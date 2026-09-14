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
import { startRestServer, startPair, mcpSession, makeBoardFixture } from './helpers/harness.mjs';
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
    // THE RETRY BUDGET: failed-with-tries-left is open; a third failure is not.
    const m2 = (await api(srv.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: 'fails every time' })).body;
    const d2 = (await api(srv.baseUrl, 'POST', '/api/deliveries', { to: 'gizmo', conversation: m2.id, source: 'fanout', by: 'board' })).body;
    const ev2 = (body) => api(srv.baseUrl, 'POST', `/api/deliveries/${encodeURIComponent(d2.id)}/events`, { source: 'guest-runner', by: 'gizmo', ...body });
    const openIds = async () => (await api(srv.baseUrl, 'GET', '/api/deliveries?to=gizmo&open=1')).body.deliveries.map((x) => x.id);
    for (let attempt = 1; attempt <= 3; attempt++) {
      assert.ok((await openIds()).includes(d2.id), `open before attempt ${attempt}`);
      assert.equal((await ev2({ state: 'runner-claimed' })).status, 201);
      assert.equal((await ev2({ state: 'failed', note: 'model timeout' })).status, 201);
    }
    assert.ok(!(await openIds()).includes(d2.id), 'three failures: no longer open — a retry budget, not a retry loop');
    assert.equal((await api(srv.baseUrl, 'GET', `/api/deliveries?conversation=${encodeURIComponent(m2.id)}`)).body.deliveries[0].state, 'failed', 'and the record says so');
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
      assert.deepEqual(d.events.map((e) => e.state), ['offered', 'claimed', 'turn-started', 'published'], JSON.stringify(d.events));
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
    assert.deepEqual(d4.events.map((e) => e.state), ['offered', 'claimed', 'turn-started', 'declined']);
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

// ── slice 4: the STALE SWEEP and the DISCLOSURE ─────────────────────────────

test('#1346 STALE SWEEP — a delivery left at turn-started by a runner that died is failed (reason: stale) and drained again; a fresh one is left alone', async () => {
  const srv = await startRestServer({ board: fresh() });
  const ollama = await fakeOllama('REPLY: back from the dead.');
  const dir = tmpdir(); const stateFile = path.join(dir, 'gizmo.state.json');
  // A stale window of ONE SECOND so the test does not wait ten minutes; production keeps the lock's window.
  const env = { SCRUM_BOARD_URL: srv.baseUrl, SCRUM_GUEST_STATE_FILE: stateFile, SCRUM_DELIVERY_STALE_MS: '1000' };
  try {
    assert.equal((await api(srv.baseUrl, 'POST', '/api/agents', {
      seatKey: 'gizmo', prompt: 'Be brief.', model: { model: 'fake', protocol: 'ollama-native', baseUrl: ollama.baseUrl },
      residency: 'resident', contextPolicy: 'artifact-only', by: 'ada', deliveryMode: 'channel',
    })).status, 201);
    const mk = async (body) => {
      const m = (await api(srv.baseUrl, 'POST', '/api/conversations', { author: 'ada', body })).body;
      return (await api(srv.baseUrl, 'POST', '/api/deliveries', { to: 'gizmo', conversation: m.id, source: 'fanout', by: 'board' })).body;
    };
    const ev = (id, body) => api(srv.baseUrl, 'POST', `/api/deliveries/${encodeURIComponent(id)}/events`, { source: 'guest-runner', by: 'gizmo', ...body });
    // The crash shape: claimed, turn started, then the process died.
    const dead = await mk('answered by a runner that died');
    await ev(dead.id, { state: 'runner-claimed' }); await ev(dead.id, { state: 'turn-started' });
    assert.equal((await api(srv.baseUrl, 'GET', '/api/deliveries?to=gizmo&open=1')).body.deliveries.length, 0, 'invisible to open — the finding');
    await new Promise((r) => setTimeout(r, 1200));
    // A FRESH claim, inside the window: must not be swept.
    const live = await mk('being answered right now');
    await ev(live.id, { state: 'runner-claimed' });

    const r = await runOnce(env);
    assert.equal(r.code, 0, r.err + r.out);
    const byId = Object.fromEntries((await api(srv.baseUrl, 'GET', '/api/deliveries?to=gizmo')).body.deliveries.map((d) => [d.id, d]));
    assert.deepEqual(byId[dead.id].events.map((e) => e.state), ['offered', 'claimed', 'turn-started', 'failed', 'claimed', 'turn-started', 'published'],
      `swept to failed, reclaimed at attempt 2, drained — ${JSON.stringify(byId[dead.id].events)}`);
    assert.equal(byId[dead.id].events[3].reason, 'stale', 'the sweep says why');
    assert.equal(byId[dead.id].events[4].attempt, 2);
    assert.deepEqual(byId[live.id].events.map((e) => e.state), ['offered', 'claimed'], 'a claim inside the window is somebody\'s turn in progress — untouched');
    assert.equal(ollama.calls.length, 1);
    assert.match(r.out + r.err, /stale/i, 'the sweep is logged');
  } finally { await ollama.stop(); await srv.stop(); }
});

test('#1346 DISCLOSURE — /channel/status carries every channel-mode resident: mode, open, in-turn, stuck', async () => {
  const pair = await startPair({ board: fresh() });
  try {
    const rest = pair.rest.baseUrl;
    const mkAgent = (seatKey, extra) => api(rest, 'POST', '/api/agents', { seatKey, prompt: 'p', residency: 'resident', by: 'ada', model: { model: 'fake', protocol: 'ollama-native', baseUrl: 'http://127.0.0.1:1' }, ...extra });
    assert.equal((await mkAgent('gizmo', { deliveryMode: 'channel' })).status, 201);
    assert.equal((await mkAgent('bo', {})).status, 201, 'wake mode — must NOT appear as a resident inbox');
    const status = async () => (await fetch(`${pair.mcp.baseUrl}/channel/status`)).json();
    let s = await status();
    assert.deepEqual(s.residents, { gizmo: { deliveryMode: 'channel', open: 0, inTurn: 0, stuck: 0 } }, JSON.stringify(s.residents));

    const mk = async (body) => {
      const m = (await api(rest, 'POST', '/api/conversations', { author: 'ada', body })).body;
      return (await api(rest, 'POST', '/api/deliveries', { to: 'gizmo', conversation: m.id, source: 'fanout', by: 'board' })).body;
    };
    const ev = (id, body) => api(rest, 'POST', `/api/deliveries/${encodeURIComponent(id)}/events`, { source: 'guest-runner', by: 'gizmo', ...body });
    await mk('one'); await mk('two');
    const claimed = await mk('three'); await ev(claimed.id, { state: 'runner-claimed' }); await ev(claimed.id, { state: 'turn-started' });
    const done = await mk('four'); await ev(done.id, { state: 'runner-claimed' }); await ev(done.id, { state: 'published' });
    s = await status();
    assert.equal(s.residents.gizmo.open, 2, 'the two offered');
    assert.equal(s.residents.gizmo.inTurn, 1, 'the one claimed or in a turn, inside the stale window');
    assert.equal(s.residents.gizmo.stuck, 0, 'nothing is older than the window yet');
    assert.ok(!('bo' in s.residents));
    // The fanout itself also offers to gizmo — through MCP, the whole path.
    const session = await mcpSession(pair.mcp.mcpUrl);
    await session.callTool('conversation_post', { author: 'bex', body: 'five, through the fanout' });
    for (let i = 0; i < 40 && (await status()).residents.gizmo.open < 3; i++) await new Promise((r) => setTimeout(r, 50));
    const fin = await status();
    const recs = (await api(rest, 'GET', '/api/deliveries?to=gizmo')).body.deliveries.map((d) => d.state);
    assert.equal(fin.residents.gizmo.open, 3, `status=${JSON.stringify(fin.residents)} read=${JSON.stringify(fin.residentsRead)} records=${JSON.stringify(recs)} mcpLog=${pair.mcp.logs?.().slice(-800) ?? ''}`);
  } finally { await pair.stop(); }
});

// ── the bounded read: /channel/status must answer while REST is blocked ──────
import { boundedResidentReader } from '../core/delivery.mjs';

test('#1346 boundedResidentReader — a slow board does not stall the status page: last good reading served, stamped stale with the reason; no reading ⇒ named unreadable', async () => {
  let t = 1_000_000;
  const read = boundedResidentReader({ timeoutMs: 50, now: () => t });
  const never = () => new Promise(() => {});
  const first = await read(never);
  assert.equal(first.read.fresh, false);
  assert.match(first.residents.error, /unreadable.*timeout after 50ms/, 'no cache yet ⇒ an error field, not an empty map');

  t += 1000;
  const good = await read(async () => ({ gizmo: { deliveryMode: 'channel', open: 2, inTurn: 0, stuck: 0 } }));
  assert.deepEqual(good, { residents: { gizmo: { deliveryMode: 'channel', open: 2, inTurn: 0, stuck: 0 } }, read: { at: new Date(1_001_000).toISOString(), fresh: true } });

  t += 1000;
  const stale = await read(never);
  assert.deepEqual(stale.residents, good.residents, 'the last good reading is served');
  assert.equal(stale.read.fresh, false);
  assert.equal(stale.read.at, good.read.at, 'stamped with WHEN it was read, not now');
  assert.match(stale.read.reason, /timeout/);

  const failed = await read(async () => { throw new Error('ECONNREFUSED'); });
  assert.equal(failed.read.fresh, false); assert.match(failed.read.reason, /ECONNREFUSED/);
  assert.deepEqual(failed.residents, good.residents);
});

test('#1346 the status counter and the drain query agree on a third failure — one constant, both sides', async () => {
  const { classifyDeliveries, isOpenDelivery, DELIVERY_MAX_ATTEMPTS } = await import('../core/delivery.mjs');
  const claim = { state: 'runner-claimed', at: '2026-09-13T00:00:00Z' };
  const fail = { state: 'failed', at: '2026-09-13T00:00:01Z' };
  const twice = { state: 'failed', events: [{ state: 'offered' }, claim, fail, claim, fail] };
  const thrice = { state: 'failed', events: [{ state: 'offered' }, claim, fail, claim, fail, claim, fail] };
  assert.equal(DELIVERY_MAX_ATTEMPTS, 3);
  assert.equal(isOpenDelivery(twice), true); assert.equal(isOpenDelivery(thrice), false);
  assert.deepEqual(classifyDeliveries([twice, thrice]), { open: 1, inTurn: 0, stuck: 0 });
});
