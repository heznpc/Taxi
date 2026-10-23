#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function classifyExistingGithubRelease(release, { tag, expectedCommit }) {
  assert(release && typeof release === "object", "existing GitHub Release response is malformed");
  assert(release.tag_name === tag, `existing GitHub Release tag is ${release.tag_name ?? "missing"}, not ${tag}`);
  assert(release.draft === false, `existing GitHub Release ${tag} is a draft and must be resolved before publish`);
  assert(release.prerelease === false, `existing GitHub Release ${tag} is unexpectedly a prerelease`);
  assert(
    release.target_commitish === expectedCommit,
    `existing GitHub Release ${tag} targets ${release.target_commitish ?? "missing"}, not ${expectedCommit}`,
  );
  assert(release.immutable === true, `existing GitHub Release ${tag} is mutable; refuse to overwrite or finalize it`);
  return "immutable";
}

export function classifyListedGithubReleases(releases, { tag, expectedCommit }) {
  assert(Array.isArray(releases), "GitHub Release list response is malformed");
  const matching = releases.filter((release) => release?.tag_name === tag);
  assert(matching.length <= 1, `multiple GitHub Releases claim ${tag}`);
  if (matching.length === 0) return "missing";
  return classifyExistingGithubRelease(matching[0], { tag, expectedCommit });
}

async function fetchReleasePage(repository, token, page) {
  const response = await fetch(`https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub Release list API returned HTTP ${response.status}`);
  const releases = await response.json();
  assert(Array.isArray(releases), "GitHub Release list response is malformed");
  return releases;
}

function argument(name, fallback = "") {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? "") : fallback;
}

async function main() {
  const repository = argument("--repo", process.env.GITHUB_REPOSITORY ?? "");
  const tag = argument("--tag", process.env.RELEASE_TAG ?? "");
  const expectedCommit = argument("--expected-sha", process.env.RELEASE_SHA ?? "");
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), "--repo owner/name is required");
  assert(
    /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(tag),
    "--tag must be canonical vMAJOR.MINOR.PATCH",
  );
  assert(/^[0-9a-f]{40}$/i.test(expectedCommit), "--expected-sha must be a full Git commit SHA");
  assert(token, "GH_TOKEN or GITHUB_TOKEN is required");

  const response = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  let state;
  if (response.status === 404) {
    // The tag endpoint deliberately hides drafts. Enumerate the authenticated
    // release collection before calling the publishing action so an interrupted
    // draft can never be silently reused and made immutable with stale assets.
    const releases = [];
    for (let page = 1; page <= 100; page += 1) {
      const entries = await fetchReleasePage(repository, token, page);
      releases.push(...entries);
      if (entries.length < 100) break;
      assert(page < 100, "GitHub Release pagination exceeded the safety bound");
    }
    state = classifyListedGithubReleases(releases, {
      tag,
      expectedCommit: expectedCommit.toLowerCase(),
    });
  } else {
    if (!response.ok) throw new Error(`GitHub Release API returned HTTP ${response.status}`);
    state = classifyExistingGithubRelease(await response.json(), {
      tag,
      expectedCommit: expectedCommit.toLowerCase(),
    });
  }

  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `state=${state}\n`);
  console.log(
    state === "missing"
      ? `ok: GitHub Release ${tag} does not exist and may be created by the protected publish step`
      : `ok: existing GitHub Release ${tag} is published and immutable; exact assets must verify before resume`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`existing-release: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
