/**
 * `taxi doctor` — diagnose Taxi installation.
 *
 * Checks: Node version, config files, MCP client configs,
 * module status, and declared macOS permission requirements.
 */

import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MODULE_NAMES,
  OPT_IN_MODULE_NAMES,
  MCP_CLIENTS,
  getCompatibilityEnv,
  isModuleEnabled,
  normalizeProfileName,
  parseConfigSnapshot,
  readOnlyConfigFileSnapshot,
  type TaxiConfig,
} from "../shared/config.js";
import { HOME, PATHS } from "../shared/constants.js";
import {
  CODEX_APP_OWNED_URL,
  codexConfigTomlHasTaxiHttpToken,
  codexTaxiRuntimeShapeFromTomlReadOnly,
  resolveCodexConfigPath,
} from "./codex-mcp.js";
import { clientRuntimeShape } from "./client-config.js";
import { LOGO_LINES, typeLine } from "../shared/banner.js";
import { MODULE_MANIFEST, getModulePackPlan } from "../shared/modules.js";
import { getModulePackStatuses, resolveModulePackSelection } from "../shared/module-packs.js";
import { summarizeCompatibility } from "../shared/compatibility.js";
import { assessWorkflowsReadiness, summarizeWorkflowsReadiness } from "../shared/workflows.js";
import { RESET, BOLD, DIM, WHITE, GREEN, SYM, heading, line, divider, spinner, sleep } from "./style.js";
import { APP_RUNTIME_TOKEN_PATH } from "../shared/app-runtime-token.js";
import { readPrivateRuntimeCredential } from "../shared/app-runtime-identity.js";
import { inspectDoctorAppRuntime } from "./doctor-app-runtime.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Package root — works in repo checkout, npm cache, and git worktrees. */
const PKG_ROOT = resolve(__dirname, "..", "..");
const DOCTOR_FILE_CLIENTS = [
  ...MCP_CLIENTS,
  // Claude Code's user-scope registry is separate from .claude/mcp.json.
  // Keep it doctor-only: setup must not rewrite the broader .claude.json file.
  { name: "Claude Code user scope", configPath: join(HOME, ".claude.json"), serversKey: "mcpServers" },
] as const;

interface FileConfig {
  locale?: string;
  profile?: string;
  toolExposure?: string;
  modulePacks?: string | string[];
  requireToolSession?: boolean;
  disabledModules?: string[];
  includeShared?: boolean;
  allowSendMessages?: boolean;
  allowSendMail?: boolean;
}

function configuredAppRuntimeToken(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const env = (entry as { env?: unknown }).env;
  if (!env || typeof env !== "object") return undefined;
  const value = (env as Record<string, unknown>).TAXI_HTTP_TOKEN;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function appRuntimeRegistrationTokenState(
  entry: unknown,
  validatedRuntimeToken: string | undefined,
): "matching" | "stale" | "unverifiable" {
  if (validatedRuntimeToken === undefined) return "unverifiable";
  return configuredAppRuntimeToken(entry) === validatedRuntimeToken ? "matching" : "stale";
}

export function doctorExitCode(failureCount: number): 0 | 1 {
  return failureCount > 0 ? 1 : 0;
}

export interface DoctorConfigFileMetadata {
  mode?: number;
  failure?: string;
}

export function tokenBearingConfigModeFailure(metadata: DoctorConfigFileMetadata): string | undefined {
  if (metadata.failure) return metadata.failure;
  if (metadata.mode !== 0o600) {
    return `token-bearing exact config file permissions are ${(metadata.mode ?? 0).toString(8).padStart(3, "0")}; expected 0600`;
  }
  return undefined;
}

/** Locate an executable as a filesystem observation; never launch it. */
export function findExecutableOnPath(name: string, pathValue = process.env.PATH): string | undefined {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || !pathValue) return undefined;
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = resolve(directory, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep searching the remaining PATH entries.
    }
  }
  return undefined;
}

export async function runDoctor(): Promise<0 | 1> {
  // Banner
  console.log("");
  for (const l of LOGO_LINES) await typeLine(l, 2, "stdout");
  console.log("");
  await typeLine(`  ${BOLD}${WHITE}Taxi Doctor${RESET}`, 8, "stdout");
  console.log("");
  await sleep(200);

  let pass = 0;
  let warn = 0;
  let fail = 0;

  function ok(label: string, detail: string) {
    console.log(line(SYM.ok, label, detail));
    pass++;
  }
  function bad(label: string, detail: string) {
    console.log(line(SYM.fail, label, detail));
    fail++;
  }
  function meh(label: string, detail: string) {
    console.log(line(SYM.warn, label, detail));
    warn++;
  }

  // ── Environment ────────────────────────────────────────────────────
  console.log(heading("Environment"));

  const s1 = spinner("Checking environment...");
  await sleep(300);

  const nodeVer = process.version;
  const major = parseInt(nodeVer.slice(1), 10);
  s1.succeed("Environment checked");

  // Must track package.json `engines.node` (>=22). At >=18 this reported green
  // on versions where npm refuses to install the package at all, so doctor
  // cleared an environment that could never have run it.
  if (major >= 22) ok("Node.js", `${nodeVer}`);
  else bad("Node.js", `${nodeVer} — upgrade required (>= 22)`);

  const platform = process.platform;
  if (platform === "darwin") ok("Platform", "macOS");
  else bad("Platform", `${platform} — Taxi requires macOS`);

  // macOS version
  if (platform === "darwin") {
    try {
      const { execFileSync } = await import("node:child_process");
      const ver = execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
        encoding: "utf8",
        timeout: 3000,
      }).trim();
      ok("macOS Version", ver);
    } catch {
      meh("macOS Version", "Could not detect");
    }
  }

  // Local package identity is deterministic and side-effect free. `npm view`
  // used to initialise ~/.npm and emit a public-registry request on every
  // doctor run (and `npx` below could install a package); update discovery is
  // deliberately outside this operational diagnosis command.
  try {
    const pkgPath = join(PKG_ROOT, "package.json");
    const current = JSON.parse(readFileSync(pkgPath, "utf-8")).version;
    if (typeof current !== "string" || current.length === 0) throw new Error("missing version");
    ok("Taxi Version", `v${current} ${DIM}(installed package)${RESET}`);
  } catch {
    bad("Taxi Version", "Could not read installed package metadata");
  }

  // ── Configuration ──────────────────────────────────────────────────
  console.log(heading("Configuration"));

  let fileConfig: FileConfig | null = null;
  let runtimeConfig: TaxiConfig | null = null;
  let configText: string | undefined;
  try {
    const snapshot = readOnlyConfigFileSnapshot(PATHS.CONFIG, { label: "Taxi config" });
    if (snapshot) {
      configText = snapshot.content;
      fileConfig = JSON.parse(configText) as FileConfig;
      ok("Config file", PATHS.CONFIG.replace(HOME, "~"));
      if (fileConfig.locale) ok("Language", fileConfig.locale);
    } else {
      meh("Config file", `Not found — using starter profile`);
    }
  } catch (error) {
    if (configText === undefined) {
      bad("Config file security", `${error instanceof Error ? error.message : String(error)}: ${PATHS.CONFIG}`);
    } else {
      meh("Config file", `${PATHS.CONFIG} (parse error)`);
    }
  }
  try {
    runtimeConfig = parseConfigSnapshot(configText);
    const enabledCount = MODULE_NAMES.filter((moduleName) => isModuleEnabled(runtimeConfig!, moduleName)).length;
    // MODULE_NAMES covers the standard modules a profile can enable; the
    // published catalogue count also includes OPT_IN_MODULE_NAMES, which no
    // profile turns on. Naming both keeps this from reading as a contradiction
    // of the documented module total.
    const catalogueCount = MODULE_NAMES.length + OPT_IN_MODULE_NAMES.length;
    ok(
      "Runtime profile",
      `${runtimeConfig.profile} (${runtimeConfig.toolExposure} exposure, ${enabledCount}/${MODULE_NAMES.length} standard modules enabled` +
        `, ${OPT_IN_MODULE_NAMES.length} opt-in excluded of ${catalogueCount} total)`,
    );
    const requestedProfile = normalizeProfileName(fileConfig?.profile);
    if (fileConfig?.profile && requestedProfile !== runtimeConfig.profile) {
      meh("Config profile", `requested "${fileConfig.profile}", effective "${runtimeConfig.profile}"`);
    }
  } catch (e) {
    meh("Runtime profile", `could not parse effective config: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── MCP Clients ────────────────────────────────────────────────────
  console.log(heading("MCP Clients"));

  // Read-only and fail-closed. This value is used only to distinguish a
  // structurally present registration from one carrying an obsolete bearer;
  // this comparison read never creates or repairs the credential.
  let validatedAppRuntimeToken: string | undefined;
  try {
    validatedAppRuntimeToken = readPrivateRuntimeCredential(APP_RUNTIME_TOKEN_PATH, "app runtime HTTP token");
  } catch {
    // The dedicated runtime section reports the precise integrity result.
  }

  const s2 = spinner("Scanning for MCP clients...");
  await sleep(400);
  s2.succeed("Client scan complete");

  let anyClientFound = false;
  for (const client of DOCTOR_FILE_CLIENTS) {
    try {
      const snapshot = readOnlyConfigFileSnapshot(client.configPath, { label: `${client.name} config` });
      if (!snapshot) continue;
      anyClientFound = true;
      const raw = JSON.parse(snapshot.content);
      const servers = raw?.[client.serversKey] ?? {};
      if (servers.taxi) {
        const shape = clientRuntimeShape(servers.taxi);
        const tokenBearing = configuredAppRuntimeToken(servers.taxi) !== undefined;
        if (tokenBearing) {
          const configFailure = tokenBearingConfigModeFailure({ mode: snapshot.mode });
          if (configFailure) bad(`${client.name} config security`, `${configFailure}: ${client.configPath}`);
          else ok(`${client.name} config security`, "token-bearing exact config file is owner-only (0600)");
        }
        if (shape === "app-owned") {
          const tokenState = appRuntimeRegistrationTokenState(servers.taxi, validatedAppRuntimeToken);
          if (tokenState === "unverifiable") {
            meh(client.name, "Taxi.app registration present; token integrity could not be compared");
          } else if (tokenState === "stale") {
            // This registration will deterministically receive 401 from the
            // app-owned runtime. It is an operational failure, not an
            // optional warning merely because the runtime may be stopped
            // while doctor is running.
            bad(client.name, "Taxi.app registration token is stale — run: taxi clients");
          } else {
            ok(client.name, `registration present ${DIM}(Taxi.app proxy; token matches)${RESET}`);
          }
        } else if (shape === "direct") {
          ok(client.name, `registration present ${DIM}(direct stdio; runtime not started by doctor)${RESET}`);
        } else {
          meh(client.name, `taxi entry found, runtime shape unknown`);
        }
      } else {
        meh(client.name, `found but no taxi entry`);
      }
    } catch (error) {
      anyClientFound = true;
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof SyntaxError) meh(client.name, "config parse error");
      else bad(`${client.name} config security`, `${message}: ${client.configPath}`);
    }
  }
  try {
    const codexConfigPath = resolveCodexConfigPath();
    const snapshot = readOnlyConfigFileSnapshot(codexConfigPath, { label: "Codex config" });
    if (snapshot) {
      anyClientFound = true;
      const codexToml = snapshot.content;
      const tokenBearing = codexConfigTomlHasTaxiHttpToken(codexToml);
      if (tokenBearing) {
        const configFailure = tokenBearingConfigModeFailure({ mode: snapshot.mode });
        if (configFailure) bad("Codex config security", `${configFailure}: ${codexConfigPath}`);
        else ok("Codex config security", "token-bearing exact config.toml is owner-only (0600)");
      }

      const shape = codexTaxiRuntimeShapeFromTomlReadOnly(codexToml, validatedAppRuntimeToken);
      if (shape === "app-owned") {
        ok("Codex", `registration present ${DIM}(Taxi.app proxy; token matches)${RESET}`);
      } else if (shape === "app-owned-stale") {
        bad("Codex", "Taxi.app registration token is stale — run: taxi clients");
      } else if (shape === "app-owned-disabled" || shape === "direct-disabled") {
        meh("Codex", "Taxi is disabled for Codex startup — run: taxi codex enable");
      } else if (shape === "app-owned-pending-restart") {
        meh("Codex", `config uses Taxi.app runtime — restart Codex to reload MCP servers`);
      } else if (shape === "direct") {
        ok("Codex", "registration present (direct stdio; runtime not started by doctor)");
      } else if (shape === "missing") {
        meh("Codex", `found but no taxi entry`);
      } else {
        meh("Codex", `taxi entry found, runtime shape unknown`);
      }
    }
  } catch (e) {
    // An invalid override or unsafe file must not be followed or crash the
    // rest of doctor. Unlike a missing optional config, it is a concrete
    // security failure and therefore fails the operational gate.
    anyClientFound = true;
    bad("Codex config security", e instanceof Error ? e.message : String(e));
    meh("Codex", "registration shape was not read from an unsafe config path");
  }
  if (!anyClientFound) {
    meh("MCP Clients", `No clients found — run: taxi setup`);
  }

  // ── Taxi.app runtime ─────────────────────────────────────────────
  //
  // This is the recommended production shape: Taxi.app owns macOS/TCC
  // permissions and exposes a local token-gated HTTP runtime for clients.
  // Doctor reports every observation separately: a process is not a listener,
  // a listener is not a healthy Taxi runtime, and bearer acceptance is not
  // proof of app ownership or MCP readiness.
  console.log(heading("Taxi.app Runtime"));
  let packageVersion = "unknown";
  try {
    packageVersion = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf-8")).version as string;
  } catch {
    bad("Runtime package version", "could not read package.json version");
  }
  const appRuntimeReport = await inspectDoctorAppRuntime({
    expectedVersion: packageVersion,
    mcpUrl: CODEX_APP_OWNED_URL,
  });
  for (const check of appRuntimeReport.checks) {
    const detail = check.detail.replaceAll(HOME, "~");
    if (check.severity === "pass") ok(check.label, detail);
    else if (check.severity === "failure") bad(check.label, detail);
    else meh(check.label, detail);
  }

  // ── Modules ────────────────────────────────────────────────────────
  console.log(heading("Modules"));

  const enabledMods: string[] = [];
  const disabledMods: string[] = [];

  for (const mod of MODULE_NAMES) {
    if (runtimeConfig ? isModuleEnabled(runtimeConfig, mod) : false) enabledMods.push(mod);
    else disabledMods.push(mod);
  }

  console.log(`  ${BOLD}${enabledMods.length}${RESET} enabled  ${DIM}${disabledMods.length} disabled${RESET}\n`);

  // Show in compact columns
  const cols = 4;
  const rows = Math.ceil(MODULE_NAMES.length / cols);
  for (let r = 0; r < rows; r++) {
    const parts: string[] = [];
    for (let c = 0; c < cols; c++) {
      const idx = r + c * rows;
      if (idx >= MODULE_NAMES.length) break;
      const mod = MODULE_NAMES[idx]!;
      const on = enabledMods.includes(mod);
      const icon = on ? SYM.ok : `${DIM}·${RESET}`;
      const label = on ? mod : `${DIM}${mod}${RESET}`;
      parts.push(`  ${icon} ${label}`.padEnd(on ? 20 : 30));
    }
    console.log(parts.join(""));
  }

  // OS permissions required by ENABLED modules (RFC 0004 requiresPermissions).
  // Previously this manifest field was inert — declared but never surfaced — so
  // a user only discovered a module needed Accessibility / HealthKit when a call
  // failed with an opaque OS error. List them up front instead.
  const permModules = MODULE_MANIFEST.filter(
    (m) => enabledMods.includes(m.name) && (m.compatibility?.requiresPermissions?.length ?? 0) > 0,
  ).map((m) => ({ name: m.name, perms: m.compatibility!.requiresPermissions! }));
  if (permModules.length > 0) {
    const allPerms = [...new Set(permModules.flatMap((m) => m.perms))].sort();
    meh("OS permissions needed", allPerms.join(", "));
    for (const m of permModules) {
      console.log(`    ${DIM}${m.name} → ${m.perms.join(", ")}${RESET}`);
    }
  }

  console.log(heading("Bundled module packs"));
  const packSelection = resolveModulePackSelection(process.env.TAXI_MODULE_PACKS ?? fileConfig?.modulePacks);
  const packStatuses = getModulePackStatuses(runtimeConfig?.modulePacks ?? packSelection.packs);
  const activePacks = packStatuses.filter((pack) => pack.available);
  ok("Active packs", activePacks.map((pack) => pack.name).join(", "));
  if (runtimeConfig?.modulePacksConfigured ?? packSelection.configured)
    ok("Pack source", process.env.TAXI_MODULE_PACKS ? "TAXI_MODULE_PACKS" : "config.json");
  else meh("Pack source", "default all built-in packs");
  for (const pack of packStatuses) {
    const detail = pack.modules.join(", ");
    if (pack.available) ok(`pack:${pack.name}`, detail);
    else meh(`pack:${pack.name}`, detail);
  }

  console.log(heading("Task harness"));
  const strictHarness = runtimeConfig?.requireToolSession ?? false;
  const harnessAdapter =
    process.env.TAXI_HARNESS_ADAPTER ??
    (process.env.TAXI_APP_OWNED_RUNTIME ? "app-runtime" : strictHarness ? "strict" : "compatible");
  ok("Harness adapter", harnessAdapter);
  if (strictHarness) ok("Hidden tool sessions", "required before run_tool dispatches hidden tools");
  else meh("Hidden tool sessions", "compatible mode — set requireToolSession=true for strict task scoping");

  console.log(heading("Workflow config readiness"));
  meh("Scope", "profile/module packs/write opt-ins; MCP workflow_readiness checks live tools");
  if (runtimeConfig) {
    const workflowPackPlan = getModulePackPlan(runtimeConfig);
    const workflows = assessWorkflowsReadiness({
      enabledModules: enabledMods,
      modulesMissingPacks: workflowPackPlan.modulesMissingPacks,
      allowSendMail: runtimeConfig.allowSendMail,
      allowSendMessages: runtimeConfig.allowSendMessages,
    });
    const { ready, partial, blocked } = summarizeWorkflowsReadiness(workflows);
    if (blocked === 0 && partial === 0) {
      ok("Curated workflows", `${ready}/${workflows.length} ready`);
    } else {
      meh("Curated workflows", `${ready} ready, ${partial} partial, ${blocked} blocked`);
    }
    for (const workflow of workflows) {
      const label = `workflow:${workflow.id}`;
      if (workflow.status === "ready") {
        ok(label, workflow.summary);
      } else {
        const firstIssue = workflow.issues[0];
        const detail = firstIssue
          ? `${workflow.summary} ${firstIssue.message}${firstIssue.command ? ` Run: ${firstIssue.command}` : ""}`
          : workflow.summary;
        meh(label, detail);
      }
    }
  } else {
    meh("Curated workflows", "runtime config unavailable");
  }

  // ── Compatibility (RFC 0004) ───────────────────────────────────────
  //
  // Run the pure resolver against the current host env so users can see
  // *why* a given module won't register (macOS too old, HealthKit missing,
  // module flagged broken for this point release, etc.). The section is
  // intentionally terse — it only surfaces non-trivial outcomes (deprecated
  // / unsupported / broken). A fully-green host sees a single ok line.
  console.log(heading("Compatibility"));
  const compatEnv = getCompatibilityEnv();
  const compatSummary = summarizeCompatibility(
    MODULE_MANIFEST.map((m) => ({ name: m.name, compatibility: m.compatibility })),
    compatEnv,
  );
  const envLine =
    compatEnv.osVersion === 0
      ? `arch=${compatEnv.cpu}  (non-darwin — version checks bypassed)`
      : `macOS ${compatEnv.osVersion}  arch=${compatEnv.cpu}  healthkit=${compatEnv.healthkitAvailable ? "yes" : "no"}`;
  ok("Host env", envLine);

  if (
    compatSummary.deprecated.length === 0 &&
    compatSummary.unsupported.length === 0 &&
    compatSummary.broken.length === 0
  ) {
    ok("All modules compatible", `${compatSummary.register.length} register cleanly`);
  } else {
    for (const d of compatSummary.deprecated) meh(`⚠ ${d.name}`, d.reason);
    for (const u of compatSummary.unsupported) meh(`↷ ${u.name}`, u.reason);
    for (const b of compatSummary.broken) bad(`✖ ${b.name}`, b.reason);
  }

  // ── HTTP network policy (RFC 0002) ─────────────────────────────────
  //
  // Surface what the HTTP transport *would* do if started right now with
  // the current env. Doctor runs in stdio context so nothing is bound —
  // this is pure introspection. Matches the same resolver the server uses,
  // so mismatches between doctor output and actual startup behaviour can
  // only come from config drift, not from stale logic here.
  console.log(heading("HTTP network policy"));
  try {
    const { resolveAllowNetwork } = await import("../server/http-transport.js");
    const envPolicy = (process.env.TAXI_ALLOW_NETWORK ?? "").trim() || undefined;
    const bindAll = process.argv.includes("--bind-all");
    const unsafeNoAuth = process.argv.includes("--unsafe-no-auth");
    const httpToken = process.env.TAXI_HTTP_TOKEN ?? "";
    const allowedOrigins = (process.env.TAXI_ALLOWED_ORIGINS ?? "").split(",").filter(Boolean);
    const effective = resolveAllowNetwork({
      explicit: envPolicy as never,
      bindAll,
      httpToken,
      allowedOriginsCount: allowedOrigins.length,
      unsafeNoAuth,
    });
    ok("Effective policy", effective);
    if (envPolicy) ok("TAXI_ALLOW_NETWORK", envPolicy);
    ok("Token", httpToken ? `set (sha256: ${httpToken.slice(0, 0)}${"…".repeat(1)})` : "not set");
    ok("Origin allow-list", allowedOrigins.length > 0 ? allowedOrigins.join(", ") : "(empty)");
    if (effective === "unauthenticated") {
      bad(
        "Danger mode",
        "allowNetwork=unauthenticated — tool surface exposed without auth. Intended for CI/debug only.",
      );
    } else if (effective === "loopback-only" && bindAll) {
      // The runtime would refuse to start in this state; doctor should
      // surface it clearly instead of silently contradicting itself.
      bad(
        "Config conflict",
        "--bind-all is set but policy is loopback-only — HTTP server would refuse to start. Drop --bind-all or set TAXI_ALLOW_NETWORK=with-token.",
      );
    }
  } catch (e) {
    // Non-fatal: this section is diagnostic, don't sink the whole doctor run.
    meh("HTTP policy resolver unavailable", e instanceof Error ? e.message : String(e));
  }

  // ── Audit trust ────────────────────────────────────────────────────
  //
  // Same composition the taxi://trust resource serves, against the real
  // local store. The one-line verdict doctor reports is the key-grade-aware
  // `assurance` tier — never the bare `governed` boolean, which stays true
  // under a re-derivable host-fallback key.
  console.log(heading("Audit trust"));
  try {
    const { buildTrustAttestation } = await import("../shared/resources.js");
    const s4 = spinner("Verifying audit chain...");
    let trust;
    try {
      trust = await buildTrustAttestation(runtimeConfig ?? undefined, { readOnly: true });
      s4.succeed("Audit chain checked");
    } catch (err) {
      s4.fail("Audit chain check failed");
      throw err; // outer catch renders the non-fatal meh line
    }

    if (trust.assurance === "operator-attested") {
      ok("Assurance", "operator-attested — chain verified with an operator key");
    } else if (trust.assurance === "tamper-evident") {
      meh(
        "Assurance",
        "tamper-evident — chain verified, but the key is host-derived (re-derivable by any local shell). " +
          "Archive the existing audit*.jsonl + audit.checkpoint, then `taxi setup` generates an operator key " +
          "(a key change does not re-sign existing rows).",
      );
    } else if (trust.assurance === "audit-halted") {
      bad("Assurance", "audit-halted — logging stopped (disk/permission/flush failure)");
    } else {
      bad(
        "Assurance",
        `tampered — chain broken at ${trust.audit.firstBreak?.file ?? "?"}:${trust.audit.firstBreak?.lineIndex ?? "?"} (${trust.audit.firstBreak?.reason ?? "unknown"})`,
      );
    }
    // A host-derived key source must not read as a green check when the
    // assurance line above just flagged it as the degradation.
    if (trust.audit.keySource === "host-derived") meh("Key source", "host-derived");
    else ok("Key source", trust.audit.keySource);
  } catch (e) {
    // Non-fatal: this section is diagnostic, don't sink the whole doctor run.
    meh("Audit trust unavailable", e instanceof Error ? e.message : String(e));
  }

  // ── Permissions ────────────────────────────────────────────────────
  if (platform === "darwin" && enabledMods.length > 0) {
    console.log(heading("Permissions"));

    const APP_MAP: Record<string, string> = {
      notes: "Notes",
      reminders: "Reminders",
      calendar: "Calendar",
      contacts: "Contacts",
      mail: "Mail",
      messages: "Messages",
      music: "Music",
      finder: "Finder",
      safari: "Safari",
      system: "System Events",
      photos: "Photos",
      shortcuts: "Shortcuts",
      tv: "TV",
      maps: "Maps",
    };

    const automationApps = [...new Set(enabledMods.map((mod) => APP_MAP[mod]).filter((app): app is string => !!app))];
    if (automationApps.length > 0) {
      // Sending even a harmless Apple Event can trigger a TCC prompt and
      // mutate the system permission database. A bare Application(name)
      // expression sends no event and therefore cannot prove access. Report
      // only the declared requirement in this read-only command.
      meh(
        "Automation access",
        `not probed in read-only mode (${automationApps.join(", ")}); inspect Taxi.app Trust Center or System Settings`,
      );
    }
  }

  // ── Swift Bridge ───────────────────────────────────────────────────
  console.log(heading("Optional"));

  const swiftBridgePath = join(PKG_ROOT, "swift", ".build", "release", "TaxiBridge");
  if (existsSync(swiftBridgePath)) {
    ok("Swift bridge", "built");
  } else {
    meh("Swift bridge", `not built — run: npm run swift-build (optional native bridge)`);
  }

  // GWS CLI. Availability is a PATH observation only; doctor must never use
  // `npx -y` because that installs code and populates ~/.npm during diagnosis.
  if (findExecutableOnPath("gws")) {
    ok("Google Workspace CLI", "installed");
  } else {
    meh("Google Workspace CLI", `not installed — npm i -g @googleworkspace/cli`);
  }

  // ── Deep checks (opt-in) ──────────────────────────────────────────
  // `--deep` runs slower live probes useful for user-reported triage:
  // audit-log HMAC chain integrity, Swift bridge path inspection, module
  // registry boot.
  const deepFlag = process.argv.includes("--deep");
  if (deepFlag) {
    console.log(heading("Deep checks (--deep)"));

    // 1. Audit log HMAC chain — single-line tampering probe.
    const s4 = spinner("Verifying audit log HMAC chain...");
    try {
      const auditMod = await import("../shared/audit.js");
      const summary = await auditMod.summarizeAuditEntries({ readOnly: true });
      s4.succeed("Audit verification complete");
      if (summary.auditDisabled) {
        meh("Audit log", "currently disabled (recovery window — re-enables on next call)");
      } else if (summary.verified) {
        ok("Audit HMAC chain", `verified across ${summary.scannedFiles} file(s), ${summary.total} entries`);
      } else if (summary.verifiedFirstBreak) {
        const b = summary.verifiedFirstBreak;
        if (summary.legacyMixedBreak) {
          // Key-holder-written rows under an older chain contract (pre-seq
          // build or two builds appending concurrently) — not tampering. The
          // server quarantines this automatically on its next flush.
          meh(
            "Audit HMAC chain",
            `mixed-version legacy history at ${b.file}:${b.lineIndex} (${b.reason}) — ` +
              `${summary.unverifiedTailRows} unverified row(s) will be quarantined byte-exact on the server's next ` +
              `audit flush and the chain resumes. If this recurs, an outdated Taxi build is still writing to this store.`,
          );
        } else {
          bad(
            "Audit HMAC chain",
            `break at ${b.file}:${b.lineIndex} (${b.reason}) — possible tampering or corruption. ` +
              `Inspect the surrounding lines, then call audit_summary to see the full break window.`,
          );
        }
      } else {
        meh("Audit HMAC chain", "no chained entries on disk yet");
      }
    } catch (e) {
      s4.fail("Audit verification failed");
      meh("Audit HMAC chain", `error: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 2. Swift bridge path inspection. checkSwiftBridge only checks whether
    //    the configured path is present; it does not launch or ping the bridge.
    const s5 = spinner("Checking Swift bridge path...");
    try {
      const swiftMod = await import("../shared/swift.js");
      const missing = await swiftMod.checkSwiftBridge();
      s5.succeed("Swift bridge path checked");
      if (!missing) {
        ok("Swift bridge", "path present (execution and response not probed)");
      } else {
        meh("Swift bridge", missing);
      }
    } catch (e) {
      s5.fail("Swift bridge path check failed");
      meh("Swift bridge", `error: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 3. Module registry boot smoke. Loads every module's tools.ts +
    //    optional prompts.ts the same way the runtime does and reports
    //    any module that fails to import (typo in a script.ts, missing
    //    transitive dep, etc.).
    const s6 = spinner("Loading module registry (boot smoke)...");
    try {
      const modulesMod = await import("../shared/modules.js");
      // loadModuleRegistry() with no config argument deliberately imports
      // every manifest entry — standard modules AND the opt-in ones
      // (spatial_prep, webhooks, powerautomate) — as a boot smoke test, so it
      // can catch an import-time bug even in a module the current profile
      // doesn't enable. The denominator must match that same universe
      // (MODULE_NAMES + OPT_IN_MODULE_NAMES), not just the standard count,
      // or the reported total is incoherent (e.g. "32 of 29").
      const registry = await modulesMod.loadModuleRegistry();
      s6.succeed("Module registry loaded");
      const optInLoaded = registry.filter((m) => (OPT_IN_MODULE_NAMES as readonly string[]).includes(m.name)).length;
      const standardLoaded = registry.length - optInLoaded;
      const totalTargets = MODULE_NAMES.length + OPT_IN_MODULE_NAMES.length;
      ok(
        "Module registry",
        `${standardLoaded} of ${MODULE_NAMES.length} standard + ${optInLoaded} of ${OPT_IN_MODULE_NAMES.length} opt-in modules loaded successfully`,
      );
      if (registry.length < totalTargets) {
        meh("Module registry", `${totalTargets - registry.length} module(s) failed — see stderr for the failed names`);
      }
    } catch (e) {
      s6.fail("Module registry boot failed");
      bad("Module registry", `import error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────
  console.log("");
  console.log(divider());
  console.log("");
  console.log(
    `  ${BOLD}Summary${RESET}  ${SYM.ok} ${pass} passed  ${warn > 0 ? `${SYM.warn} ${warn} warnings  ` : ""}${fail > 0 ? `${SYM.fail} ${fail} failed` : ""}`,
  );

  if (fail > 0) {
    console.log(`\n  ${DIM}Fix the issues above, then run: taxi doctor${RESET}`);
  } else if (warn > 0) {
    console.log(
      `\n  ${DIM}Warnings identify optional or currently inactive surfaces; review the observations above.${RESET}`,
    );
  } else {
    console.log(`\n  ${GREEN}${BOLD}  All checks passed. Taxi is ready.${RESET}`);
  }
  if (!deepFlag) {
    console.log(
      `  ${DIM}Run \`taxi doctor --deep\` for audit chain + Swift bridge path + module registry checks.${RESET}`,
    );
  }
  console.log("");

  // Doctor is used as a release/install gate. Warnings (including an
  // uninstalled or stopped optional Taxi.app) remain exit 0, while a concrete
  // integrity, foreign-listener, or operational contract failure is nonzero.
  const exitCode = doctorExitCode(fail);
  if (exitCode !== 0) process.exitCode = exitCode;
  return exitCode;
}
