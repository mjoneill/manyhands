/**
 * #280 — the dup warning at create: "a similar-titled card exists".
 *
 * The incident: two seats carded the same thing one minute apart, each blind
 * to the other, then reconciled in opposite directions and briefly deleted
 * both. The card lists this as the thinnest mitigation — cheap, catches the
 * blind-dup half — and it sat unbuilt from June while the room measured
 * retrieval instead.
 *
 * ⚠️ WHAT THIS IS AND IS NOT, pinned here rather than described:
 *   - a WARNING on the 201, never a refusal. The card is created regardless.
 *     A gate that blocks on a lexical guess would refuse legitimate siblings
 *     and train the bypass.
 *   - TITLE-only, token overlap. Not the body, not embeddings, not the graph.
 *     A rule you hold in different words scores zero, and that is the exact
 *     failure it cannot detect. It catches the #277/#278 case — same words,
 *     same minute — which is the case that actually happened.
 *   - DERIVED, response-layer only. Nothing is stored on the card; the
 *     domain round-trip stays lossless.
 *   - present only when NON-EMPTY, like `ignoredFields`: a `[]` on every
 *     response is noise a caller learns to skip.
 *   - a LIST, not an alarm. Measured on the live board before shipping (see
 *     the module header): the only setting that catches the same-words case
 *     also fires on ~all creates, so the honest shape is "the five nearest
 *     titles", ranked, for the filer to glance at.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { similarCards, titleTokens } from '../core/similar-cards.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const card = (shortId, title, extra = {}) => ({ id: `id-${shortId}`, shortId, title, column: 'backlog', ...extra });

// ── the pure half ──────────────────────────────────────────────────────────

test('#280 titleTokens drops stop words, short tokens and punctuation', () => {
  assert.deepEqual(
    [...titleTokens('The OpenAI Model Designer — apply for it!')].sort(),
    ['apply', 'designer', 'model', 'openai'].sort(),   // 'apply' is 5 chars and distinctive; it stays
  );
});

test('#280 a near-identical title is found, ranked first, with its score', () => {
  const cards = [
    card(277, 'OpenAI Model Designer role — worth applying'),
    card(10, 'Fix the deploy script health check'),
    card(11, 'Model the room, not just the work'),
  ];
  const out = similarCards(cards, 'OpenAI Model Designer — apply?');
  assert.equal(out[0].shortId, 277);
  assert.equal(out[0].title, 'OpenAI Model Designer role — worth applying');
  assert.ok(out[0].score >= 0.6, `score ${out[0].score}`);
  // #11 shares only "model" — one token of four is below the bar (SIMILAR_MIN_SHARED = 2).
  assert.ok(!out.some((c) => c.shortId === 11), 'a single shared token is not similarity');
});

test('#280 no shared distinctive tokens ⇒ empty, not a weak match', () => {
  const cards = [card(1, 'Fix the deploy script health check')];
  assert.deepEqual(similarCards(cards, 'Write the retro document'), []);
});

test('#280 stop-word-only overlap is not similarity', () => {
  const cards = [card(1, 'What is the thing we are building')];
  assert.deepEqual(similarCards(cards, 'Why is the room the way it is'), []);
});

test('#280 a title with no usable tokens returns empty rather than matching everything', () => {
  const cards = [card(1, 'anything at all'), card(2, 'and another')];
  assert.deepEqual(similarCards(cards, 'the of and'), []);
  assert.deepEqual(similarCards(cards, ''), []);
});

test('#280 excludes a card by id (the one just created) and caps at limit', () => {
  const cards = [];
  for (let i = 1; i <= 8; i++) cards.push(card(i, `dup warning at create slice ${i}`));
  const out = similarCards(cards, 'dup warning at create', { excludeId: 'id-3', limit: 5 });
  assert.equal(out.length, 5);
  assert.ok(!out.some((c) => c.id === 'id-3'));
});

test('#280 result rows are bounded: shortId, id, title, column, score — never the body', () => {
  const cards = [card(1, 'dup warning at create', { description: 'x'.repeat(10000), labels: ['a'] })];
  const [row] = similarCards(cards, 'dup warning at create');
  assert.deepEqual(Object.keys(row).sort(), ['column', 'id', 'score', 'shortId', 'title']);
});

// ── the wired half: REST create ────────────────────────────────────────────

function apiTest(name, fn) {
  test(name, async () => {
    const server = await startRestServer({
      board: makeBoardFixture({
        cards: [
          { id: 'c-277', shortId: 277, title: 'OpenAI Model Designer role — worth applying',
            column: 'backlog', type: 'idea', assignees: ['unassigned'], labels: [], createdAt: '2026-06-27T00:00:00Z', updatedAt: '2026-06-27T00:00:00Z' },
        ],
        nextShortId: 278,
      }),
    });
    try { await fn(server); } finally { await server.stop(); }
  });
}

const post = async (baseUrl, body) => {
  const res = await fetch(`${baseUrl}/api/cards`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { res, body: await res.json() };
};
const get = async (baseUrl, id) => (await fetch(`${baseUrl}/api/cards/${id}`)).json();

apiTest('#280 creating a near-duplicate returns 201 WITH similarCards naming the original', async ({ baseUrl }) => {
  const { res, body } = await post(baseUrl, { title: 'OpenAI Model Designer — apply', createdBy: 'ada' });
  assert.equal(res.status, 201);                                   // a warning, never a refusal
  assert.equal(body.shortId, 278);
  assert.ok(Array.isArray(body.similarCards), 'similarCards must ride on the 201');
  assert.equal(body.similarCards[0].shortId, 277);
  assert.ok(!body.similarCards.some((c) => c.shortId === 278), 'the new card is not similar to itself');
  // DERIVED: the stored card carries nothing.
  const stored = await get(baseUrl, 278);
  assert.equal(stored.similarCards, undefined);
});

apiTest('#280 an unrelated title returns 201 with NO similarCards key at all', async ({ baseUrl }) => {
  const { res, body } = await post(baseUrl, { title: 'Fix the deploy script health check', createdBy: 'ada' });
  assert.equal(res.status, 201);
  assert.equal(body.similarCards, undefined);
});
