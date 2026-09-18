/**
 * #1411 — two mention-woken residents must not wake each other forever.
 *
 * Served, with the REAL runner (scripts/guest-once.mjs) for TWO resident seats
 * on fake models that always at-sign the other resident. A human names one
 * of them once. Under the old scan each reply woke the other and the board
 * grew by one post per tick without end; now a resident's reply that names
 * only residents is reply-to-reply and wakes nobody. Three ticks of both
 * runners ⇒ the human's post + exactly ONE resident reply. A human naming a
 * resident still wakes her (the first reply proves it).
 *
 * Sabotage: the resident rule removed ⇒ "one reply, not a chain" reads 3+.
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

test('#1411 two residents that always at-sign each other: a human names one → ONE reply, not a chain, across three ticks of both runners', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-1411-'));
  const sausage = await fakeOllama('REPLY: @bubbles just so nobody has to guess — we are separate seats.');
  const bubbles = await fakeOllama('REPLY: @sausage and you are Sausage; the key is separate.');
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  try {
    const mk = (seatKey, name, baseUrl) => api(s.baseUrl, 'POST', '/api/agents', { seatKey, name, prompt: `You are ${name}.`, model: { model: 'fake', protocol: 'ollama-native', baseUrl }, residency: 'resident', contextPolicy: 'thread', deliveryMode: 'wake', wakeOn: ['mention'], by: 'ada' });
    assert.equal((await mk('guest', 'Sausage', sausage.baseUrl)).status, 201);
    assert.equal((await mk('bubbles', 'Bubbles', bubbles.baseUrl)).status, 201);

    const human = await api(s.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: '@sausage what was it like?' });
    assert.deepEqual(human.body.mentions, ['guest'], 'the human names one resident');

    const env = (seat) => ({ SCRUM_BOARD_URL: s.baseUrl, SCRUM_GUEST_STATE_FILE: path.join(dir, `${seat}.state.json`) });
    const outs = [];
    for (let tick = 0; tick < 3; tick++) {
      for (const seat of ['guest', 'bubbles']) {
        const r = await runOnce(env(seat), seat);
        assert.equal(r.code, 0, r.err + r.out);
        outs.push(`[${tick}/${seat}] ${(r.out + r.err).trim().split('\n').pop()}`);
      }
    }
    const listed = (await api(s.baseUrl, 'GET', '/api/conversations?limit=50')).body; const posts = Array.isArray(listed) ? listed : listed.conversations;
    const byAuthor = posts.reduce((m, p) => ({ ...m, [p.author]: (m[p.author] || 0) + 1 }), {});
    assert.equal(byAuthor.guest, 1, `the human's mention woke her exactly once: ${JSON.stringify(byAuthor)}\n${outs.join('\n')}`);
    assert.equal(byAuthor.bubbles ?? 0, 0, `her reply named only a resident, so it woke nobody — one reply, not a chain: ${JSON.stringify(byAuthor)}\n${outs.join('\n')}`);
    assert.equal(posts.length, 2, `the board holds the human's post and one reply after three ticks of both runners, not ${posts.length}`);
  } finally { await s.stop(); await sausage.stop(); await bubbles.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
