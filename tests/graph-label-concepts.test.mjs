/**
 * #687 — labels become CONCEPT NODES, and the literal stays.
 *
 * #687 closed in 2026-08-05 having deliberately left this open, and it stated
 * the exact condition under which to come back:
 *
 *   "Labels are string literals. Decide: keep as literals with a defined
 *    predicate (fine for the graph-complete claim) or mint concept nodes IF WE
 *    WANT LABEL→CARDS TRAVERSAL FROM THE GRAPH SIDE."
 *
 * That condition is now met and measured: 391 distinct label strings, zero
 * identities, and traversal is one of the three graph-first gaps on the apex
 * card. The warrant is #687's own sentence — not an analogy to #686, which is
 * about derived PEOPLE and does not fit.
 *
 * ⭐ BOTH HALVES, ON PURPOSE. #857 §V: "Membership by label is cheap and bulk;
 * structural children get real edges. Both, on purpose — THE STRING FOR SCALE,
 * THE EDGE FOR TRAVERSAL." The literal is not a workaround being tolerated; it
 * is the scale mechanism, and only half the design was ever built. So every
 * assertion here that adds the edge is paired with one proving the literal
 * still answers identically.
 *
 * ⛔ WHAT THIS SLICE DELIBERATELY DOES NOT DO: synonyms. `building scrum board`
 * and `building-scrum-board` are two spellings of one concept and they will get
 * two nodes here. Merging them needs a mechanism nobody has designed — curated
 * merge vs alias list vs emergent co-occurrence are three different products —
 * and minting identities is a prerequisite for ALL of them. Building the
 * mechanism before the identities would be designing on top of nothing.
 *
 * ⚠️ THE SHAPE, per the room's D1/D2/D3 rule: materialized into the store at
 * PROJECTION time from ONE authority (the card's own labels), rebuilt every
 * time. No second copy, no sync code, so drift stays unrepresentable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphStore, queryGraph, updateEntity } from '../core/graph-replica.mjs';
import { domainToJsonLd } from '../core/jsonld.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const card = (id, shortId, name, labels) => ({
  '@type': 'CreativeWork', '@id': id, identifier: shortId, name, text: '',
  additionalType: 'scrum:task',
  board: {
    column: 'backlog', order: 0, assignees: [], labels, for: '', priority: null,
    relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [], supersededBy: [] },
  },
});

const doc = () => domainToJsonLd({
  nodes: [
    card('u-a', 1, 'alpha', ['manyhands', 'graph']),
    card('u-b', 2, 'beta', ['manyhands']),
    card('u-c', 3, 'gamma', []),
    // The live pair that will decide the synonym question. Two spellings, and
    // this slice must NOT pretend to resolve them.
    card('u-d', 4, 'delta', ['building scrum board']),
    card('u-e', 5, 'epsilon', ['building-scrum-board']),
  ],
  messages: [], people: [],
  columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
  nextShortId: 6, lastUpdated: null,
});

test('#687 the label literal still answers identically — the scale half is untouched', () => {
  // ⚠️ THE BACKWARD-COMPATIBILITY CONTROL, FIRST. Every existing consumer and
  // every card_list?label= query reads the literal. If this breaks, the slice is
  // a regression no matter how good the traversal is.
  const store = buildGraphStore(doc());
  const r = queryGraph(store,
    'SELECT ?id WHERE { ?c scrum:label "manyhands" ; schema:identifier ?id } ORDER BY ?id');
  assert.deepEqual(r.rows.map((x) => x.id), ['1', '2'],
    'the bare-literal query is the one 391 labels and every consumer depend on');
});

test('#687 a distinct label is a DefinedTerm node — the identity half', () => {
  const store = buildGraphStore(doc());
  const r = queryGraph(store,
    'SELECT ?name WHERE { ?t a schema:DefinedTerm ; schema:name ?name } ORDER BY ?name');
  assert.deepEqual(r.rows.map((x) => x.name),
    ['building scrum board', 'building-scrum-board', 'graph', 'manyhands'],
    'four distinct label strings ⇒ four concepts. The two spellings are NOT merged '
    + 'here — that is the synonym question, and it is deliberately not answered by this slice.');
});

test('#687 label→cards traversal FROM THE GRAPH SIDE — the condition #687 named', () => {
  // This query is the reason the card left the decision open, quoted verbatim in
  // the header. It is impossible against bare literals: a string is not a subject,
  // so you cannot start at the concept and walk to its cards.
  const store = buildGraphStore(doc());
  const r = queryGraph(store, `
    SELECT ?title WHERE {
      ?t a schema:DefinedTerm ; schema:name "manyhands" .
      ?c schema:keywords ?t ; schema:name ?title .
    } ORDER BY ?title`);
  assert.deepEqual(r.rows.map((x) => x.title), ['alpha', 'beta'],
    'start at the CONCEPT, arrive at its cards');
});

test('#687 one concept, one node — two cards sharing a label share an identity', () => {
  // ⭐ THE POINT OF IDENTITY, and the thing a per-card blank node would fail.
  // If each card minted its own term, the count would be 5 and every query above
  // would still pass while the graph held five unrelated things that happen to
  // spell the same.
  const store = buildGraphStore(doc());
  const r = queryGraph(store,
    'SELECT (COUNT(DISTINCT ?t) AS ?n) WHERE { ?t a schema:DefinedTerm ; schema:name "manyhands" }');
  assert.equal(r.rows[0].n, '1', 'both cards point at the SAME node, not at twin nodes');

  const back = queryGraph(store,
    'SELECT (COUNT(?c) AS ?n) WHERE { ?c schema:keywords ?t . ?t schema:name "manyhands" }');
  assert.equal(back.rows[0].n, '2', 'and the shared node is reachable from both directions');
});

test('#687 a card with no labels gets no keywords edge — no phantom concepts', () => {
  const store = buildGraphStore(doc());
  const r = queryGraph(store,
    'SELECT ?id WHERE { ?c schema:identifier "3" ; schema:keywords ?t . BIND(?c AS ?id) }');
  assert.equal(r.rows.length, 0, 'gamma has no labels and must acquire nothing');
});

test('#687 a label with spaces survives as an addressable identity', () => {
  // ⚠️ 'building scrum board' is the board's most-used label, it contains spaces,
  // and a spaced value has already caused one silent-zero defect this month (#764).
  // An IRI cannot hold a raw space, so the encoding is where this would break.
  const store = buildGraphStore(doc());
  const r = queryGraph(store, `
    SELECT ?title WHERE {
      ?t a schema:DefinedTerm ; schema:name "building scrum board" .
      ?c schema:keywords ?t ; schema:name ?title .
    }`);
  assert.deepEqual(r.rows.map((x) => x.title), ['delta'],
    'the space must survive the round trip into an IRI and back out as a name');
});

test('#687 a concept whose last card drops the label does NOT survive — drift is unrepresentable', () => {
  // ⛔ THIS IS THE TEST THAT CAUGHT THE FIRST IMPLEMENTATION, and it did not
  // exist until the orphan was measured by hand.
  //
  // Concept triples hang from the CONCEPT's subject, not the card's, and
  // `updateEntity` deletes only the card's own subject. So the first cut left
  // `concept:temp` alive — typed, named, and reachable by zero cards — after
  // the only card carrying it dropped the label. The card's literal and edge
  // both vanished correctly; the identity did not.
  //
  // ⚠️ WHY THAT IS NOT COSMETIC. #714's invariant is that an incrementally
  // maintained store is triple-for-triple identical to a full rebuild. An
  // orphan concept exists in the synced store and NOT in a rebuilt one, so the
  // two disagree — and it is the room's D-rule failing exactly as stated: a
  // derived thing that needs keeping in step with its authority has left the
  // pattern. The whole suite passed with the orphan in place; nothing else
  // could see it.
  const store = buildGraphStore(doc());
  const before = queryGraph(store,
    'SELECT (COUNT(DISTINCT ?t) AS ?n) WHERE { ?t a schema:DefinedTerm }');
  assert.equal(before.rows[0].n, '4', 'control: four concepts before anything is dropped');

  // 'graph' is carried by exactly one card. Drop it there and it should cease
  // to exist as a concept; 'manyhands', carried by two, must be untouched.
  const stripped = domainToJsonLd({
    nodes: [
      card('u-a', 1, 'alpha', ['manyhands']),
      card('u-b', 2, 'beta', ['manyhands']),
      card('u-c', 3, 'gamma', []),
      card('u-d', 4, 'delta', ['building scrum board']),
      card('u-e', 5, 'epsilon', ['building-scrum-board']),
    ],
    messages: [], people: [],
    columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
    nextShortId: 6, lastUpdated: null,
  });
  updateEntity(store, stripped['@graph'].find((e) => e['@id'] === 'u-a'));

  const names = queryGraph(store,
    'SELECT ?n WHERE { ?t a schema:DefinedTerm ; schema:name ?n } ORDER BY ?n').rows.map((r) => r.n);
  assert.ok(!names.includes('graph'),
    'the concept lost its last card and must not linger as an identity nothing points at');
  assert.ok(names.includes('manyhands'),
    'a concept another card still carries must SURVIVE — the sweep must not over-collect, '
    + 'which is the failure mode a naive "delete on update" would introduce');

  // ⭐ THE PARITY CHECK, stated as the invariant rather than as a count: the
  // synced store must equal what a rebuild from the same document produces.
  const rebuilt = buildGraphStore(stripped);
  const rebuiltNames = queryGraph(rebuilt,
    'SELECT ?n WHERE { ?t a schema:DefinedTerm ; schema:name ?n } ORDER BY ?n').rows.map((r) => r.n);
  assert.deepEqual(names, rebuiltNames,
    'incremental and rebuilt stores must agree about which concepts exist (#714)');
});

test('#687 it reaches the LIVE endpoint, not just the module', async () => {
  // ⛔ THE #725 LESSON, APPLIED THE SAME DAY IT WAS LEARNED. `projectActivities`
  // had seven green unit tests and no production caller. A unit test proves the
  // artifact; only the front door proves the property. This asserts through HTTP.
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const created = await fetch(`${s.baseUrl}/api/cards`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'live', labels: ['manyhands'], by: 'ada' }),
    });
    assert.equal(created.status, 201);

    const res = await fetch(`${s.baseUrl}/api/graph`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query:
        'SELECT ?title WHERE { ?t a schema:DefinedTerm ; schema:name "manyhands" . '
        + '?c schema:keywords ?t ; schema:name ?title }' }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.deepEqual(body.rows.map((r) => r.title), ['live'],
      'the concept node must exist on the running server, reached the way a caller reaches it');
  } finally { await s.stop(); }
});
