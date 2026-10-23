"use strict";

const { chmodSync, mkdtempSync, realpathSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");

module.exports = async function setupTaxiJestHomeRun() {
  if (process.env.TAXI_TEST_REAL_HOME === "1") return;
  const canonicalTempRoot = realpathSync(tmpdir());
  const runRoot = mkdtempSync(join(canonicalTempRoot, "taxi-jest-run-"));
  const canonicalRunRoot = realpathSync(runRoot);
  if (dirname(canonicalRunRoot) !== canonicalTempRoot) {
    throw new Error(`Jest HOME run root escaped the canonical temp root: ${runRoot}`);
  }
  chmodSync(canonicalRunRoot, 0o700);
  process.env.TAXI_JEST_HOME_RUN_ROOT = canonicalRunRoot;
};
