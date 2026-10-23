// Explicit opt-in: consumes a real provider invocation. No model substitution.
// node scripts/verify-background-live.mjs codex gpt-6.1-sol xhigh /absolute/evidence-dir
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);
const [provider, model, effort, destination] = process.argv.slice(2);
if (!["codex", "claude"].includes(provider) || !model || !effort || !destination)
  throw new Error("Usage: verify-background-live.mjs <codex|claude> <model> <effort> <evidence-directory>");
const root = resolve(destination);
await mkdir(root, { recursive: true, mode: 0o700 });
const workspace = await mkdtemp(join(tmpdir(), `taxi-background-live-${provider}-`));
await writeFile(join(workspace, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
await writeFile(join(workspace, "duration.js"), "export function parseDuration(text) { return 0; }\n");
await writeFile(
  join(workspace, "duration.test.js"),
  `import {test} from 'node:test'; import assert from 'node:assert/strict'; import {parseDuration} from './duration.js';
test('compound duration',()=>assert.equal(parseDuration('1h 30m 15s'),5415));
test('single and zero',()=>{assert.equal(parseDuration('2m'),120);assert.equal(parseDuration('0s'),0)});
test('reject malformed',()=>{for(const s of ['', '1x','-1h','1h junk','1.5m']) assert.throws(()=>parseDuration(s))});
`,
);
await exec("/usr/bin/git", ["init", "-q", workspace]);
const monitorPath = join(root, "focus-monitor");
await exec("/usr/bin/xcrun", [
  "swiftc",
  fileURLToPath(new URL("./background-focus-monitor.swift", import.meta.url)),
  "-o",
  monitorPath,
]);
const stop = join(root, provider + "-" + Date.now() + "-monitor-done");
const monitor = spawn(monitorPath, [stop], { stdio: ["ignore", "pipe", "pipe"] });
let monitorOutput = "";
await new Promise((resolve, reject) => {
  monitor.on("error", reject);
  monitor.stdout.on("data", (chunk) => {
    monitorOutput += chunk;
    if (monitorOutput.includes("READY")) resolve();
  });
  monitor.once("exit", (code) => {
    if (!monitorOutput.includes("READY")) reject(new Error(`Monitor exited ${code}`));
  });
});
const monitorDone = new Promise((resolve) => monitor.once("exit", resolve));
process.env.TAXI_VECTOR_STORE_DIR = join(root, "records");
const { executeProvider } = await import("../dist/work/provider.js");
let record;
try {
  record = await executeProvider(
    {
      provider,
      workspace,
      mode: "background-only",
      model,
      effort,
      timeoutMs: 600000,
      prompt:
        "Implement parseDuration in duration.js so the supplied tests pass. Use terminal tools to inspect and edit files and run npm test. Do not change tests. Complete the implementation and report the actual test results.",
    },
    (id) => console.log(JSON.stringify({ started: id, provider })),
  );
} finally {
  await writeFile(stop, "done");
  await monitorDone;
}
let verification;
try {
  const r = await exec(process.execPath, ["--test"], { cwd: workspace, timeout: 15000 });
  verification = { passed: true, stdout: r.stdout };
} catch (e) {
  verification = { passed: false, stdout: e.stdout, stderr: e.stderr };
}
const focus = JSON.parse(monitorOutput.slice(monitorOutput.indexOf("\n") + 1));
const result = { provider, model, effort, record, verification, focus };
await writeFile(join(root, `${provider}-${record?.id ?? Date.now()}-result.json`), JSON.stringify(result, null, 2), {
  mode: 0o600,
});
await writeFile(join(root, provider + "-result.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(
  JSON.stringify(
    {
      provider,
      outcome: record?.outcome,
      verification: verification.passed,
      focus,
      result: join(root, provider + "-result.json"),
    },
    null,
    2,
  ),
);
if (
  record?.outcome !== "returned" ||
  !verification.passed ||
  !focus.completed ||
  focus.activationEvents.length ||
  !focus.sameFrontmostPID
)
  process.exitCode = 1;
