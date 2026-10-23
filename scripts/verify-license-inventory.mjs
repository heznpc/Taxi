#!/usr/bin/env node

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  compareProductionPackageGraphs,
  expectedProductionPackageGraph,
  installedProductionPackageGraph,
} from "./lib/production-package-graph.mjs";

const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const NOTICE_FILE = join(ROOT, "THIRD_PARTY_NOTICES.md");
const ALLOWED_LICENSES = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause"]);

function fail(message) {
  console.error(`license-inventory: ${message}`);
  process.exit(1);
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function packageName(relativePath) {
  return relativePath.slice(relativePath.lastIndexOf("node_modules/") + "node_modules/".length);
}

function legalFiles(directory) {
  return readdirSync(directory).filter((name) => /^(licen[cs]e|notice|copying)(\.|$)/i.test(name));
}

function productionPackages() {
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  return Object.entries(lock.packages)
    .filter(([relativePath, metadata]) => relativePath.startsWith("node_modules/") && !metadata.dev)
    .map(([relativePath, metadata]) => ({
      relativePath,
      name: packageName(relativePath),
      version: metadata.version,
      license: metadata.license,
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function verifySource(packages) {
  const notices = readFileSync(NOTICE_FILE, "utf8");
  const missingInventory = [];
  const missingLicenseFiles = [];
  const reviewLicenses = [];

  for (const pkg of packages) {
    if (!notices.includes(`\`${pkg.name}@${pkg.version}\``)) missingInventory.push(`${pkg.name}@${pkg.version}`);
    if (!ALLOWED_LICENSES.has(pkg.license))
      reviewLicenses.push(`${pkg.name}@${pkg.version}: ${pkg.license ?? "missing"}`);
    const directory = join(ROOT, pkg.relativePath);
    try {
      if (!statSync(directory).isDirectory() || legalFiles(directory).length === 0) {
        missingLicenseFiles.push(pkg.relativePath);
      }
    } catch {
      missingLicenseFiles.push(pkg.relativePath);
    }
  }

  if (missingInventory.length) fail(`THIRD_PARTY_NOTICES.md is stale: ${missingInventory.join(", ")}`);
  if (reviewLicenses.length) fail(`licenses require review: ${reviewLicenses.join(", ")}`);
  if (missingLicenseFiles.length)
    fail(`installed packages lack license/notice files: ${missingLicenseFiles.join(", ")}`);
  console.log(
    `ok: source license inventory: ${packages.length} production package entries, permissive licenses, files present`,
  );
}

function verifyApp(packages, appOption) {
  if (!appOption) return;
  const app = resolve(ROOT, appOption);
  const legalRoot = join(app, "Contents", "Resources", "taxi");
  for (const relative of [
    "legal/LICENSE",
    "legal/SOURCE_PROVENANCE.md",
    "legal/THIRD_PARTY_NOTICES.md",
    "runtime/LICENSE",
  ]) {
    statSync(join(legalRoot, relative));
  }
  const missing = packages.filter((pkg) => {
    const directory = join(legalRoot, "server", pkg.relativePath);
    try {
      return !statSync(directory).isDirectory() || legalFiles(directory).length === 0;
    } catch {
      return true;
    }
  });
  if (missing.length)
    fail(`Taxi.app packages lack license/notice files: ${missing.map((pkg) => pkg.relativePath).join(", ")}`);
  console.log(`ok: Taxi.app legal surface: project, provenance, Node, and ${packages.length} package entries`);
}

function verifyMcpb(packages, mcpbOption) {
  if (!mcpbOption) return;
  const archive = resolve(ROOT, mcpbOption);
  const listed = spawnSync("unzip", ["-Z1", archive], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (listed.status !== 0) fail(`cannot inspect MCPB archive: ${archive}`);
  const entries = new Set(listed.stdout.split("\n").filter(Boolean));
  for (const required of ["LICENSE", "SOURCE_PROVENANCE.md", "THIRD_PARTY_NOTICES.md"]) {
    if (!entries.has(required)) fail(`MCPB is missing ${required}`);
  }
  const missing = packages.filter((pkg) => {
    const prefix = `server/${pkg.relativePath}/`;
    return ![...entries].some(
      (entry) => entry.startsWith(prefix) && /\/(licen[cs]e|notice|copying)(\.|$)/i.test(entry),
    );
  });
  if (missing.length)
    fail(`MCPB packages lack license/notice files: ${missing.map((pkg) => pkg.relativePath).join(", ")}`);
  const extractionRoot = mkdtempSync(join(tmpdir(), "taxi-mcpb-license-"));
  try {
    const extracted = spawnSync("unzip", ["-q", archive, "server/node_modules/*", "-d", extractionRoot], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (extracted.status !== 0) fail(`cannot extract MCPB dependency graph: ${archive}`);
    const expectedGraph = expectedProductionPackageGraph(join(ROOT, "package-lock.json"));
    const actualGraph = installedProductionPackageGraph(join(extractionRoot, "server", "node_modules"));
    const mismatches = compareProductionPackageGraphs(expectedGraph, actualGraph);
    if (mismatches.length) {
      fail(`MCPB dependency graph differs from reviewed lockfile: ${mismatches.join("; ")}`);
    }
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true });
  }
  console.log(`ok: MCPB legal surface: project, provenance, and ${packages.length} package entries`);
}

const packages = productionPackages();
verifySource(packages);
verifyApp(packages, option("--app"));
verifyMcpb(packages, option("--mcpb"));
