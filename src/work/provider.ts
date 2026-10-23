import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, open, readFile, writeFile, rename, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { normalizeProviderOutput } from "./normalize.js";
import { PATHS } from "../shared/constants.js";
import { readModoreSnapshot, type ArtifactReference } from "../interop/modore.js";
import { prepareBackground } from "./background.js";

export const workSpec = z
  .object({
    provider: z.enum(["codex", "claude"]),
    workspace: z.string().min(1),
    prompt: z.string().min(1).max(100000),
    timeoutMs: z.number().int().min(1000).max(3600000).default(120000),
    snapshot: z.string().optional(),
    mode: z.enum(["capture", "background-only"]).default("capture"),
    model: z.string().min(1).max(200).optional(),
    effort: z.string().min(1).max(40).optional(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    if (spec.mode === "background-only" && (!spec.model || !spec.effort))
      ctx.addIssue({
        code: "custom",
        message: "background-only requires explicit model and effort; Taxi never substitutes them",
      });
  });
export type WorkSpec = z.infer<typeof workSpec>;
export const workRoot = () => join(PATHS.VECTOR_STORE, "work");
function runPath(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid work ID");
  return join(workRoot(), id);
}
async function atomic(path: string, value: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = await open(temp, "wx", 0o600);
  try {
    await fd.writeFile(JSON.stringify(value, null, 2));
    await fd.sync();
  } finally {
    await fd.close();
  }
  await rename(temp, path);
  const directory = await open(resolve(path, ".."), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export interface WorkRecord {
  schema: "taxi.provider-work";
  schemaVersion: 1;
  id: string;
  ownerPid: number;
  createdAt: string;
  finishedAt?: string;
  provider: string;
  workspace: string;
  outcome: "running" | "returned" | "failed" | "not_started" | "unknown";
  reason?: string;
  exitCode?: number | null;
  artifacts: ArtifactReference[];
  acceptedScope: string;
  mode?: "capture" | "background-only";
  isolation?: Awaited<ReturnType<typeof prepareBackground>>["evidence"];
  verification: "not_performed";
  authority: "none";
}

/** Explicit capture or OS-isolated development; never resume inherited authority. */
export function providerArgs(spec: WorkSpec): string[] {
  if (spec.mode === "background-only") {
    const prompt = `Taxi background-only development. Work only in the requested project. GUI, global input, AppleEvents, host MCP/CDP and local service access are blocked by the OS for this entire process tree. Use file edits, CLI builds and tests. If a task needs unavailable UI, report it as blocked; never fall back to foreground control.\n\n${spec.prompt}`;
    return spec.provider === "codex"
      ? [
          "exec",
          "--json",
          "--cd",
          spec.workspace,
          "--ephemeral",
          "--ignore-user-config",
          "--ignore-rules",
          "--sandbox",
          "danger-full-access",
          "-c",
          'approval_policy="never"',
          "-c",
          "features.apps=false",
          "-c",
          "features.multi_agent=false",
          "-c",
          "mcp_servers={}",
          "-c",
          'cli_auth_credentials_store="file"',
          "--model",
          spec.model!,
          "-c",
          `model_reasoning_effort=${JSON.stringify(spec.effort)}`,
          "--",
          prompt,
        ]
      : [
          "--print",
          "--output-format",
          "stream-json",
          "--verbose",
          "--permission-mode",
          "acceptEdits",
          "--tools",
          "Bash,Read,Write,Edit,Glob,Grep",
          "--allowedTools",
          "Bash,Read,Write,Edit,Glob,Grep",
          "--setting-sources",
          "",
          "--settings",
          '{"disableAllHooks":true}',
          "--strict-mcp-config",
          "--mcp-config",
          '{"mcpServers":{}}',
          "--no-chrome",
          "--no-session-persistence",
          "--model",
          spec.model!,
          "--effort",
          spec.effort!,
          "--",
          prompt,
        ];
  }
  return spec.provider === "codex"
    ? ["exec", "--json", "--cd", spec.workspace, "--sandbox", "read-only", "--ephemeral", "--", spec.prompt]
    : [
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "plan",
        "--no-session-persistence",
        "--",
        spec.prompt,
      ];
}

export async function inspectWork(id: string): Promise<WorkRecord> {
  const record: WorkRecord = JSON.parse(await readFile(join(runPath(id), "record.json"), "utf8"));
  if (record.outcome === "running") {
    try {
      process.kill(record.ownerPid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH")
        return {
          ...record,
          outcome: "unknown",
          reason: "Owner exited; capture may be partial. Inspect artifacts. Never replay automatically.",
        };
      throw error;
    }
  }
  return record;
}
export async function cancelWork(id: string) {
  const record = await inspectWork(id);
  if (record.outcome !== "running") return record;
  await writeFile(join(runPath(id), "cancel"), "requested\n", { mode: 0o600 });
  return { id, cancellation: "requested", effect: "unverified" };
}
export async function reviewWork(id: string, note: string) {
  const record = await inspectWork(id);
  if (!note.trim()) throw new Error("Review cannot be empty");
  const review = {
    schema: "taxi.artifact-review",
    schemaVersion: 1,
    id: randomUUID(),
    workId: id,
    createdAt: new Date().toISOString(),
    note,
    artifacts: record.artifacts,
    authority: "none",
  };
  await atomic(join(runPath(id), `review-${review.id}.json`), review);
  return review;
}
export async function recoverWork(id: string) {
  const record = await inspectWork(id);
  // Recovery creates evidence only. It never restarts an executor or restores an approval.
  const recovery = {
    record,
    recoveredAt: new Date().toISOString(),
    authority: "none",
    retryable: false,
    artifacts: [join(runPath(id), "stdout.jsonl"), join(runPath(id), "stderr.txt")],
    next:
      record.outcome === "running"
        ? "Owner may still be active; request cancellation first."
        : "Inspect captured output; a new execution requires a new explicit request.",
  };
  await atomic(join(runPath(id), `recovery-${randomUUID()}.json`), recovery);
  return recovery;
}

export async function executeProvider(input: unknown, onStarted?: (id: string) => void): Promise<WorkRecord> {
  const spec = workSpec.parse(input);
  spec.workspace = resolve(spec.workspace);
  if (!(await stat(spec.workspace)).isDirectory()) throw new Error("Workspace must be a directory");
  const sessions = spec.snapshot ? (await readModoreSnapshot(spec.snapshot)).sessions : undefined;
  const id = randomUUID();
  const dir = runPath(id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await atomic(join(dir, "request.json"), spec);
  const record: WorkRecord = {
    schema: "taxi.provider-work",
    schemaVersion: 1,
    id,
    ownerPid: process.pid,
    createdAt: new Date().toISOString(),
    provider: spec.provider,
    workspace: spec.workspace,
    outcome: "running",
    artifacts: [],
    verification: "not_performed",
    authority: "none",
    mode: spec.mode,
    acceptedScope:
      spec.mode === "background-only"
        ? "Project writes and CLI development inside an OS-enforced background-only process tree; goal verification is separate"
        : "Capture provider output under provider read-only/plan policy; no wider goal guarantee",
  };
  await atomic(join(dir, "record.json"), record);
  let background: Awaited<ReturnType<typeof prepareBackground>> | undefined;
  if (spec.mode === "background-only") {
    try {
      background = await prepareBackground(spec.workspace, spec.provider);
      record.isolation = background.evidence;
      await atomic(join(dir, "record.json"), record);
    } catch {
      record.outcome = "not_started";
      record.reason = "background-only isolation setup failed; provider was not launched and no fallback was attempted";
      record.finishedAt = new Date().toISOString();
      await atomic(join(dir, "record.json"), record);
      return record;
    }
  }
  onStarted?.(id);
  const out = await open(join(dir, "stdout.jsonl"), "wx", 0o600);
  const err = await open(join(dir, "stderr.txt"), "wx", 0o600);
  const env = background?.env ?? { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("TAXI_") && /TOKEN|SECRET|KEY/.test(key)) delete env[key];
  const child = spawn(
    background?.executable ?? spec.provider,
    background ? [...background.prefix, "/usr/bin/env", spec.provider, ...providerArgs(spec)] : providerArgs(spec),
    {
      cwd: spec.workspace,
      env,
      detached: true,
      stdio: ["ignore", out.fd, err.fd],
    },
  );
  let interrupted = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (reason: string) => {
    if (interrupted) return;
    interrupted = true;
    record.reason = reason;
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* process already ended */
      }
      killTimer = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          /* ended */
        }
      }, 2000);
    }
  };
  const timeout = setTimeout(() => stop("timeout; outcome may be partial"), spec.timeoutMs);
  const sigint = () => stop("cancelled by signal; outcome may be partial");
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigint);
  let polling = false;
  const monitor = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      if ((await out.stat()).size + (await err.stat()).size > 16 * 1024 * 1024) stop("capture limit exceeded");
      try {
        await stat(join(dir, "cancel"));
        stop("cancellation requested; outcome may be partial");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") stop("cancellation monitor unavailable");
      }
    } catch {
      stop("capture monitor unavailable");
    } finally {
      polling = false;
    }
  }, 100);
  try {
    await new Promise<void>((done) => {
      child.once("error", () => {
        record.outcome = "not_started";
        record.reason = "Provider process launch failed";
        done();
      });
      child.once("close", (code) => {
        if (record.outcome !== "not_started") {
          record.exitCode = code;
          record.outcome = interrupted || code === null ? "unknown" : code === 0 ? "returned" : "failed";
        }
        done();
      });
    });
  } finally {
    clearTimeout(timeout);
    clearInterval(monitor);
    if (killTimer) clearTimeout(killTimer);
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigint);
    await out.sync();
    await err.sync();
    await out.close();
    await err.close();
    // Descendants retain Seatbelt even after detaching. Stop the ordinary process
    // group and close the proxy so no background network work survives the run.
    if (background) {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* exited */
        }
      }
      await background.close();
    }
  }
  const stdoutPath = join(dir, "stdout.jsonl");
  const normal =
    (await stat(stdoutPath)).size <= 16 * 1024 * 1024
      ? normalizeProviderOutput(await readFile(stdoutPath, "utf8"))
      : { text: "", malformedLines: 0, providerReportedError: false, skipped: "capture exceeded normalization budget" };
  if (record.outcome === "returned" && normal.providerReportedError) {
    record.outcome = "failed";
    record.reason = "Provider reported an error in its output";
  }
  await atomic(join(dir, "normalized.json"), normal);
  for (const filename of ["stdout.jsonl", "stderr.txt", "normalized.json"]) {
    const path = join(dir, filename);
    const { createReadStream } = await import("node:fs");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    record.artifacts.push({
      producer: "taxi",
      invocationId: id,
      path,
      sha256: hash.digest("hex"),
      sourceSessions: sessions,
    });
  }
  record.finishedAt = new Date().toISOString();
  await atomic(join(dir, "record.json"), record);
  return record;
}
