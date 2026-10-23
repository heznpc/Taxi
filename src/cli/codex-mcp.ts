import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { NPM_PACKAGE_SPECIFIER, readOnlyConfigFileSnapshot } from "../shared/config.js";
import { HOME, IDENTITY } from "../shared/constants.js";
import { ensureAppRuntimeToken } from "../shared/app-runtime-token.js";

export const CODEX_APP_OWNED_URL = `http://127.0.0.1:${IDENTITY.HTTP_PORT}/mcp`;
const INSTALLED_TAXI_APP = "/Applications/Taxi.app";
const BUNDLED_NODE_SUFFIX = "/Contents/Resources/taxi/runtime/bin/node";
const BUNDLED_SERVER_SUFFIX = "/Contents/Resources/taxi/server/dist/index.js";
export type CodexTaxiRuntimeShape =
  | "app-owned"
  | "app-owned-disabled"
  | "app-owned-stale"
  | "app-owned-pending-restart"
  | "direct"
  | "direct-disabled"
  | "unknown"
  | "missing";
type CodexConfigFileRuntimeShape =
  "app-owned" | "app-owned-disabled" | "app-owned-stale" | "direct" | "direct-disabled" | "unknown";
export type CodexTaxiEnabledState = "enabled" | "disabled" | "missing" | "invalid";

interface CodexConfigPathSelection {
  absolutePath?: string;
  errorMessage?: string;
}

class CodexConfigPathError extends Error {
  override readonly name = "CodexConfigPathError";
}

function selectCodexConfigPath(env: NodeJS.ProcessEnv): CodexConfigPathSelection {
  const candidate = env.TAXI_CODEX_CONFIG_PATH
    ? env.TAXI_CODEX_CONFIG_PATH
    : env.CODEX_HOME
      ? join(env.CODEX_HOME, "config.toml")
      : join(env.HOME ?? env.USERPROFILE ?? HOME, ".codex", "config.toml");
  try {
    const absolutePath = resolve(candidate);
    if (basename(absolutePath) !== "config.toml") {
      return {
        errorMessage: "TAXI_CODEX_CONFIG_PATH must name config.toml because Codex only reads CODEX_HOME/config.toml",
      };
    }
    return { absolutePath };
  } catch {
    return { errorMessage: "The selected Codex config must be a valid filesystem path named config.toml" };
  }
}

/** Resolve one candidate for tests and callers that need explicit validation. */
export function resolveCodexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const selection = selectCodexConfigPath(env);
  if (selection.errorMessage) throw new CodexConfigPathError(selection.errorMessage);
  return selection.absolutePath!;
}

// Capture environment selection once without throwing during module import.
// Unrelated/config-only commands may import this module without touching Codex;
// the first actual Codex boundary below fails closed with the stored error.
const CODEX_CONFIG_SELECTION = selectCodexConfigPath(process.env);

function requireCodexConfigPath(): string {
  if (CODEX_CONFIG_SELECTION.errorMessage) {
    throw new CodexConfigPathError(CODEX_CONFIG_SELECTION.errorMessage);
  }
  return CODEX_CONFIG_SELECTION.absolutePath!;
}

export interface CodexProjectOverride {
  path: string;
  state: Exclude<CodexTaxiEnabledState, "missing">;
}

export interface CodexTaxiRegistrationState {
  globalConfigPath: string;
  globalState: CodexTaxiEnabledState;
  /**
   * The nearest project-local Taxi entry, when present. Codex gives this
   * entry precedence in that project; Taxi deliberately never edits it from
   * a global enable/disable operation.
   */
  projectOverride?: CodexProjectOverride;
}

export interface CodexTaxiEnabledResult extends CodexTaxiRegistrationState {
  changed: boolean;
}

export interface CodexTaxiConfigOptions {
  configPath?: string;
  projectDirectory?: string;
}

export interface ConfigureCodexTaxiOptions {
  enabled?: boolean;
}

function runCodex(args: string[], usesConfig = true): string {
  const configPath = usesConfig ? requireCodexConfigPath() : undefined;
  return execFileSync("codex", args, {
    // `codex mcp get` resolves a trusted project's `.codex/config.toml` ahead
    // of the user config. Taxi's setup owns only the persistent user entry,
    // so run from HOME and report project overrides separately.
    cwd: HOME,
    // Codex accepts a config directory rather than a config-file flag. Point
    // every CLI read/write at the same config.toml selected above, including
    // the Taxi-only explicit path override used by isolated integrations.
    env: configPath ? { ...process.env, CODEX_HOME: dirname(configPath) } : process.env,
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

interface CodexTomlSection {
  lines: string[];
  headerIndex: number;
  endIndex: number;
  enabledIndex?: number;
  enabled?: boolean;
  invalid: boolean;
}

function lineContent(line: string): string {
  return line.replace(/\r?\n$/, "");
}

function locateCodexTaxiSection(toml: string): CodexTomlSection | null {
  const lines = toml.split(/(?<=\n)/);
  const headers = lines
    .map((line, index) => ({ content: lineContent(line).trim(), index }))
    .filter(({ content }) => /^\[mcp_servers\.taxi\](?:\s*#.*)?$/.test(content));
  if (headers.length === 0) return null;
  if (headers.length > 1) {
    return { lines, headerIndex: headers[0]!.index, endIndex: headers[0]!.index + 1, invalid: true };
  }

  const headerIndex = headers[0]!.index;
  let endIndex = lines.length;
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lineContent(lines[index]!))) {
      endIndex = index;
      break;
    }
  }

  let enabledIndex: number | undefined;
  let enabled: boolean | undefined;
  let invalid = false;
  for (let index = headerIndex + 1; index < endIndex; index += 1) {
    const content = lineContent(lines[index]!);
    if (!/^\s*enabled\s*=/.test(content)) continue;
    if (enabledIndex !== undefined) {
      invalid = true;
      continue;
    }
    enabledIndex = index;
    const match = content.match(/^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/i);
    if (!match) {
      invalid = true;
      continue;
    }
    enabled = match[1]!.toLowerCase() === "true";
  }

  return { lines, headerIndex, endIndex, enabledIndex, enabled, invalid };
}

export function codexConfigTomlEnabledState(toml: string): CodexTaxiEnabledState {
  const section = locateCodexTaxiSection(toml);
  if (!section) return "missing";
  if (section.invalid) return "invalid";
  // Codex defaults an existing MCP server to enabled when the key is absent.
  return section.enabled === false ? "disabled" : "enabled";
}

/**
 * Toggle only `[mcp_servers.taxi].enabled`, preserving every other setting
 * byte-for-byte and leaving nested sections such as `.env` untouched.
 */
export function updateCodexTaxiEnabledInToml(
  toml: string,
  enabled: boolean,
): { toml: string; found: boolean; changed: boolean } {
  const section = locateCodexTaxiSection(toml);
  if (!section) return { toml, found: false, changed: false };
  if (section.invalid) {
    throw new Error("Codex config has an invalid or duplicate [mcp_servers.taxi] enabled setting");
  }
  if ((section.enabled ?? true) === enabled) return { toml, found: true, changed: false };

  if (section.enabledIndex !== undefined) {
    const originalLine = section.lines[section.enabledIndex]!;
    const ending = originalLine.match(/\r?\n$/)?.[0] ?? "";
    const content = lineContent(originalLine);
    section.lines[section.enabledIndex] =
      content.replace(/^(\s*enabled\s*=\s*)(true|false)(\s*(?:#.*)?)$/i, `$1${String(enabled)}$3`) + ending;
  } else {
    const headerLine = section.lines[section.headerIndex]!;
    const defaultEnding = toml.includes("\r\n") ? "\r\n" : "\n";
    const headerEnding = headerLine.match(/\r?\n$/)?.[0];
    if (headerEnding) {
      section.lines.splice(section.headerIndex + 1, 0, `enabled = ${String(enabled)}${headerEnding}`);
    } else {
      section.lines[section.headerIndex] = headerLine + defaultEnding;
      section.lines.splice(section.headerIndex + 1, 0, `enabled = ${String(enabled)}`);
    }
  }
  return { toml: section.lines.join(""), found: true, changed: true };
}

function readCodexEnabledState(configPath: string): CodexTaxiEnabledState {
  if (!existsSync(configPath)) return "missing";
  return codexConfigTomlEnabledState(readFileSync(configPath, "utf8"));
}

function findCodexProjectOverride(startDirectory: string, globalConfigPath: string): CodexProjectOverride | undefined {
  let directory = resolve(startDirectory);
  const normalizedGlobalPath = resolve(globalConfigPath);
  while (true) {
    const candidate = join(directory, ".codex", "config.toml");
    if (resolve(candidate) !== normalizedGlobalPath && existsSync(candidate)) {
      const state = readCodexEnabledState(candidate);
      if (state !== "missing") return { path: candidate, state };
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export function inspectCodexTaxiRegistration(options: CodexTaxiConfigOptions = {}): CodexTaxiRegistrationState {
  const globalConfigPath = options.configPath ?? requireCodexConfigPath();
  const projectOverride = findCodexProjectOverride(options.projectDirectory ?? process.cwd(), globalConfigPath);
  return {
    globalConfigPath,
    globalState: readCodexEnabledState(globalConfigPath),
    ...(projectOverride ? { projectOverride } : {}),
  };
}

export function setCodexTaxiEnabled(enabled: boolean, options: CodexTaxiConfigOptions = {}): CodexTaxiEnabledResult {
  const before = inspectCodexTaxiRegistration(options);
  if (before.globalState === "missing") return { ...before, changed: false };
  if (before.globalState === "invalid") {
    throw new Error("Codex config has an invalid or duplicate [mcp_servers.taxi] enabled setting");
  }

  const original = readFileSync(before.globalConfigPath, "utf8");
  const updated = updateCodexTaxiEnabledInToml(original, enabled);
  if (updated.changed) {
    atomicReplaceFile(before.globalConfigPath, updated.toml, statSync(before.globalConfigPath).mode & 0o777);
  }
  return {
    ...inspectCodexTaxiRegistration(options),
    changed: updated.changed,
  };
}

function atomicReplaceFile(path: string, content: string, mode: number): void {
  const temporaryPath = join(dirname(path), `.${basename(path)}.taxi-${process.pid}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, content, { encoding: "utf8", mode });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

/**
 * The app-owned Codex config embeds TAXI_HTTP_TOKEN — the sole credential
 * gating the local HTTP runtime — in `[mcp_servers.taxi.env]`. Force
 * owner-only permissions (0600) whenever the config on disk carries that
 * token, the same convention client-config.ts applies to token-bearing MCP
 * client configs, so it is not left world-readable (0644, the typical
 * default for a file the `codex` CLI itself writes) in a shared-home
 * scenario. Best-effort: a permission-lockdown failure must not mask an
 * otherwise-successful configure result.
 */
function lockDownCodexConfigIfTokenPresent(): void {
  try {
    const configPath = requireCodexConfigPath();
    if (existsSync(configPath) && readFileSync(configPath, "utf8").includes("TAXI_HTTP_TOKEN")) {
      chmodSync(configPath, 0o600);
    }
  } catch {
    /* best-effort; the configure operation itself already succeeded */
  }
}

export function isCodexCliAvailable(): boolean {
  try {
    // Executable detection does not read or mutate config. Delaying config
    // validation lets client setup report the selected-path error accurately
    // instead of misclassifying a present Codex CLI as absent.
    runCodex(["--version"], false);
    return true;
  } catch {
    return false;
  }
}

export function getCodexTaxiConfig(): string | null {
  try {
    return runCodex(["mcp", "get", "taxi"]);
  } catch (error) {
    if (error instanceof CodexConfigPathError) throw error;
    return null;
  }
}

export function isCodexTaxiConfigured(): boolean {
  return getCodexTaxiConfig() !== null;
}

function codexCliRuntimeShape(config: string | null): Exclude<CodexTaxiRuntimeShape, "app-owned-pending-restart"> {
  if (!config) return "missing";
  const disabled = /\benabled:\s*false\b/i.test(config);
  const command = config.match(/^\s*command:\s*(.*?)\s*$/m)?.[1] ?? "";
  const args = config.match(/^\s*args:\s*(.*?)\s*$/m)?.[1] ?? "";
  const expectedDirectArgs = `-y ${NPM_PACKAGE_SPECIFIER} run`;
  const cliArgs = args.split(/\s+/).filter(Boolean);
  if (
    isAppOwnedProxyInvocation(command, cliArgs) &&
    config.includes("transport: stdio") &&
    config.includes("TAXI_HTTP_TOKEN")
  ) {
    return disabled ? "app-owned-disabled" : "app-owned";
  }
  if (command === "npx" && args === expectedDirectArgs && config.includes("transport: stdio")) {
    return disabled ? "direct-disabled" : "direct";
  }
  return "unknown";
}

function sectionBody(toml: string, header: string): string {
  const lines = toml.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return "";
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^\s*\[/.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

/** Extract the TAXI_HTTP_TOKEN value from a Codex `[mcp_servers.taxi]`
 *  block, covering BOTH the standalone `[mcp_servers.taxi.env]` subsection
 *  form and the inline-table `env = { TAXI_HTTP_TOKEN = "..." }` form.
 *  Returns the literal token string, or null when absent. */
function extractCodexHttpToken(serverBody: string, envBody: string): string | null {
  // Standalone subsection: TAXI_HTTP_TOKEN = "value"
  const subsection = envBody.match(/TAXI_HTTP_TOKEN\s*=\s*"([^"]*)"/);
  if (subsection) return subsection[1] ?? null;
  // Inline table on the server block: env = { ..., TAXI_HTTP_TOKEN = "value", ... }
  const inline = serverBody.match(/TAXI_HTTP_TOKEN\s*=\s*"([^"]*)"/);
  if (inline) return inline[1] ?? null;
  return null;
}

/** True only when the Taxi server table itself carries a literal bearer. */
export function codexConfigTomlHasTaxiHttpToken(toml: string): boolean {
  const server = sectionBody(toml, "[mcp_servers.taxi]");
  if (!server) return false;
  return extractCodexHttpToken(server, sectionBody(toml, "[mcp_servers.taxi.env]")) !== null;
}

function extractTomlString(serverBody: string, key: string): string | null {
  const match = serverBody.match(new RegExp(`^\\s*${key}\\s*=\\s*("(?:\\\\.|[^"\\\\])*")\\s*(?:#.*)?$`, "m"));
  if (!match?.[1]) return null;
  try {
    const value: unknown = JSON.parse(match[1]);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function extractTomlStringArray(serverBody: string, key: string): string[] | null {
  const match = serverBody.match(new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]\\s*(?:#.*)?$`, "m"));
  if (!match) return null;
  const values: string[] = [];
  const content = match[1] ?? "";
  const stringPattern = /"(?:\\.|[^"\\])*"/g;
  let cursor = 0;
  for (const item of content.matchAll(stringPattern)) {
    const index = item.index ?? 0;
    if (!/^[\s,]*$/.test(content.slice(cursor, index))) return null;
    try {
      const value: unknown = JSON.parse(item[0]);
      if (typeof value !== "string") return null;
      values.push(value);
    } catch {
      return null;
    }
    cursor = index + item[0].length;
  }
  if (!/^[\s,]*$/.test(content.slice(cursor))) return null;
  return values;
}

function sameStrings(actual: string[] | null, expected: readonly string[]): boolean {
  return (
    actual !== null && actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

/**
 * Match either the version-pinned npm fallback or the deterministic runtime
 * embedded in a Taxi.app bundle. This is shared by config writers and readers
 * so an entry produced by the native app is not later classified as unknown or
 * replaced with a network-dependent npx command.
 */
export function isAppOwnedProxyInvocation(command: string, args: readonly string[]): boolean {
  if (
    command === "npx" &&
    sameStrings([...args], ["-y", NPM_PACKAGE_SPECIFIER, "connect", "--url", CODEX_APP_OWNED_URL])
  ) {
    return true;
  }
  if (!command.startsWith("/") || !command.endsWith(BUNDLED_NODE_SUFFIX)) return false;
  const appPath = command.slice(0, -BUNDLED_NODE_SUFFIX.length);
  if (!appPath.endsWith("/Taxi.app")) return false;
  return sameStrings([...args], [`${appPath}${BUNDLED_SERVER_SUFFIX}`, "connect", "--url", CODEX_APP_OWNED_URL]);
}

function installedAppOwnedProxyInvocation(): { command: string; args: string[] } | undefined {
  const command = `${INSTALLED_TAXI_APP}${BUNDLED_NODE_SUFFIX}`;
  const serverEntry = `${INSTALLED_TAXI_APP}${BUNDLED_SERVER_SUFFIX}`;
  if (!existsSync(command) || !existsSync(serverEntry)) return undefined;
  return {
    command,
    args: [serverEntry, "connect", "--url", CODEX_APP_OWNED_URL],
  };
}

/**
 * Classify a Codex `config.toml`. When `liveToken` is provided, an app-owned
 * proxy entry is only reported as `"app-owned"` if its stored token VALUE
 * matches the live runtime token — a stale/wrong token is preserved as
 * `"app-owned-stale"` so doctor fails and setup repairs it. When `liveToken` is omitted the
 * function is a pure structural parse (token presence only).
 */
export function codexConfigTomlRuntimeShape(toml: string, liveToken?: string): CodexConfigFileRuntimeShape {
  const server = sectionBody(toml, "[mcp_servers.taxi]");
  if (!server) return "unknown";
  const env = sectionBody(toml, "[mcp_servers.taxi.env]");
  const command = extractTomlString(server, "command");
  const args = extractTomlStringArray(server, "args");
  const configToken = extractCodexHttpToken(server, env);
  const hasToken = configToken !== null;
  const disabled = codexConfigTomlEnabledState(toml) === "disabled";
  if (command !== null && args !== null && isAppOwnedProxyInvocation(command, args) && hasToken) {
    // A definite mismatch is materially different from an unknown shape. Keep
    // it explicit so setup can repair it and doctor can fail the operational
    // gate instead of downgrading a deterministic 401 to a warning.
    if (liveToken !== undefined && configToken !== liveToken) return "app-owned-stale";
    return disabled ? "app-owned-disabled" : "app-owned";
  }
  if (command === "npx" && sameStrings(args, ["-y", NPM_PACKAGE_SPECIFIER, "run"])) {
    return disabled ? "direct-disabled" : "direct";
  }
  return "unknown";
}

function codexConfigFileRuntimeShape(): CodexConfigFileRuntimeShape {
  const configPath = requireCodexConfigPath();
  try {
    if (!existsSync(configPath)) return "unknown";
    // Pass the live runtime token so a config carrying a stale/wrong token
    // is not classified app-owned — it falls through and gets repaired.
    return codexConfigTomlRuntimeShape(readFileSync(configPath, "utf8"), ensureAppRuntimeToken());
  } catch {
    return "unknown";
  }
}

export function codexTaxiRuntimeShapeFromTomlReadOnly(toml: string, liveToken?: string): CodexTaxiRuntimeShape {
  if (codexConfigTomlEnabledState(toml) === "missing") return "missing";
  const shape = codexConfigTomlRuntimeShape(toml, liveToken);
  // A structurally valid TOML token cannot prove the configured bearer
  // matches when the private credential itself is missing or invalid.
  // Diagnosis fails closed without starting Codex, creating its state, or
  // repairing the credential; setup/repair retains the mutating path above.
  if (liveToken === undefined && (shape === "app-owned" || shape === "app-owned-disabled")) return "unknown";
  return shape;
}

function codexConfigFileRuntimeShapeReadOnly(liveToken?: string): CodexTaxiRuntimeShape {
  const configPath = requireCodexConfigPath();
  try {
    const snapshot = readOnlyConfigFileSnapshot(configPath, { label: "Codex config" });
    return snapshot ? codexTaxiRuntimeShapeFromTomlReadOnly(snapshot.content, liveToken) : "missing";
  } catch {
    return "unknown";
  }
}

function mergeCodexRuntimeShapes(
  cliShape: Exclude<CodexTaxiRuntimeShape, "app-owned-pending-restart">,
  fileShape: CodexConfigFileRuntimeShape,
): CodexTaxiRuntimeShape {
  // The CLI redacts bearer values, so the file is the only source capable of
  // proving a definite mismatch. Never let the structural CLI snapshot erase
  // that stronger stale-token observation.
  if (fileShape === "app-owned-stale") return "app-owned-stale";
  if (cliShape === "app-owned" || cliShape === "app-owned-disabled") {
    // `codex mcp get` redacts the token value, so its structural output cannot
    // prove that the persisted bearer still matches the current app token. When
    // a global Taxi table exists, let the value-aware TOML parser fail closed on
    // a stale token instead of suppressing repair.
    if (readCodexEnabledState(requireCodexConfigPath()) !== "missing" && fileShape === "unknown") return "unknown";
    return cliShape;
  }

  if (fileShape === "app-owned") return "app-owned-pending-restart";
  if (fileShape === "app-owned-disabled" || fileShape === "direct" || fileShape === "direct-disabled") return fileShape;
  if (cliShape === "missing" && readCodexEnabledState(requireCodexConfigPath()) !== "missing") return "unknown";
  return cliShape;
}

export function codexTaxiRuntimeShape(): CodexTaxiRuntimeShape {
  return mergeCodexRuntimeShapes(codexCliRuntimeShape(getCodexTaxiConfig()), codexConfigFileRuntimeShape());
}

/**
 * Read the file-backed Codex Taxi shape without launching Codex, creating a
 * runtime token, changing its mode, or rewriting config. `codex mcp get` is
 * intentionally excluded: even a nominal read can initialise Codex state.
 * When no validated live token is available, app-owned registration is
 * intentionally unknown; callers may report presence but must not call it
 * connected or repaired.
 */
export function codexTaxiRuntimeShapeReadOnly(liveToken?: string): CodexTaxiRuntimeShape {
  return codexConfigFileRuntimeShapeReadOnly(liveToken);
}

interface CodexStdioSnapshot {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
}

interface CodexHttpSnapshot {
  type: "streamable_http";
  url: string;
  bearerTokenEnvVar?: string;
  enabled: boolean;
}

type CodexMcpSnapshot = CodexStdioSnapshot | CodexHttpSnapshot;

interface CodexConfigFileSnapshot {
  content: string;
  mode: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseStringRecord(value: unknown): Record<string, string> | null {
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}

function parseCodexMcpSnapshot(raw: string): CodexMcpSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Codex returned an invalid JSON snapshot for the existing Taxi entry");
  }
  if (!isRecord(parsed) || !isRecord(parsed.transport)) {
    throw new Error("Codex returned an unsupported snapshot for the existing Taxi entry");
  }
  const enabled = typeof parsed.enabled === "boolean" ? parsed.enabled : true;
  const transport = parsed.transport;
  if (transport.type === "stdio") {
    const env = parseStringRecord(transport.env);
    if (
      typeof transport.command !== "string" ||
      !Array.isArray(transport.args) ||
      transport.args.some((arg) => typeof arg !== "string") ||
      env === null
    ) {
      throw new Error("Codex returned an unsupported stdio snapshot for the existing Taxi entry");
    }
    return {
      type: "stdio",
      command: transport.command,
      args: transport.args as string[],
      env,
      enabled,
    };
  }
  if (transport.type === "streamable_http") {
    if (
      typeof transport.url !== "string" ||
      (transport.bearer_token_env_var !== null &&
        transport.bearer_token_env_var !== undefined &&
        typeof transport.bearer_token_env_var !== "string")
    ) {
      throw new Error("Codex returned an unsupported HTTP snapshot for the existing Taxi entry");
    }
    return {
      type: "streamable_http",
      url: transport.url,
      ...(typeof transport.bearer_token_env_var === "string"
        ? { bearerTokenEnvVar: transport.bearer_token_env_var }
        : {}),
      enabled,
    };
  }
  throw new Error("Codex returned an unsupported transport snapshot for the existing Taxi entry");
}

function captureCodexMcpSnapshot(): CodexMcpSnapshot {
  let raw: string;
  try {
    raw = runCodex(["mcp", "get", "taxi", "--json"]);
  } catch (cause) {
    if (cause instanceof CodexConfigPathError) throw cause;
    throw new Error("Codex could not snapshot the existing Taxi entry; replacement was not attempted", { cause });
  }
  return parseCodexMcpSnapshot(raw);
}

function captureCodexConfigFileSnapshot(): CodexConfigFileSnapshot | null {
  const configPath = requireCodexConfigPath();
  if (!existsSync(configPath)) return null;
  return {
    content: readFileSync(configPath, "utf8"),
    mode: statSync(configPath).mode & 0o777,
  };
}

function restoreArgs(snapshot: CodexMcpSnapshot): string[] {
  if (snapshot.type === "stdio") {
    const envArgs = Object.entries(snapshot.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
    return ["mcp", "add", ...envArgs, "taxi", "--", snapshot.command, ...snapshot.args];
  }
  return [
    "mcp",
    "add",
    "taxi",
    "--url",
    snapshot.url,
    ...(snapshot.bearerTokenEnvVar ? ["--bearer-token-env-var", snapshot.bearerTokenEnvVar] : []),
  ];
}

function requireEnabledState(enabled: boolean): void {
  if (enabled) return;
  const toggled = setCodexTaxiEnabled(false);
  if (toggled.globalState === "missing") {
    throw new Error(`Codex did not write the expected global Taxi entry at ${toggled.globalConfigPath}`);
  }
}

function replaceCodexMcpWithRollback(
  snapshot: CodexMcpSnapshot,
  configFileSnapshot: CodexConfigFileSnapshot | null,
  replacementArgs: string[],
  enabled: boolean,
): void {
  try {
    // Keep remove inside the transaction boundary: Codex could mutate the
    // config and still return a non-zero status.
    runCodex(["mcp", "remove", "taxi"]);
    runCodex(replacementArgs);
    requireEnabledState(enabled);
  } catch (replacementCause) {
    try {
      if (configFileSnapshot) {
        // Codex's JSON surface intentionally omits some TOML fields (cwd,
        // timeouts, tool filters, env indirection). Restoring the complete
        // pre-remove file is the only lossless rollback for the user config.
        atomicReplaceFile(requireCodexConfigPath(), configFileSnapshot.content, configFileSnapshot.mode);
      } else {
        // A nonstandard Codex home can expose an entry while the configured
        // global path is absent. Fall back to the supported transport fields.
        try {
          runCodex(["mcp", "remove", "taxi"]);
        } catch {
          // A missing partial entry is the normal failure mode.
        }
        runCodex(restoreArgs(snapshot));
        requireEnabledState(snapshot.enabled);
      }
    } catch (restorationCause) {
      throw new Error(`Codex failed to replace Taxi and failed to restore the previous ${snapshot.type} entry`, {
        cause: restorationCause,
      });
    }
    throw new Error(`Codex failed to replace Taxi; the previous ${snapshot.type} entry was restored`, {
      cause: replacementCause,
    });
  }
}

function addOrReplaceCodexMcp(shape: CodexTaxiRuntimeShape, replacementArgs: string[], enabled: boolean): void {
  if (shape === "missing") {
    runCodex(replacementArgs);
    requireEnabledState(enabled);
    return;
  }
  const snapshot = captureCodexMcpSnapshot();
  const configFileSnapshot = captureCodexConfigFileSnapshot();
  replaceCodexMcpWithRollback(snapshot, configFileSnapshot, replacementArgs, enabled);
}

export function configureCodexTaxi(options: ConfigureCodexTaxiOptions = {}): "already-configured" | "configured" {
  const enabled = options.enabled ?? true;
  const token = ensureAppRuntimeToken();
  const shape = codexTaxiRuntimeShape();
  if (shape === "app-owned" || shape === "app-owned-disabled" || shape === "app-owned-pending-restart") {
    const toggled = setCodexTaxiEnabled(enabled);
    if (toggled.globalState === "missing") {
      if (enabled) return "already-configured";
      throw new Error(
        "Codex reports Taxi from a non-global config; the global Taxi entry is missing and was not changed",
      );
    }
    lockDownCodexConfigIfTokenPresent();
    return toggled.changed ? "configured" : "already-configured";
  }
  addOrReplaceCodexMcp(
    shape,
    [
      "mcp",
      "add",
      "--env",
      `TAXI_HTTP_TOKEN=${token}`,
      "taxi",
      "--",
      "npx",
      "-y",
      NPM_PACKAGE_SPECIFIER,
      "connect",
      "--url",
      CODEX_APP_OWNED_URL,
    ],
    enabled,
  );
  lockDownCodexConfigIfTokenPresent();
  return "configured";
}

export function configureCodexTaxiDirect(options: ConfigureCodexTaxiOptions = {}): "already-configured" | "configured" {
  const enabled = options.enabled ?? true;
  const shape = codexTaxiRuntimeShape();
  if (shape === "direct" || shape === "direct-disabled") {
    const toggled = setCodexTaxiEnabled(enabled);
    if (toggled.globalState === "missing") {
      if (enabled) return "already-configured";
      throw new Error(
        "Codex reports Taxi from a non-global config; the global Taxi entry is missing and was not changed",
      );
    }
    return toggled.changed ? "configured" : "already-configured";
  }
  addOrReplaceCodexMcp(shape, ["mcp", "add", "taxi", "--", "npx", "-y", NPM_PACKAGE_SPECIFIER, "run"], enabled);
  return "configured";
}

export function codexManualSetupCommand(): string {
  return (
    "codex mcp add --env TAXI_HTTP_TOKEN=<token> taxi -- npx -y " +
    NPM_PACKAGE_SPECIFIER +
    " connect --url " +
    CODEX_APP_OWNED_URL
  );
}

export function codexDirectManualSetupCommand(): string {
  return "codex mcp add taxi -- npx -y " + NPM_PACKAGE_SPECIFIER + " run";
}

export function directStdioEntry(): {
  command: string;
  args: string[];
} {
  return {
    command: "npx",
    args: ["-y", NPM_PACKAGE_SPECIFIER, "run"],
  };
}

export function stdioProxyEntry(token = ensureAppRuntimeToken()): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  const invocation = installedAppOwnedProxyInvocation() ?? {
    command: "npx",
    args: ["-y", NPM_PACKAGE_SPECIFIER, "connect", "--url", CODEX_APP_OWNED_URL],
  };
  return {
    ...invocation,
    env: {
      TAXI_HTTP_TOKEN: token,
    },
  };
}
