/**
 * #891 — the projection drops `entity.shortId`, so an activity forgets what it
 * was about the moment its card is deleted.
 *
 * ⛔ MEASURED IN PRODUCTION, 2026-08-18:
 *
 *     raw event log   entity: {kind, id, shortId}    2014/2014 card events carry it
 *     replica         prov:used entity:<uuid>        scrum:shortId → 0 rows
 *     orphaned        activities whose target no longer resolves → 34
 *
 * The usual defence is that a shortId is derivable in one hop: join
 * `?c schema:identifier ?id`. That is true *while the card still exists*. Delete
 * the card and the join has nothing to land on — the provenance record survives
 * and what it was provenance OF does not.
 *
 * ⭐⭐⭐ THIS IS THE NORTH-STAR CLAIM FAILING IN THE SMALL. The event log is the
 * room's memory of what was done. "Graph-native" is supposed to mean context is
 * RETRIEVABLE, not merely stored — and a memory that silently forgets its
 * referent when the referent is deleted is stored, not retrievable.
 *
 * ⚠️ AND THE FIELD WAS NEVER LOST, ONLY UNPROJECTED. The raw log has held it the
 * whole time, which is what makes the backfill free: re-projecting the same
 * bytes recovers all 34. Nothing needs to be reconstructed or guessed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphStore, queryGraph, projectActivities } from '../core/graph-replica.mjs';

/** Shapes copied verbatim from board-data-events/*.jsonl — not invented. */
const CARD_EV = (over = {}) => ({
  seq: 6689,
  recorded_at: '2026-08-18T19:44:51.400Z',
  occurred_at: '2026-08-18T19:44:51.400Z',
  actor: 'ada',
  op: 'update',
  entity: { kind: 'card', id: '731176f0-0000-4000-8000-000000000001', shortId: 873 },
  ...over,
});

const POST_EV = (over = {}) => ({
  seq: 6690,
  recorded_at: '2026-08-18T19:45:17.903Z',
  occurred_at: '2026-08-18T19:45:17.903Z',
  actor: 'ada',
  op: 'post',
  entity: { kind: 'conversation', id: '76617515-0000-4000-8000-000000000002' },
  ...over,
});

const store = () => buildGraphStore({ '@graph': [] });
const rows = (s, q) => queryGraph(s, q, { limit: 100 }).rows || [];

test('#891 ⭐⭐⭐ an activity carries the shortId it targeted, as its OWN literal', () => {
  const s = store();
  projectActivities(s, [CARD_EV()]);

  const r = rows(s, 'SELECT ?id WHERE { ?a a <http://www.w3.org/ns/prov#Activity> ; scrum:shortId ?id }');
  assert.equal(r.length, 1, 'the field the raw log has carried all along was dropped in projection');
  assert.equal(String(r[0].id), '873');
});

test('#891 ⛔ THE ORPHAN CASE — a DELETED card does not erase what its events were about', () => {
  // ⭐ THE WHOLE CARD. 34 production activities are in exactly this state: the
  // uuid still resolves to nothing, so "which card was this?" has no answer in
  // the graph while the raw log answers it directly.
  //
  // ⚠️ Deliberately projected with NO card entity present — that IS the deleted
  // state, and it is also the ordinary state of an activity log rebuilt from
  // events without the board. If the shortId only survives when the card does,
  // the fix has not fixed anything.
  const s = store();
  projectActivities(s, [CARD_EV()]);

  const joinable = rows(s, `SELECT ?id WHERE {
    ?a a <http://www.w3.org/ns/prov#Activity> ; <http://www.w3.org/ns/prov#used> ?c .
    ?c schema:identifier ?id }`);
  assert.equal(joinable.length, 0,
    'control: the card node does not exist, so the one-hop join returns nothing — '
    + 'this is precisely the state the 34 orphans are in');

  const direct = rows(s, 'SELECT ?id WHERE { ?a a <http://www.w3.org/ns/prov#Activity> ; scrum:shortId ?id }');
  assert.equal(String(direct[0]?.id), '873',
    'and the activity still knows, because the shortId is its own property rather than a join');
});

test('#891 ⚠️ a post carries NO shortId — absent, so it matches no card rather than every card', () => {
  // ⛔ The failure this prevents: a conversation event projected with an empty
  // or zero shortId would join to a card in any query using a loose comparison,
  // and 4,661 of the log's 6,701 events are posts. "Targeted no card" must be
  // ABSENCE, which SPARQL already reads correctly as "no match".
  const s = store();
  projectActivities(s, [POST_EV()]);

  const r = rows(s, 'SELECT ?id WHERE { ?a a <http://www.w3.org/ns/prov#Activity> ; scrum:shortId ?id }');
  assert.deepEqual(r, [], 'a conversation has no card, and no card must mean no triple');

  // Paired control: the activity itself still projected. Absence of the shortId
  // must not mean absence of the event.
  const all = rows(s, 'SELECT ?op WHERE { ?a a <http://www.w3.org/ns/prov#Activity> ; scrum:op ?op }');
  assert.deepEqual(all.map((x) => String(x.op)), ['post']);
});

test('#891 the projection stays idempotent — a rebuild does not double the shortId', () => {
  // #725's identity guard keys on seq. A new triple written outside that guard
  // is exactly how a re-projection starts accumulating duplicates.
  const s = store();
  projectActivities(s, [CARD_EV()]);
  projectActivities(s, [CARD_EV()]);

  const r = rows(s, 'SELECT ?id WHERE { ?a a <http://www.w3.org/ns/prov#Activity> ; scrum:shortId ?id }');
  assert.equal(r.length, 1, 'projected twice, stored once');
});

test('#891 a card event with NO shortId still projects — the activity happened either way', () => {
  // ⚠️ Same discipline the actor field already follows: a first cut of
  // projectActivities dropped events with `actor: null` and silently lost 23
  // real updates. An event missing a field is not a malformed event, and the
  // rule is to project what is there rather than to discard the record.
  const s = store();
  projectActivities(s, [CARD_EV({ entity: { kind: 'card', id: 'aaaa0000-0000-4000-8000-000000000003' } })]);

  const act = rows(s, 'SELECT ?op WHERE { ?a a <http://www.w3.org/ns/prov#Activity> ; scrum:op ?op }');
  assert.equal(act.length, 1, 'the activity is projected without the shortId, not dropped with it');
  const sid = rows(s, 'SELECT ?id WHERE { ?a a <http://www.w3.org/ns/prov#Activity> ; scrum:shortId ?id }');
  assert.deepEqual(sid, [], 'and no shortId is invented for it');
});

test('#891 shortId is a QUERYABLE literal — "what happened to card N" needs no join', () => {
  // The point of the fix, stated as the question it answers. Before this, the
  // only route was through the card node, which is the node that can vanish.
  const s = store();
  projectActivities(s, [
    CARD_EV(),
    CARD_EV({ seq: 6691, op: 'move', entity: { kind: 'card', id: '731176f0-0000-4000-8000-000000000001', shortId: 873 } }),
    CARD_EV({ seq: 6692, op: 'update', entity: { kind: 'card', id: 'cccc0000-0000-4000-8000-000000000004', shortId: 890 } }),
  ]);

  const r = rows(s, `SELECT ?op WHERE {
    ?a a <http://www.w3.org/ns/prov#Activity> ; scrum:shortId "873" ; scrum:op ?op } ORDER BY ?op`);
  assert.deepEqual(r.map((x) => String(x.op)), ['move', 'update'],
    'both events on #873, and nothing from #890 — one triple pattern, no card node required');
});
