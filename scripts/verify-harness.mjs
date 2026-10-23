#!/usr/bin/env node
/** Exercise the installed Taxi runtime. Fixture mode is explicit; --real-codex
 * uses a disposable CODEX_HOME with a private credential copy and makes real
 * provider requests. Nothing is sent to an existing user thread. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const arg = (name) => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; };
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverRoot = resolve(arg('--server-root') ?? repo);
const real = process.argv.includes('--real-codex');
const catalogPath = arg("--catalog");
const sourceAuth = arg('--auth-file');
if (real && (!sourceAuth || !existsSync(sourceAuth))) throw new Error('--real-codex requires --auth-file pointing to a Codex credential file');
const mode = real ? 'real-provider' : 'synthetic-protocol-fixture';
const stage = mkdtempSync(join(tmpdir(), 'taxi-harness-verify-'));
chmodSync(stage, 0o700);
const state = join(stage, 'state');
const home = join(state, 'harness', 'codex');
mkdirSync(home, { recursive: true, mode: 0o700 });
if (real) { copyFileSync(sourceAuth, join(home, 'auth.json')); chmodSync(join(home, 'auth.json'), 0o600); }
const persistent = randomBytes(32).toString('base64url');
const owner = randomBytes(32).toString('base64url');
const tokenPath = join(stage, 'token'); const ownerPath = join(stage, 'owner');
writeFileSync(tokenPath, persistent, { mode: 0o600 }); writeFileSync(ownerPath, owner, { mode: 0o600 });
const probe = createServer();
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
  TAXI_APP_OWNED_RUNTIME: '1', TAXI_APP_RUNTIME_TOKEN_PATH: tokenPath, TAXI_APP_RUNTIME_OWNER_PATH: ownerPath,
  TAXI_CONFIG_PATH: join(stage,'config.json'), TAXI_VECTOR_STORE_DIR: state, TAXI_USAGE_PROFILE_PATH: join(stage,'usage.json'),
  TAXI_MEMORY_STORE_PATH: join(stage,'memory.json'), TAXI_EMERGENCY_STOP_PATH: join(stage,'stop'),
  TAXI_HITL_SOCKET_PATH: join(stage,'hitl.sock'), TAXI_TEMP_DIR: join(stage,'tmp'), TAXI_HITL_LEVEL: 'off',
  TAXI_AUDIT_HMAC_KEY: randomBytes(32).toString('hex'), TAXI_USAGE_TRACKING: 'false', TAXI_HTTP_MAX_REQUESTS_PER_MINUTE: '2000',
  ...(real ? {} : { TAXI_CODEX_BINARY: join(repo,'tests/fixtures/harness-codex.mjs') }) };
let server = spawn(process.execPath, [join(serverRoot, 'dist/index.js'), 'run', '--http', '--port', String(port)], { cwd: stage, env, stdio: ['ignore','pipe','pipe'] });
let errors = '';
server.stdout.resume(); server.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-8000); });
try {
  let healthy = false;
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null) throw new Error(`Taxi startup failed (${server.exitCode}): ${errors.slice(-1500)}`);
    try { healthy = (await fetch(base + '/health')).ok; } catch {}
    if (healthy) break;
    await delay(150);
  }
  assert(healthy, 'packaged runtime ready');
  const { runtimeGenerationBearer, runtimeResponseProof } = await import(pathToFileURL(join(serverRoot, 'dist/shared/app-runtime-identity.js')));
  const version = JSON.parse(readFileSync(join(serverRoot, 'package.json'),'utf8')).version;
  let bearer = runtimeGenerationBearer(owner, server.pid, version);
  async function request(path = '', body, options = {}) {
    const fullPath = '/app/harness' + path;
    const nonce = randomUUID();
    const method = body === undefined ? 'GET' : 'POST';
    const response = await fetch(base + fullPath, { method, headers: {
      Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'X-Taxi-Runtime-Nonce': nonce, ...options.headers,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!options.allowFailure) {
      assert.equal(response.status, 200, `${method} ${path}: ${response.ok ? "" : await response.clone().text()}`);
      assert.equal(response.headers.get('x-taxi-runtime-proof'), runtimeResponseProof(owner, nonce, server.pid, version, method, fullPath));
    }
    return { status: response.status, data: await response.json() };
  }
  for (const headers of [{ Authorization: `Bearer ${persistent}` }, { Origin: 'https://example.invalid' }, { 'X-Taxi-Runtime-Nonce': '' }]) {
    const denial = await request('', undefined, { headers, allowFailure: true });
    assert(denial.status >= 400, 'native controls reject non-owner, browser, or missing nonce');
  }
  let snapshot = (await request()).data;
  assert.equal(snapshot.core.version, '0.2.0');
  assert.equal(snapshot.ownership.relay, 'none');
  assert.equal(snapshot.provider.home, home);
  assert.equal(snapshot.usageStatus, 'disabled');
  let model = 'gpt-6-sol'; let effort = 'medium';
  if (real) {
    const { CodexClient } = await import(pathToFileURL(join(serverRoot, 'dist/harness/codex-client.js')));
    const catalogClient = new CodexClient(home, join(state,'harness','workspace'));
    try {
      await catalogClient.start();
      const catalog = await catalogClient.request('model/list', { includeHidden: false });
      const selected = catalog.data.find(item => item.model === model) ?? catalog.data.find(item => item.isDefault) ?? catalog.data[0];
      assert(selected, 'provider supplies a model catalog');
      model = selected.model; effort = selected.defaultReasoningEffort;
    } finally { catalogClient.close(); }
  }
  const settings = { ...snapshot.settings, phasePreferences: { verification: { model, effort } }, usageEnabled: true, compactionEnabled: true, model, effort };
  snapshot = (await request('/settings', settings)).data;
  assert.deepEqual(snapshot.settings, settings);
  assert.equal(snapshot.compaction.effective, false);
  snapshot = (await request('/usage', {})).data;
  assert.equal(snapshot.usageStatus, 'observed', 'quota collected from selected provider');
  assert(snapshot.usage.length > 0);
  const context = { originalRequest: 'Reply with the word READY. Do not use tools.', decisions: ['Return one word only.'], openQuestions: [], completionCriteria: ['The output is READY.'], phase: 'research', evidenceRefs: ['verification:synthetic-context'] };
  const parent = (await request('/tasks', context)).data.task;
  const input = { requestId: randomUUID(), action: 'keep', model, effort, prompt: 'Reply with READY. Do not use any tools.', allowTaskRouting: false, confirmReadOnlyRun: true };
  const start = (await request(`/tasks/${parent.id}/run`, input)).data.run;
  const duplicate = (await request(`/tasks/${parent.id}/run`, input)).data.run;
  assert.equal(start.id, duplicate.id, 'repeat HTTP delivery never creates a second provider turn');
  const collision = await request(`/tasks/${parent.id}/run`, { ...input, prompt: 'Different instruction' }, { allowFailure: true });
  assert.equal(collision.status, 409);
  async function waitRun(id) {
    for (let i = 0; i < 500; i++) {
      const result = (await request()).data;
      const run = result.runs.find(run => run.id === id);
      if (run && !['started','response_headers'].includes(run.event.phase)) return { run, snapshot: result };
      await delay(real ? 500 : 50);
    }
    throw new Error('provider run timed out');
  }
  const first = await waitRun(start.id);
  assert.equal(first.run.event.phase, 'completed', JSON.stringify(first.run.event));
  assert.equal(first.run.event.responseModel, null, 'session acknowledgment is not response-model evidence');
  assert.equal(first.run.completionVerified, false);
  const parentThread = first.snapshot.tasks.find(task => task.id === parent.id).threadId;
  assert(parentThread);
  const child = (await request(`/tasks/${parent.id}/handoff`, { phase: "verification" })).data.task;
  assert.equal(child.parentId, parent.id);
  assert.equal(child.threadId, null);
  assert.equal(child.phase, "verification");
  assert(child.handoff.includes('Return one word only.'));
  assert(child.evidenceRefs.some(ref => ref.includes(start.id)));
  const childRun = (await request(`/tasks/${child.id}/run`, { ...input, requestId: randomUUID(), usePhasePreference: true })).data.run;
  const second = await waitRun(childRun.id);
  assert.equal(second.run.event.phase, 'completed', JSON.stringify(second.run.event));
  assert.equal(second.run.modelSelection.source, 'phase');
  assert.equal(second.run.taskPhase, 'verification');
  assert.notEqual(second.snapshot.tasks.find(task => task.id === child.id).threadId, parentThread);
  if (real) assert.match(second.run.output, /READY/);
  if (!real) {
    const change = (await request(`/tasks/${child.id}/run`, { ...input, requestId: randomUUID(), action: 'model-only', model: 'gpt-6-astra', effort: 'high' })).data.run;
    const changed = await waitRun(change.id);
    assert.equal(changed.run.event.to, 'gpt-6-astra');
    assert.equal(changed.run.event.threadId, second.run.event.threadId);
    const keep = (await request(`/tasks/${child.id}/run`, { ...input, requestId: randomUUID() })).data.run;
    assert.equal((await waitRun(keep.id)).run.event.to, 'gpt-6-astra', 'keep preserves session choice independently of settings');
    for (const [prompt, expected] of [['FIXTURE_FAIL','failed'], ['FIXTURE_DROP','unverified']]) {
      const failed = (await request(`/tasks/${child.id}/run`, { ...input, requestId: randomUUID(), prompt })).data.run;
      assert.equal((await waitRun(failed.id)).run.event.phase, expected);
    }
    await request('/settings', { ...settings, taskSavingsEnabled: true });
    const savingsTask = (await request('/tasks', { ...context, originalRequest: 'Change button label "Start" to "Begin".' })).data.task;
    const warmup = (await request(`/tasks/${savingsTask.id}/run`, { ...input, requestId: randomUUID(), model: 'gpt-6-astra', effort: 'high', allowTaskRouting: false })).data.run;
    await waitRun(warmup.id);
    const savings = (await request(`/tasks/${savingsTask.id}/run`, { ...input, requestId: randomUUID(), model: 'gpt-6-astra', effort: 'high',
      prompt: 'Change button label "Start" to "Begin".', allowTaskRouting: true })).data.run;
    const routed = await waitRun(savings.id);
    assert.equal(routed.run.event.to, 'gpt-5.6-luna');
    assert.equal(routed.run.event.routed, true);
    assert.equal(routed.run.event.savingsReason, 'simple_text_edit');
    const unsupportedTask = (await request('/tasks', context)).data.task;
    const unsupported = (await request(`/tasks/${unsupportedTask.id}/run`, { ...input, requestId: randomUUID(), model: 'unsupported-fixture-model' })).data.run;
    const refused = await waitRun(unsupported.id);
    assert.equal(refused.run.modelSelection.reason, 'unsupported_model');
    assert.equal(refused.run.dispatched, false);
    assert.equal(refused.snapshot.tasks.find(task => task.id === unsupportedTask.id).threadId, null);
    writeFileSync(env.TAXI_EMERGENCY_STOP_PATH, 'stop');
    assert.equal((await request(`/tasks/${child.id}/run`, { ...input, requestId: randomUUID() }, { allowFailure: true })).status, 409);
  }
  // Metadata import never confers status or execution authority.
  const fixtureCatalog = { schemaVersion: 1, generatedAt: '2026-01-01T00:00:00Z', source: 'modore',
    scan: { complete: false, truncated: true, errors: ['synthetic incomplete scan'] },
    sessions: ['parent', 'child'].map(key => ({ key: `fixture:${key}`, provider: 'fixture', providerSessionId: key, profileKey: 'fixture', workspacePath: null, lastActivityAt: null, provenance: 'local-metadata' })) };
  const imported = (await request('/catalog', fixtureCatalog)).data;
  assert.equal(imported.externalSessions.length, 2);
  assert(imported.externalSessions.every(session => session.status === 'unknown'));
  const link = (await request(`/tasks/${parent.id}/links`, { sessionKey: 'fixture:child', parentSessionKey: 'fixture:parent', phase: 'research', evidence: 'Synthetic explicit relation for acceptance', registeredBy: 'user' })).data.link;
  assert.equal(link.authority, 'none');
  assert.equal((await request('/catalog', { ...fixtureCatalog, schemaVersion: 2 }, { allowFailure: true })).status, 409);
  let actualCatalogCount = 0;
  if (catalogPath) {
    const actual = JSON.parse(readFileSync(catalogPath, 'utf8'));
    actualCatalogCount = actual.sessions.length;
    const actualImport = (await request('/catalog', actual)).data;
    assert.deepEqual(actualImport.catalogImports[0].scan, actual.scan);
    assert.equal(actualImport.catalogImports[0].sessionCount, actualCatalogCount);
    assert(actualImport.externalSessions.every(session => session.status === 'unknown' && session.authority === 'observe-only'));
  }
  // Inspect through the normal authenticated MCP transport and explicit tool grant.
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const mcp = new Client({ name: 'taxi-dashboard-acceptance', version: '1.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${persistent}` } } }));
  const grantResult = await mcp.callTool({ name: 'start_tool_session', arguments: { tools: ['read_task_dashboard'] } });
  const grant = grantResult.structuredContent ?? JSON.parse(grantResult.content[0].text);
  const observed = await mcp.callTool({ name: 'run_tool', arguments: { name: 'read_task_dashboard', sessionId: grant.sessionId, args: { sessionId: grant.sessionId, taskId: parent.id } } });
  assert(!observed.isError, JSON.stringify(observed));
  const relationView = observed.structuredContent ?? JSON.parse(observed.content[0].text);
  assert(relationView.tasks.some(task => task.id === parent.id));
  assert(relationView.sessionLinks.some(item => item.id === link.id));
  await mcp.close();
  server.kill('SIGTERM');
  await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(6000)]);
  assert.notEqual(server.exitCode, null, 'first runtime exits before restart');
  server = spawn(process.execPath, [join(serverRoot, 'dist/index.js'), 'run', '--http', '--port', String(port)], { cwd: stage, env, stdio: ['ignore','pipe','pipe'] });
  server.stdout.resume(); server.stderr.on('data', () => {});
  bearer = runtimeGenerationBearer(owner, server.pid, version);
  let restarted;
  for (let i = 0; i < 120; i++) {
    try { restarted = (await request()).data; break; } catch { await delay(150); }
  }
  assert(restarted?.tasks.some(task => task.id === child.id && task.parentId === parent.id));
  assert(restarted.sessionLinks.some(item => item.id === link.id));
  assert(restarted.externalSessions.length >= actualCatalogCount);
  assert(restarted.runs.some(run => run.id === childRun.id && run.event.phase === 'completed'));
  console.log(JSON.stringify({ mode, package: '@heznpc/taxi', core: '0.2.0', installedRuntime: true,
    usageObserved: true, settingsPersisted: true, restartPersisted: true, actualCatalogCount, readOnlyMcpObserved: true, phaseSelection: true, parentAndChildExecuted: true, handoffLinked: true,
    permissionScope: 'read-only', actualResponseModel: 'unverified', completionCriteria: 'not-automatically-verified' }, null, 2));
} finally {
  server.kill('SIGTERM');
  await Promise.race([new Promise(resolve => server.once('exit',resolve)), delay(6000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
  // Includes only this verifier's disposable credential copy, not the source.
  rmSync(stage, { recursive: true, force: true });
}
