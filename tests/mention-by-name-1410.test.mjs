/**
 * #1410 — a resident addressed by her DISPLAY NAME wakes. The board's parser
 * has resolved names to keys since #1200 ("@sausage" → guest, recorded on the
 * row as `mentions`); the runner re-parsed the body for the KEY alone, so the
 * name the room gave her never woke her (2026-09-18 00:04–00:19Z, three
 * posts). Now the runner trusts the board's field.
 *
 * Served, with the REAL runner (scripts/guest-once.mjs against a fake model):
 * a post that says "@sausage" and never "@guest" → the guest seat wakes and
 * answers; a post naming nobody does not. Sabotage: the runner back on its
 * key regex ⇒ "woke on her display name" reads 0 posts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const api = async (base, method, p, body) => { const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
function fakeOllama(reply) {
  const srv = http.createServer((req, res) => { let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: 'fake', message: { role: 'assistant', content: reply }, done: true, done_reason: 'stop', prompt_eval_count: 40, eval_count: 9 })); }); });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ baseUrl: `http://127.0.0.1:${srv.address().port}`, stop: () => new Promise((r) => srv.close(r)) })));
}
function runOnce(env, seat) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'scripts/guest-once.mjs'), '--seat', seat], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

test('#1410 "@sausage" (display name, never the key) wakes the guest seat through the real runner; a post naming nobody does not', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mention-1410-'));
  const ollama = await fakeOllama('REPLY: You called, and by my name.');
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  try {
    const c = await api(s.baseUrl, 'POST', '/api/agents', { seatKey: 'guest', name: 'Sausage', prompt: 'You are Sausage.', model: { model: 'fake', protocol: 'ollama-native', baseUrl: ollama.baseUrl }, residency: 'resident', contextPolicy: 'thread', deliveryMode: 'wake', wakeOn: ['mention'], by: 'ada' });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const roster = await api(s.baseUrl, 'GET', '/api/roster');
    assert.equal((roster.body.seats || roster.body).guest?.name, 'Sausage', 'the roster carries her display name');

    const nobody = await api(s.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: 'a quiet line for the room' });
    assert.deepEqual(nobody.body.mentions, [], 'control: names nobody');
    const stateFile = path.join(dir, 'guest.state.json');
    const r0 = await runOnce({ SCRUM_BOARD_URL: s.baseUrl, SCRUM_GUEST_STATE_FILE: stateFile }, 'guest');
    assert.equal(r0.code, 0, r0.err + r0.out);
    assert.match(r0.out + r0.err, /nothing to wake for/, 'control: no mention, no wake');

    const named = await api(s.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: '@sausage what was it like for you?' });
    assert.equal(named.status, 201);
    assert.deepEqual(named.body.mentions, ['guest'], 'the board resolved the display name to the key');
    assert.ok(!/@guest/i.test(named.body.body), 'the post never contains the key');
    const r1 = await runOnce({ SCRUM_BOARD_URL: s.baseUrl, SCRUM_GUEST_STATE_FILE: stateFile }, 'guest');
    assert.equal(r1.code, 0, r1.err + r1.out);
    const posts = await api(s.baseUrl, 'GET', '/api/conversations?limit=50');
    const hers = (posts.body.conversations || posts.body).filter((m) => m.author === 'guest');
    assert.equal(hers.length, 1, `woke on her display name and answered: ${r1.out}`);
    assert.match(hers[0].body, /by my name/);
  } finally { await s.stop(); await ollama.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
