/**
 * #962 — `?c a scrum:Card` returned ZERO ROWS AND NO ERROR while 933 cards
 * existed, on the tool this room is required to try FIRST.
 *
 * ⛔ The trap was baited with the obvious spelling. A seat doing the sensible
 * thing got a confident, silent, well-formed lie; a seat who knew the arcane
 * spelling got the answer. And a silent zero is indistinguishable from an empty
 * board, so nothing about the failure invited a second look.
 *
 * ── OPTION (a), RULED 2026-08-24 ────────────────────────────────────────────
 * The alias is emitted BESIDE schema:CreativeWork in the PROJECTION. The stored
 * document is untouched.
 *
 * ⭐ Chosen over 4a (dual-typing the document) on blast radius, measured: 4a is
 * a ~26-file atomic change to the LOAD PATH where a mistake means `cardEntities`
 * loads EMPTY — total data invisibility traded for query ergonomics. The
 * exemption in the #561 gate is required EITHER WAY, so 4a bought nothing there.
 *
 * ⚠️ THE COST OF (a), STATED RATHER THAN DISCOVERED: a card is CreativeWork on
 * disk and CreativeWork + scrum:Card in the graph. TWO SURFACES, ONE NAME. The
 * divergence is recorded in the graph_query description, on the card, and
 * asserted in graph-query-prior-art-hazards.test.mjs — and the export-fidelity
 * half is deferred to its own card rather than smuggled in here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainToJsonLd } from '../core/jsonld.mjs';
import { buildGraphStore, queryGraph } from '../core/graph-replica.mjs';

const card = (id, sid, name) => ({
  '@id': id, '@type': 'CreativeWork', identifier: sid, name, board: { column: 'backlog' },
});

const domain = () => ({
  nodes: [
    card('t1', 1, 'tending playlist rotation'),
    card('t2', 2, 'Tending: the boot sequence'),
    card('x1', 3, 'something else entirely'),
  ],
  messages: [], people: [], columns: [],
});

const store = () => buildGraphStore(domainToJsonLd(domain()));
const count = (s, q) => Number(queryGraph(s, q).rows[0]?.n ?? -1);

test('#962 the TYPED prior-art query works — the shape a seat actually writes', () => {
  const s = store();
  // ⭐ This is acceptance 2's shape: type + a name filter, which is what a
  // prior-art search looks like. Cases spelled out, never LCASE (#927).
  const n = count(s,
    'SELECT (COUNT(?c) AS ?n) WHERE { ?c a scrum:Card ; schema:name ?name '
    + 'FILTER(CONTAINS(?name,"tending") || CONTAINS(?name,"Tending")) }');
  assert.equal(n, 2, `the typed query must find both tending cards, got ${n}`);
});

test('#962 ⭐ the alias matches EVERY card, not some — and the control proves the fixture is not empty', () => {
  const s = store();
  const creative = count(s, 'SELECT (COUNT(?c) AS ?n) WHERE { ?c a schema:CreativeWork }');
  assert.equal(creative, 3, 'precondition: three cards exist, or every count below is meaningless');
  const alias = count(s, 'SELECT (COUNT(?c) AS ?n) WHERE { ?c a scrum:Card }');
  assert.equal(alias, creative,
    `partial aliasing is worse than none — a query that finds SOME cards reads as a complete answer. Got ${alias} of ${creative}`);
});

test('#962 ⛔ LOAD-PATH TRIPWIRE — the projection change did not touch what LOADS', () => {
  // Acceptance 4 asked for this against a dual-typed fixture, because under 4a
  // `isCard` would have returned false for every card and `cardEntities` would
  // have loaded EMPTY. Under (a) the document is untouched, so this is
  // discharged BY CONSTRUCTION — and asserted anyway, because "by construction"
  // is exactly the kind of claim that stops being true when someone later
  // dual-types the document without re-reading this file.
  const jsonld = domainToJsonLd(domain());
  const types = jsonld['@graph']
    .filter((e) => e.identifier != null && e.name)
    .map((e) => JSON.stringify(e['@type']));
  assert.deepEqual([...new Set(types)], ['"CreativeWork"'],
    'the SERIALIZED document must still type a card as CreativeWork alone — if this '
    + 'fails, option 4a has landed and the graph_query description\'s "projection-only" '
    + 'claim is now false and must be corrected in the same commit');
});
