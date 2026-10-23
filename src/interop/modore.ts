import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";

const snapshotSchema = z
  .object({
    schema: z.literal("modore.agent-state-snapshot"),
    schemaVersion: z.literal(1),
    generatedAt: z.string().refine((s) => Number.isFinite(Date.parse(s))),
    workspace: z.string().min(1),
    coverage: z.enum(["shallow", "truncated", "complete"]),
    bindings: z.array(
      z
        .object({
          provider: z.string().min(1),
          sessionId: z.string().min(1),
          source: z.string().min(1),
          subtranscripts: z.array(z.string()).optional(),
          artifactRoot: z.string().optional(),
          evidence: z.array(z.string()),
          confidence: z.enum(["high", "medium", "low"]),
        })
        .passthrough(),
    ),
  })
  .passthrough();

/** References convey provenance, never cleanup, restore or execution authority. */
export interface SourceProvenance {
  producer: "modore";
  schemaVersion: 1;
  snapshotPath: string;
  sha256: string;
  observedAt: string;
}
export interface SessionReference {
  provider: string;
  sessionId: string;
  source: string;
  provenance: SourceProvenance;
}
export interface ArtifactReference {
  producer: "taxi";
  invocationId: string;
  path: string;
  sha256: string;
  sourceSessions?: SessionReference[];
}

export function parseModoreSnapshot(raw: Buffer, path: string, now = Date.now(), maxAgeMs = 86400000) {
  const snapshot = snapshotSchema.parse(JSON.parse(raw.toString("utf8")));
  const ageMs = now - Date.parse(snapshot.generatedAt);
  const provenance: SourceProvenance = {
    producer: "modore",
    schemaVersion: 1,
    snapshotPath: resolve(path),
    sha256: createHash("sha256").update(raw).digest("hex"),
    observedAt: snapshot.generatedAt,
  };
  return {
    schema: "taxi.session-references",
    schemaVersion: 1,
    workspace: snapshot.workspace,
    freshness: ageMs < -60000 ? "future" : ageMs > maxAgeMs ? "stale" : "fresh",
    ageMs,
    coverage: snapshot.coverage,
    provenance,
    sessions: snapshot.bindings.map((b): SessionReference => ({
      provider: b.provider,
      sessionId: b.sessionId,
      source: b.source,
      provenance,
    })),
    snapshot,
    authority: "none",
    coverageMeaning: "Classification of candidate bindings, not total machine observation.",
  };
}
export async function readModoreSnapshot(path: string) {
  const raw = await readFile(path);
  if (raw.length > 16 * 1024 * 1024) throw new Error("Snapshot exceeds 16 MiB");
  return parseModoreSnapshot(raw, path);
}
