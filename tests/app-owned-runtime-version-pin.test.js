import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const expectedSpecifier = `@heznpc/taxi@${pkg.version}`;

const menuContent = readFileSync(new URL("../app/Sources/TaxiApp/Views/MenuContent.swift", import.meta.url), "utf8");
const serverManager = readFileSync(new URL("../app/Sources/TaxiApp/ServerManager.swift", import.meta.url), "utf8");
const app = readFileSync(new URL("../app/Sources/TaxiApp/TaxiApp.swift", import.meta.url), "utf8");
const appIntents = readFileSync(new URL("../app/Sources/TaxiApp/AppIntents.swift", import.meta.url), "utf8");
const onboarding = readFileSync(
  new URL("../app/Sources/TaxiApp/Views/OnboardingView.swift", import.meta.url),
  "utf8",
);
const config = readFileSync(new URL("../src/shared/config.ts", import.meta.url), "utf8");

describe("app-owned runtime npm package pin", () => {
  test("Swift constants pin app-owned npx commands to the bundle/package version", () => {
    expect(menuContent).toContain(`static let npmPackageVersion = "${pkg.version}"`);
    expect(menuContent).toContain('ProcessInfo.processInfo.environment["TAXI_NPM_PACKAGE_SPECIFIER"]');
    expect(menuContent).toContain('"\\(npmPackageName)@\\(npmPackageVersion)"');
    expect(menuContent).toContain("npmPackageSpecifier");
    expect(menuContent).not.toContain('["-y", npmPackageName, "connect"');
  });

  test("app runtime, AppIntents, and onboarding use the pinned specifier", () => {
    expect(serverManager).toContain("TaxiConstants.npmPackageSpecifier");
    expect(appIntents).toContain("TaxiConstants.npmPackageSpecifier");
    expect(onboarding).toContain("TaxiConstants.appOwnedProxyCommand");
    expect(onboarding).toContain("TaxiConstants.appOwnedProxyArgs");
  });

  test("AppIntents prefer the token-gated app-owned HTTP runtime before stdio fallback", () => {
    expect(appIntents).toContain("runTaxiToolViaAppRuntime");
    expect(appIntents).toContain("runTaxiToolViaStdio");
    expect(appIntents).toContain("return try await runTaxiToolViaAppRuntime(toolName, args: args)");
    expect(appIntents).toContain("return try await runTaxiToolViaStdio(toolName, args: args)");
    expect(appIntents).toContain("AppRuntimeToken.ensure()");
    expect(appIntents).toContain("TaxiConstants.appOwnedHttpURL");
    expect(appIntents).toContain(
      'request.setValue("Bearer \\(listener.authorizationToken)", forHTTPHeaderField: "Authorization")',
    );
    expect(appIntents).toContain("AppRuntimeToken.runtimeGenerationBearer(");
    expect(appIntents).toContain('request.setValue(nonce, forHTTPHeaderField: "X-Taxi-Runtime-Nonce")');
    expect(appIntents).toContain('response.value(forHTTPHeaderField: "X-Taxi-Runtime-Proof")');
    expect(appIntents).toContain("AppRuntimeToken.runtimeResponseProofIsValid(");
    expect(appIntents).not.toContain('request.setValue("Bearer \\(token)", forHTTPHeaderField: "Authorization")');
    expect(appIntents).toContain('request.setValue(sessionID, forHTTPHeaderField: "Mcp-Session-Id")');
    expect(appIntents).toContain('"application/json, text/event-stream"');
    expect(appIntents).toContain('trimmed.hasPrefix("data:")');
    expect(appIntents).toContain("allowsEmptyResponse: true");
    expect(appIntents).toContain("case toolCallUncertain(Error)");
    expect(appIntents).toContain("timeoutInterval: 135");
    expect(appIntents).toContain("case .toolCallUncertain, .rpcError, .missingToolText:");
    expect((appIntents.match(/result\["isError"\] as\? Bool == true/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(appIntents).toContain("static func probe() async -> Bool");
    expect(appIntents).toContain('"method": "tools/list"');
    expect(serverManager).toContain("await AppRuntimeClient.probe()");
    expect(serverManager).toContain("static func authenticatedRuntimeVersionAtAppEndpoint() async -> String?");
    expect(serverManager).toContain("expectedVersion: String = TaxiConstants.npmPackageVersion");
    expect(serverManager).toContain("guard version == expectedVersion else");
  });

  test("supports a persistent app-owned runtime through the system login item", () => {
    expect(serverManager).toContain("import ServiceManagement");
    expect(serverManager).toContain("SMAppService.mainApp.register()");
    expect(serverManager).toContain("SMAppService.mainApp.unregister()");
    expect(menuContent).toContain('L("settings.launchAtLogin")');
  });

  test("explicit menu and Quick Setup starts commit recovery only after verified readiness", () => {
    const setupManager = readFileSync(new URL("../app/Sources/TaxiApp/SetupManager.swift", import.meta.url), "utf8");
    const explicitStart = serverManager.match(/func startServerFromExplicitUserAction\(\) \{([\s\S]*?)\n    \}/)?.[1];

    expect(explicitStart).toBeDefined();
    expect(explicitStart).toContain("commitAutoStartOnReady: true");
    expect(explicitStart).not.toContain("autoStartEnabled = true");
    expect(serverManager).toContain("shouldCommitExplicitAutoStart(");
    expect(serverManager).toContain("hasVerifiedIdentity: existingIdentity != nil");
    expect(serverManager).toContain("hasVerifiedIdentity: runtimeIdentity != nil");
    expect(menuContent).toContain("serverManager.startServerFromExplicitUserAction()");
    expect(setupManager).toContain("serverManager.startServerFromExplicitUserAction()");
  });

  test("normal AppKit termination signals the owned runtime child", () => {
    expect(app).toContain("@NSApplicationDelegateAdaptor(TaxiApplicationDelegate.self)");
    expect(app).toContain("serverManager?.prepareForApplicationTermination()");
    expect(serverManager).toContain("func prepareForApplicationTermination()");
    // Process shutdown is covered by the native lifecycle tests; this check
    // verifies the AppKit connection without pinning its callback implementation.
    expect(serverManager).toContain("if self.isShuttingDown");
  });

  test("TypeScript app-owned proxy helper uses the same pinned package specifier", () => {
    expect(config).toContain(`process.env.TAXI_NPM_PACKAGE_SPECIFIER || "${expectedSpecifier}"`);
  });

  test("local app verification can override npx to the checkout instead of unpublished npm versions", () => {
    const bundleScript = readFileSync(new URL("../scripts/bundle-app.sh", import.meta.url), "utf8");
    expect(bundleScript).toContain('TAXI_NPM_PACKAGE_SPECIFIER="${TAXI_NPM_PACKAGE_SPECIFIER:-$PROJECT_DIR}"');
  });

  test("bundle verification forces and validates the app-owned runtime contract", () => {
    const bundleScript = readFileSync(new URL("../scripts/bundle-app.sh", import.meta.url), "utf8");
    expect(menuContent).toContain('static let envForceAppRuntime = "TAXI_FORCE_APP_RUNTIME"');
    expect(app).toContain('ProcessInfo.processInfo.environment[TaxiConstants.envForceAppRuntime] == "1"');
    expect(app).toContain("#if TAXI_ACCEPTANCE_HARNESS");
    expect(app).toContain("acceptanceHarnessForcesAppRuntime");
    expect(app).toContain("serverManager.startServerFromExplicitUserAction()");
    expect(bundleScript).toContain("export TAXI_FORCE_APP_RUNTIME=1");
    expect(bundleScript).toContain("APP_SWIFT_BUILD_ARGS+=(-Xswiftc -DTAXI_ACCEPTANCE_HARNESS)");
    expect(bundleScript).toContain('BUNDLE_DIR="$PROJECT_DIR/.build/Taxi-Acceptance.app"');
    expect(bundleScript).toContain("TaxiAcceptanceHarnessBuild");
    expect(menuContent).toContain('static let envAppRuntimePort = "TAXI_APP_RUNTIME_PORT"');
    expect(menuContent).toMatch(/#if TAXI_ACCEPTANCE_HARNESS[\s\S]*?TAXI_APP_RUNTIME_PORT/);
    expect(bundleScript).toContain("setup_acceptance_environment");
    expect(bundleScript).toContain('export TAXI_APP_RUNTIME_PORT="$APP_HTTP_PORT"');
    expect(bundleScript).toMatch(
      /case "\$MODE" in\s+verify\|verify-governed\|verify-soak\|verify-appintents\)[\s\S]*?-DTAXI_ACCEPTANCE_HARNESS[\s\S]*?;;\s+esac/,
    );
    expect(bundleScript).toContain("verify_app_owned_runtime");
    expect(bundleScript).toContain("app-owned runtime version mismatch");
    expect(bundleScript).toContain("unauthenticated /mcp request should return 401");
    expect(bundleScript).toContain("probe-app-runtime.mjs");
    expect(bundleScript).toContain("generation-authenticated MCP initialize/tools-list failed");
  });
});
