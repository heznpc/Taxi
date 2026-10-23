#!/usr/bin/env node

import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SIGNED_RELEASE_RECEIPT_SCHEMA = "taxi.signed-release-receipt.v1";
export const SIGNED_RELEASE_WORKFLOW = ".github/workflows/release-app.yml";
export const SIGNED_APP_VERIFICATION_SCHEMA = "taxi.signed-app-verification.v1";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAX_EVIDENCE_BYTES = 64 * 1024;
const TAXI_SIGNING_TEAM_ID = "XS7HJJN7GC";
const TAXI_APP_GROUP = "group.app.taxi";
const TAXI_APP_BUNDLE_ID = "app.taxi";
const TAXI_WIDGET_BUNDLE_ID = "app.taxi.Widget";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireMatch(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requirePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function requirePassedProof(value, label) {
  if (value !== true) throw new Error(`verification evidence is missing ${label}`);
  return true;
}

function readArchiveIdentity(path) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    assert(metadata.isFile() && metadata.size > 0, "signed archive must be a non-empty regular file");
    const bytes = readFileSync(descriptor);
    assert(bytes.length === metadata.size, "signed archive changed while it was being read");
    return { bytes: metadata.size, sha256: sha256(bytes) };
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new Error("signed archive must not be a symbolic link", { cause: error });
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function validateLifecycleEvidence(evidence, version) {
  assert(evidence && typeof evidence === "object" && !Array.isArray(evidence), "verification evidence is invalid");
  assert(evidence.schema === SIGNED_APP_VERIFICATION_SCHEMA, "verification evidence schema is not supported");
  assert(
    evidence.artifact?.bundleIdentifier === TAXI_APP_BUNDLE_ID,
    "verification evidence bundle identifier is invalid",
  );
  assert(evidence.artifact?.executable === "Taxi", "verification evidence executable is invalid");
  assert(evidence.artifact?.version === version, "verification evidence version does not match the release");
  assert(
    evidence.artifact?.teamIdentifier === TAXI_SIGNING_TEAM_ID,
    "verification evidence team identifier is invalid",
  );
  requireMatch(evidence.artifact?.codeDirectoryHash, /^[0-9a-f]{40,64}$/, "verification evidence code-directory hash");
  assert(
    evidence.verification?.lifecycleVerifier === "scripts/verify-signed-app.sh",
    "verification evidence lifecycle verifier is invalid",
  );
  assert(evidence.verification?.result === "passed", "signed app lifecycle verification did not pass");
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
  ]) {
    requirePassedProof(evidence.verification?.[proof], proof);
  }
  return evidence;
}

function loadLifecycleEvidence(path, version) {
  let descriptor;
  let evidence;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    assert(metadata.isFile(), "verification evidence must be a regular file");
    if (typeof process.getuid === "function") {
      assert(metadata.uid === process.getuid(), "verification evidence must be owned by the current user");
    }
    assert(metadata.size > 0 && metadata.size <= MAX_EVIDENCE_BYTES, "verification evidence size is invalid");
    assert((metadata.mode & 0o077) === 0, "verification evidence must not be group/world accessible");
    evidence = JSON.parse(readFileSync(descriptor, "utf8"));
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new Error("verification evidence must not be a symbolic link", { cause: error });
    }
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error(
      `verification evidence is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return validateLifecycleEvidence(evidence, version);
}

function runGate(label, executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) throw new Error(`${label} failed for the extracted signed archive`);
  return result;
}

function signingField(output, name) {
  const match = output.match(new RegExp(`^${name}=([^\\r\\n]+)$`, "m"));
  return match?.[1] ?? "";
}

function verifyExtractedArchive(archivePath, lifecycleEvidence, version) {
  const extractionRoot = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "taxi-signed-candidate-"));
  const archiveBefore = readArchiveIdentity(archivePath);
  try {
    runGate("archive extraction", "/usr/bin/ditto", ["-x", "-k", archivePath, extractionRoot]);
    const entries = readdirSync(extractionRoot);
    assert(entries.length === 1 && entries[0] === "Taxi.app", "signed archive must contain only Taxi.app");
    const extractedApp = join(extractionRoot, "Taxi.app");
    const appMetadata = lstatSync(extractedApp);
    assert(appMetadata.isDirectory() && !appMetadata.isSymbolicLink(), "extracted Taxi.app must be a bundle directory");

    runGate("code-sign verification", "/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      "--verbose=2",
      extractedApp,
    ]);
    const signing = runGate("signing identity inspection", "/usr/bin/codesign", ["-dv", "--verbose=4", extractedApp]);
    const signingOutput = `${signing.stdout || ""}\n${signing.stderr || ""}`;
    assert(
      signingField(signingOutput, "TeamIdentifier") === lifecycleEvidence.artifact.teamIdentifier,
      "extracted app signing team differs from lifecycle evidence",
    );
    assert(
      signingField(signingOutput, "CDHash").toLowerCase() === lifecycleEvidence.artifact.codeDirectoryHash,
      "extracted app code-directory hash differs from lifecycle evidence",
    );
    assert(signingOutput.includes("Runtime Version="), "extracted app is missing hardened runtime");
    assert(!signingOutput.includes("Signature=adhoc"), "extracted app has an ad-hoc signature");

    runGate("Gatekeeper assessment", "/usr/sbin/spctl", ["--assess", "--type", "execute", "-vvv", extractedApp]);
    runGate("notarization staple validation", "/usr/bin/xcrun", ["stapler", "validate", extractedApp]);
    runGate(
      "bundle structure verification",
      "/bin/bash",
      [join(PROJECT_ROOT, "scripts", "verify-bundle-structure.sh"), extractedApp, "app.taxi", "Taxi"],
      {
        env: {
          ...process.env,
          TAXI_REQUIRE_WIDGET: "1",
          TAXI_EXPECTED_SIGNING_MODE: "developer-id",
          TAXI_EXPECTED_SIGNING_TEAM_ID: lifecycleEvidence.artifact.teamIdentifier,
        },
      },
    );
    const extractedWidget = join(extractedApp, "Contents", "PlugIns", "TaxiWidget.appex");
    const widgetMetadata = lstatSync(extractedWidget);
    assert(
      widgetMetadata.isDirectory() && !widgetMetadata.isSymbolicLink(),
      "extracted TaxiWidget.appex must be a bundle directory",
    );
    const profileVerifier = join(PROJECT_ROOT, "scripts", "verify-provisioning-profile.mjs");
    const provisioningArgs = (bundlePath, bundleIdentifier) => [
      profileVerifier,
      `--bundle=${bundlePath}`,
      `--expected-bundle-id=${bundleIdentifier}`,
      `--expected-team-id=${TAXI_SIGNING_TEAM_ID}`,
      `--expected-app-group=${TAXI_APP_GROUP}`,
    ];
    runGate(
      "main app provisioning profile verification",
      process.execPath,
      provisioningArgs(extractedApp, TAXI_APP_BUNDLE_ID),
    );
    runGate(
      "widget provisioning profile verification",
      process.execPath,
      provisioningArgs(extractedWidget, TAXI_WIDGET_BUNDLE_ID),
    );
    const versionResult = runGate("bundle version inspection", "/usr/libexec/PlistBuddy", [
      "-c",
      "Print :CFBundleShortVersionString",
      join(extractedApp, "Contents", "Info.plist"),
    ]);
    assert(versionResult.stdout.trim() === version, "extracted app version does not match the release");
    runGate("artifact license verification", process.execPath, [
      join(PROJECT_ROOT, "scripts", "verify-license-inventory.mjs"),
      "--app",
      extractedApp,
    ]);

    const archiveAfter = readArchiveIdentity(archivePath);
    assert(
      archiveAfter.bytes === archiveBefore.bytes && archiveAfter.sha256 === archiveBefore.sha256,
      "signed archive changed while its extracted artifact was being verified",
    );
    return {
      archive: archiveAfter,
      verification: {
        ...lifecycleEvidence.verification,
        artifact: { ...lifecycleEvidence.artifact },
        archiveVerifier: "scripts/create-signed-release-receipt.mjs",
        archiveExtraction: true,
        postPackagingStaticVerification: true,
        postPackagingProvisioningProfiles: true,
        artifactLicenses: true,
      },
    };
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true });
  }
}

function validateReceiptVerification(verification, version) {
  assert(verification && typeof verification === "object", "receipt verification evidence is invalid");
  assert(verification.lifecycleVerifier === "scripts/verify-signed-app.sh", "lifecycle verifier is invalid");
  assert(verification.archiveVerifier === "scripts/create-signed-release-receipt.mjs", "archive verifier is invalid");
  assert(verification.result === "passed", "signed artifact verification did not pass");
  assert(
    verification.artifact?.bundleIdentifier === TAXI_APP_BUNDLE_ID,
    "verified artifact bundle identifier is invalid",
  );
  assert(verification.artifact?.executable === "Taxi", "verified artifact executable is invalid");
  assert(verification.artifact?.version === version, "verified artifact version does not match the release");
  assert(
    verification.artifact?.teamIdentifier === TAXI_SIGNING_TEAM_ID,
    "verified artifact team identifier is invalid",
  );
  requireMatch(verification.artifact?.codeDirectoryHash, /^[0-9a-f]{40,64}$/, "verified artifact code-directory hash");
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
    requirePassedProof(verification[proof], proof);
  }
  return { ...verification };
}

export function createSignedReleaseReceipt({
  archivePath,
  repository,
  runId,
  runAttempt,
  event,
  ref,
  refType,
  headSha,
  tag,
  version,
  verificationEvidence,
  verifiedArchive,
}) {
  const canonicalTag = requireMatch(tag, /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/, "tag");
  const canonicalVersion = requireMatch(
    version,
    /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/,
    "version",
  );
  if (canonicalTag !== `v${canonicalVersion}`) throw new Error("tag and version do not agree");
  requireMatch(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "repository");
  const canonicalHeadSha = requireMatch(headSha, /^[0-9a-f]{40}$/i, "head SHA").toLowerCase();
  const canonicalRunId = String(requirePositiveInteger(runId, "workflow run ID"));
  const canonicalRunAttempt = requirePositiveInteger(runAttempt, "workflow run attempt");
  if (event !== "push" && event !== "workflow_dispatch") throw new Error("workflow event is invalid");
  if (refType !== "tag") throw new Error("workflow ref type must be tag");
  if (ref !== `refs/tags/${canonicalTag}`) {
    throw new Error(`workflow ref must be refs/tags/${canonicalTag}`);
  }

  const expectedName = `Taxi-${canonicalVersion}.zip`;
  if (basename(archivePath) !== expectedName) throw new Error(`signed archive must be named ${expectedName}`);
  assert(
    Number.isSafeInteger(verifiedArchive?.bytes) && verifiedArchive.bytes >= 1,
    "verified archive byte count is invalid",
  );
  requireMatch(verifiedArchive?.sha256, /^[0-9a-f]{64}$/, "verified archive SHA-256");
  const archive = readArchiveIdentity(archivePath);
  assert(
    archive.bytes === verifiedArchive.bytes && archive.sha256 === verifiedArchive.sha256,
    "signed archive differs from the extracted artifact that passed verification",
  );
  const verified = validateReceiptVerification(verificationEvidence, canonicalVersion);

  return {
    schema: SIGNED_RELEASE_RECEIPT_SCHEMA,
    repository,
    workflow: SIGNED_RELEASE_WORKFLOW,
    workflowRun: {
      id: canonicalRunId,
      attempt: canonicalRunAttempt,
      event,
      ref,
      refType,
    },
    source: {
      tag: canonicalTag,
      version: canonicalVersion,
      headSha: canonicalHeadSha,
    },
    verification: verified,
    archive: {
      name: expectedName,
      ...archive,
    },
  };
}

function valueArg(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? "") : fallback;
}

function main() {
  const archivePath = resolve(valueArg("--archive"));
  const outputPath = resolve(valueArg("--output"));
  const version = valueArg("--version");
  const evidenceArgument = valueArg("--verification-evidence");
  if (!evidenceArgument) throw new Error("--verification-evidence is required");
  const lifecycleEvidence = loadLifecycleEvidence(resolve(evidenceArgument), version);
  const extractedVerification = verifyExtractedArchive(archivePath, lifecycleEvidence, version);
  const receipt = createSignedReleaseReceipt({
    archivePath,
    repository: valueArg("--repository", process.env.GITHUB_REPOSITORY ?? ""),
    runId: valueArg("--run-id", process.env.GITHUB_RUN_ID ?? ""),
    runAttempt: valueArg("--run-attempt", process.env.GITHUB_RUN_ATTEMPT ?? ""),
    event: valueArg("--event", process.env.GITHUB_EVENT_NAME ?? ""),
    ref: valueArg("--ref", process.env.GITHUB_REF ?? ""),
    refType: valueArg("--ref-type", process.env.GITHUB_REF_TYPE ?? ""),
    headSha: valueArg("--head-sha", process.env.GITHUB_SHA ?? ""),
    tag: valueArg("--tag"),
    version,
    verificationEvidence: extractedVerification.verification,
    verifiedArchive: extractedVerification.archive,
  });
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  writeFileSync(outputPath, bytes, { flag: "wx", mode: 0o600 });
  const receiptSha256 = sha256(bytes);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `receipt_sha256=${receiptSha256}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `archive_sha256=${receipt.archive.sha256}\n`);
  }
  console.log(`ok: signed release receipt ${basename(outputPath)} sha256=${receiptSha256}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`signed-release-receipt: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
