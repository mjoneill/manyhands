/**
 * core/graph-queries.mjs — the executable query library, tested as ruled:
 * every query beside a KNOWN-POSITIVE WITNESS sharing its predicates and
 * datatypes, and a mutation proving the ABSENT case actually reads 0.
 *
 * The fixture goes through the REAL projection path (domainToJsonLd →
 * buildGraphStore), never a hand-built triple set — the datatype trap this
 * library retires (identifiers project as STRING literals) only exists on the
 * real path, so a synthetic store would test the library against a world
 * where its hardest-won lesson isn't true.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { domainToJsonLd } from '../core/jsonld.mjs';
import { buildGraphStore, queryGraph, SPARQL_PREFIXES } from '../core/graph-replica.mjs';
import {
  typedEntityCount, cardByShortId, anyCardWitness, cardsByNameContains,
  tendingEntityCount, anyTypedEntityWitness, cardEdges,
} from '../core/graph-queries.mjs';

const domain = (tending = []) => ({
  nodes: [
    {
      '@id': 'entity:c1', '@type': 'CreativeWork', identifier: 41,
      name: 'first fixture card', board: {},
      // ⚠️ stored-node shape: relationship arrays live at TOP LEVEL and hold
      // entity-id STRINGS — the nested relationships:{} object is the REST
      // API's shape, and the projector silently ignores it (measured).
      blockedBy: ['c2'],
    },
    { '@id': 'entity:c2', '@type': 'CreativeWork', identifier: 42, name: 'second fixture card', board: {} },
  ],
  messages: [], people: [], columns: [],
  ...(tending.length ? { tending } : {}),
});

const storeFor = (d = domain()) => buildGraphStore(domainToJsonLd(d));
const ask = (store, q) => queryGraph(store, `${SPARQL_PREFIXES}\n${q}`).rows;

// ── the witness/target pair is the unit, not the query ─────────────────────

test('cardByShortId finds a real card, and its WITNESS answers through the same predicates', () => {
  const s = storeFor();
  assert.ok(ask(s, anyCardWitness()).length > 0, 'witness: some card answers identifier+name');
  const rows = ask(s, cardByShortId(41));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'first fixture card');
});

test('⭐ ABSENCE DISCRIMINATES: a missing shortId reads 0 WHILE the witness still answers', () => {
  // The trap this library exists for: 0 rows from a wrong query and 0 rows
  // from an absent thing are the same output. The pair splits them — witness
  // green + target empty is a MEASUREMENT of absence; witness empty voids it.
  const s = storeFor();
  assert.equal(ask(s, cardByShortId(999)).length, 0, 'absent card reads 0');
  assert.ok(ask(s, anyCardWitness()).length > 0, 'and the witness proves the predicates were right');
});

test('⭐ THE DATATYPE LESSON IS TRUE ON THE REAL PATH: identifiers project as strings', () => {
  // Q2 of the measured three-query tax: `schema:identifier 804` as a bare
  // number matched nothing. This pins WHY — the projection stringifies — so
  // if the projection ever changes datatype, this fails and the library's
  // hardest-won comment gets re-examined instead of silently going stale.
  const s = storeFor();
  const witness = ask(s, anyCardWitness());
  assert.equal(typeof witness[0].id, 'string', 'identifier reaches the query surface as a string');
  const numericForm = `SELECT ?card WHERE { ?card a schema:CreativeWork ; schema:identifier 41 }`;
  assert.equal(ask(s, numericForm).length, 0, 'the numeric literal form matches NOTHING — the trap is real');
});

test('cardsByNameContains finds by substring, case-insensitively', () => {
  const rows = ask(storeFor(), cardsByNameContains('SECOND fixture'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, '42');
});

// ── the deploy-hold instrument, both directions ────────────────────────────

test('⭐⭐ tendingEntityCount reads 0 on a tending-free board — with its witness green', () => {
  const s = storeFor();
  assert.ok(ask(s, anyTypedEntityWitness()).length > 0, 'witness: typed entities exist');
  assert.equal(ask(s, tendingEntityCount())[0].n, '0');
});

test('⭐⭐ and reads exactly the entities when they EXIST — the mutation that makes 0 trustworthy', () => {
  const s = storeFor(domain([{
    '@id': 'https://scrumboard.local/tending/prompt/p-lib/v1',
    '@type': 'scrum:TendingPromptVersion', 'scrum:body': 'x', 'scrum:version': 1,
  }]));
  assert.equal(ask(s, tendingEntityCount())[0].n, '1',
    'a query that reads 0 both with and without the entity would be the string-grep all over again');
});

// ── coordination lives in edges ────────────────────────────────────────────

test('cardEdges surfaces blockedBy — recorded coordination is queryable', () => {
  const rows = ask(storeFor(), cardEdges(41));
  const blocked = rows.filter((r) => String(r.p).includes('blockedBy'));
  assert.equal(blocked.length, 1, 'the blockedBy edge answers from the graph');
});
