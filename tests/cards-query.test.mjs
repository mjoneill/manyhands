/**
 * #657 — slice 1 of projection-first: the card list must answer in bytes an
 * agent can read, and the browser must stop downloading conversations it
 * never renders.
 *
 * The measured basis (#656): GET /api/cards is 2.2MB for 587 cards and 84% of
 * that payload is the `description` field; the question "what's in progress?"
 * is a 15-card answer. Projection carries 98% of the win (2KB vs 125KB), so
 * summary-by-default is the feature — bounds alone would ship 2% of the value
 * and read as "the surface failed."
 *
 * Same spec shape as #628 (people-graph-bounds): bounded by default, totals
 * ride alongside, backward cursor paging, an unknown cursor REFUSES rather
 * than silently serving page one, and the invariant is INVARIANCE — the
 * default payload must not grow with corpus size.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  queryCards,
  CARD_RECENT_LIMIT,
  CARD_LIMIT_CEILING,
  CARD_SUMMARY_OMIT,
} from '../core/cards-query.mjs';

/** A realistic card; shortIds mint monotonically so ascending = chronological. */
function makeCard(shortId, overrides = {}) {
  return {
    id: `uuid-${shortId}`,
    shortId,
    title: `Card ${shortId}`,
    description: `Body of card ${shortId}. `.repeat(50), // ~1.1KB — the 84%
    type: 'task',
    assignees: ['ada'],
    labels: ['api'],
    for: '',
    priority: null,
    column: 'backlog',
    order: 0,
    createdAt: `2026-08-0${(shortId % 9) + 1}T00:00:00.000Z`,
    updatedAt: `2026-08-0${(shortId % 9) + 1}T00:00:00.000Z`,
    createdBy: 'ada',
    relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [] },
    claimedBy: null,
    claimedAt: null,
    ...overrides,
  };
}

function makeCards(n) {
  return Array.from({ length: n }, (_, i) => makeCard(i + 1));
}

// ── projection ──────────────────────────────────────────────────────────────

test('default projection omits description and nothing else', () => {
  const { cards } = queryCards(makeCards(3), {});
  for (const c of cards) {
    assert.equal('description' in c, false, 'summary must not carry description');
    // Everything else survives — the summary is "the card minus its body".
    for (const key of ['id', 'shortId', 'title', 'type', 'assignees', 'labels',
      'column', 'priority', 'createdAt', 'updatedAt', 'createdBy',
      'relationships', 'claimedBy']) {
      assert.equal(key in c, true, `summary must keep ${key}`);
    }
  }
});

test('CARD_SUMMARY_OMIT is exactly the description field', () => {
  // The 84% number is about description alone. If someone later widens the
  // omit list, this test forces the change to be deliberate and re-measured.
  assert.deepEqual(CARD_SUMMARY_OMIT, ['description']);
});

test('fields=all returns complete cards, byte-identical to input', () => {
  const input = makeCards(3);
  const { cards } = queryCards(input, { fields: 'all' });
  assert.deepEqual(cards, input);
});

test('a named field list returns id+shortId plus exactly those fields', () => {
  const { cards } = queryCards(makeCards(2), { fields: 'title,column' });
  for (const c of cards) {
    assert.deepEqual(Object.keys(c).sort(), ['column', 'id', 'shortId', 'title']);
  }
});

test('description is requestable by name — projection hides by default, never forbids', () => {
  const { cards } = queryCards(makeCards(1), { fields: 'title,description' });
  assert.equal(typeof cards[0].description, 'string');
});

test('an unknown field name REFUSES with UNKNOWN_FIELD, never silently drops', () => {
  // A typo like fields=titel that silently returned id+shortId would read as
  // "the card has no title" — a wrong answer delivered fluently (#655).
  assert.throws(
    () => queryCards(makeCards(1), { fields: 'title,titel' }),
    (e) => e.code === 'UNKNOWN_FIELD' && /titel/.test(e.message),
  );
});

// ── bounds ──────────────────────────────────────────────────────────────────

test('default limit returns the CARD_RECENT_LIMIT most-recent by shortId, with the true total', () => {
  const n = CARD_RECENT_LIMIT + 25;
  const result = queryCards(makeCards(n), {});
  assert.equal(result.cards.length, CARD_RECENT_LIMIT);
  assert.equal(result.cardsTotal, n);
  // Most-recent tail: the last card returned is the newest shortId.
  assert.equal(result.cards.at(-1).shortId, n);
  assert.equal(result.cards[0].shortId, n - CARD_RECENT_LIMIT + 1);
});

test('recency is true by construction — storage order is not trusted', () => {
  const shuffled = makeCards(CARD_RECENT_LIMIT + 10).sort(() => 0.5 - 0.5).reverse();
  const result = queryCards(shuffled, {});
  assert.equal(result.cards.at(-1).shortId, CARD_RECENT_LIMIT + 10);
});

test('limit is clamped to the ceiling; a huge ask cannot reopen the firehose', () => {
  const n = CARD_LIMIT_CEILING + 50;
  const result = queryCards(makeCards(n), { limit: '999999' });
  assert.equal(result.cards.length, CARD_LIMIT_CEILING);
  assert.equal(result.cardsTotal, n);
});

test('a non-numeric or hostile limit falls back to the default', () => {
  for (const bad of ['abc', '-5', '0', '1.5', '']) {
    const result = queryCards(makeCards(CARD_RECENT_LIMIT + 5), { limit: bad });
    assert.equal(result.cards.length, CARD_RECENT_LIMIT, `limit=${JSON.stringify(bad)}`);
  }
});

test('before pages backward: the window strictly older than the cursor', () => {
  const cards = makeCards(30);
  const page1 = queryCards(cards, { limit: '10' });
  const cursor = String(page1.cards[0].shortId); // oldest of page 1
  const page2 = queryCards(cards, { limit: '10', before: cursor });
  assert.equal(page2.cards.length, 10);
  assert.equal(page2.cards.at(-1).shortId, Number(cursor) - 1);
  // No overlap, no gap.
  const seen = new Set([...page1.cards, ...page2.cards].map((c) => c.shortId));
  assert.equal(seen.size, 20);
});

test('an unknown before cursor REFUSES with UNKNOWN_CURSOR, never serves page one', () => {
  assert.throws(
    () => queryCards(makeCards(5), { before: '9999' }),
    (e) => e.code === 'UNKNOWN_CURSOR',
  );
});

// ── the invariant: payload does not grow with corpus size ──────────────────

test('default payload is invariant to corpus growth', () => {
  const small = JSON.stringify(queryCards(makeCards(CARD_RECENT_LIMIT + 10), {}));
  const large = JSON.stringify(queryCards(makeCards(CARD_RECENT_LIMIT * 40), {}));
  // Totals differ by a few digits; the page itself must not scale. 10% slack
  // covers the digits, not another card.
  assert.ok(
    large.length < small.length * 1.1,
    `default page grew with the corpus: ${small.length} → ${large.length} bytes`,
  );
});

test('the default page of a 600-card board with 1KB bodies stays under 100KB', () => {
  // The acceptance number on #657: today's real board (587 cards, 2.2MB full)
  // must come back readable. Fixture matches that scale.
  const bytes = JSON.stringify(queryCards(makeCards(600), {})).length;
  assert.ok(bytes < 100_000, `default page is ${bytes} bytes`);
});
