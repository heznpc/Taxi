/** Locks the jest-level HOME isolation and cleanup (tests/helpers/isolate-home.cjs).
 *  If this fails, suites are running against the developer's real HOME and
 *  can pollute the real audit chain, config, and memory store. */
import { describe, expect, test } from "@jest/globals";
import { PATHS } from "../dist/shared/constants.js";

describe("test-run HOME isolation", () => {
  test("HOME points at a disposable taxi-test-home directory", () => {
    // App code derives every home path from env HOME (constants.ts HOME),
    // which jest sandboxes per worker — os.homedir() is native and reads the
    // real environment, so source modules must never use it for state paths.
    expect(process.env.HOME).toMatch(/taxi-test-home-/);
    expect(PATHS.CONFIG_DIR).toBe(`${process.env.HOME}/.config/taxi`);
  });

  test("no source module derives a state path from os.homedir()", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const grep = promisify(execFile);
    // grep exits 1 on no matches — that is the passing case.
    const result = await grep("grep", ["-rln", "homedir", "src/"], { cwd: process.cwd() }).catch((err) => err);
    expect(result.stdout ?? "").toBe("");
  });

  test("the harness owns a per-suite HOME under the canonical temp root", async () => {
    const { realpath } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { dirname } = await import("node:path");
    const runRoot = await realpath(process.env.TAXI_JEST_HOME_RUN_ROOT ?? tmpdir());
    expect(dirname(await realpath(process.env.HOME))).toBe(runRoot);
    expect(dirname(runRoot)).toBe(await realpath(tmpdir()));
  });
});
