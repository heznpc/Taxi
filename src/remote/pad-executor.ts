/** Optional Windows-side PAD bridge. A URI launch never establishes flow completion. */
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, open, rename, stat, unlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const commandSchema = z
  .object({
    schema: z.literal("taxi.remote-execution"),
    schemaVersion: z.literal(1),
    requestId: z.string().uuid(),
    attemptId: z.string().uuid(),
    flowId: z.string().uuid(),
  })
  .strict();
const resultSchema = z
  .object({
    requestId: z.string().uuid(),
    attemptId: z.string().uuid(),
    state: z.enum(["started", "completed", "failed", "cancelled"]),
    result: z.unknown().refine((value) => value !== undefined),
  })
  .strict();
type Command = z.infer<typeof commandSchema>;
interface Stored extends Command {
  state: string;
  callbackToken: string;
  evidence?: { source: string; observedAt: string; result: unknown };
}
function equalSecret(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export async function startPadExecutor(options: {
  directory: string;
  token: string;
  flows: Record<string, string>;
  port: number;
  launch: (flowName: string, input: Record<string, string>) => Promise<void>;
}) {
  if (options.token.length < 32) throw new Error("Executor token must be at least 32 characters");
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  try {
    await stat(join(options.directory, "recovery.lock"));
    throw new Error("Store recovery is active");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  // This process owns this store. A second server must not dispatch from it.
  const owner = await open(join(options.directory, "owner.lock"), "wx", 0o600);
  await owner.writeFile(JSON.stringify({ pid: process.pid }));
  await owner.sync();
  try {
    await stat(join(options.directory, "recovery.lock"));
    await owner.close();
    await unlink(join(options.directory, "owner.lock"));
    throw new Error("Store recovery is active");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  const busy = new Set<string>();
  const launches = new Set<Promise<void>>();
  const path = (id: string) => join(options.directory, `${id}.json`);
  const save = async (record: Stored) => {
    const tmp = `${path(record.requestId)}.tmp`;
    const fd = await open(tmp, "w", 0o600);
    try {
      await fd.writeFile(JSON.stringify(record));
      await fd.sync();
    } finally {
      await fd.close();
    }
    await rename(tmp, path(record.requestId));
  };
  const publicRecord = (record: Stored) => ({
    schema: record.schema,
    schemaVersion: record.schemaVersion,
    requestId: record.requestId,
    attemptId: record.attemptId,
    state: record.state,
    ...(record.evidence ? { evidence: record.evidence } : {}),
  });
  const server = createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const match = /^\/requests\/([a-f0-9-]{36})(\/cancel|\/result)?$/.exec(req.url ?? "");
    if (!match || !z.string().uuid().safeParse(match[1]).success) {
      reply(404, { error: "Unknown request" });
      return;
    }
    const id = match[1]!;
    if (busy.has(id)) {
      reply(409, { error: "Request is being updated; reconcile" });
      return;
    }
    busy.add(id);
    try {
      let current: Stored | undefined;
      try {
        current = JSON.parse(await readFile(path(id), "utf8"));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      const secret = match[2] === "/result" ? current?.callbackToken : options.token;
      if (!secret || !equalSecret(req.headers.authorization ?? "", `Bearer ${secret}`)) {
        reply(401, { error: "Unauthorized" });
        return;
      }
      if (req.method === "GET" && !match[2]) {
        reply(current ? 200 : 404, current ? publicRecord(current) : { error: "Unknown request" });
        return;
      }
      if (req.method !== "POST") {
        reply(405, { error: "Method not allowed" });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) {
          reply(413, { error: "Request too large" });
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (match[2] === "/result") {
        const result = resultSchema.parse(value);
        if (!current || result.requestId !== id || result.attemptId !== current.attemptId) {
          reply(409, { error: "Correlation mismatch" });
          return;
        }
        const terminal = ["completed", "failed", "cancelled"].includes(current.state);
        if (terminal) {
          if (
            result.state !== current.state ||
            JSON.stringify(result.result) !== JSON.stringify(current.evidence?.result)
          ) {
            reply(409, { error: "Conflicting terminal result" });
            return;
          }
        } else {
          current.state = result.state;
          current.evidence = {
            source: "windows-pad-flow-callback",
            observedAt: new Date().toISOString(),
            result: result.result,
          };
          await save(current);
        }
        reply(200, publicRecord(current));
        return;
      }
      const command = commandSchema.parse(value);
      if (command.requestId !== id || req.headers["idempotency-key"] !== command.attemptId) {
        reply(409, { error: "Correlation mismatch" });
        return;
      }
      if (current) {
        if (current.attemptId !== command.attemptId || current.flowId !== command.flowId) {
          reply(409, { error: "Request ID already bound" });
          return;
        }
        if (match[2] === "/cancel" && !["completed", "failed", "cancelled"].includes(current.state)) {
          // PAD URI transport has no reliable cancel acknowledgement. Never claim cancellation.
          current.state = "unknown";
          await save(current);
        }
        reply(200, publicRecord(current));
        return; // Idempotent duplicate: never relaunch.
      }
      if (match[2]) {
        reply(404, { error: "Unknown request" });
        return;
      }
      const name = options.flows[command.flowId];
      if (!name) {
        reply(404, { error: "Flow is not registered" });
        return;
      }
      current = { ...command, state: "accepted", callbackToken: randomBytes(32).toString("hex") };
      await save(current); // Persist deduplication boundary before launching PAD.
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Executor not listening");
      const input = {
        TaxiRequestId: id,
        TaxiAttemptId: command.attemptId,
        TaxiCallbackURL: `http://127.0.0.1:${address.port}/requests/${id}/result`,
        TaxiCallbackToken: current.callbackToken,
      };
      // Release the request lock before a fast flow can report completion.
      const launch = Promise.resolve()
        .then(() => options.launch(name, input))
        .catch(async () => {
          while (busy.has(id)) await new Promise((resolve) => setTimeout(resolve, 10));
          busy.add(id);
          try {
            const latest: Stored = JSON.parse(await readFile(path(id), "utf8"));
            if (latest.state === "accepted") {
              latest.state = "unknown";
              await save(latest);
            }
          } finally {
            busy.delete(id);
          }
        })
        .catch(() => {
          /* Persisted acceptance is still not evidence of completion. */
        });
      launches.add(launch);
      void launch.then(() => launches.delete(launch));
      reply(202, publicRecord(current));
    } catch {
      reply(400, { error: "Request invalid or state unavailable; reconcile before retry" });
    } finally {
      busy.delete(id);
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  const release = async () => {
    await owner.close();
    const { unlink } = await import("node:fs/promises");
    await unlink(join(options.directory, "owner.lock"));
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, "127.0.0.1", resolve);
    });
  } catch (e) {
    await release();
    throw e;
  }
  return {
    server,
    close: async () => {
      await Promise.allSettled([...launches]);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await release();
    },
  };
}
export async function launchPad(flowName: string, input: Record<string, string>) {
  if (process.platform !== "win32") throw new Error("PAD executor requires Windows");
  const uri = `ms-powerautomate:/console/flow/run?${new URLSearchParams({ workflowName: flowName, inputArguments: JSON.stringify(input) })}`;
  await new Promise<void>((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $env:TAXI_PAD_URI"],
      { env: { ...process.env, TAXI_PAD_URI: uri }, timeout: 10000 },
      (error) => (error ? reject(new Error("PAD launch outcome unknown")) : resolve()),
    );
  });
}

/** Explicit stale-owner recovery only; persisted requests remain deduplication barriers. */
export async function recoverPadStore(directory: string) {
  const reaper = await open(join(directory, "recovery.lock"), "wx", 0o600);
  try {
    const ownerPath = join(directory, "owner.lock");
    const owner = JSON.parse(await readFile(ownerPath, "utf8"));
    if (!Number.isInteger(owner.pid) || owner.pid < 1) throw new Error("Invalid owner identity; recovery refused");
    try {
      process.kill(owner.pid, 0);
      throw new Error("Owner may still be running; recovery refused");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
    for (const name of await readdir(directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const path = join(directory, name);
      const record = JSON.parse(await readFile(path, "utf8"));
      if (record.state === "accepted" || record.state === "started") {
        record.state = "unknown";
        const temp = `${path}.recovery.tmp`;
        const fd = await open(temp, "w", 0o600);
        try {
          await fd.writeFile(JSON.stringify(record));
          await fd.sync();
        } finally {
          await fd.close();
        }
        await rename(temp, path);
      }
    }
    await unlink(ownerPath);
    return { recovered: true, resumedExecutions: 0, authority: "none" };
  } finally {
    await reaper.close();
    await unlink(join(directory, "recovery.lock"));
  }
}
