/**
 * #1078 — "what is in flight" had THREE independent answers (column, claim,
 * work-bid ledger) that never reconcile. Measured 2026-08-29T13:10Z: column
 * in-progress 0 cards · live claims 4 · work_list.open [] with nothing settled
 * for 11 days. A reader believed whichever surface they opened first.
 *
 * The ruling this file pins: the CLAIM is authoritative for "in flight" — it
 * is the only surface with first-write-wins and a tool-call cost. The column
 * is a workflow stage; the ledger is negotiation BEFORE a claim. Both are
 * reported as DERIVED, and every way they disagree with the claim is named.
 *
 * NOT here, on purpose: auto-moving claimed cards into in-progress. A mutex
 * is not a stage; collapsing them loses one of the two facts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inFlight, retiredWorkLedger, WORK_LEDGER_COUNT_QUERY, STALE_AFTER_HOURS } from '../core/in-flight.mjs';

const NOW = '2026-08-29T13:10:00.000Z';
const card = (shortId, over = {}) => ({
  id: `uuid-${shortId}`, shortId, title: `Card ${shortId}`, column: 'backlog',
  claimedBy: null, claimedAt: null, ...over,
});

test('the answer names its authority and publishes its definitions with the numbers', () => {
  const r = inFlight([], { now: NOW });
  assert.equal(r.authority, 'claim');
  assert.equal(r.staleAfterHours, STALE_AFTER_HOURS);
  assert.equal(r.now, NOW);
  assert.ok(typeof r.definition === 'string' && r.definition.includes('claim'));
  assert.deepEqual(r.cards, []);
});

test('a claimed card is in flight, with its age and column carried', () => {
  const r = inFlight([card(1, { claimedBy: 'ada', claimedAt: '2026-08-29T11:10:00.000Z', column: 'backlog' })], { now: NOW });
  assert.equal(r.cards.length, 1);
  const c = r.cards[0];
  assert.equal(c.shortId, 1);
  assert.equal(c.claimedBy, 'ada');
  assert.equal(c.column, 'backlog');
  assert.equal(c.ageHours, 2);
  assert.equal(c.stale, false);
});

test('the #1078 measurement itself: 0 in-progress, 4 claims → four in flight, four claimed-not-in-progress, zero in-progress-unclaimed', () => {
  const cards = [
    card(367, { claimedBy: 'ada', claimedAt: '2026-08-23T22:21:00.000Z' }),
    card(437, { claimedBy: 'ada', claimedAt: '2026-08-23T22:07:00.000Z', parkedBy: 'ada', parkedUntil: '2026-09-08T00:00:00.000Z' }),
    card(962, { claimedBy: 'bo', claimedAt: '2026-08-24T10:32:00.000Z' }),
    card(1076, { claimedBy: 'bo', claimedAt: '2026-08-29T12:50:00.000Z' }),
    card(5), card(6),
  ];
  const r = inFlight(cards, { now: NOW });
  assert.deepEqual(r.cards.map((c) => c.shortId), [367, 437, 962, 1076]);
  assert.deepEqual(r.disagreements.inProgressUnclaimed, []);
  assert.deepEqual(r.disagreements.claimedNotInProgress, [367, 437, 962, 1076]);
  // The three leases that were not live work, invisible to the column view:
  assert.deepEqual(r.disagreements.stale, [367, 437, 962]);
  // #437 — parked AND claimed: two mechanisms, one intent, disagreeing.
  assert.deepEqual(r.disagreements.claimedAndParked, [{ shortId: 437, claimedBy: 'ada', parkedUntil: '2026-09-08T00:00:00.000Z' }]);
});

test('a card in the in-progress column with no claim is named as a disagreement, not counted as in flight', () => {
  const r = inFlight([card(9, { column: 'in-progress' })], { now: NOW });
  assert.deepEqual(r.cards, []);
  assert.deepEqual(r.disagreements.inProgressUnclaimed, [{ shortId: 9, title: 'Card 9' }]);
});

test('a claimed card that IS in in-progress agrees — no disagreement recorded for it', () => {
  const r = inFlight([card(9, { column: 'in-progress', claimedBy: 'ada', claimedAt: NOW })], { now: NOW });
  assert.equal(r.cards.length, 1);
  assert.deepEqual(r.disagreements.claimedNotInProgress, []);
  assert.deepEqual(r.disagreements.inProgressUnclaimed, []);
});

test('stale is exactly the published threshold: 47h59m holds, 48h is stale', () => {
  const fresh = inFlight([card(1, { claimedBy: 'ada', claimedAt: '2026-08-27T13:11:00.000Z' })], { now: NOW });
  const stale = inFlight([card(1, { claimedBy: 'ada', claimedAt: '2026-08-27T13:10:00.000Z' })], { now: NOW });
  assert.equal(fresh.cards[0].stale, false);
  assert.equal(stale.cards[0].stale, true);
  assert.deepEqual(stale.disagreements.stale, [1]);
});

test('the threshold is a parameter, and the payload reports the one actually used', () => {
  const r = inFlight([card(1, { claimedBy: 'ada', claimedAt: '2026-08-29T10:00:00.000Z' })], { now: NOW, staleAfterHours: 3 });
  assert.equal(r.staleAfterHours, 3);
  assert.equal(r.cards[0].stale, true);
});

test('a claim with an unparseable claimedAt is still in flight — age unknown, reported as null, never silently dropped', () => {
  const r = inFlight([card(1, { claimedBy: 'ada', claimedAt: 'garbage' })], { now: NOW });
  assert.equal(r.cards.length, 1);
  assert.equal(r.cards[0].ageHours, null);
  assert.equal(r.cards[0].stale, null);
});

test('now is required — a defaulted clock is how a derived view stops reporting its own staleness', () => {
  assert.throws(() => inFlight([], {}), /now/);
});

// ── the ledger: RETIRED (#1763) ──────────────────────────────────────────────
// board_status's summary is counts from ONE graph query and nothing else; the file is never read.

test('#1763 the retired ledger summary reports the graph\'s counts, read from either binding shape', () => {
  assert.deepEqual(retiredWorkLedger({ source: 'executor', rows: [{ actions: '53', workObjects: '17' }] }), { retired: true, since: '2026-08-18', actions: 53, workObjects: 17 });
  assert.deepEqual(retiredWorkLedger({ source: 'executor', rows: [{ actions: { value: '3' }, workObjects: { value: '2' } }] }), { retired: true, since: '2026-08-18', actions: 3, workObjects: 2 });
  assert.match(WORK_LEDGER_COUNT_QUERY, /schema:Action/); assert.match(WORK_LEDGER_COUNT_QUERY, /scrum:WorkObject/);
});

test('#1763 a graph that cannot answer is UNAVAILABLE with null counts — never a confident zero', () => {
  for (const bad of [null, { error: 'the graph could not be read' }, { source: 'executor', rows: [] }, { source: 'executor', rows: [{ actions: 'x', workObjects: '1' }] },
    { source: 'replica', rows: [{ actions: '0', workObjects: '0' }] }, { rows: [{ actions: '0', workObjects: '0' }] }]) {
    const r = retiredWorkLedger(bad);
    assert.equal(r.retired, true); assert.equal(r.actions, null); assert.equal(r.workObjects, null);
    assert.equal(typeof r.unavailable, 'string', JSON.stringify(bad));
  }
  assert.equal(retiredWorkLedger({ error: 'boom' }).unavailable, 'boom', 'the reason is carried, not replaced');
});
