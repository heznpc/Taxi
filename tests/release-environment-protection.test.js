import { describe, expect, test } from "@jest/globals";
import { assertReleaseEnvironmentProtection } from "../scripts/verify-release-environment.mjs";

const protectedEnvironment = {
  can_admins_bypass: false,
  protection_rules: [{ type: "required_reviewers", reviewers: [{ type: "User" }] }],
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
};
const policies = { total_count: 1, branch_policies: [{ name: "v*.*.*", type: "tag" }] };

describe("signed release environment gate", () => {
  test("accepts reviewed, no-bypass, tag-restricted configuration", () => {
    expect(assertReleaseEnvironmentProtection(protectedEnvironment, policies, "v2.16.0")).toBe(true);
    expect(assertReleaseEnvironmentProtection(protectedEnvironment, policies, "v2.16.0", "mcp-registry")).toBe(true);
  });

  test("accepts a reviewed main-only publish environment", () => {
    const branchPolicies = { total_count: 1, branch_policies: [{ name: "main", type: "branch" }] };
    expect(assertReleaseEnvironmentProtection(protectedEnvironment, branchPolicies, "main", "npm", "branch")).toBe(
      true,
    );
  });

  test("does not confuse a branch-gated job with a tag-gated job", () => {
    const branchPolicies = { total_count: 1, branch_policies: [{ name: "main", type: "branch" }] };
    expect(() => assertReleaseEnvironmentProtection(protectedEnvironment, branchPolicies, "v1.0.0")).toThrow(
      "must allow tags only",
    );
    expect(() => assertReleaseEnvironmentProtection(protectedEnvironment, policies, "main", "npm", "branch")).toThrow(
      "must allow branches only",
    );
  });

  test.each([
    [
      "an extra branch policy",
      "main",
      "npm",
      "branch",
      {
        total_count: 2,
        branch_policies: [
          { name: "main", type: "branch" },
          { name: "release", type: "branch" },
        ],
      },
    ],
    [
      "a wildcard branch policy",
      "main",
      "npm",
      "branch",
      { total_count: 1, branch_policies: [{ name: "*", type: "branch" }] },
    ],
    [
      "an extra tag policy",
      "v1.0.0",
      "release",
      "tag",
      {
        total_count: 2,
        branch_policies: [
          { name: "v*.*.*", type: "tag" },
          { name: "*", type: "tag" },
        ],
      },
    ],
    [
      "a wildcard tag policy",
      "v1.0.0",
      "release",
      "tag",
      { total_count: 1, branch_policies: [{ name: "*", type: "tag" }] },
    ],
  ])("rejects same-type overbroad deployment configuration: %s", (_label, ref, environment, type, branchPolicies) => {
    expect(() =>
      assertReleaseEnvironmentProtection(protectedEnvironment, branchPolicies, ref, environment, type),
    ).toThrow();
  });

  test("names the exact protected environment in failures", () => {
    expect(() =>
      assertReleaseEnvironmentProtection(
        { ...protectedEnvironment, protection_rules: [] },
        policies,
        "v2.16.0",
        "mcp-registry",
      ),
    ).toThrow("mcp-registry environment must require an explicit reviewer");
  });

  test.each([
    ["missing reviewers", { ...protectedEnvironment, protection_rules: [] }, policies],
    ["admin bypass", { ...protectedEnvironment, can_admins_bypass: true }, policies],
    ["open deployment refs", { ...protectedEnvironment, deployment_branch_policy: null }, policies],
    [
      "branch policy instead of tag",
      protectedEnvironment,
      { total_count: 1, branch_policies: [{ name: "v*.*.*", type: "branch" }] },
    ],
    [
      "mixed branch and tag policies",
      protectedEnvironment,
      {
        total_count: 2,
        branch_policies: [
          { name: "v*.*.*", type: "tag" },
          { name: "main", type: "branch" },
        ],
      },
    ],
    [
      "nonmatching tag policy",
      protectedEnvironment,
      { total_count: 1, branch_policies: [{ name: "release-*", type: "tag" }] },
    ],
  ])("fails closed for %s", (_label, environment, branchPolicies) => {
    expect(() => assertReleaseEnvironmentProtection(environment, branchPolicies, "v2.16.0")).toThrow();
  });

  test.each([
    ["missing total count", { branch_policies: [{ name: "v*.*.*", type: "tag" }] }],
    ["truncated first page", { total_count: 101, branch_policies: [{ name: "v*.*.*", type: "tag" }] }],
    ["non-numeric total count", { total_count: "1", branch_policies: [{ name: "v*.*.*", type: "tag" }] }],
  ])("fails closed for an incomplete policy collection: %s", (_label, branchPolicies) => {
    expect(() => assertReleaseEnvironmentProtection(protectedEnvironment, branchPolicies, "v2.16.0")).toThrow(
      "deployment policies response is incomplete",
    );
  });
});
