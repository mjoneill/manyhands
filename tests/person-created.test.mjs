/**
 * #653 — the person graph learns `createdBy`: "who filed this card" becomes
 * answerable through the person surface.
 *
 * #631 shipped createdBy at write time; #619's derivation reads only
 * assignees + conversation authors, so every card filed since is invisible
 * to "what did this seat create" — 100% of new cards, zero backfill (the
 * audit's step-function finding). This adds `creator` as a third source
 * field and a `created` edge list, under the same #628 bounding contract as
 * the other three lists: bounded default, `<list>Total` alongside,
 * `createdBefore` backward cursor, unknown cursor refuses.
 *
 * Honest absence: cards from before #631 carry no creator and appear in
 * nobody's `created` list — absent is honest, backfill would be a guess.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveGraph, personByKey, EDGE_RECENT_LIMIT } from '../core/people.mjs';

const seats = { ada: { name: 'Ada', glyph: '◇', color: '#7cc4a0', aliases: [] } };
const roster = { seats };

function board(n) {
  return {
    cards: Array.from({ length: n }, (_, i) => ({
      id: `c${i + 1}`, shortId: i + 1, title: `Card ${i + 1}`,
      assignees: [], column: 'backlog',
      createdAt: `2026-08-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
      createdBy: i === 0 ? undefined : 'ada', // card 1 predates createdBy — honest absence
    })),
    conversations: [],
  };
}

test('created edges derive from createdBy; pre-#631 cards are honestly absent', () => {
  const person = personByKey(board(4), roster, 'ada');
  assert.deepEqual(person.created, [2, 3, 4], 'cards 2-4 carry creator; card 1 predates the field');
  assert.equal(person.createdTotal, 3);
});

test('created is bounded with the same contract as every other list', () => {
  const n = EDGE_RECENT_LIMIT + 10;
  const person = personByKey(board(n + 1), roster, 'ada'); // +1 for the creatorless first card
  assert.equal(person.created.length, EDGE_RECENT_LIMIT, 'bounded default');
  assert.equal(person.createdTotal, n, 'true total rides alongside');
  assert.equal(person.created.at(-1), n + 1, 'most-recent tail');

  const cursor = person.created[0];
  const page2 = personByKey(board(n + 1), roster, 'ada', { createdBefore: String(cursor) });
  assert.ok(page2.created.every((sid) => sid < cursor), 'createdBefore pages strictly backward');

  assert.throws(
    () => personByKey(board(5), roster, 'ada', { createdBefore: '9999' }),
    (e) => e.code === 'UNKNOWN_CURSOR',
    'unknown cursor refuses, never serves page one',
  );
});

test('an unknown creator mints an unresolved person, same as an unknown author', () => {
  const b = board(2);
  b.cards[1].createdBy = 'stranger';
  const { people } = deriveGraph(b, roster);
  const stranger = people.find((p) => p.key === 'stranger');
  assert.ok(stranger, 'creator alone can bring a person into being (it is authorship, unlike claimedBy)');
  assert.equal(stranger.resolved, false);
  assert.deepEqual(stranger.created, [2]);
});

test('the graph list projection carries created bounded, like its siblings', () => {
  const { people } = deriveGraph(board(EDGE_RECENT_LIMIT + 20), roster);
  const ada = people.find((p) => p.key === 'ada');
  assert.equal(ada.created.length, EDGE_RECENT_LIMIT);
  assert.equal(ada.createdTotal, EDGE_RECENT_LIMIT + 19);
});
