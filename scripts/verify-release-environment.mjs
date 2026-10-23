#!/usr/bin/env node

function globMatches(pattern, value) {
  let source = "^";
  for (const character of pattern) {
    if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`${source}$`).test(value);
}

export function assertReleaseEnvironmentProtection(
  environment,
  policies,
  expectedRef,
  environmentName = "release",
  expectedRefType = "tag",
) {
  if (expectedRefType !== "tag" && expectedRefType !== "branch") {
    throw new Error("expected deployment ref type must be tag or branch");
  }
  const expectedRefTypePlural = expectedRefType === "branch" ? "branches" : "tags";
  const reviewerRule = environment?.protection_rules?.find((rule) => rule.type === "required_reviewers");
  if (!reviewerRule || !Array.isArray(reviewerRule.reviewers) || reviewerRule.reviewers.length === 0) {
    throw new Error(`${environmentName} environment must require an explicit reviewer`);
  }
  if (environment.can_admins_bypass !== false) {
    throw new Error(`${environmentName} environment must disable administrator bypass`);
  }
  if (environment.deployment_branch_policy?.custom_branch_policies !== true) {
    throw new Error(`${environmentName} environment must use a custom deployment tag policy`);
  }
  const deploymentPolicies = policies?.branch_policies ?? policies ?? [];
  if (!Number.isSafeInteger(policies?.total_count) || policies.total_count !== deploymentPolicies.length) {
    throw new Error(`${environmentName} environment deployment policies response is incomplete`);
  }
  if (!Array.isArray(deploymentPolicies) || deploymentPolicies.some((policy) => policy?.type !== expectedRefType)) {
    throw new Error(`${environmentName} environment deployment policies must allow ${expectedRefTypePlural} only`);
  }
  if (deploymentPolicies.length !== 1) {
    throw new Error(`${environmentName} environment must have exactly one deployment ${expectedRefType} policy`);
  }
  const [policy] = deploymentPolicies;
  const allowedPolicyNames = expectedRefType === "tag" ? new Set([expectedRef, "v*.*.*"]) : new Set([expectedRef]);
  if (
    typeof policy?.name !== "string" ||
    !allowedPolicyNames.has(policy.name) ||
    !globMatches(policy.name, expectedRef)
  ) {
    throw new Error(
      `${environmentName} environment ${expectedRefType} policy is broader than the approved release ref`,
    );
  }
  return true;
}

async function githubJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub environment API returned HTTP ${response.status}`);
  return response.json();
}

function argument(name, fallback = "") {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? "") : fallback;
}

async function main() {
  const repository = argument("--repo", process.env.GITHUB_REPOSITORY ?? "");
  const expectedRefType = argument("--ref-type", "tag");
  const expectedRef = argument("--ref-name", argument("--tag", process.env.RELEASE_TAG ?? ""));
  const environmentName = argument("--environment", "release");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("--repo owner/name is required");
  if (!/^[A-Za-z0-9_.-]+$/.test(environmentName)) throw new Error("--environment is invalid");
  if (expectedRefType !== "tag" && expectedRefType !== "branch") {
    throw new Error("--ref-type must be tag or branch");
  }
  if (expectedRefType === "tag" && !/^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(expectedRef)) {
    throw new Error("--ref-name/--tag must be a canonical vMAJOR.MINOR.PATCH release tag");
  }
  if (expectedRefType === "branch" && !/^[A-Za-z0-9](?:[A-Za-z0-9._\/-]*[A-Za-z0-9])?$/.test(expectedRef)) {
    throw new Error("--ref-name must be a safe branch name");
  }

  const base = `https://api.github.com/repos/${repository}`;
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  const environmentPath = `${base}/environments/${encodeURIComponent(environmentName)}`;
  const environment = await githubJson(environmentPath, token);
  const hasReviewers = environment?.protection_rules?.some(
    (rule) => rule.type === "required_reviewers" && Array.isArray(rule.reviewers) && rule.reviewers.length > 0,
  );
  if (
    !hasReviewers ||
    environment.can_admins_bypass !== false ||
    environment.deployment_branch_policy?.custom_branch_policies !== true
  ) {
    // Fail on the environment invariant itself before querying a custom-policy
    // collection that GitHub returns as 404 when custom policies are disabled.
    assertReleaseEnvironmentProtection(
      environment,
      { total_count: 0, branch_policies: [] },
      expectedRef,
      environmentName,
      expectedRefType,
    );
  }
  const policies = await githubJson(`${environmentPath}/deployment-branch-policies?per_page=100`, token);
  assertReleaseEnvironmentProtection(environment, policies, expectedRef, environmentName, expectedRefType);
  console.log(
    `ok: ${environmentName} environment requires review, disables admin bypass, and restricts deployment to this ${expectedRefType}`,
  );
}

if (process.argv[1]?.endsWith("verify-release-environment.mjs")) {
  main().catch((error) => {
    console.error(`release-environment: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
