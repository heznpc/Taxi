#!/usr/bin/env node
// Synthetic public-protocol fixture. Never reported as real provider evidence.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === 'model/list') result = { data: ['gpt-6-sol', 'gpt-6-astra', 'gpt-5.6-luna'].map(model => ({ model, supportedReasoningEfforts: ['low','medium','high'].map(reasoningEffort => ({ reasoningEffort })) })) };
  if (request.method === 'account/rateLimits/read') result = { rateLimits: { limitId: 'codex', primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: Math.floor(Date.now()/1000)+3600 }, secondary: null } };
  if (['thread/start', 'thread/resume'].includes(request.method)) {
    if (request.params.approvalPolicy !== 'never' || request.params.sandbox !== 'read-only') process.exit(10);
    const id = request.params.threadId ?? randomUUID();
    let saved = { model: 'gpt-6-sol', effort: 'medium' };
    try { saved = JSON.parse(readFileSync(join(process.env.CODEX_HOME, id), 'utf8')); } catch {}
    const model = request.params.model ?? saved.model;
    writeFileSync(join(process.env.CODEX_HOME, id), JSON.stringify({ model, effort: saved.effort }));
    result = { thread: { id }, model, reasoningEffort: saved.effort };
  }
  if (request.method === 'turn/start') {
    const { threadId, input, model, effort } = request.params;
    if (request.params.sandboxPolicy.type !== 'readOnly' || request.params.sandboxPolicy.networkAccess !== false || request.params.approvalPolicy !== 'never') process.exit(11);
    const id = randomUUID();
    writeFileSync(join(process.env.CODEX_HOME, threadId), JSON.stringify({ model, effort }));
    result = { turn: { id } };
    setTimeout(() => {
      if (input[0].text.includes('FIXTURE_DROP')) process.exit(12);
      send({ method: 'item/completed', params: { threadId, turnId: id, item: { type: 'agentMessage', text: 'Synthetic handoff response.' } } });
      send({ method: 'turn/completed', params: { threadId, turn: { id, status: input[0].text.includes('FIXTURE_FAIL') ? 'failed' : 'completed' } } });
    }, 30);
  }
  send({ id: request.id, result });
});
