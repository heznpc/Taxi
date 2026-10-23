import { afterEach, describe, expect, test } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanBootEnv } from "../scripts/lib/clean-boot-env.mjs";

const DIST = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const homes = [];

function runCli(home, args) {
  return spawnSync(process.execPath, [DIST, ...args], {
    cwd: ROOT,
    env: { ...cleanBootEnv(), HOME: home, NO_COLOR: "1", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("taxi clients", () => {
  test("dry-run JSON reports an installed direct Claude Desktop config without mutating it", () => {
    const home = mkdtempSync(join(tmpdir(), "taxi-clients-"));
    homes.push(home);
    const configPath = join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { taxi: { command: "npx", args: ["-y", "@heznpc/taxi@1.0.0", "run"] } } }),
    );

    const result = runCli(home, ["clients", "--dry-run", "--json"]);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.dryRun).toBe(true);
    expect(payload.results).toEqual([
      expect.objectContaining({
        name: "Claude Desktop",
        status: "would-configure",
        configPath,
      }),
    ]);
    expect(readFileSync(configPath, "utf8")).toContain('"taxi"');
  });

  test("dry-run JSON accepts the direct runtime mode", () => {
    const home = mkdtempSync(join(tmpdir(), "taxi-clients-"));
    homes.push(home);
    const configPath = join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { taxi: { command: "npx", args: ["-y", "@heznpc/taxi@1.0.0", "run"] } } }),
    );

    const result = runCli(home, ["clients", "--dry-run", "--json", "--client-runtime", "direct"]);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.clientRuntime).toBe("direct");
    expect(payload.results).toEqual([
      expect.objectContaining({
        name: "Claude Desktop",
        status: "already-configured",
        configPath,
      }),
    ]);
  });

  test("rejects unknown flags with a non-zero exit code", () => {
    const home = mkdtempSync(join(tmpdir(), "taxi-clients-"));
    homes.push(home);

    const result = runCli(home, ["clients", "--wat"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown clients option: --wat");
  });
});
