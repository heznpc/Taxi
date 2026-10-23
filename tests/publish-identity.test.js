import { afterEach, describe, expect, test } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPublishedIdentity,
  inspectPackageTarball,
  sha256Hex,
  sha512Sri,
  verifyPublishedIdentity,
  waitForPublishedIdentity,
} from "../scripts/lib/publish-identity.mjs";

const local = {
  name: "taxi",
  version: "2.16.0",
  integrity: "sha512-local",
};
const expectedGitHead = "a".repeat(40);
const temporaryDirectories = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function createTarball(gitHead = expectedGitHead) {
  const root = mkdtempSync(join(tmpdir(), "taxi-publish-artifact-test-"));
  temporaryDirectories.push(root);
  const packageDirectory = join(root, "package");
  mkdirSync(packageDirectory);
  writeFileSync(
    join(packageDirectory, "package.json"),
    `${JSON.stringify({ name: "taxi", version: "2.16.0", gitHead }, null, 2)}\n`,
  );
  const tarball = join(root, "taxi-2.16.0.tgz");
  const packed = spawnSync("tar", ["-czf", tarball, "-C", root, "package"], { encoding: "utf8" });
  if (packed.status !== 0) throw new Error(packed.stderr || "could not create npm tarball fixture");
  return { root, packageDirectory, tarball };
}

describe("immutable npm publish identity", () => {
  test("computes standard SHA-512 SRI", () => {
    expect(sha512Sri(Buffer.from("Taxi", "utf8"))).toBe(
      "sha512-leqPPDIQhS5oTeA2pY9gHHDYbCKDz8Isag+YoUMpGqL5dd0ELG+utNFSSVIoKkzXZuCODPpGYNEC61Mpt0KMPw==",
    );
  });

  test("reads gitHead and both hashes from an exact npm tarball", () => {
    const { tarball } = createTarball();
    const inspected = inspectPackageTarball(tarball);
    expect(inspected).toMatchObject({
      name: "taxi",
      version: "2.16.0",
      gitHead: expectedGitHead,
      filename: "taxi-2.16.0.tgz",
    });
    const bytes = readFileSync(tarball);
    expect(inspected.integrity).toBe(sha512Sri(bytes));
    expect(inspected.sha256).toBe(sha256Hex(bytes));
  });

  test("rejects an exact npm tarball whose embedded gitHead differs before registry access", () => {
    const { packageDirectory, tarball } = createTarball("b".repeat(40));
    expect(() =>
      verifyPublishedIdentity({
        packageRoot: packageDirectory,
        tarballPath: tarball,
        expectedGitHead,
        allowMissing: true,
      }),
    ).toThrow(/tarball gitHead differs/);
  });

  test("allows an idempotent skip only for exact version, SRI, and gitHead", () => {
    expect(
      assertPublishedIdentity({
        local,
        expectedGitHead,
        published: { version: local.version, integrity: local.integrity, gitHead: expectedGitHead },
      }),
    ).toBe(true);
  });

  test.each([
    ["version", { version: "2.15.0", integrity: local.integrity, gitHead: expectedGitHead }],
    ["SRI", { version: local.version, integrity: "sha512-other", gitHead: expectedGitHead }],
    ["gitHead", { version: local.version, integrity: local.integrity, gitHead: "b".repeat(40) }],
  ])("fails closed on %s mismatch", (_label, published) => {
    expect(() => assertPublishedIdentity({ local, published, expectedGitHead })).toThrow();
  });

  test("bounded post-publish retry tolerates network, missing, and incomplete metadata", () => {
    let clock = 0;
    const responses = [
      new Error("temporary registry failure"),
      null,
      { version: local.version, integrity: local.integrity },
      { version: local.version, integrity: local.integrity, gitHead: expectedGitHead },
    ];
    const published = waitForPublishedIdentity({
      local,
      expectedGitHead,
      timeoutMs: 30,
      retryDelayMs: 10,
      now: () => clock,
      sleep: (milliseconds) => {
        clock += milliseconds;
      },
      query: () => {
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return response;
      },
    });
    expect(published.gitHead).toBe(expectedGitHead);
    expect(clock).toBe(30);
  });

  // Regression: the v2.16.2 release shipped every package, but a bare "was not
  // visible" timeout read as a failed publish and drove thirteen re-runs of an
  // already-published release. The propagation timeout must name itself as a
  // read-path timeout and state that re-running skips published packages.
  test("propagation timeout reports a shipped publish, not a failed one", () => {
    let clock = 0;
    expect(() =>
      waitForPublishedIdentity({
        local,
        expectedGitHead,
        timeoutMs: 100,
        retryDelayMs: 50,
        now: () => clock,
        sleep: (milliseconds) => {
          clock += milliseconds;
        },
        query: () => null, // registry read path still 404s after a successful publish
      }),
    ).toThrow(/publish succeeded.*propagation.*Re-run.*skipped/s);
  });

  test("post-publish retry never waits through a complete identity mismatch", () => {
    let sleeps = 0;
    expect(() =>
      waitForPublishedIdentity({
        local,
        expectedGitHead,
        timeoutMs: 60_000,
        query: () => ({ version: local.version, integrity: "sha512-other", gitHead: expectedGitHead }),
        sleep: () => {
          sleeps += 1;
        },
      }),
    ).toThrow(/SRI/);
    expect(sleeps).toBe(0);
  });
});
