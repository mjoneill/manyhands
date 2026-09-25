/**
 * #1483 — a POST that names a card becomes a queryable edge, derived exactly the
 * way #656 derives card→card references, on a SIBLING predicate.
 *
 * Measured 2026-09-25: 17,438 of 30,525 posts name at least one real card, and
 * none of those mentions was an edge. #656 already derived `scrum:mentionsCard`
 * from card text; posts were simply never passed through it.
 *
 * ⛔ WHY NOT REUSE `scrum:mentionsCard` (decided on #1483 by its reader): the
 * documented closure walks that predicate in BOTH directions from an apex. On it,
 * every post naming two cards would become a bridge between them, and every
 * existing closure and isolation query would return a different number without
 * erroring. The sibling keeps those queries meaning what they meant; a consumer
 * who wants both corpora asks `scrum:mentionsCard|scrum:postMentionsCard`.
 *
 * ⛔ This file QUERIES. It never inspects the document (the #656 lesson: an edge
 * can be serialized, tested, and in no query).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphStore, queryGraph, syncGraphStore } from '../core/graph-replica.mjs';
import { domainToJsonLd, jsonLdToDomain } from '../core/jsonld.mjs';

const P = 'PREFIX scrum: <https://scrumboard.local/ns#>\nPREFIX schema: <https://schema.org/>\n'
  + 'PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>\n';
const E = 'https://scrumboard.local/entity/';

const card = (id, shortId, name, text) => ({
  '@type': 'CreativeWork', '@id': id, identifier: shortId, name, text,
  additionalType: 'scrum:task', board: { column: 'backlog', relationships: { relatedTo: [] } },
});
const post = (id, text) => ({
  '@type': 'Comment', '@id': id, author: 'ada', dateCreated: '2026-09-25T10:00:00.000Z', text,
});

// NUMERIC shortIds, as the live board stores them (#656's string-fixture trap).
const CARDS = [
  card('u-a', 1, 'alpha', 'mentions nobody'),
  card('u-b', 2, 'beta', 'mentions nobody'),
  card('u-c', 3, 'gamma', 'mentions nobody'),
];
const MESSAGES = [
  post('m-1', 'this is about #1 and #2, and #1 again'),
  post('m-2', 'no references at all'),
  post('m-3', 'names #99, which is no card'),
];
const doc = (nodes = CARDS, messages = MESSAGES) =>
  domainToJsonLd({ nodes, messages, people: [], columns: [] });
const rows = async (store, q) => { const r = await queryGraph(store, P + q); return r.rows ?? r; };

test('#1483 a post that names a card is REACHABLE BY QUERY', async () => {
  const store = await buildGraphStore(doc());
  const r = await rows(store, `SELECT ?c WHERE { <${E}m-1> scrum:postMentionsCard ?c } ORDER BY ?c`);
  assert.deepEqual(r.map((x) => String(x.c).replace(/^.*[/:]/, '')), ['u-a', 'u-b'],
    `#1 and #2, each once (mentions, not mention-counts). got ${JSON.stringify(r)}`);
});

test('#1483 the backlink question a person asks: which posts mention #2?', async () => {
  const store = await buildGraphStore(doc());
  const r = await rows(store, `SELECT ?p WHERE { ?p scrum:postMentionsCard <${E}u-b> }`);
  assert.equal(r.length, 1, JSON.stringify(r));
  assert.ok(String(r[0].p).endsWith('m-1'));
});

test('#1483 CONTROL: a post with no reference contributes no edge', async () => {
  // Passes against a replica that emits nothing; FAILS against one that links every post.
  const store = await buildGraphStore(doc());
  const r = await rows(store, `SELECT ?c WHERE { <${E}m-2> scrum:postMentionsCard ?c }`);
  assert.equal(r.length, 0, `m-2 names no card. got ${JSON.stringify(r)}`);
});

test('#1483 CONTROL: a #NNN naming no card is dropped, not linked to a phantom', async () => {
  const store = await buildGraphStore(doc());
  const r = await rows(store, `SELECT ?c WHERE { <${E}m-3> scrum:postMentionsCard ?c }`);
  assert.equal(r.length, 0, `#99 is no card; a dangling pointer is not a connection. got ${JSON.stringify(r)}`);
});

test('#1483 the whole population: exactly the two edges from m-1 exist', async () => {
  const store = await buildGraphStore(doc());
  const r = await rows(store, `SELECT ?p ?c WHERE { ?p scrum:postMentionsCard ?c }`);
  assert.equal(r.length, 2, JSON.stringify(r));
  assert.ok(r.every((x) => String(x.p).endsWith('m-1')));
});

test('#1483 ⛔ posts never ride scrum:mentionsCard: the card↔card traversal contract is untouched', async () => {
  const withRef = doc([card('u-a', 1, 'alpha', 'see #2'), CARDS[1], CARDS[2]]);
  const store = await buildGraphStore(withRef);
  // Positive control: the machinery DOES find mentionsCard where a card emits it.
  const cc = await rows(store, `SELECT ?a WHERE { ?a scrum:mentionsCard ?b }`);
  assert.equal(cc.length, 1, `control: the card→card edge must be found. got ${JSON.stringify(cc)}`);
  const leak = await rows(store, `SELECT ?p WHERE { ?p a schema:Comment ; scrum:mentionsCard ?c }`);
  assert.equal(leak.length, 0, `a post on the card predicate makes every post a bridge. got ${JSON.stringify(leak)}`);
});

test('#1483 the documented closure from an apex returns the SAME cards with and without posts', async () => {
  const nodes = [card('u-a', 1, 'alpha', 'see #2'), CARDS[1], CARDS[2]];
  const closure = `SELECT DISTINCT ?c WHERE { ?a schema:identifier ?id . FILTER(STR(?id) = "1")
    ?c a schema:CreativeWork ; (scrum:relatedTo|^scrum:relatedTo|scrum:mentionsCard|^scrum:mentionsCard)* ?a } ORDER BY ?c`;
  const without = await rows(await buildGraphStore(doc(nodes, [])), closure);
  // m-9 names #1 AND #3: on the card predicate it would bridge #3 into #1's component.
  const withPosts = await rows(await buildGraphStore(doc(nodes, [post('m-9', 'about #1 and #3')])), closure);
  assert.ok(without.length >= 1, `control: the closure must find the apex itself. got ${JSON.stringify(without)}`);
  assert.deepEqual(withPosts, without, 'a post naming two cards must not join them in an existing closure');
});

test('#1483 subPropertyOf is DECLARED, and PINNED inert: with it present, no inference widens mentionsCard', async () => {
  const store = await buildGraphStore(doc());
  const declared = await rows(store, `SELECT ?x WHERE { scrum:postMentionsCard rdfs:subPropertyOf ?x }`);
  assert.equal(declared.length, 1, `the kinship is in the graph, not only in prose. got ${JSON.stringify(declared)}`);
  assert.match(String(declared[0].x), /(#|scrum:)mentionsCard$/);
  // ⛔ The day someone turns on RDFS inference, this goes red and the union is
  // chosen out loud instead of discovered in every closure query.
  const widened = await rows(store, `SELECT ?p WHERE { ?p a schema:Comment ; scrum:mentionsCard ?c }`);
  assert.equal(widened.length, 0, `inference is ON: subPropertyOf now pulls posts into mentionsCard. got ${JSON.stringify(widened)}`);
});

test('#1483 the derived edge is NOT stored back: the document round-trips to the same messages', () => {
  const back = jsonLdToDomain(doc());
  assert.deepEqual(back.messages, MESSAGES, 'a derived fact written back would outlive the text that produced it');
});

test('#1483 #714 parity: creating the cited card ADDS the edge to an untouched post on sync', async () => {
  const before = doc([CARDS[0], CARDS[2]], [post('m-4', 'forward reference to #2')]);
  const after = doc(CARDS, [post('m-4', 'forward reference to #2')]);
  const store = await buildGraphStore(before);
  const { hashes } = syncGraphStore(store, before, null);
  const q = `SELECT ?c WHERE { <${E}m-4> scrum:postMentionsCard ?c }`;
  assert.equal((await rows(store, q)).length, 0, 'setup: #2 does not exist yet');
  syncGraphStore(store, after, hashes);
  const synced = (await rows(store, q)).length;
  const rebuilt = (await rows(await buildGraphStore(after), q)).length;
  assert.equal(rebuilt, 1, 'a rebuild resolves the forward reference');
  assert.equal(synced, rebuilt, `the post was not edited; only #2 appeared. synced ${synced}, rebuilt ${rebuilt}`);
});

test('#1483 an empty board projects NO kinship triple, and the first post edge brings it, on SYNC as well as rebuild', async () => {
  const empty = doc(CARDS, [post('m-5', 'no references')]);
  const store = await buildGraphStore(empty);
  const kin = `SELECT ?x WHERE { scrum:postMentionsCard rdfs:subPropertyOf ?x }`;
  assert.equal((await rows(store, kin)).length, 0, 'no post edge, no vocabulary triple: an empty graph stays empty');
  const { hashes } = syncGraphStore(store, empty, null);
  syncGraphStore(store, doc(CARDS, [post('m-5', 'now it names #3')]), hashes);
  assert.equal((await rows(store, kin)).length, 1, 'the declaration must arrive with the first edge on the path the server actually runs');
});
