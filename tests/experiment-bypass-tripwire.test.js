/**
 * Experiment-bypass tripwire.
 *
 * The ablation harness (separate, later PR) gets test-gated, EXPERIMENT-ONLY bypass
 * flags for the three hardcoded defenses (Safari egress guard, untrusted fencing /
 * taint, symlink-escape guard). This test makes sure that surface never leaks into
 * Taxi's shipped product. The product Task Dashboard now has its own src/harness
 * module; only its reviewed files are allowed, not an arbitrary harness subtree.
 * Bypasses remain forbidden in all source, including those product files, and in
 * the published file set, the .mcpb builder, and product docs.
 *
 * Design ref: docs/experiments/harness-safety-preflight.md §1.
 */
import { describe, test, expect } from "@jest/globals";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Reserved env namespaces that must never appear on the public (src-read) surface.
const RESERVED_ENV = /TAXI_(EXPERIMENT|ABLATION|BYPASS|UNSAFE|DANGEROUS)_/;
// Disabling a *defense* (not a module/poller) via env is forbidden on the public surface.
const DEFENSE_DISABLE_ENV = /TAXI_DISABLE_(EGRESS|FENCE|FENCING|TAINT|SYMLINK|SSRF|GUARD|HITL|AUDIT)\b/;
// Experiment paths must not ship or live under src/. The Task Dashboard is a
// product module, not the defense-ablation harness. Additions require review;
// never replace this file list with a startsWith("src/harness/") exemption.
const EXP_PATH = /experiment|harness|ablation/i;
const PRODUCT_TASK_HARNESS_MODULES = ["catalog", "codex-client", "dashboard", "host", "routes", "store", "tools"];
const PRODUCT_TASK_HARNESS_FILES = new Set(
  PRODUCT_TASK_HARNESS_MODULES.flatMap((name) => [`src/harness/${name}.ts`, `dist/harness/${name}.js`]),
);

function isUnreviewedExperimentPath(path, directory = false) {
  if (directory && (path === "src/harness" || path === "dist/harness")) return false;
  return EXP_PATH.test(path) && !(PRODUCT_TASK_HARNESS_FILES.has(path) && !directory);
}
// Narrow, defense-context bypass phrase for docs (must NOT match benign "bypasses JXA").
const DEFENSE_BYPASS_PHRASE = /defense[-\s]?bypass|TAXI_(EXPERIMENT|ABLATION|BYPASS|UNSAFE|DANGEROUS)_/i;

function scanSrc() {
  const directories = [];
  const files = [];
  let tsText = "";
  const stack = [join(ROOT, "src")];
  while (stack.length) {
    const d = stack.pop();
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      const path = relative(ROOT, full).split(sep).join("/");
      if (e.isDirectory()) {
        directories.push(path);
        stack.push(full);
      } else {
        files.push(path);
        if (e.name.endsWith(".ts")) tsText += readFileSync(full, "utf8") + "\n";
      }
    }
  }
  return { directories, files, tsText };
}

describe("experiment-bypass tripwire", () => {
  const { directories, files: sourceFiles, tsText } = scanSrc();
  const envTokens = [...new Set(tsText.match(/TAXI_[A-Z0-9_]+/g) ?? [])];

  test("no reserved experiment/bypass env var is read by shipped src/", () => {
    const leaked = envTokens.filter((t) => RESERVED_ENV.test(t) || DEFENSE_DISABLE_ENV.test(t));
    expect(leaked).toEqual([]);
  });

  test("src/ contains only the reviewed product harness files, with no experiment directories or files", () => {
    expect(directories.filter((path) => isUnreviewedExperimentPath(path, true))).toEqual([]);
    expect(sourceFiles.filter((path) => isUnreviewedExperimentPath(path))).toEqual([]);
    expect(sourceFiles.filter((path) => path.startsWith("src/harness/")).sort()).toEqual(
      PRODUCT_TASK_HARNESS_MODULES.map((name) => `src/harness/${name}.ts`).sort(),
    );
  });

  test("the product exception rejects new, nested and lookalike harness paths", () => {
    for (const path of [
      "src/harness/new-module.ts",
      "dist/harness/new-module.js",
      "src/harness/experiment.ts",
      "dist/harness/ablation.js",
      "src/harness/nested/catalog.ts",
      "dist/harness/catalog.js.map",
      "src/other/harness/catalog.ts",
      "dist/harness-extra/catalog.js",
      "src/experiments.ts",
      "dist/ablation.js",
    ]) {
      expect(isUnreviewedExperimentPath(path)).toBe(true);
    }
    for (const path of ["src/harness/nested", "src/other/harness", "src/harness/catalog.ts", "dist/experiments"]) {
      expect(isUnreviewedExperimentPath(path, true)).toBe(true);
    }
    for (const path of PRODUCT_TASK_HARNESS_FILES) expect(isUnreviewedExperimentPath(path)).toBe(false);
  });

  test("reserved bypass controls remain forbidden inside reviewed product files", () => {
    // The path exception never exempts content from the all-source env scan.
    expect(sourceFiles).toContain("src/harness/host.ts");
    expect(envTokens).toContain("TAXI_CODEX_BINARY");
    for (const token of ["TAXI_EXPERIMENT_EGRESS", "TAXI_ABLATION_MODE", "TAXI_BYPASS_GUARD", "TAXI_DISABLE_HITL"]) {
      expect(RESERVED_ENV.test(token) || DEFENSE_DISABLE_ENV.test(token)).toBe(true);
    }
  });

  test("package.json publishes no experiment path (files stays dist-only)", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const files = pkg.files ?? [];
    expect(files).toContain("dist");
    expect(files.filter((f) => EXP_PATH.test(f))).toEqual([]);
  });

  test(".mcpb builder ships only dist/, not an experiment path", () => {
    const build = readFileSync(join(ROOT, "scripts", "build-mcpb.mjs"), "utf8");
    expect(build).toContain('cpSync(join(ROOT, "dist")');
    expect(EXP_PATH.test(build)).toBe(false);
  });

  test("product docs do not expose defense-bypass identifiers", () => {
    const productDocs = ["README.md", "llms.txt", "llms-full.txt", join("docs", "index.html")];
    for (const rel of productDocs) {
      const abs = join(ROOT, rel);
      if (!existsSync(abs)) continue;
      const text = readFileSync(abs, "utf8");
      expect(DEFENSE_BYPASS_PHRASE.test(text)).toBe(false);
      expect(DEFENSE_DISABLE_ENV.test(text)).toBe(false);
    }
  });

  // The .mcpb manifest template is where a reserved env / user_config key would
  // actually be authored (it renders into the shipped manifest.json). The source
  // scan above never opens it — close that hole.
  test("mcpb manifest template carries no reserved bypass env / user_config key", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "mcpb", "manifest.template.json"), "utf8"));
    const env = manifest.server?.mcp_config?.env ?? {};
    const surface = [
      ...Object.keys(env),
      ...Object.values(env).map(String),
      ...Object.keys(manifest.user_config ?? {}),
    ];
    const leaked = surface.filter((s) => RESERVED_ENV.test(s) || DEFENSE_DISABLE_ENV.test(s));
    expect(leaked).toEqual([]);
  });

  // The actual published payload (not just the `files` array) must carry no
  // experiment path. `--ignore-scripts` keeps it side-effect-free and offline.
  test("npm pack payload includes only the reviewed product harness, without experiment paths", () => {
    const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const files = (JSON.parse(out)[0]?.files ?? []).map((f) => f.path);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((path) => isUnreviewedExperimentPath(path))).toEqual([]);
    expect(files.filter((path) => path.startsWith("dist/harness/")).sort()).toEqual(
      PRODUCT_TASK_HARNESS_MODULES.map((name) => `dist/harness/${name}.js`).sort(),
    );
    // An old or independently altered build must not smuggle bypass controls
    // into an otherwise permitted file while the source scan remains clean.
    for (const path of files.filter((file) => PRODUCT_TASK_HARNESS_FILES.has(file))) {
      const shippedText = readFileSync(join(ROOT, path), "utf8");
      const tokens = shippedText.match(/TAXI_[A-Z0-9_]+/g) ?? [];
      expect(tokens.filter((token) => RESERVED_ENV.test(token) || DEFENSE_DISABLE_ENV.test(token))).toEqual([]);
    }
  });
});
