import { randomUUID } from "node:crypto";
import { mkdir, readFile, open, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { PATHS } from "../shared/constants.js";

const replySchema = z
  .object({
    schema: z.literal("taxi.remote-execution"),
    schemaVersion: z.literal(1),
    requestId: z.string().uuid(),
    attemptId: z.string().uuid(),
    state: z.enum(["accepted", "started", "completed", "failed", "unknown", "cancelled"]),
    evidence: z
      .object({ source: z.string().min(1), observedAt: z.string().datetime({ offset: true }), result: z.unknown() })
      .optional(),
  })
  .strict();
export interface RemoteRecord {
  schema: "taxi.remote-execution";
  schemaVersion: 1;
  requestId: string;
  attemptId: string;
  endpoint: string;
  flowId: string;
  createdAt: string;
  state: z.infer<typeof replySchema>["state"];
  evidence?: z.infer<typeof replySchema>["evidence"];
  uncertainty?: string;
}
const directory = () => join(PATHS.VECTOR_STORE, "remote");
function file(id: string) {
  z.string().uuid().parse(id);
  return join(directory(), `${id}.json`);
}
function endpointURL(endpoint: string) {
  const url = new URL(endpoint);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw new Error("Remote executor requires HTTPS (HTTP only on loopback), with credentials supplied separately");
  return url;
}
async function persist(record: RemoteRecord) {
  await mkdir(directory(), { recursive: true, mode: 0o700 });
  const path = file(record.requestId);
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = await open(tmp, "wx", 0o600);
  try {
    await fd.writeFile(JSON.stringify(record, null, 2));
    await fd.sync();
  } finally {
    await fd.close();
  }
  await rename(tmp, path);
  const dir = await open(directory(), "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
export function acceptRemoteReply(record: RemoteRecord, value: unknown): RemoteRecord {
  const reply = replySchema.parse(value);
  if (reply.requestId !== record.requestId || reply.attemptId !== record.attemptId)
    throw new Error("Remote correlation mismatch");
  if (["completed", "failed", "cancelled"].includes(reply.state) && !reply.evidence)
    throw new Error("Terminal remote status requires executor evidence");
  if (["completed", "failed", "cancelled"].includes(record.state)) {
    if (reply.state !== record.state || JSON.stringify(reply.evidence) !== JSON.stringify(record.evidence))
      throw new Error("Conflicting terminal remote reply");
    return record;
  }
  if (record.state === "started" && reply.state === "accepted") return record;
  return { ...record, state: reply.state, evidence: reply.evidence, uncertainty: undefined };
}
async function exchange(record: RemoteRecord, token: string, operation: "submit" | "reconcile" | "cancel") {
  const base = endpointURL(record.endpoint);
  const url = new URL(`/requests/${record.requestId}${operation === "cancel" ? "/cancel" : ""}`, base);
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "idempotency-key": record.attemptId,
  };
  try {
    const response = await fetch(url, {
      method: operation === "reconcile" ? "GET" : "POST",
      headers,
      body:
        operation === "reconcile"
          ? undefined
          : JSON.stringify({
              schema: record.schema,
              schemaVersion: 1,
              requestId: record.requestId,
              attemptId: record.attemptId,
              flowId: record.flowId,
            }),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Remote executor did not confirm the request");
    const reader = response.body?.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    if (!reader) throw new Error("Remote response missing");
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 1024 * 1024) throw new Error("Remote response exceeds limit");
        chunks.push(Buffer.from(part.value));
      }
    } finally {
      await reader.cancel();
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    const parsed = replySchema.parse(JSON.parse(raw));
    // HTTP acceptance is not completion, even if an inconsistent body says so.
    if (response.status === 202 && ["completed", "failed", "cancelled"].includes(parsed.state))
      throw new Error("HTTP 202 cannot establish a terminal result");
    return acceptRemoteReply(record, parsed);
  } catch {
    if (["completed", "failed", "cancelled"].includes(record.state)) return record;
    return {
      ...record,
      state: "unknown" as const,
      uncertainty: "Transport or reply could not establish outcome. Reconcile this request ID; do not resubmit.",
    };
  }
}
export async function submitRemote(endpoint: string, flowId: string, token: string) {
  endpointURL(endpoint);
  z.string().uuid().parse(flowId);
  if (!token) throw new Error("TAXI_REMOTE_TOKEN is required");
  const record: RemoteRecord = {
    schema: "taxi.remote-execution",
    schemaVersion: 1,
    requestId: randomUUID(),
    attemptId: randomUUID(),
    endpoint,
    flowId,
    createdAt: new Date().toISOString(),
    state: "unknown",
    uncertainty: "Dispatch not yet reconciled",
  };
  await persist(record); // Durable identity before any possible remote side effect.
  const result = await exchange(record, token, "submit");
  await persist(result);
  return result;
}
export async function reconcileRemote(id: string, token: string, cancel = false) {
  if (!token) throw new Error("TAXI_REMOTE_TOKEN is required");
  // Serialize cross-process updates; a duplicate callback/reconcile cannot overwrite a newer terminal result.
  const lock = await open(`${file(id)}.lock`, "wx", 0o600);
  try {
    const record: RemoteRecord = JSON.parse(await readFile(file(id), "utf8"));
    const result = await exchange(record, token, cancel ? "cancel" : "reconcile");
    await persist(result);
    return result;
  } finally {
    await lock.close();
    const { unlink } = await import("node:fs/promises");
    await unlink(`${file(id)}.lock`);
  }
}
