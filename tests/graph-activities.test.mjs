/**
 * #725 part 2 — project the event log as PROV Activities.
 *
 * The board already writes structured events for every mutation and the graph
 * has never read them. `deriveEvents()` (server.js) emits
 * `{seq, actor, op, entity:{kind,id}, occurred_at, state}` and `appendEvent()`
 * persists them append-only. That record IS a PROV Activity: actor is
 * prov:wasAssociatedWith, op is the activity type, entity is what it acted on.
 *
 * Meanwhile the human-readable rendering of the same fact — "🔔 <seat> claimed
 * #726" — is stored as a Comment authored by `person:board`, a node that does
 * not exist (267 references, zero triples). So today:
 *
 *   "who moved cards, and when"        CANNOT be asked — the mover is prose
 *   "what did each person say"          silently includes 267 machine events
 *
 * Sizing measured 2026-08-07 before building rather than after: 1,624 events
 * over 4 days, ~8,120 triples, against a store already holding ~70,748. About
 * 11%, so the projection is unfiltered — there was no decision to make.
 *
 * ⚠️ Deliberately NOT wired into buildGraphStore() in this commit. The document
 * projection and the activity projection are separable, and the graph replica is
 * the surface whose breakage took the board's whole query layer down earlier
 * today. Pure function first, wiring second, reviewed in between.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphStore, queryGraph, projectActivities, IRI } from '../core/graph-replica.mjs';

/** One real event, shape copied verbatim from board-data-events/*.jsonl. */
const EV = (over = {}) => ({
  seq: 1622,
  recorded_at: '2026-08-07T21:39:45.566Z',
  occurred_at: '2026-08-07T21:39:45.566Z',
  actor: 'ada',
  op: 'post',
  entity: { kind: 'conversation', id: 'bea349a2-0000-4000-8000-000000000001' },
  state: { id: 'bea349a2-0000-4000-8000-000000000001', body: 'hello' },
  ...over,
});

const store = () => buildGraphStore({ '@graph': [] });
const rows = (s, q) => queryGraph(s, q, { limit: 100 }).rows || [];

test('#725 an event becomes a prov:Activity with actor, time and target', () => {
  const s = store();
  projectActivities(s, [EV()]);

  const r = rows(s, `SELECT ?a ?who ?op ?when ?what WHERE {
    ?a a <http://www.w3.org/ns/prov#Activity> ;
       <http://www.w3.org/ns/prov#wasAssociatedWith> ?who ;
       scrum:op ?op ;
       <http://www.w3.org/ns/prov#startedAtTime> ?when ;
       <http://www.w3.org/ns/prov#used> ?what }`);

  assert.equal(r.length, 1, 'one event, one activity');
  assert.match(String(r[0].who), /person:ada|person\/ada/, 'the ACTOR, not a fictional speaker');
  assert.equal(String(r[0].op), 'post');
  assert.match(String(r[0].when), /2026-08-07T21:39:45/);
  assert.match(String(r[0].what), /bea349a2/, 'linked to the thing it acted on');
});

test('#725 "who moved cards, and when" becomes answerable — it cannot be asked today', () => {
  const s = store();
  projectActivities(s, [
    EV({ seq: 1, actor: 'ada', op: 'update', entity: { kind: 'card', id: 'card-aaa' } }),
    EV({ seq: 2, actor: 'bo',  op: 'create', entity: { kind: 'card', id: 'card-bbb' } }),
    EV({ seq: 3, actor: 'ada', op: 'update', entity: { kind: 'card', id: 'card-ccc' } }),
    EV({ seq: 4, actor: 'ada', op: 'post',   entity: { kind: 'conversation', id: 'conv-x' } }),
  ]);

  const r = rows(s, `SELECT ?who (COUNT(?a) AS ?n) WHERE {
    ?a a <http://www.w3.org/ns/prov#Activity> ;
       <http://www.w3.org/ns/prov#wasAssociatedWith> ?who ;
       scrum:entityKind "card" } GROUP BY ?who`);

  const by = Object.fromEntries(r.map((x) => [String(x.who).replace(/^.*[:/]/, ''), Number(x.n)]));
  assert.equal(by.ada, 2, 'card activity only — the post must not count');
  assert.equal(by.bo, 1);
});

test('#725 activities are DISTINCT from speech — a Comment is not an Activity', () => {
  const s = store();
  projectActivities(s, [EV()]);

  // The separation is the entire point. If an activity also answered as a
  // Comment, "what did each person say this week" would keep silently counting
  // machine events, which is the defect #725 exists to remove.
  const speech = rows(s, `SELECT ?x WHERE { ?x a schema:Comment }`);
  assert.equal(speech.length, 0, 'an event is something that HAPPENED, not something said');
});

test('#725 a malformed event is skipped, not fatal — the log is append-only history', () => {
  const s = store();
  // Real logs carry real junk, and a projection that throws on one bad line
  // takes the whole graph down. Each of these lacks something load-bearing.
  projectActivities(s, [
    null,
    {},
    EV({ entity: null, seq: 99 }),
    EV({ op: null, seq: 98 }),
    EV({ seq: 100 }),                 // well-formed
  ]);
  const r = rows(s, `SELECT ?a WHERE { ?a a <http://www.w3.org/ns/prov#Activity> }`);
  assert.equal(r.length, 1, 'the good event survives its neighbours');
});

test('#725 an event with NO ACTOR is still an activity — it happened', () => {
  const s = store();
  // Caught on live data: 23 real card updates carry `actor: null`. A first cut
  // dropped them, which undercounted "who moved cards" by 23 while reporting a
  // clean number — the exact defect this card exists to remove. The activity is
  // projected; only the accountability triple is absent.
  projectActivities(s, [EV({ seq: 7, actor: null, op: 'update', entity: { kind: 'card', id: 'card-zzz' } })]);

  assert.equal(rows(s, `SELECT ?a WHERE { ?a a <http://www.w3.org/ns/prov#Activity> }`).length, 1);
  assert.equal(
    rows(s, `SELECT ?a WHERE { ?a <http://www.w3.org/ns/prov#wasAssociatedWith> ?w }`).length, 0,
    'unknown actor is an ABSENT triple, never a fabricated one');
  // …and the absence is itself queryable, which is the point of not dropping it
  const orphan = rows(s, `SELECT ?a WHERE {
    ?a a <http://www.w3.org/ns/prov#Activity>
    FILTER NOT EXISTS { ?a <http://www.w3.org/ns/prov#wasAssociatedWith> ?w } }`);
  assert.equal(orphan.length, 1, '"activities nobody is accountable for" must be askable');
});

test('#725 projection is idempotent — a rebuild must not double-count', () => {
  const s = store();
  projectActivities(s, [EV()]);
  const before = rows(s, `SELECT ?a ?p ?o WHERE { ?a ?p ?o }`).length;
  projectActivities(s, [EV()]);
  const after = rows(s, `SELECT ?a ?p ?o WHERE { ?a ?p ?o }`).length;
  assert.equal(after, before, 'seq is the identity; replaying the log is not new history');
});

test('#725 ANTI-VACUITY: an empty event list projects nothing and does not throw', () => {
  const s = store();
  projectActivities(s, []);
  assert.equal(rows(s, `SELECT ?a WHERE { ?a ?p ?o }`).length, 0);
  // and the harness can see triples at all, or every assertion above is empty
  projectActivities(s, [EV()]);
  assert.ok(rows(s, `SELECT ?a WHERE { ?a ?p ?o }`).length > 0,
    'if this fails, the queries above prove nothing');
});
