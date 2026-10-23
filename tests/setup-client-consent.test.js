import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalArgv = process.argv;
const originalHome = process.env.HOME;
const originalConfigPath = process.env.TAXI_CONFIG_PATH;
const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const home = mkdtempSync(join(tmpdir(), "taxi-init-consent-"));
const configPath = join(home, "config.json");

const configureMcpClients = jest.fn();
const selectOne = jest.fn();
const selectMulti = jest.fn();
const log = jest.spyOn(console, "log").mockImplementation(() => {});
const error = jest.spyOn(console, "error").mockImplementation(() => {});
const stdoutWrite = jest.spyOn(process.stdout, "write").mockImplementation(() => true);

jest.unstable_mockModule("../dist/cli/client-config.js", () => ({ configureMcpClients }));
jest.unstable_mockModule("../dist/cli/select.js", () => ({ selectOne, selectMulti }));
jest.unstable_mockModule("../dist/shared/banner.js", () => ({
  LOGO_LINES: [],
  sleep: async () => {},
  typeLine: async () => {},
  writeOut: () => {},
}));

let runSetup;
let runHelp;

function setTTY(value) {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value });
}

function setArgs(...args) {
  process.argv = [process.execPath, "dist/index.js", "setup", ...args];
}

function consoleOutput() {
  return log.mock.calls.map((call) => call.join(" ")).join("\n");
}

function arrangeInteractive(clientConsent = "no") {
  const singleAnswers = ["en", "sensitive-only", clientConsent];
  const multiAnswers = [
    ["notes", "reminders", "calendar", "finder", "system", "shortcuts", "weather"],
    [],
    ["usageTracking", "auditLog", "semanticToolSearch", "proactiveContext"],
  ];
  selectOne.mockImplementation(async () => singleAnswers.shift());
  selectMulti.mockImplementation(async () => multiAnswers.shift());
}

beforeAll(async () => {
  process.env.HOME = home;
  process.env.TAXI_CONFIG_PATH = configPath;
  ({ runSetup } = await import("../dist/cli/setup.js"));
  ({ runHelp } = await import("../dist/cli/help.js"));
});

beforeEach(() => {
  configureMcpClients.mockReset().mockReturnValue([]);
  selectOne.mockReset();
  selectMulti.mockReset();
  log.mockClear();
  error.mockClear();
  stdoutWrite.mockClear();
  rmSync(configPath, { force: true });
});

afterAll(() => {
  process.argv = originalArgv;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalConfigPath === undefined) delete process.env.TAXI_CONFIG_PATH;
  else process.env.TAXI_CONFIG_PATH = originalConfigPath;
  if (originalIsTTY) Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
  else delete process.stdin.isTTY;
  log.mockRestore();
  error.mockRestore();
  stdoutWrite.mockRestore();
  rmSync(home, { recursive: true, force: true });
});

describe("taxi setup client-registration consent", () => {
  test("interactive init asks clearly before registration and defaults to No", async () => {
    setTTY(true);
    setArgs();
    arrangeInteractive("no");

    await runSetup();

    const consentCall = selectOne.mock.calls[2];
    expect(consentCall[0]).toContain("persistent client settings");
    expect(consentCall[0]).toContain("clients may start Taxi");
    expect(consentCall[1]).toEqual([
      expect.objectContaining({ value: "no" }),
      expect.objectContaining({ value: "yes" }),
    ]);
    expect(consentCall[2]).toBe(0);
    expect(configureMcpClients).not.toHaveBeenCalled();
    expect(consoleOutput()).toContain("Client registration skipped; no MCP client config was changed.");
  });

  test("interactive --no-clients suppresses the question and always skips registration", async () => {
    setTTY(true);
    setArgs("--no-clients", "--clients");
    arrangeInteractive("yes");

    await runSetup();

    expect(selectOne).toHaveBeenCalledTimes(2);
    expect(configureMcpClients).not.toHaveBeenCalled();
    expect(consoleOutput()).toContain("Client registration skipped; no MCP client config was changed.");
  });

  test("interactive Yes explicitly configures detected clients", async () => {
    setTTY(true);
    setArgs();
    arrangeInteractive("yes");
    configureMcpClients.mockReturnValue([
      { name: "Codex", status: "configured", detail: "token-gated Taxi.app runtime" },
    ]);

    await runSetup();

    expect(configureMcpClients).toHaveBeenCalledWith({ includeSkipped: false, runtimeMode: "app" });
    expect(consoleOutput()).toContain("1 client(s) configured.");
  });

  test("non-interactive --profile --yes skips clients unless --clients is present", async () => {
    setTTY(false);
    setArgs("--profile", "starter", "--yes");

    await runSetup();

    expect(existsSync(configPath)).toBe(true);
    expect(configureMcpClients).not.toHaveBeenCalled();
    expect(consoleOutput()).toContain("clients=skipped");
    expect(consoleOutput()).toContain("client registration skipped; no MCP client config was changed");
  });

  test("non-interactive --clients is an explicit opt-in and --no-clients still wins", async () => {
    setTTY(false);
    configureMcpClients.mockReturnValue([
      { name: "Cursor", status: "configured", detail: "token-gated Taxi.app runtime" },
    ]);

    setArgs("--profile", "starter", "--yes", "--clients");
    await runSetup();
    expect(configureMcpClients).toHaveBeenCalledTimes(1);
    expect(consoleOutput()).toContain("clients=1");

    configureMcpClients.mockClear();
    log.mockClear();
    setArgs("--profile", "starter", "--yes", "--clients", "--no-clients");
    await runSetup();
    expect(configureMcpClients).not.toHaveBeenCalled();
    expect(consoleOutput()).toContain("clients=skipped");
  });

  test("help makes the default skip and explicit opt-in visible", () => {
    runHelp();

    const output = consoleOutput();
    expect(output).toContain("client connection asks first and defaults to No");
    expect(output).toContain("Non-interactive config only; clients skipped");
    expect(output).toContain("--clients");
    expect(output).toContain("explicit opt-in");
  });
});
