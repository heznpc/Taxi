#!/usr/bin/env node
// Explicit local integration probe. Uses real MCP stdio, JXA and screencapture
// against two dedicated AppKit windows. Test code answers elicitation, so this
// does NOT prove Codex/Claude UI delivery or the signed app-owned HTTP route.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { cleanBootEnv } from "./lib/clean-boot-env.mjs";

if (process.platform !== "darwin")
  throw new Error("Requires a logged-in macOS desktop with Screen Recording permission.");
const root = fileURLToPath(new URL("..", import.meta.url));
const output = mkdtempSync(join(tmpdir(), "taxi-window-proof-"));
const binary = join(output, "TaxiWindowFixture");
execFileSync("xcrun", ["swiftc", join(root, "scripts/fixtures/development-windows.swift"), "-o", binary], {
  timeout: 60_000,
});
const fixture = spawn(binary, [], { stdio: ["pipe", "ignore", "pipe"] });
let fixtureError = "";
fixture.stderr.on("data", (chunk) => {
  fixtureError += chunk;
});
const env = {
  ...cleanBootEnv(),
  TAXI_ENABLE_SCREEN: "true",
  TAXI_TOOL_EXPOSURE: "full",
  TAXI_VECTOR_STORE_DIR: join(output, "state"),
  TAXI_TEMP_DIR: join(output, "captures"),
  TAXI_HITL_SOCKET_PATH: join(output, "absent.sock"),
  TAXI_AUDIT_FLUSH_INTERVAL: "50",
};
mkdirSync(env.TAXI_TEMP_DIR);
const approvals = [];
let decision = true;
let activeCall;
let client;
let transport;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = setTimeout(() => {
  fixture.kill("SIGTERM");
  transport?.close();
  console.error("Window verification timed out");
  process.exitCode = 1;
}, 120_000);
function data(result) {
  assert(!result.isError, JSON.stringify(result));
  const text = result.content.find((item) => item.type === "text")?.text;
  return JSON.parse(text.replace(/^\[UNTRUSTED[^\n]*\]\n/, "").replace(/\n\[END UNTRUSTED[^\n]*\]$/, ""));
}
async function start() {
  client = new Client(
    { name: "taxi-window-verification", version: "1.0.0" },
    { capabilities: { elicitation: { form: {} } } },
  );
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    assert(["list_windows", "capture_window"].includes(activeCall?.name), "Unexpected approval request");
    if (activeCall.name === "capture_window") assert.equal(activeCall.arguments.ownerPid, fixture.pid);
    assert(request.params.message.includes(activeCall.name));
    approvals.push({ tool: activeCall.name, approved: decision, source: "test-elicitation-handler" });
    return { action: "accept", content: { approve: decision } };
  });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "dist/index.js"), "run"],
    cwd: root,
    env,
    stderr: "pipe",
  });
  await client.connect(transport);
}
async function call(name, args = {}) {
  activeCall = { name, arguments: args };
  try {
    return await client.callTool(activeCall);
  } finally {
    activeCall = undefined;
  }
}
async function selected(title) {
  for (let attempt = 0; attempt < 15; attempt++) {
    const matches = data(await call("list_windows", { captureTargets: true })).filter(
      (item) => item.target.ownerPid === fixture.pid,
    );
    const match = matches.find((item) => item.target.title === title);
    if (match) return { match, matches };
    await pause(200);
  }
  throw new Error(`Fixture window unavailable. ${fixtureError}`);
}
try {
  await start();
  const permissions = data(await call("setup_permissions", { system_only: true }));
  assert.equal(
    permissions.system_permissions.screen_recording.status,
    "granted",
    "Screen Recording unavailable on the MCP execution host",
  );
  assert.equal(permissions.total, 0);
  const { match, matches } = await selected("Taxi Fixture Selected");
  assert.equal(matches.length, 2, "Expected two same-process fixture windows");
  const result = await call("capture_window", match.target);
  const evidence = data(result);
  assert.deepEqual(evidence.target, match.target);
  const png = Buffer.from(result.content.find((item) => item.type === "image").data, "base64");
  assert.equal(createHash("sha256").update(png).digest("hex"), evidence.sha256);
  assert(evidence.width >= 320 && evidence.height >= 240);
  writeFileSync(join(output, "selected.png"), png);
  execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", join(output, "selected.png")], { stdio: "ignore" });
  decision = false;
  const denied = await call("capture_window", match.target);
  assert.equal(denied.isError, true);
  assert(!denied.content.some((item) => item.type === "image"));
  decision = true;
  fixture.stdin.write("rename\n");
  await selected("Taxi Fixture Renamed");
  const stale = await call("capture_window", match.target);
  assert.equal(stale.isError, true);
  assert(stale.content.some((item) => item.type === "text" && item.text.includes("stale or unavailable")));
  assert(!stale.content.some((item) => item.type === "image"));
  await client.close();
  await start();
  const renamed = await selected("Taxi Fixture Renamed");
  const restarted = data(await call("capture_window", renamed.match.target));
  assert.deepEqual(restarted.target, renamed.match.target);
  fixture.stdin.write("close\n");
  for (let attempt = 0; attempt < 15; attempt++) {
    const targets = data(await call("list_windows", { captureTargets: true }));
    if (!targets.some((item) => item.target.windowId === renamed.match.target.windowId)) break;
    await pause(200);
  }
  const closed = await call("capture_window", renamed.match.target);
  assert.equal(closed.isError, true);
  assert(!closed.content.some((item) => item.type === "image"));
  await pause(200);
  await client.close();
  const audit = readFileSync(join(output, "state", "audit.jsonl"), "utf8");
  assert(audit.includes("capture_window"));
  const report = {
    checkedAt: new Date().toISOString(),
    route: "local MCP stdio",
    approvalSource: "test elicitation handler",
    checks: [
      "two same-app windows",
      "selected image and hash",
      "approval denied: no image",
      "renamed target rejected",
      "MCP process restart and fresh capture",
      "closed target rejected",
      "isolated audit written",
    ],
    evidence,
    approvals,
    unverified: [
      "Codex/Claude application UI",
      "signed app-owned HTTP route",
      "app update persistence",
      "real app visual correctness",
    ],
    image: join(output, "selected.png"),
  };
  writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  console.log(`Evidence: ${output}`);
} finally {
  clearTimeout(deadline);
  await client?.close();
  fixture.stdin.end("quit\n");
  fixture.kill("SIGTERM");
}
