/**
 * #910 — a `reference` card is a DOCUMENT and must never be offered as work.
 *
 * THE ORACLE IS HAND-DERIVED, per this suite's standing convention: each
 * verdict below was written by reading the fixture and reasoning about the
 * rule, not by running the queue and recording what it said.
 *
 * ⛔ AND THE POSITIVE CONTROL IS THE LOAD-BEARING TEST. A rule that excludes
 * EVERYTHING satisfies every exclusion assertion ever written. `t-task` exists
 * so that "documents are excluded" cannot pass by excluding the whole board.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readyFromStore } from '../core/ready-query.mjs';
import { domainToJsonLd } from '../core/jsonld.mjs';
import { boardToDomain } from '../core/mapping.mjs';
import { buildGraphStore } from '../core/graph-replica.mjs';

const card = (shortId, over = {}) => ({
  id: `id-${shortId}`, shortId, title: `card ${shortId}`, description: '',
  type: 'task', column: 'backlog', priority: 'p1', labels: [], assignees: [],
  createdBy: 'ada', createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z', relationships: {}, ...over,
});

const queue = (cards) => readyFromStore(buildGraphStore(domainToJsonLd(boardToDomain({
  cards, columns: [
    { id: 'backlog', name: 'Backlog', order: 0 },
    { id: 'done', name: 'Done', order: 1 },
  ], conversations: [], nextShortId: 99,
}))));

const reasonFor = (q, id) => (q.excluded.find((e) => e.shortId === id) || {}).reason;
const isReady = (q, id) => q.included.some((c) => c.shortId === id);

test('#910 a reference card is EXCLUDED with reason context:reference', () => {
  const q = queue([card(1, { type: 'reference', title: 'ADR-001' })]);
  assert.equal(isReady(q, 1), false, 'a document must never be offered as work');
  assert.equal(reasonFor(q, 1), 'context:reference', 'and the reason must SAY why');
});

test('#910 POSITIVE CONTROL — an identical TASK is still ready', () => {
  // ⛔ Without this, a rule that excluded every card would pass the test above.
  const q = queue([card(1, { type: 'reference' }), card(2, { type: 'task' })]);
  assert.equal(isReady(q, 2), true, 'the queue must still offer real work');
  assert.equal(isReady(q, 1), false);
});

test('#910 a GOAL is NOT excluded — an epic is a legitimate queue member', () => {
  // Excluding goals was proposed and refused: it would drop the North Star and
  // the convergence epic out of the queue. This test is the refusal, made
  // executable so a later "tidy-up" cannot quietly widen the rule.
  const q = queue([card(3, { type: 'goal', title: 'EPIC: converge' })]);
  assert.equal(isReady(q, 3), true, 'a goal remains pullable');
});

test('#910 a DONE reference reports column:done — the more specific fact wins', () => {
  const q = queue([card(4, { type: 'reference', column: 'done' })]);
  assert.equal(reasonFor(q, 4), 'column:done', 'state beats kind');
});

test('#910 a CLAIMED reference reports the holder, not its kind', () => {
  const q = queue([card(5, { type: 'reference', claimedBy: 'bex', claimedAt: '2026-08-02T00:00:00.000Z' })]);
  assert.equal(reasonFor(q, 5), 'claimed-by:bex');
});

test('#910 the OTHER four types all remain pullable', () => {
  const q = queue([
    card(6, { type: 'task' }), card(7, { type: 'bug' }),
    card(8, { type: 'feature' }), card(9, { type: 'idea' }),
  ]);
  assert.deepEqual(q.included.map((c) => c.shortId).sort((a, b) => a - b), [6, 7, 8, 9],
    'only `reference` is a document; the rule must not widen');
});
