import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseNpmPackList } from "./npm-json.mjs";

function commandFailure(command, args, result) {
  const detail = String(result.stderr || result.stdout || "command failed")
    .trim()
    .slice(0, 2_000);
  return new Error(`${command} ${args.join(" ")} failed (${result.status ?? "signal"}): ${detail}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) throw commandFailure(command, args, result);
  return String(result.stdout ?? "");
}

function parsePackJson(output, packageRoot) {
  const [entry] = parseNpmPackList(output) ?? [];
  if (!entry) throw new Error(`npm pack did not return JSON for ${packageRoot}`);
  if (!entry.filename) throw new Error(`npm pack did not report a filename for ${packageRoot}`);
  return entry;
}

export function sha512Sri(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Read identity from an already-packed npm artifact without repacking it.
 *
 * `npm publish <tarball>` publishes these exact bytes, so release gates must
 * calculate registry SRI from the tarball that was exercised rather than from
 * a later `npm pack` of a possibly changed working tree.
 */
export function inspectPackageTarball(tarballPath, { tarCommand = "tar" } = {}) {
  const tarball = resolve(tarballPath);
  const bytes = readFileSync(tarball);
  const manifestText = run(tarCommand, ["-xOzf", tarball, "package/package.json"]);
  let pkg;
  try {
    pkg = JSON.parse(manifestText);
  } catch (error) {
    throw new Error(
      `package/package.json in ${tarball} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof pkg.name !== "string" || typeof pkg.version !== "string") {
    throw new Error(`package identity is missing in ${tarball}`);
  }
  return {
    name: pkg.name,
    version: pkg.version,
    gitHead: typeof pkg.gitHead === "string" ? pkg.gitHead : undefined,
    integrity: sha512Sri(bytes),
    sha256: sha256Hex(bytes),
    size: statSync(tarball).size,
    filename: basename(tarball),
    tarball,
  };
}

/** Pack exactly what `npm publish` would upload and calculate its registry SRI. */
export function inspectLocalPackage(packageRoot, { npmCommand = "npm" } = {}) {
  const root = resolve(packageRoot);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (typeof pkg.name !== "string" || typeof pkg.version !== "string") {
    throw new Error(`package identity is missing in ${join(root, "package.json")}`);
  }

  const destination = mkdtempSync(join(tmpdir(), "taxi-publish-identity-"));
  try {
    const output = run(npmCommand, ["pack", "--json", "--pack-destination", destination], { cwd: root });
    const packed = parsePackJson(output, root);
    const tarball = join(destination, packed.filename);
    const identity = inspectPackageTarball(tarball);
    if (identity.name !== pkg.name || identity.version !== pkg.version) {
      throw new Error(
        `packed identity mismatch for ${root}: expected ${pkg.name}@${pkg.version}, got ${identity.name}@${identity.version}`,
      );
    }
    return identity;
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
}

function parsePublishedJson(output, label) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(`${label} metadata was not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  // npm 12 wraps `npm view --json` results in a single-element array.
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  return {
    version: entry?.version,
    integrity: entry?.["dist.integrity"] ?? entry?.dist?.integrity,
    gitHead: entry?.gitHead,
  };
}

/** Query immutable registry identity. A network/auth failure is never treated as "missing". */
export function queryPublishedIdentity(name, version, { npmCommand = "npm" } = {}) {
  const spec = `${name}@${version}`;
  const args = ["view", spec, "version", "dist.integrity", "gitHead", "--json"];
  const result = spawnSync(npmCommand, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (/\bE404\b|404 Not Found|is not in this registry/i.test(output)) return null;
    throw commandFailure(npmCommand, args, result);
  }
  return parsePublishedJson(String(result.stdout ?? ""), spec);
}

export function assertPublishedIdentity({
  local,
  published,
  expectedGitHead,
  label = `${local.name}@${local.version}`,
}) {
  if (!published) throw new Error(`${label} is not published`);
  if (published.version !== local.version) {
    throw new Error(`${label} registry version differs from the local package`);
  }
  if (published.integrity !== local.integrity) {
    throw new Error(`${label} registry SRI differs from the local npm tarball`);
  }
  if (published.gitHead !== expectedGitHead) {
    throw new Error(`${label} registry gitHead differs from the expected release SHA`);
  }
  return true;
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Registry reads can lag a successful immutable publish. Retry only in the
 * explicitly post-publish path: a complete but mismatched SRI/gitHead remains
 * an immediate hard failure, while missing/incomplete/transient metadata gets
 * a bounded window to converge.
 */
export function waitForPublishedIdentity({
  local,
  expectedGitHead,
  timeoutMs = 60_000,
  retryDelayMs = 2_000,
  npmCommand = "npm",
  query = queryPublishedIdentity,
  now = Date.now,
  sleep = sleepSync,
  label = `${local.name}@${local.version}`,
}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("publish retry timeout must be non-negative");
  if (!Number.isFinite(retryDelayMs) || retryDelayMs <= 0) throw new Error("publish retry delay must be positive");

  const deadline = now() + timeoutMs;
  let lastPublished = null;
  let lastQueryError = null;

  while (true) {
    let published = null;
    try {
      published = query(local.name, local.version, { npmCommand });
    } catch (error) {
      lastQueryError = error;
    }

    if (published) {
      lastPublished = published;
      if (published.version !== undefined && published.version !== local.version) {
        assertPublishedIdentity({ local, published, expectedGitHead, label });
      }
      if (published.integrity !== undefined && published.integrity !== local.integrity) {
        assertPublishedIdentity({ local, published, expectedGitHead, label });
      }
      if (published.gitHead !== undefined && published.gitHead !== expectedGitHead) {
        assertPublishedIdentity({ local, published, expectedGitHead, label });
      }
      if (published.version && published.integrity && published.gitHead) {
        assertPublishedIdentity({ local, published, expectedGitHead, label });
        return published;
      }
    }

    const remaining = deadline - now();
    if (remaining <= 0) break;
    sleep(Math.min(retryDelayMs, remaining));
  }

  if (lastPublished) assertPublishedIdentity({ local, published: lastPublished, expectedGitHead, label });

  // Reaching here means the publish itself SUCCEEDED and only the registry read
  // path failed to confirm it in time. Say so explicitly: the previous wording
  // ("was not visible") read as a failed publish and sent an operator through
  // thirteen re-runs of an already-shipped release. Re-running is still the
  // correct recovery — publish is idempotent and skips packages whose registry
  // SRI and gitHead already match — but only once propagation catches up.
  const resume =
    "the publish succeeded; this is a registry read-path (propagation) timeout, not a failed publish. " +
    "Re-run once the version resolves via `npm view` — already-published packages are skipped.";
  if (lastQueryError)
    throw new Error(`${label} registry metadata remained unavailable after bounded retry — ${resume}`);
  throw new Error(`${label} was not visible after bounded registry retry — ${resume}`);
}

export function verifyPublishedIdentity({
  packageRoot,
  tarballPath,
  expectedGitHead,
  allowMissing = false,
  npmCommand = "npm",
  retryTimeoutMs = 0,
}) {
  if (!/^[0-9a-f]{40}$/i.test(expectedGitHead)) {
    throw new Error("expected release SHA must be a full 40-character Git commit SHA");
  }
  const local = tarballPath ? inspectPackageTarball(tarballPath) : inspectLocalPackage(packageRoot, { npmCommand });
  if (tarballPath && packageRoot) {
    const root = resolve(packageRoot);
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (local.name !== pkg.name || local.version !== pkg.version) {
      throw new Error(
        `npm tarball identity differs from ${join(root, "package.json")}: ` +
          `expected ${pkg.name}@${pkg.version}, got ${local.name}@${local.version}`,
      );
    }
  }
  if (tarballPath && local.gitHead !== expectedGitHead) {
    throw new Error(
      `npm tarball gitHead differs from the expected release SHA: ` +
        `expected ${expectedGitHead}, got ${local.gitHead ?? "missing"}`,
    );
  }
  if (retryTimeoutMs > 0) {
    if (allowMissing) throw new Error("allowMissing cannot be combined with post-publish registry retry");
    const publishedIdentity = waitForPublishedIdentity({
      local,
      expectedGitHead,
      timeoutMs: retryTimeoutMs,
      npmCommand,
    });
    return { published: true, local, publishedIdentity };
  }
  const published = queryPublishedIdentity(local.name, local.version, { npmCommand });
  if (!published) {
    if (allowMissing) return { published: false, local };
    throw new Error(`${local.name}@${local.version} is not published`);
  }
  assertPublishedIdentity({ local, published, expectedGitHead });
  return { published: true, local, publishedIdentity: published };
}
