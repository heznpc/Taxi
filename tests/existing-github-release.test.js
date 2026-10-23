import { describe, expect, test } from "@jest/globals";
import {
  classifyExistingGithubRelease,
  classifyListedGithubReleases,
} from "../scripts/classify-existing-github-release.mjs";

const SHA = "a".repeat(40);
const release = {
  tag_name: "v1.0.0",
  target_commitish: SHA,
  draft: false,
  prerelease: false,
  immutable: true,
};

describe("existing GitHub Release resume classification", () => {
  test("accepts only the exact published immutable release", () => {
    expect(classifyExistingGithubRelease(release, { tag: "v1.0.0", expectedCommit: SHA })).toBe("immutable");
  });

  test.each([
    ["draft", { draft: true }],
    ["prerelease", { prerelease: true }],
    ["mutable", { immutable: false }],
    ["wrong tag", { tag_name: "v1.0.1" }],
    ["wrong commit", { target_commitish: "b".repeat(40) }],
  ])("rejects a pre-existing %s release", (_label, replacement) => {
    expect(() =>
      classifyExistingGithubRelease({ ...release, ...replacement }, { tag: "v1.0.0", expectedCommit: SHA }),
    ).toThrow();
  });

  test("detects and rejects a draft hidden from the release-by-tag endpoint", () => {
    expect(() =>
      classifyListedGithubReleases([{ ...release, draft: true, immutable: false }], {
        tag: "v1.0.0",
        expectedCommit: SHA,
      }),
    ).toThrow(/draft/);
    expect(
      classifyListedGithubReleases([{ ...release, tag_name: "v0.9.0" }], {
        tag: "v1.0.0",
        expectedCommit: SHA,
      }),
    ).toBe("missing");
  });
});
