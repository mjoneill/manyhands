/**
 * #1404 — /api/checks is ONE pass shared by every caller, and the board has a
 * door that costs nothing.
 *
 * 2026-09-17 16:03–16:11Z: REST answered nothing for eight minutes. The checks
 * pass runs every card's stored ASK synchronously on the main thread (5.4 s on
 * that day's board) and it ran once per caller — the MCP tick every minute, a
 * seat's "is it back?" curl every five seconds, none of them cancelled by the
 * client giving up. Restarted under the #1399 lock. This test is the rail:
 *
 *   1  twenty concurrent callers ⇒ ONE evaluation (`passes` moves by one, every
 *      caller holds the same `evaluatedAt`), and a later call inside the cache
 *      window is served from cache with a non-zero `ageMs`.
 *   2  `?fresh=1` re-runs exactly once (`passes` +1) — a human can force
 *      currency without forcing N.
 *   3  /api/health answers WHILE a pass is running, within one check's cost —
 *      the loop yields between cards, so the cheap door is not stuck behind
 *      the whole pass. (It cannot beat one check: an ASK is one synchronous
 *      WASM call, #885.)
 *   4  every check carries `ms`, and one over the ceiling is flagged `slow`
 *      beside its verdict — the verdict itself is unchanged.
 *
 * The slow check is store-independent on purpose: three VALUES lists whose
 * cross product the evaluator must walk to prove the FILTER never matches —
 * ~1 s per check on this machine, the same on an empty fixture as on prod.
 *
 * Sabotage profiles (measured 2026-09-17): drop the single-flight
 * (`_checksInflight` never published) ⇒ `passes seen: 1..20` AND test 2's
 * "health saw the pass in flight" (health is served between cards, but no
 * pass is ever shared); drop the cache ⇒ `'fresh' !== 'cache'`; drop the
 * per-card yield ⇒ `passes seen: 1..20` too — no second request is parsed
 * during a pass, so nothing can join one — AND test 2's "health took N ms"
 * line (the whole pass); drop the pricing ⇒ "flagged slow with its ms".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';

const vals = Array.from({ length: 600 }, (_, i) => i).join(' ');
const SLOW_ASK = `ASK { VALUES ?x { ${vals} } VALUES ?y { ${vals} } VALUES ?z { 0 1 2 3 4 5 6 7 8 9 } FILTER(?x + ?y + ?z = -1) }`;
const slowCheck = (n) => ({ claim: `slow tripwire ${n}`, ask: SLOW_ASK, expect: false });
const quickCheck = { claim: 'no decisions on this board', ask: 'ASK { ?d a scrum:Decision }', expect: false };

const card = (i, checks) => ({
  id: `card-${i}`, shortId: i, title: `card ${i}`, column: 'backlog', type: 'task', version: 1,
  createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z', description: '', checks,
});

// ⚠️ NOT fetch: undici pools connections and serialised a 20-request burst
// into ~2 at a time (measured: passes 1..9 for one burst — the server was
// right, the client never made the calls concurrent). One socket per call.
const agent = new http.Agent({ keepAlive: false, maxSockets: Infinity });
const get = (base, p) => new Promise((resolve, reject) => {
  const t0 = performance.now();
  http.get(`${base}${p}`, { agent }, (res) => {
    let raw = ''; res.setEncoding('utf8'); res.on('data', (c) => { raw += c; });
    res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(raw), ms: performance.now() - t0 }); } catch (e) { reject(e); } });
  }).on('error', reject);
});

test('#1404 twenty concurrent /api/checks callers share ONE pass; a call inside the window is served from cache; ?fresh=1 re-runs once; each check is priced', async () => {
  const board = makeBoardFixture({ cards: [card(1, [slowCheck(1)]), card(2, [slowCheck(2), quickCheck])], nextShortId: 3 });
  const s = await startRestServer({ board, env: { SCRUM_CHECKS_CACHE_MS: '60000', SCRUM_CHECK_CEILING_MS: '200' } });
  try {
    // ── 1: twenty concurrent callers on a COLD cache, one pass ──
    // (Not `?fresh=1`: a forced caller parsed after the pass ended legitimately
    // starts the next one — one at a time is the promise, not one ever.)
    const burst = await Promise.all(Array.from({ length: 20 }, () => get(s.baseUrl, '/api/checks')));
    assert.ok(burst.every((r) => r.status === 200), JSON.stringify(burst.map((r) => r.status)));
    const passes = new Set(burst.map((r) => r.body.passes));
    const stamps = new Set(burst.map((r) => r.body.evaluatedAt));
    assert.deepEqual([...passes], [1], `twenty concurrent callers must share ONE evaluation — passes seen: ${[...passes]}`);
    assert.equal(stamps.size, 1, 'every caller holds the same evaluatedAt');
    const froms = burst.map((r) => r.body.servedFrom).sort();
    assert.equal(froms.filter((f) => f === 'fresh').length, 1, `exactly one caller ran the pass: ${froms}`);
    assert.ok(froms.filter((f) => f === 'joined').length >= 1, `the others joined it or read the cache it left: ${froms}`);
    const first = burst.find((r) => r.body.servedFrom === 'fresh');
    assert.ok(first.body.evaluationMs > 1000, `the fixture's slow checks must actually be slow (pass took ${first.body.evaluationMs} ms)`);

    // ── 4: priced ──
    const byCard = Object.fromEntries(first.body.results.map((r) => [r.shortId, r]));
    const slow = byCard[1].checks[0], quick = byCard[2].checks[1];
    assert.equal(slow.status, 'holds', 'the verdict is untouched by the pricing');
    assert.ok(slow.ms > 500 && slow.slow === true, `a check over the ceiling is flagged slow with its ms: ${JSON.stringify(slow)}`);
    assert.ok(typeof quick.ms === 'number' && quick.slow === undefined, `a cheap check carries ms and no flag: ${JSON.stringify(quick)}`);
    assert.ok(first.body.standing.every((row) => typeof row.ms === 'number'), 'standing checks are priced too');

    const cached = await get(s.baseUrl, '/api/checks');
    assert.equal(cached.body.servedFrom, 'cache');
    assert.equal(cached.body.passes, 1, 'a call inside the window does not re-run');
    assert.ok(cached.ms < 500, `a cached answer is cheap (${Math.round(cached.ms)} ms)`);
    assert.ok(cached.body.ageMs >= 0 && typeof cached.body.cacheMs === 'number', 'the reader is told how old the verdicts are');

    // ── 2: ?fresh=1 forces exactly one more pass ──
    const fresh = await get(s.baseUrl, '/api/checks?fresh=1');
    assert.equal(fresh.body.servedFrom, 'fresh');
    assert.equal(fresh.body.passes, 2);
  } finally { await s.stop(); }
});

test('#1404 /api/health answers from memory WHILE a checks pass runs — within one check\'s cost, not the whole pass', async () => {
  // Four slow checks on four cards ⇒ a pass of ~4 s with a yield between cards.
  const board = makeBoardFixture({ cards: [1, 2, 3, 4].map((i) => card(i, [slowCheck(i)])), nextShortId: 5 });
  const s = await startRestServer({ board });
  try {
    const idle = await get(s.baseUrl, '/api/health');
    assert.equal(idle.status, 200);
    assert.equal(idle.body.ok, true);
    assert.equal(idle.body.checks.passes, 0);
    assert.equal(typeof idle.body.pid, 'number');

    const passP = get(s.baseUrl, '/api/checks?fresh=1');
    await new Promise((r) => setTimeout(r, 150));          // the pass is under way
    const health = await get(s.baseUrl, '/api/health');
    const pass = await passP;
    const oneCheck = Math.max(...pass.body.results.map((r) => r.checks[0].ms));
    assert.ok(pass.body.evaluationMs > 2500, `the pass must be long enough to be caught mid-way (${pass.body.evaluationMs} ms)`);
    assert.ok(health.ms < oneCheck + 400,
      `the cheap door answers between cards: health took ${Math.round(health.ms)} ms, one check costs ${oneCheck} ms, the pass ${pass.body.evaluationMs} ms`);
    assert.ok(health.ms < pass.body.evaluationMs - 1000, 'and it did NOT wait for the whole pass');
    // Last, because it is the seam the yield exposes: without the yield no
    // second request is even PARSED during a pass, so nothing can ever see
    // `inflight` — the single-flight would be correct and unobservable.
    assert.equal(health.body.checks.inflight, true, 'health saw the pass in flight');
  } finally { await s.stop(); }
});

test('#1404 a write invalidates the cached pass — a seat that writes a tripwire reads its own verdict back, not last minute\'s', async () => {
  const s = await startRestServer({ board: makeBoardFixture({ cards: [card(1, [quickCheck])], nextShortId: 2 }), env: { SCRUM_CHECKS_CACHE_MS: '600000' } });
  try {
    const a = await get(s.baseUrl, '/api/checks');
    assert.equal(a.body.servedFrom, 'fresh');
    const b = await get(s.baseUrl, '/api/checks');
    assert.equal(b.body.servedFrom, 'cache', 'control: nothing changed ⇒ cached');
    const w = await fetch(`${s.baseUrl}/api/cards`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'a claim written just now', by: 'ada', checks: [{ claim: 'the board has a card titled just now', ask: 'ASK { ?c schema:name "a claim written just now" }', expect: true }] }) });
    assert.equal(w.status, 201);
    const c = await get(s.baseUrl, '/api/checks');
    assert.equal(c.body.servedFrom, 'fresh', 'a write bumps the generation ⇒ the next read re-runs');
    assert.equal(c.body.passes, 2);
    const mine = c.body.results.find((r) => r.title === 'a claim written just now');
    assert.equal(mine?.checks?.[0]?.status, 'holds', 'and the writer sees their own tripwire evaluated');
  } finally { await s.stop(); }
});
