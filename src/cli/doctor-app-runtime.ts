import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import {
  APP_RUNTIME_OWNER_SECRET_PATH,
  readPrivateRuntimeCredential,
  verifyRuntimeIdentityChallenge,
  type VerifiedAppRuntimeIdentity,
} from "../shared/app-runtime-identity.js";
import { APP_RUNTIME_TOKEN_PATH } from "../shared/app-runtime-token.js";
import { APP_RUNTIME_DIAGNOSTIC_HEADER, APP_RUNTIME_DIAGNOSTIC_PROTOCOL } from "../shared/app-runtime-diagnostic.js";
import { CODEX_APP_OWNED_URL } from "./codex-mcp.js";
import { probeAppRuntimeMcp, type AppRuntimeProbeOptions, type AppRuntimeProbeResult } from "./app-runtime-probe.js";

export const INSTALLED_TAXI_APP_PATH = "/Applications/Taxi.app";
export const INSTALLED_TAXI_APP_EXECUTABLE = join(INSTALLED_TAXI_APP_PATH, "Contents", "MacOS", "Taxi");
export const INSTALLED_TAXI_NODE_PATH = join(
  INSTALLED_TAXI_APP_PATH,
  "Contents",
  "Resources",
  "taxi",
  "runtime",
  "bin",
  "node",
);
export const INSTALLED_TAXI_SERVER_ENTRY = join(
  INSTALLED_TAXI_APP_PATH,
  "Contents",
  "Resources",
  "taxi",
  "server",
  "dist",
  "index.js",
);

export type DoctorCheckSeverity = "pass" | "warning" | "failure";

export interface DoctorAppRuntimeCheck {
  label: string;
  severity: DoctorCheckSeverity;
  detail: string;
}

export interface DoctorProcessRecord {
  pid: number;
  parentPid: number;
  uid: number;
  command: string;
}

export interface DoctorAppRuntimeReport {
  checks: DoctorAppRuntimeCheck[];
  hasFailures: boolean;
}

export interface DoctorAppRuntimeOptions {
  expectedVersion: string;
  mcpUrl?: string;
  tokenPath?: string;
  ownerSecretPath?: string;
  timeoutMs?: number;
  mcpTimeoutMs?: number;
}

export interface DoctorAppRuntimeDependencies {
  pathExists?: (path: string) => boolean;
  inspectRegularFile?: (path: string, label: string) => void;
  verifyBundleTrust?: (appPath: string) => void;
  processSnapshot?: () => DoctorProcessRecord[];
  listenerPids?: (mcpUrl: string) => number[];
  readCredential?: (path: string, label: string, uid?: number) => string;
  verifyIdentity?: (options: {
    url: string;
    ownerSecretPath?: string;
    timeoutMs?: number;
    expectedVersion?: string;
  }) => Promise<VerifiedAppRuntimeIdentity>;
  probeMcp?: (options: AppRuntimeProbeOptions) => Promise<AppRuntimeProbeResult>;
  fetchImpl?: typeof fetch;
  uid?: number;
}

const INSTALLED_APP_REQUIREMENT =
  'anchor apple generic and identifier "app.taxi" and certificate leaf[subject.OU] = "XS7HJJN7GC"';

function inspectRegularFile(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
}

function verifyInstalledBundleTrust(appPath: string): void {
  const result = spawnSync(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", "--requirement", INSTALLED_APP_REQUIREMENT, appPath],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `codesign exited ${result.status}`).trim());
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseDoctorProcessTable(output: string): DoctorProcessRecord[] {
  const records: DoctorProcessRecord[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!match) continue;
    const [, pidValue, parentPidValue, uidValue, command] = match;
    const pid = Number(pidValue);
    const parentPid = Number(parentPidValue);
    const uid = Number(uidValue);
    if (![pid, parentPid, uid].every(Number.isSafeInteger) || !command) continue;
    records.push({ pid, parentPid, uid, command });
  }
  return records;
}

function readSystemProcessSnapshot(): DoctorProcessRecord[] {
  const result = spawnSync("/bin/ps", ["-ww", "-axo", "pid=,ppid=,uid=,command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`ps exited ${result.status}: ${(result.stderr || result.stdout).trim()}`);
  }
  return parseDoctorProcessTable(result.stdout);
}

export function parseDoctorListenerPids(output: string): number[] {
  return [
    ...new Set(
      output
        .split("\n")
        .map((line) => (/^p\d+$/.test(line) ? Number(line.slice(1)) : undefined))
        .filter((pid): pid is number => pid !== undefined && Number.isSafeInteger(pid) && pid > 1),
    ),
  ].sort((left, right) => left - right);
}

function readListenerPids(mcpUrl: string): number[] {
  const url = new URL(mcpUrl);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const result = spawnSync("/usr/sbin/lsof", ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  // lsof uses 1 for a valid query that found no matching file descriptors.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`lsof exited ${result.status}: ${(result.stderr || result.stdout).trim()}`);
  }
  return parseDoctorListenerPids(result.stdout);
}

function healthUrl(mcpUrl: string): string {
  const url = new URL(mcpUrl);
  url.pathname = "/health";
  url.search = "";
  url.hash = "";
  return url.href;
}

function runtimeStateUrl(mcpUrl: string): string {
  const url = new URL(mcpUrl);
  url.pathname = "/app/runtime-state";
  url.search = "";
  url.hash = "";
  return url.href;
}

async function fetchJsonWithTimeout(
  fetchImpl: typeof fetch,
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = 1_500,
): Promise<{ response: Response; value?: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(input, { ...init, signal: controller.signal });
    if (!response.ok) return { response };
    try {
      return { response, value: await response.json() };
    } catch (error) {
      throw new Error(`response is not JSON: ${errorMessage(error)}`, { cause: error });
    }
  } finally {
    clearTimeout(timeout);
  }
}

function runtimeTokenFingerprint(token: string): string {
  return createHash("sha256").update(`taxi-runtime-token-v1\n${token}`, "utf8").digest("hex");
}

function diagnosticPayload(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function skipped(checks: DoctorAppRuntimeCheck[], label: string, prerequisite: string): void {
  checks.push({ label, severity: "warning", detail: `not probed — ${prerequisite}` });
}

/**
 * Inspect the canonical Taxi.app runtime as a sequence of independent facts.
 * A TCP listener, a healthy payload, bearer rejection, OS ownership, and MCP
 * readiness are deliberately separate checks: no weaker observation is used
 * as evidence for a stronger one.
 */
export async function inspectDoctorAppRuntime(
  options: DoctorAppRuntimeOptions,
  dependencies: DoctorAppRuntimeDependencies = {},
): Promise<DoctorAppRuntimeReport> {
  const checks: DoctorAppRuntimeCheck[] = [];
  const mcpUrl = options.mcpUrl ?? CODEX_APP_OWNED_URL;
  const tokenPath = options.tokenPath ?? APP_RUNTIME_TOKEN_PATH;
  const ownerSecretPath = options.ownerSecretPath ?? APP_RUNTIME_OWNER_SECRET_PATH;
  const timeoutMs = options.timeoutMs ?? 1_500;
  const pathExists = dependencies.pathExists ?? existsSync;
  const inspectFile = dependencies.inspectRegularFile ?? inspectRegularFile;
  const verifyBundleTrust = dependencies.verifyBundleTrust ?? verifyInstalledBundleTrust;
  const processSnapshot = dependencies.processSnapshot ?? readSystemProcessSnapshot;
  const listenerPids = dependencies.listenerPids ?? readListenerPids;
  const readCredential = dependencies.readCredential ?? readPrivateRuntimeCredential;
  const verifyIdentity = dependencies.verifyIdentity ?? verifyRuntimeIdentityChallenge;
  const probeMcp = dependencies.probeMcp ?? probeAppRuntimeMcp;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const uid = dependencies.uid ?? process.getuid?.();
  const port = new URL(mcpUrl).port || "80";
  const expectedChildCommand = `${INSTALLED_TAXI_NODE_PATH} ${INSTALLED_TAXI_SERVER_ENTRY} run --http --port ${port}`;

  const appInstalled = pathExists(INSTALLED_TAXI_APP_PATH);
  if (!appInstalled) {
    checks.push({
      label: "Taxi.app installation",
      severity: "warning",
      detail: "not installed in /Applications (direct stdio remains available)",
    });
  } else {
    checks.push({
      label: "Taxi.app installation",
      severity: "pass",
      detail: "/Applications/Taxi.app is installed; launch inputs are inspected separately",
    });

    const launchInputs = [
      { label: "Taxi.app executable file", path: INSTALLED_TAXI_APP_EXECUTABLE, role: "app executable" },
      { label: "Bundled Node file", path: INSTALLED_TAXI_NODE_PATH, role: "bundled Node" },
      { label: "Bundled server entry file", path: INSTALLED_TAXI_SERVER_ENTRY, role: "server entry" },
    ] as const;
    let launchInputsSafe = true;
    for (const input of launchInputs) {
      try {
        inspectFile(input.path, input.role);
        checks.push({ label: input.label, severity: "pass", detail: `${input.path} is a regular non-symlink file` });
      } catch (error) {
        launchInputsSafe = false;
        checks.push({ label: input.label, severity: "failure", detail: `${input.path}: ${errorMessage(error)}` });
      }
    }

    if (launchInputsSafe) {
      try {
        verifyBundleTrust(INSTALLED_TAXI_APP_PATH);
        checks.push({
          label: "Taxi.app code signature",
          severity: "pass",
          detail: "bundle passed deep/strict app.taxi + team requirement verification",
        });
      } catch (error) {
        checks.push({
          label: "Taxi.app code signature",
          severity: "failure",
          detail: `installed bundle trust verification failed: ${errorMessage(error)}`,
        });
      }
    } else {
      skipped(checks, "Taxi.app code signature", "one or more launch inputs are unsafe");
    }
  }

  let exactRuntimeChildren: DoctorProcessRecord[] = [];
  let appProcessCount = 0;
  try {
    const records = processSnapshot();
    const appProcesses = records.filter(
      (record) =>
        (uid === undefined || record.uid === uid) &&
        (record.command === INSTALLED_TAXI_APP_EXECUTABLE ||
          record.command.startsWith(`${INSTALLED_TAXI_APP_EXECUTABLE} `)),
    );
    const appPids = new Set(appProcesses.map((record) => record.pid));
    appProcessCount = appProcesses.length;
    const children = records.filter(
      (record) => appPids.has(record.parentPid) && (uid === undefined || record.uid === uid),
    );
    exactRuntimeChildren = children.filter((record) => record.command === expectedChildCommand);
    const unexpectedRuntimeChildren = children.filter(
      (record) =>
        record.command !== expectedChildCommand &&
        (record.command === INSTALLED_TAXI_NODE_PATH ||
          record.command.startsWith(`${INSTALLED_TAXI_NODE_PATH} `) ||
          record.command.includes(INSTALLED_TAXI_SERVER_ENTRY)),
    );

    if (appProcesses.length === 0) {
      checks.push({ label: "Taxi.app process", severity: "warning", detail: "not running" });
    } else if (appProcesses.length > 1) {
      checks.push({
        label: "Taxi.app process",
        severity: "failure",
        detail: `single-instance contract violated: same uid has PIDs ${appProcesses.map((record) => record.pid).join(", ")}`,
      });
    } else {
      checks.push({
        label: "Taxi.app process",
        severity: "pass",
        detail: `running PID${appProcesses.length === 1 ? "" : "s"} ${appProcesses.map((record) => record.pid).join(", ")}`,
      });
    }

    if (unexpectedRuntimeChildren.length > 0) {
      checks.push({
        label: "Runtime child argv",
        severity: "failure",
        detail: `bundled runtime child PID${unexpectedRuntimeChildren.length === 1 ? "" : "s"} ${unexpectedRuntimeChildren.map((record) => record.pid).join(", ")} do not match the canonical launch contract`,
      });
    } else if (exactRuntimeChildren.length > 1) {
      checks.push({
        label: "Runtime child argv",
        severity: "failure",
        detail: `expected one canonical runtime child, found ${exactRuntimeChildren.length}`,
      });
    } else if (exactRuntimeChildren.length === 1) {
      checks.push({
        label: "Runtime child argv",
        severity: "pass",
        detail: `PID ${exactRuntimeChildren[0]!.pid} matches bundled-node/server/run --http --port ${port}`,
      });
    } else {
      checks.push({
        label: "Runtime child argv",
        severity: "warning",
        detail: "no canonical app-owned child is running",
      });
    }
  } catch (error) {
    checks.push({
      label: "Taxi.app process",
      severity: "warning",
      detail: `could not inspect process table: ${errorMessage(error)}`,
    });
    skipped(checks, "Runtime child argv", "process table unavailable");
  }

  let listenerState: "absent" | "present" | "ambiguous" | "unknown" = "unknown";
  try {
    const observedListenerPids = listenerPids(mcpUrl);
    if (observedListenerPids.length === 0) {
      listenerState = "absent";
      checks.push({
        label: "Runtime listener",
        severity: exactRuntimeChildren.length > 0 ? "failure" : "warning",
        detail:
          exactRuntimeChildren.length > 0
            ? `runtime child is alive but port ${port} has no TCP listener`
            : `no TCP listener on 127.0.0.1:${port}`,
      });
    } else if (observedListenerPids.length === 1) {
      listenerState = "present";
      checks.push({
        label: "Runtime listener",
        severity: "pass",
        detail: `TCP port ${port} is listening (PID ${observedListenerPids[0]})`,
      });
    } else {
      listenerState = "ambiguous";
      checks.push({
        label: "Runtime listener",
        severity: "failure",
        detail: `expected one listener on port ${port}, found PIDs ${observedListenerPids.join(", ")}`,
      });
    }
  } catch (error) {
    checks.push({
      label: "Runtime listener",
      severity: "warning",
      detail: `could not inspect TCP ownership: ${errorMessage(error)}`,
    });
  }

  let runtimeToken: string | undefined;
  let credentialError: unknown;
  try {
    runtimeToken = readCredential(tokenPath, "app runtime HTTP token", uid);
  } catch (error) {
    credentialError = error;
  }

  let ownerSecretError: unknown;
  let ownerSecretValid = false;
  try {
    readCredential(ownerSecretPath, "app runtime owner secret", uid);
    ownerSecretValid = true;
  } catch (error) {
    ownerSecretError = error;
  }
  if (ownerSecretValid) {
    checks.push({
      label: "Runtime owner-secret integrity",
      severity: "pass",
      detail: `${ownerSecretPath} is a private, owner-only regular credential file`,
    });
  } else {
    const missing = !pathExists(ownerSecretPath);
    const runtimeObservable =
      appProcessCount > 0 ||
      exactRuntimeChildren.length > 0 ||
      listenerState === "present" ||
      listenerState === "ambiguous";
    checks.push({
      label: "Runtime owner-secret integrity",
      severity: missing && !runtimeObservable ? "warning" : "failure",
      detail: missing
        ? "runtime owner secret has not been created"
        : `runtime owner secret is unsafe or malformed: ${errorMessage(ownerSecretError)}`,
    });
  }

  if (listenerState === "absent") {
    if (runtimeToken !== undefined) {
      checks.push({
        label: "Runtime credential integrity",
        severity: "pass",
        detail: `${tokenPath} is a private, owner-only regular credential file`,
      });
    } else {
      const missing = !pathExists(tokenPath);
      checks.push({
        label: "Runtime credential integrity",
        severity: missing && exactRuntimeChildren.length === 0 ? "warning" : "failure",
        detail: missing
          ? "runtime token has not been created"
          : `runtime token is unsafe or malformed: ${errorMessage(credentialError)}`,
      });
    }
    skipped(checks, "Runtime health payload", "no TCP listener");
    skipped(checks, "Runtime auth rejection", "no TCP listener");
    skipped(checks, "Runtime ownership attestation", "no TCP listener");
    skipped(checks, "Runtime token binding", "no verified app-owned runtime");
    skipped(checks, "Runtime MCP readiness", "no verified app-owned runtime");
    skipped(checks, "Persistent-token MCP readiness", "no verified app-owned runtime");
    return { checks, hasFailures: checks.some((check) => check.severity === "failure") };
  }

  let healthIsExpectedAppRuntime = false;
  let healthResponded = false;
  try {
    const { response, value } = await fetchJsonWithTimeout(
      fetchImpl,
      healthUrl(mcpUrl),
      { cache: "no-store" },
      timeoutMs,
    );
    healthResponded = true;
    if (!response.ok) {
      checks.push({
        label: "Runtime health payload",
        severity: "failure",
        detail: `reserved port returned HTTP ${response.status} from /health`,
      });
    } else {
      const health = value as { status?: unknown; version?: unknown; appOwned?: unknown };
      if (health.status !== "ok") {
        checks.push({
          label: "Runtime health payload",
          severity: "failure",
          detail: `unexpected status payload: ${diagnosticPayload(value)}`,
        });
      } else if (health.version !== options.expectedVersion) {
        checks.push({
          label: "Runtime health payload",
          severity: "failure",
          detail: `version mismatch: package v${options.expectedVersion}, listener v${typeof health.version === "string" ? health.version : "unknown"}`,
        });
      } else if (health.appOwned !== true) {
        checks.push({
          label: "Runtime health payload",
          severity: "failure",
          detail:
            health.appOwned === false
              ? `v${options.expectedVersion} manual runtime occupies the Taxi.app port (appOwned=false)`
              : `v${options.expectedVersion} listener omitted appOwned=true`,
        });
      } else {
        healthIsExpectedAppRuntime = true;
        checks.push({
          label: "Runtime health payload",
          severity: "pass",
          detail: `status=ok, version=${options.expectedVersion}, appOwned=true`,
        });
      }
    }
  } catch (error) {
    checks.push({
      label: "Runtime health payload",
      severity:
        listenerState === "present" || listenerState === "ambiguous" || exactRuntimeChildren.length > 0
          ? "failure"
          : "warning",
      detail:
        listenerState === "present" || listenerState === "ambiguous"
          ? `TCP listener did not provide Taxi health: ${errorMessage(error)}`
          : `runtime did not answer /health: ${errorMessage(error)}`,
    });
  }

  if (runtimeToken !== undefined) {
    checks.push({
      label: "Runtime credential integrity",
      severity: "pass",
      detail: `${tokenPath} is a private, owner-only regular credential file`,
    });
  } else {
    const missing = !pathExists(tokenPath);
    checks.push({
      label: "Runtime credential integrity",
      severity:
        healthResponded || listenerState === "present" || listenerState === "ambiguous" || !missing
          ? "failure"
          : "warning",
      detail: missing
        ? "runtime is observable but its private token file is missing"
        : `runtime token is unsafe or malformed: ${errorMessage(credentialError)}`,
    });
  }

  let verifiedIdentity: VerifiedAppRuntimeIdentity | undefined;
  if (healthIsExpectedAppRuntime) {
    try {
      verifiedIdentity = await verifyIdentity({
        url: mcpUrl,
        ownerSecretPath,
        timeoutMs,
        expectedVersion: options.expectedVersion,
      });
      checks.push({
        label: "Runtime ownership attestation",
        severity: "pass",
        detail: `PID ${verifiedIdentity.challenge.pid} passed listener argv, parent, live signature, and owner-secret challenge checks`,
      });
    } catch (error) {
      checks.push({
        label: "Runtime ownership attestation",
        severity: "failure",
        detail: errorMessage(error),
      });
    }
  } else {
    skipped(checks, "Runtime ownership attestation", "health did not prove version + appOwned payload");
  }

  let runtimeTokenBound = false;
  let authRejectionAttested = false;
  if (verifiedIdentity && runtimeToken !== undefined) {
    try {
      const { response, value } = await fetchJsonWithTimeout(
        fetchImpl,
        runtimeStateUrl(mcpUrl),
        {
          cache: "no-store",
          headers: {
            Authorization: `Bearer ${verifiedIdentity.authorizationToken}`,
            [APP_RUNTIME_DIAGNOSTIC_HEADER]: APP_RUNTIME_DIAGNOSTIC_PROTOCOL,
          },
        },
        timeoutMs,
      );
      if (response.status === 503) {
        checks.push({
          label: "Runtime token binding",
          severity: "warning",
          detail: "runtime state is still warming; token generation was not compared",
        });
      } else if (!response.ok) {
        checks.push({
          label: "Runtime token binding",
          severity: "failure",
          detail: `generation-authenticated runtime state returned HTTP ${response.status}`,
        });
      } else {
        const state = value as {
          status?: unknown;
          version?: unknown;
          appOwned?: unknown;
          pid?: unknown;
          tokenFingerprint?: unknown;
          bearerEnforcement?: {
            scheme?: unknown;
            missingRejected?: unknown;
            invalidRejected?: unknown;
            persistentAccepted?: unknown;
            diagnosticProtocol?: unknown;
          };
        };
        const expectedFingerprint = runtimeTokenFingerprint(runtimeToken);
        if (
          state.status !== "ok" ||
          state.version !== options.expectedVersion ||
          state.appOwned !== true ||
          state.pid !== verifiedIdentity.challenge.pid ||
          typeof state.tokenFingerprint !== "string"
        ) {
          checks.push({
            label: "Runtime token binding",
            severity: "failure",
            detail: `runtime state did not match the verified process: ${diagnosticPayload(value)}`,
          });
        } else if (state.tokenFingerprint !== expectedFingerprint) {
          checks.push({
            label: "Runtime token binding",
            severity: "failure",
            detail: "token file is stale: its fingerprint differs from the running app-owned generation",
          });
        } else {
          runtimeTokenBound = true;
          checks.push({
            label: "Runtime token binding",
            severity: "pass",
            detail: "private token file matches the verified running generation",
          });
        }

        if (
          state.bearerEnforcement?.scheme === "bearer" &&
          state.bearerEnforcement.missingRejected === true &&
          state.bearerEnforcement.invalidRejected === true &&
          state.bearerEnforcement.persistentAccepted === true &&
          state.bearerEnforcement.diagnosticProtocol === APP_RUNTIME_DIAGNOSTIC_PROTOCOL
        ) {
          authRejectionAttested = true;
          checks.push({
            label: "Runtime auth rejection",
            severity: "pass",
            detail: "generation-attested bearer predicate rejects missing and invalid credentials",
          });
        } else {
          checks.push({
            label: "Runtime auth rejection",
            severity: "failure",
            detail: `runtime did not attest the canonical bearer rejection predicate: ${diagnosticPayload(state.bearerEnforcement)}`,
          });
        }
      }
    } catch (error) {
      checks.push({
        label: "Runtime token binding",
        severity: "failure",
        detail: `could not compare the private token to runtime state: ${errorMessage(error)}`,
      });
    }
  } else {
    skipped(
      checks,
      "Runtime token binding",
      verifiedIdentity ? "private runtime token is unavailable" : "runtime ownership is unverified",
    );
    skipped(checks, "Runtime auth rejection", "runtime ownership or private token is unverified");
  }
  if (!checks.some((check) => check.label === "Runtime auth rejection")) {
    skipped(checks, "Runtime auth rejection", "generation-authenticated runtime state was unavailable");
  }

  let runtimeMcpReady = false;
  if (verifiedIdentity) {
    try {
      const probe = await probeMcp({
        url: mcpUrl,
        token: verifiedIdentity.authorizationToken,
        fetchImpl: verifiedIdentity.authenticatedFetch,
        clientName: "taxi-doctor",
        readOnlyDiagnostic: true,
        timeoutMs: options.mcpTimeoutMs ?? 3_000,
      });
      if (probe.serverName !== "taxi" || probe.serverVersion !== options.expectedVersion) {
        checks.push({
          label: "Runtime MCP readiness",
          severity: "failure",
          detail: `initialize identified ${probe.serverName ?? "unknown"}@${probe.serverVersion ?? "unknown"}; expected taxi@${options.expectedVersion}`,
        });
      } else {
        runtimeMcpReady = true;
        checks.push({
          label: "Runtime MCP readiness",
          severity: "pass",
          detail: `proof-bound initialize + tools/list completed (${probe.toolCount} tools)`,
        });
      }
    } catch (error) {
      checks.push({
        label: "Runtime MCP readiness",
        severity: "failure",
        detail: `proof-bound initialize/tools-list failed: ${errorMessage(error)}`,
      });
    }
  } else {
    skipped(checks, "Runtime MCP readiness", "runtime ownership is unverified");
  }

  if (verifiedIdentity && runtimeToken !== undefined && runtimeTokenBound && authRejectionAttested && runtimeMcpReady) {
    checks.push({
      label: "Persistent-token MCP readiness",
      severity: "pass",
      detail:
        "generation-attested bearer predicate, matching persistent-token fingerprint, and one proof-bound MCP exchange agree",
    });
  } else {
    skipped(
      checks,
      "Persistent-token MCP readiness",
      !verifiedIdentity
        ? "runtime ownership is unverified"
        : runtimeToken === undefined
          ? "private runtime token is unavailable"
          : !runtimeTokenBound
            ? "persistent token fingerprint is not bound to the running generation"
            : !authRejectionAttested
              ? "bearer rejection predicate is unverified"
              : "proof-bound MCP framing is not ready",
    );
  }

  return { checks, hasFailures: checks.some((check) => check.severity === "failure") };
}
