/**
 * #1346 slice 3 — the runner DRAINS the delivery record, and the record's
 * transitions are guarded.
 *
 * (a) THE GUARD, found in review of slice 2: transitions other than the claim
 *     were unchecked, so a late `queued` from a retrying fanout would have
 *     RE-OPENED a published delivery and the runner would have drained it
 *     again — a second wake for an answered message. Now: terminal states
 *     accept nothing; `turn-started · published · declined · failed` require
 *     an open claim; `offered · queued` only before one.
 *
 * (b) THE DRAIN, through the REAL runner against a REAL board and a fake
 *     model: a channel-mode resident with N open deliveries gets ONE digest
 *     turn; every delivery walks offered → runner-claimed → turn-started →
 *     published (or declined with reason:explicit, or failed); a second tick
 *     finds nothing; mention and schedule wakes are IGNORED in channel mode
 *     (a mentioned message arrives through the channel anyway; the room is
 *     the clock); a breached budget leaves the deliveries OPEN and unclaimed
 *     rather than burning an attempt per tick.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';
import { effectiveWakeOn } from '../core/guest-loop.mjs';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'drain-1346-'));
async function api(base, method, p, body) {
  const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let parsed = null; try { parsed = await r.json(); } catch { /* none */ }
  return { status: r.status, body: parsed };
}
const fresh = () => makeBoardFixture({ cards: [], nextShortId: 1 });

// ── (a) the guard ───────────────────────────────────────────────────────────
test('#1346 GUARD — no step without a claim, nothing after a terminal, and a late queued cannot re-open a published delivery', async () => {
  const srv = await startRestServer({ board: fresh() });
  try {
    const msg = (await api(srv.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: 'guarded' })).body;
    const d = (await api(srv.baseUrl, 'POST', '/api/deliveries', { to: 'gizmo', conversation: msg.id, source: 'fanout', by: 'board' })).body;
    const ev = (body) => api(srv.baseUrl, 'POST', `/api/deliveries/${encodeURIComponent(d.id)}/events`, { source: 'guest-runner', by: 'gizmo', ...body });
    const state = async () => (await api(srv.baseUrl, 'GET', `/api/deliveries?conversation=${encodeURIComponent(msg.id)}`)).body.deliveries[0];

    for (const s of ['turn-started', 'published', 'declined', 'failed']) {
      const r = await ev({ state: s });
      assert.equal(r.status, 409, `${s} on a never-claimed delivery must be refused — got ${r.status}`);
    }
    assert.equal((await ev({ state: 'queued', source: 'fanout', by: 'board' })).status, 201, 'queued before a claim is fine');
    assert.equal((await ev({ state: 'runner-claimed' })).status, 201);
    assert.equal((await ev({ state: 'queued', source: 'fanout', by: 'board' })).status, 409, 'queued AFTER a claim is refused');
    assert.equal((await ev({ state: 'offered', source: 'fanout', by: 'board' })).status, 409, 'so is a second offered');
    assert.equal((await ev({ state: 'turn-started' })).status, 201);
    assert.equal((await ev({ state: 'published' })).status, 201);
    // The finding's exact shape: a retrying fanout appends queued after published.
    const late = await ev({ state: 'queued', source: 'fanout', by: 'board' });
    assert.equal(late.status, 409, 'a late queued after published is refused');
    assert.equal((await state()).state, 'published', 'and the state did not move');
    assert.equal((await api(srv.baseUrl, 'GET', '/api/deliveries?to=gizmo&open=1')).body.deliveries.length, 0, 'and it is not drainable');
    for (const s of ['turn-started', 'failed', 'declined', 'runner-claimed']) {
      assert.equal((await ev({ state: s })).status, 409, `${s} after published must be refused`);
    }
    // A delivery of a message that is DELETED is still a record; nothing here depends on the message body.
  } finally { await srv.stop(); }
});

test('#1346 effectiveWakeOn — channel mode keeps assignment and drops mention + schedule; wake mode is untouched', () => {
  assert.deepEqual(effectiveWakeOn({ deliveryMode: 'channel', wakeOn: ['mention', 'assignment', 'schedule'] }), ['assignment']);
  assert.deepEqual(effectiveWakeOn({ deliveryMode: 'channel', wakeOn: ['mention', 'schedule'] }), []);
  assert.deepEqual(effectiveWakeOn({ deliveryMode: 'channel' }), [], 'the default wakeOn (mention) is dropped too');
  assert.deepEqual(effectiveWakeOn({ deliveryMode: 'wake', wakeOn: ['mention', 'schedule'] }), ['mention', 'schedule']);
  assert.deepEqual(effectiveWakeOn({ wakeOn: ['mention'] }), ['mention'], 'absent mode is wake mode');
});

// ── (b) the drain, through the real runner ──────────────────────────────────
/** A fake Ollama whose reply can be changed between runs. */
function fakeOllama(initial = 'REPLY: I am here.') {
  const calls = []; let reply = initial;
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      calls.push({ url: req.url, body: raw });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'fake', message: { role: 'assistant', content: reply }, done: true, done_reason: 'stop', prompt_eval_count: 40, eval_count: 9 }));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    calls, baseUrl: `http://127.0.0.1:${srv.address().port}`, setReply: (r) => { reply = r; }, stop: () => new Promise((r) => srv.close(r)),
  })));
}
function runOnce(env, extraArgs = []) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [new URL('../scripts/guest-once.mjs', import.meta.url).pathname, '--seat', 'gizmo', ...extraArgs], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

test('#1346 DRAIN SEAM — N open deliveries → ONE digest turn; every record walks to published; mention and schedule do not wake a channel-mode seat', async () => {
  const srv = await startRestServer({ board: fresh() });
  const ollama = await fakeOllama('REPLY: Gizmo read all three.');
  const dir = tmpdir(); const stateFile = path.join(dir, 'gizmo.state.json');
  const env = { SCRUM_BOARD_URL: srv.baseUrl, SCRUM_GUEST_STATE_FILE: stateFile };
  try {
    const c = await api(srv.baseUrl, 'POST', '/api/agents', {
      seatKey: 'gizmo', prompt: 'Be brief.', model: { model: 'fake', protocol: 'ollama-native', baseUrl: ollama.baseUrl },
      residency: 'resident', contextPolicy: 'artifact-only', by: 'ada',
      deliveryMode: 'channel', wakeOn: ['mention', 'schedule'], everyMinutes: 1,
    });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const posts = async () => { const r = await api(srv.baseUrl, 'GET', '/api/conversations?attachedTo=null&limit=500'); const list = Array.isArray(r.body) ? r.body : r.body.conversations; return list.filter((m) => m.author === 'gizmo'); };
    const open = async () => (await api(srv.baseUrl, 'GET', '/api/deliveries?to=gizmo&open=1')).body.deliveries;
    const all = async () => (await api(srv.baseUrl, 'GET', '/api/deliveries?to=gizmo')).body.deliveries;

    // Nothing delivered yet. A wake-mode seat with wakeOn:['schedule'] and no
    // lastScheduledAt would wake RIGHT NOW; a channel-mode seat must not.
    const r0 = await runOnce(env);
    assert.equal(r0.code, 0, r0.err + r0.out);
    assert.equal(ollama.calls.length, 0, `no deliveries ⇒ no model call in channel mode, even with schedule on — ${r0.out}${r0.err}`);
    assert.equal((await posts()).length, 0);

    // Three posts, offered to gizmo (as the fanout would; the MCP is not in this harness).
    // One of them MENTIONS gizmo — it must be answered by the digest, not by a second mention wake.
    const bodies = ['the first thing', '@gizmo the second thing', 'the third thing'];
    const msgs = [];
    for (const body of bodies) {
      const m = (await api(srv.baseUrl, 'POST', '/api/conversations', { author: 'ada', body })).body; msgs.push(m);
      const d = await api(srv.baseUrl, 'POST', '/api/deliveries', { to: 'gizmo', conversation: m.id, source: 'fanout', by: 'board' });
      assert.equal(d.status, 201, JSON.stringify(d.body));
    }
    assert.equal((await open()).length, 3);

    const r1 = await runOnce(env);
    assert.equal(r1.code, 0, r1.err + r1.out);
    assert.equal(ollama.calls.length, 1, `THREE deliveries ⇒ ONE digest turn — ${r1.out}${r1.err}`);
    const prompt = ollama.calls[0].body;
    for (const b of bodies) assert.ok(prompt.includes(b), `the digest carries every delivered post — missing "${b}"`);
    const after1 = await posts();
    assert.equal(after1.length, 1, `one post from the digest — ${r1.out}${r1.err}`);
    assert.equal(after1[0].body, 'Gizmo read all three.');
    assert.equal((await open()).length, 0, 'nothing left open');
    for (const d of await all()) {
      assert.deepEqual(d.events.map((e) => e.state), ['offered', 'runner-claimed', 'turn-started', 'published'], JSON.stringify(d.events));
      assert.ok(d.events.slice(1).every((e) => e.source === 'guest-runner' && e.by === 'gizmo'), 'the runner signs its steps');
      assert.equal(d.events.at(-1).attempt, 1);
    }

    // A second tick: nothing open, nothing to wake for, no call — and the
    // mention inside the digest did NOT become a second wake.
    const r2 = await runOnce(env);
    assert.equal(r2.code, 0, r2.err + r2.out);
    assert.equal(ollama.calls.length, 1, `second tick must not call the model — ${r2.out}${r2.err}`);
    assert.equal((await posts()).length, 1);

    // A DECLINE: the seat says NO_REPLY. Recorded as declined with reason:explicit; no post.
    ollama.setReply('NO_REPLY');
    const m4 = (await api(srv.baseUrl, 'POST', '/api/conversations', { author: 'bo', body: 'a fourth thing, nothing for gizmo' })).body;
    await api(srv.baseUrl, 'POST', '/api/deliveries', { to: 'gizmo', conversation: m4.id, source: 'fanout', by: 'board' });
    const r3 = await runOnce(env);
    assert.equal(r3.code, 0, r3.err + r3.out);
    assert.equal(ollama.calls.length, 2);
    assert.equal((await posts()).length, 1, 'a decline posts nothing');
    const d4 = (await all()).find((d) => d.conversation === m4.id);
    assert.deepEqual(d4.events.map((e) => e.state), ['offered', 'runner-claimed', 'turn-started', 'declined']);
    assert.equal(d4.events.at(-1).reason, 'explicit', 'the seat\'s own NO, and it says so');
    assert.equal((await open()).length, 0, 'a decline discharges the delivery');

    // BUDGET BREACHED: deliveries stay OPEN and UNCLAIMED — no attempt burned, no call.
    assert.equal((await api(srv.baseUrl, 'PATCH', '/api/agents/gizmo', { budgetPerDay: 0, by: 'ada' })).status, 200);
    const spent = (await api(srv.baseUrl, 'GET', '/api/model-calls?agent=gizmo')).body;
    assert.ok(spent.count >= 1, 'a call is on the ledger, so the budget can be breached');
    const m5 = (await api(srv.baseUrl, 'POST', '/api/conversations', { author: 'bo', body: 'a fifth thing' })).body;
    await api(srv.baseUrl, 'POST', '/api/deliveries', { to: 'gizmo', conversation: m5.id, source: 'fanout', by: 'board' });
    const r4 = await runOnce(env);
    assert.equal(r4.code, 0, r4.err + r4.out);
    assert.equal(ollama.calls.length, 2, `budget breached ⇒ no model call — ${r4.out}${r4.err}`);
    const d5 = (await all()).find((d) => d.conversation === m5.id);
    assert.deepEqual(d5.events.map((e) => e.state), ['offered'], 'left OPEN and unclaimed — the next tick with budget will take it');
    assert.equal((await open()).length, 1);
    assert.match(r4.out + r4.err, /budget/i, 'the runner says WHY it left them');
  } finally { await ollama.stop(); await srv.stop(); }
});
