/**
 * #755 — the sprint's REVIEW INSTRUMENT.
 *
 * The sprint closes 2026-08-16 with three pre-registered abandon signals, and
 * until now not one of them had anything that could compute it. Somebody would
 * have sat down on the 16th and NARRATED the verdict — which is exactly the
 * failure the guard on #762 was written to prevent: "every outcome narrates as
 * a lesson; a sprint that produced nothing reports 'we learned it's harder
 * than we thought.'"
 *
 * ⚠️⚠️ THE DEFECT THAT SHAPES THIS WHOLE FILE (the steward's, and it would have
 * manufactured a verdict):
 *
 *   Signal 1 is "ZERO contested bids after 20+ real bids ⇒ abandon the window."
 *   If the instrument prints `0 contests` because it CANNOT SEE bids, that
 *   reads as signal 1 FIRING. The abandon verdict for the sprint's central
 *   mechanism would be produced by an absence of instrumentation, and it would
 *   look exactly like a result.
 *
 * ⇒ So every signal reports one of THREE things, never a bare number:
 *     measured      n / d
 *     unmeasurable  + the specific input that does not exist
 *     zero          a REAL zero over a POPULATED denominator
 *
 * ⇒ And `0` with an empty denominator is NOT a zero. It is unmeasurable.
 *   That single rule is the difference between a report and a rumour.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  signalOneContestedBids,
  signalTwoUngrantedActions,
  signalThreeOutOfBand,
  COVERED_OPS,
  renderSignal,
} from '../core/sprint-signals.mjs';

const ev = (actor, op, kind = 'card', at = '2026-08-10T02:00:00.000Z') => ({
  actor,
  op,
  entity: { kind, id: 'x' },
  occurred_at: at,
});

const SEATS = ['ada', 'bo', 'cy'];

// ── the three-state contract, which is the point of the file ────────────────

test('#755-signals a signal is exactly one of measured | unmeasurable | zero', () => {
  for (const s of [
    signalOneContestedBids({ bidRecords: null }),
    signalTwoUngrantedActions({ events: [], workObjects: [], seats: SEATS }),
    signalThreeOutOfBand({ humanSuppliedCount: null }),
  ]) {
    assert.ok(['measured', 'unmeasurable', 'zero'].includes(s.status), `bad status: ${s.status}`);
  }
});

test('#755-signals ⭐⭐ AN UNMEASURABLE SIGNAL CARRIES NO NUMBER AT ALL', () => {
  // The whole defect: a number printed where there is no input is
  // indistinguishable from a result. So there is no number to misread.
  const s = signalOneContestedBids({ bidRecords: null });
  assert.equal(s.status, 'unmeasurable');
  assert.equal('numerator' in s, false, 'an unmeasurable signal handed back a numerator');
  assert.equal('denominator' in s, false);
  assert.ok(s.missingInput, 'unmeasurable must name the specific input that does not exist');
});

test('#755-signals ⭐⭐ ZERO OVER AN EMPTY DENOMINATOR IS UNMEASURABLE, NOT ZERO', () => {
  // 0/0 is the cell that reads as "no bypasses" and means "no instrument".
  const s = signalTwoUngrantedActions({ events: [], workObjects: [], seats: SEATS });
  assert.equal(s.status, 'unmeasurable');
  assert.match(s.missingInput, /no covered actions/i);
});

test('#755-signals a REAL zero requires a populated denominator', () => {
  const events = [ev('ada', 'create'), ev('bo', 'update')];
  const s = signalTwoUngrantedActions({ events, workObjects: [], seats: SEATS });
  assert.equal(s.status, 'zero');
  assert.equal(s.numerator, 0);
  assert.equal(s.denominator, 2);
});

test('#755-signals renderSignal NEVER prints a bare number for an unmeasurable signal', () => {
  const line = renderSignal('signal 1', signalOneContestedBids({ bidRecords: null }));
  assert.match(line, /UNMEASURABLE/);
  assert.equal(/\b\d+ *\/ *\d+/.test(line), false, 'a ratio leaked into an unmeasurable line');
});

// ── signal 2: the denominator is real today; the numerator is not ───────────

test('#755-signals signal 2 counts ONLY covered ops in the denominator', () => {
  const events = [
    ev('ada', 'create'),
    ev('ada', 'update'),
    ev('ada', 'post', 'conversation'), // speech is not covered — #646
    ev('ada', 'read'),
  ];
  const s = signalTwoUngrantedActions({ events, workObjects: [], seats: SEATS });
  assert.equal(s.denominator, 2);
  assert.ok(COVERED_OPS.includes('create'));
  assert.equal(COVERED_OPS.includes('post'), false, 'you cannot mutex a conversation (#646)');
});

test('#755-signals ⚠️ HUMAN ACTIONS ARE EXCLUDED FROM THE DENOMINATOR, and the exclusion is printed', () => {
  // The gate measures SEATS. A human's card edits would dilute the rate and
  // make the rail look better-obeyed than it is. The excluded count is
  // reported so the filter itself is auditable.
  const events = [ev('ada', 'create'), ev(null, 'create'), ev(undefined, 'update'), ev('stranger', 'create')];
  const s = signalTwoUngrantedActions({ events, workObjects: [], seats: SEATS });
  assert.equal(s.denominator, 1, 'only the known seat counts');
  assert.equal(s.excludedNonSeat, 3);
});

test('#755-signals signal 2 numerator is structurally 0 while no work objects exist — and says so', () => {
  // ⚠️ This test used to assert /no work-object store/ for an EMPTY array,
  // which is the conflation the two tests further down split apart: an empty
  // store and an absent one are different facts. It now checks the property it
  // was always about — the numerator is structurally 0 and the output says so —
  // without caring which of the two reasons applies.
  const events = [ev('ada', 'create')];
  for (const workObjects of [null, []]) {
    const s = signalTwoUngrantedActions({ events, workObjects, seats: SEATS });
    assert.equal(s.numerator, 0);
    assert.match(s.caveat, /STRUCTURAL ZERO/);
    assert.match(s.caveat, /not evidence of compliance/i);
  }
});

test('#755-signals with work objects present, an action inside an open window IS counted', () => {
  const events = [ev('ada', 'create', 'card', '2026-08-10T02:10:00.000Z')];
  const workObjects = [
    {
      id: 'wo-1',
      declaredBy: 'ada',
      replyBy: '2026-08-10T02:20:00.000Z',
      required: ['ada', 'bo'],
      transitions: [
        { type: 'declare', by: 'ada', at: '2026-08-10T02:00:00.000Z' },
        { type: 'bid', by: 'ada', at: '2026-08-10T02:00:00.000Z' },
      ],
    },
  ];
  const s = signalTwoUngrantedActions({ events, workObjects, seats: SEATS });
  assert.equal(s.status, 'measured');
  assert.equal(s.numerator, 1);
  assert.equal(s.denominator, 1);
  assert.equal(s.caveat, undefined, 'the store exists now — the caveat must go away');
});

// ── signal 1: bids are prose, and the instrument refuses to guess ───────────

test('#755-signals ⛔ SIGNAL 1 REFUSES TO PARSE PROSE BIDS — not best-effort, not heuristic', () => {
  // This room measured it: a refusal and a politeness are the same string. A
  // seat's harness re-emitted "Nothing to add on my side" eleven times,
  // including after the question closed. Any counter over prose would have
  // scored those as answers.
  const s = signalOneContestedBids({ bidRecords: null });
  assert.equal(s.status, 'unmeasurable');
  assert.match(s.missingInput, /token|record/i);
});

test('#755-signals signal 1 measures once bids are RECORDS rather than sentences', () => {
  const bidRecords = [
    { id: 'w1', contested: false },
    { id: 'w2', contested: true },
    { id: 'w3', contested: false },
  ];
  const s = signalOneContestedBids({ bidRecords });
  assert.equal(s.status, 'measured');
  assert.equal(s.numerator, 1);
  assert.equal(s.denominator, 3);
});

test('#755-signals ⚠️ signal 1 does not FIRE below its own threshold of 20 real bids', () => {
  // "ZERO contested bids AFTER 20+ REAL BIDS." Three bids with no contest is
  // not the signal; it is a small sample. Firing early is how a pre-registered
  // signal becomes a story.
  const few = signalOneContestedBids({ bidRecords: [{ id: 'w1', contested: false }] });
  assert.equal(few.fires, false);
  assert.match(few.note, /20/);

  const many = signalOneContestedBids({ bidRecords: Array.from({ length: 20 }, (_, i) => ({ id: `w${i}`, contested: false })) });
  assert.equal(many.fires, true);
});

// ── signal 3: cannot come from the log, by construction ─────────────────────

test('#755-signals ⛔ SIGNAL 3 IS UNMEASURABLE FROM THE LOG, ALWAYS — a human must supply it', () => {
  const s = signalThreeOutOfBand({ humanSuppliedCount: null });
  assert.equal(s.status, 'unmeasurable');
  assert.match(s.missingInput, /human/i);
  // ⚠️ It requires someone to notice a race the protocol never opened a bid
  // for. The instrument cannot report on its own blind spot — that is the
  // definition of the blind spot.
});

test('#755-signals signal 3 accepts a human number and marks it as human-sourced', () => {
  const s = signalThreeOutOfBand({ humanSuppliedCount: 2 });
  assert.equal(s.status, 'measured');
  assert.equal(s.numerator, 2);
  assert.equal(s.source, 'human');
});

test('#755-signals signal 3 accepts a human ZERO — "we looked and found none" is a result', () => {
  const s = signalThreeOutOfBand({ humanSuppliedCount: 0 });
  assert.equal(s.status, 'zero');
  assert.equal(s.source, 'human');
});

// ── ⚠️ "NO STORE" AND "EMPTY STORE" ARE DIFFERENT FACTS ─────────────────────
//
// Caught by running the instrument against the real log the morning after the
// store landed. It printed "there is no work-object store" — and there WAS one;
// it was empty, because the gate has never been armed.
//
// ⇒ signalTwoUngrantedActions branched on `workObjects.length === 0`, which
//   conflates two states that mean opposite things about the evidence:
//     no store      → no instrument. The zero is meaningless.
//     empty store   → the instrument exists and has recorded nothing, which is
//                     expected while the flag is off, and is a real zero over a
//                     real denominator once it is armed.
//
// ⇒ The instrument built to stop a plausible zero was printing a stale caveat
//   about a condition that had ended six hours earlier. Same defect class, in
//   the tool written against it.

test('#755-signals ⛔ NO STORE (null) says so — the zero means "no instrument"', () => {
  const events = [ev('ada', 'create')];
  const s = signalTwoUngrantedActions({ events, workObjects: null, seats: SEATS });
  assert.match(s.caveat, /no work-object store/i);
  assert.match(s.caveat, /not evidence of compliance/i);
});

test('#755-signals ⚠️ AN EMPTY STORE IS A DIFFERENT CAVEAT — the store exists and is empty', () => {
  const events = [ev('ada', 'create')];
  const s = signalTwoUngrantedActions({ events, workObjects: [], seats: SEATS });
  assert.equal(/no work-object store/i.test(s.caveat || ''), false, 'still claiming there is no store');
  assert.match(s.caveat, /empty/i);
  // ⚠️ It is STILL not evidence of compliance — nothing can be counted as
  // ungranted when nothing was ever recorded. But it is a different reason.
  assert.match(s.caveat, /not evidence of compliance/i);
});

test('#755-signals a POPULATED store carries no caveat at all', () => {
  const events = [ev('ada', 'create', 'card', '2026-08-10T02:10:00.000Z')];
  const workObjects = [{
    id: 'wo-1', declaredBy: 'ada', replyBy: '2026-08-10T02:20:00.000Z', required: ['ada', 'bo'],
    transitions: [
      { type: 'declare', by: 'ada', at: '2026-08-10T02:00:00.000Z' },
      { type: 'bid', by: 'ada', at: '2026-08-10T02:00:00.000Z' },
    ],
  }];
  const s = signalTwoUngrantedActions({ events, workObjects, seats: SEATS });
  assert.equal(s.caveat, undefined);
  assert.equal(s.numerator, 1);
});
