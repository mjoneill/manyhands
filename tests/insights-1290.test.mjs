/**
 * #1290 — SHADOW INSIGHTS. Recommend, chart, change nothing.
 *
 * The motivating finding was in the ledger for two days before anyone read it
 * back: the wake tick is a flat 60s, a tick landing during a live turn is a
 * no-op (the lock), and turn durations differ per seat by 3x. So the timer is
 * mistuned per seat, in opposite directions, measurably.
 *
 * ⛔ THE RULES THIS FILE ENFORCES, because a dashboard that guesses is worse
 * than no dashboard:
 *   - too few rows ⇒ NO recommendation, and it says so
 *   - a model/provider change ⇒ the window RESETS, never averages two worlds
 *   - a missing measurement ⇒ reported MISSING, never folded in as zero
 *   - nothing here may mutate its input
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  summariseSeat, recommendInterval, regimeSegments, backlogFor,
  MIN_ROWS_FOR_RECOMMENDATION, TICK_MS,
} from '../core/insights.mjs';

const t = (iso) => Date.parse(iso);
const call = (agent, at, latencyMs, model = 'm1', extra = {}) => ({
  agent, calledAt: at, latencyMs, model, provider: 'p1', ok: true, ...extra,
});
/** n calls, one per minute, all the same latency. */
const runs = (agent, n, latencyMs, model = 'm1', startMin = 0) =>
  Array.from({ length: n }, (_, i) =>
    call(agent, new Date(t('2026-09-07T12:00:00Z') + (startMin + i) * 60_000).toISOString(), latencyMs, model));

test('#1290 the tick under test is the one actually deployed', () => {
  assert.equal(TICK_MS, 60_000, 'launchd StartInterval is 60s; if that changes this must too');
});

test('#1290 ⭐ A SEAT SLOWER THAN THE TICK IS THE MOTIVATING CASE — a seat at ~100s', () => {
  const s = summariseSeat(runs('slowseat', 40, 100_284));
  assert.equal(s.n, 40);
  assert.equal(s.medianLatencyMs, 100_284);
  // A tick fires every 60s; a turn occupies 100s ⇒ most ticks hit a held lock.
  assert.ok(s.wastedTickFraction > 0.35, `expected most ticks wasted, got ${s.wastedTickFraction}`);
  const r = recommendInterval(s);
  assert.equal(r.recommended, true);
  assert.ok(r.intervalMs > TICK_MS, 'a slow seat should be polled LESS often, not more');
  assert.match(r.why, /100|slow|turn/i);
});

test('#1290 a seat FASTER than the tick is recommended a shorter interval — the opposite direction', () => {
  const s = summariseSeat(runs('fastseat', 40, 8_000));
  const r = recommendInterval(s);
  assert.equal(r.recommended, true);
  assert.ok(r.intervalMs < TICK_MS, `fast seat should poll more often, got ${r.intervalMs}`);
});

test('#1290 ⛔ NEGATIVE CONTROL — too few rows produces NO number and says why', () => {
  const s = summariseSeat(runs('newseat', MIN_ROWS_FOR_RECOMMENDATION - 1, 30_000));
  const r = recommendInterval(s);
  assert.equal(r.recommended, false);
  assert.equal(r.intervalMs, null, 'must not emit a confident interval from a thin sample');
  assert.match(r.why, /too few|insufficient|\bn=\b/i);
});

test('#1290 ⭐ A REGIME CHANGE RESETS THE WINDOW — never average two different worlds', () => {
  // 30 slow calls on the old model, then 30 fast ones on the new.
  const rows = [...runs('guest', 30, 90_000, 'gemma3:12b'), ...runs('guest', 30, 9_000, 'qwen3.5:9b', 100)];
  const segs = regimeSegments(rows);
  assert.equal(segs.length, 2, 'two models ⇒ two segments');
  assert.equal(segs.at(-1).model, 'qwen3.5:9b');

  const s = summariseSeat(rows);
  assert.equal(s.regimeChanged, true);
  assert.equal(s.medianLatencyMs, 9_000,
    'the summary must describe the CURRENT regime, not the blend of both');
  assert.equal(s.n, 30, 'and its population is the current segment only');
  // The blended median would be ~49,500 — the number that would mislead.
  assert.notEqual(s.medianLatencyMs, 49_500);
});

test('#1290 ⛔ A MISSING MEASUREMENT IS MISSING, NEVER ZERO — a seat with no latency at all', () => {
  const rows = Array.from({ length: 20 }, (_, i) =>
    call('blindseat', new Date(t('2026-09-07T12:00:00Z') + i * 60_000).toISOString(), null));
  const s = summariseSeat(rows);
  assert.equal(s.medianLatencyMs, null, 'no latency ⇒ null, not 0');
  assert.equal(s.missingLatency, 20, 'and it counts what it could not see');
  const r = recommendInterval(s);
  assert.equal(r.recommended, false, 'no measurement ⇒ no recommendation');
  assert.match(r.why, /missing|no latency/i);
});

test('#1290 partial coverage reports BOTH the measured population and the gap', () => {
  const rows = [...runs('mixed', 20, 30_000),
                ...Array.from({ length: 5 }, (_, i) => call('mixed', new Date(t('2026-09-07T14:00:00Z') + i * 60_000).toISOString(), null))];
  const s = summariseSeat(rows);
  assert.equal(s.n, 20, 'n counts rows it could measure');
  assert.equal(s.missingLatency, 5);
  assert.equal(s.rowsSeen, 25, 'and it says how many rows it looked at');
});

test('#1290 ⭐ BACKLOG — owed = received minus answered, with the age of what is owed', () => {
  const now = t('2026-09-07T13:00:00Z');
  const mentions = [
    { createdAt: '2026-09-07T12:00:00Z' }, { createdAt: '2026-09-07T12:10:00Z' },
    { createdAt: '2026-09-07T12:50:00Z' }, { createdAt: '2026-09-07T12:59:00Z' },
  ];
  const answered = 2;
  const b = backlogFor({ mentions, answered, now });
  assert.equal(b.received, 4);
  assert.equal(b.answered, 2);
  assert.equal(b.owed, 2);
  // The two OLDEST are the answered ones (oldest-first drain, #1274), so what
  // is owed is the newest two — 10 and 1 minutes old.
  assert.ok(b.oldestOwedMinutes <= 10, `oldest owed ${b.oldestOwedMinutes}`);
  assert.ok(Array.isArray(b.owedAgesMinutes) && b.owedAgesMinutes.length === 2);
});

test('#1290 backlog reports what an EXPIRY POLICY would drop, without applying one', () => {
  const now = t('2026-09-07T13:00:00Z');
  const mentions = [
    { createdAt: '2026-09-07T11:00:00Z' },   // 120 min — stale
    { createdAt: '2026-09-07T11:30:00Z' },   //  90 min — stale
    { createdAt: '2026-09-07T12:55:00Z' },   //   5 min — live
  ];
  const b = backlogFor({ mentions, answered: 0, now, staleAfterMinutes: 30 });
  assert.equal(b.owed, 3);
  assert.equal(b.wouldExpire, 2, 'two are older than the policy');
  assert.equal(b.wouldRemain, 1);
  assert.equal(b.expiryApplied, false, '⛔ SHADOW: it reports, it does not drop');
});

test('#1290 ⛔ SHADOW — nothing here mutates its inputs', () => {
  const rows = runs('slowseat', 30, 100_000);
  const before = JSON.stringify(rows);
  summariseSeat(rows); regimeSegments(rows); recommendInterval(summariseSeat(rows));
  const mentions = [{ createdAt: '2026-09-07T12:00:00Z' }];
  const mBefore = JSON.stringify(mentions);
  backlogFor({ mentions, answered: 0, now: t('2026-09-07T13:00:00Z') });
  assert.equal(JSON.stringify(rows), before, 'ledger rows must be untouched');
  assert.equal(JSON.stringify(mentions), mBefore, 'mentions must be untouched');
});

// ---------------------------------------------------------------------------
// THE SEAM. The module can be perfect and the endpoint can still hand it the
// wrong field. The ledger's wire projection calls the timestamp `at`, not
// `calledAt` — exactly the kind of join that passes unit tests and fails live.
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const ledgerRow = (agent, at, latencyMs, model, cost = 0) => ({
  '@id': `https://scrumboard.local/model-call/${agent}-${at}`,
  '@type': 'scrum:ModelCall',
  'scrum:agent': agent, 'scrum:model': model, 'scrum:provider': 'p1',
  'scrum:latencyMs': latencyMs, 'scrum:cost': cost,
  'scrum:calledAt': at, 'scrum:ok': true,
});

test('#1290 SEAM: /api/insights joins the ledger correctly and is SHADOW', async () => {
  const board = makeBoardFixture({ cards: [], nextShortId: 1 });
  const now = Date.now();
  const iso = (minsAgo) => new Date(now - minsAgo * 60_000).toISOString();
  board.modelCalls = [
    ...Array.from({ length: 20 }, (_, i) => ledgerRow('slowseat', iso(60 - i), 100_000, 'm1', 0.001)),
    ...Array.from({ length: 20 }, (_, i) => ledgerRow('fastseat', iso(60 - i), 8_000, 'm1')),
    ...Array.from({ length: 5 },  (_, i) => ledgerRow('thinseat', iso(30 - i), 20_000, 'm1')),
    ...Array.from({ length: 6 },  (_, i) => ledgerRow('blindseat', iso(30 - i), null, 'm1')),
  ];
  board.conversations = [
    { id: 'c1', author: 'ada', body: 'hey @slowseat look at this', createdAt: iso(50), attachedTo: null },
    { id: 'c2', author: 'ada', body: 'and again @slowseat', createdAt: iso(20), attachedTo: null },
    { id: 'c3', author: 'slowseat', body: 'answering', createdAt: iso(45), attachedTo: null },
  ];
  const srv = await startRestServer({ board });
  try {
    const r = await fetch(`${srv.baseUrl}/api/insights?hours=6`);
    assert.equal(r.status, 200);
    const j = await r.json();

    // ⛔ The shadow contract, asserted on the wire.
    assert.equal(j.shadow, true);
    assert.match(j.note, /ADVISORY ONLY/i);

    const by = Object.fromEntries(j.seats.map((s) => [s.seat, s]));

    // The JOIN: if `at` → `calledAt` were dropped, every row falls outside the
    // window and every seat reports n=0. This is the assertion that catches it.
    assert.equal(by.slowseat.summary.n, 20, 'ledger rows must reach the module');
    assert.ok(by.slowseat.advice.recommended);
    assert.ok(by.slowseat.advice.intervalMs > by.slowseat.currentIntervalMs,
      'a 100s seat must be recommended a LONGER interval than the 60s tick');

    assert.ok(by.fastseat.advice.intervalMs < by.fastseat.currentIntervalMs,
      'an 8s seat must be recommended a SHORTER interval — opposite direction, same run');

    // Negative control, end to end.
    assert.equal(by.thinseat.advice.recommended, false, 'n=5 must not produce a number');
    assert.equal(by.thinseat.advice.intervalMs, null);

    // Coverage, end to end: a seat with no latency is MISSING, never fast.
    assert.equal(by.blindseat.summary.medianLatencyMs, null);
    assert.equal(by.blindseat.advice.recommended, false);
    assert.equal(j.population.rowsMissingLatency, 6, 'the gap is reported at the top level');

    // Backlog joined from conversations.
    assert.equal(by.slowseat.backlog.received, 2);
    assert.equal(by.slowseat.backlog.answered, 1);
    assert.equal(by.slowseat.backlog.owed, 1);
    assert.equal(by.slowseat.backlog.expiryApplied, false, '⛔ reports an expiry policy, never applies one');

    // ⛔ SHADOW, proven at the seam: asking twice changes nothing.
    const again = await (await fetch(`${srv.baseUrl}/api/insights?hours=6`)).json();
    assert.deepEqual(again.seats.map((s) => s.seat).sort(), j.seats.map((s) => s.seat).sort());
    const cards = await (await fetch(`${srv.baseUrl}/api/cards`)).json();
    assert.ok(Array.isArray(cards) || Array.isArray(cards?.cards), 'the board still reads normally after');
  } finally {
    await srv.stop();
  }
});

// ---------------------------------------------------------------------------
// #1290 — added after a provider-dashboard check refuted the ledger.
// The dashboard built to prevent confident zeros was about to print one.
import { costCoverage } from '../core/insights.mjs';

test('#1290 ⛔ AN UNPRICED LEDGER IS NOT A FREE ONE — the ground-truth case', () => {
  // The live shape on 2026-09-07: rows exist, tokens exist, cost is 0.
  // Hosted rows: the provider billed for these, the ledger did not record it.
  const rows = Array.from({ length: 20 }, () => ({ cost: 0, tokensIn: 100, tokensOut: 50, provider: 'openrouter' }));
  const c = costCoverage(rows);
  assert.equal(c.spent, null, '⛔ must be null, never 0 — "unmeasured" is not "free"');
  assert.equal(c.pricedRows, 0);
  assert.equal(c.unpricedRows, 20);
  assert.equal(c.trustworthy, false);
  assert.match(c.note, /UNMEASURED/);
});

test('#1290 a PARTIALLY priced ledger reports a floor, not a spend', () => {
  const rows = [{ cost: 0.5, tokensIn: 10, tokensOut: 5 }, { cost: 0, tokensIn: 10, tokensOut: 5 }];
  const c = costCoverage(rows);
  assert.equal(c.spent, 0.5);
  assert.equal(c.trustworthy, false, 'one unpriced row makes the total a floor');
  assert.match(c.note, /PARTIAL|floor/i);
});

test('#1290 a fully priced ledger is trustworthy and says so', () => {
  const rows = [{ cost: 0.25, tokensIn: 10, tokensOut: 5 }, { cost: 0.75, tokensIn: 10, tokensOut: 5 }];
  const c = costCoverage(rows);
  assert.equal(c.spent, 1);
  assert.equal(c.trustworthy, true);
});

import { budgetGateStatus } from '../core/insights.mjs';

test('#1290 ⛔⛔ A BUDGET GATE OVER AN UNPRICED LEDGER IS INERT, NOT ENFORCING — the live case', () => {
  // 145 rows, all cost 0, budget $2. The provider says $2.05 was spent.
  const coverage = costCoverage(Array.from({ length: 145 }, () => ({ cost: 0, tokensIn: 0, tokensOut: 0 })));
  const g = budgetGateStatus({ budgetPerDay: 2, coverage });
  assert.equal(g.status, 'INERT');
  assert.equal(g.armed, false, 'a cap compared against a meter reading zero is NOT a control');
  assert.match(g.why, /never trigger/i);
});

test('#1290 a fully priced ledger reports the gate ARMED', () => {
  const coverage = costCoverage([{ cost: 0.5, tokensIn: 10, tokensOut: 5 }, { cost: 0.25, tokensIn: 10, tokensOut: 5 }]);
  const g = budgetGateStatus({ budgetPerDay: 2, coverage });
  assert.equal(g.status, 'ARMED');
  assert.equal(g.armed, true);
});

test('#1290 a partly priced ledger is NOT armed — it would fire late on a number known to be low', () => {
  const coverage = costCoverage([{ cost: 0.5 }, { cost: 0 }]);
  const g = budgetGateStatus({ budgetPerDay: 2, coverage });
  assert.equal(g.status, 'PARTIAL');
  assert.equal(g.armed, false);
});

test('#1290 no budget and no data are distinguished from each other, and from INERT', () => {
  assert.equal(budgetGateStatus({ budgetPerDay: null, coverage: costCoverage([{ cost: 1 }]) }).status, 'NO_BUDGET');
  assert.equal(budgetGateStatus({ budgetPerDay: 2, coverage: costCoverage([]) }).status, 'NO_DATA');
});

test('#1290 ⭐ FREE-LOCAL AND DROPPED-USAGE ARE NOT THE SAME ZERO — the thing that hid it for 145 calls', () => {
  const localRows = Array.from({ length: 20 }, () => ({ cost: 0, provider: 'http://localhost:11434', model: 'qwen3.5:9b' }));
  const hostedRows = Array.from({ length: 20 }, () => ({ cost: 0, provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' }));

  const free = costCoverage(localRows);
  assert.equal(free.spent, 0, 'a local seat genuinely costs 0 — that is a fact, not a gap');
  assert.equal(free.trustworthy, true);
  assert.match(free.note, /FREE/);
  assert.equal(budgetGateStatus({ budgetPerDay: 2, coverage: free }).status, 'ARMED',
    'a free local seat does not need its gate flagged as broken');

  const blind = costCoverage(hostedRows);
  assert.equal(blind.spent, null, 'a HOSTED row with no cost is unmeasured, not free');
  assert.equal(blind.trustworthy, false);
  assert.match(blind.note, /UNMEASURED/);
  assert.equal(budgetGateStatus({ budgetPerDay: 2, coverage: blind }).status, 'INERT');
});
