import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const buildMcpb = readFileSync(new URL("../scripts/build-mcpb.mjs", import.meta.url), "utf8");
const verifyPackage = readFileSync(new URL("../scripts/verify-published-package.mjs", import.meta.url), "utf8");
const verifyMcpb = readFileSync(new URL("../scripts/verify-mcpb-artifact.mjs", import.meta.url), "utf8");
const preflight = readFileSync(new URL("../scripts/release-preflight.mjs", import.meta.url), "utf8");
const moduleLoader = readFileSync(new URL("../src/shared/module-loader.ts", import.meta.url), "utf8");

describe("universal shipped distribution", () => {
  test("npm lifecycle no longer strips non-core module entrypoints", () => {
    expect(pkg.scripts.prepack).toBe("npm run build");
    expect(pkg.scripts.postpack).toBeUndefined();
    expect(pkg.scripts.prepack).not.toContain("slim-root-package");
  });

  test("universal bundled loading has no external-package selection path", () => {
    expect(moduleLoader).toContain("Taxi 1.0 ships every standard module in the root runtime");
    expect(moduleLoader).not.toContain("TAXI_ADDON_PACKAGE_MODE");
    expect(moduleLoader).not.toContain("node_modules");
  });

  test("MCPB copies the complete dist tree without applying the slim-root transform", () => {
    expect(buildMcpb).toContain('cpSync(join(ROOT, "dist"), join(serverDir, "dist"), { recursive: true })');
    expect(buildMcpb).not.toContain('"scripts/slim-root-package.mjs"');
  });

  test("MCPB installs and verifies the exact reviewed production lock graph", () => {
    expect(buildMcpb).toContain('cpSync(join(ROOT, "package-lock.json"), join(serverDir, "package-lock.json"))');
    expect(buildMcpb).toContain('["ci", "--omit=dev"');
    expect(buildMcpb).not.toContain('["install", "--omit=dev"');
    expect(buildMcpb).toContain("compareProductionPackageGraphs(expectedGraph, installedGraph)");
    expect(verifyMcpb).toContain("compareProductionPackageGraphs(expectedGraph, installedGraph)");
  });

  test("MCPB normalizes archive metadata and entry order for reproducible release retries", () => {
    expect(buildMcpb).toContain('const ARCHIVE_TIMESTAMP = new Date("2000-01-01T00:00:00.000Z")');
    expect(buildMcpb).toContain("normalizedArchiveEntries(BUILD_DIR)");
    expect(buildMcpb).toContain('["-X", "-y", "-q", `taxi-${pkg.version}.mcpb`, "-@"]');
  });

  test("npm and MCPB artifact gates boot full/full and assert cross-pack tools", () => {
    for (const script of [verifyPackage, verifyMcpb]) {
      expect(script).toContain("const MIN_FULL_TOOLS = 290;");
      expect(script).toContain('TAXI_PROFILE: "full"');
      expect(script).toContain('TAXI_TOOL_EXPOSURE: "full"');
      expect(script).not.toContain("TAXI_ADDON_PACKAGE_MODE");
      expect(script).toContain('"numbers_set_cell"');
      expect(script).toContain('"gws_sheets_read"');
      expect(script).toContain('"memory_query"');
    }
  });

  test("release preflight verifies both self-contained artifacts", () => {
    expect(preflight).toContain("buildCanonicalNpmArtifact(gitHead)");
    expect(preflight).toContain('"--tarball"');
    expect(preflight).toContain('"--expected-git-head"');
    expect(preflight).toContain('"--metadata-out"');
    expect(preflight).toContain("stagedManifest.gitHead = gitHead");
    expect(preflight).toContain('run("npm", ["run", "verify:mcpb"]);');
    expect(preflight).toContain("universal publish surface");
    expect(preflight).toContain("universal .mcpb");
  });
});
