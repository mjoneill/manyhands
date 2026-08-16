/**
 * #816 — the queue reports what a card is CONNECTED to, bounded.
 *
 * WHY: on 2026-08-16 three seats read #814 repeatedly — grooming it, quoting
 * its Banana Test, appending steward constraints — and none followed its one
 * edge to #530, the architecture spec they spent the day re-deriving. The edge
 * was typed, bidirectional and live the whole time. `board_ready` reads
 * blockedBy and nothing else. ⇒ AN UNFOLLOWED EDGE AND AN UNWRITTEN ONE
 * PRODUCE IDENTICAL BEHAVIOUR.
 *
 * ── CONTRACT A — DISCOVERY, NOT PRIORITISATION ─────────────────────────────
 * This reports the relationships a card CARRIES. It promises no importance,
 * no reading order, no "what to do next". A deterministic cap makes a list
 * finite; it CANNOT manufacture relevance. So:
 *   - the reported type is the STORED predicate, never an interpretation.
 *     `relatedTo → 530` must not be labelled "spec": three seats inferred that
 *     by reading, and the graph never asserted it.
 *   - order is arbitrary-but-stable. Relationship edges carry NO timestamp,
 *     so "most recent" is unavailable and would be a lie if claimed.
 *
 * ── K IS UNIFORM ACROSS ALL FOUR TYPES ─────────────────────────────────────
 * relatedTo holds 1,498 edges board-wide and derivedFrom 26 — but 26 is a
 * CENSUS, not a cardinality. Nothing forbids a card with forty derivedFrom
 * edges. Capping only today's large type would re-import census-as-guarantee
 * in smaller print.
 *
 * ── ORDER IS KEYED ON THE STORED IDENTIFIER, NOT ON RESOLUTION ─────────────
 * ⚠️ AN EDGE'S RANK MUST NOT MOVE BECAUSE SOMETHING HAPPENED TO ITS TARGET.
 * "Resolved first, dangling last" would reshuffle a list the moment an
 * unrelated card is deleted — a value changing for reasons outside the thing
 * it describes. Resolution affects METADATA (title: null), never POSITION.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { domainToJsonLd } from '../core/jsonld.mjs';
import { buildGraphStore } from '../core/graph-replica.mjs';
import { readyFromStore, pageReady, READY_EXPLAIN, CONTEXT_K } from '../core/ready-query.mjs';

const card = (id, shortId, name, extra = {}) => ({
  '@id': id, '@type': 'CreativeWork', identifier: shortId, name, board: {}, ...extra,
});

const domain = () => ({
  nodes: [
    // The live case, reduced: ONE relatedTo edge. It can never exercise the cap
    // — which is why the overflow card below exists.
    card('c814', 814, 'commits and evidence are recordable only as prose', {
      column: 'backlog', 'scrum:priority': 'p2', relatedTo: ['c530'], derivedFrom: ['c805'],
    }),
    card('c530', 530, 'Evolve native JSON-LD to a linked entity graph', { column: 'backlog' }),
    card('c805', 805, 'graph-native tending', { column: 'done' }),
    // OVERFLOW: 8 relatedTo members against K=5, with TWO dangling — one that
    // sorts INSIDE the cap and one OUTSIDE it. Dangling-visible and
    // truncation-honest must be tested COMPOSED, not separately: testing them
    // apart is the seam that produced #815's explain/pagination blocker.
    card('cover', 900, 'overflow card', {
      column: 'backlog', 'scrum:priority': 'p1',
      relatedTo: ['c890', 'c880', 870, 'c860', 'c850', 'c840', 830, 'c820'],
    }),
    ...[890, 880, 860, 850, 840, 820].map((n) => card(`c${n}`, n, `target ${n}`, { column: 'backlog' })),
  ],
  messages: [], people: [], columns: [],
});

const storeFor = (d = domain()) => buildGraphStore(domainToJsonLd(d));
const ctx = (entry, type) => entry?.context?.[type];

test('#816 THE LIVE MISS: a seat seeing #814 sees #530, by its ACTUAL relation type', () => {
  const { ready } = pageReady(readyFromStore(storeFor()));
  const e = ready.find((c) => c.shortId === 814);

  assert.deepEqual(ctx(e, 'relatedTo'),
    { members: [{ shortId: 530, title: 'Evolve native JSON-LD to a linked entity graph' }], total: 1, truncated: false });
  assert.deepEqual(ctx(e, 'derivedFrom'),
    { members: [{ shortId: 805, title: 'graph-native tending' }], total: 1, truncated: false });

  // The type is REPORTED, never interpreted.
  assert.deepEqual(Object.keys(e.context).sort(), ['derivedFrom', 'relatedTo', 'supersededBy', 'supersedes']);
  assert.equal(JSON.stringify(e.context).toLowerCase().includes('spec'), false);
});

test('#816 K is uniform, truncation is confessed, dangling composes with the cap', () => {
  const { ready } = pageReady(readyFromStore(storeFor()));
  const rel = ctx(ready.find((c) => c.shortId === 900), 'relatedTo');

  assert.equal(CONTEXT_K, 5, 'the cap is a named constant');
  assert.equal(rel.total, 8, 'total counts every stored member, dangling included');
  assert.equal(rel.truncated, true);

  // Order: stored identifier, numeric DESC. 870 is dangling and keeps the exact
  // rank it would hold if its target existed — INSIDE the cap, title null.
  assert.deepEqual(rel.members, [
    { shortId: 890, title: 'target 890' },
    { shortId: 880, title: 'target 880' },
    { shortId: 870, title: null },
    { shortId: 860, title: 'target 860' },
    { shortId: 850, title: 'target 850' },
  ]);
  // 830 is dangling and sorts OUTSIDE the cap: counted, never privileged.
  assert.equal(rel.members.some((m) => m.shortId === 830), false);
});

test('#816 a deleted target must not RESHUFFLE the list', () => {
  // #860 exists in the base fixture and sorts 4th. Delete the card — the edge
  // is unchanged, so its rank must be unchanged; only its title goes null.
  const d = domain();
  d.nodes = d.nodes.filter((n) => n['@id'] !== 'c860');
  d.nodes.find((n) => n['@id'] === 'cover').relatedTo =
    ['c890', 'c880', 870, 860, 'c850', 'c840', 830, 'c820'];
  const rel = ctx(pageReady(readyFromStore(storeFor(d))).ready.find((c) => c.shortId === 900), 'relatedTo');
  assert.deepEqual(rel.members.map((m) => m.shortId), [890, 880, 870, 860, 850],
    'rank is keyed on the stored identifier; deleting a target changes metadata, not position');
  assert.equal(rel.members.find((m) => m.shortId === 860).title, null);
});

test('#816 explain carries the SAME bounded context — the live failure, closed', () => {
  const v = readyFromStore(storeFor());
  assert.deepEqual(READY_EXPLAIN(v, 814).context.relatedTo.members,
    [{ shortId: 530, title: 'Evolve native JSON-LD to a linked entity graph' }]);

  // Bounded, not "complete": ground truth means the summary tells the truth
  // about its own bound, not that it has none.
  const over = READY_EXPLAIN(v, 900).context.relatedTo;
  assert.equal(over.total, 8);
  assert.equal(over.truncated, true);
  assert.equal(over.members.length, 5);
});

test('#816 explain carries context for an EXCLUDED card too', () => {
  const d = domain();
  d.nodes.find((n) => n['@id'] === 'c814').claimedBy = 'ada';
  const v = READY_EXPLAIN(readyFromStore(storeFor(d)), 814);
  assert.equal(v.ready, false);
  assert.equal(v.reason, 'claimed-by:ada');
  assert.equal(v.context.relatedTo.members[0].shortId, 530,
    'a claimed card still shows what it connects to');
});

test('#816 the paged excluded[] list is byte-identical to #815 — no context there', () => {
  const { excluded } = pageReady(readyFromStore(storeFor()));
  assert.deepEqual(Object.keys(excluded.find((c) => c.shortId === 805)).sort(),
    ['reason', 'shortId', 'title']);
});

test('#816 MUTATION: dropping the edge removes context; changing its type moves it', () => {
  const dropped = domain();
  dropped.nodes.find((n) => n['@id'] === 'c814').relatedTo = [];
  const a = READY_EXPLAIN(readyFromStore(storeFor(dropped)), 814);
  assert.deepEqual(a.context.relatedTo, { members: [], total: 0, truncated: false });

  const retyped = domain();
  const n = retyped.nodes.find((x) => x['@id'] === 'c814');
  n.relatedTo = []; n.supersedes = ['c530'];
  const b = READY_EXPLAIN(readyFromStore(storeFor(retyped)), 814);
  assert.deepEqual(b.context.relatedTo.members, []);
  assert.equal(b.context.supersedes.members[0].shortId, 530, 'the REPORTED type follows the STORED predicate');
});

test('#816 a card with no edges reports empty context, not a missing field', () => {
  const { ready } = pageReady(readyFromStore(storeFor()));
  const bare = ready.find((c) => c.shortId === 890);
  for (const t of ['relatedTo', 'derivedFrom', 'supersedes', 'supersededBy']) {
    assert.deepEqual(ctx(bare, t), { members: [], total: 0, truncated: false }, t);
  }
});
