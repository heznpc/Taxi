import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const originalHome = process.env.HOME;
const tempHomes = [];
const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const packageSpecifier = `@heznpc/taxi@${packageVersion}`;

async function loadClientConfig(home) {
  process.env.HOME = home;
  delete process.env.TAXI_NPM_PACKAGE_SPECIFIER;
  jest.resetModules();
  return import("../dist/cli/client-config.js");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

beforeEach(() => {
  jest.resetModules();
});

afterEach(() => {
  process.env.HOME = originalHome;
  delete process.env.TAXI_NPM_PACKAGE_SPECIFIER;
  jest.resetModules();
  for (const home of tempHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("client config repair", () => {
  test("migrates an installed stdio client to the token-gated Taxi.app proxy and backs up the old config", async () => {
    const home = mkdtempSync(join(tmpdir(), "taxi-client-config-"));
    tempHomes.push(home);
    const { CODEX_APP_OWNED_URL } = await import("../dist/cli/codex-mcp.js");
    const { configureMcpClients } = await loadClientConfig(home);
    const configPath = join(home, "Client", "mcp.json");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            keep: { command: "node", args: ["server.js"] },
            taxi: { command: "npx", args: ["-y", "taxi@2.12.0"] },
          },
        },
        null,
        2,
      ) + "\n",
    );

    const results = configureMcpClients({
      clients: [{ name: "Test Client", configPath, serversKey: "mcpServers" }],
      configureCodex: false,
      now: () => 123,
      token: "test-token",
    });

    expect(results).toEqual([
      {
        name: "Test Client",
        status: "configured",
        detail: "token-gated Taxi.app runtime",
        configPath,
      },
    ]);
    expect(readFileSync(`${configPath}.bak.123`, "utf8")).toContain("taxi@2.12.0");
    const updated = readJson(configPath);
    expect(updated.mcpServers.keep).toEqual({ command: "node", args: ["server.js"] });
    expect(updated.mcpServers.taxi).toEqual({
      command: "npx",
      args: ["-y", packageSpecifier, "connect", "--url", CODEX_APP_OWNED_URL],
      env: { TAXI_HTTP_TOKEN: "test-token" },
    });
  });

  test("writes the token-bearing client config and its backup owner-only (0600)", async () => {
    const home = mkdtempSync(join(tmpdir(), "taxi-client-config-"));
    tempHomes.push(home);
    const { configureMcpClients } = await loadClientConfig(home);
    const configPath = join(home, "Client", "mcp.json");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { taxi: { command: "npx", args: ["-y", "taxi@2.12.0"] } } }, null, 2) + "\n",
    );
    chmodSync(configPath, 0o644); // start world-readable to prove the fix tightens it

    configureMcpClients({
      clients: [{ name: "Test Client", configPath, serversKey: "mcpServers" }],
      configureCodex: false,
      now: () => 123,
      token: "test-token",
    });

    // The embedded TAXI_HTTP_TOKEN must not be left world-readable.
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(statSync(`${configPath}.bak.123`).mode & 0o777).toBe(0o600);
    expect(readJson(configPath).mcpServers.taxi.env.TAXI_HTTP_TOKEN).toBe("test-token");
  });

  test("direct runtime (no embedded token) does not force 0600 on the client config", async () => {
    const home = mkdtempSync(join(tmpdir(), "taxi-client-config-"));
    tempHomes.push(home);
    const { configureMcpClients } = await loadClientConfig(home);
    const configPath = join(home, "Client", "mcp.json");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }, null, 2) + "\n");
    chmodSync(configPath, 0o644);

    configureMcpClients({
      clients: [{ name: "Test Client", configPath, serversKey: "mcpServers" }],
      configureCodex: false,
      now: () => 123,
      runtimeMode: "direct",
    });

    expect(statSync(configPath).mode & 0o777).toBe(0o644);
  });

  test("dry-run reports changes without writing a token, backup, or config mutation", async () => {
    const home = mkdtempSync(join(tmpdir(), "taxi-client-config-"));
    tempHomes.push(home);
    const { configureMcpClients } = await loadClientConfig(home);
    const configPath = join(home, "Client", "mcp.json");
    mkdirSync(dirname(configPath), { recursive: true });
    const original = JSON.stringify({ mcpServers: { taxi: { command: "npx", args: ["-y", "taxi"] } } }, null, 2);
    writeFileSync(configPath, `${original}\n`);

    const results = configureMcpClients({
      clients: [{ name: "Test Client", configPath, serversKey: "mcpServers" }],
      configureCodex: false,
      dryRun: true,
    });

    expect(results[0].status).toBe("would-configure");
    expect(readFileSync(configPath, "utf8")).toBe(`${original}\n`);
    expect(() => statSync(`${configPath}.bak.123`)).toThrow();
    expect(() => statSync(join(home, "Library", "Application Support", "Taxi", "http-token"))).toThrow();
  });

  test("does not rewrite a client that already has the exact app-owned proxy entry", async () => {
    const home = mkdtempSync(join(tmpdir(), "taxi-client-config-"));
    tempHomes.push(home);
    const { stdioProxyEntry } = await import("../dist/cli/codex-mcp.js");
    const { configureMcpClients } = await loadClientConfig(home);
    const configPath = join(home, "Client", "mcp.json");
    mkdirSync(dirname(configPath), { recursive: true });
    const existing = { mcpServers: { taxi: stdioProxyEntry("existing-token") } };
    writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n");

    const results = configureMcpClients({
      clients: [{ name: "Test Client", configPath, serversKey: "mcpServers" }],
      configureCodex: false,
      token: "existing-token",
    });

    expect(results[0].status).toBe("already-configured");
    expect(readJson(configPath)).toEqual(existing);
  });

  test("preserves an available Taxi.app bundled proxy in dry-run and apply modes", async () => {
    const home = mkdtempSync(join(tmpdir(), "taxi-client-config-"));
    tempHomes.push(home);
    const { CODEX_APP_OWNED_URL } = await import("../dist/cli/codex-mcp.js");
    const { configureMcpClients } = await loadClientConfig(home);
    const configPath = join(home, "Client", "mcp.json");
    const appPath = join(home, "Applications", "Taxi.app");
    const command = join(appPath, "Contents", "Resources", "taxi", "runtime", "bin", "node");
    const serverEntry = join(appPath, "Contents", "Resources", "taxi", "server", "dist", "index.js");
    mkdirSync(dirname(command), { recursive: true });
    mkdirSync(dirname(serverEntry), { recursive: true });
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(command, "node");
    writeFileSync(serverEntry, "server");
    const existing = {
      mcpServers: {
        taxi: {
          command,
          args: [serverEntry, "connect", "--url", CODEX_APP_OWNED_URL],
          env: { TAXI_HTTP_TOKEN: "existing-token" },
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n");
    const client = { name: "Test Client", configPath, serversKey: "mcpServers" };

    expect(
      configureMcpClients({
        clients: [client],
        configureCodex: false,
        dryRun: true,
      })[0].status,
    ).toBe("already-configured");
    expect(
      configureMcpClients({
        clients: [client],
        configureCodex: false,
        token: "existing-token",
        now: () => 789,
      })[0].status,
    ).toBe("already-configured");
    expect(readJson(configPath)).toEqual(existing);
    expect(() => statSync(`${configPath}.bak.789`)).toThrow();
  });

  test("repairs a bundled proxy token without replacing its deterministic app paths", async () => {
    const home = mkdtempSync(join(tmpdir(), "taxi-client-config-"));
    tempHomes.push(home);
    const { CODEX_APP_OWNED_URL } = await import("../dist/cli/codex-mcp.js");
    const { configureMcpClients } = await loadClientConfig(home);
    const configPath = join(home, "Client", "mcp.json");
    const appPath = join(home, "Applications", "Taxi.app");
    const command = join(appPath, "Contents", "Resources", "taxi", "runtime", "bin", "node");
    const serverEntry = join(appPath, "Contents", "Resources", "taxi", "server", "dist", "index.js");
    mkdirSync(dirname(command), { recursive: true });
    mkdirSync(dirname(serverEntry), { recursive: true });
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(command, "node");
    writeFileSync(serverEntry, "server");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          taxi: {
            command,
            args: [serverEntry, "connect", "--url", CODEX_APP_OWNED_URL],
            env: { TAXI_HTTP_TOKEN: "stale-token" },
          },
        },
      }),
    );

    configureMcpClients({
      clients: [{ name: "Test Client", configPath, serversKey: "mcpServers" }],
      configureCodex: false,
      token: "fresh-token",
      now: () => 790,
    });

    expect(readJson(configPath).mcpServers.taxi).toEqual({
      command,
      args: [serverEntry, "connect", "--url", CODEX_APP_OWNED_URL],
      env: { TAXI_HTTP_TOKEN: "fresh-token" },
    });
  });

  test("can intentionally write a direct stdio client entry instead of the app-owned proxy", async () => {
    const home = mkdtempSync(join(tmpdir(), "taxi-client-config-"));
    tempHomes.push(home);
    const { configureMcpClients } = await loadClientConfig(home);
    const configPath = join(home, "Client", "mcp.json");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { taxi: { command: "npx", args: ["-y", "taxi@2.12.0"] } } }, null, 2) + "\n",
    );

    const results = configureMcpClients({
      clients: [{ name: "Test Client", configPath, serversKey: "mcpServers" }],
      configureCodex: false,
      runtimeMode: "direct",
      now: () => 456,
    });

    expect(results).toEqual([
      {
        name: "Test Client",
        status: "configured",
        detail: "direct stdio runtime",
        configPath,
      },
    ]);
    expect(readFileSync(`${configPath}.bak.456`, "utf8")).toContain("taxi@2.12.0");
    expect(readJson(configPath).mcpServers.taxi).toEqual({
      command: "npx",
      args: ["-y", packageSpecifier, "run"],
    });
  });

  test("surfaces parse errors without clobbering the existing client config", async () => {
    const home = mkdtempSync(join(tmpdir(), "taxi-client-config-"));
    tempHomes.push(home);
    const { configureMcpClients } = await loadClientConfig(home);
    const configPath = join(home, "Client", "mcp.json");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, "{ nope\n");

    const results = configureMcpClients({
      clients: [{ name: "Test Client", configPath, serversKey: "mcpServers" }],
      configureCodex: false,
    });

    expect(results[0].status).toBe("failed");
    expect(results[0].detail).toMatch(/JSON/);
    expect(readFileSync(configPath, "utf8")).toBe("{ nope\n");
  });

  test("supports dry-run Codex repair without shelling out to the real codex CLI", async () => {
    const home = mkdtempSync(join(tmpdir(), "taxi-client-config-"));
    tempHomes.push(home);
    const { configureMcpClients } = await loadClientConfig(home);
    const configure = jest.fn();

    const results = configureMcpClients({
      clients: [],
      dryRun: true,
      codex: {
        isAvailable: () => true,
        shape: () => "direct",
        configure,
      },
    });

    expect(results).toEqual([
      { name: "Codex", status: "would-configure", detail: "would replace existing taxi MCP server" },
    ]);
    expect(configure).not.toHaveBeenCalled();
  });

  test("explicit Codex connection re-enables a matching disabled entry", async () => {
    const home = mkdtempSync(join(tmpdir(), "taxi-client-config-"));
    tempHomes.push(home);
    const { configureMcpClients } = await loadClientConfig(home);
    const configure = jest.fn(() => "configured");

    const results = configureMcpClients({
      clients: [],
      codex: {
        isAvailable: () => true,
        shape: () => "app-owned-disabled",
        configure,
      },
    });

    expect(results).toEqual([{ name: "Codex", status: "configured", detail: "token-gated Taxi.app runtime" }]);
    expect(configure).toHaveBeenCalledTimes(1);
  });

  test("supports dry-run Codex direct runtime repair without shelling out", async () => {
    const home = mkdtempSync(join(tmpdir(), "taxi-client-config-"));
    tempHomes.push(home);
    const { configureMcpClients } = await loadClientConfig(home);
    const configure = jest.fn();
    const configureDirect = jest.fn();

    const results = configureMcpClients({
      clients: [],
      dryRun: true,
      runtimeMode: "direct",
      codex: {
        isAvailable: () => true,
        shape: () => "app-owned",
        configure,
        configureDirect,
      },
    });

    expect(results).toEqual([
      { name: "Codex", status: "would-configure", detail: "would replace existing taxi MCP server" },
    ]);
    expect(configure).not.toHaveBeenCalled();
    expect(configureDirect).not.toHaveBeenCalled();
  });

  test("honors TAXI_NPM_PACKAGE_SPECIFIER for local development client wiring", async () => {
    const home = mkdtempSync(join(tmpdir(), "taxi-client-config-"));
    tempHomes.push(home);
    process.env.HOME = home;
    process.env.TAXI_NPM_PACKAGE_SPECIFIER = "/Users/test/Projects/Taxi";
    jest.resetModules();
    const { configureMcpClients } = await import("../dist/cli/client-config.js");
    const configPath = join(home, "Client", "mcp.json");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }, null, 2) + "\n");

    configureMcpClients({
      clients: [{ name: "Test Client", configPath, serversKey: "mcpServers" }],
      configureCodex: false,
      token: "test-token",
    });

    expect(readJson(configPath).mcpServers.taxi.args[1]).toBe("/Users/test/Projects/Taxi");
  });
});
