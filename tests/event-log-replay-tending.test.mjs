/**
 * #805 blocker 6 — event-log replay must carry TENDING, and must carry it
 * through the same door as every other family.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────
 *
 * `replay()` projects events through a positive map:
 *
 *     const COLLECTION = { card: 'cards', conversation: 'conversations',
 *                          column: 'columns' };
 *     const key = COLLECTION[ev.entity?.kind];
 *     if (!key) continue;                 // ⇐ everything else DROPS, silently
 *
 * The boot migration appends kind:'tending' events; replay drops every one.
 * "The log is the authority; the store is a rebuildable projection" is the
 * file's own first sentence — for tending, the rebuild silently loses the
 * family, so the authority claim is false exactly where #805 relies on it.
 *
 * Ruling at review (#805, commons 7b924101, 2026-08-15): fix at collection/replay, NO tending-specific
 * bypass. Acceptance: rebuild an empty board solely from the event log,
 * retrieve the exact tending entities through the graph query surface, prove
 * no duplicates, keep existing families unchanged.
 *
 * ── THE SECOND DEFECT THESE CONTROLS PIN ───────────────────────────────────
 *
 * Replay's upsert matches `x?.id === ev.entity.id`. Tending entities are
 * JSON-LD nodes whose identity field is `@id`, not `id` — so even with the
 * family mapped, a re-emitted create (the bootstrap's idempotent re-run)
 * would never MATCH the existing row and would append a duplicate. The
 * no-duplicates control below fails under exactly that implementation, which
 * is what makes it a discrimination rather than a ceremony.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { replay } from '../core/event-log.mjs';
import { domainToJsonLd } from '../core/jsonld.mjs';
import {
  buildGraphStore, queryGraph, SPARQL_PREFIXES,
} from '../core/graph-replica.mjs';

// Event shape mirrors appendEvent's stored fields: { op, entity:{kind,id}, state }.
const TENDING_IRI = 'https://scrumboard.local/tending/prompt/p-test/v1';
const promptVersionNode = (body = 'hello from the log') => ({
  '@id': TENDING_IRI,
  '@type': 'scrum:TendingPromptVersion',
  'scrum:body': body,
  author: 'ada',  // bare seat — the projector mints the person: edge
  'scrum:version': 1,
});
const tendingCreate = (state = promptVersionNode()) => ({
  op: 'create',
  entity: { kind: 'tending', id: state['@id'] },
  state,
});

const EMPTY_GENESIS = { cards: [], conversations: [], columns: [] };

// ── ⭐ THE FAMILY IS CARRIED AT ALL ─────────────────────────────────────────

test('⛔ a tending create event survives replay instead of dropping silently', () => {
  // DEFECT: COLLECTION has no entry for kind:'tending', so `if (!key) continue`
  // discards the event. The rebuilt board has no tending key, no error, no log —
  // the same fail-silent shape as the jsonld phantom-card fallthrough, one
  // layer down.
  const board = replay(EMPTY_GENESIS, [tendingCreate()]);
  assert.ok(Array.isArray(board.tending), 'the rebuilt board has a tending collection');
  assert.equal(board.tending.length, 1, 'and the event landed in it');
  assert.equal(board.tending[0]['@id'], TENDING_IRI);
});

// ── ⭐⭐ THE ACCEPTANCE: log → replay → graph, one path, exact entities ──────

test('⭐⭐ an empty board rebuilt SOLELY from the log answers tending queries via the graph', () => {
  // The full promised path: nothing pre-seeded, events only, then the real
  // query surface. If replay drops the family, this store is empty and the
  // SELECT returns zero rows — the acceptance is the discrimination.
  const events = [
    tendingCreate(),
    tendingCreate({
      '@id': 'https://scrumboard.local/tending/prompt/p-second/v1',
      '@type': 'scrum:TendingPromptVersion',
      'scrum:body': 'second body',
      author: 'bo',
      'scrum:version': 1,
    }),
  ];
  const board = replay(EMPTY_GENESIS, events);
  const store = buildGraphStore(domainToJsonLd({
    nodes: [], messages: [], people: [], columns: [], ...board,
    tending: board.tending,
  }));
  const { rows } = queryGraph(store, `${SPARQL_PREFIXES}
    SELECT ?body ?author WHERE {
      ?pv a scrum:TendingPromptVersion ; scrum:body ?body ; schema:author ?author .
    } ORDER BY ?body`);
  assert.equal(rows.length, 2, 'both prompt versions are visible to graph_query');
  assert.deepEqual(rows.map((r) => r.body), ['hello from the log', 'second body']);
  assert.deepEqual(rows.map((r) => r.author), ['person:ada', 'person:bo'],
    'authorship survives log → replay → projection as a person edge, not a literal');
});

// ── ⭐⭐ NO DUPLICATES — the @id/id mismatch is the trap, not the map ────────

test('⭐⭐ a re-emitted create UPSERTS by @id — idempotent re-boot appends no duplicate', () => {
  // DEFECT this discriminates: an upsert that matches on `x.id` alone never
  // finds a JSON-LD node (identity lives at `@id`), so the second create
  // APPENDS. board.tending.length === 2 is the wrong answer this control
  // exists to make impossible; updated body proves the second write WON
  // rather than being skipped — "no duplicate" via skip would be a second
  // fail-silent path wearing the assertion as a costume.
  const board = replay(EMPTY_GENESIS, [
    tendingCreate(promptVersionNode('first write')),
    tendingCreate(promptVersionNode('second write, same @id')),
  ]);
  assert.equal(board.tending.length, 1, 'same @id twice ⇒ ONE row');
  assert.equal(board.tending[0]['scrum:body'], 'second write, same @id',
    'and the later state won — upsert, not skip');
});

test('a tending delete removes by @id', () => {
  const board = replay(EMPTY_GENESIS, [
    tendingCreate(),
    { op: 'delete', entity: { kind: 'tending', id: TENDING_IRI }, state: null },
  ]);
  assert.equal((board.tending ?? []).length, 0, 'deleted from the projection');
});

// ── EXISTING FAMILIES UNCHANGED — the door widened, nothing else moved ─────

test('cards, conversations and columns replay exactly as before', () => {
  const board = replay(EMPTY_GENESIS, [
    { op: 'create', entity: { kind: 'card', id: 'c1' }, state: { id: 'c1', title: 'a card' } },
    { op: 'create', entity: { kind: 'card', id: 'c1' }, state: { id: 'c1', title: 'renamed' } },
    { op: 'create', entity: { kind: 'column', id: 'k1' }, state: { id: 'k1', name: 'Backlog' } },
  ]);
  assert.equal(board.cards.length, 1, 'card upsert by id still works');
  assert.equal(board.cards[0].title, 'renamed');
  assert.equal(board.columns.length, 1);
});

test('an unmapped kind still skips — wiki stays out of the board, deliberately', () => {
  // The wiki skip predates this fix and is DECLARED, not accidental. This
  // control pins that widening the door for tending did not quietly turn
  // "skip what we chose to skip" into "project everything".
  const board = replay(EMPTY_GENESIS, [
    { op: 'create', entity: { kind: 'wiki', id: 'w1' }, state: { id: 'w1', body: 'page' } },
  ]);
  assert.equal('wiki' in board, false, 'no wiki collection appears');
  assert.equal('wikis' in board, false);
});
