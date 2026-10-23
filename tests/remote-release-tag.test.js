import { describe, expect, test } from "@jest/globals";
import { assertRemoteReleaseTag, resolveGitRefCommit } from "../scripts/verify-remote-release-tag.mjs";

const SHA = "a".repeat(40);
const TAG_SHA = "b".repeat(40);

describe("remote release tag immutability check", () => {
  test("accepts a lightweight tag at the exact release commit", async () => {
    await expect(
      assertRemoteReleaseTag({
        repository: "heznpc/Taxi",
        tag: "v1.0.0",
        expectedCommit: SHA,
        requestJson: async (path) => {
          expect(path).toBe("/repos/heznpc/Taxi/git/ref/tags/v1.0.0");
          return { object: { type: "commit", sha: SHA } };
        },
      }),
    ).resolves.toBe(SHA);
  });

  test("peels an annotated tag to its commit", async () => {
    await expect(
      resolveGitRefCommit({ type: "tag", sha: TAG_SHA }, async (sha) => {
        expect(sha).toBe(TAG_SHA);
        return { object: { type: "commit", sha: SHA } };
      }),
    ).resolves.toBe(SHA);
  });

  test("fails closed when the remote tag moved", async () => {
    await expect(
      assertRemoteReleaseTag({
        repository: "heznpc/Taxi",
        tag: "v1.0.0",
        expectedCommit: SHA,
        requestJson: async () => ({ object: { type: "commit", sha: "c".repeat(40) } }),
      }),
    ).rejects.toThrow("remote v1.0.0 points at");
  });

  test.each([
    [{ type: "tree", sha: SHA }, "unsupported object type"],
    [{ type: "tag", sha: TAG_SHA }, "cycle"],
  ])("rejects malformed or cyclic tag objects", async (object, message) => {
    await expect(resolveGitRefCommit(object, async () => ({ object }))).rejects.toThrow(message);
  });
});
