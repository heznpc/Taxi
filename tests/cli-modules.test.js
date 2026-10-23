import { describe, test, expect } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runModules(home, args) {
  return execFileSync(process.execPath, ["dist/index.js", "modules", ...args], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: home,
      TAXI_SEMANTIC_SEARCH: "false",
      TAXI_AUDIT_LOG: "false",
      TAXI_USAGE_TRACKING: "false",
      TAXI_PROACTIVE_CONTEXT: "false",
    },
    encoding: "utf8",
  });
}

function runModulesFailure(home, args, extraEnv = {}) {
  try {
    runModulesWithEnv(home, args, extraEnv);
    throw new Error("expected command to fail");
  } catch (error) {
    if (error.message === "expected command to fail") throw error;
    return `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
}

function runModulesWithEnv(home, args, extraEnv = {}) {
  return execFileSync(process.execPath, ["dist/index.js", "modules", ...args], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...extraEnv,
      HOME: home,
      TAXI_SEMANTIC_SEARCH: "false",
      TAXI_AUDIT_LOG: "false",
      TAXI_USAGE_TRACKING: "false",
      TAXI_PROACTIVE_CONTEXT: "false",
    },
    encoding: "utf8",
  });
}

describe("taxi modules CLI", () => {
  test("lists only bundled activation metadata", () => {
    const home = mkdtempSync(join(tmpdir(), "taxi-modules-"));
    try {
      const payload = JSON.parse(runModules(home, ["list", "--json"]));
      expect(payload.active).toContain("core");
      expect(payload.distribution).toBe("bundled");
      expect(payload.installPrefix).toBeUndefined();
      expect(payload.packs.every((pack) => pack.packageName === undefined)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("enable writes a narrow modulePacks config from an unconfigured install", () => {
    const home = mkdtempSync(join(tmpdir(), "taxi-modules-"));
    try {
      const payload = JSON.parse(runModules(home, ["enable", "productivity", "--json"]));
      expect(payload.active).toHaveLength(13);
      expect(payload.active).toContain("productivity");

      const config = JSON.parse(readFileSync(join(home, ".config", "taxi", "config.json"), "utf8"));
      expect(config.modulePacks).toHaveLength(13);
      expect(config.modulePacks).toContain("productivity");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects the retired external package installation surface", () => {
    const home = mkdtempSync(join(tmpdir(), "taxi-modules-"));
    try {
      const output = runModulesFailure(home, ["enable", "productivity", "--install", "--dry-run", "--json"]);
      expect(output).toContain("modules are bundled");
      expect(existsSync(join(home, ".config", "taxi", "config.json"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("list does not discover legacy-looking external package directories", () => {
    const home = mkdtempSync(join(tmpdir(), "taxi-modules-"));
    try {
      const payload = JSON.parse(runModules(home, ["list", "--json"]));
      const productivity = payload.packs.find((pack) => pack.name === "productivity");
      expect(productivity.active).toBe(true);
      expect(productivity.packageName).toBeUndefined();
      expect(productivity.installedVersion).toBeUndefined();
      expect(productivity.repairCommand).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects the retired external package removal surface", () => {
    const home = mkdtempSync(join(tmpdir(), "taxi-modules-"));
    try {
      runModules(home, ["enable", "productivity", "--json"]);
      const output = runModulesFailure(home, ["uninstall", "productivity", "--dry-run", "--json"]);
      expect(output).toContain("modules are bundled");

      const config = JSON.parse(readFileSync(join(home, ".config", "taxi", "config.json"), "utf8"));
      expect(config.modulePacks).toHaveLength(13);
      expect(config.modulePacks).toContain("productivity");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("disable never removes the required core pack", () => {
    const home = mkdtempSync(join(tmpdir(), "taxi-modules-"));
    try {
      const payload = JSON.parse(runModules(home, ["disable", "all", "--json"]));
      expect(payload.active).toEqual(["core"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects unknown module pack names", () => {
    const home = mkdtempSync(join(tmpdir(), "taxi-modules-"));
    try {
      const output = runModulesFailure(home, ["enable", "fakemodule"]);
      expect(output).toContain("Unknown module packs: fakemodule");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("does not edit config while TAXI_MODULE_PACKS overrides runtime state", () => {
    const home = mkdtempSync(join(tmpdir(), "taxi-modules-"));
    try {
      const output = runModulesFailure(home, ["enable", "productivity"], { TAXI_MODULE_PACKS: "core-only" });
      expect(output).toContain("TAXI_MODULE_PACKS is set");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
