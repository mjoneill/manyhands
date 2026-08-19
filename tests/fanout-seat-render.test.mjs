/**
 * #903 — THE BRACKET NAMED A DEAF SEAT WITH THE SAME WORD IT USED FOR A
 * LISTENING ONE, AND THE FLOOR WAS THE SAME NUMBER AS THE COUNT.
 *
 * Posted 2026-08-19T11:18:48Z. Reproduced with the seat names generalised —
 * every number, and the shape that makes it wrong, is as it fired:
 *
 *   "only 2 of 10 live sessions hold an open stream (floor: 3). Seats without a
 *    stream receive NOTHING … [#703: bound=[alpha,beta,healthcheck] unbound=3]"
 *
 * ⇒ Headline 2. Bracket 3. Floor 3. A reader who takes the bracket as the answer
 *   to "who can still hear the room" — which is what #703 added it for — sees a
 *   set that exactly meets the floor and stands down.
 *
 * ⛔ THESE TESTS ASSERT ON THE RENDERED LINE, NOT ON THE SEAT ARRAY. The defect
 * is in what a human reads at 06:18 in the morning. A test on the intermediate
 * array passes happily while the printed text stays ambiguous — which is how the
 * ambiguity survived #703, #707, #713 and #726 all touching this file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSeats, seatSuffix, seatBracket } from '../scripts/fanout-decide.mjs';

// The live shape, 2026-08-19T11:18Z. healthcheck is not a seat that LOST its
// stream — it is a probe that mints a session every 60s and never opens one
// (#707, #625, #268), so streams:0 is its steady state and not a fault.
const LIVE = {
  binding: 'active',
  unbound: 3,
  seats: {
    healthcheck: { streams: 0, sessions: 5, lastBeatAt: null },
    alpha: { streams: 1, sessions: 1, lastBeatAt: '2026-08-19T11:18:04.282Z' },
    beta: { streams: 1, sessions: 1, lastBeatAt: '2026-08-19T11:18:14.283Z' },
  },
};

// Same three seats, all listening. The ONLY difference from LIVE is
// healthcheck's stream count — so any rendering that cannot separate these two
// is reporting something other than who can hear the room.
const ALL_LISTENING = {
  binding: 'active',
  unbound: 3,
  seats: {
    healthcheck: { streams: 1, sessions: 5 },
    alpha: { streams: 1, sessions: 1 },
    beta: { streams: 1, sessions: 1 },
  },
};

// ⭐ THE CONTROL, AND IT RUNS FIRST BECAUSE IT IS WHAT JUSTIFIES THE CARD.
// This reproduces the PRE-FIX rendering inline rather than trusting a memory of
// it. If this test ever fails, the premise is wrong and #903 should be closed
// unbuilt — the old bracket would already have distinguished the two.
test('#903 ⭐ CONTROL — the OLD rendering cannot tell a deaf seat from a listening one', () => {
  const preFix = (status) => Object.keys(status.seats ?? {}).sort().join(',');

  assert.equal(
    preFix(LIVE), preFix(ALL_LISTENING),
    'the pre-fix bracket must be IDENTICAL for a room with a deaf seat and a room without one. '
    + 'If these differ, #903 has no premise.',
  );
  assert.equal(preFix(LIVE), 'alpha,beta,healthcheck');
});

test('#903 the bracket names each seat with its stream count', () => {
  const line = seatBracket(LIVE);

  assert.equal(line, ' [#703: bound=[alpha:1,beta:1,healthcheck:0] unbound=3]');
  assert.match(line, /healthcheck:0/, 'a seat with no stream must read as having no stream');
});

test('#903 ⛔ and the two rooms are now DISTINGUISHABLE on the printed line', () => {
  // The whole point. Without this the test above passes for a renderer that
  // appends ":0" to everything.
  assert.notEqual(
    seatBracket(LIVE), seatBracket(ALL_LISTENING),
    'a deaf seat and a listening one must not produce the same alarm text',
  );
  assert.equal(seatBracket(ALL_LISTENING), ' [#703: bound=[alpha:1,beta:1,healthcheck:1] unbound=3]');
});

test('#903 ⚠️ an ABSENT stream count renders `?`, never `0`', () => {
  // #713's lesson, applied one field over: `?? 0` rendered a missing `pending`
  // as "there is no queue" — a measurement that isn't there reading as a healthy
  // one. A seat whose streams we cannot read is NOT a seat with zero streams,
  // and the two must not print the same.
  const partial = { binding: 'active', unbound: 0, seats: { ghost: { sessions: 2 }, real: { streams: 0 } } };
  const line = seatBracket(partial);

  assert.match(line, /ghost:\?/, 'unknown must be rendered as unknown');
  assert.match(line, /real:0/, 'and a genuine zero must still read as zero');
  assert.doesNotMatch(line, /ghost:0/, 'an absent measurement must never be printed as a zero');
});

test('#903 the per-tick log line carries the same counts as the alarm', () => {
  // Two call sites shared one bare-name array; a fix to only the alarm would
  // leave a human reading the tick log with the original ambiguity, which is
  // the same duplicate-text trap the warn bodies hit at #713 ("three copies of
  // one false claim").
  assert.equal(seatSuffix(LIVE), ' seats=[alpha:1,beta:1,healthcheck:0] unbound=3');
});

test('#903 binding inactive still renders nothing, and unknown seats do not crash', () => {
  // #894's additive rule: nothing the watch already reads may change shape.
  assert.equal(seatBracket({ binding: 'off', seats: LIVE.seats }), '');
  assert.equal(seatSuffix({ binding: 'off', seats: LIVE.seats }), '');
  assert.deepEqual(renderSeats(undefined), []);
  assert.deepEqual(renderSeats({}), []);
});
