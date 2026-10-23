/**
 * Force every jest suite into a disposable HOME.
 *
 * Several modules derive state paths (~/.taxi audit chain, ~/.config/taxi
 * config, ~/.cache/taxi memory store) from HOME at import time. A suite that
 * forgets to override those paths — or an async audit flush that outlives its
 * test — must land in a throwaway directory, never in the developer's real
 * home. This closed two real incidents: a suite sealing rows into the real
 * ~/.taxi HMAC chain (intermittent exit-1 across unrelated runs) and a suite
 * writing a prompt-injection fixture into the real ~/.cache/taxi/memory.json.
 *
 * Runs via jest `setupFilesAfterEnv`, i.e. before each test module is imported
 * but after the test lifecycle exists. That lets import-time path constants
 * pick up the fake HOME and lets afterAll remove it deterministically. Suites
 * that need finer isolation still set TAXI_VECTOR_STORE_DIR etc. themselves.
 * Escape hatch: TAXI_TEST_REAL_HOME=1 (deliberate, never set in CI).
 */
"use strict";

const { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, dirname, join } = require("node:path");
const { afterAll } = require("@jest/globals");

if (process.env.TAXI_TEST_REAL_HOME !== "1") {
  const runRoot = process.env.TAXI_JEST_HOME_RUN_ROOT || tmpdir();
  const fakeHome = mkdtempSync(join(runRoot, "taxi-test-home-"));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;

  afterAll(() => {
    if (!existsSync(fakeHome)) return;
    const canonicalRunRoot = realpathSync(runRoot);
    const canonicalFakeHome = realpathSync(fakeHome);
    const stat = lstatSync(fakeHome);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      dirname(canonicalFakeHome) !== canonicalRunRoot ||
      !basename(canonicalFakeHome).startsWith("taxi-test-home-")
    ) {
      throw new Error(`refusing to remove unexpected Jest HOME: ${fakeHome}`);
    }
    rmSync(fakeHome, { recursive: true, force: false });
  });
}
