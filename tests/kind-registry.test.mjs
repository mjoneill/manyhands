/**
 * #1214 — THE KIND REGISTRY.
 *
 * These are behaviour tests, not shape tests. The behaviours that matter:
 *
 * 1. Deriving the event log's vocabulary from the registry must not LOSE a kind.
 *    A dropped kind does not throw at import — it throws later, on a write, in
 *    production, and the event that carried it is refused. So the regression
 *    guard is an explicit literal of what the event log accepted BEFORE this
 *    card, written out here rather than imported, because importing the thing
 *    under test to test itself is a check that cannot fail.
 *
 * 2. The registry must answer the question a census cannot: which kinds exist
 *    with ZERO instances. That blind spot is the reason the card was filed.
 *
 * 3. A registry of names without definitions is a logbook, not a vocabulary —
 *    the sentence the predicate registry already enforces, held here too.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KIND_DECLARATIONS, ENTITY_KINDS, PROJECTED_TYPES, COLLECTION_OF,
  kindByName, kindByEventKind, divergence,
} from '../core/kind-registry.mjs';

// The twelve entity kinds core/event-log.mjs accepted before #1214, retyped by
// hand from the literal Set as it stood at commit 43cac95. NOT imported: a
// control that reads the value under test certifies nothing.
const ENTITY_KINDS_BEFORE_1214 = [
  'card', 'conversation', 'column', 'wiki', 'tending', 'memory', 'label',
  'decision', 'seat-state', 'predicate', 'obligation', 'wake',
];

// The collection mapping as it stood at the same commit, same reasoning.
const COLLECTION_BEFORE_1214 = {
  card: 'cards', conversation: 'conversations', column: 'columns',
  tending: 'tending', memory: 'memories', label: 'labelAliases',
  'seat-state': 'seatStates', obligation: 'obligations', wake: 'wakes',
};

test('#1214 deriving ENTITY_KINDS loses nothing the event log already accepted', () => {
  for (const k of ENTITY_KINDS_BEFORE_1214) {
    assert.ok(ENTITY_KINDS.has(k),
      `entity kind "${k}" was accepted before #1214 and is missing from the derived set — `
      + 'every event carrying it would now be refused at validateEvent');
  }
});

// Every event kind added SINCE #1214, listed deliberately. This is the guard
// that makes a new kind a decision rather than a side effect: adding one to the
// registry fails this test until someone writes the kind's name here and, with
// it, accepts that replay and the collection map now carry it.
//
// It fired for real on the first customer: #1206 added `procedure` and this
// test went red the same minute, which is the behaviour it was written for.
const ENTITY_KINDS_ADDED_SINCE = [
  'kind',      // #1214 — the registry's own entry
  'request',   // #1217 — a refusal whose route maps to no entity kind
  'procedure', // #1206 — a repeatable method, versioned (slice 1 of #1205)
  'run',       // #1207 — one performance of a procedure (projects as prov:Activity)
  'artifact',  // #1207 — a file a run used or produced; pointer + hash, never payload
];

test('#1214 the derived set adds only DECLARED new kinds — a silent addition is as bad as a loss', () => {
  const added = [...ENTITY_KINDS].filter((k) => !ENTITY_KINDS_BEFORE_1214.includes(k));
  assert.deepEqual(added.sort(), [...ENTITY_KINDS_ADDED_SINCE].sort(),
    'a new event kind must be named here as well as declared in the registry — otherwise the '
    + 'vocabulary the write path accepts can grow without anyone deciding that it should');
});

test('#1214 the replay mapping is unchanged for every pre-existing kind', () => {
  for (const [kind, collection] of Object.entries(COLLECTION_BEFORE_1214)) {
    assert.equal(COLLECTION_OF[kind], collection,
      `"${kind}" replayed into "${collection}" before #1214; an unmapped or remapped kind `
      + 'silently DROPS at replay, so the store stops being rebuildable from the log');
  }
});

// A new collection is not free: replay upserts into `data[key]`, so a kind that
// names a collection nobody initialises rebuilds into a store shape the rest of
// the code does not expect. Same discipline as the kinds list — declare it here
// on purpose, or the map grows without a decision.
const COLLECTIONS_ADDED_SINCE = {
  procedure: 'procedures', // #1206
  run: 'runs', artifact: 'artifacts', // #1207
};

test('#1214 a kind maps only to a collection replay knows, or one declared new here', () => {
  for (const [kind, collection] of Object.entries(COLLECTION_OF)) {
    const expected = COLLECTION_BEFORE_1214[kind] ?? COLLECTIONS_ADDED_SINCE[kind];
    assert.equal(expected, collection,
      `"${kind}" claims collection "${collection}" which replay does not know about`);
  }
});

test('#1214 every declaration carries a definition and names its creating verb', () => {
  for (const k of KIND_DECLARATIONS) {
    const id = k.name || k.eventKind;
    assert.ok(typeof k.definition === 'string' && k.definition.trim().length > 80,
      `"${id}" has no real definition — a registry of names without definitions is a logbook. `
      + 'This is the read a seat had to do on scrum:WorkObject, and the read this replaces.');
    assert.ok(typeof k.createdBy === 'string' && k.createdBy.trim(),
      `"${id}" does not say how one is made — "how do I create this" is the question the `
      + 'registry exists to answer in the graph rather than in source');
  }
});

test('#1214 a kind is declared exactly once — two homes for one fact cannot contradict visibly', () => {
  const names = KIND_DECLARATIONS.map((k) => k.name).filter(Boolean);
  assert.equal(new Set(names).size, names.length, 'duplicate rdf:type declaration');
  const events = KIND_DECLARATIONS.map((k) => k.eventKind).filter(Boolean);
  assert.equal(new Set(events).size, events.length, 'duplicate event kind declaration');
});

test('#1214 lookups resolve both ways', () => {
  assert.equal(kindByName('scrum:Card').eventKind, 'card');
  assert.equal(kindByEventKind('card').name, 'scrum:Card');
  assert.equal(kindByName('scrum:Nonexistent'), null);
  assert.equal(kindByEventKind('nope'), null);
});

test('#1214 the WorkObject read that motivated this card is now answerable without reading triples', () => {
  const wo = kindByName('scrum:WorkObject');
  assert.ok(wo, 'scrum:WorkObject is live in the graph and must be declared');
  assert.match(wo.definition, /bid/i,
    'the definition must say what it IS — a seat had to read its triples to learn it is a '
    + 'bid/reply object, and that read is what this registry replaces');
  assert.match(wo.definition, /NOT a claim/,
    'and what it is NOT — a WorkObject is not a claim, and conflating them would put two '
    + 'coordination mechanisms under one name');
});

test('#1214 divergence names a declared kind with ZERO instances — the census blind spot', () => {
  // scrum:Obligation is declared. A census taken before the first obligation
  // existed would not have contained it: that is the exact hole the card names.
  const censusWithoutObligations = [...PROJECTED_TYPES].filter((t) => t !== 'scrum:Obligation');
  const d = divergence([], censusWithoutObligations);
  assert.ok(d.declaredNotInstantiated.includes('scrum:Obligation'),
    'a kind that exists but has never been instantiated must be VISIBLE — this is the one '
    + 'question `SELECT ?t WHERE { ?s a ?t }` can never answer');
});

test('#1214 divergence reports a graph-registered kind the runtime does not accept, and does not throw', () => {
  // ⚠️ This fixture must name a kind THIS BUILD GENUINELY DOES NOT HAVE. It
  // said `scrum:Procedure` until #1206 declared that kind for real, at which
  // point the test went red — correctly, because its premise had expired. A
  // fixture that quietly becomes true is a check that stops checking.
  const d = divergence([{ name: 'scrum:NotAThingThisBuildKnows' }], [...PROJECTED_TYPES]);
  assert.deepEqual(d.registeredNotDeclared, ['scrum:NotAThingThisBuildKnows'],
    'a seat registering a kind this build cannot project is a REAL state to announce (#1215), '
    + 'not an error to refuse — refusing would make the seat lose the definition it wrote');
});

test('#1214 divergence reports an instantiated type nobody declared — the original defect', () => {
  const d = divergence([], [...PROJECTED_TYPES, 'scrum:Surprise']);
  assert.deepEqual(d.instantiatedNotDeclared, ['scrum:Surprise'],
    'before this card, a kind existed the moment something instantiated it and nothing noticed');
});

test('#1214 a fully registered, fully instantiated board reports no divergence at all', () => {
  const rows = [...PROJECTED_TYPES].map((name) => ({ name }));
  const d = divergence(rows, [...PROJECTED_TYPES]);
  assert.deepEqual(d.registeredNotDeclared, []);
  assert.deepEqual(d.declaredNotRegistered, []);
  assert.deepEqual(d.instantiatedNotDeclared, []);
  assert.deepEqual(d.declaredNotInstantiated, []);
});

// ── the boundary the first version of this suite did not cross ──────────────
//
// ⛔ BOTH DEFECTS BELOW SHIPPED TO PRODUCTION WITH A GREEN SUITE, and were
// found by reading the live board sixty seconds after the deploy. Neither was
// subtle; both were invisible from where the tests stood.
//
//   1. The census shortened type IRIs with a hand-typed namespace that was
//      WRONG, so nothing matched: every declared kind reported ZERO instances
//      (scrum:Card among them, >1,000 of them on the board) and every real type
//      was reported "instantiated but not declared". Two confident, false,
//      opposite lists from one mistyped constant.
//   2. `kinds` was never added to the document builder's collection list, so
//      the rows stayed a top-level key: fine over REST, absent from the graph.
//      `?k a scrum:KindDefinition` returned 0 on a board holding 33.
//
// The old tests asserted against PROJECTED_TYPES strings and built graph stores
// straight from fixtures. Both stopped short of domain → document → graph,
// which is where both bugs lived. These go the whole way.

import { domainToJsonLd, jsonLdToDomain, shortenTypeIri } from '../core/jsonld.mjs';

test('#1214 a type IRI shortens using the REAL namespace, derived not retyped', () => {
  assert.equal(shortenTypeIri('https://scrumboard.local/ns#Card'), 'scrum:Card');
  assert.equal(shortenTypeIri('https://schema.org/Comment'), 'schema:Comment');
  assert.equal(shortenTypeIri('http://www.w3.org/ns/prov#Activity'), 'prov:Activity');
  // The shape of the production failure: the wrong base must NOT shorten, so a
  // future mistyped namespace fails loudly here instead of reporting zeros.
  assert.equal(shortenTypeIri('https://scrumboard.local/vocab#Card'),
    'https://scrumboard.local/vocab#Card');
  // And every declared kind must be reachable by shortening its own IRI back.
  for (const name of ['scrum:Card', 'scrum:Obligation', 'scrum:KindDefinition']) {
    const full = name.replace('scrum:', 'https://scrumboard.local/ns#');
    assert.equal(shortenTypeIri(full), name,
      `${name} must round-trip, or the census silently reports it as absent`);
  }
});

test('#1214 a registered kind SURVIVES the document round trip and lands in @graph', () => {
  const row = {
    '@id': 'https://scrumboard.local/kind/scrum%3ACard',
    '@type': 'scrum:KindDefinition',
    name: 'scrum:Card',
    'scrum:definition': 'A unit of work with a permanent short id.',
    'scrum:createdByVerb': 'card_create',
    dateCreated: '2026-09-05T19:00:00.000Z',
  };
  const doc = domainToJsonLd({ nodes: [], messages: [], people: [], columns: [], kinds: [row] });

  // The defect: it used to ride as a top-level key and never reach the graph.
  const inGraph = doc['@graph'].filter((e) => e['@type'] === 'scrum:KindDefinition');
  assert.equal(inGraph.length, 1,
    'a KindDefinition must be IN @graph — the replica projects from there, and a registry '
    + 'the graph cannot be asked about is a registry in name only');
  assert.equal(inGraph[0].name, 'scrum:Card');

  // And back, without being swept into _unmodelled.
  const back = jsonLdToDomain(doc);
  assert.equal(back.kinds?.length, 1, 'and it must come back as its own collection');
  assert.equal(back.kinds[0]['scrum:createdByVerb'], 'card_create');
  assert.ok(!(back._unmodelled || []).some((e) => e['@type'] === 'scrum:KindDefinition'),
    'a modelled class must never be swept into _unmodelled — that is how a collection '
    + 'silently becomes untyped residue');
});

test('#1214 absence is preserved — a board with no kinds does not sprout an empty key', () => {
  const back = jsonLdToDomain(domainToJsonLd({ nodes: [], messages: [], people: [], columns: [] }));
  assert.equal(back.kinds, undefined,
    'an untouched board must not grow a key and churn its file on every save');
});
