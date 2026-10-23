import { afterEach, describe, expect, test } from "@jest/globals";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SIGNED_RELEASE_RECEIPT_SCHEMA,
  SIGNED_RELEASE_WORKFLOW,
  createSignedReleaseReceipt,
} from "../scripts/create-signed-release-receipt.mjs";
import { verifySignedReleaseReceipt } from "../scripts/verify-signed-release-receipt.mjs";
import { decryptCandidateFile, encryptCandidateFile } from "../scripts/signed-release-receipt-crypto.mjs";

const SHA = "1234567890abcdef1234567890abcdef12345678";
const REPOSITORY = "heznpc/taxi";
const RUN_ID = "987654321";
const TAG = "v1.0.0";
const VERSION = "1.0.0";
const createScript = new URL("../scripts/create-signed-release-receipt.mjs", import.meta.url);
const CANDIDATE_KEY = Buffer.alloc(32, 0x5a).toString("base64");
const temporaryDirectories = [];

function passedVerificationEvidence(overrides = {}) {
  return {
    lifecycleVerifier: "scripts/verify-signed-app.sh",
    archiveVerifier: "scripts/create-signed-release-receipt.mjs",
    result: "passed",
    artifact: {
      bundleIdentifier: "app.taxi",
      executable: "Taxi",
      version: VERSION,
      teamIdentifier: "XS7HJJN7GC",
      codeDirectoryHash: "a".repeat(40),
    },
    developerIdSignature: true,
    gatekeeperAssessment: true,
    notarizationStaple: true,
    releaseGradeRuntime: true,
    normalShutdown: true,
    sigtermRuntimeRestart: true,
    crashCleanup: true,
    postRuntimeStaticVerification: true,
    provisioningProfiles: true,
    archiveExtraction: true,
    postPackagingStaticVerification: true,
    postPackagingProvisioningProfiles: true,
    artifactLicenses: true,
    ...overrides,
  };
}

function verifiedArchiveFor(path) {
  const bytes = readFileSync(path);
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "taxi-signed-receipt-"));
  temporaryDirectories.push(directory);
  const archivePath = join(directory, `Taxi-${VERSION}.zip`);
  writeFileSync(archivePath, Buffer.from("signed-notarized-app-fixture"));
  const receipt = createSignedReleaseReceipt({
    archivePath,
    repository: REPOSITORY,
    runId: RUN_ID,
    runAttempt: "2",
    event: "workflow_dispatch",
    ref: `refs/tags/${TAG}`,
    refType: "tag",
    headSha: SHA,
    tag: TAG,
    version: VERSION,
    verificationEvidence: passedVerificationEvidence(),
    verifiedArchive: verifiedArchiveFor(archivePath),
  });
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  const expectedReceiptSha256 = createHash("sha256").update(receiptBytes).digest("hex");
  const workflowRun = {
    id: Number(RUN_ID),
    repository: { full_name: REPOSITORY },
    status: "completed",
    conclusion: "success",
    head_sha: SHA,
    head_branch: TAG,
    path: `${SIGNED_RELEASE_WORKFLOW}@${TAG}`,
    event: "workflow_dispatch",
    run_attempt: 2,
  };
  const verify = (overrides = {}) =>
    verifySignedReleaseReceipt({
      receiptBytes,
      archivePath,
      expectedReceiptSha256,
      expectedRepository: REPOSITORY,
      expectedRunId: RUN_ID,
      expectedHeadSha: SHA,
      expectedTag: TAG,
      expectedVersion: VERSION,
      workflowRun,
      ...overrides,
    });
  return { archivePath, receipt, receiptBytes, expectedReceiptSha256, workflowRun, verify };
}

describe("signed release candidate receipt", () => {
  test("keeps the Actions payload confidential and rejects authenticated-envelope tampering", async () => {
    const directory = mkdtempSync(join(tmpdir(), "taxi-signed-envelope-"));
    temporaryDirectories.push(directory);
    const input = join(directory, "candidate.zip");
    const encrypted = join(directory, "candidate.zip.enc");
    const output = join(directory, "candidate.out.zip");
    const tamperedOutput = join(directory, "tampered.out.zip");
    const original = Buffer.concat([
      Buffer.from("exact signed candidate bytes\0with binary suffix"),
      Buffer.alloc(2 * 1024 * 1024, 0xa5),
    ]);
    writeFileSync(input, original);

    await expect(encryptCandidateFile(input, encrypted, "not-a-32-byte-base64-key")).rejects.toThrow(
      /exactly 32 bytes/,
    );
    await encryptCandidateFile(input, encrypted, CANDIDATE_KEY);
    expect(readFileSync(encrypted).includes(original)).toBe(false);
    await decryptCandidateFile(encrypted, output, CANDIDATE_KEY);
    expect(readFileSync(output).equals(original)).toBe(true);
    expect(statSync(encrypted).mode & 0o777).toBe(0o600);
    expect(statSync(output).mode & 0o777).toBe(0o600);

    await expect(
      decryptCandidateFile(encrypted, join(directory, "wrong-key.out.zip"), Buffer.alloc(32, 0x33).toString("base64")),
    ).rejects.toThrow(/authentication\/decryption failed/);

    const changed = readFileSync(encrypted);
    changed[Math.floor(changed.length / 2)] ^= 0xff;
    writeFileSync(encrypted, changed);
    await expect(decryptCandidateFile(encrypted, tamperedOutput, CANDIDATE_KEY)).rejects.toThrow(
      /authentication\/decryption failed/,
    );
    expect(existsSync(tamperedOutput)).toBe(false);
  });

  test("CLI refuses to mint a receipt without private signed-app verification evidence", () => {
    const directory = mkdtempSync(join(tmpdir(), "taxi-signed-receipt-cli-"));
    temporaryDirectories.push(directory);
    const archivePath = join(directory, `Taxi-${VERSION}.zip`);
    const receiptPath = join(directory, "signed-release-receipt.json");
    const githubOutput = join(directory, "github-output");
    writeFileSync(archivePath, Buffer.from("signed-app-cli-fixture"));

    const result = spawnSync(
      process.execPath,
      [
        createScript.pathname,
        `--archive=${archivePath}`,
        `--output=${receiptPath}`,
        `--repository=${REPOSITORY}`,
        `--run-id=${RUN_ID}`,
        "--run-attempt=1",
        "--event=push",
        `--ref=refs/tags/${TAG}`,
        "--ref-type=tag",
        `--head-sha=${SHA}`,
        `--tag=${TAG}`,
        `--version=${VERSION}`,
      ],
      { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: githubOutput } },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--verification-evidence is required");
    expect(existsSync(receiptPath)).toBe(false);
    expect(existsSync(githubOutput)).toBe(false);
  });

  test("binds the exact archive to repository, workflow run, source, and release-grade verification", () => {
    const { receipt, verify } = fixture();
    expect(receipt.schema).toBe(SIGNED_RELEASE_RECEIPT_SCHEMA);
    expect(receipt.workflow).toBe(SIGNED_RELEASE_WORKFLOW);
    expect(receipt.workflowRun).toEqual({
      id: RUN_ID,
      attempt: 2,
      event: "workflow_dispatch",
      ref: `refs/tags/${TAG}`,
      refType: "tag",
    });
    expect(receipt.source).toEqual({ tag: TAG, version: VERSION, headSha: SHA });
    expect(receipt.archive.name).toBe(`Taxi-${VERSION}.zip`);
    expect(receipt.archive.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.verification.artifact).toEqual({
      bundleIdentifier: "app.taxi",
      executable: "Taxi",
      version: VERSION,
      teamIdentifier: "XS7HJJN7GC",
      codeDirectoryHash: "a".repeat(40),
    });
    expect(receipt.verification).toMatchObject({
      lifecycleVerifier: "scripts/verify-signed-app.sh",
      archiveVerifier: "scripts/create-signed-release-receipt.mjs",
      result: "passed",
      developerIdSignature: true,
      gatekeeperAssessment: true,
      notarizationStaple: true,
      releaseGradeRuntime: true,
      normalShutdown: true,
      sigtermRuntimeRestart: true,
      crashCleanup: true,
      postRuntimeStaticVerification: true,
      provisioningProfiles: true,
      archiveExtraction: true,
      postPackagingStaticVerification: true,
      postPackagingProvisioningProfiles: true,
      artifactLicenses: true,
    });
    expect(verify()).toEqual(receipt);
  });

  test("rejects a changed receipt, changed archive, failed run, or wrong source/ref", () => {
    const fixtureValue = fixture();
    expect(() => fixtureValue.verify({ expectedReceiptSha256: "0".repeat(64) })).toThrow(/receipt SHA-256/);

    writeFileSync(fixtureValue.archivePath, Buffer.from("changed"));
    expect(() => fixtureValue.verify()).toThrow(/archive size|archive SHA-256/);

    const failed = fixture();
    expect(() => failed.verify({ workflowRun: { ...failed.workflowRun, conclusion: "failure" } })).toThrow(
      /did not conclude successfully/,
    );
    expect(() => failed.verify({ workflowRun: { ...failed.workflowRun, head_sha: "f".repeat(40) } })).toThrow(
      /another source SHA/,
    );
    expect(() =>
      failed.verify({ workflowRun: { ...failed.workflowRun, path: `${SIGNED_RELEASE_WORKFLOW}@main` } }),
    ).toThrow(/another workflow or ref/);
  });

  test("receipt verification independently requires profile proofs and the exact Taxi signing team", () => {
    for (const mutation of [
      { proof: "provisioningProfiles", value: false },
      { proof: "postPackagingProvisioningProfiles", value: false },
      { proof: "artifact.teamIdentifier", value: "WRONGTEAM1" },
    ]) {
      const candidate = fixture();
      const changedReceipt = structuredClone(candidate.receipt);
      if (mutation.proof === "artifact.teamIdentifier") {
        changedReceipt.verification.artifact.teamIdentifier = mutation.value;
      } else {
        changedReceipt.verification[mutation.proof] = mutation.value;
      }
      const changedBytes = Buffer.from(`${JSON.stringify(changedReceipt, null, 2)}\n`);
      const changedSha = createHash("sha256").update(changedBytes).digest("hex");
      expect(() => candidate.verify({ receiptBytes: changedBytes, expectedReceiptSha256: changedSha })).toThrow(
        mutation.proof === "artifact.teamIdentifier" ? /signing team/ : new RegExp(mutation.proof),
      );
    }
  });

  test("rejects inconsistent generator inputs before producing a receipt", () => {
    const { archivePath } = fixture();
    expect(() =>
      createSignedReleaseReceipt({
        archivePath,
        repository: REPOSITORY,
        runId: RUN_ID,
        runAttempt: 1,
        event: "push",
        ref: `refs/tags/${TAG}`,
        refType: "tag",
        headSha: SHA,
        tag: "v1.0.1",
        version: VERSION,
        verificationEvidence: passedVerificationEvidence(),
        verifiedArchive: verifiedArchiveFor(archivePath),
      }),
    ).toThrow(/tag and version/);

    expect(() =>
      createSignedReleaseReceipt({
        archivePath,
        repository: REPOSITORY,
        runId: RUN_ID,
        runAttempt: 1,
        event: "push",
        ref: `refs/tags/${TAG}`,
        refType: "tag",
        headSha: SHA,
        tag: TAG,
        version: VERSION,
        verificationEvidence: passedVerificationEvidence(),
        verifiedArchive: { ...verifiedArchiveFor(archivePath), sha256: "0".repeat(64) },
      }),
    ).toThrow(/differs from the extracted artifact/);

    for (const proof of [
      "developerIdSignature",
      "notarizationStaple",
      "releaseGradeRuntime",
      "sigtermRuntimeRestart",
      "postRuntimeStaticVerification",
      "provisioningProfiles",
      "archiveExtraction",
      "postPackagingStaticVerification",
      "postPackagingProvisioningProfiles",
      "artifactLicenses",
    ]) {
      expect(() =>
        createSignedReleaseReceipt({
          archivePath,
          repository: REPOSITORY,
          runId: RUN_ID,
          runAttempt: 1,
          event: "push",
          ref: `refs/tags/${TAG}`,
          refType: "tag",
          headSha: SHA,
          tag: TAG,
          version: VERSION,
          verificationEvidence: passedVerificationEvidence({ [proof]: false }),
          verifiedArchive: verifiedArchiveFor(archivePath),
        }),
      ).toThrow(new RegExp(proof));
    }

    expect(() =>
      createSignedReleaseReceipt({
        archivePath,
        repository: REPOSITORY,
        runId: RUN_ID,
        runAttempt: 1,
        event: "push",
        ref: `refs/tags/${TAG}`,
        refType: "tag",
        headSha: SHA,
        tag: TAG,
        version: VERSION,
        verificationEvidence: passedVerificationEvidence({
          artifact: {
            ...passedVerificationEvidence().artifact,
            teamIdentifier: "WRONGTEAM1",
          },
        }),
        verifiedArchive: verifiedArchiveFor(archivePath),
      }),
    ).toThrow(/team identifier/);
  });

  test("requires the workflow invocation itself to use the exact release tag", () => {
    const { archivePath } = fixture();
    const base = {
      archivePath,
      repository: REPOSITORY,
      runId: RUN_ID,
      runAttempt: 1,
      event: "workflow_dispatch",
      headSha: SHA,
      tag: TAG,
      version: VERSION,
      verificationEvidence: passedVerificationEvidence(),
      verifiedArchive: verifiedArchiveFor(archivePath),
    };
    expect(() => createSignedReleaseReceipt({ ...base, ref: "refs/heads/main", refType: "branch" })).toThrow(
      /ref type must be tag/,
    );
    expect(() => createSignedReleaseReceipt({ ...base, ref: "refs/tags/v1.0.1", refType: "tag" })).toThrow(
      /workflow ref must be refs\/tags\/v1\.0\.0/,
    );
  });
});
