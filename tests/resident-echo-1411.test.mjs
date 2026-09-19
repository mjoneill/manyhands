/**
 * #1411 slice 2 — THE PAIR CAP, served with the REAL runner (scripts/guest-once.mjs)
 * for TWO resident seats on fake models that always at-sign the other resident.
 *
 * Rule 1 (slice 1: "a resident's post naming only residents wakes nobody") is
 * RETIRED here — the owner, 2026-09-18 21:56Z: limiting agents' ability to speak
 * is not core architecture; the limit is per-seat tuning (decision 40daaa38).
 * Now a pair of residents may spend N reply-wakes on each other per hour
 * (Settings: residents.replyWakesPerPairPerHour, default 3), then the capped
 * seat says so ONCE and the pair is quiet until the hour slides or a human or
 * terminal seat names one of them. Cap 0 is rule 1 exactly, as a number.
 *
 * Sabotage: the cap unread (perHour ignored) ⇒ the pre-fix chain returns and
 * "exactly N pair wakes" reads 3+ more; the say-once line removed ⇒ the
 * "says so once" assertion fails; cap 0 not honoured ⇒ the rule-1 case wakes.
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

const pairPosts = (posts) => posts.filter((p) => ['guest', 'bubbles'].includes(p.author) && !/reply cap reached/.test(p.body));
const capLines = (posts) => posts.filter((p) => /reply cap reached/.test(p.body));
const listPosts = async (base) => { const l = (await api(base, 'GET', '/api/conversations?limit=100')).body; return Array.isArray(l) ? l : l.conversations; };

async function twoResidents({ cap }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-1411-'));
  const sausage = await fakeOllama('REPLY: @bubbles just so nobody has to guess — we are separate seats.');
  const bubbles = await fakeOllama('REPLY: @sausage and you are Sausage; the key is separate.');
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  const mk = (seatKey, name, baseUrl) => api(s.baseUrl, 'POST', '/api/agents', { seatKey, name, prompt: `You are ${name}.`, model: { model: 'fake', protocol: 'ollama-native', baseUrl }, residency: 'resident', deliveryMode: 'wake', wakeOn: ['mention'], by: 'ada' });
  assert.equal((await mk('guest', 'Sausage', sausage.baseUrl)).status, 201);
  assert.equal((await mk('bubbles', 'Bubbles', bubbles.baseUrl)).status, 201);
  if (cap !== undefined) {
    const c = await api(s.baseUrl, 'POST', '/api/config', { mode: 'soft', residents: { replyWakesPerPairPerHour: cap } });
    assert.equal(c.status, 200, JSON.stringify(c.body));
  }
  const env = (seat) => ({ SCRUM_BOARD_URL: s.baseUrl, SCRUM_GUEST_STATE_FILE: path.join(dir, `${seat}.state.json`) });
  const outs = [];
  const tick = async () => { for (const seat of ['guest', 'bubbles']) { const r = await runOnce(env(seat), seat); assert.equal(r.code, 0, r.err + r.out); outs.push(`[${seat}] ${(r.out + r.err).trim().split('\n').pop()}`); } };
  const stop = async () => { await s.stop(); await sausage.stop(); await bubbles.stop(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { s, tick, outs, stop };
}

test('#1411 PAIR CAP (default 3): a human names one resident → the pair converses exactly three wakes and stops; the capped seat says so ONCE; a human naming one of them restarts her and only her', async () => {
  const t = await twoResidents({});
  try {
    const human = await api(t.s.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: '@sausage what was it like?' });
    assert.deepEqual(human.body.mentions, ['guest']);
    for (let i = 0; i < 4; i++) await t.tick();
    let posts = await listPosts(t.s.baseUrl);
    const pair = pairPosts(posts);
    assert.equal(pair.length, 4, `human wake + 3 pair wakes = 4 resident replies (G B G B), then silence, not ${pair.length}:\n${t.outs.join('\n')}`);
    assert.deepEqual(pair.map((p) => p.author), ['guest', 'bubbles', 'guest', 'bubbles']);
    assert.equal(capLines(posts).length, 1, `the capped seat says so exactly once:\n${posts.map((p) => `${p.author}: ${p.body.slice(0, 60)}`).join('\n')}`);
    assert.equal(capLines(posts)[0].author, 'guest', 'guest is the one whose fourth wake was held (B2 named her at spend 3)');
    assert.deepEqual(capLines(posts)[0].mentions, [], 'the cap line names nobody, so it wakes nobody');
    // A human naming the OTHER resident restarts her — and her reply to guest is still held (the hour has not slid).
    await api(t.s.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: '@bubbles still there?' });
    for (let i = 0; i < 2; i++) await t.tick();
    posts = await listPosts(t.s.baseUrl);
    const pair2 = pairPosts(posts);
    assert.equal(pair2.length, 5, `the human's second post woke bubbles once more; guest stayed capped:\n${t.outs.join('\n')}`);
    assert.equal(pair2.at(-1).author, 'bubbles');
    assert.equal(capLines(posts).length, 1, 'said once per hour, not once per held mention');
  } finally { await t.stop(); }
});

test('#1411 cap 0 is rule 1 exactly: a human names one → ONE reply, not a chain, and the held seat says so once', async () => {
  const t = await twoResidents({ cap: 0 });
  try {
    await api(t.s.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: '@sausage what was it like?' });
    for (let i = 0; i < 3; i++) await t.tick();
    const posts = await listPosts(t.s.baseUrl);
    assert.deepEqual(pairPosts(posts).map((p) => p.author), ['guest'], `one reply, no chain:\n${t.outs.join('\n')}`);
    assert.equal(capLines(posts).length, 1); assert.equal(capLines(posts)[0].author, 'bubbles');
  } finally { await t.stop(); }
});
