#!/usr/bin/env node
/**
 * Verify the public release state for the current package version.
 *
 * This is intentionally post-publish/post-release: it checks npm, a fresh npx
 * resolution, and the GitHub Release asset instead of trusting a local build.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanBootEnv } from "./lib/clean-boot-env.mjs";
import { MCP_PROTOCOL_VERSION, startMcp } from "./lib/mcp-stdio-client.mjs";
import { verifyPublishedIdentity } from "./lib/publish-identity.mjs";

const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const args = process.argv.slice(2);

function valueArg(name) {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? "") : "";
}

const version = valueArg("--version") || pkg.version;
const expectedShaValue = valueArg("--expected-sha");
const tarballValue = valueArg("--tarball");
const tarballPath = tarballValue ? resolve(ROOT, tarballValue) : undefined;
const mcpbValue = valueArg("--mcpb");
const appArchiveValue = valueArg("--app-archive");
const allowNotLatest = args.includes("--allow-not-latest");
const skipNpx = args.includes("--skip-npx");
const skipGithub = args.includes("--skip-github");
const skipRootInstall = args.includes("--skip-root-install");
const MIN_FULL_TOOLS = 290;
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

function run(cmd, cmdArgs, options = {}) {
  const result = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  return {
    status: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function fail(message, detail = "") {
  console.error(`release-verify: ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

function parseJson(label, text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${label} did not return parseable JSON`, `${error.message}\n${text.slice(0, 2000)}`);
  }
}

function npmJson(argsForNpm, label) {
  const result = run("npm", argsForNpm);
  if (result.status !== 0) fail(`${label} failed`, result.stderr || result.stdout);
  const parsed = parseJson(label, result.stdout);
  // npm 12 wraps `npm view --json` results in a single-element array.
  return Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
}

async function verifyGithubAttestation(argsForGh, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = "";
  do {
    const result = run("gh", argsForGh);
    if (result.status === 0) return;
    lastFailure = result.stderr || result.stdout || `gh exited ${result.status}`;
    if (Date.now() >= deadline) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
  } while (true);
  fail(`${label} failed after bounded attestation retry`, lastFailure);
}

function verifyPublishedPackage(packageName, packageVersion, label, packageRoot, exactTarballPath, expectedGitHead) {
  const publishedVersion = npmJson(
    ["view", `${packageName}@${packageVersion}`, "version", "--json"],
    `${label} version`,
  );
  if (publishedVersion !== packageVersion) {
    fail(`${label} version mismatch: expected ${packageVersion}, got ${publishedVersion}`);
  }
  const latestVersion = npmJson(["view", packageName, "dist-tags.latest", "--json"], `${label} latest`);
  if (latestVersion !== packageVersion && !allowNotLatest) {
    fail(`${label} latest points at ${latestVersion}, not ${packageVersion}`);
  }
  const dist = npmJson(["view", `${packageName}@${packageVersion}`, "dist", "--json"], `${label} dist metadata`);
  if (typeof dist?.integrity !== "string" || !dist.integrity.startsWith("sha512-")) {
    fail(`${label} is missing sha512 registry integrity metadata`);
  }
  if (typeof dist?.tarball !== "string" || !dist.tarball.startsWith("https://")) {
    fail(`${label} has invalid registry tarball metadata: ${dist?.tarball ?? "missing"}`);
  }
  try {
    verifyPublishedIdentity({
      packageRoot,
      tarballPath: exactTarballPath,
      expectedGitHead,
      retryTimeoutMs: 60_000,
    });
  } catch (error) {
    fail(`${label} source identity mismatch`, error instanceof Error ? error.message : String(error));
  }
  console.log(`ok: npm has ${packageName}@${packageVersion} (latest=${latestVersion})`);
}

function expectedReleaseSha() {
  const explicit = expectedShaValue;
  if (explicit && !/^[0-9a-f]{40}$/i.test(explicit)) fail("--expected-sha must be a full Git commit SHA");
  if (explicit) return explicit;
  const result = run("git", ["rev-parse", "HEAD"]);
  if (result.status !== 0 || !/^[0-9a-f]{40}$/i.test(result.stdout)) {
    fail("could not resolve the current Git commit for release identity verification", result.stderr);
  }
  return result.stdout;
}

function repositorySlug() {
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(process.env.GITHUB_REPOSITORY ?? "")) {
    return process.env.GITHUB_REPOSITORY;
  }
  const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  const match = String(url ?? "").match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (!match) fail("could not derive the GitHub repository slug");
  return `${match[1]}/${match[2]}`;
}

async function verifyRootRegistryInstall() {
  const work = mkdtempSync(join(tmpdir(), "taxi-release-root-"));
  let client = null;
  let failure = null;
  try {
    writeFileSync(join(work, "package.json"), JSON.stringify({ private: true, type: "module" }, null, 2) + "\n");
    const install = run(
      "npm",
      ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--no-save", `${pkg.name}@${version}`],
      { cwd: work, timeout: 180_000 },
    );
    if (install.status !== 0) throw new Error(install.stderr || install.stdout || "npm install failed");

    const distDir = join(work, "node_modules", pkg.name, "dist");
    const entry = join(distDir, "index.js");
    const missingFiles = UNIVERSAL_FILE_CANARIES.filter((path) => !existsSync(join(distDir, path)));
    if (!existsSync(entry) || missingFiles.length) {
      throw new Error(`registry root is missing universal entrypoints: ${missingFiles.join(", ") || "dist/index.js"}`);
    }

    client = startMcp({
      entry,
      args: [entry, "run"],
      cwd: work,
      timeoutMs: 60_000,
      env: {
        ...cleanBootEnv(),
        TAXI_PROFILE: "full",
        TAXI_TOOL_EXPOSURE: "full",
        TAXI_MODULE_PACKS: "all",
        TAXI_FAKE_OS_VERSION: "0",
      },
    });
    const initResp = await client.request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "taxi-release-registry-verify", version: "0.0.0" },
      },
      1,
    );
    if (!initResp.result) throw new Error(`initialize failed: ${JSON.stringify(initResp)}`);
    client.notify("notifications/initialized");
    const listResp = await client.request("tools/list", {}, 2);
    const tools = listResp.result?.tools;
    if (!Array.isArray(tools) || tools.length < MIN_FULL_TOOLS) {
      throw new Error(
        `registry root full/full tools/list is incomplete: ${Array.isArray(tools) ? tools.length : "malformed"}`,
      );
    }
    const names = new Set(tools.map((tool) => tool.name));
    const missingTools = REQUIRED_FULL_TOOLS.filter((name) => !names.has(name));
    if (missingTools.length)
      throw new Error(`registry root is missing representative tools: ${missingTools.join(", ")}`);
    const stderr = client.stderr();
    if (/ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)/.test(stderr)) {
      throw new Error(`registry root emitted missing-module errors:\n${stderr.slice(-4000)}`);
    }
    console.log(`ok: fresh registry root boots universal full/full (${tools.length} tools)`);
  } catch (error) {
    failure = error;
  } finally {
    if (client) await client.stop();
    rmSync(work, { recursive: true, force: true });
  }
  if (failure)
    fail("fresh registry root universal smoke failed", failure instanceof Error ? failure.message : String(failure));
}

function verifyNpxSmoke() {
  const work = mkdtempSync(join(tmpdir(), "taxi-release-npx-"));
  try {
    const npx = run("npx", ["-y", `${pkg.name}@${version}`, "--version"], {
      cwd: work,
      timeout: 120_000,
    });
    if (npx.status !== 0) fail(`npx smoke failed for ${pkg.name}@${version}`, npx.stderr || npx.stdout);
    if (npx.stdout !== version) fail(`npx --version mismatch: expected ${version}, got ${npx.stdout}`);
    console.log(`ok: npx -y ${pkg.name}@${version} --version`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const expectedGitHead = expectedReleaseSha();

console.log(`release-verify: ${pkg.name}@${version}`);

verifyPublishedPackage(pkg.name, version, "npm root", ROOT, tarballPath, expectedGitHead);

if (!skipNpx) {
  verifyNpxSmoke();
}

if (!skipRootInstall) {
  await verifyRootRegistryInstall();
}

if (!skipGithub) {
  const repository = repositorySlug();
  const releaseTag = `v${version}`;
  const gh = run("gh", [
    "release",
    "view",
    releaseTag,
    "--repo",
    repository,
    "--json",
    "tagName,targetCommitish,url,isImmutable,assets",
  ]);
  if (gh.status !== 0) fail(`GitHub Release v${version} not found`, gh.stderr || gh.stdout);
  const release = parseJson("gh release view", gh.stdout);
  const expectedAssets = [
    {
      name: `taxi-${version}.mcpb`,
      path: resolve(ROOT, mcpbValue || `build/release-preflight/taxi-${version}.mcpb`),
    },
    {
      name: `Taxi-${version}.zip`,
      path: resolve(ROOT, appArchiveValue || `build/signed-candidate/Taxi-${version}.zip`),
    },
  ];
  const actualAssetNames = (release.assets ?? []).map((asset) => asset.name).sort();
  const expectedAssetNames = expectedAssets.map((asset) => asset.name).sort();
  if (JSON.stringify(actualAssetNames) !== JSON.stringify(expectedAssetNames)) {
    fail(
      `GitHub Release ${releaseTag} asset set mismatch: expected ${expectedAssetNames.join(", ")}, got ${actualAssetNames.join(", ") || "none"}`,
    );
  }
  if (release.tagName !== releaseTag) fail(`GitHub Release tag mismatch: ${release.tagName}`);
  if (release.targetCommitish !== expectedGitHead) {
    fail(`GitHub Release target differs from expected release SHA`);
  }
  if (release.isImmutable !== true) {
    fail(`GitHub Release ${releaseTag} is not immutable; repository immutable releases must be enabled before publish`);
  }
  const tag = run("gh", ["api", `repos/${repository}/commits/${releaseTag}`, "--jq", ".sha"]);
  if (tag.status !== 0) fail(`could not resolve GitHub tag v${version}`, tag.stderr || tag.stdout);
  if (tag.stdout !== expectedGitHead) fail(`GitHub tag v${version} differs from expected release SHA`);
  await verifyGithubAttestation(
    ["release", "verify", releaseTag, "--repo", repository],
    `GitHub immutable release ${releaseTag} attestation`,
  );
  for (const expected of expectedAssets) {
    const asset = release.assets?.find((candidate) => candidate.name === expected.name);
    if (!asset) fail(`GitHub Release ${releaseTag} is missing ${expected.name}`);
    if (!existsSync(expected.path)) fail(`local release asset is missing: ${expected.path}`);
    const localSize = statSync(expected.path).size;
    if (!Number.isFinite(asset.size) || asset.size <= 0 || asset.size !== localSize) {
      fail(`${expected.name} size mismatch: local ${localSize}, public ${asset.size ?? "missing"}`);
    }
    await verifyGithubAttestation(
      ["release", "verify-asset", releaseTag, expected.path, "--repo", repository],
      `GitHub immutable release asset ${expected.name} attestation`,
    );
    console.log(`ok: GitHub Release ${releaseTag} has exact attested ${expected.name} (${asset.size} bytes)`);
  }
  console.log(`ok: ${release.url}`);
}

console.log("ok: public release state verified");
