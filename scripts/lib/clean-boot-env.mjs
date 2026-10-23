// Shared child-process env for the three "boot the server and read tools/list"
// gates — smoke-mcp.mjs, mcp-validate.mjs, verify-published-package.mjs — so
// they all measure the DEFAULT STARTER/progressive tool surface deterministically,
// independent of the host's ~/.config/taxi/config.json or any exported
// TAXI_*.
//
// Why this is shared, not special-cased in one gate: in CI (no config.json) the
// server already applies the STARTER profile, so all three measure the same
// small front-door surface there. On a dev box, an existing config.json (which may
// disable modules), an exported TAXI_FULL, or a per-module override would make
// the SAME gate measure a different surface — and could false-fail a floor
// (smoke-mcp's floor) or silently validate the wrong set. Routing all
// three through one helper gives local <-> CI parity instead of three gates that
// drift on whatever the host happens to have configured.
//
// Surgical, not a full `env -i`: strip every TAXI_* from the inherited env
// (drops TAXI_FULL, any per-module override, and an inherited
// TAXI_CONFIG_PATH), then re-set only the two the gates legitimately need:
//   - TAXI_TEST_MODE=1 — gates test-only shutdown/error paths; kept symmetric
//     across all three gates.
//   - TAXI_CONFIG_PATH — pointed at a guaranteed-absent file so loadConfig
//     falls through to the STARTER profile (config.ts loadFileConfig returns
//     fileExists:false on ENOENT, and parseConfig then applies STARTER).
//   - TAXI_PROFILE=starter and TAXI_TOOL_EXPOSURE=progressive — explicit
//     lock on the default profile-first contract these gates verify.
// Non-TAXI env (PATH / HOME / npm_config_*) is preserved so node, npx, and the
// npm cache keep working on any runner.

import { tmpdir } from "node:os";
import { join } from "node:path";

// Parent directory deliberately does not exist, so readFileSync throws ENOENT
// (not EACCES or a parse error) and the server treats it as "no config file".
// Nothing ever writes here — it is a read-only sentinel path.
const ABSENT_CONFIG = join(tmpdir(), "taxi-nonexistent-config-dir", "config.json");

/**
 * Build a child-process env that boots Taxi at its DEFAULT (STARTER/progressive) surface,
 * regardless of host config.json or exported TAXI_*.
 *
 * @param {NodeJS.ProcessEnv} [base=process.env] - env to derive from.
 * @returns {NodeJS.ProcessEnv}
 */
export function cleanBootEnv(base = process.env) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (key.startsWith("TAXI_")) delete env[key];
  }
  env.TAXI_TEST_MODE = "1";
  env.TAXI_CONFIG_PATH = ABSENT_CONFIG;
  env.TAXI_PROFILE = "starter";
  env.TAXI_TOOL_EXPOSURE = "progressive";
  // These gates inherit the REAL HOME (node/npx need it), so any tool call
  // they make would otherwise be recorded into the developer's real
  // ~/.taxi/profile.json usage stats. Belt: disable tracking outright.
  // Suspenders: usage-tracker.ts also refuses disk persistence whenever
  // TAXI_TEST_MODE=1 without an explicit TAXI_USAGE_PROFILE_PATH.
  env.TAXI_USAGE_TRACKING = "false";
  // Same leak, different file: the audit log lives under PATHS.VECTOR_STORE
  // (default ~/.taxi), so a cleanBootEnv-spawned server audit-logs into the
  // developer's REAL ~/.taxi/audit.jsonl. cli-connect.test.js deliberately
  // sends an unauthenticated request to assert a 401 — every full-suite run
  // was appending one __auth_failure row to the real audit chain, which then
  // read as an unattributable production auth incident (2026-08: 13 loopback
  // 401s traced back to exactly this before the redirect existed).
  // Per-parent-process dir: parallel jest workers each isolate their spawns,
  // and the multiprocess audit lock handles siblings sharing one dir.
  env.TAXI_VECTOR_STORE_DIR = join(tmpdir(), `taxi-test-state-${process.pid}`);
  return env;
}
