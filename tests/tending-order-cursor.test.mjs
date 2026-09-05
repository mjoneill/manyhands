/**
 * #1189 follow-up — "In the order below" must MEAN in the order below.
 *
 * ── THE DEFECT, reported by the board owner on the first day of use ────────
 * The Settings control offers "In the order below" and the firing picked the
 * LAST whisper in the list. Selection was `floor(epoch_hour) % pool.length` —
 * a rotation anchored to absolute clock time, inherited from #802 and
 * preserved deliberately when the graph pool landed.
 *
 * That rotation does walk the list in order, but:
 *   · the entry point is arbitrary (it depends on the absolute hour), and
 *   · it JUMPS whenever a whisper is added or removed, because the modulus
 *     changes — so "the order below" has no stable relationship to what fires.
 *
 * ⛔ The label was the lie, not the algorithm. A control that says "in the
 * order below" is a promise about the NEXT firing, and no amount of
 * eventually-fair rotation keeps it.
 *
 * ── THE CURSOR IS DERIVED, NOT STORED ──────────────────────────────────────
 * scrum:TendingMint already records which prompt version each firing sent. So
 * "where are we in the list" is a QUESTION THE GRAPH CAN ANSWER, and storing a
 * second copy would create exactly the drift this card spent the night
 * removing: two places that can disagree about one fact.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nextInOrder } from '../core/tending-pool.mjs';

const P = (slug, versionId) => ({ slug, body: `${slug} body`, versionId, version: 1 });

const POOL = [
  P('alpha', 'iri:alpha/v1'),
  P('bravo', 'iri:bravo/v1'),
  P('charlie', 'iri:charlie/v1'),
];

test('with no previous firing, the FIRST whisper in the list goes out', () => {
  // DEFECT: the shipped behaviour — an epoch-derived index, so a fresh board's
  // first whisper is whichever one the clock happens to land on.
  assert.equal(nextInOrder(POOL, null).slug, 'alpha');
  assert.equal(nextInOrder(POOL, undefined).slug, 'alpha');
});

test('the firing after alpha is bravo — the order below, literally', () => {
  assert.equal(nextInOrder(POOL, 'iri:alpha/v1').slug, 'bravo');
  assert.equal(nextInOrder(POOL, 'iri:bravo/v1').slug, 'charlie');
});

test('it wraps from the last back to the first', () => {
  assert.equal(nextInOrder(POOL, 'iri:charlie/v1').slug, 'alpha');
});

test('a REORDER is honoured on the very next firing', () => {
  // DEFECT: keying position to an index rather than to the entity that fired.
  // After a reorder, an index points at a different whisper and the sequence
  // silently restarts somewhere arbitrary.
  const reordered = [POOL[2], POOL[0], POOL[1]]; // charlie, alpha, bravo
  assert.equal(nextInOrder(reordered, 'iri:charlie/v1').slug, 'alpha');
  assert.equal(nextInOrder(reordered, 'iri:alpha/v1').slug, 'bravo');
});

test('ADDING a whisper does not scramble the sequence', () => {
  // DEFECT: `% pool.length` — the modulus changes, so every add or remove
  // teleports the cursor. This is what the owner actually saw: three whispers
  // became six between one firing and the next, and the position jumped.
  const grown = [...POOL, P('delta', 'iri:delta/v1')];
  assert.equal(nextInOrder(grown, 'iri:alpha/v1').slug, 'bravo',
    'adding a whisper changed which one comes after alpha');
});

test('if the last-fired whisper is no longer in the list, start from the top', () => {
  // Removed, or disabled, or its prompt retired. Resuming from a member that
  // is gone has no defined answer, and guessing a neighbour would be inventing
  // a position nobody chose.
  assert.equal(nextInOrder(POOL, 'iri:ghost/v1').slug, 'alpha');
});

test('the cursor matches on PROMPT identity, not on version — an edit does not lose the place', () => {
  // DEFECT: comparing the exact version IRI. Editing a whisper mints v2, so
  // the next firing would fail to find v1 in the pool and restart at the top —
  // meaning every edit silently resets the sequence.
  const pool = [P('alpha', 'iri:alpha/v2'), P('bravo', 'iri:bravo/v1')];
  assert.equal(nextInOrder(pool, 'iri:alpha/v1').slug, 'bravo',
    'an edit to the last-fired whisper reset the running order');
});

test('an empty pool yields nothing rather than throwing', () => {
  assert.equal(nextInOrder([], 'iri:alpha/v1'), null);
});

test('a single-whisper list repeats it rather than going silent', () => {
  const one = [P('solo', 'iri:solo/v1')];
  assert.equal(nextInOrder(one, 'iri:solo/v1').slug, 'solo');
});
