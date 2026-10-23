import { describe, test, expect, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessStore } from '../dist/harness/store.js';
import { mergeCatalog, catalogFreshness } from '../dist/harness/catalog.js';
import { readTaskDashboard } from '../dist/harness/dashboard.js';
import { registerTaskDashboardTool } from '../dist/harness/tools.js';
import { toolSessions } from '../dist/shared/tool-sessions.js';
const roots = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), 'taxi-dashboard-')); roots.push(path); return path; };
afterEach(() => { toolSessions.resetForTests(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const context = { originalRequest: 'Inspect a sample', decisions: ['Do not modify'], openQuestions: ['Coverage?'], completionCriteria: ['Evidence captured'], evidenceRefs: ['fixture:sample'], phase: 'research', modelPreference: { model: 'fixture-model', effort: 'high' } };
const item = (key, profileKey = null) => ({ key, profileKey, provider: 'codex', providerSessionId: 'same-session', workspacePath: '/fixture/workspace', lastActivityAt: '2026-01-01T00:00:00Z', provenance: 'local-metadata' });
const catalog = (sessions = [item('first', 'one'), item('second', 'two')]) => ({ schemaVersion: 1, source: 'modore', generatedAt: '2026-01-01T00:00:00Z', scan: { complete: false, truncated: true, errors: ['fixture scan error'] }, sessions });

describe('catalog import and task relationships', () => {
  test('profile identity, incomplete scan, unknown execution state and explicit relation persist', () => {
    const path = root(); const store = new HarnessStore(path);
    const task = store.create(context);
    store.importCatalog(catalog());
    expect(store.state.externalSessions).toHaveLength(2);
    const link = store.link(task.id, { sessionKey: 'second', parentSessionKey: 'first', phase: 'verification', evidence: 'Explicit parent creation record', registeredBy: 'authorized-parent-session' });
    expect(link.authority).toBe('none');
    expect(() => store.link(task.id, { sessionKey: 'first', parentSessionKey: 'second', phase: 'research', evidence: 'cycle', registeredBy: 'user' })).toThrow('invalid_session_relation');
    const loaded = new HarnessStore(path);
    expect(loaded.state.sessionLinks).toEqual([link]);
    expect(loaded.state.catalogImports[0].scan).toEqual(catalog().scan);
    expect(loaded.state.externalSessions.every(s => s.status === 'unknown' && s.authority === 'observe-only')).toBe(true);
    store.importCatalog(catalog([]));
    expect(store.state.externalSessions).toHaveLength(2);
    expect(store.state.externalSessions.every(s => !s.presentInLatestImport)).toBe(true);
  });
  test('rejects unknown versions, duplicate keys, identity collisions and executable metadata', () => {
    const merged = mergeCatalog([], catalog());
    expect(() => mergeCatalog([], { ...catalog(), schemaVersion: 2 })).toThrow();
    expect(() => mergeCatalog([], catalog([item('same'), item('same')]))).toThrow('duplicate_catalog_key');
    expect(() => mergeCatalog(merged.sessions, catalog([item('first', 'other')]))).toThrow('catalog_identity_conflict');
    expect(() => mergeCatalog([], catalog([{ ...item('first'), command: 'run something' }]))).toThrow();
    expect(mergeCatalog([], catalog([item('a'), item('b')])).sessions).toHaveLength(2);
    expect(catalogFreshness('2026-01-01T00:00:00Z', Date.parse('2026-01-03T00:00:00Z'))).toBe('stale');
    expect(catalogFreshness('2026-01-03T00:00:00Z', Date.parse('2026-01-01T00:00:00Z'))).toBe('future');
  });
  test('older imports preserve fresh observations and invalid imports leave saved state intact', () => {
    const path = root(); const store = new HarnessStore(path);
    const latest = { ...catalog([item('one')]), generatedAt: '2026-01-01T02:00:00+01:00' };
    store.importCatalog(latest);
    store.importCatalog({ ...catalog([{ ...item('one'), title: 'older metadata' }]), generatedAt: '2026-01-01T00:30:00Z' });
    expect(store.state.externalSessions[0].title).toBeUndefined();
    expect(store.state.externalSessions[0].catalogGeneratedAt).toBe(latest.generatedAt);
    const before = readFileSync(store.file, 'utf8');
    expect(() => store.importCatalog(catalog([item('one', 'conflicting-profile')]))).toThrow();
    expect(readFileSync(store.file, 'utf8')).toBe(before);
  });
  test('child phase can differ while explicit context and preference are inherited', () => {
    const store = new HarnessStore(root()); const parent = store.create(context);
    const child = store.fork(parent.id, { phase: 'verification' });
    expect(child.parentId).toBe(parent.id);
    expect(child.phase).toBe('verification');
    expect(child.modelPreference).toEqual(context.modelPreference);
    expect(child.handoff).toContain('verification');
    expect(child.handoff).toContain('Coverage?');
    expect(child.handoff).toContain('Do not modify');
    expect(child.threadId).toBeNull();
  });
  test('read-only inspection leaves state unchanged and marks abandoned execution unknown', () => {
    const path = root(); const store = new HarnessStore(path); const task = store.create(context);
    store.state.runs.push({ id: 'fixture-run', taskId: task.id, prompt: 'private prompt', event: { phase: 'response_headers' } }); store.save();
    const before = readFileSync(store.file, 'utf8');
    const snapshot = readTaskDashboard(task.id, 0, 50, path);
    expect(snapshot.tasks[0].status).toBe('unknown');
    expect(snapshot.runs[0].prompt).toBeUndefined();
    expect(readFileSync(store.file, 'utf8')).toBe(before);
    expect(() => readTaskDashboard(undefined, 0, 50, root())).not.toThrow();
  });
  test('read tool requires its own explicit tool-session grant even for direct dispatch', async () => {
    let callback; registerTaskDashboardTool({ registerTool: (_name, _meta, fn) => { callback = fn; } });
    const blocked = toolSessions.start({ tools: ['read_note'], ttlSeconds: 60 });
    const denied = await callback({ sessionId: blocked.sessionId, offset: 0, limit: 1 });
    expect(denied.isError).toBe(true);
  });
});
