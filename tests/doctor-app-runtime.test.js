import { createHash } from "node:crypto";
import { describe, expect, jest, test } from "@jest/globals";
import {
  INSTALLED_TAXI_APP_EXECUTABLE,
  INSTALLED_TAXI_APP_PATH,
  INSTALLED_TAXI_NODE_PATH,
  INSTALLED_TAXI_SERVER_ENTRY,
  inspectDoctorAppRuntime,
  parseDoctorListenerPids,
  parseDoctorProcessTable,
} from "../dist/cli/doctor-app-runtime.js";
import {
  appRuntimeRegistrationTokenState,
  doctorExitCode,
} from "../dist/cli/doctor.js";

const VERSION = "1.0.0";
const TOKEN = "t".repeat(43);
const OWNER_BEARER = `taxi_app_${"b".repeat(64)}`;
const APP_PID = 4100;
const RUNTIME_PID = 4200;
const TOKEN_PATH = "/tmp/taxi-doctor-http-token";
const OWNER_PATH = "/tmp/taxi-doctor-owner-secret";
const MCP_URL = "http://127.0.0.1:3848/mcp";
const CHILD_COMMAND = `${INSTALLED_TAXI_NODE_PATH} ${INSTALLED_TAXI_SERVER_ENTRY} run --http --port 3848`;

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function tokenFingerprint(token) {
  return createHash("sha256").update(`taxi-runtime-token-v1\n${token}`, "utf8").digest("hex");
}

function check(report, label) {
  const value = report.checks.find((candidate) => candidate.label === label);
  expect(value).toBeDefined();
  return value;
}

function installedPaths(path) {
  return [
    INSTALLED_TAXI_APP_PATH,
    INSTALLED_TAXI_APP_EXECUTABLE,
    INSTALLED_TAXI_NODE_PATH,
    INSTALLED_TAXI_SERVER_ENTRY,
    TOKEN_PATH,
    OWNER_PATH,
  ].includes(path);
}

function canonicalProcesses() {
  return [
    { pid: APP_PID, parentPid: 1, uid: 501, command: INSTALLED_TAXI_APP_EXECUTABLE },
    { pid: RUNTIME_PID, parentPid: APP_PID, uid: 501, command: CHILD_COMMAND },
  ];
}

function verifiedIdentity() {
  const authenticatedFetch = jest.fn();
  return {
    challenge: {
      status: "ok",
      appOwned: true,
      pid: RUNTIME_PID,
      version: VERSION,
      proof: "a".repeat(64),
      responseProof: "hmac-sha256-v1",
    },
    authorizationToken: OWNER_BEARER,
    authenticatedFetch,
  };
}

function healthyFetch(
  runtimeTokenFingerprint = tokenFingerprint(TOKEN),
  bearerEnforcement = {
    scheme: "bearer",
    missingRejected: true,
    invalidRejected: true,
    persistentAccepted: true,
    diagnosticProtocol: "owner-generation-read-only-v1",
  },
) {
  return jest.fn(async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/health") {
      return jsonResponse({ status: "ok", version: VERSION, appOwned: true });
    }
    if (url.pathname === "/app/runtime-state") {
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${OWNER_BEARER}`);
      expect(headers.get("x-taxi-doctor-probe")).toBe("owner-generation-read-only-v1");
      return jsonResponse({
        status: "ok",
        version: VERSION,
        appOwned: true,
        pid: RUNTIME_PID,
        tokenFingerprint: runtimeTokenFingerprint,
        bearerEnforcement,
      });
    }
    throw new Error(`unexpected URL ${url.href}`);
  });
}

function baseDependencies(overrides = {}) {
  const identity = verifiedIdentity();
  return {
    pathExists: installedPaths,
    processSnapshot: canonicalProcesses,
    listenerPids: () => [RUNTIME_PID],
    readCredential: () => TOKEN,
    inspectRegularFile: jest.fn(),
    verifyBundleTrust: jest.fn(),
    fetchImpl: healthyFetch(),
    verifyIdentity: jest.fn(async () => identity),
    probeMcp: jest.fn(async () => ({
      serverName: "taxi",
      serverVersion: VERSION,
      toolCount: 17,
      sampleTools: ["profile_status"],
    })),
    uid: 501,
    ...overrides,
  };
}

const OPTIONS = {
  expectedVersion: VERSION,
  mcpUrl: MCP_URL,
  tokenPath: TOKEN_PATH,
  ownerSecretPath: OWNER_PATH,
};

describe("Taxi doctor app-runtime observation contract", () => {
  test("parses process and listener snapshots without treating command text as a status", () => {
    expect(
      parseDoctorProcessTable(
        `  100   1 501 ${INSTALLED_TAXI_APP_EXECUTABLE}\n  200 100 501 ${CHILD_COMMAND}\nnot-a-process\n`,
      ),
    ).toEqual(
      canonicalProcesses().map((record, index) => ({
        ...record,
        pid: index === 0 ? 100 : 200,
        parentPid: index === 0 ? 1 : 100,
      })),
    );
    expect(parseDoctorListenerPids("p4200\nf12\np4200\np4300\n")).toEqual([4200, 4300]);
  });

  test("an uninstalled and inactive Taxi.app is warning-only", async () => {
    const fetchImpl = jest.fn();
    const report = await inspectDoctorAppRuntime(OPTIONS, {
      pathExists: () => false,
      processSnapshot: () => [],
      listenerPids: () => [],
      readCredential: () => {
        throw new Error("app runtime HTTP token is missing");
      },
      fetchImpl,
      uid: 501,
    });

    expect(report.hasFailures).toBe(false);
    expect(check(report, "Taxi.app installation").severity).toBe("warning");
    expect(check(report, "Runtime owner-secret integrity").severity).toBe("warning");
    expect(check(report, "Runtime listener").severity).toBe("warning");
    expect(check(report, "Runtime health payload").detail).toMatch(/not probed/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("installed launch inputs are each regular non-symlinks and bundle trust is checked independently", async () => {
    const inspectRegularFile = jest.fn((path, label) => {
      if (path === INSTALLED_TAXI_NODE_PATH) throw new Error(`${label} must not be a symbolic link`);
    });
    const verifyBundleTrust = jest.fn();
    const report = await inspectDoctorAppRuntime(OPTIONS, {
      ...baseDependencies(),
      inspectRegularFile,
      verifyBundleTrust,
    });

    expect(inspectRegularFile).toHaveBeenCalledTimes(3);
    expect(check(report, "Taxi.app executable file").severity).toBe("pass");
    expect(check(report, "Bundled Node file")).toMatchObject({
      severity: "failure",
      detail: expect.stringMatching(/symbolic link/),
    });
    expect(check(report, "Bundled server entry file").severity).toBe("pass");
    expect(check(report, "Taxi.app code signature").severity).toBe("warning");
    expect(verifyBundleTrust).not.toHaveBeenCalled();
    expect(report.hasFailures).toBe(true);
  });

  test("a complete installed bundle still fails when its exact code-signing trust check fails", async () => {
    const report = await inspectDoctorAppRuntime(OPTIONS, {
      ...baseDependencies(),
      verifyBundleTrust: () => {
        throw new Error("designated requirement mismatch");
      },
    });

    expect(check(report, "Taxi.app code signature")).toMatchObject({
      severity: "failure",
      detail: expect.stringMatching(/designated requirement mismatch/),
    });
  });

  test("an inactive runtime still validates an existing owner secret as a strong credential", async () => {
    const readCredential = jest.fn(() => TOKEN);
    const report = await inspectDoctorAppRuntime(OPTIONS, {
      ...baseDependencies(),
      processSnapshot: () => [],
      listenerPids: () => [],
      readCredential,
    });

    expect(readCredential).toHaveBeenCalledWith(OWNER_PATH, "app runtime owner secret", 501);
    expect(check(report, "Runtime owner-secret integrity").severity).toBe("pass");
  });

  test("an existing unsafe owner secret fails even while Taxi.app is inactive", async () => {
    const report = await inspectDoctorAppRuntime(OPTIONS, {
      ...baseDependencies(),
      processSnapshot: () => [],
      listenerPids: () => [],
      readCredential: (path) => {
        if (path === OWNER_PATH) throw new Error("owner secret permissions must be 0600, got 0644");
        return TOKEN;
      },
    });

    expect(check(report, "Runtime owner-secret integrity")).toMatchObject({
      severity: "failure",
      detail: expect.stringMatching(/permissions must be 0600/),
    });
    expect(report.hasFailures).toBe(true);
  });

  test("a canonical runtime child that is alive without a listener is a failure", async () => {
    const fetchImpl = jest.fn();
    const report = await inspectDoctorAppRuntime(OPTIONS, {
      ...baseDependencies(),
      listenerPids: () => [],
      fetchImpl,
    });

    expect(report.hasFailures).toBe(true);
    expect(check(report, "Runtime child argv").severity).toBe("pass");
    expect(check(report, "Runtime listener")).toMatchObject({
      severity: "failure",
      detail: expect.stringMatching(/child is alive.*no TCP listener/),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("an existing unsafe credential is a failure even while the app runtime is inactive", async () => {
    const report = await inspectDoctorAppRuntime(OPTIONS, {
      ...baseDependencies(),
      processSnapshot: () => [],
      listenerPids: () => [],
      readCredential: () => {
        throw new Error("app runtime HTTP token must not be a symbolic link");
      },
    });

    expect(check(report, "Runtime credential integrity")).toMatchObject({
      severity: "failure",
      detail: expect.stringMatching(/unsafe or malformed.*symbolic link/),
    });
    expect(report.hasFailures).toBe(true);
  });

  test("a raw listener that does not answer Taxi health is not reported as merely stopped", async () => {
    const report = await inspectDoctorAppRuntime(OPTIONS, {
      pathExists: () => false,
      processSnapshot: () => [],
      listenerPids: () => [9000],
      readCredential: () => {
        throw new Error("token missing");
      },
      fetchImpl: jest.fn(async () => {
        throw new Error("socket reset");
      }),
      uid: 501,
    });

    expect(check(report, "Runtime listener").severity).toBe("pass");
    expect(check(report, "Runtime health payload")).toMatchObject({
      severity: "failure",
      detail: expect.stringMatching(/listener did not provide Taxi health.*socket reset/),
    });
    expect(report.hasFailures).toBe(true);
  });

  test("a same-version manual runtime on the reserved port cannot pass as Taxi.app", async () => {
    const verifyIdentity = jest.fn();
    const probeMcp = jest.fn();
    const fetchImpl = jest.fn(async (input) => {
      const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (pathname === "/health") return jsonResponse({ status: "ok", version: VERSION, appOwned: false });
      throw new Error(`unexpected ${pathname}`);
    });
    const report = await inspectDoctorAppRuntime(OPTIONS, {
      ...baseDependencies(),
      processSnapshot: () => [],
      listenerPids: () => [9001],
      fetchImpl,
      verifyIdentity,
      probeMcp,
    });

    expect(check(report, "Runtime health payload")).toMatchObject({
      severity: "failure",
      detail: expect.stringMatching(/manual runtime.*appOwned=false/),
    });
    expect(check(report, "Runtime auth rejection").severity).toBe("warning");
    expect(check(report, "Runtime ownership attestation").severity).toBe("warning");
    expect(verifyIdentity).not.toHaveBeenCalled();
    expect(probeMcp).not.toHaveBeenCalled();
  });

  test("a spoofed health/auth surface still fails the existing OS ownership verifier", async () => {
    const probeMcp = jest.fn();
    const report = await inspectDoctorAppRuntime(OPTIONS, {
      ...baseDependencies(),
      processSnapshot: () => [],
      listenerPids: () => [9002],
      verifyIdentity: jest.fn(async () => {
        throw new Error("the Taxi.app listener is not the verified bundled runtime");
      }),
      probeMcp,
    });

    expect(check(report, "Runtime health payload").severity).toBe("pass");
    expect(check(report, "Runtime auth rejection").severity).toBe("warning");
    expect(check(report, "Runtime ownership attestation")).toMatchObject({
      severity: "failure",
      detail: expect.stringMatching(/not the verified bundled runtime/),
    });
    expect(check(report, "Runtime MCP readiness").severity).toBe("warning");
    expect(probeMcp).not.toHaveBeenCalled();
  });

  test("a runtime that cannot attest invalid-bearer rejection fails without sending a rejected request", async () => {
    const report = await inspectDoctorAppRuntime(OPTIONS, {
      ...baseDependencies(),
      fetchImpl: healthyFetch(tokenFingerprint(TOKEN), {
        scheme: "bearer",
        missingRejected: true,
        invalidRejected: false,
        persistentAccepted: true,
        diagnosticProtocol: "owner-generation-read-only-v1",
      }),
    });

    expect(check(report, "Runtime health payload").severity).toBe("pass");
    expect(check(report, "Runtime auth rejection")).toMatchObject({
      severity: "failure",
      detail: expect.stringMatching(/did not attest.*bearer rejection predicate/),
    });
    expect(report.hasFailures).toBe(true);
  });

  test("a stale persistent token is a failure even when proof-bound MCP is ready", async () => {
    const identity = verifiedIdentity();
    const probeMcp = jest.fn(async () => ({
      serverName: "taxi",
      serverVersion: VERSION,
      toolCount: 12,
      sampleTools: [],
    }));
    const report = await inspectDoctorAppRuntime(OPTIONS, {
      ...baseDependencies(),
      fetchImpl: healthyFetch(tokenFingerprint("s".repeat(43))),
      verifyIdentity: jest.fn(async () => identity),
      probeMcp,
    });

    expect(check(report, "Runtime ownership attestation").severity).toBe("pass");
    expect(check(report, "Runtime token binding")).toMatchObject({
      severity: "failure",
      detail: expect.stringMatching(/token file is stale/),
    });
    expect(check(report, "Runtime MCP readiness").severity).toBe("pass");
    expect(probeMcp).toHaveBeenCalledWith(
      expect.objectContaining({ token: OWNER_BEARER, fetchImpl: identity.authenticatedFetch }),
    );
    expect(report.hasFailures).toBe(true);
  });

  test("only a fully attested, token-bound MCP generation passes every runtime stage", async () => {
    const dependencies = baseDependencies();
    const report = await inspectDoctorAppRuntime(OPTIONS, dependencies);

    expect(report.hasFailures).toBe(false);
    expect(report.checks.every((candidate) => candidate.severity === "pass")).toBe(true);
    expect(check(report, "Runtime MCP readiness").detail).toMatch(/proof-bound initialize \+ tools\/list/);
    expect(check(report, "Persistent-token MCP readiness").detail).toMatch(/matching persistent-token fingerprint/);
    expect(dependencies.probeMcp).toHaveBeenCalledTimes(1);
    expect(dependencies.probeMcp).toHaveBeenCalledWith(
      expect.objectContaining({
        token: OWNER_BEARER,
        clientName: "taxi-doctor",
        readOnlyDiagnostic: true,
      }),
    );
    expect(
      dependencies.fetchImpl.mock.calls.map(
        ([input]) => new URL(input instanceof Request ? input.url : String(input)).pathname,
      ),
    ).toEqual(["/health", "/app/runtime-state"]);
  });

  test("persistent-token readiness cannot borrow MCP framing when its fingerprint is stale", async () => {
    const report = await inspectDoctorAppRuntime(OPTIONS, {
      ...baseDependencies(),
      fetchImpl: healthyFetch(tokenFingerprint("s".repeat(43))),
    });

    expect(check(report, "Runtime MCP readiness").severity).toBe("pass");
    expect(check(report, "Persistent-token MCP readiness")).toMatchObject({
      severity: "warning",
      detail: expect.stringMatching(/fingerprint is not bound/),
    });
    expect(report.hasFailures).toBe(true);
  });

  test("two same-uid Taxi.app processes violate the single-instance contract", async () => {
    const report = await inspectDoctorAppRuntime(OPTIONS, {
      ...baseDependencies(),
      processSnapshot: () => [
        ...canonicalProcesses(),
        { pid: APP_PID + 1, parentPid: 1, uid: 501, command: INSTALLED_TAXI_APP_EXECUTABLE },
      ],
    });

    expect(check(report, "Taxi.app process")).toMatchObject({
      severity: "failure",
      detail: expect.stringMatching(/single-instance contract violated/),
    });
    expect(report.hasFailures).toBe(true);
  });

  test("a bundled child with mutated argv is an integrity failure", async () => {
    const report = await inspectDoctorAppRuntime(OPTIONS, {
      ...baseDependencies(),
      processSnapshot: () => [
        { pid: APP_PID, parentPid: 1, uid: 501, command: INSTALLED_TAXI_APP_EXECUTABLE },
        { pid: RUNTIME_PID, parentPid: APP_PID, uid: 501, command: `${CHILD_COMMAND} --unexpected` },
      ],
      listenerPids: () => [],
    });

    expect(check(report, "Runtime child argv")).toMatchObject({
      severity: "failure",
      detail: expect.stringMatching(/do not match the canonical launch contract/),
    });
    expect(report.hasFailures).toBe(true);
  });

  test("doctor returns nonzero only for concrete failures, not warnings", () => {
    expect(doctorExitCode(0)).toBe(0);
    expect(doctorExitCode(1)).toBe(1);
    expect(doctorExitCode(99)).toBe(1);
  });

  test("client registration token state never upgrades a stale or unverified value to connected", () => {
    const entry = { env: { TAXI_HTTP_TOKEN: "old-token" } };
    expect(appRuntimeRegistrationTokenState(entry, "fresh-token")).toBe("stale");
    expect(appRuntimeRegistrationTokenState(entry, undefined)).toBe("unverifiable");
    expect(appRuntimeRegistrationTokenState(entry, "old-token")).toBe("matching");
  });
});
