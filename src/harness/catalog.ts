import { z } from "zod";

const label = z.string().min(1).max(4096);
const timestamp = z.iso.datetime({ offset: true });
export const catalogSessionSchema = z
  .object({
    key: label,
    provider: z.string().min(1).max(80),
    providerSessionId: label.nullable(),
    profileKey: label.nullable(),
    workspacePath: label.nullable(),
    lastActivityAt: timestamp.nullable(),
    provenance: z.literal("local-metadata"),
    title: z.string().max(4096).optional(),
  })
  .strict();
export const catalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: timestamp,
    source: z.literal("modore"),
    scan: z
      .object({ complete: z.boolean(), truncated: z.boolean(), errors: z.array(z.string().max(4096)).max(10000) })
      .strict(),
    sessions: z.array(catalogSessionSchema).max(50000),
  })
  .strict();
export type Catalog = z.infer<typeof catalogSchema>;
export type CatalogSession = z.infer<typeof catalogSessionSchema>;
export interface ExternalSession extends CatalogSession {
  importedAt: string;
  catalogGeneratedAt: string;
  source: "modore";
  presentInLatestImport: boolean;
  executionOwner: "external-provider";
  status: "unknown";
  authority: "observe-only";
}
export interface CatalogImport {
  generatedAt: string;
  importedAt: string;
  source: "modore";
  scan: Catalog["scan"];
  sessionCount: number;
}
export interface SessionLink {
  id: string;
  taskId: string;
  sessionKey: string;
  parentSessionKey: string | null;
  phase: string;
  evidence: string;
  registeredBy: "user" | "authorized-parent-session";
  createdAt: string;
  authority: "none";
}
export const linkSchema = z
  .object({
    sessionKey: label,
    parentSessionKey: label.nullable().default(null),
    phase: z.string().trim().min(1).max(120),
    evidence: z.string().trim().min(1).max(16000),
    registeredBy: z.enum(["user", "authorized-parent-session"]),
  })
  .strict();

/** A catalog key is opaque. Neither paths nor timestamps imply a relationship or permission. */
export function mergeCatalog(previous: ExternalSession[], value: unknown, now = new Date().toISOString()) {
  const catalog = catalogSchema.parse(value);
  const unique = new Set<string>();
  const entries = new Map(previous.map((session) => [session.key, { ...session, presentInLatestImport: false }]));
  for (const session of catalog.sessions) {
    if (unique.has(session.key)) throw new Error("duplicate_catalog_key");
    unique.add(session.key);
    const old = entries.get(session.key);
    if (
      old &&
      (old.provider !== session.provider ||
        old.profileKey !== session.profileKey ||
        old.providerSessionId !== session.providerSessionId)
    ) {
      throw new Error("catalog_identity_conflict");
    }
    // Keep the freshest metadata while recording that the key occurred in this import.
    if (old && Date.parse(old.catalogGeneratedAt) > Date.parse(catalog.generatedAt)) {
      entries.set(session.key, { ...old, presentInLatestImport: true });
    } else {
      entries.set(session.key, {
        ...session,
        importedAt: now,
        catalogGeneratedAt: catalog.generatedAt,
        source: "modore",
        presentInLatestImport: true,
        executionOwner: "external-provider",
        status: "unknown",
        authority: "observe-only",
      });
    }
  }
  if (entries.size > 50000) throw new Error("catalog_storage_limit");
  const receipt: CatalogImport = {
    generatedAt: catalog.generatedAt,
    importedAt: now,
    source: catalog.source,
    scan: catalog.scan,
    sessionCount: catalog.sessions.length,
  };
  return { sessions: [...entries.values()], receipt };
}
export function catalogFreshness(generatedAt: string, now = Date.now()): "fresh" | "stale" | "future" {
  const age = now - Date.parse(generatedAt);
  return age < -300000 ? "future" : age > 86400000 ? "stale" : "fresh";
}
