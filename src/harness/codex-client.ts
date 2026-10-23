import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { privateDirectory } from "./store.js";
import { prepareBackground } from "../work/background.js";

export function codexBinary(): string | null {
  const override = process.env.TAXI_CODEX_BINARY;
  const candidates = override
    ? [override]
    : (process.env.PATH ?? "")
        .split(":")
        .filter(Boolean)
        .map((path) => join(path, "codex"));
  candidates.push(...(override ? [] : ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"]));
  return candidates.find((path) => isAbsolute(path) && existsSync(path)) ?? null;
}
export interface CodexReply {
  thread?: { id: string };
  model?: string;
  reasoningEffort?: string | null;
  turn?: { id: string };
  data?: { model: string; supportedReasoningEfforts?: { reasoningEffort: string }[] }[];
}
interface Notification {
  threadId?: string;
  turnId?: string;
  item?: { type?: string; text?: string };
  turn?: { id?: string; status?: string };
}
type Message = { id?: string | number; method?: string; params?: Notification; result?: CodexReply; error?: unknown };
type Pending = { resolve: (value: CodexReply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/** Public stdio app-server protocol; no desktop-only APIs or global config writes. */
export class CodexClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private closed = false;
  private background?: Awaited<ReturnType<typeof prepareBackground>>;
  onNotification: (method: string, params: Notification) => void = () => {};
  onLost: () => void = () => {};
  constructor(
    readonly home: string,
    readonly workspace: string,
  ) {}
  async start(): Promise<void> {
    const binary = codexBinary();
    if (!binary) throw new Error("codex_not_installed");
    privateDirectory(this.home);
    privateDirectory(this.workspace);
    this.background = await prepareBackground(this.workspace, "codex", false, this.home);
    // Dedicated home prevents inheriting QuotaPie relay settings or user MCP grants.
    // No shell is involved; all permission overrides are process-local.
    const child = spawn(
      this.background.executable,
      [
        ...this.background.prefix,
        binary,
        "app-server",
        "--listen",
        "stdio://",
        "-c",
        'approval_policy="never"',
        "-c",
        'sandbox_mode="read-only"',
        "-c",
        "features.multi_agent=false",
        "-c",
        "features.apps=false",
        "-c",
        "mcp_servers={}",
        "-c",
        "analytics.enabled=false",
      ],
      {
        cwd: this.workspace,
        detached: true,
        env: {
          ...this.background.env,
          CODEX_HOME: this.home,
          RUST_LOG: "off",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    child.stderr.resume(); // Never retain credentials or provider diagnostics in product logs.
    child.stdin.on("error", () => this.lost());
    const ended = () => {
      this.lost();
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* group already ended */
        }
      }
      const background = this.background;
      this.background = undefined;
      void background?.close().catch(() => {});
    };
    child.on("error", ended);
    child.on("exit", ended);
    const reader = createInterface({ input: child.stdout });
    reader.on("line", (line) => {
      if (line.length > 2_000_000) {
        this.close();
        return;
      }
      let message: Message;
      try {
        message = JSON.parse(line) as Message;
      } catch {
        return;
      }
      if (message.method && message.id !== undefined) {
        // Every request is denied independently. Never carry approval from a parent task.
        const result =
          message.method.includes("requestApproval") && !message.method.includes("permissions")
            ? { decision: "decline" }
            : null;
        this.send(
          result
            ? { id: message.id, result }
            : { id: message.id, error: { code: -32601, message: "Taxi does not grant provider permissions" } },
        );
      } else if (typeof message.id === "number") {
        const item = this.pending.get(message.id);
        if (!item) return;
        this.pending.delete(message.id);
        clearTimeout(item.timer);
        if (message.error) item.reject(new Error("provider_rpc_rejected"));
        else item.resolve(message.result ?? {});
      } else if (message.method) this.onNotification(message.method, message.params ?? {});
    });
    await this.request("initialize", { clientInfo: { name: "taxi", title: "Taxi", version: "1.0.0" } });
    this.send({ method: "initialized", params: {} });
  }
  private send(message: unknown): void {
    if (!this.child || this.closed) throw new Error("provider_disconnected");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  request(method: string, params: unknown): Promise<CodexReply> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("provider_rpc_timeout"));
      }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  private lost(): void {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("provider_disconnected"));
    }
    this.pending.clear();
    this.onLost();
  }
  close(): void {
    this.lost();
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* exited */
      }
    }
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* exited */
        }
      }
    }, 1000);
    timer.unref();
  }
}
