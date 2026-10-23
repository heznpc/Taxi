import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { release } from "node:os";
import { HOME, PATHS } from "./constants.js";
import { HEALTHKIT_MIN_MACOS, type CompatibilityEnv } from "./compatibility.js";
import { log, errToCtx } from "./logger.js";
import {
  DEFAULT_TOOL_EXPOSURE_BY_PROFILE,
  KNOWN_MODULE_NAMES,
  OPT_IN_MODULE_NAMES,
  PROFILE_NAMES,
  getProfileModules,
  getProgressiveToolAllowlist,
  normalizeProfileName,
  normalizeToolExposureMode,
  type ActiveProfileName,
  type TaxiProfileName,
  type ToolExposureMode,
} from "./profiles.js";
import {
  MODULE_PACK_NAMES,
  getDefaultModulePacks,
  resolveModulePackSelection,
  type ModulePackName,
} from "./module-packs.js";

const DEFAULT_CONFIG_READ_LIMIT = 1024 * 1024;

export interface ReadOnlyConfigFileSnapshot {
  content: string;
  mode: number;
  size: number;
  uid: number;
}

/**
 * Read an optional user-owned config without following the final path component.
 *
 * The regular-file, owner, size, and content checks all use the same open file
 * descriptor. This avoids the lstat(path) -> readFile(path) replacement window
 * and also bounds a file that grows after fstat. O_NONBLOCK prevents a FIFO at
 * the selected path from hanging a diagnostic command before it can be rejected.
 */
export function readOnlyConfigFileSnapshot(
  path: string,
  options: { label?: string; maxBytes?: number; uid?: number } = {},
): ReadOnlyConfigFileSnapshot | undefined {
  const label = options.label ?? "config file";
  const maxBytes = options.maxBytes ?? DEFAULT_CONFIG_READ_LIMIT;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new Error(`${label} read limit must be a positive integer`);

  const uid = options.uid ?? process.getuid?.();
  if (typeof uid !== "number") throw new Error(`${label} current uid could not be determined`);

  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
    if (code === "ENOENT") return undefined;
    if (code === "ELOOP") throw new Error(`${label} must not be a symbolic link`, { cause: error });
    throw new Error(
      `${label} could not be opened read-only: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
    if (stat.uid !== uid) throw new Error(`${label} is owned by uid ${stat.uid}; expected current uid ${uid}`);
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes) {
      throw new Error(`${label} exceeds the ${maxBytes}-byte diagnostic read limit`);
    }

    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte diagnostic read limit`);
      chunks.push(chunk.subarray(0, bytesRead));
    }

    return {
      content: Buffer.concat(chunks, total).toString("utf8"),
      mode: stat.mode & 0o777,
      size: total,
      uid: stat.uid,
    };
  } finally {
    closeSync(fd);
  }
}

export {
  DEFAULT_TOOL_EXPOSURE_BY_PROFILE,
  FRONT_DOOR_TOOLS,
  KNOWN_MODULE_NAMES,
  MODULE_NAMES,
  OPT_IN_MODULE_NAMES,
  PRESET_PROFILE_NAMES,
  PROFILE_DESCRIPTIONS,
  PROFILE_MODULES,
  PROFILE_NAMES,
  PROGRESSIVE_EXPOSED_TOOLS,
  STARTER_MODULE_NAMES,
  STARTER_MODULES,
  TOOL_EXPOSURE_MODES,
  getProfileDisabledModules,
  getProfileModules,
  getProgressiveToolAllowlist,
  isProfileName,
  isToolExposureMode,
  normalizeProfileName,
  normalizeToolExposureMode,
  type ActiveProfileName,
  type TaxiProfileName,
  type KnownModuleName,
  type ModuleName,
  type PresetProfileName,
  type ToolExposureMode,
} from "./profiles.js";
export {
  CORE_MODULE_PACK_NAME,
  MODULE_PACK_MANIFEST,
  MODULE_PACK_NAMES,
  getModulePackNameForModule,
  getModulePackStatuses,
  isModulePackAvailable,
  resolveModulePackSelection,
  type ModulePackName,
  type ModulePackStatus,
} from "./module-packs.js";

/**
 * Return the macOS major version number.
 *
 * Darwin kernel versions map to macOS versions:
 *   Darwin 24.x → macOS 15 (Sequoia)
 *   Darwin 25.x → macOS 26 (Tahoe)
 *
 * Apple jumped from macOS 15 → 26, so the old `darwinMajor - 9` formula
 * no longer works for Darwin 25+.  We now use `sw_vers` as the primary
 * source and fall back to the Darwin formula for macOS ≤ 15.
 * Returns 0 on non-macOS platforms so version checks always pass.
 */
export function getOsVersion(): number {
  // Developer/CI override so tool-registration gates produce a reproducible
  // result across heterogeneous hosts. `scripts/dump-tool-manifest.mjs`
  // sets this so the checked-in manifest stays identical on macOS 15
  // runners and macOS 26 laptops. "0" = treat as non-Darwin (the inert
  // ceiling; every os-version gate passes).
  const override = process.env.TAXI_FAKE_OS_VERSION;
  if (override !== undefined) {
    const n = parseInt(override, 10);
    return Number.isFinite(n) ? n : 0;
  }
  if (process.platform !== "darwin") return 0;
  try {
    const ver = execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    const major = parseInt(ver.split(".")[0]!, 10);
    if (!isNaN(major)) return major;
  } catch {
    /* fall through to Darwin heuristic */
  }
  const darwinMajor = parseInt(release().split(".")[0]!, 10);
  if (isNaN(darwinMajor)) return 0;
  // Darwin 25+ → macOS 26+ (version jump); Darwin 20-24 → macOS 11-15
  if (darwinMajor >= 25) return darwinMajor + 1;
  return darwinMajor - 9;
}

/**
 * Build a {@link CompatibilityEnv} snapshot for the current process.
 *
 * Used by `resolveModuleCompatibility()` (RFC 0004) to decide which modules
 * register and which get skipped. Calling this in a subprocess or under test
 * gives a stable, JSON-serialisable snapshot — useful for doctor reports.
 *
 * Heuristics:
 *   - `osVersion` comes from `getOsVersion()` (returns 0 on non-Darwin hosts).
 *   - `cpu` is `process.arch`.
 *   - `healthkitAvailable` is a conservative heuristic: HealthKit frameworks
 *     are only present on Apple devices, and Taxi's Swift helper needs
 *     Apple Silicon + modern macOS (≥ HEALTHKIT_MIN_MACOS, which is the
 *     first macOS with the updated HealthKit framework Taxi targets).
 *     Callers that need a more precise probe (e.g. the `health` module's
 *     bridge) should override `healthkitAvailable` with a live capability check.
 */
export function getCompatibilityEnv(): CompatibilityEnv {
  const osVersion = getOsVersion();
  const cpu = process.arch;
  const isAppleSilicon = cpu === "arm64";
  // Darwin hosts with osVersion 0 (non-Darwin) always report false because
  // osVersion < HEALTHKIT_MIN_MACOS.
  const healthkitAvailable = osVersion >= HEALTHKIT_MIN_MACOS && isAppleSilicon;
  return { osVersion, cpu, healthkitAvailable };
}

/** npm package name — single source of truth for npx/install references */
export const NPM_PACKAGE_NAME = "@heznpc/taxi";
/** Version-pinned npm package specifier for app-owned proxy/runtime commands. */
export const NPM_PACKAGE_SPECIFIER = process.env.TAXI_NPM_PACKAGE_SPECIFIER || "@heznpc/taxi@1.0.0";

export type HitlLevel = "off" | "destructive-only" | "sensitive-only" | "all-writes" | "all";

export interface HitlConfig {
  level: HitlLevel;
  whitelist: Set<string>;
  timeout: number;
  socketPath: string;
}

const HITL_LEVELS: readonly string[] = ["off", "destructive-only", "sensitive-only", "all-writes", "all"];

export interface McpClient {
  name: string;
  configPath: string;
  serversKey: string;
}

export const MCP_CLIENTS: McpClient[] = [
  {
    name: "Claude Desktop",
    configPath: join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    serversKey: "mcpServers",
  },
  { name: "Claude Code", configPath: join(HOME, ".claude", "mcp.json"), serversKey: "mcpServers" },
  { name: "Cursor", configPath: join(HOME, ".cursor", "mcp.json"), serversKey: "mcpServers" },
  { name: "Windsurf", configPath: join(HOME, ".codeium", "windsurf", "mcp_config.json"), serversKey: "mcpServers" },
];

export interface FeaturesConfig {
  /** Enable audit log (~/.taxi/audit.jsonl). Default: true */
  auditLog: boolean;
  /** Enable usage pattern tracking (~/.taxi/profile.json). Default: true */
  usageTracking: boolean;
  /** Enable semantic tool search (requires embedding provider). Default: true */
  semanticToolSearch: boolean;
  /** Enable proactive context suggestions. Default: true */
  proactiveContext: boolean;
  /** Enable OpenTelemetry instrumentation (requires @opentelemetry/api). Default: false */
  telemetry: boolean;
}

export interface TaxiConfig {
  /** Active module profile. "custom" means legacy disabledModules controls the surface. */
  profile: ActiveProfileName;
  /** MCP tools/list exposure mode. Registered tools remain callable through run_tool. */
  toolExposure: ToolExposureMode;
  /** Available DLC-like module packs. Defaults to every built-in pack. */
  modulePacks: Set<ModulePackName>;
  /** True when modulePacks came from config/env instead of the default all-pack set. */
  modulePacksConfigured: boolean;
  /** Require task-scoped sessions before run_tool can dispatch hidden tools. Default: false */
  requireToolSession: boolean;
  /** Tools exposed in progressive tools/list mode. */
  progressiveTools: Set<string>;
  /** Include shared notes/folders in results. Default: false */
  includeShared: boolean;
  /** Set of disabled module names */
  disabledModules: Set<string>;
  /** Set of module names that require share approval */
  shareApprovalModules: Set<string>;
  /** Allow sending messages via Messages app. Default: false */
  allowSendMessages: boolean;
  /** Allow sending emails via Mail app. Default: false */
  allowSendMail: boolean;
  /** Allow running arbitrary JavaScript in Safari tabs. Default: false */
  allowRunJavascript: boolean;
  /** Human-in-the-loop confirmation config */
  hitl: HitlConfig;
  /** Feature toggles for intelligence layer */
  features: FeaturesConfig;
}

interface FileConfig {
  profile?: string;
  toolExposure?: string;
  modulePacks?: string | string[];
  requireToolSession?: boolean;
  includeShared?: boolean;
  allowSendMessages?: boolean;
  allowSendMail?: boolean;
  allowRunJavascript?: boolean;
  disabledModules?: string[];
  shareApproval?: string[];
  hitl?: { level?: string; whitelist?: string[]; timeout?: number };
  /** Feature toggles — disable individual intelligence features */
  features?: {
    auditLog?: boolean;
    usageTracking?: boolean;
    semanticToolSearch?: boolean;
    proactiveContext?: boolean;
    telemetry?: boolean;
  };
  /** Performance tuning — all fields optional, env vars take precedence */
  performance?: {
    /** Embedding provider: "gemini" | "swift" | "hybrid" | "none" */
    embeddingProvider?: string;
    /** Max parallel JXA processes (default: 3) */
    jxaConcurrency?: number;
    /** Circuit breaker: failures before open (default: 3) */
    circuitBreakerThreshold?: number;
    /** Circuit breaker: open duration in ms (default: 60000) */
    circuitBreakerOpenMs?: number;
  };
}

interface LoadResult {
  config: FileConfig;
  /** true if config.json was found and parsed successfully */
  fileExists: boolean;
  /** Raw parsed object for validation warnings (avoids re-reading the file) */
  rawObj?: Record<string, unknown>;
}

function parseFileConfigText(data: string): LoadResult {
  try {
    const raw: unknown = JSON.parse(data);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      log.warn("config.json must be a JSON object — using defaults");
      return { config: {}, fileExists: true };
    }
    const obj = raw as Record<string, unknown>;
    const config: FileConfig = {};
    if (typeof obj.profile === "string") config.profile = obj.profile;
    if (typeof obj.toolExposure === "string") config.toolExposure = obj.toolExposure;
    if (typeof obj.modulePacks === "string") config.modulePacks = obj.modulePacks;
    if (Array.isArray(obj.modulePacks)) {
      config.modulePacks = obj.modulePacks.filter((m): m is string => typeof m === "string");
    }
    if (typeof obj.requireToolSession === "boolean") config.requireToolSession = obj.requireToolSession;
    if (typeof obj.includeShared === "boolean") config.includeShared = obj.includeShared;
    if (typeof obj.allowSendMessages === "boolean") config.allowSendMessages = obj.allowSendMessages;
    if (typeof obj.allowSendMail === "boolean") config.allowSendMail = obj.allowSendMail;
    if (typeof obj.allowRunJavascript === "boolean") config.allowRunJavascript = obj.allowRunJavascript;
    if (Array.isArray(obj.disabledModules)) {
      config.disabledModules = obj.disabledModules.filter((m): m is string => typeof m === "string");
    }
    if (Array.isArray(obj.shareApproval)) {
      config.shareApproval = obj.shareApproval.filter((m): m is string => typeof m === "string");
    }
    if (obj.hitl && typeof obj.hitl === "object" && !Array.isArray(obj.hitl)) {
      const h = obj.hitl as Record<string, unknown>;
      config.hitl = {
        level: typeof h.level === "string" ? h.level : undefined,
        whitelist: Array.isArray(h.whitelist)
          ? h.whitelist.filter((s): s is string => typeof s === "string")
          : undefined,
        timeout: typeof h.timeout === "number" ? h.timeout : undefined,
      };
    }
    if (obj.features && typeof obj.features === "object" && !Array.isArray(obj.features)) {
      const f = obj.features as Record<string, unknown>;
      config.features = {
        auditLog: typeof f.auditLog === "boolean" ? f.auditLog : undefined,
        usageTracking: typeof f.usageTracking === "boolean" ? f.usageTracking : undefined,
        semanticToolSearch: typeof f.semanticToolSearch === "boolean" ? f.semanticToolSearch : undefined,
        proactiveContext: typeof f.proactiveContext === "boolean" ? f.proactiveContext : undefined,
        telemetry: typeof f.telemetry === "boolean" ? f.telemetry : undefined,
      };
    }
    if (obj.performance && typeof obj.performance === "object" && !Array.isArray(obj.performance)) {
      const p = obj.performance as Record<string, unknown>;
      config.performance = {
        embeddingProvider: typeof p.embeddingProvider === "string" ? p.embeddingProvider : undefined,
        jxaConcurrency: typeof p.jxaConcurrency === "number" ? p.jxaConcurrency : undefined,
        circuitBreakerThreshold: typeof p.circuitBreakerThreshold === "number" ? p.circuitBreakerThreshold : undefined,
        circuitBreakerOpenMs: typeof p.circuitBreakerOpenMs === "number" ? p.circuitBreakerOpenMs : undefined,
      };
    }
    return { config, fileExists: true, rawObj: obj };
  } catch (err) {
    log.warn("failed to parse config.json — using defaults", { err: errToCtx(err) });
    return { config: {}, fileExists: true };
  }
}

function loadFileConfig(): LoadResult {
  try {
    const snapshot = readOnlyConfigFileSnapshot(PATHS.CONFIG, { label: "Taxi config" });
    return snapshot ? parseFileConfigText(snapshot.content) : { config: {}, fileExists: false };
  } catch (err) {
    log.warn("failed to read config.json securely — using defaults", { err: errToCtx(err) });
    return { config: {}, fileExists: false };
  }
}

/**
 * Read a boolean config value with env-var override.
 * Env var is checked with strict `=== "true"` (positive opt-in) for all booleans.
 *
 * NOTE: Prior to this refactor, allowSendMessages and allowSendMail used
 * `!== "false"` (any non-"false" value enabled the feature). This has been
 * unified to `=== "true"` for consistency and safety — these are
 * action-oriented settings (sending mail/messages), so explicit opt-in
 * is more predictable. To enable via env var, set the value to exactly "true".
 */
function envBool(envKey: string, fileValue: boolean | undefined, defaultValue: boolean): boolean {
  const env = process.env[envKey];
  if (env !== undefined) return env === "true";
  return fileValue ?? defaultValue;
}

function resolveConfig({ config: file, fileExists, rawObj }: LoadResult): TaxiConfig {
  const fullMode = process.env.TAXI_FULL === "true" || process.argv.includes("--full");
  const profileEnv = parseProfileEnv(process.env.TAXI_PROFILE);
  const fileProfile = normalizeProfileName(file.profile);
  const fileProfileWasProvided = file.profile !== undefined;
  const envProfile = profileEnv.profile;
  if (fileProfileWasProvided && !fileProfile) {
    log.warn("invalid profile — using safe starter profile", {
      provided: file.profile,
      expected: PROFILE_NAMES,
    });
  }
  const activeProfile: ActiveProfileName = fullMode
    ? "full"
    : (envProfile ?? fileProfile ?? (fileProfileWasProvided ? "starter" : !fileExists ? "starter" : "custom"));
  const profileModules =
    activeProfile !== "custom" ? new Set<string>(getProfileModules(activeProfile as TaxiProfileName)) : null;
  const defaultExposure =
    activeProfile !== "custom" ? DEFAULT_TOOL_EXPOSURE_BY_PROFILE[activeProfile as TaxiProfileName] : "profile";
  const toolExposure =
    normalizeToolExposureMode(process.env.TAXI_TOOL_EXPOSURE) ??
    normalizeToolExposureMode(file.toolExposure) ??
    defaultExposure;
  const modulePackSelection = resolveModulePackSelection(process.env.TAXI_MODULE_PACKS ?? file.modulePacks);
  if (modulePackSelection.unknown.length > 0) {
    log.warn("unknown module pack in modulePacks — ignored", {
      packs: modulePackSelection.unknown,
      expected: MODULE_PACK_NAMES,
    });
  }

  // Validate disabledModules: warn about unknown module names. Normalize the
  // same way the disable logic does (trim + lowercase) so a mis-cased-but-valid
  // entry like "Mail" — which IS honored below — does not trigger a spurious
  // "unknown module" warning.
  if (file.disabledModules) {
    for (const mod of file.disabledModules) {
      const normalized = String(mod).trim().toLowerCase();
      if (!(KNOWN_MODULE_NAMES as readonly string[]).includes(normalized)) {
        log.warn("unknown module in disabledModules — ignored", { module: mod });
      }
    }
  }

  // Validate hitl.level: warn if not a valid level
  if (file.hitl?.level !== undefined && !HITL_LEVELS.includes(file.hitl.level)) {
    log.warn("invalid hitl.level — using default 'sensitive-only'", {
      provided: file.hitl.level,
      expected: HITL_LEVELS,
    });
  }

  // Validate boolean fields: warn if non-boolean values are present in the raw config
  if (rawObj) {
    const boolFields = [
      "includeShared",
      "allowSendMessages",
      "allowSendMail",
      "allowRunJavascript",
      "requireToolSession",
    ] as const;
    for (const field of boolFields) {
      if (field in rawObj && typeof rawObj[field] !== "boolean") {
        log.warn("config field has wrong type — ignored", { field, expected: "boolean", got: typeof rawObj[field] });
      }
    }
    if ("modulePacks" in rawObj && typeof rawObj.modulePacks !== "string" && !Array.isArray(rawObj.modulePacks)) {
      log.warn("config field has wrong type — ignored", {
        field: "modulePacks",
        expected: "string|string[]",
        got: typeof rawObj.modulePacks,
      });
    }
  }

  // Disabled modules: env vars override, then profile, then JSON fallback.
  // TAXI_DISABLE_<MOD> is a disable-only opt-in (mirrored by TAXI_ENABLE_<MOD>);
  // ONLY the literal value "true" force-disables. Any other value (e.g. "false"/"0")
  // must be inert — it must NOT re-enable a module the profile/config excludes, which
  // is why the profile/file branches are gated on the *absence of an explicit disable*
  // rather than on `envVal === undefined` (setting the var to "false" previously
  // fell open and silently re-enabled a profile-excluded module).
  const disabledModules = new Set<string>();
  const fileDisabled = new Set((file.disabledModules ?? []).map((m) => String(m).trim().toLowerCase()));
  for (const mod of KNOWN_MODULE_NAMES) {
    const envKey = `TAXI_DISABLE_${mod.toUpperCase()}`;
    const enableEnvKey = `TAXI_ENABLE_${mod.toUpperCase()}`;
    const envVal = process.env[envKey];
    const optInEnabled = process.env[enableEnvKey] === "true" || profileEnv.optIns.has(mod);
    if (envVal === "true") {
      disabledModules.add(mod);
    } else if ((OPT_IN_MODULE_NAMES as readonly string[]).includes(mod) && !optInEnabled) {
      disabledModules.add(mod);
    } else if (!fullMode && profileModules && !profileModules.has(mod) && !optInEnabled) {
      disabledModules.add(mod);
    } else if (!fullMode && fileDisabled.has(mod)) {
      disabledModules.add(mod);
    }
  }

  // Share approval: env var overrides, then JSON fallback
  const shareApprovalModules = new Set<string>();
  const shareApprovalEnv = process.env.TAXI_SHARE_APPROVAL;
  if (shareApprovalEnv) {
    for (const raw of shareApprovalEnv.split(",")) {
      const mod = raw.trim().toLowerCase();
      if (mod && (KNOWN_MODULE_NAMES as readonly string[]).includes(mod)) {
        shareApprovalModules.add(mod);
      }
    }
  } else if (file.shareApproval) {
    for (const mod of file.shareApproval) {
      if ((KNOWN_MODULE_NAMES as readonly string[]).includes(mod)) {
        shareApprovalModules.add(mod);
      }
    }
  }

  // Boolean configs: env var > JSON > default
  const includeShared = envBool("TAXI_INCLUDE_SHARED", file.includeShared, false);
  const allowSendMessages = envBool("TAXI_ALLOW_SEND_MESSAGES", file.allowSendMessages, false);
  const allowSendMail = envBool("TAXI_ALLOW_SEND_MAIL", file.allowSendMail, false);
  const allowRunJavascript = envBool("TAXI_ALLOW_RUN_JAVASCRIPT", file.allowRunJavascript, false);
  const requireToolSession = envBool("TAXI_REQUIRE_TOOL_SESSION", file.requireToolSession, false);

  // Performance config: write to env vars so constants.ts picks them up.
  // KNOWN LIMITATION: constants.ts evaluates envInt() at import time (before
  // parseConfig runs), so JSON config values for jxaConcurrency / CB thresholds
  // only take effect if set as env vars BEFORE the process starts. The JSON
  // config path works for embeddingProvider (read lazily) but not for values
  // CONCURRENCY getters now read env vars lazily, so JSON config values work
  // for CB_THRESHOLD, CB_OPEN_MS, and JXA_SLOTS. Note: the Semaphore in
  // jxa.ts is still created once at import time with the initial JXA_SLOTS value.
  const perf = file.performance;
  if (perf) {
    if (perf.embeddingProvider && !process.env.TAXI_EMBEDDING_PROVIDER) {
      process.env.TAXI_EMBEDDING_PROVIDER = perf.embeddingProvider;
    }
    if (perf.jxaConcurrency && !process.env.TAXI_JXA_CONCURRENCY) {
      process.env.TAXI_JXA_CONCURRENCY = String(perf.jxaConcurrency);
    }
    if (perf.circuitBreakerThreshold !== undefined && !process.env.TAXI_CB_THRESHOLD) {
      process.env.TAXI_CB_THRESHOLD = String(perf.circuitBreakerThreshold);
    }
    if (perf.circuitBreakerOpenMs !== undefined && !process.env.TAXI_CB_OPEN_MS) {
      process.env.TAXI_CB_OPEN_MS = String(perf.circuitBreakerOpenMs);
    }
  }

  // HITL config: env var > JSON > default
  const hitlLevelRaw = process.env.TAXI_HITL_LEVEL ?? file.hitl?.level ?? "sensitive-only";
  const hitlLevel: HitlLevel = HITL_LEVELS.includes(hitlLevelRaw) ? (hitlLevelRaw as HitlLevel) : "sensitive-only";
  const hitlWhitelist = new Set<string>(file.hitl?.whitelist ?? []);
  // A HITL gate blocks on a *person*, not a machine. The notification
  // route is not always available — with .denied authorization
  // HitlManager falls back to an alert sound plus the Trust Center
  // window, which a user busy in another app can easily miss. 30s was
  // short enough that a request could expire before it was ever noticed;
  // 120s keeps the caller from hanging indefinitely while leaving a
  // realistic window to react. Override with hitl.timeout.
  const hitlTimeout = file.hitl?.timeout ?? 120;
  const hitlSocketPath = PATHS.HITL_SOCKET;

  const hitl: HitlConfig = {
    level: hitlLevel,
    whitelist: hitlWhitelist,
    timeout: hitlTimeout,
    socketPath: hitlSocketPath,
  };

  // Feature toggles: env var > JSON > default (all on by default, except telemetry)
  const features: FeaturesConfig = {
    auditLog: envBool("TAXI_AUDIT_LOG", file.features?.auditLog, true),
    usageTracking: envBool("TAXI_USAGE_TRACKING", file.features?.usageTracking, true),
    semanticToolSearch: envBool("TAXI_SEMANTIC_SEARCH", file.features?.semanticToolSearch, true),
    proactiveContext: envBool("TAXI_PROACTIVE_CONTEXT", file.features?.proactiveContext, true),
    telemetry: envBool("TAXI_TELEMETRY", file.features?.telemetry, false),
  };

  return {
    profile: activeProfile,
    toolExposure,
    modulePacks: modulePackSelection.packs.size > 0 ? modulePackSelection.packs : getDefaultModulePacks(),
    modulePacksConfigured: modulePackSelection.configured,
    requireToolSession,
    progressiveTools: getProgressiveToolAllowlist(),
    includeShared,
    disabledModules,
    shareApprovalModules,
    allowSendMessages,
    allowSendMail,
    allowRunJavascript,
    hitl,
    features,
  };
}

export function parseConfig(): TaxiConfig {
  return resolveConfig(loadFileConfig());
}

/**
 * Resolve effective config from a caller-owned immutable file snapshot.
 * `undefined` means the file was absent or rejected before parsing. Doctor
 * uses this to avoid reopening a path after its O_NOFOLLOW/fstat read.
 */
export function parseConfigSnapshot(configText: string | undefined): TaxiConfig {
  return resolveConfig(configText === undefined ? { config: {}, fileExists: false } : parseFileConfigText(configText));
}

export function isModuleEnabled(config: TaxiConfig, moduleName: string): boolean {
  return !config.disabledModules.has(moduleName);
}

function parseProfileEnv(raw: string | undefined): { profile: TaxiProfileName | null; optIns: Set<string> } {
  let profile: TaxiProfileName | null = null;
  const optIns = new Set<string>();
  if (!raw) return { profile, optIns };
  for (const part of raw.split(",")) {
    const token = part.trim().toLowerCase();
    if (!token) continue;
    const normalizedProfile = normalizeProfileName(token);
    if (normalizedProfile && !profile) {
      profile = normalizedProfile;
    } else if ((KNOWN_MODULE_NAMES as readonly string[]).includes(token)) {
      optIns.add(token);
    }
  }
  return { profile, optIns };
}

export function needsShareApproval(config: TaxiConfig, moduleName: string): boolean {
  return config.shareApprovalModules.has(moduleName);
}
