#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SIGNED_RELEASE_RECEIPT_SCHEMA, SIGNED_RELEASE_WORKFLOW } from "./create-signed-release-receipt.mjs";

const TAXI_SIGNING_TEAM_ID = "XS7HJJN7GC";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function workflowPathMatches(value, tag) {
  if (typeof value !== "string") return false;
  if (value === SIGNED_RELEASE_WORKFLOW) return true;
  const [path, ref, ...extra] = value.split("@");
  return path === SIGNED_RELEASE_WORKFLOW && extra.length === 0 && (ref === tag || ref === `refs/tags/${tag}`);
}

export function verifySignedReleaseReceipt({
  receiptBytes,
  archivePath,
  expectedReceiptSha256,
  expectedRepository,
  expectedRunId,
  expectedHeadSha,
  expectedTag,
  expectedVersion,
  workflowRun,
}) {
  assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(expectedRepository), "expected repository is invalid");
  assert(/^[1-9][0-9]*$/.test(String(expectedRunId)), "expected workflow run ID is invalid");
  assert(/^[0-9a-f]{40}$/i.test(expectedHeadSha), "expected source SHA must be 40 hexadecimal characters");
  assert(/^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(expectedTag), "expected tag is invalid");
  assert(
    /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(expectedVersion),
    "expected version is invalid",
  );
  assert(expectedTag === `v${expectedVersion}`, "expected tag and version do not agree");
  assert(/^[0-9a-f]{64}$/i.test(expectedReceiptSha256), "expected receipt SHA-256 must be 64 hex characters");
  assert(sha256(receiptBytes) === expectedReceiptSha256.toLowerCase(), "receipt SHA-256 does not match dispatch input");

  let receipt;
  try {
    receipt = JSON.parse(receiptBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`receipt is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  assert(receipt.schema === SIGNED_RELEASE_RECEIPT_SCHEMA, "receipt schema is not supported");
  assert(receipt.repository === expectedRepository, "receipt repository does not match this workflow");
  assert(receipt.workflow === SIGNED_RELEASE_WORKFLOW, "receipt workflow is not the signed-app workflow");
  assert(receipt.workflowRun?.id === String(expectedRunId), "receipt run ID does not match dispatch input");
  assert(
    Number.isSafeInteger(receipt.workflowRun?.attempt) && receipt.workflowRun.attempt >= 1,
    "receipt run attempt is invalid",
  );
  assert(receipt.workflowRun?.refType === "tag", "receipt workflow ref type is not tag");
  assert(receipt.workflowRun?.ref === `refs/tags/${expectedTag}`, "receipt workflow ref is not the release tag");
  assert(receipt.source?.headSha === expectedHeadSha.toLowerCase(), "receipt source SHA does not match release source");
  assert(receipt.source?.tag === expectedTag, "receipt tag does not match release tag");
  assert(receipt.source?.version === expectedVersion, "receipt version does not match package version");
  assert(receipt.archive?.name === `Taxi-${expectedVersion}.zip`, "receipt archive name is invalid");
  assert(/^[0-9a-f]{64}$/.test(receipt.archive?.sha256 ?? ""), "receipt archive SHA-256 is invalid");
  assert(
    Number.isSafeInteger(receipt.archive?.bytes) && receipt.archive.bytes >= 1,
    "receipt archive byte count is invalid",
  );
  assert(
    receipt.verification?.lifecycleVerifier === "scripts/verify-signed-app.sh",
    "receipt lifecycle verifier is invalid",
  );
  assert(
    receipt.verification?.archiveVerifier === "scripts/create-signed-release-receipt.mjs",
    "receipt archive verifier is invalid",
  );
  assert(receipt.verification?.result === "passed", "signed artifact verification did not pass");
  assert(receipt.verification?.artifact?.bundleIdentifier === "app.taxi", "receipt bundle identifier is invalid");
  assert(receipt.verification?.artifact?.executable === "Taxi", "receipt executable is invalid");
  assert(receipt.verification?.artifact?.version === expectedVersion, "receipt app version does not match release");
  assert(receipt.verification?.artifact?.teamIdentifier === TAXI_SIGNING_TEAM_ID, "receipt signing team is invalid");
  assert(
    /^[0-9a-f]{40,64}$/.test(receipt.verification?.artifact?.codeDirectoryHash ?? ""),
    "receipt code-directory hash is invalid",
  );
  for (const proof of [
    "developerIdSignature",
    "gatekeeperAssessment",
    "notarizationStaple",
    "releaseGradeRuntime",
    "normalShutdown",
    "sigtermRuntimeRestart",
    "crashCleanup",
    "postRuntimeStaticVerification",
    "provisioningProfiles",
    "archiveExtraction",
    "postPackagingStaticVerification",
    "postPackagingProvisioningProfiles",
    "artifactLicenses",
  ]) {
    assert(receipt.verification?.[proof] === true, `receipt is missing ${proof} verification`);
  }

  const archiveStat = statSync(archivePath);
  assert(
    archiveStat.isFile() && archiveStat.size === receipt.archive.bytes,
    "downloaded archive size does not match receipt",
  );
  assert(basename(archivePath) === receipt.archive.name, "downloaded archive name does not match receipt");
  assert(
    sha256(readFileSync(archivePath)) === receipt.archive.sha256,
    "downloaded archive SHA-256 does not match receipt",
  );

  assert(String(workflowRun?.id) === String(expectedRunId), "GitHub workflow run ID does not match dispatch input");
  assert(
    workflowRun?.repository?.full_name === expectedRepository,
    "GitHub workflow run belongs to another repository",
  );
  assert(workflowRun?.status === "completed", "signed workflow run is not completed");
  assert(workflowRun?.conclusion === "success", "signed workflow run did not conclude successfully");
  assert(workflowRun?.head_sha === expectedHeadSha.toLowerCase(), "signed workflow run used another source SHA");
  assert(workflowPathMatches(workflowRun?.path, expectedTag), "signed workflow run used another workflow or ref");
  assert(workflowRun?.event === receipt.workflowRun.event, "receipt event does not match GitHub workflow run");
  assert(
    workflowRun.event === "push" || workflowRun.event === "workflow_dispatch",
    "signed workflow event is not allowed",
  );
  assert(
    workflowRun?.run_attempt === receipt.workflowRun.attempt,
    "receipt run attempt does not match GitHub workflow run",
  );

  return receipt;
}

function valueArg(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? "") : fallback;
}

function githubWorkflowRun(repository, runId) {
  const result = spawnSync("gh", ["api", `repos/${repository}/actions/runs/${runId}`], {
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0)
    throw new Error(`could not inspect signed workflow run: ${(result.stderr || result.stdout).trim()}`);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `GitHub workflow run response is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function main() {
  const receiptPath = resolve(valueArg("--receipt"));
  const archivePath = resolve(valueArg("--archive"));
  const repository = valueArg("--repository", process.env.GITHUB_REPOSITORY ?? "");
  const runId = valueArg("--run-id");
  const headSha = valueArg("--head-sha");
  const tag = valueArg("--tag");
  const version = valueArg("--version");
  const receipt = verifySignedReleaseReceipt({
    receiptBytes: readFileSync(receiptPath),
    archivePath,
    expectedReceiptSha256: valueArg("--receipt-sha256"),
    expectedRepository: repository,
    expectedRunId: runId,
    expectedHeadSha: headSha,
    expectedTag: tag,
    expectedVersion: version,
    workflowRun: githubWorkflowRun(repository, runId),
  });
  console.log(
    `ok: signed candidate run ${receipt.workflowRun.id} verified for ${receipt.source.tag} (${receipt.archive.sha256})`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`signed-release-receipt: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
