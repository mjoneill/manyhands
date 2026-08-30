/**
 * Item 13 (#1086 / #1097's goal) — query→card retrieval as a manyhands
 * feature. The PURE half: ranking, the answer contract, and the index plan.
 *
 * What was measured before this was built (#1095, frozen, k=8): dense
 * embedding reproduces the room's own findable targets 9/9 where BM25 gets
 * 1/9, fuzzy 0/9 and recency 3/9; and "no raw ranker implements the
 * abstention contract" — a ranker always returns eight cards, so a genuine
 * negative comes back as a confident wrong answer. The contract is therefore
 * part of the feature, not a later layer: every answer is one of
 * answer | ask | abstain, and the thresholds that decide which are PUBLISHED
 * beside the verdict, because they are the only guessed numbers in the build.
 *
 * Nothing here talks to a model. Ranking is cosine over vectors the caller
 * supplies; the index plan is arithmetic over content hashes. The live
 * embedder is tested separately, against the frozen eval set, pinned to a sha.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cosine, rank, decide, cardText, contentHash, planIndexUpdate, parseIndex, serializeIndex,
  DEFAULTS,
} from '../core/semantic-search.mjs';

const v = (...xs) => xs;

test('cosine: identical vectors are 1, orthogonal are 0, and a zero vector is 0 rather than NaN', () => {
  assert.equal(cosine(v(1, 0), v(1, 0)), 1);
  assert.equal(cosine(v(1, 0), v(0, 1)), 0);
  assert.equal(cosine(v(0, 0), v(1, 0)), 0);
  assert.ok(Math.abs(cosine(v(1, 1), v(1, 0)) - Math.SQRT1_2) < 1e-9);
});

test('rank: top-k by cosine, descending, carrying id and score; k caps the list', () => {
  const index = [
    { id: 'a', vec: v(1, 0) }, { id: 'b', vec: v(0.9, 0.1) }, { id: 'c', vec: v(0, 1) },
  ];
  const r = rank(v(1, 0), index, { k: 2 });
  assert.deepEqual(r.map((x) => x.id), ['a', 'b']);
  assert.ok(r[0].score > r[1].score);
  assert.equal(rank(v(1, 0), index, { k: 8 }).length, 3, 'k larger than the index returns everything');
});

test('rank: a dimension mismatch is refused, never silently scored — a swapped model is exactly what this catches', () => {
  assert.throws(() => rank(v(1, 0, 0), [{ id: 'a', vec: v(1, 0) }], { k: 1 }), /dimension/);
});

// ── the answer contract ──────────────────────────────────────────────────────

const ranked = (...scores) => scores.map((score, i) => ({ id: `c${i}`, score }));

test('decide: a clear top hit ANSWERS, and the verdict publishes the thresholds it used', () => {
  const d = decide(ranked(0.72, 0.60, 0.55), DEFAULTS);
  assert.equal(d.verdict, 'answer');
  assert.equal(d.abstainBelow, DEFAULTS.abstainBelow);
  assert.equal(d.askWithin, DEFAULTS.askWithin);
  assert.equal(d.top.id, 'c0');
});

test('decide: top below abstainBelow ⇒ ABSTAIN with the reason — a negative is not answered with eight wrong cards', () => {
  const d = decide(ranked(0.41, 0.40, 0.39), { abstainBelow: 0.5, askWithin: 0.03 });
  assert.equal(d.verdict, 'abstain');
  assert.match(d.reason, /0\.41.*0\.5/);
  assert.equal(d.top, null, 'an abstention names no top');
});

test('decide: two or more candidates within askWithin of the top ⇒ ASK, returning the contenders as the question', () => {
  const d = decide(ranked(0.70, 0.69, 0.685, 0.50), { abstainBelow: 0.5, askWithin: 0.03 });
  assert.equal(d.verdict, 'ask');
  assert.deepEqual(d.contenders.map((c) => c.id), ['c0', 'c1', 'c2']);
});

test('decide: exactly the boundary — top == abstainBelow answers; a second within exactly askWithin asks', () => {
  assert.equal(decide(ranked(0.5, 0.2), { abstainBelow: 0.5, askWithin: 0.03 }).verdict, 'answer');
  assert.equal(decide(ranked(0.6, 0.57), { abstainBelow: 0.5, askWithin: 0.03 }).verdict, 'ask');
  assert.equal(decide(ranked(0.6, 0.569), { abstainBelow: 0.5, askWithin: 0.03 }).verdict, 'answer');
});

test('decide: an empty ranking abstains with a reason that says the index was empty, not that nothing matched', () => {
  const d = decide([], DEFAULTS);
  assert.equal(d.verdict, 'abstain');
  assert.match(d.reason, /empty/i);
});

test('DEFAULTS are the numbers the design published: abstainBelow 0.50 (#1086 landmark: foreign 0.47, genuine ~0.66), askWithin 0.03, k 8', () => {
  assert.deepEqual(DEFAULTS, { abstainBelow: 0.5, askWithin: 0.03, k: 8 });
});

// ── the index: what gets embedded, and what changed ──────────────────────────

test('cardText is the measured shape, byte for byte: "# title\\n\\nbody"', () => {
  assert.equal(cardText({ title: 'T', description: 'B' }), '# T\n\nB');
  assert.equal(cardText({ title: 'T' }), '# T\n\n');
});

test('contentHash is stable and changes with the text', () => {
  assert.equal(contentHash('x'), contentHash('x'));
  assert.notEqual(contentHash('x'), contentHash('y'));
  assert.match(contentHash('x'), /^[0-9a-f]{64}$/);
});

test('planIndexUpdate: new cards and changed cards are embedded; unchanged are kept; deleted are dropped; the batch is bounded', () => {
  const cards = [
    { id: 'a', title: 'A', description: '1' },
    { id: 'b', title: 'B', description: '2' },
    { id: 'c', title: 'C', description: '3' },
  ];
  const have = [
    { id: 'a', hash: contentHash(cardText(cards[0])), vec: [1] },   // unchanged
    { id: 'b', hash: 'stale', vec: [1] },                            // changed
    { id: 'z', hash: 'x', vec: [1] },                                // deleted
  ];
  const plan = planIndexUpdate(cards, have, { maxEmbed: 50 });
  assert.deepEqual(plan.toEmbed.map((t) => t.id), ['b', 'c']);
  assert.deepEqual(plan.keep.map((t) => t.id), ['a']);
  assert.deepEqual(plan.drop, ['z']);
  assert.deepEqual(plan.coverage, { indexed: 1, total: 3, stale: 2 });

  const bounded = planIndexUpdate(cards, have, { maxEmbed: 1 });
  assert.equal(bounded.toEmbed.length, 1, 'the batch is capped so one call cannot pin the event loop or the model');
  assert.equal(bounded.coverage.stale, 2, 'coverage reports what is STILL stale, not what this batch will fix');
});

test('the index file: a generation header then rows; parse refuses a header that names a different model or dimension than the caller expects', () => {
  const gen = { model: 'm', dims: 2, textShape: '# title\n\nbody', builtAt: '2026-08-30T00:00:00.000Z' };
  const text = serializeIndex(gen, [{ id: 'a', hash: 'h', vec: [1, 0] }]);
  const back = parseIndex(text, { model: 'm', dims: 2 });
  assert.deepEqual(back.generation, gen);
  assert.equal(back.rows.length, 1);
  assert.throws(() => parseIndex(text, { model: 'other', dims: 2 }), /generation/);
  assert.throws(() => parseIndex(text, { model: 'm', dims: 3 }), /generation/);
  assert.deepEqual(parseIndex('', { model: 'm', dims: 2 }).rows, [], 'no file yet ⇒ empty index, not an error');
});
