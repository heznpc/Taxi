import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
const scratch = await mkdtemp(join(tmpdir(), 'taxi-followup-'));
process.env.TAXI_VECTOR_STORE_DIR = join(scratch, 'store');
const { parseModoreSnapshot } = await import('../dist/interop/modore.js');
const { normalizeProviderOutput } = await import('../dist/work/normalize.js');
const { executeProvider, cancelWork, inspectWork, recoverWork, reviewWork } = await import('../dist/work/provider.js');
const { acceptRemoteReply, submitRemote, reconcileRemote } = await import('../dist/remote/execution.js');
const originalPath = process.env.PATH;
beforeAll(async () => {
  await mkdir(join(scratch, 'bin'));
  await writeFile(join(scratch, 'bin', 'codex'), `#!${process.execPath}\nconst prompt=process.argv.at(-1);\nif(prompt==='wait')setInterval(()=>{},1000);\nelse if(prompt==='error'){console.log(JSON.stringify({type:'turn.failed',error:{message:'test'}}));}\nelse {console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'captured result'}}));}\n`, { mode: 0o700 });
  process.env.PATH = `${join(scratch, 'bin')}:${originalPath}`;
});
afterAll(async () => { process.env.PATH = originalPath; await rm(scratch, { recursive: true, force: true }); });

describe('Modore producer contract', () => {
  test('copied producer fixture: namespaced references, stale and digest', async () => {
    const raw = await readFile(new URL('./fixtures/modore/agent-state-snapshot-v1.json', import.meta.url));
    const output = parseModoreSnapshot(raw, '/snapshot.json', Date.parse('2026-09-09T00:00:00Z'));
    expect(output.sessions).toHaveLength(2); expect(output.freshness).toBe('stale');
    expect(output.sessions[0].provenance.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(output.authority).toBe('none');
    const future = JSON.parse(raw); future.schemaVersion = 2;
    expect(() => parseModoreSnapshot(Buffer.from(JSON.stringify(future)), '/snapshot.json')).toThrow();
    delete future.schemaVersion;
    expect(() => parseModoreSnapshot(Buffer.from(JSON.stringify(future)), '/snapshot.json')).toThrow();
  });
});
describe('provider ownership and capture', () => {
  test('process output, provenance, review and recovery never confer authority', async () => {
    const result = await executeProvider({ provider: 'codex', workspace: scratch, prompt: 'capture' });
    expect(result.outcome).toBe('returned'); expect(result.artifacts).toHaveLength(3);
    const raw = await readFile(result.artifacts[0].path, 'utf8');
    expect(normalizeProviderOutput(raw).text).toBe('captured result');
    expect((await reviewWork(result.id, 'Useful output')).authority).toBe('none');
    expect((await recoverWork(result.id)).retryable).toBe(false);
    expect((await inspectWork(result.id)).outcome).toBe('returned');
  });
  test('provider-level failure does not become success on exit zero', async () => {
    expect((await executeProvider({ provider: 'codex', workspace: scratch, prompt: 'error' })).outcome).toBe('failed');
  });
  test('timeout preserves partial evidence without replay', async () => {
    const result = await executeProvider({ provider: 'codex', workspace: scratch, prompt: 'wait', timeoutMs: 1000 });
    expect(result.outcome).toBe('unknown'); expect(result.reason).toMatch(/timeout/);
    expect(result.artifacts).toHaveLength(3);
  }, 10000);
  test('cancellation is observed by the owning executor', async () => {
    let requested;
    const running = executeProvider({ provider: 'codex', workspace: scratch, prompt: 'wait' }, id => {
      requested = cancelWork(id);
    });
    const result = await running; await requested;
    expect(result.outcome).toBe('unknown'); expect(result.reason).toMatch(/cancellation/);
  }, 10000);
  test('orphan recovery cannot rerun provider', async () => {
    const result = await executeProvider({ provider: 'codex', workspace: scratch, prompt: 'capture' });
    const path = join(scratch, 'store', 'work', result.id, 'record.json');
    await writeFile(path, JSON.stringify({ ...result, outcome: 'running', ownerPid: 2147483647 }));
    expect((await inspectWork(result.id)).outcome).toBe('unknown');
    expect((await recoverWork(result.id)).authority).toBe('none');
  });
});
describe('remote completion correlation', () => {
  test('202, matching evidence, duplicate replies, conflicting replies and cancel', async () => {
    let state = 'accepted'; let observed;
    const server = createServer(async (req, res) => {
      if (req.method === 'POST') {
        let raw = ''; for await (const chunk of req) raw += chunk;
        observed = JSON.parse(raw);
      }
      const evidence = state === 'completed' ? { source: 'fixture-executor', observedAt: '2026-09-09T00:00:00Z', result: { done: true } } : undefined;
      res.writeHead(state === 'accepted' ? 202 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ schema: 'taxi.remote-execution', schemaVersion: 1, requestId: observed.requestId, attemptId: observed.attemptId, state, evidence }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const endpoint = `http://127.0.0.1:${server.address().port}`;
      const submitted = await submitRemote(endpoint, randomUUID(), 'fixture-token');
      expect(submitted.state).toBe('accepted');
      const cancelled = await reconcileRemote(submitted.requestId, 'fixture-token', true);
      expect(cancelled.state).toBe('accepted'); // cancellation request is not acknowledgement
      state = 'completed';
      const completed = await reconcileRemote(submitted.requestId, 'fixture-token');
      expect(completed.state).toBe('completed');
      expect((await reconcileRemote(submitted.requestId, 'fixture-token')).state).toBe('completed');
      const reply = { schema: completed.schema, schemaVersion: 1, requestId: completed.requestId, attemptId: completed.attemptId, state: 'completed', evidence: completed.evidence };
      expect(() => acceptRemoteReply(completed, { ...reply, attemptId: randomUUID() })).toThrow(/correlation/);
      expect(() => acceptRemoteReply(submitted, { ...reply, evidence: undefined })).toThrow(/evidence/);
      expect(() => acceptRemoteReply(completed, { ...reply, state: 'failed' })).toThrow(/Conflicting/);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
});

describe('Windows executor transport and durable deduplication', () => {
  test('callback proof, replay, restart and auth without launching PAD on this Mac', async () => {
    const { startPadExecutor } = await import('../dist/remote/pad-executor.js');
    const flowId = randomUUID(); const token = 'fixture-token-with-at-least-32-characters';
    let launches = 0; let callback;
    const options = { directory: join(scratch, 'pad'), token, flows: { [flowId]: 'Fixture flow' }, port: 0,
      launch: async (_name, input) => { launches++; callback = input; } };
    let executor = await startPadExecutor(options);
    const command = { schema: 'taxi.remote-execution', schemaVersion: 1, requestId: randomUUID(), attemptId: randomUUID(), flowId };
    const post = () => fetch(`http://127.0.0.1:${executor.server.address().port}/requests/${command.requestId}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'idempotency-key': command.attemptId }, body: JSON.stringify(command) });
    try {
      expect((await post()).status).toBe(202);
      expect((await (await post()).json()).state).toBe('accepted'); expect(launches).toBe(1);
      const result = { requestId: command.requestId, attemptId: command.attemptId, state: 'completed', result: { fixture: 'delivered' } };
      expect((await fetch(callback.TaxiCallbackURL, { method: 'POST', body: JSON.stringify(result) })).status).toBe(401);
      const completed = await fetch(callback.TaxiCallbackURL, { method: 'POST', headers: { authorization: `Bearer ${callback.TaxiCallbackToken}` }, body: JSON.stringify(result) });
      expect((await completed.json()).state).toBe('completed');
      await executor.close(); executor = await startPadExecutor(options);
      expect((await (await post()).json()).state).toBe('completed'); expect(launches).toBe(1);
    } finally { await executor.close(); }
  });
});

test('PAD crash recovery restores records without launching or restoring authority', async () => {
  const { recoverPadStore } = await import('../dist/remote/pad-executor.js');
  const dir = join(scratch, 'orphan-pad'); await mkdir(dir);
  const id = randomUUID();
  await writeFile(join(dir, 'owner.lock'), JSON.stringify({ pid: 2147483647 }));
  await writeFile(join(dir, `${id}.json`), JSON.stringify({ requestId: id, state: 'started' }));
  expect(await recoverPadStore(dir)).toEqual({ recovered: true, resumedExecutions: 0, authority: 'none' });
  expect(JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8')).state).toBe('unknown');
  await writeFile(join(dir, 'owner.lock'), JSON.stringify({ pid: process.pid }));
  await expect(recoverPadStore(dir)).rejects.toThrow(/still be running/);
});

test('PAD can report completion before launcher returns', async () => {
  const { startPadExecutor } = await import('../dist/remote/pad-executor.js');
  const flowId = randomUUID(); const token = 'fixture-token-at-least-32-characters'; let callbackDone;
  const executor = await startPadExecutor({ directory: join(scratch,'fast-pad'), token, flows: { [flowId]: 'Fast' }, port: 0,
    launch: async (_, input) => {
      const response = await fetch(input.TaxiCallbackURL, { method: 'POST', headers: { authorization: `Bearer ${input.TaxiCallbackToken}` },
        body: JSON.stringify({requestId:input.TaxiRequestId,attemptId:input.TaxiAttemptId,state:'completed',result:'done'}) });
      callbackDone = response.status;
    } });
  try {
    const result = await submitRemote(`http://127.0.0.1:${executor.server.address().port}`,flowId,token);
    for(let i=0;i<100 && callbackDone === undefined;i++) await new Promise(resolve=>setTimeout(resolve,10));
    expect(callbackDone).toBe(200);
    expect((await reconcileRemote(result.requestId,token)).state).toBe('completed');
  } finally { await executor.close(); }
});
