/**
 * #1034 — the graph replica projects `scrum:order` as a STRING.
 *
 * It is an integer on disk and an integer via REST; only the SPARQL surface
 * disagrees. Both consequences are silent:
 *
 *     FILTER(?o != 0)   compares a string to an integer ⇒ type mismatch ⇒
 *                       true for every row ⇒ the filter removes NOTHING
 *     ORDER BY ?o       lexical, not numeric ⇒ "100" sorts before "9"
 *
 * Neither errors. Both return a well-formed, confidently wrong answer — the
 * family #962 enumerates, and the first member that corrupts a COMPARISON
 * rather than returning empty.
 *
 * It was found because a count came back 577-of-577: the filter removed
 * nothing, which is this room's own tell for a broken filter.
 *
 * ⇒ WHY IT MATTERS BEYOND TIDINESS: #1021 and #910 want a ranker that orders
 *   cards within a priority band, and `scrum:order` is the field named to hold
 *   it. A graph-backed ranker would sort card 9 above card 100, quietly.
 *
 * The remedy is #966's, already proven in this file's neighbour for booleans:
 * emit a TYPED literal, because SPARQL's bare `0` IS "0"^^xsd:integer and a
 * plain string never matches the shape a caller naturally writes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphStore, queryGraph } from '../core/graph-replica.mjs';

const CARDS = {
  '@graph': [
    { '@type': 'CreativeWork', '@id': 'a', identifier: 1, name: 'nine', 'scrum:order': 9 },
    { '@type': 'CreativeWork', '@id': 'b', identifier: 2, name: 'hundred', 'scrum:order': 100 },
    { '@type': 'CreativeWork', '@id': 'c', identifier: 3, name: 'twenty', 'scrum:order': 20 },
    { '@type': 'CreativeWork', '@id': 'd', identifier: 4, name: 'zero-1', 'scrum:order': 0 },
    { '@type': 'CreativeWork', '@id': 'e', identifier: 5, name: 'zero-2', 'scrum:order': 0 },
  ],
};

const rows = (graph, q) => queryGraph(buildGraphStore(graph), q).rows;

test('#1034 scrum:order is a NUMERIC literal, not a string', () => {
  const r = rows(CARDS, 'SELECT DISTINCT (DATATYPE(?o) AS ?dt) WHERE { ?s scrum:order ?o }');
  assert.equal(r.length, 1, 'every order should carry ONE datatype');
  assert.notEqual(r[0].dt, 'xsd:string',
    'scrum:order projects as a string, so every numeric comparison against it '
    + 'silently misbehaves — this is the defect');
  assert.match(String(r[0].dt), /integer|decimal|int$/,
    `expected a numeric datatype, got ${r[0].dt}`);
});

test('#1034 ⛔ FILTER(?o != 0) actually REMOVES the zero-order cards', () => {
  // ⭐ ANTI-VACUITY FIRST. This assertion is only meaningful if the unfiltered
  // population is bigger than the filtered one — a filter that "removes the
  // zeros" from a fixture with no zeros passes while broken. The fixture has
  // two, and they are asserted here rather than assumed.
  const all = rows(CARDS, 'SELECT ?s WHERE { ?s scrum:order ?o }');
  assert.equal(all.length, 5, 'precondition: five cards carry an order');

  const nonZero = rows(CARDS, 'SELECT ?s WHERE { ?s scrum:order ?o FILTER(?o != 0) }');
  assert.equal(nonZero.length, 3,
    `FILTER(?o != 0) returned ${nonZero.length} of 5 — a filter that removes NOTHING `
    + 'is the tell that the comparison is type-mismatched, not that the data is non-zero');
});

test('#1034 ⭐ NEGATIVE CONTROL — ORDER BY puts 9 BEFORE 100 (numeric, not lexical)', () => {
  // ⛔ THE ASSERTION THAT MATTERS. A fix that changes the DATATYPE without
  // fixing sort order is the same defect wearing a passing test: lexically
  // "100" < "20" < "9", so this ordering is the thing a caller actually feels.
  const r = rows(CARDS,
    'SELECT ?n WHERE { ?s scrum:order ?o ; schema:name ?n FILTER(?o != 0) } ORDER BY ?o');
  assert.deepEqual(r.map((x) => x.n), ['nine', 'twenty', 'hundred'],
    'lexical ordering gives hundred < twenty < nine; numeric gives 9 < 20 < 100');
});

test('#1034 an order of ZERO is still projected — the fix must not drop falsy values', () => {
  // The guard is `!= null`, and 0 is falsy. A fix that switches to a truthiness
  // test would make 516 real cards lose the field entirely, trading a wrong
  // datatype for missing data.
  const r = rows(CARDS, 'SELECT ?n WHERE { ?s scrum:order 0 ; schema:name ?n }');
  assert.equal(r.length, 2, 'both zero-order cards must still be queryable by their order');
});

test('#1034 scrum:Column order is typed too — the SAME defect, second site', () => {
  // graph-replica projects scrum:order in two places. Fixing only the card site
  // leaves columns sorting lexically, which is precisely where an `order` field
  // is most obviously a sort key.
  const cols = {
    '@graph': [
      { '@type': 'scrum:Column', '@id': 'https://scrumboard.local/column/x', identifier: 'x', name: 'nine', 'scrum:order': 9 },
      { '@type': 'scrum:Column', '@id': 'https://scrumboard.local/column/y', identifier: 'y', name: 'hundred', 'scrum:order': 100 },
    ],
  };
  const r = rows(cols, 'SELECT ?n WHERE { ?s a scrum:Column ; scrum:order ?o ; schema:name ?n } ORDER BY ?o');
  assert.deepEqual(r.map((x) => x.n), ['nine', 'hundred'],
    'columns sort lexically when their order is a string');
});
