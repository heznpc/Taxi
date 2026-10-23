#!/usr/bin/env node
// Build an `.mcpb` Desktop Extensions bundle for Claude Desktop
// (spec: modelcontextprotocol/mcpb MANIFEST.md v0.3).
//
// Layout produced in build/mcpb/ before zipping:
//
//   manifest.json              — generated from mcpb/manifest.template.json
//   icon.png                   — copied from icons/taxi-icon-256.png
//   server/
//     package.json             — trimmed: just deps, no scripts
//     dist/                    — Node build output (copy of repo dist/)
//     node_modules/            — lockfile-exact production deps (`npm ci --omit=dev`)
//
// The resulting bundle is a single `.mcpb` zip that Claude Desktop's
// "Browse extensions" picks up with zero CLI interaction from the user.
//
// Notes on scope
// - `npm ci --omit=dev` runs against the reviewed root lockfile inside the build dir,
//   so the bundle is self-contained. Users don't need node_modules
//   pre-populated locally.
// - We do NOT sign or notarize the archive. Notarization is a follow-up
//   (P2-1); Claude Desktop currently accepts unsigned .mcpb.
// - The complete JavaScript module catalog is copied into the bundle. Logical
//   profiles still control what loads and what tools/list exposes by default.
// - We do NOT ship a swift-bridge binary yet. Cloud-path tools work
//   out of the box; Swift-backed tools (EventKit, HealthKit, etc.)
//   require `npm run swift-build` on the user side. A future pass can
//   pre-build a universal binary for darwin-arm64 + darwin-x64 and
//   drop it into the bundle.
//
// Usage:
//   npm run build:mcpb          # produce build/mcpb/taxi-{version}.mcpb
//   npm run build:mcpb -- --check  # verify manifest substitution only, no zip

import {
  cpSync,
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareProductionPackageGraphs,
  expectedProductionPackageGraph,
  installedProductionPackageGraph,
} from "./lib/production-package-graph.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUILD_DIR = join(ROOT, "build", "mcpb");
const TEMPLATE_PATH = join(ROOT, "mcpb", "manifest.template.json");
const CHECK_ONLY = process.argv.includes("--check");
const ARCHIVE_TIMESTAMP = new Date("2000-01-01T00:00:00.000Z");

function normalizedArchiveEntries(directory, relativeDirectory = "") {
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (relativePath.includes("\n") || relativePath.includes("\r")) {
      console.error(`[mcpb] archive path contains a forbidden line break: ${JSON.stringify(relativePath)}`);
      process.exit(1);
    }
    const absolutePath = join(directory, entry.name);
    const metadata = lstatSync(absolutePath);
    if (metadata.isSymbolicLink()) {
      lutimesSync(absolutePath, ARCHIVE_TIMESTAMP, ARCHIVE_TIMESTAMP);
      paths.push(relativePath);
    } else if (metadata.isDirectory()) {
      paths.push(`${relativePath}/`);
      paths.push(...normalizedArchiveEntries(absolutePath, relativePath));
      utimesSync(absolutePath, ARCHIVE_TIMESTAMP, ARCHIVE_TIMESTAMP);
    } else if (metadata.isFile()) {
      utimesSync(absolutePath, ARCHIVE_TIMESTAMP, ARCHIVE_TIMESTAMP);
      paths.push(relativePath);
    }
  }
  return paths;
}

// ── Read package.json for metadata ───────────────────────────────────
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));

// ── Substitute manifest placeholders ─────────────────────────────────
const template = readFileSync(TEMPLATE_PATH, "utf-8");
let manifest;
try {
  manifest = JSON.parse(template);
} catch (e) {
  console.error(`[mcpb] template is invalid JSON: ${e.message}`);
  process.exit(1);
}

// Assign parsed fields instead of hand-escaping values into JSON source. This
// keeps quotes, backslashes, control characters, and Unicode data lossless;
// JSON.stringify below owns the only serialization boundary.
if (manifest.version !== "{{VERSION}}" || manifest.description !== "{{DESCRIPTION}}") {
  console.error("[mcpb] template metadata placeholders are missing or malformed");
  process.exit(1);
}
manifest.version = pkg.version;
manifest.description = pkg.description;

if (manifest.manifest_version !== "0.3") {
  console.error(`[mcpb] manifest_version mismatch (expected "0.3", got "${manifest.manifest_version}")`);
  process.exit(1);
}
if (manifest.version !== pkg.version) {
  console.error(`[mcpb] manifest.version (${manifest.version}) != package.json version (${pkg.version})`);
  process.exit(1);
}

if (CHECK_ONLY) {
  console.error(
    `[mcpb --check] manifest OK — v${manifest.version}, ${Object.keys(manifest.user_config ?? {}).length} user_config keys`,
  );
  process.exit(0);
}

// ── Fresh build dir ──────────────────────────────────────────────────
if (existsSync(BUILD_DIR)) rmSync(BUILD_DIR, { recursive: true, force: true });
mkdirSync(BUILD_DIR, { recursive: true });

// ── Write manifest + icon ────────────────────────────────────────────
writeFileSync(join(BUILD_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
cpSync(join(ROOT, "icons", "taxi-icon-256.png"), join(BUILD_DIR, "icon.png"));
for (const legalFile of ["LICENSE", "SOURCE_PROVENANCE.md", "THIRD_PARTY_NOTICES.md"]) {
  const source = join(ROOT, legalFile);
  if (!existsSync(source)) {
    console.error(`[mcpb] required legal file is missing: ${legalFile}`);
    process.exit(1);
  }
  cpSync(source, join(BUILD_DIR, legalFile));
}

// ── Server tree ──────────────────────────────────────────────────────
const serverDir = join(BUILD_DIR, "server");
mkdirSync(serverDir, { recursive: true });

// Trim package.json: deps + minimal runtime metadata. No scripts (Claude
// Desktop does not run them), no dev-only fields (commitlint, lint-staged).
const trimmedPkg = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  license: pkg.license,
  type: pkg.type,
  main: "dist/index.js",
  bin: pkg.bin,
  dependencies: pkg.dependencies,
  // Keep `overrides` so npm install respects the pinned Hono CVE fixes
  // (see CHANGELOG v2.10 Security entry).
  ...(pkg.overrides ? { overrides: pkg.overrides } : {}),
};
writeFileSync(join(serverDir, "package.json"), JSON.stringify(trimmedPkg, null, 2) + "\n");
cpSync(join(ROOT, "package-lock.json"), join(serverDir, "package-lock.json"));
cpSync(join(ROOT, "vendor"), join(serverDir, "vendor"), { recursive: true });

// Build output — require that `npm run build` has produced dist/.
if (!existsSync(join(ROOT, "dist", "index.js"))) {
  console.error(`[mcpb] dist/index.js not found — run \`npm run build\` first`);
  process.exit(1);
}
cpSync(join(ROOT, "dist"), join(serverDir, "dist"), { recursive: true });

// ── Install production deps into the bundle ──────────────────────────
console.error("[mcpb] installing production dependencies into bundle…");
const npmInstall = spawnSync(
  "npm",
  ["ci", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts", "--prefer-offline"],
  { cwd: serverDir, stdio: "inherit" },
);
if (npmInstall.status !== 0) {
  console.error(`[mcpb] npm ci failed with status ${npmInstall.status}`);
  process.exit(1);
}

const expectedGraph = expectedProductionPackageGraph(join(ROOT, "package-lock.json"));
const installedGraph = installedProductionPackageGraph(join(serverDir, "node_modules"));
const graphMismatches = compareProductionPackageGraphs(expectedGraph, installedGraph);
if (graphMismatches.length > 0) {
  console.error(`[mcpb] installed production graph differs from package-lock.json:\n${graphMismatches.join("\n")}`);
  process.exit(1);
}

// Drop package-lock.json — runtime doesn't need it, and it inflates
// the bundle by ~200 KB.
const lockPath = join(serverDir, "package-lock.json");
if (existsSync(lockPath)) rmSync(lockPath);

// ── Zip ──────────────────────────────────────────────────────────────
const outPath = join(BUILD_DIR, `taxi-${pkg.version}.mcpb`);
console.error(`[mcpb] zipping → ${outPath}`);

// Use the system zip CLI — macOS ships it by default, every CI runner
// has it, and writing our own ZIP encoder for one use-case is scope
// creep. The tradeoff is Windows CI would need a separate path, but
// Taxi is macOS-first and Windows isn't a supported build host.
const archiveEntries = normalizedArchiveEntries(BUILD_DIR);
const zipResult = spawnSync("zip", ["-X", "-y", "-q", `taxi-${pkg.version}.mcpb`, "-@"], {
  cwd: BUILD_DIR,
  encoding: "utf8",
  input: `${archiveEntries.join("\n")}\n`,
});
if (zipResult.status !== 0) {
  console.error(`[mcpb] zip failed with status ${zipResult.status}: ${zipResult.stderr || zipResult.stdout}`);
  process.exit(1);
}

const outStat = statSync(outPath);
console.error(
  `[mcpb] OK — ${outPath} (${(outStat.size / 1024 / 1024).toFixed(2)} MB, ${Object.keys(manifest.user_config ?? {}).length} user_config keys)`,
);
