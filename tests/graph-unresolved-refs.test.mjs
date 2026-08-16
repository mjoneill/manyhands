/**
 * #818 — a relationship target that names no card must be REPRESENTED in the
 * graph, not skipped.
 *
 * THE DEFECT, measured on the live board 2026-08-16 22:15Z:
 *   board-data.json  #334 relatedTo = ['4aadabdc-…', 759, '9f641b3a-…']
 *                                       str          INT   str
 *   graph_query      #334 relatedTo → 761, 758.      #759 ABSENT.
 *   board-wide       1,545 string members → edges · 7 NUMERIC members → DROPPED
 *                    carriers 334 335 346 604 624 646 758 · dead targets 759, 648
 *
 * TWO CORRECT DECISIONS WHOSE COMPOSITION LOSES DATA:
 *   jsonld.mjs      "a shortId naming no card rides VERBATIM — losslessness
 *                    beats tidiness on dangling data" ⇒ it stays a NUMBER
 *   graph-replica   `if (typeof r === 'string')` ⇒ numbers silently skipped
 *
 * ⚠️ WHY THIS IS WORSE THAN A TIDINESS BUG
 *   `cardEdgesResolved` was deliberately built with an OPTIONAL join so a
 *   dangling edge surfaces with an unbound target instead of vanishing — "a
 *   resolved row proves edge+target; an unbound row IS the finding." That
 *   protection NEVER FIRES, because the edge is gone before the query runs.
 *   And #530 Phase 1 specs "every unresolved internal reference, as a
 *   first-class review queue" — which would return zero forever and look
 *   correct.
 *
 * ⛔ VERIFICATION WARNING FOR ANYONE TOUCHING THIS
 *   Do NOT verify from /api/board. That view normalises every relationship
 *   member to a shortId, so the mixed representation that causes the drop is
 *   invisible from it — a seat checked there and declared the defect "cleaned
 *   since." It is not. Read board-data.json's @graph and the replica, and
 *   compare them.
 *
 * THE SHAPE #530 ALREADY SPECS: scrum:UnresolvedReference — "never drop or
 * confidently invent the target." Represented, typed, carrying the identifier
 * that was written, so the edge is queryable and the breakage is visible.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { domainToJsonLd } from '../core/jsonld.mjs';
import { buildGraphStore, queryGraph, SPARQL_PREFIXES } from '../core/graph-replica.mjs';

/** Stored-node shape: relationship arrays at TOP LEVEL holding entity-id strings — or, for a target that names no card, the raw shortId NUMBER. */
const domain = () => ({
  nodes: [
    {
      '@id': 'c334', '@type': 'CreativeWork', identifier: 334, name: 'the carrier', board: {},
      relatedTo: ['c761', 759, 'c758'],   // ⇐ 759 names no card: the live shape
    },
    { '@id': 'c761', '@type': 'CreativeWork', identifier: 761, name: 'resolves', board: {} },
    { '@id': 'c758', '@type': 'CreativeWork', identifier: 758, name: 'also resolves', board: {} },
  ],
  messages: [], people: [], columns: [],
});

const storeFor = (d = domain()) => buildGraphStore(domainToJsonLd(d));
const ask = (store, q) => queryGraph(store, `${SPARQL_PREFIXES}\n${q}`).rows;

test('#818 the dangling member is PRESENT as an edge, not skipped', () => {
  const rows = ask(storeFor(),
    `SELECT ?o WHERE { ?c a schema:CreativeWork ; schema:identifier "334" ; scrum:relatedTo ?o }`);
  assert.equal(rows.length, 3,
    'the card stores THREE relatedTo members; the graph must carry three edges, not two');
});

test('#818 the unresolved target is TYPED and carries the identifier that was written', () => {
  const rows = ask(storeFor(),
    `SELECT ?o ?id WHERE { ?c schema:identifier "334" ; scrum:relatedTo ?o . ` +
    `?o a scrum:UnresolvedReference ; schema:identifier ?id }`);
  assert.equal(rows.length, 1, 'exactly one unresolved reference on this card');
  assert.equal(rows[0].id, '759',
    'it names 759 — the reference is preserved, never invented and never dropped');
});

test('#818 the unresolved node lives in its OWN namespace, never entity:', () => {
  // ⚠️ ADDED BECAUSE A MUTANT SURVIVED. Minting the node as entity:759 passed
  // every other test here: it is still typed UnresolvedReference and still
  // carries the identifier. But the NAMESPACE IS ITSELF A CLAIM — entity:759
  // asserts "this is a board entity", which is precisely what it is not. The
  // document held a shortId that names no card; minting an entity IRI for it
  // invents the target #530 forbids inventing.
  const rows = ask(storeFor(),
    `SELECT ?o WHERE { ?c schema:identifier "334" ; scrum:relatedTo ?o . ?o a scrum:UnresolvedReference }`);
  assert.equal(rows.length, 1);
  assert.match(rows[0].o, /^unresolved:/,
    `expected the unresolved: namespace, got ${rows[0].o} — an entity: IRI would claim this is a board entity`);
});

test('#818 an unresolved reference is NOT a card — it must not pollute card queries', () => {
  const store = storeFor();
  const cards = ask(store, `SELECT ?c WHERE { ?c a schema:CreativeWork }`);
  assert.equal(cards.length, 3, 'three real cards; the unresolved reference is not a fourth');

  // And it must not surface as a phantom in a name query either.
  const named = ask(store, `SELECT ?n WHERE { ?c a schema:CreativeWork ; schema:name ?n }`);
  assert.deepEqual(named.map((r) => r.n).sort(), ['also resolves', 'resolves', 'the carrier']);
});

test('#818 THE REVIEW QUEUE #530 SPECS: every unresolved reference, board-wide, in one query', () => {
  const rows = ask(storeFor(),
    `SELECT ?src ?id WHERE { ?c a schema:CreativeWork ; schema:identifier ?src ; ` +
    `?p ?o . ?o a scrum:UnresolvedReference ; schema:identifier ?id }`);
  assert.deepEqual(rows, [{ src: '334', id: '759' }],
    'the referential-integrity queue returns rows instead of zero-forever');
});

test('#818 resolved members are unchanged — the fix adds, it does not rewrite', () => {
  const rows = ask(storeFor(),
    `SELECT ?tid WHERE { ?c schema:identifier "334" ; scrum:relatedTo ?o . ?o schema:identifier ?tid . ` +
    `FILTER NOT EXISTS { ?o a scrum:UnresolvedReference } }`);
  assert.deepEqual(rows.map((r) => r.tid).sort(), ['758', '761']);
});

test('#818 a board with no dangling members mints NO unresolved nodes', () => {
  const clean = domain();
  clean.nodes[0].relatedTo = ['c761', 'c758'];
  const rows = ask(storeFor(clean), `SELECT ?o WHERE { ?o a scrum:UnresolvedReference }`);
  assert.deepEqual(rows, [], 'nothing is minted for a healthy board — no phantom population');
});

test('#818 the same dangling shortId from two cards is ONE node, referenced twice', () => {
  const two = domain();
  two.nodes.push({
    '@id': 'c335', '@type': 'CreativeWork', identifier: 335, name: 'second carrier', board: {},
    relatedTo: [759],
  });
  const store = storeFor(two);
  const nodes = ask(store, `SELECT ?o WHERE { ?o a scrum:UnresolvedReference }`);
  assert.equal(nodes.length, 1, 'identity is the reference itself, not the referrer');
  const edges = ask(store,
    `SELECT ?src WHERE { ?c schema:identifier ?src ; scrum:relatedTo ?o . ?o a scrum:UnresolvedReference }`);
  assert.deepEqual(edges.map((r) => r.src).sort(), ['334', '335']);
});

test('#818 every relationship type carries dangling members, not just relatedTo', () => {
  const d = domain();
  d.nodes[0].blockedBy = [648];
  d.nodes[0].derivedFrom = [648];
  const rows = ask(storeFor(d),
    `SELECT ?p WHERE { ?c schema:identifier "334" ; ?p ?o . ?o a scrum:UnresolvedReference }`);
  const preds = rows.map((r) => r.p).sort();
  assert.ok(preds.includes('scrum:blockedBy') && preds.includes('scrum:derivedFrom'),
    'the projector loops REL_TYPES; the fix must apply to all of them, not the one that was measured');
});
