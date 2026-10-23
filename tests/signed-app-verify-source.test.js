import { afterEach, describe, expect, test } from "@jest/globals";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scriptPath = new URL("../scripts/verify-signed-app.sh", import.meta.url);
const script = readFileSync(scriptPath, "utf8");
const notarizePath = new URL("../scripts/notarize-app.sh", import.meta.url);
const notarize = readFileSync(notarizePath, "utf8");
const bundleScript = readFileSync(new URL("../scripts/bundle-app.sh", import.meta.url), "utf8");
const mainEntitlements = readFileSync(new URL("../scripts/lib/main-app-entitlements.plist", import.meta.url), "utf8");
const widgetEntitlements = readFileSync(new URL("../scripts/lib/widget-entitlements.plist", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const temporaryDirectories = [];
const mainValidatorStart = notarize.indexOf("MAIN_BASE_ENTITLEMENTS=(");
const mainValidatorEnd = notarize.indexOf("\nverify_widget_entitlements()");
const mainValidatorSource = notarize.slice(mainValidatorStart, mainValidatorEnd);
const widgetValidatorStart = notarize.indexOf("WIDGET_BASE_ENTITLEMENTS=(");
const widgetValidatorEnd = notarize.indexOf("\n# Inspect the source signature");
const widgetValidatorSource = notarize.slice(widgetValidatorStart, widgetValidatorEnd);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createAcceptanceHarnessBundle() {
  const directory = mkdtempSync(join(tmpdir(), "taxi-marked-app-"));
  temporaryDirectories.push(directory);
  const bundle = join(directory, "Taxi.app");
  const contents = join(bundle, "Contents");
  mkdirSync(contents, { recursive: true });
  writeFileSync(
    join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>app.taxi</string>
  <key>TaxiAcceptanceHarnessBuild</key>
  <true/>
</dict>
</plist>
`,
    { mode: 0o600 },
  );
  return bundle;
}

function artifactGateEnvironment(bundle) {
  const environment = { ...process.env, APP_BUNDLE_PATH: bundle };
  for (const name of [
    "APPLE_DEVELOPER_ID",
    "APPLE_API_KEY_PATH",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER_ID",
    "NOTARY_KEYCHAIN_PROFILE",
    "APPLE_TEAM_ID",
  ]) {
    delete environment[name];
  }
  return environment;
}

function validateMainEntitlements(contents) {
  const directory = mkdtempSync(join(tmpdir(), "taxi-main-entitlements-"));
  temporaryDirectories.push(directory);
  const entitlements = join(directory, "candidate.plist");
  const harness = join(directory, "validate.sh");
  writeFileSync(entitlements, contents);
  writeFileSync(
    harness,
    `#!/bin/bash
set -euo pipefail
ENT_DIR="$1"
${mainValidatorSource}
verify_main_entitlements "$2" "contract" "ad-hoc"
`,
  );
  return spawnSync("bash", [harness, directory, entitlements], { encoding: "utf8" });
}

function validateWidgetEntitlements(contents) {
  const directory = mkdtempSync(join(tmpdir(), "taxi-widget-entitlements-"));
  temporaryDirectories.push(directory);
  const entitlements = join(directory, "candidate.plist");
  const harness = join(directory, "validate.sh");
  writeFileSync(entitlements, contents);
  writeFileSync(
    harness,
    `#!/bin/bash
set -euo pipefail
ENT_DIR="$1"
${widgetValidatorSource}
verify_widget_entitlements "$2" "contract" "ad-hoc"
`,
  );
  return spawnSync("bash", [harness, directory, entitlements], { encoding: "utf8" });
}

describe("signed app artifact verification script", () => {
  test("is valid bash", () => {
    expect(() => execFileSync("bash", ["-n", scriptPath.pathname], { stdio: "pipe" })).not.toThrow();
  });

  test("verifies an existing signed artifact instead of rebuilding it", () => {
    expect(script).toContain("codesign --verify --deep --strict");
    expect(script).toContain("SIGN_AUTHORITY=");
    // The team anchor and authority-shape verifier are centralised without
    // hard-coding the individual account holder's legal name in source.
    expect(script).toContain("lib/signing-identity.sh");
    expect(script).toContain('is_taxi_developer_id_authority "$SIGN_AUTHORITY"');
    expect(script).toContain('"$TAXI_SIGNING_TEAM_ID"');
    expect(script).toContain("TeamIdentifier=");
    expect(script).toContain("spctl --assess --type execute");
    expect(script).toContain("xcrun stapler validate");
    expect(script).toContain("probe-app-runtime.mjs");
    expect(script).toContain("/app/runtime-state");
    expect(script).toContain('CURRENT_CONFIG_FILE="$CURRENT_HOME/.config/taxi/config.json"');
    expect(script).toContain('CURRENT_TOKEN_FILE="$CURRENT_HOME/Library/Application Support/Taxi/http-token"');
    expect(script).toContain("features");
    expect(script).toContain('"auditLog": false');
    expect(script).toContain('"usageTracking": false');
    expect(script).toContain('defaults write "$CURRENT_HOME/Library/Preferences/app.taxi"');
    expect(script).toContain("autoStartServer -bool true");
    expect(script).toContain("onboardingPresented -bool true");
    expect(script).toContain('--env "HOME=$CURRENT_HOME"');
    expect(script).toContain('--env "CFFIXED_USER_HOME=$CURRENT_HOME"');
    expect(script).not.toContain('--env "TAXI_');
    expect(script).not.toContain("TAXI_FORCE_APP_RUNTIME");
    expect(script).toContain("ownerFingerprint");
    expect(script).toContain("pid_matches_command");
    expect(script).toContain('--owner-secret-file "$CURRENT_OWNER_FILE"');
    expect(script).toContain("taxi-app-generation-bearer-v1");
    expect(script).toContain("tokenFingerprint");
    expect(script).toContain("processIdentifier == $CURRENT_APP_PID");
    expect(script).toContain("TAXI_REQUIRE_WIDGET=1");
    expect(script).toContain("TAXI_EXPECTED_SIGNING_MODE=developer-id");
    expect(script).not.toContain("TAXI_SIGNING_COMMON_NAME");
    expect(script).toContain('TAXI_EXPECTED_SIGNING_TEAM_ID="$TAXI_SIGNING_TEAM_ID"');
    expect(script).toContain("bundle structure verification failed");
    expect(script).toContain("Print :TaxiAcceptanceHarnessBuild");
    expect(script).toContain("refusing an acceptance-harness build");
    expect(script).toContain('"$APP_BUNDLE" >/dev/null 2>&1');
    expect(script).toContain("Error registering app with intents");
    expect(script).toContain("request-app-termination.js");
    expect(script).toContain("verify_normal_shutdown");
    expect(script).toContain("left its authenticated runtime running");
    expect(script).toContain('prepare_generation "normal"');
    expect(script).toContain('prepare_generation "soak-crash"');
    expect(script).toContain("verify_generation_isolation");
    expect(script).toContain('cmp -s "$CURRENT_TOKEN_FILE" "$FIRST_TOKEN_FILE"');
    expect(script).toContain('cmp -s "$CURRENT_OWNER_FILE" "$FIRST_OWNER_FILE"');
    expect(script).toContain("soak-app-runtime.mjs");
    expect(script).toContain('SIGNED_SOAK_DURATION_SECONDS="${TAXI_SIGNED_SOAK_DURATION_SECONDS:-3600}"');
    expect(script).toContain("--allow-short-soak");
    expect(script).toContain("NON-RELEASE short soak smoke passed");
    expect(script).toContain("RELEASE-QUALIFIED exact signed artifact");
    expect(script).toContain("verify_crash_watchdog_shutdown");
    expect(script).toContain('pid_matches_generation prefix "$CURRENT_APP_PID" "$CURRENT_APP_BIRTH" "$APP_BINARY"');
    expect(script).toContain('kill -KILL "$CURRENT_APP_PID"');
    expect(script).toContain("native app crash left its app-owned Node runtime orphaned");
    expect(script).toContain("verify_sigterm_runtime_restart");
    expect(script).toContain('kill -TERM "$old_runtime_pid"');
    expect(script).toContain("SIGTERM_RESTART_VERIFIED=1");
    expect(script).toContain("--min-tools 290");
    for (const tool of [
      "list_notes",
      "list_contacts",
      "send_mail",
      "list_tabs",
      "list_photos",
      "numbers_set_cell",
      "gws_sheets_read",
      "get_bluetooth_state",
      "memory_query",
    ]) {
      expect(script).toContain(`--require-tool ${tool}`);
    }
    expect(script).toContain("find_artifact_processes");
    expect(script).toContain("assert_no_artifact_processes_stably");
    expect(script).toContain("ARTIFACT_LAUNCH_ATTEMPTED=0");
    expect(script).toContain('if [ "$ARTIFACT_LAUNCH_ATTEMPTED" -eq 1 ]; then');
    expect(script).toContain("A preflight refusal");
    expect(script).toContain('"$RUNTIME_NODE"|"$RUNTIME_NODE "*');
    expect(script).toContain('"$BRIDGE_BINARY"|"$BRIDGE_BINARY "*');
    expect(script).toContain("exact command immediately before signalling");
    expect(script).not.toContain("pkill");
    expect(script).not.toContain('--token "$TOKEN"');
    expect(script).not.toContain("swift build");
    expect(script).not.toContain("bundle-app.sh");
  });

  test("package.json exposes the signed artifact gate", () => {
    expect(pkg.scripts["app:verify:signed"]).toBe("./scripts/verify-signed-app.sh");
  });

  test("decides success before emergency cleanup can hide an orphan or delayed restart", () => {
    const cleanupStart = script.indexOf("cleanup() {");
    const cleanupEnd = script.indexOf("\nprepare_generation()", cleanupStart);
    const cleanup = script.slice(cleanupStart, cleanupEnd);

    expect(cleanupStart).toBeGreaterThanOrEqual(0);
    expect(cleanupEnd).toBeGreaterThan(cleanupStart);
    expect(cleanup.indexOf("NORMAL_SHUTDOWN_VERIFIED")).toBeGreaterThanOrEqual(0);
    expect(cleanup.indexOf("SIGTERM_RESTART_VERIFIED")).toBeGreaterThanOrEqual(0);
    expect(cleanup.indexOf("SOAK_VERIFIED")).toBeGreaterThanOrEqual(0);
    expect(cleanup.indexOf("CRASH_SHUTDOWN_VERIFIED")).toBeGreaterThanOrEqual(0);
    expect(cleanup.indexOf("assert_no_artifact_processes_stably")).toBeGreaterThanOrEqual(0);
    expect(cleanup.indexOf("terminate_attested_artifact_processes")).toBeGreaterThan(
      cleanup.indexOf("assert_no_artifact_processes_stably"),
    );
    expect(cleanup).toContain("Only PID + command + birth identities authenticated by this invocation");
    expect(script).not.toContain("terminate_all_artifact_processes");
  });

  test("runs normal and crash generations in order and requires the soak before crash injection", () => {
    const firstLaunch = script.indexOf('prepare_generation "normal"');
    const normalShutdown = script.indexOf("verify_normal_shutdown", firstLaunch);
    const secondLaunch = script.indexOf('prepare_generation "soak-crash"', normalShutdown);
    const isolation = script.indexOf("verify_generation_isolation", secondLaunch);
    const restart = script.indexOf("verify_sigterm_runtime_restart", isolation);
    const soak = script.indexOf("run_signed_runtime_soak", restart);
    const crash = script.indexOf("verify_crash_watchdog_shutdown", soak);

    expect(firstLaunch).toBeGreaterThanOrEqual(0);
    expect(normalShutdown).toBeGreaterThan(firstLaunch);
    expect(secondLaunch).toBeGreaterThan(normalShutdown);
    expect(isolation).toBeGreaterThan(secondLaunch);
    expect(restart).toBeGreaterThan(isolation);
    expect(soak).toBeGreaterThan(restart);
    expect(crash).toBeGreaterThan(soak);
  });

  test("does not leave the hidden acceptance bundle registered as the app.taxi launch target", () => {
    expect(bundleScript).toContain('if [ "$ACCEPTANCE_HARNESS_BUILD" = "0" ]; then');
    expect(bundleScript).toContain("register_bundle_with_launch_services");
    expect(bundleScript).toContain('"$LSREGISTER" -u "$BUNDLE_DIR"');
    expect(bundleScript).toContain("cannot select test-only launch wiring");
  });

  test("rejects an acceptance bundle before signature checks or app execution", () => {
    const bundle = createAcceptanceHarnessBundle();
    const tripwireDirectory = join(bundle, "Contents", "tripwire-bin");
    const tripwire = join(tripwireDirectory, "node");
    const tripwireSentinel = join(bundle, "node-was-executed");
    mkdirSync(tripwireDirectory);
    writeFileSync(tripwire, '#!/bin/sh\n: > "$TAXI_TRIPWIRE_SENTINEL"\nexit 97\n');
    chmodSync(tripwire, 0o700);
    const environment = artifactGateEnvironment(bundle);
    environment.TAXI_TRIPWIRE_SENTINEL = tripwireSentinel;
    environment.PATH = `${tripwireDirectory}:${environment.PATH ?? "/usr/bin:/bin"}`;
    const result = spawnSync("bash", [scriptPath.pathname], {
      encoding: "utf8",
      env: environment,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("verify-signed-app: refusing an acceptance-harness build");
    expect(existsSync(tripwireSentinel)).toBe(false);
    expect(result.stdout).not.toContain("checking signature tree");
    expect(result.stdout).not.toContain("launching isolated artifact generation");
  });

  test("does not terminate an exact artifact process when preflight refuses before launch", () => {
    const bundle = createAcceptanceHarnessBundle();
    const executableDirectory = join(bundle, "Contents", "MacOS");
    const executable = join(executableDirectory, "Taxi");
    mkdirSync(executableDirectory);
    copyFileSync("/bin/sleep", executable);
    chmodSync(executable, 0o700);
    const existing = spawn(executable, ["30"], { stdio: "ignore" });

    try {
      expect(existing.pid).toBeDefined();
      process.kill(existing.pid, 0);
      const result = spawnSync("bash", [scriptPath.pathname], {
        encoding: "utf8",
        env: artifactGateEnvironment(bundle),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("verify-signed-app: refusing an acceptance-harness build");
      expect(existing.exitCode).toBeNull();
      expect(() => process.kill(existing.pid, 0)).not.toThrow();
    } finally {
      existing.kill("SIGKILL");
    }
  });

  test("notarization signs embedded runtime code and runs the final artifact gate", () => {
    expect(notarize).toContain("Contents/Resources/taxi/runtime/bin/node");
    expect(notarize).toContain("Contents/Resources/taxi/bin/TaxiBridge");
    expect(notarize).toContain('find "$APP_BUNDLE/Contents/Resources/taxi/runtime/lib"');
    expect(notarize).toContain('"${NOTARY_AUTH[@]}"');
    expect(notarize).toContain('bash "$SCRIPT_DIR/verify-signed-app.sh"');
    const lifecycleGate = notarize.indexOf('bash "$SCRIPT_DIR/verify-signed-app.sh"');
    expect(notarize.indexOf("post-runtime code-sign verification failed")).toBeGreaterThan(lifecycleGate);
    expect(notarize.indexOf("post-runtime Gatekeeper assessment failed")).toBeGreaterThan(lifecycleGate);
    expect(notarize.indexOf("post-runtime notarization staple validation failed")).toBeGreaterThan(lifecycleGate);
    expect(notarize.indexOf("post-runtime bundle structure verification failed")).toBeGreaterThan(lifecycleGate);
    expect(notarize).toContain("TAXI_SIGNED_VERIFICATION_OUTPUT");
    expect(notarize).toContain('schema: "taxi.signed-app-verification.v1"');
    expect(notarize).toContain('flag: "wx"');
    expect(notarize).toContain("postRuntimeStaticVerification: true");
    expect(notarize).toContain("sigtermRuntimeRestart: true");
    expect(notarize).toContain("provisioningProfiles: true");
    expect(notarize).toContain('bash "$SCRIPT_DIR/verify-signing-identity.sh"');
    expect(notarize).toContain("need_var TAXI_APP_PROVISIONING_PROFILE_PATH");
    expect(notarize).toContain("need_var TAXI_WIDGET_PROVISIONING_PROFILE_PATH");
    expect(notarize).toContain('PROFILE_VERIFIER="$SCRIPT_DIR/verify-provisioning-profile.mjs"');
    expect(notarize).toContain('verify_profile_source "$TAXI_APP_PROVISIONING_PROFILE_PATH" "$TAXI_APP_BUNDLE_ID"');
    expect(notarize).toContain(
      'verify_profile_source "$TAXI_WIDGET_PROVISIONING_PROFILE_PATH" "$TAXI_WIDGET_BUNDLE_ID"',
    );
    expect(notarize).toContain('APP_EMBEDDED_PROFILE="$APP_BUNDLE/Contents/embedded.provisionprofile"');
    expect(notarize).toContain('WIDGET_EMBEDDED_PROFILE="$WIDGET_APPEX/Contents/embedded.provisionprofile"');
    expect(notarize).toContain('/usr/bin/install -m 0644 "$TAXI_APP_PROVISIONING_PROFILE_PATH"');
    expect(notarize).toContain('/usr/bin/install -m 0644 "$TAXI_WIDGET_PROVISIONING_PROFILE_PATH"');
    expect(notarize).toContain('verify_embedded_profile "$APP_BUNDLE" "$TAXI_APP_BUNDLE_ID"');
    expect(notarize).toContain('verify_embedded_profile "$WIDGET_APPEX" "$TAXI_WIDGET_BUNDLE_ID"');
    const embedProfiles = notarize.indexOf('APP_EMBEDDED_PROFILE="$APP_BUNDLE/Contents/embedded.provisionprofile"');
    expect(embedProfiles).toBeGreaterThan(
      notarize.indexOf('verify_profile_source "$TAXI_APP_PROVISIONING_PROFILE_PATH"'),
    );
    expect(embedProfiles).toBeLessThan(notarize.indexOf("# The self-contained app embeds executable Node"));
    expect(notarize).toContain("Print :TaxiAcceptanceHarnessBuild");
    expect(notarize).toContain("refusing to sign an acceptance-harness build");
    expect(notarize).toContain('SOURCE_MAIN_ENTITLEMENTS="$ENT_DIR/source-main-app.plist"');
    expect(notarize).toContain('SOURCE_MAIN_ENTITLEMENTS_FILE="$SCRIPT_DIR/lib/main-app-entitlements.plist"');
    expect(notarize).toContain('MAIN_ENTITLEMENTS="$ENT_DIR/main-app-developer-id-entitlements.plist"');
    expect(notarize).toContain('verify_main_entitlements "$SOURCE_MAIN_ENTITLEMENTS" "source" "ad-hoc"');
    expect(notarize).toContain('verify_main_entitlements "$MAIN_ENTITLEMENTS" "allowlisted" "developer-id"');
    const outerBundleSigning = notarize.match(
      /# Finally sign the outer bundle[\s\S]*?if ! codesign --force --options=runtime --timestamp \\\n[\s\S]*?\nfi/,
    )?.[0];
    expect(outerBundleSigning).toContain('--entitlements "$MAIN_ENTITLEMENTS"');
    expect(outerBundleSigning).not.toContain("SOURCE_MAIN_ENTITLEMENTS");
    expect(notarize).toContain('FINAL_MAIN_ENTITLEMENTS="$ENT_DIR/final-main-app.plist"');
    expect(notarize).toContain('verify_main_entitlements "$FINAL_MAIN_ENTITLEMENTS" "re-signed" "developer-id"');
    expect(notarize).toContain('verify_widget_entitlements "$ent_file" "source" "ad-hoc"');
    expect(notarize).toContain('verify_widget_entitlements "$WIDGET_ENTITLEMENTS" "allowlisted" "developer-id"');
    expect(notarize).toContain('verify_widget_entitlements "$final_ent_file" "re-signed" "developer-id"');
    expect(notarize).toContain('SOURCE_WIDGET_ENTITLEMENTS_FILE="$SCRIPT_DIR/lib/widget-entitlements.plist"');
    expect(notarize).toContain('WIDGET_ENTITLEMENTS="$ENT_DIR/widget-developer-id-entitlements.plist"');
    const extensionSigning = notarize.match(
      /# Sign embedded extensions first[\s\S]*?(?=# Finally sign the outer bundle)/,
    )?.[0];
    expect(extensionSigning).toContain('--entitlements "$WIDGET_ENTITLEMENTS"');
    expect(extensionSigning).not.toContain('--entitlements "$ent_file"');
    expect(notarize).toContain("com.apple.security.application-groups");
    expect(notarize).toContain("com.apple.application-identifier");
    expect(notarize).toContain("com.apple.developer.team-identifier");
    expect(notarize).toContain("Developer ID entitlement construction failed");
    expect(notarize).toContain("com.apple.security.automation.apple-events");
    expect(notarize).toContain("for capability in calendars reminders");
    expect(notarize).toContain("personal-information\\.$capability");
    expect(notarize).toContain("application-groups entitlement must be an array");
    expect(notarize).toContain("application-groups must contain only group.app.taxi");
    expect(notarize).toContain("main-app contains an unexpected entitlement");
    expect(notarize).toContain("main-app sandbox entitlement must be a boolean");
    expect(notarize).toContain("main-app must remain outside the App Sandbox");
    expect(notarize).toContain("widget contains an unexpected entitlement");
    expect(notarize).toContain("widget must enable the App Sandbox");
    expect(notarize).not.toContain("codesigning with $APPLE_DEVELOPER_ID");
    expect(notarize).toContain('NOTARY_KEYCHAIN_PROFILE="${NOTARY_KEYCHAIN_PROFILE:-AC_API}"');
    expect(notarize).not.toContain("--apple-id");
    expect(notarize).not.toContain("APPLE_ID_PASSWORD");
    expect(notarize).not.toContain('echo "$SUBMIT_OUTPUT"');
    expect(notarize).not.toContain("preserved entitlements: $appex");
    expect(notarize).not.toContain('echo "  signing $nested"');
    expect(notarize).not.toContain('echo "  signing $appex"');
    expect(notarize).not.toContain("zipping $APP_BUNDLE");
    expect(notarize).not.toContain("✓ $APP_BUNDLE");
  });

  test("uses one exact main-app entitlement allowlist for the baseline and Developer ID signatures", () => {
    const keys = [...mainEntitlements.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]).sort();
    expect(keys).toEqual(
      [
        "com.apple.security.app-sandbox",
        "com.apple.security.application-groups",
        "com.apple.security.automation.apple-events",
      ].sort(),
    );
    expect(mainEntitlements).toMatch(/<key>com\.apple\.security\.app-sandbox<\/key>\s*<false\/>/);
    expect(mainEntitlements).toMatch(
      /<key>com\.apple\.security\.application-groups<\/key>\s*<array>\s*<string>group\.app\.taxi<\/string>\s*<\/array>/,
    );
    expect(mainEntitlements).toMatch(/<key>com\.apple\.security\.automation\.apple-events<\/key>\s*<true\/>/);
    expect(mainEntitlements).not.toMatch(/get-task-allow|disable-library-validation|allow-dyld-environment-variables/);
    expect(bundleScript).toContain('MAIN_APP_ENTITLEMENTS="$SCRIPT_DIR/lib/main-app-entitlements.plist"');
    expect(bundleScript).toContain('--entitlements "$MAIN_APP_ENTITLEMENTS"');
  });

  test("resolves a codesign selector to the signed authority and team before verification", () => {
    expect(bundleScript).toContain('SIGNED_BUNDLE_INFO="$(codesign -dv --verbose=4 "$BUNDLE_DIR" 2>&1)"');
    expect(bundleScript).toContain("SIGNED_AUTHORITY=");
    expect(bundleScript).toContain("SIGNED_TEAM_ID=");
    expect(bundleScript).toContain('TAXI_EXPECTED_SIGNING_AUTHORITY="$SIGNED_AUTHORITY"');
    expect(bundleScript).toContain('TAXI_EXPECTED_SIGNING_TEAM_ID="$SIGNED_TEAM_ID"');
    expect(bundleScript).not.toContain('TAXI_EXPECTED_SIGNING_AUTHORITY="$SIGN_IDENTITY"');
  });

  test("fails closed when a source signature adds a debug entitlement or another app group", () => {
    expect(mainValidatorStart).toBeGreaterThanOrEqual(0);
    expect(mainValidatorEnd).toBeGreaterThan(mainValidatorStart);
    expect(validateMainEntitlements(mainEntitlements).status).toBe(0);

    const withDebugEntitlement = mainEntitlements.replace(
      "</dict>",
      "\t<key>com.apple.security.get-task-allow</key>\n\t<true/>\n</dict>",
    );
    const debugResult = validateMainEntitlements(withDebugEntitlement);
    expect(debugResult.status).toBe(1);
    expect(debugResult.stderr).toContain("contains an unexpected entitlement");

    const withAnotherGroup = mainEntitlements.replace(
      "\t\t<string>group.app.taxi</string>",
      "\t\t<string>group.app.taxi</string>\n\t\t<string>group.attacker</string>",
    );
    const groupResult = validateMainEntitlements(withAnotherGroup);
    expect(groupResult.status).toBe(1);
    expect(groupResult.stderr).toContain("application-groups must contain only group.app.taxi");
  });

  test("uses and enforces one exact sandboxed widget entitlement allowlist", () => {
    const keys = [...widgetEntitlements.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]).sort();
    expect(keys).toEqual(
      [
        "com.apple.security.app-sandbox",
        "com.apple.security.application-groups",
        "com.apple.security.personal-information.calendars",
        "com.apple.security.personal-information.reminders",
      ].sort(),
    );
    expect(widgetEntitlements).toMatch(/<key>com\.apple\.security\.app-sandbox<\/key>\s*<true\/>/);
    expect(validateWidgetEntitlements(widgetEntitlements).status).toBe(0);

    const withDebugEntitlement = widgetEntitlements.replace(
      "</dict>",
      "\t<key>com.apple.security.get-task-allow</key>\n\t<true/>\n</dict>",
    );
    const debugResult = validateWidgetEntitlements(withDebugEntitlement);
    expect(debugResult.status).toBe(1);
    expect(debugResult.stderr).toContain("widget contains an unexpected entitlement");

    const withoutSandbox = widgetEntitlements.replace(
      /(<key>com\.apple\.security\.app-sandbox<\/key>\s*)<true\/>/,
      "$1<false/>",
    );
    const sandboxResult = validateWidgetEntitlements(withoutSandbox);
    expect(sandboxResult.status).toBe(1);
    expect(sandboxResult.stderr).toContain("widget must enable the App Sandbox");

    const withAnotherGroup = widgetEntitlements.replace(
      "\t\t<string>group.app.taxi</string>",
      "\t\t<string>group.app.taxi</string>\n\t\t<string>group.attacker</string>",
    );
    const groupResult = validateWidgetEntitlements(withAnotherGroup);
    expect(groupResult.status).toBe(1);
    expect(groupResult.stderr).toContain("application-groups must contain only group.app.taxi");
  });

  test("rejects an acceptance bundle before reading signing or notarization credentials", () => {
    const bundle = createAcceptanceHarnessBundle();
    const result = spawnSync("bash", [notarizePath.pathname], {
      encoding: "utf8",
      env: artifactGateEnvironment(bundle),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("notarize-app: refusing to sign an acceptance-harness build");
    expect(result.stderr).not.toContain("required env var");
    expect(result.stdout).not.toContain("codesigning with the verified Heznpc Developer ID");
    expect(result.stdout).not.toContain("submitting to Apple");
  });
});
