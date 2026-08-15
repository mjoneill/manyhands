/**
 * #805 item 6 — the tending system, ANSWERABLE from the real query surface.
 *
 * Before the projector existed, nine bootstrap entities produced thirteen
 * triples: every one rdf:type or identifier. `graph_query` could discover that
 * a TendingPromptVersion EXISTED and learn nothing about it — not its text, not
 * its author, and above all not the playlist ORDER, which we had spent the
 * evening declaring in the JSON-LD context and which reached the document and
 * stopped there.
 *
 * These are readback controls, not triple counts. Each asks a question a person
 * would actually ask, and each fails under a named defect.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTendingEntities, mergeTending } from '../core/tending-bootstrap.mjs';
import { domainToJsonLd } from '../core/jsonld.mjs';
import {
  buildGraphStore, queryGraph, updateEntity, removeEntity, subjectIriFor,
  SPARQL_PREFIXES, TENDING_PREDICATES, IRI,
} from '../core/graph-replica.mjs';
import { playlistVersionId, promptVersionId } from '../core/tending-ids.mjs';

const PROMPTS = [
  {
    slug: 'hello-ladies', body: 'A-first', author: 'ada', influencedBy: 'bo',
    evidencedBy: ['git:2a6f4d0', 'b2d746ab-e9eb-4641-82bd-5b86074d15b9'],
  },
  { slug: 'nobody-watching', body: 'B-second', author: 'ada' },
  { slug: 'quiet-hour', body: 'C-third', author: 'ada' },
];
const STATE = {
  history: [{
    window: '2026-08-14T22:00:00.000Z', seat: 'ada',
    at: '2026-08-14T22:45:36.788Z', reached: [],
  }],
};

const entities = (over = {}) => buildTendingEntities({
  prompts: PROMPTS, config: { enabled: true }, state: STATE,
  importedAt: '2026-08-15T00:00:00.000Z', ...over,
});
const storeFor = (es = entities()) => buildGraphStore(domainToJsonLd(
  mergeTending({ nodes: [], messages: [], people: [], columns: [] }, es),
));
const ask = (store, sparql) => queryGraph(store, `${SPARQL_PREFIXES}\n${sparql}`).rows;

/** The ordered-playlist question, asked the way a person would ask it. */
const ORDER_QUERY = `SELECT ?body (COUNT(?mid) AS ?pos) WHERE {
  ?pv a scrum:TendingPlaylistVersion ; scrum:orderedPrompts/rdf:rest* ?node .
  ?node rdf:first ?item . ?item scrum:body ?body .
  ?pv scrum:orderedPrompts/rdf:rest* ?mid . ?mid rdf:rest* ?node .
} GROUP BY ?body ORDER BY ?pos`;

// ── THE FOUR READBACKS ─────────────────────────────────────────────────────

test('⭐ Q1 prompt text, author and evidence are all queryable', () => {
  // DEFECT: the pre-#805 projector emitted type + identifier only. Every one of
  // these columns came back empty while the document held them all.
  const rows = ask(storeFor(), `SELECT ?body ?author ?ev WHERE {
    ?v a scrum:TendingPromptVersion ; scrum:body ?body ; schema:author ?author .
    OPTIONAL { ?v scrum:evidencedBy ?ev } } ORDER BY ?body`);
  assert.ok(rows.length >= 3, 'every prompt version must answer');
  const first = rows.find((r) => r.body === 'A-first');
  assert.equal(first.author, 'person:ada');
  // Evidence pointing at a board Comment must be an EDGE, so it joins to the
  // real utterance. A literal would silently fail to join and return less.
  const evs = rows.filter((r) => r.body === 'A-first').map((r) => r.ev);
  assert.ok(evs.includes('entity:b2d746ab-e9eb-4641-82bd-5b86074d15b9'),
    'a uuid evidence ref must project as an entity edge');
  assert.ok(evs.includes('git:2a6f4d0'),
    'a non-resolvable source ref stays a literal rather than minting an entity');
});

test('Q2 current tending state answers', () => {
  const rows = ask(storeFor(), 'SELECT ?e WHERE { ?s a scrum:TendingState ; scrum:enabled ?e }');
  assert.deepEqual(rows, [{ e: 'true' }]);
});

test('⭐⭐ Q3 the playlist answers IN ORDER — the whole point of the list', () => {
  // DEFECT: bare members, or a scrambled/flattened list, still answer "which
  // prompts" and lose "in what order". Order was declared in the @context all
  // evening and was absent from the graph until the collection was projected.
  const rows = ask(storeFor(), ORDER_QUERY);
  assert.deepEqual(rows.map((r) => r.body), ['A-first', 'B-second', 'C-third']);
  assert.deepEqual(rows.map((r) => r.pos), ['1', '2', '3']);
});

test('Q4 the legacy mint keeps its clock window and has NO silence edge', () => {
  const rows = ask(storeFor(), `SELECT ?win ?outcome ?declared WHERE {
    ?m a scrum:TendingMint ; scrum:legacyClockWindow ?win .
    ?c scrum:ofMint ?m ; scrum:outcome ?outcome ; scrum:declaredSeatRaw ?declared .
    FILTER NOT EXISTS { ?m scrum:ofSilence ?any } }`);
  assert.deepEqual(rows, [{
    win: '2026-08-14T22:00:00.000Z', outcome: 'granted', declared: 'ada',
  }]);
});

// ── COMPLETENESS BY CONSTRUCTION ───────────────────────────────────────────

test('⭐ an unknown tending predicate THROWS rather than vanishing', () => {
  // DEFECT: a projector that drops what it does not recognise lets a new field
  // reach the document and never reach the graph — which is precisely how the
  // entire tending system came to exist in one and not the other.
  const es = entities();
  const v = es.find((e) => e['@type'] === 'scrum:TendingPromptVersion');
  assert.throws(
    () => storeFor([...es, { ...v, '@id': v['@id'] + '-x', 'scrum:brandNewField': 'z' }]),
    /no projection semantics for tending predicate/,
  );
});

test('every predicate the bootstrap emits has declared semantics', () => {
  // DEFECT: the registry and the bootstrap drifting apart. This fails the day
  // someone adds a bootstrap field without teaching the projector.
  for (const e of entities()) {
    for (const k of Object.keys(e)) {
      if (k === '@id' || k === '@type') continue;
      assert.ok(TENDING_PREDICATES[k], `bootstrap emits ${k} with no declared projection kind`);
    }
  }
});

test('a bare array is refused by the projector, not quietly projected', () => {
  const es = entities();
  const pv = es.find((e) => e['@type'] === 'scrum:TendingPlaylistVersion');
  pv['scrum:orderedPrompts'] = pv['scrum:orderedPrompts']['@list'];
  assert.throws(() => storeFor(es), /must be \{"@list"/);
});

// ── INCREMENTAL MAINTENANCE: the list chain must not leak ──────────────────

const listTripleCount = (store) =>
  store.match(null, { termType: 'NamedNode', value: IRI.rdf + 'first' }, null).length;

test('⭐ reordering a playlist leaves NO orphaned list cells', () => {
  // DEFECT: subject-scoped deletion drops the head edge and orphans every
  // rdf:first/rdf:rest cell behind it — blank nodes are their own subjects.
  // The chain would accumulate on every single reorder, forever, invisibly.
  const store = storeFor();
  const before = listTripleCount(store);
  assert.equal(before, 3, 'three cells for three prompts');

  const pv = entities().find((e) => e['@id'] === playlistVersionId('room-tending', 1));
  const reversed = {
    ...pv,
    'scrum:orderedPrompts': { '@list': [...pv['scrum:orderedPrompts']['@list']].reverse() },
  };
  updateEntity(store, reversed);

  assert.equal(listTripleCount(store), 3, 'still three cells — no orphans accumulated');
  const rows = ask(store, ORDER_QUERY);
  assert.deepEqual(rows.map((r) => r.body), ['C-third', 'B-second', 'A-first'],
    'and the NEW order is what answers');
});

test('shortening a playlist drops the old tail', () => {
  // DEFECT: a 3→2 update that only overwrites cells 0 and 1 leaves cell 2
  // reachable, so the list still answers three items.
  const store = storeFor();
  const pv = entities().find((e) => e['@id'] === playlistVersionId('room-tending', 1));
  updateEntity(store, {
    ...pv,
    'scrum:orderedPrompts': { '@list': [promptVersionId('hello-ladies', 1)] },
  });
  assert.equal(listTripleCount(store), 1);
  assert.deepEqual(ask(store, ORDER_QUERY).map((r) => r.body), ['A-first']);
});

test('removing a playlist version removes its list chain too', () => {
  const store = storeFor();
  const pv = entities().find((e) => e['@id'] === playlistVersionId('room-tending', 1));
  removeEntity(store, subjectIriFor(pv));
  assert.equal(listTripleCount(store), 0, 'no cell may outlive its owner');
  assert.equal(ask(store, ORDER_QUERY).length, 0);
});
