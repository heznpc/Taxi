import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";

const bundle = readFileSync(new URL("../scripts/bundle-app.sh", import.meta.url), "utf8");
const verify = readFileSync(new URL("../scripts/verify-bundle-structure.sh", import.meta.url), "utf8");
const menu = readFileSync(new URL("../app/Sources/TaxiApp/Views/MenuContent.swift", import.meta.url), "utf8");
const server = readFileSync(new URL("../app/Sources/TaxiApp/ServerManager.swift", import.meta.url), "utf8");
const connect = readFileSync(new URL("../src/cli/connect.ts", import.meta.url), "utf8");
const signedVerify = readFileSync(new URL("../scripts/verify-signed-app.sh", import.meta.url), "utf8");

describe("self-contained macOS app bundle", () => {
  test("embeds a fixed Node runtime, universal server, production dependencies, and Swift bridge", () => {
    expect(bundle).toContain("Contents/Resources/taxi");
    expect(bundle).toContain("npm ci --omit=dev --ignore-scripts");
    expect(bundle).toContain("runtime/bin");
    expect(bundle).toContain('"$SCRIPT_DIR/lib/embed-node-runtime.sh" "$NODE_SOURCE" "$RUNTIME_ROOT/runtime"');
    expect(bundle).toContain('find "$BUNDLE_DIR/Contents/Resources/taxi/runtime/lib"');
    expect(bundle).toContain("TaxiBridge");
    expect(bundle).toContain(
      'codesign --force --sign "$SIGN_IDENTITY" "$BUNDLE_DIR/Contents/Resources/taxi/runtime/bin/node"',
    );
  });

  test("app runtime and generated client configs prefer bundled executables", () => {
    expect(menu).toContain("static var bundledServerRuntime: (node: String, entry: String)?");
    expect(menu).toContain('bundledServerRuntime?.node ?? "npx"');
    expect(server).toContain("if let runtime = TaxiConstants.bundledServerRuntime");
    expect(server).toContain('env["TAXI_BRIDGE_PATH"] = bridge');
  });

  test("bundle verification proves runtime, architecture, and widget version parity", () => {
    expect(verify).toContain("RUNTIME_VERSION=");
    expect(verify).toContain("bundled runtime version");
    expect(verify).toContain('APP_ARCHS="$(lipo -archs "$APP_BINARY")"');
    expect(verify).toContain("widget version/build");
    expect(verify).toContain("CFBundleAllowMixedLocalizations");
    expect(verify).toContain("LSMultipleInstancesProhibited");
    expect(verify).toContain("SUPPORTED_LOCALES");
    expect(verify).toContain("packaged localization missing");
    expect(verify).toContain("packaged localization is not declared");
    expect(verify).toContain("build-machine library");
    expect(bundle).toContain('rm -rf "$PREVIOUS_APP_BUILD_DIR/TaxiApp_TaxiApp.bundle"');
  });

  test("uses the app.taxi identity for packaging, verification, and CLI auto-launch", () => {
    expect(bundle).toContain('BUNDLE_ID="app.taxi"');
    expect(signedVerify).toContain('"app.taxi" "$APP_EXECUTABLE"');
    expect(connect).toContain('process.env.TAXI_APP_BUNDLE_ID ?? "app.taxi"');
  });

  test("non-interactive verification cleans up only this checkout app and runtime", () => {
    const cleanupStart = bundle.indexOf("cleanup_verification() {");
    const cleanupEnd = bundle.indexOf('\ncase "$MODE" in', cleanupStart);
    const cleanup = bundle.slice(cleanupStart, cleanupEnd);

    expect(bundle).toContain("trap cleanup_verification EXIT");
    expect(bundle).toContain("cleanup_verification()");
    expect(bundle).toContain("terminate_attested_bundle_processes");
    expect(bundle).toContain("remember_attested_generation");
    expect(bundle).toContain("pid_matches_generation");
    expect(bundle).toContain('LAUNCHED_APP_PID="$!"');
    expect(bundle).toContain("refusing verification while this exact bundle already has a process");
    expect(cleanup).toContain('if [ "$VERIFICATION_LAUNCH_ATTEMPTED" -eq 1 ]; then');
    expect(cleanup.indexOf("assert_no_bundle_processes_stably")).toBeLessThan(
      cleanup.indexOf("terminate_attested_bundle_processes"),
    );
    expect(bundle).not.toContain("stop_bundle_processes");
    expect(bundle).not.toContain("terminate_matching_command");
    expect(bundle).not.toContain('pkill -x "$APP_EXECUTABLE"');
    expect(bundle).not.toContain('pgrep -x "$APP_EXECUTABLE"');
    expect(bundle).toContain('"$APP_BINARY"|"$APP_BINARY "*');
  });
});
