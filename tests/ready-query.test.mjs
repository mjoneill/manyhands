/**
 * core/ready-query.mjs — #815: `board_ready`, the computed work queue.
 *
 * THE ORACLE IS HAND-DERIVED (verifier requirement, card thread 5d7f7e51):
 * every expectation below was written by reading the fixture's card
 * definitions and deriving the verdict BY HAND, before the implementation
 * existed — never by running a second query over the same replica. A shared
 * misreading (blockedBy direction, done-as-closed, dangling semantics) would
 * pass a query-derived oracle identically; it cannot pass this table unless
 * the hand also misread the fixture.
 *
 * EXCLUSIONS ARE NAMED, NOT IMPLIED (same thread): every scenario asserts at
 * least one card that MUST be absent AND its machine-readable reason. A ready
 * list that returns the right cards while silently dropping one it owes
 * passes every inclusion-only check ever written.
 *
 * The fixture rides the REAL projection path (domainToJsonLd →
 * buildGraphStore) — the datatype traps this library's older siblings retire
 * (string identifiers, IRI columns) only exist on the real path.
 *
 * ── THE HAND-DERIVED TRUTH TABLE ────────────────────────────────────────────
 *   #1 a-solo      backlog  p1  unclaimed  no blockers        → READY
 *   #2 b-cleared   backlog  p2  unclaimed  blockedBy #5(done) → READY (blocker closed)
 *   #3 c-claimed   backlog  p0  CLAIMED    no blockers        → EXCLUDED claimed-by:ada
 *                  (highest priority on the board and still absent — the
 *                   fixture that catches a queue ignoring claims)
 *   #4 d-blocked   backlog  p1  unclaimed  blockedBy #6(open) → EXCLUDED open-blocker:6
 *   #5 e-done      done     p1  unclaimed  no blockers        → EXCLUDED column:done
 *   #6 f-noprio    backlog  —   unclaimed  no blockers        → READY (unprioritized sorts LAST)
 *   #7 g-dangling  backlog  p2  unclaimed  blockedBy ghost    → EXCLUDED dangling-blocker:ghost
 *                  (pre-registered BEFORE the code ran: dangling excludes
 *                   conservatively — the two defensible answers differ, so
 *                   the choice is written here, not ratified by whatever the
 *                   implementation happened to do)
 *   #8 h-parked    in-progress p3 unclaimed no blockers       → READY (the #809
 *                   shape: parked in a working column, anyone may take it)
 *   #9 j-mixed     backlog  p1  unclaimed  blockedBy #5(done) AND #6(open)
 *                                                             → EXCLUDED open-blocker:6
 *                  (kills the any/all confusion: one closed blocker must not
 *                   clear a card that still has an open one; if wrongly
 *                   included it lands at position 2 — position-discriminating)
 *
 *   READY ORDER (priority p0<p1<p2<p3<none, then shortId asc): [1, 2, 8, 6]
 *
 * ── MUTATIONS THIS TABLE KILLS (steward requirement, commons e3395016) ──────
 *   reverse blockedBy       → #6 gains a blocker (excluded), #4 loses one
 *                             (included): both flip, table fails
 *   dangling-as-clear       → #7 included: table fails
 *   done-blockers-as-open   → #2 excluded: table fails
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { domainToJsonLd } from '../core/jsonld.mjs';
import { buildGraphStore } from '../core/graph-replica.mjs';
import { readyFromStore, READY_EXPLAIN } from '../core/ready-query.mjs';

const card = (id, shortId, name, extra = {}) => ({
  '@id': id, '@type': 'CreativeWork', identifier: shortId, name, board: {}, ...extra,
});

const domain = () => ({
  nodes: [
    card('a', 1, 'a-solo', { column: 'backlog', 'scrum:priority': 'p1' }),
    card('b', 2, 'b-cleared', { column: 'backlog', 'scrum:priority': 'p2', blockedBy: ['e'] }),
    card('c', 3, 'c-claimed', { column: 'backlog', 'scrum:priority': 'p0', claimedBy: 'ada' }),
    card('d', 4, 'd-blocked', { column: 'backlog', 'scrum:priority': 'p1', blockedBy: ['f'] }),
    card('e', 5, 'e-done', { column: 'done', 'scrum:priority': 'p1' }),
    card('f', 6, 'f-noprio', { column: 'backlog' }),
    card('g', 7, 'g-dangling', { column: 'backlog', 'scrum:priority': 'p2', blockedBy: ['ghost'] }),
    card('h', 8, 'h-parked', { column: 'in-progress', 'scrum:priority': 'p3' }),
    card('j', 9, 'j-mixed', { column: 'backlog', 'scrum:priority': 'p1', blockedBy: ['e', 'f'] }),
  ],
  messages: [], people: [], columns: [],
});

const storeFor = (d = domain()) => buildGraphStore(domainToJsonLd(d));

test('ready: the hand-derived truth table, inclusions AND exclusions', () => {
  const { ready, excluded, readyTotal, excludedTotal } = readyFromStore(storeFor());

  // Inclusions, in the hand-derived order.
  assert.deepEqual(ready.map((c) => c.shortId), [1, 2, 8, 6]);
  assert.equal(readyTotal, 4);

  // Named exclusions with machine-readable reasons — each asserted, none implied.
  const reasonOf = (n) => excluded.find((c) => c.shortId === n)?.reason;
  assert.equal(reasonOf(3), 'claimed-by:ada');
  assert.equal(reasonOf(4), 'open-blocker:6');
  assert.equal(reasonOf(5), 'column:done');
  assert.equal(reasonOf(7), 'dangling-blocker:ghost');
  assert.equal(reasonOf(9), 'open-blocker:6');
  assert.equal(excludedTotal, 5);

  // The wrong answers, named: the claimed p0 card must not lead the queue,
  // and the mixed-blockers card must not ride its closed blocker in.
  assert.ok(!ready.some((c) => c.shortId === 3), 'claimed p0 card must be absent');
  assert.ok(!ready.some((c) => c.shortId === 9), 'mixed open+closed blockers must exclude');
});

test('ready: entries carry the fields a chooser needs, and reasons for inclusion', () => {
  const { ready } = readyFromStore(storeFor());
  const first = ready[0];
  assert.equal(first.shortId, 1);
  assert.equal(first.title, 'a-solo');
  assert.equal(first.priority, 'p1');
  assert.equal(first.column, 'backlog');
  // Inclusion is explained too — not just exclusion.
  assert.deepEqual(first.reasons, ['column:backlog', 'unclaimed', 'no-open-blockers']);
});

test('ready: a card whose blocker closes enters the queue (blocker release)', () => {
  // Same board, but #6 moves to done → #4's blocker is closed → #4 becomes
  // ready; #9's open blocker also clears. Hand-derived new order:
  // p1: #1, #4, #9 (shortId asc) · p2: #2 · p3: #8 · #6 leaves (column:done).
  const d = domain();
  d.nodes.find((n) => n['@id'] === 'f').column = 'done';
  const { ready, excluded } = readyFromStore(storeFor(d));
  assert.deepEqual(ready.map((c) => c.shortId), [1, 4, 9, 2, 8]);
  assert.equal(excluded.find((c) => c.shortId === 6)?.reason, 'column:done');
});

test('ready: explain answers for ANY card, included or excluded, and refuses unknowns', () => {
  const store = storeFor();
  const inQueue = READY_EXPLAIN(readyFromStore(store), 1);
  assert.equal(inQueue.ready, true);
  assert.deepEqual(inQueue.reasons, ['column:backlog', 'unclaimed', 'no-open-blockers']);

  const out = READY_EXPLAIN(readyFromStore(store), 9);
  assert.equal(out.ready, false);
  assert.equal(out.reason, 'open-blocker:6');

  assert.throws(() => READY_EXPLAIN(readyFromStore(store), 999), (e) => e.code === 'UNKNOWN_CARD');
});

test('ready: empty board is an honest empty, not an error', () => {
  const { ready, excluded, readyTotal } = readyFromStore(storeFor({ nodes: [], messages: [], people: [], columns: [] }));
  assert.deepEqual(ready, []);
  assert.deepEqual(excluded, []);
  assert.equal(readyTotal, 0);
});

test('ready: limit bounds the ready page; totals still count the whole board', () => {
  const { ready, readyTotal } = readyFromStore(storeFor(), { limit: 2 });
  assert.deepEqual(ready.map((c) => c.shortId), [1, 2]);
  assert.equal(readyTotal, 4, 'total answers the question asked, not the page size');
});
