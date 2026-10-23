#!/usr/bin/env node

import { fileURLToPath } from "node:url";

const API_VERSION = "2022-11-28";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function resolveGitRefCommit(initialObject, loadTagObject) {
  let object = initialObject;
  const visited = new Set();
  for (let depth = 0; depth < 8; depth += 1) {
    assert(object && typeof object === "object", "remote tag object is missing");
    assert(/^[0-9a-f]{40}$/i.test(object.sha ?? ""), "remote tag object SHA is invalid");
    if (object.type === "commit") return object.sha.toLowerCase();
    assert(object.type === "tag", `remote release ref resolves to unsupported object type ${object.type ?? "unknown"}`);
    const tagSha = object.sha.toLowerCase();
    assert(!visited.has(tagSha), "remote annotated tag chain contains a cycle");
    visited.add(tagSha);
    const tag = await loadTagObject(tagSha);
    object = tag?.object;
  }
  throw new Error("remote annotated tag chain exceeds the supported depth");
}

export async function assertRemoteReleaseTag({ repository, tag, expectedCommit, requestJson }) {
  assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), "repository must be owner/name");
  assert(
    /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(tag),
    "tag must be canonical vMAJOR.MINOR.PATCH",
  );
  assert(/^[0-9a-f]{40}$/i.test(expectedCommit), "expected commit must be a full Git SHA");
  const ref = await requestJson(`/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`);
  const commit = await resolveGitRefCommit(ref?.object, (sha) => requestJson(`/repos/${repository}/git/tags/${sha}`));
  assert(
    commit === expectedCommit.toLowerCase(),
    `remote ${tag} points at ${commit}, not ${expectedCommit.toLowerCase()}`,
  );
  return commit;
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
  if (!token) throw new Error("GH_TOKEN or GITHUB_TOKEN is required");

  const requestJson = async (path) => {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": API_VERSION,
      },
    });
    if (!response.ok) throw new Error(`GitHub tag API returned HTTP ${response.status}`);
    return response.json();
  };

  const commit = await assertRemoteReleaseTag({ repository, tag, expectedCommit, requestJson });
  console.log(`ok: remote ${tag} still resolves to release commit ${commit}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`release-tag: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
