import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const bundle = readFileSync(new URL("../scripts/bundle-app.sh", import.meta.url), "utf8");
const probe = readFileSync(new URL("../scripts/verify-governed-workflow.mjs", import.meta.url), "utf8");
const constants = readFileSync(new URL("../src/shared/constants.ts", import.meta.url), "utf8");
const tokenNode = readFileSync(new URL("../src/shared/app-runtime-token.ts", import.meta.url), "utf8");
const tokenSwift = readFileSync(new URL("../app/Sources/TaxiApp/AppRuntimeToken.swift", import.meta.url), "utf8");
const nodeEnvironmentSwift = readFileSync(
  new URL("../app/Sources/TaxiApp/NodeEnvironment.swift", import.meta.url),
  "utf8",
);
const serverManagerSwift = readFileSync(new URL("../app/Sources/TaxiApp/ServerManager.swift", import.meta.url), "utf8");
const app = readFileSync(new URL("../app/Sources/TaxiApp/TaxiApp.swift", import.meta.url), "utf8");
const preflight = readFileSync(new URL("../scripts/release-preflight.mjs", import.meta.url), "utf8");
const notarize = readFileSync(new URL("../scripts/notarize-app.sh", import.meta.url), "utf8");
const cdWorkflow = parseYaml(readFileSync(new URL("../.github/workflows/cd.yml", import.meta.url), "utf8"));
const appReleaseWorkflow = parseYaml(
  readFileSync(new URL("../.github/workflows/release-app.yml", import.meta.url), "utf8"),
);

function namedStep(workflow, jobName, stepName) {
  const steps = workflow.jobs[jobName].steps;
  const index = steps.findIndex((step) => step.name === stepName);
  expect(index).toBeGreaterThanOrEqual(0);
  return { index, step: steps[index], steps };
}

describe("governed app-owned acceptance wiring", () => {
  test("exposes one explicit local acceptance command", () => {
    expect(pkg.scripts["app:verify:governed"]).toBe("./scripts/bundle-app.sh verify-governed");
    expect(bundle).toContain("setup_governed_environment");
    expect(bundle).toContain("verify_governed_workflow");
    expect(bundle).toContain("verify-governed-workflow.mjs");
    expect(bundle).toMatch(
      /case "\$MODE" in\s+verify\|verify-governed\|verify-soak\|verify-appintents\)[\s\S]*?TAXI_EMBED_RUNTIME=1/,
    );
  });

  test("makes governed acceptance a blocking app release-preflight gate", () => {
    const appBranch = preflight.match(/if \(INCLUDE_APP\) \{([\s\S]*?)\} else \{/);
    expect(appBranch).not.toBeNull();
    expect(appBranch[1]).toContain('run("npm", ["run", "app:verify:governed"]');
    expect(appBranch[1]).toContain('run("npm", ["run", "app:verify:soak"]');
    expect(appBranch[1]).toContain('TAXI_SOAK_DURATION_SECONDS: "3600"');
    expect(appBranch[1]).toContain('TAXI_ALLOW_SHORT_SOAK: "0"');
    expect(preflight).toContain('const REQUIRE_WIDGET = process.env.TAXI_REQUIRE_WIDGET === "1"');
    expect(appBranch[1]).toContain('TAXI_SKIP_WIDGET: REQUIRE_WIDGET ? "0" : "1"');
    expect(appBranch[1]).toContain('TAXI_REQUIRE_WIDGET: REQUIRE_WIDGET ? "1" : "0"');
    expect(appBranch[1].indexOf("app:verify:governed")).toBeLessThan(appBranch[1].indexOf("buildAppArchive();"));
    expect(appBranch[1].indexOf("app:verify:soak")).toBeLessThan(appBranch[1].indexOf("buildAppArchive();"));
  });

  test("makes the one-hour liveness and CPU soak explicit", () => {
    expect(pkg.scripts["app:verify:soak"]).toBe("./scripts/bundle-app.sh verify-soak");
    expect(bundle).toContain('SOAK_DURATION_SECONDS="${TAXI_SOAK_DURATION_SECONDS:-3600}"');
    expect(bundle).toContain("soak-app-runtime.mjs");
    expect(bundle).toContain("verify_graceful_app_shutdown");
    expect(bundle).toContain("verify_runtime_sigterm_restart");
    expect(bundle).toContain("verify_app_crash_cleanup");
    expect(bundle).toMatch(/wait_for_http_runtime\(\)[\s\S]*?seq 1 100/);
    expect(bundle).toContain("Swift's 3s restart backoff");
    expect(bundle).toMatch(/verify-soak\)[\s\S]*?run_app_runtime_soak[\s\S]*?verify_app_crash_cleanup/);
    expect(bundle).toMatch(/verify-soak\)[\s\S]*?verify_runtime_sigterm_restart[\s\S]*?run_app_runtime_soak/);
    expect(bundle).toContain('pid_matches_generation exact "$old_runtime_pid" "$old_runtime_birth" "$bundled_runtime"');
    expect(bundle).toContain('"$VERIFIED_APP_PID" "$VERIFIED_APP_BIRTH" "$APP_BINARY"');
    expect(bundle).toContain('kill -TERM "$old_runtime_pid"');
    expect(bundle).toContain('kill -KILL "$VERIFIED_APP_PID"');
  });

  test("blocks CD publication on the exact signed-candidate receipt", () => {
    expect(cdWorkflow.jobs.publish["runs-on"]).toBe("macos-latest");
    const gate = namedStep(cdWorkflow, "publish", "Verify signed release receipt");
    expect(gate.step.run).toContain("verify-signed-release-receipt.mjs");
    expect(gate.step.if).toBeUndefined();
    expect(gate.step["continue-on-error"]).toBeUndefined();

    for (const mutation of [
      "Publish root with provenance",
      "Publish root with provenance (token fallback)",
      "Create GitHub Release",
    ]) {
      expect(gate.index).toBeLessThan(namedStep(cdWorkflow, "publish", mutation).index);
    }
  });

  test("builds only a protected signed candidate and verifies that exact artifact", () => {
    expect(appReleaseWorkflow.jobs["release-app"].environment).toBe("release");
    expect(appReleaseWorkflow.jobs["release-app"].env.TAXI_REQUIRE_WIDGET).toBe("1");
    const sourceGate = namedStep(appReleaseWorkflow, "release-app", "Release preflight (npm + MCPB)");
    const importCertificate = namedStep(appReleaseWorkflow, "release-app", "Import signing certificate");
    const signedGate = namedStep(appReleaseWorkflow, "release-app", "Sign + notarize + staple + verify exact artifact");
    const receipt = namedStep(appReleaseWorkflow, "release-app", "Create signed release receipt");
    expect(sourceGate.step.run).toBe("npm run release:preflight");
    expect(sourceGate.index).toBeLessThan(importCertificate.index);
    expect(importCertificate.index).toBeLessThan(signedGate.index);
    expect(signedGate.index).toBeLessThan(receipt.index);
    expect(notarize).toContain('APP_BUNDLE_PATH="$APP_BUNDLE" bash "$SCRIPT_DIR/verify-signed-app.sh"');
    expect(JSON.stringify(appReleaseWorkflow)).not.toContain("Attach artifacts to Release");
  });

  test("uses real MCP elicitation instead of an auto-approval server hook", () => {
    expect(probe).toContain("StreamableHTTPClientTransport");
    expect(probe).toContain("ElicitRequestSchema");
    expect(probe).toContain('{ action: "accept", content: { approve: true } }');
    expect(probe).toContain('{ action: "decline" }');
    expect(probe).not.toMatch(/AUTO.?APPROVE/i);
    expect(bundle).not.toMatch(/AUTO.?APPROVE/i);
    expect(probe).toContain('"X-Taxi-Run-ID": runId');
  });

  test("proves write isolation, emergency stop, and HMAC-chain verification", () => {
    for (const tool of ["memory_stats", "memory_put", "memory_forget", "audit_log", "audit_summary"]) {
      expect(probe).toContain(`"${tool}"`);
    }
    expect(probe).toContain("correlationId: runId");
    expect(probe).toContain('approvalDecision: "approved"');
    expect(probe).toContain('approvalDecision: "denied"');
    expect(probe).toContain('gate: "emergency_stop"');
    expect(probe).toContain("summary?.verified === true");
    expect(probe).toContain("summary?.auditDisabled === false");
    expect(bundle).toContain('TAXI_HITL_LEVEL="sensitive-only"');
    expect(bundle).toContain('TAXI_RATE_LIMIT="true"');
    expect(bundle).not.toContain('TAXI_TEST_MODE="1"');
  });

  test("shares isolated memory, HITL, config, and token paths across runtimes", () => {
    expect(constants).toContain('envStr("TAXI_MEMORY_STORE_PATH"');
    expect(constants).toContain('envStr("TAXI_HITL_SOCKET_PATH"');
    expect(tokenNode).toContain("process.env.TAXI_APP_RUNTIME_TOKEN_PATH");
    expect(tokenSwift).toContain('environment["TAXI_APP_RUNTIME_TOKEN_PATH"]');
    expect(bundle).toContain('TAXI_VECTOR_STORE_DIR="$VERIFICATION_STATE_DIR/audit"');
    expect(bundle).toContain('TAXI_EMERGENCY_STOP_PATH="$VERIFICATION_STATE_DIR/emergency-stop"');
    expect(bundle).toContain('CFFIXED_USER_HOME="$VERIFICATION_STATE_DIR/home"');
  });

  test("passes exactly the governed Node overrides through the sanitized app launch", () => {
    const setup = bundle.match(/setup_governed_environment\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const swiftKeys = nodeEnvironmentSwift.match(
      /private static let appRuntimeAcceptanceOverrideKeys = \[([\s\S]*?)\n    \]/,
    )?.[1];
    expect(swiftKeys).toBeDefined();

    const harnessKeys = new Set([...setup.matchAll(/export (TAXI_[A-Z0-9_]+)(?:=|\s|$)/gm)].map((match) => match[1]));
    for (const swiftOnly of [
      "TAXI_APP_RUNTIME_TOKEN_PATH",
      "TAXI_APP_RUNTIME_OWNER_PATH",
      "TAXI_FORCE_APP_RUNTIME",
      "TAXI_NPM_PACKAGE_SPECIFIER",
    ]) {
      harnessKeys.delete(swiftOnly);
    }
    const allowlist = new Set([...swiftKeys.matchAll(/"(TAXI_[A-Z0-9_]+)"/g)].map((match) => match[1]));

    expect([...allowlist].sort()).toEqual([...harnessKeys].sort());
    expect(nodeEnvironmentSwift).toContain('inherited["CFFIXED_USER_HOME"]');
    expect(allowlist.has("TAXI_HTTP_TOKEN")).toBe(false);
    expect(allowlist.has("TAXI_APP_RUNTIME_OWNER_SECRET")).toBe(false);
  });

  test("compiles acceptance-only launch wiring only into verification builds", () => {
    expect(serverManagerSwift).toMatch(
      /#if TAXI_ACCEPTANCE_HARNESS\s+for \(key, value\) in NodeEnvironment\.appRuntimeAcceptanceOverrides\(\)/,
    );
    expect(app).toMatch(/#if TAXI_ACCEPTANCE_HARNESS[\s\S]*?envForceAppRuntime[\s\S]*?#else[\s\S]*?return false/);
    expect(bundle).toMatch(
      /case "\$MODE" in\s+verify\|verify-governed\|verify-soak\|verify-appintents\)[\s\S]*?APP_SWIFT_BUILD_ARGS\+=\(-Xswiftc -DTAXI_ACCEPTANCE_HARNESS\)[\s\S]*?;;\s+esac/,
    );
    expect(bundle).toContain('swift build "${APP_SWIFT_BUILD_ARGS[@]}"');
    expect(bundle).toContain('BUNDLE_DIR="$PROJECT_DIR/.build/Taxi-Acceptance.app"');
    expect(bundle).toContain("Add :TaxiAcceptanceHarnessBuild bool true");
    expect(bundle).toContain('setup_acceptance_environment "taxi-governed"');
    expect(bundle).toContain('export TAXI_APP_RUNTIME_PORT="$APP_HTTP_PORT"');
    expect(bundle).toContain('export TAXI_PROFILE="full"');
    expect(bundle).toContain('export TAXI_TOOL_EXPOSURE="full"');
    expect(bundle).toContain('export TAXI_MODULE_PACKS="all"');
    expect(bundle).toContain('"$APP_BINARY" >/dev/null 2>&1 &');
    expect(app).toContain("if acceptanceHarnessForcesAppRuntime { return true }");
  });

  test("does not request notification permission when the app-side HITL listener is off", () => {
    const setup = app.match(/private func setupHitl\(\)[\s\S]*?\n    }/)?.[0] ?? "";
    expect(setup).toContain("if configManager.hitlLevel != .off");
    expect(setup).not.toContain("HitlManager.requestNotificationPermission()");
  });

  test("waits through production shutdown and asserts process/temp cleanup", () => {
    const waitSteps = Number(bundle.match(/PROCESS_SHUTDOWN_WAIT_STEPS=(\d+)/)?.[1] ?? 0);
    expect(waitSteps).toBeGreaterThanOrEqual(60);
    expect(bundle).toContain("assert_no_bundle_processes");
    expect(bundle).toContain("terminate_attested_bundle_processes");
    expect(bundle).toContain("ATTESTED_BIRTHS");
    expect(bundle).toContain('find_matching_commands contains "$PROJECT_DIR modules list --json"');
    expect(bundle).toContain('if [ -e "$state_dir" ]');
    expect(bundle).toContain("trap - EXIT");
    expect(bundle).not.toContain("terminate_matching_command");
    expect(bundle).not.toContain("stop_bundle_processes");
  });
});
