/**
 * #1561 (a reviewer 14:48Z, a reviewer 14:49Z) — with the executor in the change feed, an
 * executor restart makes /api/changes 503 for every wake in that window. The wake
 * used to proceed with an EMPTY tail and tell the seat nothing: "unavailable" read
 * as "nothing changed", the G1 pattern one layer up. The prompt now says so.
 * Twin: an empty but READABLE list says nothing extra.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guestOnce } from '../core/guest-loop.mjs';

async function promptWith(changes) {
  let prompt = null;
  await guestOnce({
    agent: { seatKey: 'gizmo', residency: 'resident', model: { model: 'fake', protocol: 'ollama-native', baseUrl: 'http://127.0.0.1:1' } },
    wake: { kind: 'mention', id: 'w1', author: 'ada', body: '@gizmo what changed?', createdAt: new Date().toISOString() },
    changes,
    callModel: async (agent, messages) => { prompt = messages; return { text: 'NO_REPLY', toolCalls: [], stopReason: 'stop', usage: {} }; },
    post: async () => ({ id: 'p' }),
    ledgerFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gcu-')), 'l.jsonl'),
  });
  assert.ok(prompt, 'the model was called');
  return prompt.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
}

test('#1561 an UNREADABLE change list is said in the wake prompt, never shown as nothing', async () => {
  const text = await promptWith(() => { throw new Error('changes 503: executor unavailable'); });
  assert.match(text, /recent changes could not be read/i);
  assert.match(text, /not evidence that nothing changed/i);
});

test('#1561 twin: an empty but readable change list adds no such line', async () => {
  const text = await promptWith(() => []);
  assert.doesNotMatch(text, /could not be read/i);
});
