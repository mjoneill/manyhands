/**
 * #817 — a SUPERSEDED card is not available work.
 *
 * THE LIVE DEFECT, measured 2026-08-16 21:55Z before this test existed:
 *   #768 supersededBy #769 · column:backlog · unclaimed
 *   #757 supersededBy #756 · column:backlog · unclaimed
 *   board_ready(explain=768) → { ready: true,
 *                                reasons: ["column:backlog","unclaimed",
 *                                          "no-open-blockers"] }
 * ⇒ the queue told any seat that #768 was ready to start. #769 had replaced it.
 *
 * Found while scoping #816's selection rule — asking "which edges change a
 * seat's decision to start?" turned up one that doesn't inform the decision at
 * all: `supersededBy` INVALIDATES it. That makes it an exclusion, not context,
 * which is why it was split out of #816 rather than bundled into the slice
 * that found it.
 *
 * ── WHY A FLAT RULE (verifier's binding constraint, card thread) ────────────
 * ⚠️ DO NOT consult the superseder's state. The tempting refinement —
 * "unless the superseder is done or abandoned, in which case the original may
 * be live again" — is inference about intent that NO EDGE ASSERTS, and it is
 * untestable: nothing in the graph says whether an abandoned superseder
 * revives its predecessor. A flat rule is arguable; the clever one is a guess
 * with a query attached.
 *
 * ── WHY THIS IS SAFE TO BUILD ON (verified before the rule was accepted) ────
 * All four live supersession edges are symmetric in BOTH directions
 * (#756↔757, #768↔769). That matters because 79% of `relatedTo` is one-ended:
 * had supersession been maintained as loosely, this exclusion would fire on
 * one side and miss the other, and the queue would answer differently
 * depending on which card you asked about. `supersededBy` is server-maintained
 * from `supersedes`, which is why it holds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { domainToJsonLd } from '../core/jsonld.mjs';
import { buildGraphStore } from '../core/graph-replica.mjs';
import { readyFromStore, pageReady, READY_EXPLAIN } from '../core/ready-query.mjs';

const card = (id, shortId, name, extra = {}) => ({
  '@id': id, '@type': 'CreativeWork', identifier: shortId, name, board: {}, ...extra,
});

/**
 * The superseded card is deliberately given the HIGHEST priority on the board
 * and the LOWEST shortId, so under the ready ordering (p0 first, ties
 * oldest-first) a ruleset that ignores supersession puts it at POSITION 1.
 * A fixture where it sorts last could pass by accident.
 */
const domain = () => ({
  nodes: [
    card('old', 10, 'the replaced card', {
      column: 'backlog', 'scrum:priority': 'p0', supersededBy: ['new'],
    }),
    card('new', 90, 'the replacement', {
      column: 'backlog', 'scrum:priority': 'p2', supersedes: ['old'],
    }),
    card('live', 50, 'ordinary available work', { column: 'backlog', 'scrum:priority': 'p1' }),
  ],
  messages: [], people: [], columns: [],
});

const storeFor = (d = domain()) => buildGraphStore(domainToJsonLd(d));

test('#817 a superseded card is EXCLUDED, with the superseder named', () => {
  const { ready, excluded } = pageReady(readyFromStore(storeFor()));

  assert.equal(ready.some((c) => c.shortId === 10), false,
    'the replaced card must not be offered — it is p0 and oldest, so a ruleset ignoring supersession fails HERE, at position 1');
  assert.equal(excluded.find((c) => c.shortId === 10)?.reason, 'superseded-by:90');

  // The replacement and unrelated work are unaffected.
  assert.deepEqual(ready.map((c) => c.shortId), [50, 90]);
});

test('#817 explain answers for the superseded card', () => {
  const v = READY_EXPLAIN(readyFromStore(storeFor()), 10);
  assert.equal(v.ready, false);
  assert.equal(v.reason, 'superseded-by:90');
});

test('#817 the rule is FLAT — the superseder\'s own state is never consulted', () => {
  // Superseder is DONE. A "clever" rule might revive the original here.
  // Nothing in the graph says an abandoned or completed superseder revives its
  // predecessor, so inventing that is a guess. The original stays excluded.
  const d = domain();
  d.nodes.find((n) => n['@id'] === 'new').column = 'done';
  const { excluded } = pageReady(readyFromStore(storeFor(d)));
  assert.equal(excluded.find((c) => c.shortId === 10)?.reason, 'superseded-by:90',
    'a done superseder does not revive the card it replaced');
});

test('#817 MUTATION: removing the edge returns the card to ready', () => {
  const d = domain();
  d.nodes.find((n) => n['@id'] === 'old').supersededBy = [];
  d.nodes.find((n) => n['@id'] === 'new').supersedes = [];
  const { ready } = pageReady(readyFromStore(storeFor(d)));
  assert.equal(ready[0].shortId, 10, 'without the edge it is p0 and leads the queue');
});

test('#817 precedence is deterministic and stated: done > claimed > superseded > blocker', () => {
  // A card that is BOTH superseded and claimed reports the claim, not the
  // supersession — one reason per card, chosen by a fixed order, so the
  // explanation never depends on evaluation accident.
  const d = domain();
  d.nodes.find((n) => n['@id'] === 'old').claimedBy = 'ada';
  const { excluded } = pageReady(readyFromStore(storeFor(d)));
  assert.equal(excluded.find((c) => c.shortId === 10)?.reason, 'claimed-by:ada');

  // And a superseded card in done reports done, not supersession.
  const d2 = domain();
  d2.nodes.find((n) => n['@id'] === 'old').column = 'done';
  const { excluded: ex2 } = pageReady(readyFromStore(storeFor(d2)));
  assert.equal(ex2.find((c) => c.shortId === 10)?.reason, 'column:done');
});

test('#817 #815 verdicts are otherwise untouched', () => {
  const { ready, readyTotal, excludedTotal } = pageReady(readyFromStore(storeFor()));
  assert.equal(readyTotal, 2);
  assert.equal(excludedTotal, 1);
  assert.deepEqual(ready[0].reasons, ['column:backlog', 'unclaimed', 'no-open-blockers']);
});
