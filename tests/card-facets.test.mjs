/**
 * #629's FIRST THIN SLICE — count → facet → refine, before enumerating.
 *
 * ⚠️ #629 is an IDEA DUMP and says so: "Nothing here is scheduled; thin slices
 * remain the rule", "Open for idea-throwing. Nothing binds." So it is not a
 * capability to be built whole, and §IV listing it as one was a category error.
 *
 * ⭐ But it names its own first slice, twice, and the second time as the gap:
 *
 *   "count → facet → refine … the first thin slice this card could someday yield"
 *   "His count-then-filter flow is the next capability the current surface does
 *    NOT have."
 *
 * The framing it came from: a caller should be able to ask for a COUNT, learn
 * the number of objects, and then choose to filter by a second dimension —
 * because a board accumulates until "too many results" is the normal case.
 *
 * ⇒ THE PROBLEM IT SOLVES: today the only way to learn the shape of a result set
 *   is to fetch it. An agent wanting "which columns hold my work" must pull rows
 *   and count them client-side — paying full payload to learn a distribution, on
 *   a board where one unpaged call was 3.9 MB.
 *
 * ⛔ WHAT THIS IS NOT: a query governor, an execution budget, a retrieval
 * envelope, or any of the essay's architecture. Those are ideaspace per the
 * card's own ruling, and building them off an unvetted outside synthesis would
 * be treating ideaspace as a spec — which the card explicitly forbids.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const card = (shortId, over = {}) => ({
  id: `u-${shortId}`, shortId, title: `card ${shortId}`, description: '',
  type: 'task', labels: [], assignees: [], column: 'backlog', order: shortId,
  createdAt: '2026-08-01T00:00:00.000Z', relationships: {}, ...over,
});

const board = () => makeBoardFixture({
  cards: [
    card(1, { column: 'backlog', labels: ['graph'], type: 'task' }),
    card(2, { column: 'backlog', labels: ['graph', 'ux'], type: 'bug' }),
    card(3, { column: 'done', labels: ['graph'], type: 'task' }),
    card(4, { column: 'done', labels: [], type: 'task' }),
    card(5, { column: 'done', labels: ['ux'], type: 'idea' }),
  ],
  nextShortId: 6,
});

const get = async (baseUrl, path) => {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
};

test('#629 facet=column returns the distribution WITHOUT the rows', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const r = await get(s.baseUrl, '/api/cards?facet=column&as=ada');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.facet, 'column');
    assert.deepEqual(r.body.counts, [
      { value: 'done', count: 3 },
      { value: 'backlog', count: 2 },
    ], 'ranked by count — the shape of the set, largest first');
    assert.equal(r.body.cards, undefined,
      'NO rows: the whole point is learning the distribution without paying for the payload');
    assert.equal(r.body.total, 5, 'and the total it was computed over');
  } finally { await s.stop(); }
});

test('#629 a card with MANY values counts under each — labels are not single-valued', async () => {
  // ⚠️ The trap. Card 2 carries two labels. A naive implementation that took
  // `labels[0]` would produce a distribution that silently sums to less than the
  // population, and nothing in the response would say so.
  const s = await startRestServer({ board: board() });
  try {
    const r = await get(s.baseUrl, '/api/cards?facet=label&as=ada');
    assert.deepEqual(r.body.counts, [
      { value: 'graph', count: 3 },
      { value: 'ux', count: 2 },
    ]);
    assert.equal(r.body.unset, 1, 'card 4 carries no labels — counted, not silently dropped');
  } finally { await s.stop(); }
});

test('#629 facet COMPOSES with filters — count, then refine, then count again', async () => {
  // ⭐ THE ACTUAL FLOW: "query a Count… and then choose to filter by a second
  // dimension". If facet ignored filters it would answer a different question
  // than the one the agent is narrowing toward.
  const s = await startRestServer({ board: board() });
  try {
    const all = await get(s.baseUrl, '/api/cards?facet=type&as=ada');
    assert.deepEqual(all.body.counts, [
      { value: 'task', count: 3 }, { value: 'bug', count: 1 }, { value: 'idea', count: 1 },
    ]);

    const narrowed = await get(s.baseUrl, '/api/cards?facet=type&column=done&as=ada');
    assert.deepEqual(narrowed.body.counts, [
      { value: 'task', count: 2 }, { value: 'idea', count: 1 },
    ], 'the facet is computed over the FILTERED set, not the whole board');
    assert.equal(narrowed.body.total, 3);
  } finally { await s.stop(); }
});

test('#629 an unknown facet is REFUSED, naming the ones that exist', async () => {
  // #659: the refusal is the only place a caller learns what the door can do.
  const s = await startRestServer({ board: board() });
  try {
    const r = await get(s.baseUrl, '/api/cards?facet=nonsense&as=ada');
    assert.equal(r.status, 400);
    assert.match(r.body.error, /column/, 'the refusal must name the valid facets');
    assert.match(r.body.error, /nonsense/, 'and echo what was asked for');
  } finally { await s.stop(); }
});

test('#629 the facet counts SUM to the population, or the response says why not', async () => {
  // ⛔ THE HONESTY PROPERTY, and the one worth having. A distribution whose parts
  // do not add up to the whole is the shape of every silently-narrowed number
  // this board has found: `unset` is reported so a reader can always reconcile
  // counted + unset against total, rather than trusting that they do.
  const s = await startRestServer({ board: board() });
  try {
    const r = await get(s.baseUrl, '/api/cards?facet=label&as=ada');
    const counted = r.body.counts.reduce((n, c) => n + c.count, 0);
    // 3 graph + 2 ux = 5 label-slots across 4 labelled cards; 1 card unlabelled.
    assert.equal(r.body.multivalued, true,
      'label is multivalued, so counts sum to SLOTS not cards — stated, not assumed');
    assert.equal(r.body.cardsWithValue + r.body.unset, r.body.total,
      'cards-with-a-value plus cards-without must reconcile against the total');
    assert.ok(counted >= r.body.cardsWithValue,
      'and slot-count is at least card-count when a card can carry several');
  } finally { await s.stop(); }
});

test('#629 facet does not record a retrieval miss — it is a supported param', async () => {
  const s = await startRestServer({ board: board() });
  try {
    await get(s.baseUrl, '/api/cards?facet=column&as=ada');
    const m = await get(s.baseUrl, '/api/misses');
    assert.equal(m.body.open, 0, 'facet is supported and must not be logged as an unmet need');
  } finally { await s.stop(); }
});
