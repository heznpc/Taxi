import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { APP_RUNTIME_DIAGNOSTIC_HEADER, APP_RUNTIME_DIAGNOSTIC_PROTOCOL } from "../shared/app-runtime-diagnostic.js";

export interface AppRuntimeProbeOptions {
  url: string;
  token: string;
  /**
   * Optional transport-bound fetch implementation. The Taxi.app ownership
   * verifier supplies one that adds and verifies a per-request response proof;
   * callers probing the canonical app runtime must not silently downgrade to
   * an ordinary bearer-only fetch.
   */
  fetchImpl?: typeof fetch;
  /** Restrict this session to initialize/notifications/initialized/tools/list
   * and request the cryptographically gated no-rate-mutation doctor path. */
  readOnlyDiagnostic?: boolean;
  clientName?: string;
  clientVersion?: string;
  timeoutMs?: number;
  minTools?: number;
  requiredTools?: string[];
}

export interface AppRuntimeProbeResult {
  serverName?: string;
  serverVersion?: string;
  toolCount: number;
  sampleTools: string[];
}

export async function probeAppRuntimeMcp(options: AppRuntimeProbeOptions): Promise<AppRuntimeProbeResult> {
  const timeout = options.timeoutMs ?? 3_000;
  const minTools = options.minTools ?? 1;
  const client = new Client(
    {
      name: options.clientName ?? "taxi-runtime-probe",
      version: options.clientVersion ?? "0",
    },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(new URL(options.url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${options.token}`,
        ...(options.readOnlyDiagnostic ? { [APP_RUNTIME_DIAGNOSTIC_HEADER]: APP_RUNTIME_DIAGNOSTIC_PROTOCOL } : {}),
      },
    },
    ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
  });

  try {
    await client.connect(transport, { timeout });
    const tools = await client.listTools(undefined, { timeout });
    const toolCount = tools.tools.length;
    if (toolCount < minTools) {
      throw new Error(`tools/list returned ${toolCount} tools; expected at least ${minTools}`);
    }
    const toolNames = new Set(tools.tools.map((tool) => tool.name));
    const missing = (options.requiredTools ?? []).filter((name) => !toolNames.has(name));
    if (missing.length > 0) {
      throw new Error(`tools/list missing required tools: ${missing.join(", ")}`);
    }
    const serverVersion = client.getServerVersion();
    return {
      serverName: serverVersion?.name,
      serverVersion: serverVersion?.version,
      toolCount,
      sampleTools: tools.tools.slice(0, 5).map((tool) => tool.name),
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
