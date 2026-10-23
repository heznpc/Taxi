#!/usr/bin/env node
/**
 * Dry release preflight.
 *
 * Builds and inspects the artifacts a user would install before any publish
 * step is allowed to run. This is intentionally local/CI-only: it never creates
 * a tag, never calls npm publish, and never mutates a GitHub Release.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseNpmPackList } from "./lib/npm-json.mjs";

const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const OUT_DIR = join(ROOT, "build", "release-preflight");
const args = new Set(process.argv.slice(2));
const INCLUDE_APP = args.has("--app");
const REQUIRE_WIDGET = process.env.TAXI_REQUIRE_WIDGET === "1";
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const version = pkg.version;

function run(cmd, cmdArgs, options = {}) {
  const result = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    env: process.env,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    const rendered = [cmd, ...cmdArgs].join(" ");
    console.error(`release-preflight: command failed (${result.status}): ${rendered}`);
    if (result.stdout) console.error(result.stdout);
    if (result.stderr) console.error(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout ?? "";
}

function fail(message) {
  console.error(`release-preflight: ${message}`);
  process.exit(1);
}

function assertFile(path, label) {
  if (!existsSync(path)) fail(`${label} missing: ${path}`);
  const size = statSync(path).size;
  if (size <= 0) fail(`${label} is empty: ${path}`);
  return size;
}

function listZip(path) {
  const output = run("unzip", ["-Z1", path], { capture: true });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function readZipJson(path, entry) {
  const output = run("unzip", ["-p", path, entry], { capture: true });
  try {
    return JSON.parse(output);
  } catch (error) {
    fail(`${entry} in ${path} is not valid JSON: ${error.message}`);
  }
}

function parsePack(output, label) {
  try {
    const [pack] = parseNpmPackList(output) ?? [];
    if (!pack?.filename) fail(`${label} did not report an npm tarball filename`);
    return pack;
  } catch (error) {
    fail(`${label} did not return parseable JSON: ${error.message}`);
  }
}

function releaseGitHead() {
  const value = process.env.TAXI_RELEASE_SHA || run("git", ["rev-parse", "HEAD"], { capture: true }).trim();
  if (!/^[0-9a-f]{40}$/i.test(value)) fail("TAXI_RELEASE_SHA/current HEAD must be a full Git commit SHA");
  return value;
}

function verifyNpmPackMetadata(pack) {
  if (!pack || pack.version !== version) {
    fail(`npm artifact version mismatch: expected ${version}, got ${pack?.version ?? "none"}`);
  }
  if (pack.name !== pkg.name) {
    fail(`npm artifact name mismatch: expected ${pkg.name}, got ${pack.name ?? "none"}`);
  }
  const filePaths = (pack.files ?? []).map((file) => file.path);
  const forbidden = filePaths.filter(
    (path) =>
      path.startsWith("build/") ||
      path.startsWith("experiments/") ||
      path.endsWith(".mcpb") ||
      path.endsWith(".env") ||
      path === ".npmrc",
  );
  if (forbidden.length) {
    fail(`npm artifact includes non-shipped or sensitive paths: ${forbidden.join(", ")}`);
  }
  if (!filePaths.includes("dist/index.js")) {
    fail("npm artifact is missing dist/index.js");
  }
  const requiredModules = ["notes", "mail", "safari", "photos", "numbers", "google", "bluetooth", "memory"];
  const missingEntrypoints = requiredModules
    .map((moduleName) => `dist/${moduleName}/tools.js`)
    .filter((entry) => !filePaths.includes(entry));
  if (missingEntrypoints.length) {
    fail(`universal npm artifact is missing module entrypoints: ${missingEntrypoints.join(", ")}`);
  }
  console.log(`ok: exact npm artifact: ${pack.filename}, ${filePaths.length} files, universal publish surface`);
}

function buildCanonicalNpmArtifact(gitHead) {
  const staging = mkdtempSync(join(tmpdir(), "taxi-release-npm-"));
  const initialDir = join(staging, "initial");
  const extractedDir = join(staging, "extracted");
  mkdirSync(initialDir, { recursive: true });
  mkdirSync(extractedDir, { recursive: true });
  try {
    // First let npm select and normalize the publish surface. npm does not add
    // gitHead to a packed tarball, and `npm publish <tarball>` cannot recover it
    // from the repository, so bind the exact release SHA inside the staged
    // manifest before producing the one preserved publish artifact.
    const initialOutput = run("npm", ["pack", "--json", "--pack-destination", initialDir], { capture: true });
    const initialPack = parsePack(initialOutput, "initial npm pack");
    const initialTarball = join(initialDir, initialPack.filename);
    assertFile(initialTarball, "initial npm tarball");
    run("tar", ["-xzf", initialTarball, "-C", extractedDir]);

    const stagedPackage = join(extractedDir, "package");
    const stagedManifestPath = join(stagedPackage, "package.json");
    const stagedManifest = JSON.parse(readFileSync(stagedManifestPath, "utf8"));
    if (stagedManifest.name !== pkg.name || stagedManifest.version !== version) {
      fail(
        `staged npm identity mismatch: expected ${pkg.name}@${version}, ` +
          `got ${stagedManifest.name}@${stagedManifest.version}`,
      );
    }
    stagedManifest.gitHead = gitHead;
    writeFileSync(stagedManifestPath, `${JSON.stringify(stagedManifest, null, 2)}\n`);

    const finalOutput = run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", OUT_DIR], {
      capture: true,
      cwd: stagedPackage,
    });
    const finalPack = parsePack(finalOutput, "canonical npm pack");
    verifyNpmPackMetadata(finalPack);
    const produced = join(OUT_DIR, finalPack.filename);
    assertFile(produced, "canonical npm tarball");
    const canonical = join(OUT_DIR, `taxi-${version}.tgz`);
    if (produced !== canonical) renameSync(produced, canonical);
    return canonical;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function verifyMcpb(path) {
  const size = assertFile(path, ".mcpb");
  const entries = listZip(path);
  const required = [
    "manifest.json",
    "icon.png",
    "LICENSE",
    "SOURCE_PROVENANCE.md",
    "THIRD_PARTY_NOTICES.md",
    "server/package.json",
    "server/dist/index.js",
  ];
  const missing = required.filter((entry) => !entries.includes(entry));
  if (missing.length) fail(`.mcpb is missing required entries: ${missing.join(", ")}`);
  if (!entries.some((entry) => entry.startsWith("server/node_modules/"))) {
    fail(".mcpb is missing bundled production dependencies under server/node_modules/");
  }
  const forbidden = entries.filter(
    (entry) =>
      entry.startsWith("src/") ||
      entry.startsWith("experiments/") ||
      entry.includes("/experiments/") ||
      entry.endsWith(".env") ||
      entry === ".npmrc" ||
      entry.endsWith("/.npmrc"),
  );
  if (forbidden.length) fail(`.mcpb includes forbidden paths: ${forbidden.join(", ")}`);
  const requiredModules = ["notes", "mail", "safari", "photos", "numbers", "google", "bluetooth", "memory"];
  const missingEntrypoints = requiredModules
    .map((moduleName) => `server/dist/${moduleName}/tools.js`)
    .filter((entry) => !entries.includes(entry));
  if (missingEntrypoints.length) {
    fail(`universal .mcpb is missing module entrypoints: ${missingEntrypoints.join(", ")}`);
  }

  const manifest = readZipJson(path, "manifest.json");
  if (manifest.version !== version) {
    fail(`.mcpb manifest version mismatch: expected ${version}, got ${manifest.version}`);
  }
  if (manifest.manifest_version !== "0.3") {
    fail(`.mcpb manifest_version mismatch: expected 0.3, got ${manifest.manifest_version}`);
  }
  console.log(`ok: .mcpb: ${path} (${(size / 1024 / 1024).toFixed(2)} MB), manifest v${manifest.version}`);
}

function buildAppArchive() {
  run("bash", ["scripts/bundle-app.sh", "bundle"], {
    env: {
      ...process.env,
      TAXI_REQUIRE_WIDGET: REQUIRE_WIDGET ? "1" : "0",
      TAXI_SKIP_WIDGET: REQUIRE_WIDGET ? "0" : "1",
    },
  });
  const appPath = join(ROOT, "Taxi.app");
  assertFile(join(appPath, "Contents", "MacOS", "Taxi"), "Taxi.app executable");
  run("npm", ["run", "licenses:check", "--", "--app", appPath]);
  const zipPath = join(OUT_DIR, `Taxi-${version}-adhoc.zip`);
  run("ditto", ["-c", "-k", "--norsrc", "--keepParent", appPath, zipPath]);
  const size = assertFile(zipPath, "ad-hoc app archive");
  console.log(`ok: ad-hoc app archive: ${zipPath} (${(size / 1024 / 1024).toFixed(2)} MB)`);
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

console.log(`release-preflight: Taxi v${version}`);
const gitHead = releaseGitHead();
run("npm", ["run", "build"]);
run("npm", ["run", "tokens:check"]);
run("npm", ["run", "profiles:check"]);
run("npm", ["run", "harness:check"]);
run("npm", ["run", "licenses:check"]);
run("npm", ["run", "size:check"]);
const npmTarballPath = buildCanonicalNpmArtifact(gitHead);
const npmMetadataPath = join(OUT_DIR, `taxi-${version}.npm-artifact.json`);
run("npm", [
  "run",
  "verify:package",
  "--",
  "--tarball",
  npmTarballPath,
  "--expected-git-head",
  gitHead,
  "--metadata-out",
  npmMetadataPath,
]);
run("npm", ["run", "build:mcpb"]);
run("npm", ["run", "verify:mcpb"]);

const mcpbPath = join(ROOT, "build", "mcpb", `taxi-${version}.mcpb`);
verifyMcpb(mcpbPath);
run("npm", ["run", "licenses:check", "--", "--mcpb", mcpbPath]);
copyFileSync(mcpbPath, join(OUT_DIR, `taxi-${version}.mcpb`));

if (INCLUDE_APP) {
  // Exercise the shipping, self-contained app through the real MCP transport
  // before archiving it: authenticated read, approved and denied writes,
  // emergency stop, and HMAC audit verification. This is deliberately part of
  // the app preflight rather than a source-wiring-only test.
  run("npm", ["run", "app:verify:governed"], {
    env: {
      ...process.env,
      TAXI_REQUIRE_WIDGET: REQUIRE_WIDGET ? "1" : "0",
      TAXI_SKIP_WIDGET: REQUIRE_WIDGET ? "0" : "1",
    },
  });
  // The previously observed failure was time-dependent: a live child could
  // consume a full core while its listener disappeared. Keep the one-hour
  // liveness/generation/CPU soak on the same blocking path as publish and
  // notarization rather than leaving it as an optional operator command.
  run("npm", ["run", "app:verify:soak"], {
    env: {
      ...process.env,
      TAXI_REQUIRE_WIDGET: REQUIRE_WIDGET ? "1" : "0",
      TAXI_SKIP_WIDGET: REQUIRE_WIDGET ? "0" : "1",
      TAXI_SOAK_DURATION_SECONDS: "3600",
      TAXI_SOAK_INTERVAL_SECONDS: "5",
      TAXI_SOAK_MCP_INTERVAL_SECONDS: "60",
      TAXI_SOAK_MAX_SUSTAINED_CPU: "80",
      TAXI_SOAK_MAX_HIGH_CPU_SECONDS: "60",
      TAXI_ALLOW_SHORT_SOAK: "0",
    },
  });
  buildAppArchive();
} else {
  console.log("release-preflight: skipping app bundle archive (pass --app to include it)");
}

console.log(`ok: release preflight artifacts ready in ${OUT_DIR}`);
