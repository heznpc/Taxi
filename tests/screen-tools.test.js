import { describe, test, expect, jest } from '@jest/globals';
import { mkdtemp, writeFile, rm, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const mockRunJxa = jest.fn();

jest.unstable_mockModule('../dist/shared/jxa.js', () => ({
  runJxa: mockRunJxa,
}));

const { registerScreenTools } = await import('../dist/screen/tools.js');

function createMockServer() {
  const tools = new Map();
  return {
    registerTool(name, config, handler) {
      tools.set(name, { config, handler });
    },
    tools,
    async callTool(name, args = {}) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} not registered`);
      return tool.handler(args);
    },
  };
}

describe('Screen tools registration', () => {
  let server;

  beforeAll(() => {
    server = createMockServer();
    registerScreenTools(server, {});
  });

  test('registers all 5 screen tools', () => {
    expect(server.tools.size).toBe(5);
    const expected = [
      'capture_screen',
      'capture_window',
      'capture_area',
      'list_windows',
      'record_screen',
    ];
    for (const name of expected) {
      expect(server.tools.has(name)).toBe(true);
    }
  });

  test('all tools have titles and descriptions', () => {
    for (const [, { config }] of server.tools) {
      expect(typeof config.title).toBe('string');
      expect(config.title.length).toBeGreaterThan(0);
      expect(typeof config.description).toBe('string');
      expect(config.description.length).toBeGreaterThan(0);
    }
  });

  test('all tools have annotations', () => {
    for (const [, { config }] of server.tools) {
      expect(config.annotations).toBeDefined();
      expect(typeof config.annotations.readOnlyHint).toBe('boolean');
      expect(typeof config.annotations.destructiveHint).toBe('boolean');
    }
  });

  test('list_windows is read-only', () => {
    const { config } = server.tools.get('list_windows');
    expect(config.annotations.readOnlyHint).toBe(true);
    expect(config.annotations.destructiveHint).toBe(false);
  });

  test('exact targeting preserves the existing generated Capture Window App Intent', async () => {
    const manifest = JSON.parse(await readFile(new URL('../docs/tool-manifest.json', import.meta.url), 'utf8'));
    expect(manifest.tools.find(tool => tool.name === 'capture_window').appIntentEligible).toBe(true);
    const intents = await readFile(new URL('../swift/Sources/TaxiKit/Generated/MCPIntents.swift', import.meta.url), 'utf8');
    expect(intents).toContain('public struct CaptureWindowIntent: AppIntent');
  });

  test.each([{ windowId: 42 }, { ownerPid: 123 }, { title: '' }])(
    'rejects incomplete explicit targeting before JXA: %j', async args => {
      mockRunJxa.mockClear();
      const result = await server.callTool('capture_window', args);
      expect(result.isError).toBe(true);
      expect(mockRunJxa).not.toHaveBeenCalled();
    },
  );

  test('returns the exact PNG with traceable evidence and removes the temporary capture', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'taxi-screen-unit-'));
    const path = join(dir, 'capture.png');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII=', 'base64');
    const target = { windowId: 42, ownerPid: 123, title: 'Test' };
    try {
      await writeFile(path, png);
      mockRunJxa.mockResolvedValueOnce({ path, target, app: 'Fixture', capturedAt: '2026-09-07T00:00:00Z' });
      const result = await server.callTool('capture_window', target);
      expect(result.isError).not.toBe(true);
      expect(result.content[0]).toEqual({ type: 'image', mimeType: 'image/png', data: png.toString('base64') });
      const text = result.content[1].text;
      expect(text).toContain(createHash('sha256').update(png).digest('hex'));
      expect(text).toContain('2026-09-07T00:00:00Z');
      expect(text).toContain('"windowId": 42');
      expect(text).toContain('"width": 1');
      expect(text).toContain('caller must compare');
      await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('does not return malformed capture data as an image and still cleans up', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'taxi-screen-unit-'));
    const path = join(dir, 'capture.png');
    try {
      await writeFile(path, 'not a PNG');
      mockRunJxa.mockResolvedValueOnce({ path });
      const result = await server.callTool('capture_screen');
      expect(result.isError).toBe(true);
      expect(result.content.some(item => item.type === 'image')).toBe(false);
      await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
