import { afterAll, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const originalHome = process.env.HOME;
const originalCodexConfigPath = process.env.TAXI_CODEX_CONFIG_PATH;
const testHome = mkdtempSync(join(tmpdir(), "taxi-codex-mcp-"));
process.env.HOME = testHome;
process.env.TAXI_CODEX_CONFIG_PATH = join(testHome, "config.toml");
const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const packageSpecifier = `@heznpc/taxi@${packageVersion}`;

const execFileSync = jest.fn();
const ensureAppRuntimeToken = jest.fn(() => "test-runtime-token");

jest.unstable_mockModule("node:child_process", () => ({
  execFileSync,
}));

jest.unstable_mockModule("../dist/shared/app-runtime-token.js", () => ({
  ensureAppRuntimeToken,
}));

const {
  CODEX_APP_OWNED_URL,
  codexTaxiRuntimeShape,
  codexTaxiRuntimeShapeFromTomlReadOnly,
  codexTaxiRuntimeShapeReadOnly,
  codexConfigTomlHasTaxiHttpToken,
  codexConfigTomlEnabledState,
  codexConfigTomlRuntimeShape,
  codexDirectManualSetupCommand,
  configureCodexTaxi,
  configureCodexTaxiDirect,
  directStdioEntry,
  inspectCodexTaxiRegistration,
  isCodexTaxiConfigured,
  resolveCodexConfigPath,
  setCodexTaxiEnabled,
  stdioProxyEntry,
  updateCodexTaxiEnabledInToml,
} = await import("../dist/cli/codex-mcp.js");

let codexGetOutput;
let codexGetJsonOutput;
let failReplacementAdd;
let failRestorationAdd;
let failRemoveAfterMutation;
let removeCalls;

beforeEach(() => {
  codexGetOutput = null;
  codexGetJsonOutput = {
    name: "taxi",
    enabled: true,
    transport: {
      type: "stdio",
      command: "npx",
      args: ["-y", "taxi@2.12.0"],
      env: null,
      env_vars: [],
      cwd: null,
    },
  };
  failReplacementAdd = false;
  failRestorationAdd = false;
  failRemoveAfterMutation = false;
  removeCalls = 0;
  ensureAppRuntimeToken.mockClear();
  writeFileSync(process.env.TAXI_CODEX_CONFIG_PATH, "");
  execFileSync.mockReset();
  execFileSync.mockImplementation((_command, args) => {
    if (args[0] === "--version") return "codex 0.0.0";
    if (args.join(" ") === "mcp get taxi --json") {
      if (codexGetJsonOutput === null) throw new Error("snapshot missing");
      return JSON.stringify(codexGetJsonOutput);
    }
    if (args.join(" ") === "mcp get taxi") {
      if (codexGetOutput === null) throw new Error("missing");
      return codexGetOutput;
    }
    if (args.join(" ") === "mcp remove taxi") {
      removeCalls += 1;
      if (failRemoveAfterMutation && removeCalls === 1) {
        writeFileSync(process.env.TAXI_CODEX_CONFIG_PATH, '[mcp_servers.taxi]\ncommand = "partial-remove"\n');
        throw new Error("remove failed after mutation");
      }
    }
    if (args[0] === "mcp" && args[1] === "add") {
      const isReplacement = args.includes(packageSpecifier);
      if (isReplacement && failReplacementAdd) {
        writeFileSync(process.env.TAXI_CODEX_CONFIG_PATH, '[mcp_servers.taxi]\ncommand = "partial"\n');
        throw new Error("replacement add failed");
      }
      if (!isReplacement && failRestorationAdd) throw new Error("restoration add failed");
    }
    return "";
  });
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalCodexConfigPath === undefined) delete process.env.TAXI_CODEX_CONFIG_PATH;
  else process.env.TAXI_CODEX_CONFIG_PATH = originalCodexConfigPath;
  rmSync(testHome, { recursive: true, force: true });
});

describe("codex MCP setup", () => {
  test("resolves the user config with explicit path, CODEX_HOME, then HOME precedence", () => {
    expect(
      resolveCodexConfigPath({
        TAXI_CODEX_CONFIG_PATH: "/explicit/config.toml",
        CODEX_HOME: "/custom/codex",
        HOME: "/user/home",
      }),
    ).toBe("/explicit/config.toml");
    expect(resolveCodexConfigPath({ CODEX_HOME: "/custom/codex", HOME: "/user/home" })).toBe(
      "/custom/codex/config.toml",
    );
    expect(resolveCodexConfigPath({ HOME: "/user/home" })).toBe("/user/home/.codex/config.toml");
  });

  test("canonicalizes relative config roots before deriving the child Codex home", () => {
    expect(resolveCodexConfigPath({ TAXI_CODEX_CONFIG_PATH: "relative-codex/config.toml" })).toBe(
      resolve("relative-codex/config.toml"),
    );
    expect(resolveCodexConfigPath({ CODEX_HOME: "relative-codex-home" })).toBe(
      resolve("relative-codex-home/config.toml"),
    );
  });

  test("rejects an explicit filename that child Codex cannot address", () => {
    expect(() => resolveCodexConfigPath({ TAXI_CODEX_CONFIG_PATH: "/isolated/custom-codex.toml" })).toThrow(
      "TAXI_CODEX_CONFIG_PATH must name config.toml",
    );
  });

  test("captures one config directory for every child Codex call", () => {
    codexGetOutput = [
      "taxi",
      "  enabled: true",
      "  transport: stdio",
      "  command: npx",
      `  args: -y ${packageSpecifier} run`,
    ].join("\n");

    const selectedPath = process.env.TAXI_CODEX_CONFIG_PATH;
    process.env.TAXI_CODEX_CONFIG_PATH = join(testHome, "later-environment", "config.toml");
    try {
      expect(isCodexTaxiConfigured()).toBe(true);
      expect(execFileSync).toHaveBeenCalledWith(
        "codex",
        ["mcp", "get", "taxi"],
        expect.objectContaining({ env: expect.objectContaining({ CODEX_HOME: testHome }) }),
      );
    } finally {
      process.env.TAXI_CODEX_CONFIG_PATH = selectedPath;
    }
  });

  test("classifies stale direct stdio config separately from app-owned runtime", () => {
    codexGetOutput = ["taxi", "  enabled: true", "  transport: stdio", "  command: npx", "  args: -y taxi@2.12.0"].join(
      "\n",
    );

    expect(isCodexTaxiConfigured()).toBe(true);
    expect(codexTaxiRuntimeShape()).toBe("unknown");
  });

  test("classifies only the exact current direct package specifier", () => {
    codexGetOutput = [
      "taxi",
      "  enabled: true",
      "  transport: stdio",
      "  command: npx",
      `  args: -y ${packageSpecifier} run`,
    ].join("\n");

    expect(codexTaxiRuntimeShape()).toBe("direct");
  });

  test("rejects stale package specifiers in config.toml for direct and app-owned shapes", () => {
    expect(
      codexConfigTomlRuntimeShape(["[mcp_servers.taxi]", 'command = "npx"', 'args = ["-y", "taxi@2.12.0"]'].join("\n")),
    ).toBe("unknown");
    expect(
      codexConfigTomlRuntimeShape(
        [
          "[mcp_servers.taxi]",
          'command = "npx"',
          `args = ["-y", "taxi@2.12.0", "connect", "--url", "${CODEX_APP_OWNED_URL}"]`,
          "",
          "[mcp_servers.taxi.env]",
          'TAXI_HTTP_TOKEN = "token"',
        ].join("\n"),
      ),
    ).toBe("unknown");
  });

  test("keeps external wrappers unknown while allowing persistent enable toggles", () => {
    codexGetOutput = [
      "taxi",
      "  enabled: false",
      "  transport: stdio",
      "  command: /Users/test/.codex/bin/taxi-connect.sh",
      "  args:",
    ].join("\n");
    writeFileSync(
      process.env.TAXI_CODEX_CONFIG_PATH,
      ["[mcp_servers.taxi]", "enabled = false", 'command = "/Users/test/.codex/bin/taxi-connect.sh"', ""].join("\n"),
    );

    expect(codexTaxiRuntimeShape()).toBe("unknown");
    expect(setCodexTaxiEnabled(true)).toEqual(expect.objectContaining({ globalState: "enabled", changed: true }));
  });

  test("does not classify a bare HTTP URL as the recommended token-gated shape", () => {
    codexGetOutput = ["taxi", "  enabled: true", "  transport: streamable-http", `  url: ${CODEX_APP_OWNED_URL}`].join(
      "\n",
    );

    expect(codexTaxiRuntimeShape()).toBe("unknown");
  });

  test("classifies the token-gated proxy config as the recommended shape", () => {
    codexGetOutput = [
      "taxi",
      "  enabled: true",
      "  transport: stdio",
      "  command: npx",
      `  args: -y ${packageSpecifier} connect --url http://127.0.0.1:3848/mcp`,
      "  env: TAXI_HTTP_TOKEN=********",
    ].join("\n");

    expect(codexTaxiRuntimeShape()).toBe("app-owned");
  });

  test("surfaces a disabled app-owned entry instead of reporting it as connected", () => {
    codexGetOutput = [
      "taxi",
      "  enabled: false",
      "  transport: stdio",
      "  command: npx",
      `  args: -y ${packageSpecifier} connect --url http://127.0.0.1:3848/mcp`,
      "  env: TAXI_HTTP_TOKEN=********",
    ].join("\n");

    expect(codexTaxiRuntimeShape()).toBe("app-owned-disabled");
  });

  test("classifies config.toml app-owned entries as pending restart when CLI output is stale", () => {
    codexGetOutput = ["taxi", "  enabled: true", "  transport: stdio", "  command: npx", "  args: -y taxi@2.12.0"].join(
      "\n",
    );
    writeFileSync(
      process.env.TAXI_CODEX_CONFIG_PATH,
      [
        "[mcp_servers.taxi]",
        'command = "npx"',
        `args = ["-y", "${packageSpecifier}", "connect", "--url", "${CODEX_APP_OWNED_URL}"]`,
        "",
        "[mcp_servers.taxi.env]",
        'TAXI_HTTP_TOKEN = "test-runtime-token"',
        "",
      ].join("\n"),
    );

    expect(codexTaxiRuntimeShape()).toBe("app-owned-pending-restart");
  });

  test("treats a config.toml carrying a stale token as not-app-owned so it gets repaired", () => {
    // CLI output is stale-direct; config.toml has the app-owned proxy shape but
    // a token that no longer matches the live runtime token. The runtime path
    // must NOT report app-owned (which would suppress repair).
    codexGetOutput = ["taxi", "  transport: stdio", "  command: npx", "  args: -y taxi@2.12.0"].join("\n");
    writeFileSync(
      process.env.TAXI_CODEX_CONFIG_PATH,
      [
        "[mcp_servers.taxi]",
        'command = "npx"',
        `args = ["-y", "${packageSpecifier}", "connect", "--url", "${CODEX_APP_OWNED_URL}"]`,
        "",
        "[mcp_servers.taxi.env]",
        'TAXI_HTTP_TOKEN = "stale-old-token"',
        "",
      ].join("\n"),
    );

    expect(codexTaxiRuntimeShape()).toBe("app-owned-stale");
  });

  test("does not let redacted Codex CLI output hide a stale persisted token", () => {
    codexGetOutput = [
      "taxi",
      "  enabled: true",
      "  transport: stdio",
      "  command: npx",
      `  args: -y ${packageSpecifier} connect --url ${CODEX_APP_OWNED_URL}`,
      "  env: TAXI_HTTP_TOKEN=********",
    ].join("\n");
    writeFileSync(
      process.env.TAXI_CODEX_CONFIG_PATH,
      [
        "[mcp_servers.taxi]",
        'command = "npx"',
        `args = ["-y", "${packageSpecifier}", "connect", "--url", "${CODEX_APP_OWNED_URL}"]`,
        "",
        "[mcp_servers.taxi.env]",
        'TAXI_HTTP_TOKEN = "stale-old-token"',
        "",
      ].join("\n"),
    );

    expect(codexTaxiRuntimeShape()).toBe("app-owned-stale");
  });

  test("read-only shape detection never creates or repairs a missing live token", () => {
    codexGetOutput = [
      "taxi",
      "  enabled: true",
      "  transport: stdio",
      "  command: npx",
      `  args: -y ${packageSpecifier} connect --url ${CODEX_APP_OWNED_URL}`,
      "  env: TAXI_HTTP_TOKEN=********",
    ].join("\n");
    const content = [
      "[mcp_servers.taxi]",
      'command = "npx"',
      `args = ["-y", "${packageSpecifier}", "connect", "--url", "${CODEX_APP_OWNED_URL}"]`,
      "",
      "[mcp_servers.taxi.env]",
      'TAXI_HTTP_TOKEN = "configured-token"',
      "",
    ].join("\n");
    writeFileSync(process.env.TAXI_CODEX_CONFIG_PATH, content, { mode: 0o640 });
    chmodSync(process.env.TAXI_CODEX_CONFIG_PATH, 0o640);

    execFileSync.mockClear();
    expect(codexTaxiRuntimeShapeReadOnly()).toBe("unknown");
    expect(execFileSync).not.toHaveBeenCalled();
    expect(ensureAppRuntimeToken).not.toHaveBeenCalled();
    expect(readFileSync(process.env.TAXI_CODEX_CONFIG_PATH, "utf8")).toBe(content);
    expect(statSync(process.env.TAXI_CODEX_CONFIG_PATH).mode & 0o777).toBe(0o640);

    expect(codexTaxiRuntimeShapeReadOnly("configured-token")).toBe("app-owned");
    expect(codexTaxiRuntimeShapeReadOnly("different-live-token")).toBe("app-owned-stale");
    expect(codexTaxiRuntimeShapeFromTomlReadOnly(content, "configured-token")).toBe("app-owned");
    expect(codexTaxiRuntimeShapeFromTomlReadOnly(content, "different-live-token")).toBe("app-owned-stale");
    expect(execFileSync).not.toHaveBeenCalled();
    expect(ensureAppRuntimeToken).not.toHaveBeenCalled();
  });

  test("detects the inline-table env form of the app-owned proxy", () => {
    expect(
      codexConfigTomlRuntimeShape(
        [
          "[mcp_servers.taxi]",
          'command = "npx"',
          `args = ["-y", "${packageSpecifier}", "connect", "--url", "${CODEX_APP_OWNED_URL}"]`,
          'env = { TAXI_HTTP_TOKEN = "token" }',
        ].join("\n"),
      ),
    ).toBe("app-owned");
  });

  test("detects a Taxi bearer for file-permission diagnosis even when the invocation shape is invalid", () => {
    expect(
      codexConfigTomlHasTaxiHttpToken(
        [
          "[mcp_servers.taxi]",
          'command = "unexpected-wrapper"',
          "",
          "[mcp_servers.taxi.env]",
          'TAXI_HTTP_TOKEN = "sensitive-token"',
        ].join("\n"),
      ),
    ).toBe(true);
  });

  test("compares the inline-table token value against the live token", () => {
    const toml = [
      "[mcp_servers.taxi]",
      'command = "npx"',
      `args = ["-y", "${packageSpecifier}", "connect", "--url", "${CODEX_APP_OWNED_URL}"]`,
      'env = { TAXI_HTTP_TOKEN = "live-token" }',
    ].join("\n");
    expect(codexConfigTomlRuntimeShape(toml, "live-token")).toBe("app-owned");
    expect(codexConfigTomlRuntimeShape(toml, "different-token")).toBe("app-owned-stale");
  });

  test("parses Codex config.toml app-owned proxy shape", () => {
    expect(
      codexConfigTomlRuntimeShape(
        [
          "[mcp_servers.taxi]",
          'command = "npx"',
          `args = ["-y", "${packageSpecifier}", "connect", "--url", "${CODEX_APP_OWNED_URL}"]`,
          "",
          "[mcp_servers.taxi.env]",
          'TAXI_HTTP_TOKEN = "token"',
        ].join("\n"),
      ),
    ).toBe("app-owned");
  });

  test("parses the deterministic Taxi.app bundled proxy shape", () => {
    const appPath = "/Applications/Taxi.app";
    const command = `${appPath}/Contents/Resources/taxi/runtime/bin/node`;
    const serverEntry = `${appPath}/Contents/Resources/taxi/server/dist/index.js`;
    expect(
      codexConfigTomlRuntimeShape(
        [
          "[mcp_servers.taxi]",
          `command = "${command}"`,
          `args = ["${serverEntry}", "connect", "--url", "${CODEX_APP_OWNED_URL}"]`,
          "",
          "[mcp_servers.taxi.env]",
          'TAXI_HTTP_TOKEN = "token"',
        ].join("\n"),
        "token",
      ),
    ).toBe("app-owned");

    codexGetOutput = [
      "taxi",
      "  enabled: true",
      "  transport: stdio",
      `  command: ${command}`,
      `  args: ${serverEntry} connect --url ${CODEX_APP_OWNED_URL}`,
      "  env: TAXI_HTTP_TOKEN=********",
    ].join("\n");
    expect(codexTaxiRuntimeShape()).toBe("app-owned");
  });

  test("parses disabled config.toml runtime shapes explicitly", () => {
    expect(
      codexConfigTomlRuntimeShape(
        [
          "[mcp_servers.taxi]",
          "enabled = false",
          'command = "npx"',
          `args = ["-y", "${packageSpecifier}", "connect", "--url", "${CODEX_APP_OWNED_URL}"]`,
          "",
          "[mcp_servers.taxi.env]",
          'TAXI_HTTP_TOKEN = "token"',
        ].join("\n"),
      ),
    ).toBe("app-owned-disabled");
  });

  test("toggles only the Taxi enabled key and preserves the rest of config.toml", () => {
    const original = [
      'model = "gpt-5"',
      "",
      "[mcp_servers.taxi] # managed entry",
      'command = "npx"',
      'args = ["-y", "taxi"]',
      "",
      "[mcp_servers.taxi.env]",
      'TAXI_HTTP_TOKEN = "keep-this-token"',
      "",
      '[projects."/tmp/example"]',
      'trust_level = "trusted"',
      "",
    ].join("\r\n");

    const disabled = updateCodexTaxiEnabledInToml(original, false);
    expect(disabled.found).toBe(true);
    expect(disabled.changed).toBe(true);
    expect(codexConfigTomlEnabledState(disabled.toml)).toBe("disabled");
    expect(disabled.toml).toBe(
      original.replace(
        "[mcp_servers.taxi] # managed entry\r\n",
        "[mcp_servers.taxi] # managed entry\r\nenabled = false\r\n",
      ),
    );

    const enabled = updateCodexTaxiEnabledInToml(disabled.toml, true);
    expect(enabled.toml).toBe(disabled.toml.replace("enabled = false", "enabled = true"));
    expect(codexConfigTomlEnabledState(enabled.toml)).toBe("enabled");
  });

  test("rejects malformed enabled values without rewriting the file", () => {
    const malformed = ["[mcp_servers.taxi]", 'enabled = "sometimes"', 'command = "npx"'].join("\n");
    expect(codexConfigTomlEnabledState(malformed)).toBe("invalid");
    expect(() => updateCodexTaxiEnabledInToml(malformed, false)).toThrow("invalid or duplicate");
  });

  test("atomically disables the global entry and reports a project override without editing it", () => {
    const project = join(testHome, "project");
    const projectConfig = join(project, ".codex", "config.toml");
    const globalConfig = process.env.TAXI_CODEX_CONFIG_PATH;
    mkdirSync(join(project, ".codex"), { recursive: true });
    writeFileSync(globalConfig, ['model = "gpt-5"', "[mcp_servers.taxi]", 'command = "npx"', ""].join("\n"));
    writeFileSync(projectConfig, ["[mcp_servers.taxi]", "enabled = true", 'command = "npx"', ""].join("\n"));
    const projectBefore = readFileSync(projectConfig, "utf8");

    const result = setCodexTaxiEnabled(false, { projectDirectory: project });

    expect(result).toEqual(
      expect.objectContaining({
        globalState: "disabled",
        changed: true,
        projectOverride: { path: projectConfig, state: "enabled" },
      }),
    );
    expect(readFileSync(globalConfig, "utf8")).toContain("enabled = false");
    expect(readFileSync(globalConfig, "utf8")).toContain('model = "gpt-5"');
    expect(readFileSync(projectConfig, "utf8")).toBe(projectBefore);
    expect(inspectCodexTaxiRegistration({ projectDirectory: project }).projectOverride).toEqual({
      path: projectConfig,
      state: "enabled",
    });
  });

  test("replaces an existing Codex entry with the token-gated app-owned proxy", () => {
    codexGetOutput = "taxi\n  transport: stdio\n  command: npx\n  args: -y taxi";

    expect(configureCodexTaxi()).toBe("configured");
    expect(execFileSync).toHaveBeenCalledWith(
      "codex",
      ["mcp", "remove", "taxi"],
      expect.objectContaining({ encoding: "utf8" }),
    );
    expect(execFileSync).toHaveBeenCalledWith(
      "codex",
      [
        "mcp",
        "add",
        "--env",
        "TAXI_HTTP_TOKEN=test-runtime-token",
        "taxi",
        "--",
        "npx",
        "-y",
        packageSpecifier,
        "connect",
        "--url",
        CODEX_APP_OWNED_URL,
      ],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  test("restores the complete previous stdio config bytes and mode when replacement add fails", () => {
    const configPath = process.env.TAXI_CODEX_CONFIG_PATH;
    const original = [
      'model = "gpt-5"',
      "",
      "[mcp_servers.taxi]",
      "enabled = false",
      'command = "node"',
      'args = ["old-server.js"]',
      'cwd = "/tmp/old"',
      "startup_timeout_sec = 17",
      'enabled_tools = ["safe_tool"]',
      "",
      "[mcp_servers.taxi.env]",
      'KEEP = "value"',
      "",
      "[mcp_servers.other]",
      'command = "keep-me"',
      "",
    ].join("\n");
    writeFileSync(configPath, original);
    chmodSync(configPath, 0o600);
    codexGetOutput = "taxi\n  enabled: false\n  transport: stdio\n  command: node\n  args: old-server.js";
    codexGetJsonOutput = {
      name: "taxi",
      enabled: false,
      transport: {
        type: "stdio",
        command: "node",
        args: ["old-server.js"],
        env: { KEEP: "value" },
        env_vars: [],
        cwd: "/tmp/old",
      },
      startup_timeout_sec: 17,
      enabled_tools: ["safe_tool"],
    };
    failReplacementAdd = true;

    expect(() => configureCodexTaxi()).toThrow("previous stdio entry was restored");

    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(execFileSync).toHaveBeenCalledWith(
      "codex",
      ["mcp", "get", "taxi", "--json"],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  test("restores the complete previous HTTP config when replacement add fails", () => {
    const configPath = process.env.TAXI_CODEX_CONFIG_PATH;
    const original = [
      "[mcp_servers.taxi]",
      'url = "https://old.example.test/mcp"',
      'bearer_token_env_var = "OLD_TOKEN"',
      "tool_timeout_sec = 23",
      'http_headers = { "X-Safe" = "keep" }',
      "",
    ].join("\n");
    writeFileSync(configPath, original);
    codexGetOutput = [
      "taxi",
      "  enabled: true",
      "  transport: streamable-http",
      "  url: https://old.example.test/mcp",
    ].join("\n");
    codexGetJsonOutput = {
      name: "taxi",
      enabled: true,
      transport: {
        type: "streamable_http",
        url: "https://old.example.test/mcp",
        bearer_token_env_var: "OLD_TOKEN",
        http_headers: { "X-Safe": "keep" },
        env_http_headers: null,
      },
      tool_timeout_sec: 23,
    };
    failReplacementAdd = true;

    expect(() => configureCodexTaxi()).toThrow("previous streamable_http entry was restored");
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("restores the complete config when remove mutates and then fails", () => {
    const configPath = process.env.TAXI_CODEX_CONFIG_PATH;
    const original = ['model = "gpt-5"', "[mcp_servers.taxi]", 'command = "node"', 'args = ["old-server.js"]', ""].join(
      "\n",
    );
    writeFileSync(configPath, original);
    codexGetOutput = "taxi\n  transport: stdio\n  command: node\n  args: old-server.js";
    codexGetJsonOutput = {
      name: "taxi",
      enabled: true,
      transport: { type: "stdio", command: "node", args: ["old-server.js"], env: null },
    };
    failRemoveAfterMutation = true;

    expect(() => configureCodexTaxi()).toThrow("previous stdio entry was restored");
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(removeCalls).toBe(1);
  });

  test("reports replacement and restoration failure when no file snapshot is available", () => {
    codexGetOutput = "taxi\n  transport: stdio\n  command: node\n  args: old-server.js";
    codexGetJsonOutput = {
      name: "taxi",
      enabled: true,
      transport: { type: "stdio", command: "node", args: ["old-server.js"], env: null },
    };
    rmSync(process.env.TAXI_CODEX_CONFIG_PATH, { force: true });
    failReplacementAdd = true;
    failRestorationAdd = true;

    expect(() => configureCodexTaxi()).toThrow("failed to restore the previous stdio entry");
  });

  test("explicitly disables and re-enables an existing app-owned entry without remove/add", () => {
    const configPath = process.env.TAXI_CODEX_CONFIG_PATH;
    codexGetOutput = [
      "taxi",
      "  enabled: false",
      "  transport: stdio",
      "  command: npx",
      `  args: -y ${packageSpecifier} connect --url http://127.0.0.1:3848/mcp`,
      "  env: TAXI_HTTP_TOKEN=********",
    ].join("\n");
    writeFileSync(
      configPath,
      [
        "[mcp_servers.taxi]",
        "enabled = false",
        'command = "npx"',
        `args = ["-y", "${packageSpecifier}", "connect", "--url", "${CODEX_APP_OWNED_URL}"]`,
        "",
        "[mcp_servers.taxi.env]",
        'TAXI_HTTP_TOKEN = "test-runtime-token"',
        "",
      ].join("\n"),
    );
    // Simulate a config file left at a permissive default (e.g. by the
    // codex CLI's own umask-based write) to prove the token-bearing
    // rewrite locks it down rather than merely preserving the prior mode.
    chmodSync(configPath, 0o644);

    expect(configureCodexTaxi()).toBe("configured");
    expect(readFileSync(configPath, "utf8")).toContain("enabled = true");
    expect(execFileSync).not.toHaveBeenCalledWith("codex", ["mcp", "remove", "taxi"], expect.anything());
    expect(statSync(configPath).mode & 0o777).toBe(0o600);

    codexGetOutput = codexGetOutput.replace("enabled: false", "enabled: true");
    expect(configureCodexTaxi({ enabled: false })).toBe("configured");
    expect(readFileSync(configPath, "utf8")).toContain("enabled = false");
    expect(execFileSync).not.toHaveBeenCalledWith("codex", ["mcp", "add", "taxi"], expect.anything());
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  test("stdio clients use a token-gated proxy command rather than launching another server", () => {
    expect(stdioProxyEntry("test-token")).toEqual({
      command: "npx",
      args: ["-y", packageSpecifier, "connect", "--url", CODEX_APP_OWNED_URL],
      env: { TAXI_HTTP_TOKEN: "test-token" },
    });
  });

  test("direct stdio entries intentionally launch the version-pinned server", () => {
    expect(directStdioEntry()).toEqual({
      command: "npx",
      args: ["-y", packageSpecifier, "run"],
    });
    expect(codexDirectManualSetupCommand()).toBe(`codex mcp add taxi -- npx -y ${packageSpecifier} run`);
  });

  test("can configure Codex for direct stdio runtime", () => {
    codexGetOutput = "taxi\ntransport: http\ncommand: node";
    expect(configureCodexTaxiDirect()).toBe("configured");
    expect(execFileSync).toHaveBeenCalledWith(
      "codex",
      ["mcp", "remove", "taxi"],
      expect.objectContaining({ encoding: "utf8" }),
    );
    expect(execFileSync).toHaveBeenCalledWith(
      "codex",
      ["mcp", "add", "taxi", "--", "npx", "-y", packageSpecifier, "run"],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });
});
