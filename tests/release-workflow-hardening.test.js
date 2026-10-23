import { afterEach, describe, expect, test } from "@jest/globals";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const cdSource = read("../.github/workflows/cd.yml");
const appSource = read("../.github/workflows/release-app.yml");
const autoReleaseSource = read("../.github/workflows/auto-release.yml");
const registrySource = read("../.github/workflows/publish-registry.yml");
const registryStatusSource = read("../.github/workflows/registry-set-status.yml");
const ciSource = read("../.github/workflows/ci.yml");
const existingReleaseSource = read("../scripts/classify-existing-github-release.mjs");
const pinnedGhSource = read("../scripts/install-pinned-gh.sh");
const preflightSource = read("../scripts/release-preflight.mjs");
const bundleSource = read("../scripts/bundle-app.sh");
const notarizeSource = read("../scripts/notarize-app.sh");
const signedVerifySource = read("../scripts/verify-signed-app.sh");
const signedReceiptSource = read("../scripts/create-signed-release-receipt.mjs");
const releaseVerifySource = read("../scripts/verify-release-state.mjs");
const bundlePath = new URL("../scripts/bundle-app.sh", import.meta.url).pathname;
const cd = parseYaml(cdSource);
const app = parseYaml(appSource);
const autoRelease = parseYaml(autoReleaseSource);
const registry = parseYaml(registrySource);
const registryStatus = parseYaml(registryStatusSource);
const ci = parseYaml(ciSource);
const temporaryDirectories = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function namedStep(workflow, job, name) {
  const step = workflow.jobs[job].steps.find((candidate) => candidate.name === name);
  expect(step).toBeDefined();
  return step;
}

function runTagResolver(requestedTag, ref = `refs/tags/v${requestedTag.replace(/^v/, "")}`, refType = "tag") {
  const directory = mkdtempSync(join(tmpdir(), "taxi-release-tag-"));
  temporaryDirectories.push(directory);
  const output = join(directory, "github-output");
  const resolver = namedStep(app, "resolve-release", "Resolve and validate release tag");
  const result = spawnSync("bash", ["-c", `set -euo pipefail\n${resolver.run}`], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_OUTPUT: output,
      GITHUB_REF: ref,
      GITHUB_REF_TYPE: refType,
      REQUESTED_TAG: requestedTag,
    },
  });
  const values = existsSync(output)
    ? Object.fromEntries(
        readFileSync(output, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split("=", 2)),
      )
    : {};
  return { ...result, values, directory };
}

describe("release workflow source and identity hardening", () => {
  test("names candidate and publication states separately", () => {
    expect(autoRelease.name).toBe("Release Candidate Handoff");
    expect(app.name).toBe("Build Signed Taxi Candidate");
    expect(cd.name).toBe("Publish Taxi Release");
  });

  test("validates a stable SemVer tag for push and explicit resume dispatches", () => {
    for (const input of ["2.16.0", "v2.16.0"]) {
      const result = runTagResolver(input);
      expect(result.status).toBe(0);
      expect(result.values).toEqual({ tag: "v2.16.0", version: "2.16.0" });
    }
    expect(runTagResolver("v02.16.0").status).not.toBe(0);
    expect(runTagResolver("v2.16").status).not.toBe(0);
    expect(runTagResolver("v2.16.0", "refs/heads/main", "branch").status).not.toBe(0);
    expect(runTagResolver("v2.16.0", "refs/tags/v2.16.1", "tag").status).not.toBe(0);
    const injection = runTagResolver('v2.16.0"; touch injected; #');
    expect(injection.status).not.toBe(0);
    expect(existsSync(join(injection.directory, "injected"))).toBe(false);

    expect(app.on.push.tags).toContain("v*.*.*");
    expect(app.on.workflow_dispatch.inputs.tag.required).toBe(true);
    expect(app.on.workflow_dispatch.inputs.require_signing).toBeUndefined();
    const resolver = namedStep(app, "resolve-release", "Resolve and validate release tag");
    expect(resolver.env.REQUESTED_TAG).toContain("inputs.tag");
    expect(resolver.run).toContain('"$GITHUB_REF_TYPE" != "tag"');
    expect(resolver.run).toContain('"$GITHUB_REF" != "refs/tags/$TAG"');
    expect(resolver.run).not.toContain("${{");
  });

  test("builds the signed candidate before any GitHub Release exists", () => {
    const sourceCheckout = app.jobs["resolve-release"].steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(sourceCheckout.with.ref).toBe("refs/tags/${{ steps.release.outputs.tag }}");
    expect(sourceCheckout.with["fetch-depth"]).toBe(0);

    const checkout = app.jobs["release-app"].steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout.with.ref).toBe("refs/tags/${{ needs.resolve-release.outputs.tag }}");
    expect(checkout.with["fetch-depth"]).toBe(0);

    const identity = namedStep(app, "resolve-release", "Verify immutable release source identity");
    expect(identity.run).toContain('git rev-parse "refs/tags/$RELEASE_TAG^{commit}"');
    expect(identity.run).toContain("git merge-base --is-ancestor");
    expect(identity.run).toContain("require('./package.json').version");
    expect(identity.run).toContain("CFBundleShortVersionString");
    expect(identity.run).toContain("app/widget/Info.plist");
    expect(identity.run).not.toContain("releases/tags");
    expect(appSource).not.toContain("action-gh-release");
    expect(appSource).not.toContain("Attach artifacts to Release");
  });

  test("has no unsigned, missing-secret, or repository-variable success path", () => {
    expect(app.jobs["release-app"].environment).toBe("release");
    expect(app.jobs["release-app"].permissions.actions).toBe("read");
    expect(app.jobs["release-app"].if).toBeUndefined();
    expect(appSource).not.toContain("SIGNED_APP_RELEASE");
    expect(appSource).not.toContain("steps.signing.outputs.ready");
    expect(JSON.stringify(app.jobs["resolve-release"])).not.toContain("secrets.");

    const signing = namedStep(app, "release-app", "Preflight — required secrets present");
    expect(signing.env.APPLE_CERT_P12_BASE64).toBe("${{ secrets.APPLE_CERT_P12_BASE64 }}");
    expect(signing.env.APPLE_API_KEY_P8_BASE64).toBe("${{ secrets.APPLE_API_KEY_P8_BASE64 }}");
    expect(signing.env.TAXI_APP_PROVISIONING_PROFILE_BASE64).toBe(
      "${{ secrets.TAXI_APP_PROVISIONING_PROFILE_BASE64 }}",
    );
    expect(signing.env.TAXI_WIDGET_PROVISIONING_PROFILE_BASE64).toBe(
      "${{ secrets.TAXI_WIDGET_PROVISIONING_PROFILE_BASE64 }}",
    );
    expect(signing.env.TAXI_RELEASE_CANDIDATE_KEY_BASE64).toBe("${{ secrets.TAXI_RELEASE_CANDIDATE_KEY_BASE64 }}");
    expect(signing.run).toContain('missing+=("TAXI_APP_PROVISIONING_PROFILE_BASE64")');
    expect(signing.run).toContain('missing+=("TAXI_WIDGET_PROVISIONING_PROFILE_BASE64")');
    expect(signing.run).toContain('missing+=("TAXI_RELEASE_CANDIDATE_KEY_BASE64")');
    expect(signing.run).toContain('echo "::error::Missing required secrets: ${missing[*]}"');
    expect(signing.run).toContain("exit 1");
    expect(signing.run).not.toContain("exit 0");
    expect(appSource).not.toContain("APPLE_ID_PASSWORD");

    const outerGate = namedStep(app, "resolve-release", "Verify release environment protection");
    const innerGate = namedStep(app, "release-app", "Re-verify release environment protection");
    expect(outerGate.run).toContain("verify-release-environment.mjs");
    expect(innerGate.run).toContain("verify-release-environment.mjs");
    expect(app.jobs["release-app"].steps.indexOf(innerGate)).toBeLessThan(
      app.jobs["release-app"].steps.indexOf(signing),
    );
  });

  test("verifies the exact signed/notarized/stapled app before creating its receipt", () => {
    const steps = app.jobs["release-app"].steps;
    const signing = namedStep(app, "release-app", "Sign + notarize + staple + verify exact artifact");
    const licenses = namedStep(app, "release-app", "Verify signed app license surface");
    const packaging = namedStep(app, "release-app", "Package signed .app for release");
    const receipt = namedStep(app, "release-app", "Create signed release receipt");
    const encryption = namedStep(app, "release-app", "Encrypt signed release candidate");
    const upload = namedStep(app, "release-app", "Upload encrypted signed release candidate");
    const handoff = namedStep(app, "release-app", "Record signed candidate handoff");
    expect(notarizeSource).toContain('APP_BUNDLE_PATH="$APP_BUNDLE" bash "$SCRIPT_DIR/verify-signed-app.sh"');
    expect(app.jobs["release-app"].env.TAXI_SIGNED_SOAK_DURATION_SECONDS).toBe("3600");
    expect(app.jobs["release-app"].env.TAXI_SIGNED_ALLOW_SHORT_SOAK).toBe("0");
    expect(signedVerifySource).toContain("run_signed_runtime_soak");
    expect(signedVerifySource).toContain("verify_crash_watchdog_shutdown");
    expect(signedVerifySource).toContain("RELEASE-QUALIFIED exact signed artifact");
    expect(signing.run).toContain('APPLE_API_KEY_PATH="$API_KEY_PATH"');
    expect(signing.env.TAXI_APP_PROVISIONING_PROFILE_BASE64).toBe(
      "${{ secrets.TAXI_APP_PROVISIONING_PROFILE_BASE64 }}",
    );
    expect(signing.env.TAXI_WIDGET_PROVISIONING_PROFILE_BASE64).toBe(
      "${{ secrets.TAXI_WIDGET_PROVISIONING_PROFILE_BASE64 }}",
    );
    expect(signing.run).toContain('SIGNING_SECRET_DIR="$(mktemp -d "$RUNNER_TEMP/taxi-signing.XXXXXX")"');
    expect(signing.run).toContain('APP_PROFILE_PATH="$SIGNING_SECRET_DIR/Taxi.provisionprofile"');
    expect(signing.run).toContain('WIDGET_PROFILE_PATH="$SIGNING_SECRET_DIR/TaxiWidget.provisionprofile"');
    expect(signing.run).toContain('chmod 0600 "$API_KEY_PATH" "$APP_PROFILE_PATH" "$WIDGET_PROFILE_PATH"');
    expect(signing.run).toContain('TAXI_APP_PROVISIONING_PROFILE_PATH="$APP_PROFILE_PATH"');
    expect(signing.run).toContain('TAXI_WIDGET_PROVISIONING_PROFILE_PATH="$WIDGET_PROFILE_PATH"');
    expect(signing.run).toContain('rm -f "$API_KEY_PATH" "$APP_PROFILE_PATH" "$WIDGET_PROFILE_PATH"');
    expect(signing.run).toContain("bash scripts/notarize-app.sh");
    expect(signing.run).toContain('TAXI_SIGNED_VERIFICATION_OUTPUT="$VERIFICATION_EVIDENCE"');
    const lifecycleGate = notarizeSource.indexOf('bash "$SCRIPT_DIR/verify-signed-app.sh"');
    expect(notarizeSource.indexOf("post-runtime code-sign verification failed")).toBeGreaterThan(lifecycleGate);
    expect(notarizeSource.indexOf("post-runtime Gatekeeper assessment failed")).toBeGreaterThan(lifecycleGate);
    expect(notarizeSource.indexOf("post-runtime notarization staple validation failed")).toBeGreaterThan(lifecycleGate);
    expect(licenses.run).toBe("npm run licenses:check -- --app Taxi.app");
    expect(steps.indexOf(signing)).toBeLessThan(steps.indexOf(packaging));
    expect(steps.indexOf(signing)).toBeLessThan(steps.indexOf(licenses));
    expect(steps.indexOf(licenses)).toBeLessThan(steps.indexOf(packaging));
    expect(steps.indexOf(packaging)).toBeLessThan(steps.indexOf(receipt));
    expect(steps.indexOf(receipt)).toBeLessThan(steps.indexOf(encryption));
    expect(steps.indexOf(encryption)).toBeLessThan(steps.indexOf(upload));
    expect(steps.indexOf(upload)).toBeLessThan(steps.indexOf(handoff));
    expect(receipt.run).toContain("create-signed-release-receipt.mjs");
    expect(receipt.run).toContain('--ref="${GITHUB_REF}"');
    expect(receipt.run).toContain('--ref-type="${GITHUB_REF_TYPE}"');
    expect(receipt.run).toContain('--head-sha="$RELEASE_SHA"');
    expect(receipt.run).toContain('--verification-evidence="$RUNNER_TEMP/signed-app-verification.json"');
    expect(signedReceiptSource).toContain(
      'mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "taxi-signed-candidate-")',
    );
    expect(signedReceiptSource).toContain('["-x", "-k", archivePath, extractionRoot]');
    expect(signedReceiptSource).toContain('entries.length === 1 && entries[0] === "Taxi.app"');
    expect(signedReceiptSource).toContain('"postPackagingStaticVerification"');
    expect(signedReceiptSource).toContain('"artifactLicenses"');
    expect(signedReceiptSource).toContain('"provisioningProfiles"');
    expect(signedReceiptSource).toContain('"postPackagingProvisioningProfiles"');
    expect(signedReceiptSource).toContain('"main app provisioning profile verification"');
    expect(signedReceiptSource).toContain('"widget provisioning profile verification"');
    expect(signedReceiptSource).toContain("verify-provisioning-profile.mjs");
    expect(signedReceiptSource).toContain("`--expected-bundle-id=${bundleIdentifier}`");
    expect(signedReceiptSource).toContain("`--expected-team-id=${TAXI_SIGNING_TEAM_ID}`");
    expect(signedReceiptSource).toContain("`--expected-app-group=${TAXI_APP_GROUP}`");
    expect(signedReceiptSource).toContain("provisioningArgs(extractedApp, TAXI_APP_BUNDLE_ID)");
    expect(signedReceiptSource).toContain("provisioningArgs(extractedWidget, TAXI_WIDGET_BUNDLE_ID)");
    expect(upload.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    expect(upload.with.name).toBe("taxi-signed-candidate-${{ github.run_id }}");
    expect(encryption.env.TAXI_RELEASE_CANDIDATE_KEY_BASE64).toBe("${{ secrets.TAXI_RELEASE_CANDIDATE_KEY_BASE64 }}");
    expect(encryption.run).toContain("signed-release-receipt-crypto.mjs encrypt");
    expect(upload.with.path).toContain("signed-release-receipt.json.enc");
    expect(upload.with.path).toContain("Taxi-${{ needs.resolve-release.outputs.version }}.zip.enc");
    expect(
      upload.with.path
        .split("\n")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .every((entry) => entry.endsWith(".enc")),
    ).toBe(true);
    expect(upload.with.overwrite).toBe(true);
    expect(upload.with["compression-level"]).toBe(0);
    expect(handoff.run).toContain("Signed Taxi candidate verified and stored");
    expect(handoff.run).toContain("No npm package or GitHub Release has been created");
  });

  test("requires an existing exact tag and explicit signed run/receipt for normal and resume CD", () => {
    expect(cd.on.workflow_dispatch.inputs.npm_auth_mode.default).toBe("token");
    expect(cd.on.workflow_dispatch.inputs.signed_release_run_id.required).toBe(true);
    expect(cd.on.workflow_dispatch.inputs.signed_release_receipt_sha256.required).toBe(true);
    expect(cd.jobs.publish.permissions.actions).toBe("read");
    const checkout = cd.jobs.publish.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout.with.ref).toBe("${{ inputs.release_sha || github.sha }}");
    expect(checkout.with["persist-credentials"]).toBe(false);

    const source = namedStep(cd, "publish", "Verify release source");
    expect(source.run).toContain("refs/heads/main");
    expect(source.run).toContain("git merge-base --is-ancestor");
    const version = namedStep(cd, "publish", "Version guard");
    expect(version.run).toContain("if ! git show-ref --tags");
    expect(version.run).toContain('git rev-parse "refs/tags/v${{ steps.pkg.outputs.version }}^{commit}"');

    const download = namedStep(cd, "publish", "Download signed release candidate");
    const decryption = namedStep(cd, "publish", "Decrypt signed release candidate");
    const receipt = namedStep(cd, "publish", "Verify signed release receipt");
    expect(download.run).toContain('gh run download "$SIGNED_RUN_ID"');
    expect(download.run).toContain('--name "taxi-signed-candidate-$SIGNED_RUN_ID"');
    expect(decryption.env.TAXI_RELEASE_CANDIDATE_KEY_BASE64).toBe("${{ secrets.TAXI_RELEASE_CANDIDATE_KEY_BASE64 }}");
    expect(decryption.run).toContain("signed-release-receipt-crypto.mjs decrypt");
    expect(cd.jobs.publish.steps.indexOf(download)).toBeLessThan(cd.jobs.publish.steps.indexOf(decryption));
    expect(cd.jobs.publish.steps.indexOf(decryption)).toBeLessThan(cd.jobs.publish.steps.indexOf(receipt));
    expect(receipt.run).toContain("verify-signed-release-receipt.mjs");
    expect(receipt.env.RELEASE_SHA).toBe("${{ inputs.release_sha || github.sha }}");
    expect(receipt.env.SIGNED_RUN_ID).toBe("${{ inputs.signed_release_run_id }}");
    expect(receipt.env.SIGNED_RECEIPT_SHA256).toBe("${{ inputs.signed_release_receipt_sha256 }}");
    expect(cdSource).not.toContain("gh workflow run release-app.yml");
    expect(cdSource).not.toContain("SIGNED_APP_RELEASE");
    expect(cd.jobs.ci.with.checkout_ref).toBe("${{ inputs.release_sha || github.sha }}");
    expect(ci.on.workflow_call.inputs.checkout_ref.type).toBe("string");
    for (const jobName of ["ci", "registry-introspection"]) {
      const ciCheckout = ci.jobs[jobName].steps.find((step) => step.uses?.startsWith("actions/checkout@"));
      expect(ciCheckout.with.ref).toBe("${{ inputs.checkout_ref || github.sha }}");
      expect(
        ci.jobs[jobName].steps.some(
          (step) => step.name?.startsWith("Verify requested") && step.run.includes("git rev-parse HEAD"),
        ),
      ).toBe(true);
    }
  });

  test("blocks both public mutations until environment and receipt verification pass", () => {
    const steps = cd.jobs.publish.steps;
    const environment = namedStep(cd, "publish", "Verify publish environment protection");
    const receipt = namedStep(cd, "publish", "Verify signed release receipt");
    const inspect = namedStep(cd, "publish", "Inspect root registry identity");
    const publish = namedStep(cd, "publish", "Publish root with provenance");
    const release = namedStep(cd, "publish", "Create GitHub Release");
    const npmTag = namedStep(cd, "publish", "Re-verify immutable remote tag before npm publish");
    const preNpmRelease = namedStep(cd, "publish", "Classify GitHub Release before npm publish");
    const preNpmReleaseVerify = namedStep(cd, "publish", "Verify existing immutable GitHub Release before npm publish");
    const releaseTag = namedStep(cd, "publish", "Re-verify immutable remote tag before GitHub Release");
    const existingRelease = namedStep(cd, "publish", "Classify existing GitHub Release");
    const existingReleaseVerify = namedStep(cd, "publish", "Verify existing immutable GitHub Release before resume");
    const candidateReverify = namedStep(cd, "publish", "Re-verify signed candidate immediately before GitHub Release");
    const dependencies = namedStep(cd, "publish", "Install dependencies");
    const preflight = namedStep(cd, "publish", "Release preflight (npm + MCPB)");
    expect(environment.run).toContain("--ref-name=main");
    expect(environment.run).toContain("--ref-type=branch");
    expect(environment.run).toContain("--environment=npm");
    expect(environment.run).toContain('--ref-name="$RELEASE_TAG"');
    expect(environment.run).toContain("--ref-type=tag");
    expect(environment.run).toContain("--environment=release");
    expect(steps.indexOf(environment)).toBeLessThan(steps.indexOf(receipt));
    expect(steps.indexOf(receipt)).toBeLessThan(steps.indexOf(inspect));
    expect(steps.indexOf(receipt)).toBeLessThan(steps.indexOf(dependencies));
    expect(steps.indexOf(receipt)).toBeLessThan(steps.indexOf(preflight));
    expect(steps.indexOf(receipt)).toBeLessThan(steps.indexOf(publish));
    expect(steps.indexOf(npmTag)).toBeLessThan(steps.indexOf(publish));
    expect(steps.indexOf(preNpmRelease)).toBeLessThan(steps.indexOf(publish));
    expect(preNpmRelease.run).toContain("classify-existing-github-release.mjs");
    expect(preNpmReleaseVerify.if).toBe("steps.pre-npm-github-release.outputs.state == 'immutable'");
    expect(steps.indexOf(preNpmReleaseVerify)).toBeLessThan(steps.indexOf(publish));
    expect(steps.indexOf(releaseTag)).toBeLessThan(steps.indexOf(release));
    expect(steps.indexOf(existingRelease)).toBeLessThan(steps.indexOf(release));
    expect(candidateReverify.if).toBe("steps.github-release.outputs.state == 'missing'");
    expect(candidateReverify.run).toContain("verify-signed-release-receipt.mjs");
    expect(candidateReverify.run).toContain('--archive="build/signed-candidate/Taxi-${VERSION}.zip"');
    expect(steps.indexOf(existingRelease)).toBeLessThan(steps.indexOf(candidateReverify));
    expect(steps.indexOf(candidateReverify)).toBeLessThan(steps.indexOf(release));
    expect(existingRelease.run).toContain("classify-existing-github-release.mjs");
    expect(existingReleaseVerify.if).toBe("steps.github-release.outputs.state == 'immutable'");
    expect(existingReleaseVerify.run).toContain("--skip-npx");
    expect(existingReleaseVerify.run).toContain('--app-archive="build/signed-candidate/Taxi-${VERSION}.zip"');
    expect(steps.indexOf(receipt)).toBeLessThan(steps.indexOf(release));
    expect(release.if).toBe("steps.github-release.outputs.state == 'missing'");
    expect(release.with.target_commitish).toBe("${{ inputs.release_sha || github.sha }}");
    expect(release.with.token).toBe("${{ github.token }}");
    expect(release.with.overwrite_files).toBe(true);
    expect(release.with.files).toContain("taxi-${{ steps.pkg.outputs.version }}.mcpb");
    expect(release.with.files).toContain("Taxi-${{ steps.pkg.outputs.version }}.zip");
    expect(npmTag.run).toContain("verify-remote-release-tag.mjs");
    expect(releaseTag.run).toContain("verify-remote-release-tag.mjs");
  });

  test("resumes an occupied npm version only after signed receipt, SRI, and gitHead verification", () => {
    const inspect = namedStep(cd, "publish", "Inspect root registry identity");
    const verify = namedStep(cd, "publish", "Verify root registry identity");
    expect(inspect.run).toContain("verify-publish-identity.mjs");
    expect(inspect.run).toContain('--tarball="build/release-preflight/taxi-${VERSION}.tgz"');
    expect(inspect.run).toContain("--allow-missing");
    expect(inspect.run).toContain('--expected-sha="$RELEASE_SHA"');
    expect(inspect.env.RELEASE_SHA).toBe("${{ inputs.release_sha || github.sha }}");
    const resumeBoundary = namedStep(cd, "publish", "Enforce resume mutation boundary");
    expect(resumeBoundary.env.RELEASE_SHA).toBe("${{ inputs.release_sha || github.sha }}");
    expect(resumeBoundary.env.WORKFLOW_SHA).toBe("${{ github.sha }}");
    expect(resumeBoundary.run).toContain('"$RELEASE_SHA" != "$WORKFLOW_SHA"');
    expect(resumeBoundary.run).toContain('"$CURRENT_VERSION_PUBLISHED" != "true"');
    expect(cd.on.workflow_dispatch.inputs.release_sha.description).toContain("can never create a new npm version");
    expect(verify.run).toContain("verify-publish-identity.mjs");
    expect(verify.run).toContain('--tarball="build/release-preflight/taxi-${VERSION}.tgz"');
    expect(verify.run).toContain("--retry-seconds=600");
    expect(verify.run).toContain('--expected-sha="$RELEASE_SHA"');
    expect(verify.env.RELEASE_SHA).toBe("${{ inputs.release_sha || github.sha }}");
    const auth = namedStep(cd, "publish", "Select npm auth mode");
    expect(auth.run).toContain('"$PACKAGE_VERSION" = "1.0.0"');
    expect(auth.run).toContain('"$CURRENT_VERSION_PUBLISHED" != "true"');
    expect(auth.run).toContain('"$NPM_AUTH_MODE" != "token"');
    for (const name of ["Publish root with provenance", "Publish root with provenance (token fallback)"]) {
      const publish = namedStep(cd, "publish", name);
      expect(publish.if).toContain("steps.root-identity.outputs.published != 'true'");
      expect(publish.run).toContain('npm publish "build/release-preflight/taxi-${{ steps.pkg.outputs.version }}.tgz"');
    }
    expect(releaseVerifySource).toContain("expectedGitHead");
    expect(releaseVerifySource).toContain("release.targetCommitish !== expectedGitHead");
    expect(releaseVerifySource).toContain("tarballPath: exactTarballPath");
    const publicState = namedStep(cd, "publish", "Verify public release state");
    expect(publicState.run).toContain('--tarball="build/release-preflight/taxi-${VERSION}.tgz"');
    expect(publicState.run).toContain('--expected-sha="$RELEASE_SHA"');
    expect(publicState.run).toContain('--mcpb="build/release-preflight/taxi-${VERSION}.mcpb"');
    expect(publicState.run).toContain('--app-archive="build/signed-candidate/Taxi-${VERSION}.zip"');
    expect(releaseVerifySource).toContain('"tagName,targetCommitish,url,isImmutable,assets"');
    expect(releaseVerifySource).toContain("release.isImmutable !== true");
    expect(releaseVerifySource).toContain('["release", "verify", releaseTag');
    expect(releaseVerifySource).toContain('["release", "verify-asset", releaseTag, expected.path');
    const npmUpgrade = namedStep(cd, "publish", "Upgrade npm for trusted publishing");
    expect(npmUpgrade.run).toContain("npm install -g npm@12.0.2");
    expect(npmUpgrade.run).not.toContain("npm install -g npm@12\n");
    const ghInstall = namedStep(cd, "publish", "Install checksum-pinned GitHub CLI");
    expect(ghInstall.run).toBe("bash scripts/install-pinned-gh.sh");
    expect(pinnedGhSource).toContain('GH_VERSION="2.93.0"');
    expect(pinnedGhSource).toContain("release verify --help");
    expect(pinnedGhSource).toContain("release verify-asset --help");
    expect(pinnedGhSource.match(/[0-9a-f]{64}/g)?.length).toBeGreaterThanOrEqual(4);
    const releaseCreate = namedStep(cd, "publish", "Create GitHub Release");
    expect(releaseCreate.with.overwrite_files).toBe(true);
    expect(existingReleaseSource).toContain("releases?per_page=100&page=${page}");
    expect(existingReleaseSource).toContain("The tag endpoint deliberately hides drafts");
  });

  test("does not let version-bump automation dispatch publication without a receipt", () => {
    expect(autoRelease.jobs["trigger-cd"]).toBeUndefined();
    expect(autoReleaseSource).not.toContain("gh workflow run cd.yml");
    expect(autoReleaseSource).not.toContain("actions: write");
    const handoff = namedStep(autoRelease, "publish-handoff", "Record protected publish handoff");
    expect(handoff.run).toContain("run ID and receipt SHA-256");
    expect(handoff.run).toContain("No package, release, tag, or publish workflow was created");
  });

  test("keeps first MCP Registry registration behind its own manual protected gate", () => {
    expect(registry.on.release).toBeUndefined();
    expect(registry.on.workflow_dispatch.inputs.tag.required).toBe(true);
    expect(registry.concurrency.group).toBe("mcp-registry-${{ inputs.tag }}");
    expect(registry.jobs.publish.environment).toBe("mcp-registry");
    expect(registry.jobs.publish["runs-on"]).toBe("macos-latest");
    expect(registry.jobs.publish.permissions.actions).toBe("read");
    expect(registry.jobs.publish.permissions["id-token"]).toBe("write");
    expect(registry.jobs.verify.permissions["id-token"]).toBeUndefined();
    expect(registry.jobs.verify.environment).toBeUndefined();
    const resolver = namedStep(registry, "verify", "Resolve exact registry release tag");
    expect(resolver.run).toContain('"$GITHUB_REF_TYPE" != "tag"');
    expect(resolver.run).toContain('"$GITHUB_REF" != "refs/tags/$REQUESTED_TAG"');
    const checkout = namedStep(registry, "verify", "Checkout exact release tag");
    expect(checkout.with.ref).toBe("refs/tags/${{ steps.release.outputs.tag }}");
    expect(checkout.with["persist-credentials"]).toBe(false);
    const protection = namedStep(registry, "verify", "Verify protected registry environment");
    expect(protection.run).toContain("--environment=mcp-registry");
    const identity = namedStep(registry, "verify", "Verify registry manifest and published npm identity");
    expect(identity.run).toContain("git merge-base --is-ancestor");
    const npmIdentity = namedStep(registry, "verify", "Verify exact published npm prerequisite");
    expect(npmIdentity.run).toContain("verify-publish-identity.mjs");
    expect(npmIdentity.run).toContain('--tarball="build/release-preflight/taxi-${VERSION}.tgz"');
    const canonicalArtifact = namedStep(registry, "verify", "Rebuild canonical npm release artifact");
    expect(canonicalArtifact.run).toBe("npm run release:preflight");
    expect(registry.jobs.verify.steps.indexOf(canonicalArtifact)).toBeLessThan(
      registry.jobs.verify.steps.indexOf(npmIdentity),
    );
    const npmPin = namedStep(registry, "verify", "Pin canonical npm pack implementation");
    expect(npmPin.run).toContain("npm install -g npm@12.0.2");
    expect(npmPin.run).toContain('test "$(npm --version)" = "12.0.2"');
    expect(registry.jobs.verify.steps.indexOf(npmPin)).toBeLessThan(
      registry.jobs.verify.steps.indexOf(canonicalArtifact),
    );
    expect(namedStep(registry, "verify", "Install checksum-pinned GitHub CLI").run).toBe(
      "bash scripts/install-pinned-gh.sh",
    );
    const publicApp = namedStep(registry, "verify", "Download exact public artifacts from immutable GitHub Release");
    const publicMcpb = namedStep(registry, "verify", "Inspect exact public MCPB artifact");
    const publicRelease = namedStep(registry, "verify", "Verify immutable public release prerequisite");
    expect(publicApp.run).toContain('gh release download "$RELEASE_TAG"');
    expect(publicApp.run).toContain('--pattern "taxi-${VERSION}.mcpb"');
    expect(publicMcpb.run).toContain("verify-mcpb-artifact.mjs");
    expect(publicMcpb.run).toContain("licenses:check");
    expect(publicRelease.run).toContain("npm run release:verify --");
    expect(publicRelease.run).toContain('--mcpb="build/registry-release/taxi-${VERSION}.mcpb"');
    expect(publicRelease.run).toContain('--app-archive="build/registry-release/Taxi-${VERSION}.zip"');
    const upload = namedStep(registry, "verify", "Upload verified Registry publish input");
    expect(upload.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    const download = namedStep(registry, "publish", "Download verified Registry publish input");
    expect(download.uses).toBe("actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c");
    const transferred = namedStep(registry, "publish", "Validate transferred Registry evidence");
    expect(transferred.run).toContain("registry-publish-evidence.json");
    expect(transferred.run).toContain("serverSha256");
    const remoteTag = namedStep(
      registry,
      "publish",
      "Re-verify immutable public release immediately before Registry login",
    );
    expect(remoteTag.run).toContain('gh api "repos/$GITHUB_REPOSITORY/commits/$RELEASE_TAG"');
    expect(remoteTag.run).toContain("release.isImmutable !== true");
    expect(remoteTag.run).toContain("gh release verify-asset");
    expect(registry.jobs.publish.steps.indexOf(remoteTag)).toBeLessThan(
      registry.jobs.publish.steps.indexOf(namedStep(registry, "publish", "Publish exact server.json")),
    );
    const install = namedStep(registry, "publish", "Install checksum-pinned mcp-publisher");
    expect(install.env.MCP_PUBLISHER_VERSION).toBe("v1.8.1");
    expect(install.env.MCP_PUBLISHER_DARWIN_AMD64_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(install.env.MCP_PUBLISHER_DARWIN_ARM64_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(install.run).toContain("shasum -a 256 --check");
    expect(registry.jobs.publish.steps.some((step) => step.run === "npm ci")).toBe(false);
    expect(registry.jobs.publish.steps.some((step) => step.run?.includes("release:preflight"))).toBe(false);
    expect(namedStep(registry, "publish", "Publish exact server.json").run).toBe(
      "./mcp-publisher publish build/registry-publish-input/server.json",
    );
  });

  test("scopes registry status maintenance to one exact Taxi version", () => {
    expect(registryStatus.on.workflow_dispatch.inputs.server_name).toBeUndefined();
    expect(registryStatus.on.workflow_dispatch.inputs.version.required).toBe(true);
    expect(registryStatus.concurrency.group).toBe("mcp-registry-v${{ inputs.version }}");
    expect(registryStatus.jobs["set-status"].environment).toBe("mcp-registry");
    expect(registryStatus.jobs["set-status"].permissions.actions).toBe("read");
    const validation = namedStep(registryStatus, "set-status", "Validate exact Taxi version tag");
    expect(validation.run).toContain('"$GITHUB_REF_TYPE" != "tag"');
    const protection = namedStep(registryStatus, "set-status", "Verify protected registry environment");
    expect(protection.run).toContain("--environment=mcp-registry");
    const install = namedStep(registryStatus, "set-status", "Install checksum-pinned mcp-publisher");
    expect(install.env.MCP_PUBLISHER_VERSION).toBe("v1.8.1");
    expect(install.run).toContain("sha256sum --check --strict");
    const mutation = namedStep(registryStatus, "set-status", "Set exact Taxi version status");
    expect(mutation.run).toContain('io.github.heznpc/taxi "$VERSION"');
    expect(mutation.run).not.toContain("--all-versions");
    expect(registryStatusSource).not.toContain("iconnect");
  });

  test("requires the Heznpc certificate subject before signing and suppresses raw notary identity output", () => {
    const identity = namedStep(app, "release-app", "Verify public signing identity");
    const certificateImport = namedStep(app, "release-app", "Import signing certificate");
    const signing = namedStep(app, "release-app", "Sign + notarize + staple + verify exact artifact");
    expect(identity.run).toBe("bash scripts/verify-signing-identity.sh");
    expect(app.jobs["release-app"].steps.indexOf(certificateImport)).toBeLessThan(
      app.jobs["release-app"].steps.indexOf(identity),
    );
    expect(app.jobs["release-app"].steps.indexOf(identity)).toBeLessThan(
      app.jobs["release-app"].steps.indexOf(signing),
    );
    expect(certificateImport.run).toContain("umask 077");
    expect(certificateImport.run).toContain("trap 'rm -f cert.p12' EXIT");
    expect(certificateImport.run).toContain("set-key-partition-list");
    expect(certificateImport.run).toContain(">/dev/null 2>&1");
    expect(signing.run).toContain("App Store Connect API key decoding failed");
  });

  test("requires the widget only in the signed lane while local app preflight stays fast", () => {
    expect(app.jobs["release-app"].env.TAXI_REQUIRE_WIDGET).toBe("1");
    expect(preflightSource).toContain('const REQUIRE_WIDGET = process.env.TAXI_REQUIRE_WIDGET === "1"');
    expect(preflightSource).toContain('TAXI_SKIP_WIDGET: REQUIRE_WIDGET ? "0" : "1"');
    expect(bundleSource).toContain('TAXI_REQUIRE_WIDGET="${TAXI_REQUIRE_WIDGET:-0}"');
    expect(bundleSource).toContain("Widget build failed and TAXI_REQUIRE_WIDGET=1");
    expect(bundleSource).toContain("signed distribution requires a complete TaxiWidget.appex");

    const conflictingFlags = spawnSync("bash", [bundlePath, "bundle"], {
      encoding: "utf8",
      env: { ...process.env, TAXI_REQUIRE_WIDGET: "1", TAXI_SKIP_WIDGET: "1" },
    });
    expect(conflictingFlags.status).toBe(2);
    expect(conflictingFlags.stderr).toContain("TAXI_SKIP_WIDGET=1 is not allowed");
  });
});
