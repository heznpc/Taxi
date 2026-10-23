import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { McpClient } from "../shared/config.js";
import { MCP_CLIENTS, NPM_PACKAGE_SPECIFIER } from "../shared/config.js";
import { isPlainObject } from "../shared/validate.js";
import {
  type CodexTaxiRuntimeShape,
  configureCodexTaxi,
  configureCodexTaxiDirect,
  codexTaxiRuntimeShape,
  directStdioEntry,
  isAppOwnedProxyInvocation,
  isCodexCliAvailable,
  stdioProxyEntry,
} from "./codex-mcp.js";

export type ClientRuntimeShape = "app-owned" | "direct" | "unknown";
export type ClientRuntimeMode = "app" | "direct";
export type ClientConfigStatus = "configured" | "already-configured" | "would-configure" | "skipped" | "failed";

export interface ClientConfigResult {
  name: string;
  status: ClientConfigStatus;
  detail: string;
  configPath?: string;
}

export interface ClientConfigOptions {
  clients?: readonly McpClient[];
  dryRun?: boolean;
  includeSkipped?: boolean;
  token?: string;
  now?: () => number;
  runtimeMode?: ClientRuntimeMode;
  configureCodex?: boolean;
  codex?: {
    isAvailable: () => boolean;
    shape: () => CodexTaxiRuntimeShape;
    configure: () => "already-configured" | "configured";
    configureDirect?: () => "already-configured" | "configured";
  };
}

interface ClientStdioEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export function clientRuntimeShape(entry: unknown): ClientRuntimeShape {
  if (!entry || typeof entry !== "object") return "unknown";
  const record = entry as Record<string, unknown>;
  const command = typeof record.command === "string" ? record.command : "";
  const args = Array.isArray(record.args) ? record.args.filter((arg): arg is string => typeof arg === "string") : [];
  const env = record.env && typeof record.env === "object" ? (record.env as Record<string, unknown>) : {};
  const hasToken = typeof env.TAXI_HTTP_TOKEN === "string" && env.TAXI_HTTP_TOKEN.length > 0;
  if (isAppOwnedProxyInvocation(command, args) && hasToken) return "app-owned";
  if (isAppOwnedProxyInvocation(command, args)) return "unknown";
  if (
    command === "npx" &&
    args.length === 3 &&
    args[0] === "-y" &&
    args[1] === NPM_PACKAGE_SPECIFIER &&
    args[2] === "run"
  ) {
    return "direct";
  }
  return "unknown";
}

function availableBundledProxyEntry(entry: unknown): entry is {
  command: string;
  args: string[];
  env: Record<string, unknown>;
} {
  if (!isPlainObject(entry)) return false;
  const command = typeof entry.command === "string" ? entry.command : "";
  const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : [];
  if (command === "npx" || !isAppOwnedProxyInvocation(command, args)) return false;
  return existsSync(command) && typeof args[0] === "string" && existsSync(args[0]) && isPlainObject(entry.env);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function runtimeDetail(runtimeMode: ClientRuntimeMode): string {
  return runtimeMode === "direct" ? "direct stdio runtime" : "token-gated Taxi.app runtime";
}

function targetRuntimeShape(runtimeMode: ClientRuntimeMode): ClientRuntimeShape {
  return runtimeMode === "direct" ? "direct" : "app-owned";
}

function configureFileClient(
  client: McpClient,
  options: Required<Pick<ClientConfigOptions, "dryRun" | "now">> & {
    runtimeMode: ClientRuntimeMode;
    token?: string;
  },
): ClientConfigResult {
  const configExists = existsSync(client.configPath);
  const parentExists = existsSync(dirname(client.configPath));
  if (!configExists && !parentExists) {
    return {
      name: client.name,
      status: "skipped",
      detail: "client config directory not found",
      configPath: client.configPath,
    };
  }

  let targetEntry: ClientStdioEntry =
    options.runtimeMode === "direct"
      ? directStdioEntry()
      : stdioProxyEntry(options.dryRun ? "<app-runtime-token>" : options.token);
  const detail = runtimeDetail(options.runtimeMode);
  const targetShape = targetRuntimeShape(options.runtimeMode);

  try {
    let existing: Record<string, unknown> = {};
    if (configExists) {
      const parsed: unknown = JSON.parse(readFileSync(client.configPath, "utf-8"));
      if (!isPlainObject(parsed)) throw new Error("existing config is not a JSON object");
      existing = parsed;
    }

    const rawServers = existing[client.serversKey];
    const servers: Record<string, unknown> = isPlainObject(rawServers) ? rawServers : {};
    const currentEntry = servers.taxi;
    const currentShape = clientRuntimeShape(currentEntry);
    if (options.runtimeMode === "app" && availableBundledProxyEntry(currentEntry)) {
      const targetToken = targetEntry.env?.TAXI_HTTP_TOKEN;
      if (!targetToken) throw new Error("app-owned client entry is missing its runtime token");
      const currentToken = currentEntry.env.TAXI_HTTP_TOKEN;
      const targetUsesFallback = targetEntry.command === "npx";
      if (!options.dryRun && targetUsesFallback && currentToken === targetToken) {
        return {
          name: client.name,
          status: "already-configured",
          detail,
          configPath: client.configPath,
        };
      }
      if (!options.dryRun && targetUsesFallback) {
        targetEntry = {
          command: currentEntry.command,
          args: currentEntry.args,
          env: { ...currentEntry.env, TAXI_HTTP_TOKEN: targetToken },
        };
      }
    }
    if (!options.dryRun && deepEqual(currentEntry, targetEntry)) {
      return {
        name: client.name,
        status: "already-configured",
        detail,
        configPath: client.configPath,
      };
    }
    if (
      options.dryRun &&
      currentShape === targetShape &&
      (currentShape !== "app-owned" ||
        (isPlainObject(currentEntry) && currentEntry.command === "npx") ||
        availableBundledProxyEntry(currentEntry))
    ) {
      return {
        name: client.name,
        status: "already-configured",
        detail,
        configPath: client.configPath,
      };
    }

    if (options.dryRun) {
      return {
        name: client.name,
        status: "would-configure",
        detail: configExists ? `would replace taxi with the ${detail}` : "would create config file",
        configPath: client.configPath,
      };
    }

    servers.taxi = targetEntry;
    existing[client.serversKey] = servers;

    // App-runtime mode embeds the TAXI_HTTP_TOKEN — the sole credential gating
    // the local HTTP tool surface — into the client config. Write it owner-only
    // (0600), matching the token file's own protection, so it is not left
    // world-readable (0644) in a shared-home scenario. writeFileSync's `mode`
    // only applies when creating a new file, so chmod explicitly to also cover an
    // existing config and the backup copy.
    const tokenMode = options.runtimeMode !== "direct";
    if (configExists) {
      const backupPath = `${client.configPath}.bak.${options.now()}`;
      copyFileSync(client.configPath, backupPath);
      if (tokenMode) chmodSync(backupPath, 0o600);
    }
    mkdirSync(dirname(client.configPath), { recursive: true });
    writeFileSync(client.configPath, JSON.stringify(existing, null, 2) + "\n", tokenMode ? { mode: 0o600 } : undefined);
    if (tokenMode) chmodSync(client.configPath, 0o600);

    return {
      name: client.name,
      status: "configured",
      detail,
      configPath: client.configPath,
    };
  } catch (error) {
    return {
      name: client.name,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
      configPath: client.configPath,
    };
  }
}

function configureCodexClient(
  options: Required<Pick<ClientConfigOptions, "dryRun">> & {
    runtimeMode: ClientRuntimeMode;
    codex: NonNullable<ClientConfigOptions["codex"]>;
  },
): ClientConfigResult {
  if (!options.codex.isAvailable()) {
    return { name: "Codex", status: "skipped", detail: "codex CLI not found" };
  }

  try {
    const shape = options.codex.shape();
    if (options.runtimeMode === "direct") {
      if (shape === "direct") {
        return { name: "Codex", status: "already-configured", detail: "direct stdio runtime" };
      }
      if (options.dryRun) {
        return {
          name: "Codex",
          status: "would-configure",
          detail: shape === "missing" ? "would add taxi MCP server" : "would replace existing taxi MCP server",
        };
      }
      if (!options.codex.configureDirect) {
        throw new Error("direct Codex configuration is unavailable");
      }
      options.codex.configureDirect();
      return { name: "Codex", status: "configured", detail: "direct stdio runtime" };
    }
    if (shape === "app-owned" || shape === "app-owned-pending-restart") {
      return { name: "Codex", status: "already-configured", detail: "Taxi.app runtime" };
    }
    if (options.dryRun) {
      return {
        name: "Codex",
        status: "would-configure",
        detail: shape === "missing" ? "would add taxi MCP server" : "would replace existing taxi MCP server",
      };
    }
    options.codex.configure();
    return { name: "Codex", status: "configured", detail: "token-gated Taxi.app runtime" };
  } catch (error) {
    return { name: "Codex", status: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
}

export function configureMcpClients(options: ClientConfigOptions = {}): ClientConfigResult[] {
  const dryRun = options.dryRun ?? false;
  const includeSkipped = options.includeSkipped ?? true;
  const clients = options.clients ?? MCP_CLIENTS;
  const now = options.now ?? Date.now;
  const runtimeMode = options.runtimeMode ?? "app";
  const codex = options.codex ?? {
    isAvailable: isCodexCliAvailable,
    shape: codexTaxiRuntimeShape,
    configure: configureCodexTaxi,
    configureDirect: configureCodexTaxiDirect,
  };

  const results = clients.map((client) =>
    configureFileClient(client, { dryRun, now, runtimeMode, token: options.token }),
  );
  if (options.configureCodex ?? true) {
    results.push(configureCodexClient({ dryRun, runtimeMode, codex }));
  }
  return includeSkipped ? results : results.filter((result) => result.status !== "skipped");
}
