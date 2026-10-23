import {
  embedText,
  embedBatch,
  cosineSimilarity,
  detectProvider,
  type EmbeddingProvider,
} from "../semantic/embeddings.js";
import { createHash } from "node:crypto";
import { toolRegistry, type ToolInfo, type ToolRegistry } from "./tool-registry.js";
import { LIMITS } from "./constants.js";

interface ToolVector {
  name: string;
  title?: string;
  description?: string;
  vector: number[];
}

interface ToolSearchIndex {
  toolVectors: ToolVector[];
  provider: EmbeddingProvider;
  indexed: boolean;
  /** Hash of the exact name/title/description catalog represented by this
   * index. Registries may share an index only when this value matches. */
  catalogFingerprint: string;
}

const indexes = new WeakMap<ToolRegistry, ToolSearchIndex>();
/** One mutable index state and one build promise per process/catalog. HTTP
 * warmup owns the first build; session registries attach to the same state so
 * an in-progress on-device embedding pass is never duplicated. */
const sharedIndexes = new Map<string, { index: ToolSearchIndex; build: Promise<number> }>();
const MAX_SHARED_INDEX_CATALOGS = 8;

/** Keep completed catalog sharing bounded without evicting an in-flight build
 * and defeating its single-flight guarantee. A temporary overflow of active
 * builds is trimmed as each one settles. */
function trimSharedIndexes(): void {
  while (sharedIndexes.size > MAX_SHARED_INDEX_CATALOGS) {
    let evicted = false;
    for (const [fingerprint, entry] of sharedIndexes) {
      if (!entry.index.indexed) continue;
      sharedIndexes.delete(fingerprint);
      evicted = true;
      break;
    }
    if (!evicted) return;
  }
}

function toolCatalog(registry: ToolRegistry): { tools: ToolInfo[]; texts: string[]; fingerprint: string } {
  const tools = registry
    .getToolNames()
    .map((name) => registry.getToolInfo(name, { descriptionMode: "full" }))
    .filter((tool): tool is ToolInfo => tool !== undefined);
  const texts = tools.map((tool) => `${tool.name}: ${tool.title ?? ""} ${tool.description ?? ""}`);
  const fingerprint = createHash("sha256")
    .update(texts.map((text) => `${text.length}:${text}`).join("\n"), "utf8")
    .digest("hex");
  return { tools, texts, fingerprint };
}

function getIndex(registry: ToolRegistry): ToolSearchIndex {
  let index = indexes.get(registry);
  if (!index) {
    index = { toolVectors: [], provider: "none", indexed: false, catalogFingerprint: "" };
    indexes.set(registry, index);
  }
  return index;
}

/** Build the tool description vector index. Identical catalogs share a
 * process-wide single-flight so concurrent HTTP warmup/session construction
 * cannot enqueue duplicate full-catalog embedding batches. */
export async function indexToolDescriptions(registry: ToolRegistry = toolRegistry): Promise<number> {
  const catalog = toolCatalog(registry);
  const existing = sharedIndexes.get(catalog.fingerprint);
  if (existing) {
    // Refresh insertion order so settled entries follow bounded LRU eviction.
    sharedIndexes.delete(catalog.fingerprint);
    sharedIndexes.set(catalog.fingerprint, existing);
    indexes.set(registry, existing.index);
    return existing.build;
  }

  const registryIndex = indexes.get(registry);
  if (registryIndex?.indexed && registryIndex.catalogFingerprint === catalog.fingerprint) {
    return registryIndex.toolVectors.length;
  }

  // Publish the mutable state before the first await. HTTP sessions created
  // while warmup is embedding can attach now and observe `indexed=true` when
  // this single build completes.
  // Reuse a failed state for the same registry/catalog so session registries
  // attached during the failed attempt observe a later successful retry.
  const index: ToolSearchIndex =
    registryIndex?.catalogFingerprint === catalog.fingerprint
      ? registryIndex
      : {
          toolVectors: [],
          provider: "none",
          indexed: false,
          catalogFingerprint: catalog.fingerprint,
        };
  index.toolVectors = [];
  index.provider = "none";
  index.indexed = false;
  indexes.set(registry, index);

  const build: Promise<number> = Promise.resolve()
    .then(async (): Promise<number> => {
      index.provider = await detectProvider();
      if (index.provider === "none") return 0;

      if (catalog.tools.length === 0) {
        index.indexed = true;
        return 0;
      }

      const vectors = await embedBatch(catalog.texts, index.provider);
      const dimension = vectors[0]?.length ?? 0;
      if (
        vectors.length !== catalog.tools.length ||
        dimension === 0 ||
        vectors.some(
          (vector) =>
            !Array.isArray(vector) || vector.length !== dimension || vector.some((value) => !Number.isFinite(value)),
        )
      ) {
        throw new Error(
          `embedding batch returned an invalid catalog (${vectors.length} vectors for ${catalog.tools.length} tools)`,
        );
      }
      index.toolVectors = [];
      for (let i = 0; i < catalog.tools.length; i++) {
        const vector = vectors[i]!;
        const tool = catalog.tools[i]!;
        index.toolVectors.push({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          vector,
        });
      }
      index.indexed = true;
      return index.toolVectors.length;
    })
    .catch(() => 0)
    .finally(() => {
      // Cache only a successfully built index. Provider discovery and Swift/
      // remote embedding can fail transiently; retaining that failed promise
      // would make every later build request return 0 until process restart.
      const current = sharedIndexes.get(catalog.fingerprint);
      if (!index.indexed && current?.build === build) {
        sharedIndexes.delete(catalog.fingerprint);
      }
      trimSharedIndexes();
    });
  sharedIndexes.set(catalog.fingerprint, { index, build });
  trimSharedIndexes();
  return build;
}

/** Attach a session registry to the process warmup index without performing
 * any embedding work. A catalog mismatch fails closed: semantic lookup stays
 * unavailable for that session rather than applying vectors to different
 * tools. Substring discovery remains available. */
export function reuseToolDescriptionIndex(source: ToolRegistry, target: ToolRegistry): boolean {
  const sourceIndex = indexes.get(source);
  if (!sourceIndex) return false;
  const targetFingerprint = toolCatalog(target).fingerprint;
  if (sourceIndex.catalogFingerprint !== targetFingerprint) return false;
  indexes.set(target, sourceIndex);
  return true;
}

/** Search tools by semantic similarity. Returns top matches above threshold. */
export async function semanticToolSearch(
  query: string,
  limit = 10,
  threshold = LIMITS.SEARCH_THRESHOLD,
  registry: ToolRegistry = toolRegistry,
): Promise<ToolInfo[]> {
  const index = getIndex(registry);
  if (!index.indexed || index.provider === "none") return [];

  try {
    const queryVector = await embedText(query, index.provider);
    const scored = index.toolVectors
      .map((tv) => ({
        info:
          registry.getToolInfo(tv.name, { descriptionMode: "summary" }) ??
          ({ name: tv.name, title: tv.title, description: tv.description } as ToolInfo),
        score: cosineSimilarity(queryVector, tv.vector),
      }))
      .filter((s) => s.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored.map((s) => s.info);
  } catch {
    return [];
  }
}

/** Check if semantic tool search is available. */
export function isToolSearchIndexed(registry: ToolRegistry = toolRegistry): boolean {
  return getIndex(registry).indexed;
}
