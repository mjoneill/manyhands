/**
 * #1043 — two blockers naming the SAME subject on one card collapsed into ONE
 * graph node carrying BOTH statuses.
 *
 * ⛔ MEASURED ON A LIVE CARD holding a `cleared` publication approval and a new
 * `open` deploy-window block, both naming the same person:
 *
 *     entity:<card>/blocker/person:ada   scrum:status "open"     ⌉ BOTH on
 *     entity:<card>/blocker/person:ada   scrum:status "cleared"  ⌋ ONE node
 *
 * ⇒ A query for status "open" MATCHED THE CLEARED APPROVAL. A query for
 *   "cleared" matched the OPEN block. Both directions wrong, neither errored,
 *   and the PATCH that produced it returned 200. The symptom that exposed it was
 *   an audit of one person's open blockers returning a card twice — once for a
 *   block cleared four days earlier.
 *
 * ⭐ THE FIX WAS ALREADY IN THIS FILE, ONE FIELD FAMILY OVER. `acceptance` has
 * the same multiplicity and solved it by INDEX (`<card>/rc/0`, `/rc/1`).
 * Blockers are now keyed the same way: N entries are N nodes, whatever they name.
 *
 * ⚠️ The `<card>/blocker/` PREFIX is preserved deliberately — `sweepBlockerNodes`
 * matches on it, and a derived node the sweep cannot reach is the production
 * orphan this projection has already paid for twice.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainToJsonLd } from '../core/jsonld.mjs';
import { buildGraphStore, queryGraph, removeEntity } from '../core/graph-replica.mjs';

const card = (id, sid, name, board = {}) => ({
  '@id': id, '@type': 'CreativeWork', identifier: sid, name, board: { column: 'backlog', ...board },
});

/** Two entries naming the SAME person, opposite statuses — the exact live shape. */
const samePerson = () => ({
  nodes: [card('c1', 1, 'holds two blockers for one person', {
    blockers: [
      { person: 'ada', status: 'cleared', note: 'approved four days ago' },
      { person: 'ada', status: 'open', note: 'a new, different question' },
    ],
  })],
  messages: [], people: [], columns: [],
});

const storeOf = (d) => buildGraphStore(domainToJsonLd(d));
const rows = (s, q) => queryGraph(s, q).rows;

test('#1043 two blockers naming ONE person are TWO nodes with independent statuses', () => {
  const s = storeOf(samePerson());
  const nodes = rows(s, 'SELECT DISTINCT ?b WHERE { ?b a scrum:Blocker }');
  assert.equal(nodes.length, 2,
    `two entries must project as two nodes, got ${nodes.length} — one node carrying both `
    + 'statuses is the defect, and it answers every status query wrongly in both directions');

  const statuses = rows(s, 'SELECT ?b ?st WHERE { ?b a scrum:Blocker ; scrum:status ?st }');
  const byNode = new Map();
  for (const r of statuses) byNode.set(r.b, [...(byNode.get(r.b) || []), r.st]);
  for (const [node, sts] of byNode) {
    assert.equal(sts.length, 1, `${node} carries ${sts.length} statuses (${sts}) — a node with two is the collision`);
  }
});

test('#1043 ⛔ NEGATIVE CONTROL — BOTH directions, because the defect is symmetric', () => {
  // ⚠️ Testing one direction hides the other: with a collapsed node, "open"
  // matches the cleared entry AND "cleared" matches the open one. A suite that
  // only asked "is the open one found?" would have passed against the defect.
  const s = storeOf(samePerson());

  const open = rows(s, 'SELECT ?note WHERE { ?b a scrum:Blocker ; scrum:status "open" ; scrum:note ?note }');
  assert.equal(open.length, 1, `exactly one OPEN blocker, got ${open.length}`);
  assert.match(open[0].note, /different question/,
    `the OPEN query must return the OPEN note, not the cleared one. Got: ${open[0].note}`);

  const cleared = rows(s, 'SELECT ?note WHERE { ?b a scrum:Blocker ; scrum:status "cleared" ; scrum:note ?note }');
  assert.equal(cleared.length, 1, `exactly one CLEARED blocker, got ${cleared.length}`);
  assert.match(cleared[0].note, /approved four days ago/,
    `the CLEARED query must return the CLEARED note. Got: ${cleared[0].note}`);
});

test('#1043 ⭐ ALL THREE BLOCKER KINDS — not only the person-keyed one that bit us', () => {
  // The person kind is the one with a live instance. The card and any-human
  // kinds were keyed by identity too, so they had the same collision waiting;
  // fixing only the observed one would leave two loaded guns.
  const d = {
    nodes: [
      card('t1', 10, 'target one'), card('t2', 20, 'target two'),
      card('multi', 30, 'one of each, twice over', {
        relationships: { blockedBy: [10, 20] },
        blockers: [
          { card: 10, status: 'open', note: 'card blocker A' },
          { card: 20, status: 'cleared', note: 'card blocker B' },
          { anyHuman: true, status: 'open', note: 'any human A' },
          { anyHuman: true, status: 'cleared', note: 'any human B' },
        ],
      }),
    ], messages: [], people: [], columns: [],
  };
  const s = storeOf(d);
  const n = rows(s, 'SELECT DISTINCT ?b WHERE { ?b a scrum:Blocker }');
  assert.equal(n.length, 4,
    `four entries must be four nodes, got ${n.length} — under identity keying the two `
    + 'any-human entries collapsed into one and each card kind was one-per-target');
});

test('#1043 ⛔ NEGATIVE CONTROL — the new IRI scheme is still REACHABLE BY THE SWEEP', () => {
  // ⚠️ THE CONDITION MOST LIKELY TO BE SKIPPED, and the one with a production
  // scar behind it: Blocker subjects are DERIVED, so subject-scoped deletion
  // cannot reach them, and sweepBlockerNodes finds them by the `<card>/blocker/`
  // PREFIX. Changing the suffix is safe; changing the prefix would silently
  // orphan every blocker node on every delete — carrying an owner and a status
  // and pointing at nothing.
  const s = storeOf(samePerson());
  assert.equal(rows(s, 'SELECT DISTINCT ?b WHERE { ?b a scrum:Blocker }').length, 2,
    'precondition: the nodes exist before the sweep, or this test proves nothing');

  removeEntity(s, 'c1');

  assert.equal(rows(s, 'SELECT DISTINCT ?b WHERE { ?b a scrum:Blocker }').length, 0,
    'deleting the card must remove BOTH derived blocker nodes — an unreachable derived '
    + 'node is the orphan this projection has already paid for twice');
});
