import { afterEach, describe, expect, test } from "@jest/globals";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanBootEnv } from "../scripts/lib/clean-boot-env.mjs";

import {
  FULL_SURFACE_CANARY_TOOLS,
  FULL_SURFACE_MIN_TOOLS,
  parseArgs,
  probeAppRuntime,
  readPrivateOwnerSecret,
  readPrivateToken,
  runtimeGenerationBearer,
  runtimeIdentityProof,
  runtimeResponseProof,
  verifyRuntimeIdentityChallenge,
} from "../scripts/probe-app-runtime.mjs";

const VERSION = "1.0.0";
const OWNER_SECRET = "a".repeat(43);
const TOKEN = "t".repeat(43);
const tempDirs = [];
const servers = [];
const children = [];
const DIST = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
  }
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(() => resolve()))));
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function freePort() {
  const server = createTcpServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === "string") throw new Error("failed to allocate a test port");
  return address.port;
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`app-owned test server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // Keep waiting for the listener.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("app-owned test server did not become healthy");
}

function makeCredentials() {
  const directory = mkdtempSync(join(tmpdir(), "taxi-runtime-probe-"));
  tempDirs.push(directory);
  const tokenFile = join(directory, "http-token");
  const ownerSecretFile = join(directory, "runtime-owner-secret");
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  writeFileSync(ownerSecretFile, `${OWNER_SECRET}\n`, { mode: 0o600 });
  return { directory, tokenFile, ownerSecretFile };
}

async function listen(handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}/mcp`;
}

describe("app runtime identity probe", () => {
  test("bundle verification supplies both private credentials and the expected version", () => {
    const bundleScript = readFileSync(new URL("../scripts/bundle-app.sh", import.meta.url), "utf8");
    expect(bundleScript).toContain('OWNER_SECRET_FILE="${TAXI_APP_RUNTIME_OWNER_PATH:-');
    expect(bundleScript).toContain('credential_uid="$(stat -f "%u" "$credential_path")"');
    expect(bundleScript).toContain('--owner-secret-file "$OWNER_SECRET_FILE"');
    expect(bundleScript).toContain('--expected-version "$EXPECTED_VERSION"');
    expect(bundleScript).toContain("App identity challenge yields generation-authenticated MCP");
  });

  test("requires private current-user credential files and rejects raw bearer input", () => {
    const { tokenFile, ownerSecretFile } = makeCredentials();
    expect(readPrivateToken(tokenFile)).toBe(TOKEN);
    expect(readPrivateOwnerSecret(ownerSecretFile)).toBe(OWNER_SECRET);
    expect(() => readPrivateToken(tokenFile, (process.getuid?.() ?? 0) + 1)).toThrow(/current user/);
    expect(() => readPrivateOwnerSecret(ownerSecretFile, (process.getuid?.() ?? 0) + 1)).toThrow(/current user/);

    chmodSync(tokenFile, 0o640);
    chmodSync(ownerSecretFile, 0o400);
    expect(() => readPrivateToken(tokenFile)).toThrow(/0600/);
    expect(() => readPrivateOwnerSecret(ownerSecretFile)).toThrow(/0600/);
    expect(() => parseArgs(["--url", "http://127.0.0.1:3848/mcp", "--token", TOKEN])).toThrow(
      /unknown option: --token/,
    );
    const parsed = parseArgs([
      "--url",
      "http://127.0.0.1:3848/mcp",
      "--owner-secret-file",
      ownerSecretFile,
      "--require-tool",
      "list_notes",
      "--require-tool",
      "memory_query",
    ]);
    expect(parsed.requiredTools).toEqual(["list_notes", "memory_query"]);
    expect(() =>
      parseArgs([
        "--url",
        "http://127.0.0.1:3848/mcp",
        "--owner-secret-file",
        ownerSecretFile,
        "--require-tool",
        "not a tool",
      ]),
    ).toThrow(/valid tool name/);
  });

  test("binds the proof to its domain, nonce, PID, and version", () => {
    expect(runtimeIdentityProof(OWNER_SECRET, "b".repeat(43), 123, VERSION)).toBe(
      "b123b0d9e62577ba57db9ed623cd58cc0b8c807fcf4c16ee463278cd12322d9c",
    );
    expect(runtimeIdentityProof(OWNER_SECRET, "c".repeat(43), 123, VERSION)).not.toBe(
      runtimeIdentityProof(OWNER_SECRET, "b".repeat(43), 123, VERSION),
    );
    expect(runtimeIdentityProof(OWNER_SECRET, "b".repeat(43), 124, VERSION)).not.toBe(
      runtimeIdentityProof(OWNER_SECRET, "b".repeat(43), 123, VERSION),
    );
    expect(runtimeIdentityProof(OWNER_SECRET, "b".repeat(43), 123, "1.0.1")).not.toBe(
      runtimeIdentityProof(OWNER_SECRET, "b".repeat(43), 123, VERSION),
    );
    expect(runtimeGenerationBearer(OWNER_SECRET, 123, VERSION)).toBe(
      "taxi_app_8c0d855124140ae980249aee084e2d65363937b96c91e80ac19ffeb8d97f8c06",
    );
    expect(runtimeResponseProof(OWNER_SECRET, "b".repeat(43), 123, VERSION, "POST", "/mcp")).toBe(
      "dfb547b916d3eb63369d179da49659b13fe69aa84330a625a5ad080fc0668c2d",
    );
  });

  test("uses a fresh nonce and never sends Authorization on the challenge", async () => {
    const { ownerSecretFile } = makeCredentials();
    const requests = [];
    const url = await listen((request, response) => {
      const requestUrl = new URL(request.url, "http://127.0.0.1");
      const nonce = requestUrl.searchParams.get("nonce");
      requests.push({
        method: request.method,
        path: requestUrl.pathname,
        nonce,
        authorization: request.headers.authorization,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          status: "ok",
          appOwned: true,
          pid: 321,
          version: VERSION,
          proof: runtimeIdentityProof(OWNER_SECRET, nonce, 321, VERSION),
          responseProof: "hmac-sha256-v1",
        }),
      );
    });
    const options = { url, ownerSecretFile, expectedVersion: VERSION, timeoutMs: 1_000 };

    await verifyRuntimeIdentityChallenge(options);
    await verifyRuntimeIdentityChallenge(options);

    expect(requests).toHaveLength(2);
    expect(requests.map(({ method }) => method)).toEqual(["GET", "GET"]);
    expect(requests.map(({ path }) => path)).toEqual(["/app/identity-challenge", "/app/identity-challenge"]);
    expect(requests.every(({ authorization }) => authorization === undefined)).toBe(true);
    expect(requests[0].nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(requests[1].nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(requests[0].nonce).not.toBe(requests[1].nonce);
  });

  test("a bad challenge aborts before any bearer-authenticated request", async () => {
    const { ownerSecretFile } = makeCredentials();
    const requests = [];
    const url = await listen((request, response) => {
      requests.push({ method: request.method, authorization: request.headers.authorization });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          status: "ok",
          appOwned: true,
          pid: 321,
          version: VERSION,
          proof: "0".repeat(64),
          responseProof: "hmac-sha256-v1",
        }),
      );
    });

    await expect(
      probeAppRuntime({
        url,
        ownerSecretFile,
        expectedVersion: VERSION,
        timeoutMs: 1_000,
        minTools: 1,
        clientName: "identity-order-test",
      }),
    ).rejects.toThrow(/proof is invalid/);
    expect(requests).toEqual([{ method: "GET", authorization: undefined }]);
  });

  test("real app-owned boot reads credential files and MACs the MCP channel", async () => {
    const { directory, tokenFile, ownerSecretFile } = makeCredentials();
    const port = await freePort();
    const child = spawn(process.execPath, [DIST, "run", "--http", "--port", String(port)], {
      cwd: ROOT,
      env: {
        ...cleanBootEnv(),
        HOME: directory,
        TAXI_ALLOW_NETWORK: "with-token",
        TAXI_APP_OWNED_RUNTIME: "1",
        TAXI_APP_RUNTIME_TOKEN_PATH: tokenFile,
        TAXI_APP_RUNTIME_OWNER_PATH: ownerSecretFile,
        TAXI_PROFILE: "full",
        TAXI_TOOL_EXPOSURE: "full",
        TAXI_MODULE_PACKS: "all",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.push(child);
    child.stderr.resume();
    await waitForHealth(port, child);

    await expect(
      probeAppRuntime({
        url: `http://127.0.0.1:${port}/mcp`,
        ownerSecretFile,
        expectedVersion: PACKAGE_VERSION,
        timeoutMs: 10_000,
        minTools: FULL_SURFACE_MIN_TOOLS,
        requiredTools: FULL_SURFACE_CANARY_TOOLS,
        clientName: "app-owned-file-credential-test",
      }),
    ).resolves.toContain(`tools from taxi v${PACKAGE_VERSION}`);

    const execEnvironment = execFileSync("/bin/ps", ["eww", "-p", String(child.pid), "-o", "command="], {
      encoding: "utf8",
    });
    expect(execEnvironment).not.toContain(TOKEN);
    expect(execEnvironment).not.toContain(OWNER_SECRET);
    expect(execEnvironment).toContain("TAXI_APP_RUNTIME_TOKEN_PATH=");
    expect(execEnvironment).toContain("TAXI_APP_RUNTIME_OWNER_PATH=");
  }, 60_000);
});
