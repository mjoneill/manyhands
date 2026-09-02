/**
 * #1130 item 3 — AN APEX IS A KIND, NOT A CONVENTION.
 *
 * Measured 2026-09-02 on prod: "what is this project?" asked of the graph
 * returned 13 goal-typed roots — a fellowship deadline, a final exam, a known
 * duplicate — and nothing structural singled out the two cards written to
 * answer it. Three apex cards carried three different spellings of the same
 * claim (`apex:manyhands`, `north-star`, `north-star` + `apex`), and the
 * `apex:<label>` form the owner approved on 2026-08-30 was on exactly one.
 *
 * The write side already exists: an apex declares itself with `apex:<label>`
 * (core/apex-labels.mjs). What was missing is the READ side: nothing in the
 * projection let a stranger ask for apexes without knowing a string prefix.
 * So a card carrying `apex:<X>` now projects as `a scrum:Apex` with
 * `scrum:apexLabel "X"`, and the stranger's question is one hop.
 *
 * Materialised at projection time from ONE authority (the card's labels),
 * rebuilt every time — no second copy, so drift stays unrepresentable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphStore, queryGraph, GRAPH_VOCABULARY } from '../core/graph-replica.mjs';
import { domainToJsonLd } from '../core/jsonld.mjs';

const card = (id, shortId, name, labels, extra = {}) => ({
  '@type': 'CreativeWork', '@id': id, identifier: shortId, name, text: '',
  additionalType: 'scrum:goal',
  board: {
    column: 'backlog', order: 0, assignees: [], labels, for: '', priority: null,
    relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [], supersededBy: [] },
    ...extra,
  },
});

const doc = () => domainToJsonLd({
  nodes: [
    card('u-apex', 857, 'north star', ['manyhands', 'apex:manyhands']),
    card('u-sibling', 989, 'second apex', ['apex:orchard']),
    // The three spellings measured on prod that are NOT the approved form.
    card('u-northstar', 1051, 'placeholder apex', ['north-star', 'apex']),
    // A goal-typed root with a project label — the shape that made 13 of 13
    // roots indistinguishable from an apex.
    card('u-root', 305, 'final exam', ['manyhands']),
    card('u-child', 900, 'member', ['manyhands'], { parent: 'u-apex' }),
  ],
  messages: [], people: [],
});

const rows = (store, q) => queryGraph(store, q).rows;

test('#1130 ⭐ a card carrying apex:<X> projects as scrum:Apex — the stranger\'s question is ONE hop', () => {
  const store = buildGraphStore(doc());
  const got = rows(store,
    'SELECT ?id ?title ?label WHERE { ?c a scrum:Apex ; schema:identifier ?id ; schema:name ?title ; scrum:apexLabel ?label } ORDER BY ?id');
  assert.deepEqual(got, [
    { id: '857', title: 'north star', label: 'manyhands' },
    { id: '989', title: 'second apex', label: 'orchard' },
  ]);
});

test('#1130 the unapproved spellings (north-star, bare apex) and goal-typed roots are NOT apexes', () => {
  const store = buildGraphStore(doc());
  const ids = rows(store, 'SELECT ?id WHERE { ?c a scrum:Apex ; schema:identifier ?id }').map((r) => r.id);
  assert.equal(ids.includes('1051'), false, 'north-star + apex is a convention, not the declaration');
  assert.equal(ids.includes('305'), false, 'a goal-typed root is not an apex');
  assert.equal(ids.includes('900'), false, 'a member is not an apex');
});

test('#1130 the apex is still a card — CreativeWork and the label literal both survive', () => {
  const store = buildGraphStore(doc());
  const got = rows(store,
    'SELECT ?id WHERE { ?c a scrum:Apex ; a schema:CreativeWork ; schema:identifier ?id ; scrum:label "apex:manyhands" }');
  assert.deepEqual(got, [{ id: '857' }]);
});

test('#1130 the new terms are declared in the vocabulary, so the drift guard sees them', () => {
  assert.ok(GRAPH_VOCABULARY.has('scrum:Apex'));
  assert.ok(GRAPH_VOCABULARY.has('scrum:apexLabel'));
});
