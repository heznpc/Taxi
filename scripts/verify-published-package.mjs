#!/usr/bin/env node
/**
 * verify-published-package.mjs — a forcing function on the SHIPPED npm artifact.
 *
 * Why this exists (RFC 0013 §4 floor applied to the shipped thing; root-cause in
 * RFC 0014): CI proved Swift *compiled* and `dist/` *built*, but nothing ever
 * booted the *packaged tarball* the way a user actually gets it via
 * the version-pinned Taxi package. So packaging regressions shipped green:
 *   - a missing dist file (the banner.js npx crash — dist/index.js imported
 *     dist/shared/banner.js which wasn't present in the resolved package),
 *   - an incomplete `files` field,
 *   - a dist that builds locally but is broken once isolated from the repo.
 *
 * With no arguments this packs the real tarball for backwards compatibility.
 * Release preflight passes `--tarball`, so this installs and boots the one
 * preserved artifact that `npm publish <tarball>` will upload. No second pack
 * is allowed on that path.
 *
 * The verifier installs the tarball into a CLEAN throwaway project (no repo on
 * PATH, deps resolved fresh — exactly a user's environment), boots the
 * INSTALLED server under the pinned MCP Inspector, and asserts both the
 * default starter surface and full/full cross-pack surface. It tests the
 * artifact users run, not the repo working tree.
 *
 * It deliberately does NOT assert the Swift-backed tools *work* — those need the
 * optional bridge + real apps/permissions and are honestly surfaced elsewhere.
 * Its job is to catch "the published package is broken / incomplete" — the class
 * that four masking mechanisms (graceful degradation, local build artifacts, CI
 * compiles-but-doesn't-package, docs-ahead-of-distribution) let through before.
 *
 * Usage: node scripts/verify-published-package.mjs [--tarball <path>]
 *        [--metadata-out <path>]
 * Exit 0 = the packaged tarball boots clean and serves the expected surface.
 */

import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanBootEnv } from "./lib/clean-boot-env.mjs";
import { inspectPackageTarball } from "./lib/publish-identity.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Keep in sync with scripts/mcp-validate.mjs — same pinned inspector.
const INSPECTOR_VERSION = "0.21.2";
const INSPECTOR_PKG = `@modelcontextprotocol/inspector@${INSPECTOR_VERSION}`;
const INSPECTOR_TIMEOUT_MS = 120_000;
const ROOT_PACKAGE = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
const REQUIRED_ARTIFACT_ENTRIES = [
  "package/package.json",
  "package/dist/index.js",
  "package/LICENSE",
  "package/SOURCE_PROVENANCE.md",
  "package/THIRD_PARTY_NOTICES.md",
];

function valueArg(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? "") : "";
}

const suppliedTarballValue = valueArg("--tarball");
const suppliedTarball = suppliedTarballValue ? resolve(suppliedTarballValue) : null;
const metadataOutValue = valueArg("--metadata-out");
const metadataOut = metadataOutValue ? resolve(metadataOutValue) : null;
const expectedGitHead = valueArg("--expected-git-head");

if (metadataOut && !suppliedTarball) {
  console.error("✗ --metadata-out requires --tarball so the recorded artifact remains available for publish.");
  process.exit(1);
}
if (expectedGitHead && !/^[0-9a-f]{40}$/i.test(expectedGitHead)) {
  console.error("✗ --expected-git-head must be a full 40-character Git commit SHA.");
  process.exit(1);
}

// Surface floor for the DEFAULT boot. A plain `taxi run` (no --full, no
// config.json) applies the STARTER profile with progressive exposure: modules
// still load, but tools/list advertises a small front door rather than every
// registered tool. This gate tests the default user experience, so the floor
// catches "booted to near-empty" without forcing the old token-heavy surface.
const MIN_TOOLS = 10;
// Tools that MUST be present in any environment. Front-door tools prove the
// progressive runtime is usable; core JXA tools prove starter modules loaded.
const REQUIRED_CORE_TOOLS = [
  "profile_status",
  "list_profiles",
  "discover_tools",
  "run_tool",
  "list_notes",
  "list_reminders",
  "list_events",
  "list_directory",
];
const MIN_FULL_TOOLS = 290;
const REQUIRED_FULL_TOOLS = [
  "list_notes",
  "list_contacts",
  "send_mail",
  "list_tabs",
  "list_photos",
  "numbers_set_cell",
  "gws_sheets_read",
  "get_bluetooth_state",
  "memory_query",
];
const UNIVERSAL_FILE_CANARIES = [
  "notes/tools.js",
  "mail/tools.js",
  "safari/tools.js",
  "photos/tools.js",
  "numbers/tools.js",
  "google/tools.js",
  "bluetooth/tools.js",
  "memory/tools.js",
];

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.status !== 0) {
    console.error(`✗ command failed: ${cmd} ${args.join(" ")}`);
    if (r.stdout) console.error(r.stdout);
    if (r.stderr) console.error(r.stderr);
    process.exit(1);
  }
  return (r.stdout || "").trim();
}

function bootAndList(entry, cwd, envOverrides = {}) {
  return new Promise((done) => {
    // Boot the installed tarball at its DEFAULT (STARTER/progressive) surface, independent
    // of host config / TAXI_* — see scripts/lib/clean-boot-env.mjs. This gate
    // tests the default user experience, not whatever the host enables.
    const env = { ...cleanBootEnv(), ...envOverrides };
    const proc = spawn("npx", ["-y", INSPECTOR_PKG, "--cli", "node", entry, "run", "--method", "tools/list"], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c) => (stdout += c.toString()));
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      done({ code: 124, stdout, stderr: stderr + "\n[timeout]" });
    }, INSPECTOR_TIMEOUT_MS);
    proc.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });
}

function parseTools(stdout) {
  // Inspector emits the JSON-RPC result on stdout; npx/npm notices may prefix it.
  // Slice from the first '{' and parse the largest valid JSON object.
  const start = stdout.indexOf("{");
  if (start === -1) return null;
  for (let end = stdout.length; end > start; end--) {
    if (stdout[end - 1] !== "}") continue;
    try {
      const obj = JSON.parse(stdout.slice(start, end));
      if (obj && Array.isArray(obj.tools)) return obj.tools;
    } catch {
      /* keep shrinking */
    }
  }
  return null;
}

function inspectArtifactContents(tgz) {
  const identity = inspectPackageTarball(tgz);
  if (identity.name !== ROOT_PACKAGE.name || identity.version !== ROOT_PACKAGE.version) {
    console.error(
      `✗ tarball identity mismatch: expected ${ROOT_PACKAGE.name}@${ROOT_PACKAGE.version}, ` +
        `got ${identity.name}@${identity.version}`,
    );
    process.exit(1);
  }
  if (suppliedTarball && !/^[0-9a-f]{40}$/i.test(identity.gitHead ?? "")) {
    console.error("✗ preserved npm artifact package.json must contain a full release gitHead.");
    process.exit(1);
  }
  if (expectedGitHead && identity.gitHead !== expectedGitHead) {
    console.error(
      `✗ exact npm artifact gitHead mismatch: expected ${expectedGitHead}, got ${identity.gitHead ?? "missing"}`,
    );
    process.exit(1);
  }

  const entries = sh("tar", ["-tzf", tgz])
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const entrySet = new Set(entries);
  const missing = REQUIRED_ARTIFACT_ENTRIES.filter((entry) => !entrySet.has(entry));
  if (missing.length) {
    console.error(`✗ exact npm artifact is missing required entries: ${missing.join(", ")}`);
    process.exit(1);
  }

  const unsafe = entries.filter(
    (entry) =>
      !entry.startsWith("package/") ||
      entry.includes("/../") ||
      entry.startsWith("/") ||
      entry.startsWith("package/build/") ||
      entry.startsWith("package/experiments/") ||
      entry.endsWith(".mcpb") ||
      entry.endsWith(".env") ||
      entry === "package/.npmrc",
  );
  if (unsafe.length) {
    console.error(`✗ exact npm artifact includes forbidden or unsafe paths: ${unsafe.join(", ")}`);
    process.exit(1);
  }

  const manifest = JSON.parse(sh("tar", ["-xOzf", tgz, "package/package.json"]));
  if (manifest.license !== "MIT" || manifest.bin?.taxi !== "dist/index.js") {
    console.error("✗ exact npm artifact package metadata does not declare the Taxi CLI and MIT license.");
    process.exit(1);
  }
  for (const entry of ["package/LICENSE", "package/SOURCE_PROVENANCE.md", "package/THIRD_PARTY_NOTICES.md"]) {
    if (!sh("tar", ["-xOzf", tgz, entry]).trim()) {
      console.error(`✗ exact npm artifact legal entry is empty: ${entry}`);
      process.exit(1);
    }
  }

  console.log(
    `✓ exact npm artifact content and legal surface verified: ${identity.filename} ` +
      `(${identity.size} bytes, ${identity.sha256})`,
  );
  return identity;
}

function writeMetadata(path, identity, defaultToolCount, fullToolCount) {
  const metadata = {
    schemaVersion: 1,
    package: {
      name: identity.name,
      version: identity.version,
      gitHead: identity.gitHead,
    },
    artifact: {
      filename: identity.filename,
      size: identity.size,
      sha256: identity.sha256,
      integrity: identity.integrity,
    },
    verification: {
      exactArtifactBytesStable: true,
      cleanInstall: true,
      cliExecutable: "taxi",
      cliVersion: identity.version,
      legalEntries: REQUIRED_ARTIFACT_ENTRIES.filter((entry) =>
        /\/(?:LICENSE|SOURCE_PROVENANCE\.md|THIRD_PARTY_NOTICES\.md)$/.test(entry),
      ).map((entry) => entry.slice("package/".length)),
      defaultToolCount,
      fullToolCount,
    },
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o644 });
  console.log(`✓ exact npm artifact metadata written: ${path}`);
}

const work = mkdtempSync(join(tmpdir(), "taxi-pkgverify-"));
let tgz = suppliedTarball;
let removeTarball = false;
try {
  if (!tgz) {
    console.log("[1/5] npm pack (backwards-compatible standalone mode) …");
    // `npm pack` prints notices on stderr and the tarball name on stdout (last line).
    const packOut = sh("npm", ["pack"], { cwd: REPO_ROOT });
    const tgzName = packOut
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .pop();
    tgz = join(REPO_ROOT, tgzName);
    removeTarball = true;
    console.log(`    packed ${tgzName}`);
  } else {
    console.log(`[1/5] use preserved npm artifact without repacking: ${tgz}`);
  }
  if (!existsSync(tgz)) {
    console.error(`✗ npm tarball does not exist: ${tgz}`);
    process.exit(1);
  }
  const artifactIdentity = inspectArtifactContents(tgz);

  console.log("[2/5] clean install and CLI execution from the exact tarball …");
  sh("npm", ["init", "-y"], { cwd: work });
  sh("npm", ["install", "--no-audit", "--no-fund", "--no-save", tgz], { cwd: work });
  const installedPackage = join(work, "node_modules", ...ROOT_PACKAGE.name.split("/"));
  const entry = join(installedPackage, "dist", "index.js");
  if (!existsSync(entry)) {
    console.error(`✗ installed package is missing the entrypoint: ${entry}`);
    process.exit(1);
  }
  const distDir = join(installedPackage, "dist");
  const missingFiles = UNIVERSAL_FILE_CANARIES.filter((path) => !existsSync(join(distDir, path)));
  if (missingFiles.length) {
    console.error(`✗ installed universal package is missing module entrypoints: ${missingFiles.join(", ")}`);
    process.exit(1);
  }
  for (const legalFile of ["LICENSE", "SOURCE_PROVENANCE.md", "THIRD_PARTY_NOTICES.md"]) {
    const path = join(installedPackage, legalFile);
    if (!existsSync(path) || !readFileSync(path, "utf8").trim()) {
      console.error(`✗ clean-installed package is missing a non-empty ${legalFile}`);
      process.exit(1);
    }
  }
  const taxiExecutable = join(work, "node_modules", ".bin", "taxi");
  if (!existsSync(taxiExecutable)) {
    console.error(`✗ clean-installed package is missing its taxi executable: ${taxiExecutable}`);
    process.exit(1);
  }
  const cliVersion = sh(taxiExecutable, ["--version"], { cwd: work, env: cleanBootEnv() });
  if (cliVersion !== artifactIdentity.version) {
    console.error(`✗ installed taxi --version mismatch: expected ${artifactIdentity.version}, got ${cliVersion}`);
    process.exit(1);
  }
  console.log(`✓ clean-installed taxi executable reports ${cliVersion}.`);

  console.log("[3/5] boot the INSTALLED default starter surface under MCP Inspector …");
  // eslint-disable-next-line no-undef -- top-level await is fine in an ESM script
  const { code, stdout, stderr } = await bootAndList(entry, work);

  if (code !== 0) {
    console.error(`✗ installed server did not boot cleanly (exit ${code}).`);
    console.error("--- stdout ---\n" + stdout.slice(0, 4000));
    console.error("--- stderr ---\n" + stderr.slice(0, 4000));
    process.exit(1);
  }
  if (/ERR_MODULE_NOT_FOUND|Cannot find module/.test(stdout + stderr)) {
    console.error("✗ packaged tarball is missing a module at runtime (incomplete dist / files field).");
    console.error((stdout + stderr).slice(0, 4000));
    process.exit(1);
  }

  const tools = parseTools(stdout);
  if (!tools) {
    console.error("✗ could not parse a tools/list response from the installed server.");
    console.error("--- stdout ---\n" + stdout.slice(0, 4000));
    process.exit(1);
  }

  const names = new Set(tools.map((t) => t.name));
  const missing = REQUIRED_CORE_TOOLS.filter((n) => !names.has(n));
  const problems = [];
  if (tools.length < MIN_TOOLS) problems.push(`only ${tools.length} tools served (floor ${MIN_TOOLS})`);
  if (missing.length) problems.push(`missing required core tools: ${missing.join(", ")}`);

  if (problems.length) {
    console.error("✗ published tarball booted but the surface is wrong:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  console.log(
    `✓ packaged tarball boots clean and serves ${tools.length} exposed tools (front door + core JXA present).`,
  );

  console.log("[4/5] boot the same INSTALLED artifact in full/full bundled mode …");
  const fullResult = await bootAndList(entry, work, {
    TAXI_PROFILE: "full",
    TAXI_TOOL_EXPOSURE: "full",
    TAXI_MODULE_PACKS: "all",
    TAXI_FAKE_OS_VERSION: "0",
  });
  if (fullResult.code !== 0) {
    console.error(`✗ installed universal server did not boot full/full cleanly (exit ${fullResult.code}).`);
    console.error("--- stdout ---\n" + fullResult.stdout.slice(0, 4000));
    console.error("--- stderr ---\n" + fullResult.stderr.slice(0, 4000));
    process.exit(1);
  }
  if (/ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)/.test(fullResult.stdout + fullResult.stderr)) {
    console.error("✗ full/full packaged runtime emitted a missing-module error.");
    console.error((fullResult.stdout + fullResult.stderr).slice(0, 4000));
    process.exit(1);
  }
  const fullTools = parseTools(fullResult.stdout);
  if (!fullTools) {
    console.error("✗ could not parse full/full tools/list from the installed universal package.");
    console.error("--- stdout ---\n" + fullResult.stdout.slice(0, 4000));
    process.exit(1);
  }
  const fullNames = new Set(fullTools.map((tool) => tool.name));
  const missingFull = REQUIRED_FULL_TOOLS.filter((name) => !fullNames.has(name));
  if (fullTools.length < MIN_FULL_TOOLS || missingFull.length) {
    console.error("✗ installed universal package has an incomplete full/full surface:");
    if (fullTools.length < MIN_FULL_TOOLS) {
      console.error(`  - only ${fullTools.length} tools served (floor ${MIN_FULL_TOOLS})`);
    }
    if (missingFull.length) console.error(`  - missing representative tools: ${missingFull.join(", ")}`);
    process.exit(1);
  }

  console.log(`✓ universal packaged tarball serves ${fullTools.length} full/full tools across representative packs.`);
  console.log("  (This gate tests the SHIPPED artifact, closing the docs-ahead-of-distribution gap.)");

  console.log("[5/5] re-check exact artifact bytes and emit publish metadata …");
  const finalIdentity = inspectPackageTarball(tgz);
  if (
    finalIdentity.sha256 !== artifactIdentity.sha256 ||
    finalIdentity.integrity !== artifactIdentity.integrity ||
    finalIdentity.size !== artifactIdentity.size
  ) {
    console.error("✗ npm artifact bytes changed while they were being verified.");
    process.exit(1);
  }
  if (metadataOut) writeMetadata(metadataOut, finalIdentity, tools.length, fullTools.length);
  console.log(`✓ publish SRI is bound to the exercised bytes: ${finalIdentity.integrity}`);
} finally {
  if (removeTarball && tgz) rmSync(tgz, { force: true });
  rmSync(work, { recursive: true, force: true });
}
