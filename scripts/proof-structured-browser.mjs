#!/usr/bin/env node
// Dedicated disposable Chrome profile and local fixture; never drives personal tabs.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { ChromeSession } from '../dist/browser/structured.js';
const dir = await mkdtemp(join(tmpdir(), 'taxi-chrome-proof-'));
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(`<button id="deliver" aria-label="Deliver fixture" onclick="document.title='Delivered';this.textContent='Delivered';console.log('fixture delivered');fetch('/evidence')">Deliver</button>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const child = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', url,
], { stdio: 'ignore' });
let session;
try {
  let endpoint;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { const raw = await readFile(join(dir, 'DevToolsActivePort'), 'utf8'); endpoint = `http://127.0.0.1:${raw.split('\n')[0]}`; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(endpoint, 'Chrome did not launch');
  let target;
  for (let i = 0; i < 30; i++) {
    target = (await (await fetch(`${endpoint}/json/list`)).json()).find(t => t.url === url);
    if (target) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(target);
  session = await ChromeSession.connect(endpoint, target.id, url);
  const start = performance.now();
  const before = await session.observe();
  assert.equal(before.document.elements[0].label, 'Deliver fixture');
  assert.ok(before.accessibility.length);
  assert.equal((await session.click('#deliver')).executed, true);
  await new Promise(resolve => setTimeout(resolve, 200));
  const after = await session.observe();
  assert.equal(after.document.title, 'Delivered');
  assert.ok(after.diagnostics.some(e => e.method === 'Network.responseReceived'));
  assert.ok(after.diagnostics.some(e => e.method === 'Runtime.consoleAPICalled'));
  assert.equal((await session.click('.missing')).executed, false);
  await session.call('Page.navigate', { url: 'about:blank' });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await session.click('#deliver')).reason, 'stale_target');
  const proof = { adapter: 'Chrome DOM + AX + runtime/network', verified: true, screenshotCount: 0,
    elapsedMs: performance.now() - start, exactTargetId: target.id, checked: ['DOM observation', 'AX tree', 'structured click', 'independent title read-back', 'network and console observation', 'missing selector refusal', 'stale URL refusal'],
    limitations: ['Synthetic DOM click is not a trusted user input event.', 'No vision or token-cost comparison is claimed.'], profile: dir };
  await writeFile(join(dir, 'proof.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof, null, 2));
} finally {
  session?.close(); child.kill('SIGTERM');
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
