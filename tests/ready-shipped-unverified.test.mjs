/**
 * #1020 — THE QUEUE HALF. A card whose every implementing commit is already in
 * the deployed history is offered as `shipped-unverified`, never as plain ready.
 *
 * Measured on prod 2026-09-03 (deployedSha 18b28908a): 23 of 200 offered cards
 * had every implementedBy sha in the deployed history — five of them in the
 * sprint's Planned column. Two of those cost a claim and a groom each the same
 * morning (#1043 fixed 2026-08-24 and in production; #1025's mechanism shipped
 * with #466). The queue reads column, claim and blockers and cannot see any of
 * it.
 *
 * ⛔ WHAT THIS DELIBERATELY DOES NOT DO: move, close, or hide anything. Nine
 * deliberate leave-it-in-backlog decisions exist on the live board. A card can
 * also carry commits AND real remaining work. So the card stays exactly where
 * its owner put it, stays IN the queue, and gains a reason that says
 * "verify and close, or say why it is still open".
 *
 * ⭐ THE SHIPPED SET IS PASSED IN, not derived here. It comes from the deploy
 * stamp's `inDeployed` (the sibling commit), because ancestry can only be
 * computed where a `.git` is — production serves an export without one (#1008).
 * Absent that input this is a no-op: no stamp, no claim.
 *
 * ⚠️ EVERY sha, not any. A card with two commits where one shipped and one did
 * not is mid-flight, and calling it shipped would hide the unfinished half.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainToJsonLd } from '../core/jsonld.mjs';
import { buildGraphStore } from '../core/graph-replica.mjs';
import { readyFromStore, pageReady } from '../core/ready-query.mjs';

const SHIPPED_A = 'a'.repeat(40);
const SHIPPED_B = 'b'.repeat(40);
const UNSHIPPED = 'c'.repeat(40);   // resolves in a root, NOT an ancestor — #1029's shape

const card = (id, shortId, name, extra = {}) => ({
  '@id': id, '@type': 'CreativeWork', identifier: shortId, name, board: {}, ...extra,
});

const domain = () => ({
  nodes: [
    card('a', 1, 'plain-ready', { column: 'backlog', 'scrum:priority': 'p1' }),
    card('b', 2, 'all-shipped', { column: 'backlog', 'scrum:priority': 'p1', implementedBy: [SHIPPED_A] }),
    card('c', 3, 'multi-shipped', { column: 'backlog', 'scrum:priority': 'p1', implementedBy: [SHIPPED_A, SHIPPED_B] }),
    card('d', 4, 'part-shipped', { column: 'backlog', 'scrum:priority': 'p1', implementedBy: [SHIPPED_A, UNSHIPPED] }),
    card('e', 5, 'not-shipped', { column: 'backlog', 'scrum:priority': 'p1', implementedBy: [UNSHIPPED] }),
  ],
  messages: [], people: [], columns: [],
});

const storeFor = (d = domain()) => buildGraphStore(domainToJsonLd(d));
const shipped = () => new Set([SHIPPED_A, SHIPPED_B]);
const byId = (rows) => new Map(rows.map((r) => [r.shortId, r]));

test('#1020 a card whose EVERY implementedBy sha is in the deployed set reads shipped-unverified', () => {
  const { ready } = pageReady(readyFromStore(storeFor(), { shippedShas: shipped() }));
  const rows = byId(ready);

  const one = rows.get(2);
  assert.ok(one, 'it must STAY IN THE QUEUE — this is a relabel, not a filter. '
    + 'Removing it would hide a card whose owner may have deliberate remaining work');
  assert.ok(one.reasons.some((r) => r.startsWith('shipped-unverified:')),
    `expected a shipped-unverified reason, got ${JSON.stringify(one.reasons)}`);
  assert.ok(one.reasons.some((r) => r.includes(SHIPPED_A.slice(0, 9))),
    'the SHA rides the reason — a reader must be able to check the claim without another round trip');
  assert.ok(!one.reasons.includes('no-open-blockers'),
    'NEVER BOTH. A row claiming plain readiness beside shipped-unverified is the false-reason shape '
    + 'this queue was already burned by (#965)');
});

test('#1020 ⛔ THE DISCRIMINATOR — a PARTLY shipped card stays plain ready', () => {
  const { ready } = pageReady(readyFromStore(storeFor(), { shippedShas: shipped() }));
  const four = byId(ready).get(4);
  assert.ok(four, 'still offered');
  assert.ok(!four.reasons.some((r) => r.startsWith('shipped-unverified')),
    'ONE of its two commits is not in the deployed history, so the card is mid-flight. '
    + 'Marking it shipped would hide the unfinished half — the exact failure this card exists to stop, '
    + 'arriving through an any/all confusion');
});

test('#1020 ⛔⛔ #1029\'s SHAPE — a sha that resolves in a root but never shipped stays plain ready', () => {
  const { ready } = pageReady(readyFromStore(storeFor(), { shippedShas: shipped() }));
  const five = byId(ready).get(5);
  assert.ok(five, 'offered');
  assert.deepEqual(five.reasons, ['column:backlog', 'unclaimed', 'no-open-blockers'],
    'This is #1029 on the live board: backlog, offered as ready, carrying a sha that git can resolve '
    + 'and that is NOT an ancestor of the deployed sha. If this ever reads shipped-unverified, the '
    + 'implementation has been keyed on resolution instead of ancestry and is hiding real unstarted work.');
});

test('#1020 ⛔ NO shipped set ⇒ the queue is EXACTLY as it was: no claim, no crash', () => {
  const without = pageReady(readyFromStore(storeFor()));
  const rows = byId(without.ready);
  for (const id of [1, 2, 3, 4, 5]) {
    assert.ok(rows.get(id), `#${id} offered`);
    assert.ok(!rows.get(id).reasons.some((r) => r.startsWith('shipped-unverified')),
      `#${id} must not be marked without an input saying so. An absent stamp is "not asked", `
      + 'never "nothing shipped"');
  }
  assert.deepEqual(rows.get(2).reasons, ['column:backlog', 'unclaimed', 'no-open-blockers'],
    'byte-identical to the pre-#1020 queue');
});

test('#1020 an EMPTY shipped set marks nothing — and is not confused with an absent one', () => {
  const { ready } = pageReady(readyFromStore(storeFor(), { shippedShas: new Set() }));
  for (const r of ready) {
    assert.ok(!r.reasons.some((x) => x.startsWith('shipped-unverified')),
      'an empty set is a real answer meaning nothing has shipped; it marks nothing and must not throw');
  }
});

test('#1020 a card with NO implementedBy is never marked, whatever the shipped set holds', () => {
  const { ready } = pageReady(readyFromStore(storeFor(), { shippedShas: shipped() }));
  const one = byId(ready).get(1);
  assert.deepEqual(one.reasons, ['column:backlog', 'unclaimed', 'no-open-blockers'],
    'vacuous-truth guard: "every sha is shipped" over an EMPTY list is trivially true, and would '
    + 'mark every unstarted card on the board as shipped');
});
