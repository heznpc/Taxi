"use strict";

const { existsSync, lstatSync, realpathSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, dirname } = require("node:path");

module.exports = async function teardownTaxiJestHomeRun() {
  if (process.env.TAXI_TEST_REAL_HOME === "1") return;
  const runRoot = process.env.TAXI_JEST_HOME_RUN_ROOT;
  if (!runRoot || !existsSync(runRoot)) return;

  const canonicalTempRoot = realpathSync(tmpdir());
  const canonicalRunRoot = realpathSync(runRoot);
  const stat = lstatSync(runRoot);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    dirname(canonicalRunRoot) !== canonicalTempRoot ||
    !basename(canonicalRunRoot).startsWith("taxi-jest-run-")
  ) {
    throw new Error(`refusing to remove unexpected Jest HOME run root: ${runRoot}`);
  }
  rmSync(canonicalRunRoot, { recursive: true, force: false });
};
