import { describe, test, expect, afterEach } from '@jest/globals';
import { mkdtempSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HarnessStore, buildHandoff } from '../dist/harness/store.js';
import { HarnessHost } from '../dist/harness/host.js';

const context = { originalRequest: 'Summarize a sample note.', decisions: ['Use one paragraph.'], openQuestions: ['Is a title required?'], completionCriteria: ['Contains the sample topic.'], evidenceRefs: ['fixture:note'] };
const roots = [];
const hosts = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), 'taxi-harness-test-')); roots.push(path); return path; };
afterEach(async () => { for (const host of hosts.splice(0)) await host.close(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('private task handoffs', () => {
  test('preserves context, distinct IDs and parent links across restart without approvals', () => {
    const path = root();
    const store = new HarnessStore(path);
    const parent = store.create(context);
    const child = store.fork(parent.id);
    expect(child.id).not.toBe(parent.id);
    expect(child.parentId).toBe(parent.id);
    expect(child.threadId).toBeNull();
    expect(child.handoff).toBe(buildHandoff(context));
    expect(child.handoff).toContain('grants no permissions or approvals');
    const resumed = new HarnessStore(path);
    expect(resumed.task(child.id)).toEqual(child);
    expect(statSync(store.file).mode & 0o777).toBe(0o600);
    expect(() => store.create({ ...context, inheritedApproval: true })).toThrow();
  });
  test('marks interrupted runs unverified instead of replaying them', () => {
    const path = root();
    const store = new HarnessStore(path);
    store.state.runs.push({ event: { phase: 'started' } });
    store.save();
    const recovered = new HarnessStore(path);
    expect(recovered.state.runs[0].event.phase).toBe('unverified');
    expect(recovered.state.runs[0].event.errorCode).toBe('runtime_restarted');
  });
  test('fails closed for corrupt saved state', () => {
    const path = root();
    writeFileSync(join(path, 'state.json'), '{');
    expect(() => new HarnessStore(path)).toThrow();
  });
});

describe('host boundaries', () => {
  test('one owner, no global relay, opt-in collection and honest compression state', async () => {
    const path = root();
    const host = new HarnessHost(path); hosts.push(host);
    expect(() => new HarnessHost(path)).toThrow('harness_owned_elsewhere');
    await expect(host.collectUsage()).rejects.toThrow('usage_consent_required');
    host.configure({ ...host.store.state.settings, compactionEnabled: true });
    const snapshot = host.snapshot();
    expect(snapshot.core.installed).toBe(true);
    expect(snapshot.compaction.configured).toBe(true);
    expect(snapshot.compaction.effective).toBe(false);
    expect(snapshot.ownership.interceptsExternalRequests).toBe(false);
    expect(snapshot.usage).toEqual([]);
    expect(JSON.parse(readFileSync(host.store.file, 'utf8')).settings.compactionEnabled).toBe(true);
  });
  test('rejects unsupported actions and missing per-run authorization', () => {
    const host = new HarnessHost(root()); hosts.push(host);
    const task = host.store.create(context);
    expect(() => host.run(task.id, { requestId: randomUUID(), provider: 'claude' })).toThrow();
  });
});
