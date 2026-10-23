import { z } from "zod";

const target = z.object({
  id: z.string(),
  type: z.string(),
  url: z.string(),
  webSocketDebuggerUrl: z.string().optional(),
});
/** Explicit local Chrome debugging endpoint only. Never attach to a default personal profile automatically. */
export function localEndpoint(endpoint: string): URL {
  const url = new URL(endpoint);
  if (
    !["http:", "ws:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error("An explicit loopback debugging endpoint is required");
  return url;
}
export class ChromeSession {
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  readonly events: Array<{ method: string; params: unknown }> = [];
  private constructor(
    private socket: WebSocket,
    readonly targetId: string,
    readonly expectedUrl: string,
  ) {
    socket.addEventListener("message", (message) => {
      const data = JSON.parse(String(message.data));
      if (typeof data.id === "number") {
        const entry = this.pending.get(data.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(data.id);
        if (data.error) entry.reject(new Error(String(data.error.message)));
        else entry.resolve(data.result ?? {});
      } else if (typeof data.method === "string" && this.events.length < 200) {
        // Only bounded diagnostics. No headers, cookies, POST bodies or arbitrary console objects.
        const p = data.params ?? {};
        if (data.method === "Network.responseReceived")
          this.events.push({
            method: data.method,
            params: { status: p.response?.status, mimeType: p.response?.mimeType },
          });
        if (data.method === "Runtime.exceptionThrown")
          this.events.push({
            method: data.method,
            params: { text: String(p.exceptionDetails?.text ?? "").slice(0, 500) },
          });
        if (data.method === "Runtime.consoleAPICalled")
          this.events.push({ method: data.method, params: { type: p.type, argumentCount: p.args?.length } });
      }
    });
    const disconnect = () => {
      for (const item of this.pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error("Chrome disconnected; action outcome may be unknown"));
      }
      this.pending.clear();
    };
    socket.addEventListener("close", disconnect);
    socket.addEventListener("error", disconnect);
  }
  static async connect(endpoint: string, targetId: string, expectedUrl: string) {
    const base = localEndpoint(endpoint);
    const response = await fetch(new URL("/json/list", base), { signal: AbortSignal.timeout(5000), redirect: "error" });
    const targets = z.array(target).parse(await response.json());
    const selected = targets.find((t) => t.id === targetId && t.type === "page" && t.url === expectedUrl);
    if (!selected?.webSocketDebuggerUrl) throw new Error("Exact page target missing or stale");
    const socketUrl = localEndpoint(selected.webSocketDebuggerUrl);
    if (socketUrl.host !== base.host) throw new Error("Chrome returned a different debugging authority");
    const ws = new WebSocket(socketUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("Chrome connection timeout"));
      }, 5000);
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("Chrome connection failed"));
        },
        { once: true },
      );
    });
    const session = new ChromeSession(ws, targetId, expectedUrl);
    try {
      await session.call("Runtime.enable");
      await session.call("DOM.enable");
      await session.call("Network.enable");
    } catch (e) {
      session.close();
      throw e;
    }
    return session;
  }
  call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Chrome response timeout; action outcome may be unknown"));
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async observe() {
    const snapshot = await this.call("Runtime.evaluate", {
      returnByValue: true,
      expression: `JSON.stringify({url:location.href,title:document.title,readyState:document.readyState,elements:Array.from(document.querySelectorAll('button,a,input,select,textarea,[role]')).slice(0,200).map(e=>({tag:e.tagName,role:e.getAttribute('role'),label:e.getAttribute('aria-label')||e.textContent?.trim().slice(0,200),disabled:!!e.disabled}))})`,
    });
    const raw = snapshot.result as { value?: string };
    if (typeof raw?.value !== "string") throw new Error("Chrome did not return a document snapshot");
    const document = JSON.parse(raw.value);
    if (document.url !== this.expectedUrl) throw new Error("Page URL changed; target is stale");
    const ax = await this.call("Accessibility.getFullAXTree");
    return {
      target: { id: this.targetId, url: this.expectedUrl },
      document,
      accessibility: (ax.nodes as unknown[]).slice(0, 200),
      diagnostics: this.events,
      verification: "observation_only",
    };
  }
  async click(selector: string) {
    if (!selector || selector.length > 500) throw new Error("A bounded CSS selector is required");
    const result = await this.call("Runtime.evaluate", {
      returnByValue: true,
      expression: `(()=>{if(location.href!==${JSON.stringify(this.expectedUrl)})return {executed:false,reason:'stale_target'};const es=document.querySelectorAll(${JSON.stringify(selector)});if(es.length!==1)return {executed:false,reason:'ambiguous_or_missing'};const e=es[0];if(!e.isConnected||e.disabled||e.getAttribute('aria-disabled')==='true'||!e.getClientRects().length)return {executed:false,reason:'not_actionable'};e.click();return {executed:true,verification:'not_performed'}})()`,
    });
    if (result.exceptionDetails) throw new Error("Click failed or outcome unknown; inspect page before retry");
    return (result.result as { value?: unknown }).value;
  }
  close() {
    this.socket.close();
  }
}
