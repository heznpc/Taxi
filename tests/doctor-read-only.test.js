import { afterAll, describe, expect, test } from "@jest/globals";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "dist", "index.js");
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const PACKAGE_SPECIFIER = `@heznpc/taxi@${VERSION}`;
const APP_RUNTIME_URL = "http://127.0.0.1:3848/mcp";
const scratchDirectories = [];

function expectCompletedDiagnosis(result) {
  expect(result.error).toBeUndefined();
  // A disposable home does not hide installed apps or live localhost listeners.
  // Verify a completed diagnosis and its exit contract independently of host
  // health; the snapshots below assert that diagnosis never repairs the fixture.
  const output = result.stdout.replace(/\x1b\[[0-9;]*m/g, "");
  const summary = output.match(/Summary\s+✓\s+\d+ passed\s+⚠\s+\d+ warnings\s+✗\s+(\d+) failed/);
  expect(summary).not.toBeNull();
  expect(result.status).toBe(Number(summary[1]) > 0 ? 1 : 0);
}

function fileSnapshot(path) {
  const stat = statSync(path, { bigint: true });
  return {
    content: readFileSync(path, "utf8"),
    mode: Number(stat.mode & 0o777n),
    inode: stat.ino,
    modified: stat.mtimeNs,
  };
}

function treeSnapshot(root) {
  const snapshot = {};
  function visit(path, relativePath) {
    const stat = lstatSync(path, { bigint: true });
    const common = {
      mode: Number(stat.mode & 0o777n),
      inode: stat.ino,
      modified: stat.mtimeNs,
    };
    if (stat.isDirectory()) {
      snapshot[relativePath || "."] = { type: "directory", ...common };
      for (const entry of readdirSync(path).sort()) {
        visit(join(path, entry), relativePath ? join(relativePath, entry) : entry);
      }
    } else if (stat.isFile()) {
      snapshot[relativePath] = { type: "file", ...common, content: readFileSync(path, "base64") };
    } else if (stat.isSymbolicLink()) {
      snapshot[relativePath] = { type: "symlink", ...common };
    } else {
      snapshot[relativePath] = { type: "other", ...common };
    }
  }
  visit(root, "");
  return snapshot;
}

function prepareDoctorWorld(tokenState, configMode = 0o600) {
  const scratch = mkdtempSync(join(tmpdir(), `taxi-doctor-read-only-${tokenState}-`));
  scratchDirectories.push(scratch);
  const home = join(scratch, "home");
  const bin = join(scratch, "bin");
  const codexConfigPath = join(scratch, "codex", "config.toml");
  const claudeConfigPath = join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  const tokenPath = join(home, "Library", "Application Support", "Taxi", "http-token");
  const taxiConfigPath = join(home, "taxi-config.json");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(dirname(codexConfigPath), { recursive: true });
  mkdirSync(dirname(claudeConfigPath), { recursive: true });

  const codexConfig = [
    "[mcp_servers.taxi]",
    'command = "npx"',
    `args = ["-y", "${PACKAGE_SPECIFIER}", "connect", "--url", "${APP_RUNTIME_URL}"]`,
    "",
    "[mcp_servers.taxi.env]",
    'TAXI_HTTP_TOKEN = "configured-token"',
    "",
  ].join("\n");
  writeFileSync(codexConfigPath, codexConfig, { mode: configMode });
  chmodSync(codexConfigPath, configMode);

  const fakeCodexPath = join(bin, "codex");
  writeFileSync(
    fakeCodexPath,
    [
      "#!/bin/sh",
      'printf "invoked\\n" > "$HOME/codex-invoked"',
      'if [ "$1" = "--version" ]; then',
      '  echo "codex 0.0.0-test"',
      "  exit 0",
      "fi",
      'if [ "$1" = "mcp" ] && [ "$2" = "get" ] && [ "$3" = "taxi" ]; then',
      '  echo "taxi"',
      '  echo "  enabled: true"',
      '  echo "  transport: stdio"',
      '  echo "  command: npx"',
      `  echo "  args: -y ${PACKAGE_SPECIFIER} connect --url ${APP_RUNTIME_URL}"`,
      '  echo "  env: TAXI_HTTP_TOKEN=********"',
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(fakeCodexPath, 0o755);

  for (const command of ["gws", "osascript", "sw_vers", "which"]) {
    const commandPath = join(bin, command);
    writeFileSync(commandPath, `#!/bin/sh\nprintf "invoked\\n" > "$HOME/${command}-invoked"\n`, { mode: 0o755 });
    chmodSync(commandPath, 0o755);
  }

  writeFileSync(
    claudeConfigPath,
    `${JSON.stringify({
      mcpServers: {
        taxi: {
          command: "npx",
          args: ["-y", PACKAGE_SPECIFIER, "connect", "--url", APP_RUNTIME_URL],
          env: { TAXI_HTTP_TOKEN: "configured-token" },
        },
      },
    })}\n`,
    { mode: configMode },
  );
  chmodSync(claudeConfigPath, configMode);

  if (tokenState === "invalid") {
    mkdirSync(dirname(tokenPath), { recursive: true });
    writeFileSync(tokenPath, "short-token\n", { mode: 0o644 });
    chmodSync(tokenPath, 0o644);
  } else if (tokenState === "valid-stale") {
    mkdirSync(dirname(tokenPath), { recursive: true });
    writeFileSync(tokenPath, `${"v".repeat(43)}\n`, { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
  }

  return { scratch, home, bin, codexConfigPath, claudeConfigPath, tokenPath, taxiConfigPath };
}

afterAll(() => {
  for (const directory of scratchDirectories) rmSync(directory, { recursive: true, force: true });
});

describe("taxi doctor is read-only at the Codex/token boundary", () => {
  test.each([
    ["missing", null],
    ["invalid", 1],
    ["valid-stale", 1],
  ])(
    "does not create, chmod, or rewrite state when the runtime token is %s",
    (tokenState, expectedExit) => {
      const world = prepareDoctorWorld(tokenState);
      const configBefore = fileSnapshot(world.codexConfigPath);
      const claudeConfigBefore = fileSnapshot(world.claudeConfigPath);
      const tokenBefore = existsSync(world.tokenPath) ? fileSnapshot(world.tokenPath) : undefined;
      const treeBefore = treeSnapshot(world.scratch);
      const result = spawnSync(process.execPath, [ENTRY, "doctor"], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          HOME: world.home,
          PATH: world.bin,
          TAXI_CODEX_CONFIG_PATH: world.codexConfigPath,
          TAXI_APP_RUNTIME_TOKEN_PATH: world.tokenPath,
          TAXI_APP_RUNTIME_OWNER_PATH: join(world.home, "runtime-owner-secret"),
          TAXI_CONFIG_PATH: join(world.home, "taxi-config.json"),
          TAXI_AUDIT_LOG: "false",
          TAXI_RATE_LIMIT: "false",
          TAXI_USAGE_TRACKING: "false",
          TAXI_USAGE_PROFILE_PATH: join(world.home, "usage.json"),
          TAXI_HITL_SOCKET_PATH: join(world.home, "hitl.sock"),
        },
      });

      expectCompletedDiagnosis(result);
      if (expectedExit !== null && result.status !== expectedExit) {
        throw new Error(
          `doctor exited ${result.status}; expected ${expectedExit}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
        );
      }
      if (tokenState === "valid-stale") {
        expect(result.stdout).toMatch(/Claude Desktop.*registration token is stale/s);
        expect(result.stdout).toMatch(/Codex.*registration token is stale/s);
      }
      expect(fileSnapshot(world.codexConfigPath)).toEqual(configBefore);
      expect(fileSnapshot(world.claudeConfigPath)).toEqual(claudeConfigBefore);
      if (tokenBefore === undefined) {
        expect(existsSync(world.tokenPath)).toBe(false);
      } else {
        expect(fileSnapshot(world.tokenPath)).toEqual(tokenBefore);
      }
      expect(treeSnapshot(world.scratch)).toEqual(treeBefore);
    },
    90_000,
  );

  test("fails without chmodding token-bearing generic and Codex configs that are not 0600", () => {
    const world = prepareDoctorWorld("missing", 0o640);
    const configBefore = fileSnapshot(world.codexConfigPath);
    const claudeConfigBefore = fileSnapshot(world.claudeConfigPath);
    const treeBefore = treeSnapshot(world.scratch);
    const result = spawnSync(process.execPath, [ENTRY, "doctor"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        HOME: world.home,
        PATH: world.bin,
        TAXI_CODEX_CONFIG_PATH: world.codexConfigPath,
        TAXI_APP_RUNTIME_TOKEN_PATH: world.tokenPath,
        TAXI_APP_RUNTIME_OWNER_PATH: join(world.home, "runtime-owner-secret"),
        TAXI_CONFIG_PATH: join(world.home, "taxi-config.json"),
        TAXI_AUDIT_LOG: "false",
        TAXI_RATE_LIMIT: "false",
        TAXI_USAGE_TRACKING: "false",
        TAXI_USAGE_PROFILE_PATH: join(world.home, "usage.json"),
        TAXI_HITL_SOCKET_PATH: join(world.home, "hitl.sock"),
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/Claude Desktop config security.*permissions are 640; expected 0600/s);
    expect(result.stdout).toMatch(/Codex config security.*permissions are 640; expected 0600/s);
    expect(fileSnapshot(world.codexConfigPath)).toEqual(configBefore);
    expect(fileSnapshot(world.claudeConfigPath)).toEqual(claudeConfigBefore);
    expect(treeSnapshot(world.scratch)).toEqual(treeBefore);
  });

  test("does not repair a loose audit key during diagnosis", () => {
    const world = prepareDoctorWorld("missing");
    const auditKeyPath = join(world.home, ".taxi", "audit-hmac.key");
    mkdirSync(dirname(auditKeyPath), { recursive: true });
    writeFileSync(auditKeyPath, `${"a".repeat(64)}\n`, { mode: 0o600 });
    chmodSync(auditKeyPath, 0o644);
    const treeBefore = treeSnapshot(world.scratch);

    const result = spawnSync(process.execPath, [ENTRY, "doctor"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        HOME: world.home,
        PATH: world.bin,
        TAXI_CODEX_CONFIG_PATH: world.codexConfigPath,
        TAXI_APP_RUNTIME_TOKEN_PATH: world.tokenPath,
        TAXI_APP_RUNTIME_OWNER_PATH: join(world.home, "runtime-owner-secret"),
        TAXI_CONFIG_PATH: join(world.home, "taxi-config.json"),
        TAXI_AUDIT_LOG: "false",
        TAXI_RATE_LIMIT: "false",
        TAXI_USAGE_TRACKING: "false",
        TAXI_USAGE_PROFILE_PATH: join(world.home, "usage.json"),
        TAXI_HITL_SOCKET_PATH: join(world.home, "hitl.sock"),
      },
    });

    expectCompletedDiagnosis(result);
    expect(result.stderr).toMatch(/group\/other-accessible.*run taxi setup/);
    expect((statSync(auditKeyPath).mode & 0o777).toString(8)).toBe("644");
    expect(treeSnapshot(world.scratch)).toEqual(treeBefore);
  });

  test("rejects a symlinked root config without following or repairing it", () => {
    const world = prepareDoctorWorld("missing");
    const configTarget = join(world.scratch, "taxi-config-target.json");
    writeFileSync(configTarget, '{"profile":"starter"}\n', { mode: 0o600 });
    symlinkSync(configTarget, world.taxiConfigPath);
    const treeBefore = treeSnapshot(world.scratch);

    const result = spawnSync(process.execPath, [ENTRY, "doctor"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        HOME: world.home,
        PATH: world.bin,
        TAXI_CODEX_CONFIG_PATH: world.codexConfigPath,
        TAXI_APP_RUNTIME_TOKEN_PATH: world.tokenPath,
        TAXI_APP_RUNTIME_OWNER_PATH: join(world.home, "runtime-owner-secret"),
        TAXI_CONFIG_PATH: world.taxiConfigPath,
        TAXI_AUDIT_LOG: "false",
        TAXI_RATE_LIMIT: "false",
        TAXI_USAGE_TRACKING: "false",
        TAXI_USAGE_PROFILE_PATH: join(world.home, "usage.json"),
        TAXI_HITL_SOCKET_PATH: join(world.home, "hitl.sock"),
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/Config file security.*must not be a symbolic link/s);
    expect(treeSnapshot(world.scratch)).toEqual(treeBefore);
  });

  test("deep diagnostics import and inspect without creating local state or invoking PATH shims", () => {
    const world = prepareDoctorWorld("missing");
    const treeBefore = treeSnapshot(world.scratch);
    const result = spawnSync(process.execPath, [ENTRY, "doctor", "--deep"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        HOME: world.home,
        PATH: world.bin,
        TAXI_CODEX_CONFIG_PATH: world.codexConfigPath,
        TAXI_APP_RUNTIME_TOKEN_PATH: world.tokenPath,
        TAXI_APP_RUNTIME_OWNER_PATH: join(world.home, "runtime-owner-secret"),
        TAXI_CONFIG_PATH: world.taxiConfigPath,
        TAXI_AUDIT_LOG: "false",
        TAXI_RATE_LIMIT: "false",
        TAXI_USAGE_TRACKING: "false",
        TAXI_USAGE_PROFILE_PATH: join(world.home, "usage.json"),
        TAXI_HITL_SOCKET_PATH: join(world.home, "hitl.sock"),
      },
    });

    expectCompletedDiagnosis(result);
    expect(result.stdout).toMatch(/Swift bridge path checked/);
    expect(result.stdout).not.toMatch(/Swift bridge.*responsive/s);
    expect(treeSnapshot(world.scratch)).toEqual(treeBefore);
  }, 90_000);

  test("keeps diagnostics behind non-mutating import and probe contracts", () => {
    const indexSource = readFileSync(join(ROOT, "src", "index.ts"), "utf8");
    const doctorSource = readFileSync(join(ROOT, "src", "cli", "doctor.ts"), "utf8");

    expect(indexSource).not.toMatch(/^import\s/m);
    expect(indexSource).toContain('await import("./server/init.js")');
    expect(doctorSource).not.toMatch(/execFileSync\(\s*["'](?:osascript|which)["']/);
    expect(doctorSource).toContain("not probed in read-only mode");
    expect(doctorSource).toContain("path present (execution and response not probed)");
    expect(doctorSource).not.toContain('ok("Swift bridge", "responsive")');
  });
});
