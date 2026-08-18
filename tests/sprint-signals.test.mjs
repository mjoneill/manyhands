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
import { ENFORCED_OPS } from '../core/work-gate.mjs';

// ⚠️ #890 — `entity.shortId` IS PART OF THE REAL RECORD and was missing here.
// The module's own docstring inventory said the log carries "actor · op ·
// occurred_at", two seats read that as exhaustive, and neither looked at
// `entity` for six hours. Measured on the production log: 2014/2014 card events
// carry shortId, 0 without. A fixture thinner than the record is a fixture that
// cannot discriminate.
const ev = (actor, op, kind = 'card', at = '2026-08-10T02:00:00.000Z', shortId = 700) => ({
  actor,
  op,
  entity: kind === 'card' ? { kind, id: 'x', shortId } : { kind, id: 'x' },
  occurred_at: at,
});

/**
 * ⛔⛔ #890 R4 — WHY THESE TESTS NAME AN OP INSTEAD OF TAKING THE DEFAULT.
 *
 * `ENFORCED_OPS` is ['create'], and a create brings a card into existence and
 * so names none at decision time. The gate cannot scope it, therefore no create
 * can ever BE a violation, therefore signal 2 over creates alone is
 * unmeasurable — not zero. (That is the module's own contract, applied one
 * function up: `scored()` refuses an empty denominator for the same reason.)
 *
 * ⇒ The tests below are about COUNTING — which ops enter the denominator, who
 *   is excluded, which caveat fires — and counting is still worth pinning. They
 *   name a SCOPABLE op so they measure counting rather than re-measuring R4.
 *
 * ⚠️ Deliberately NOT ['create']: if #889 lands and the enforced op becomes
 * scopable, these keep testing exactly what they test today, and the R4 test
 * below is the one that will need rewriting — which is the right place for the
 * change to surface.
 */
const SCOPABLE = ['update'];

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
  // Was create+update expecting 2. `update` is not enforced by the gate, so
  // counting it WAS the mismatch — corrected to the truth, not loosened.
  const events = [ev('ada', 'update'), ev('bo', 'update')];
  const s = signalTwoUngrantedActions({ events, workObjects: [], seats: SEATS, enforcedOps: SCOPABLE });
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

test('#755-signals signal 2 counts ONLY ENFORCED ops in the denominator', () => {
  const events = [
    ev('ada', 'create'),
    ev('ada', 'update'), // board-mutating, and NOT enforced by the gate
    ev('ada', 'claim'), // the scenario that exposed the gap — also not enforced
    ev('ada', 'post', 'conversation'), // speech is never covered — #646
    ev('ada', 'read'),
  ];
  const s = signalTwoUngrantedActions({ events, workObjects: [], seats: SEATS, enforcedOps: SCOPABLE });
  assert.equal(s.denominator, 1, 'only the enforced op counts');
  assert.ok(COVERED_OPS.includes('create'));
  assert.equal(COVERED_OPS.includes('post'), false, 'you cannot mutex a conversation (#646)');
  // Claims are already a compare-and-set under a write lock — a second claimant
  // gets an immediate 409 naming the holder, verified live. A bid window on top
  // of that would be strictly weaker and about twenty minutes slower.
  assert.equal(COVERED_OPS.includes('claim'), false, 'claims are atomic already');
});

test('#755-signals ⚠️ HUMAN ACTIONS ARE EXCLUDED FROM THE DENOMINATOR, and the exclusion is printed', () => {
  // The gate measures SEATS. A human's card edits would dilute the rate and
  // make the rail look better-obeyed than it is. The excluded count is
  // reported so the filter itself is auditable.
  const events = [ev('ada', 'update'), ev(null, 'update'), ev(undefined, 'update'), ev('stranger', 'update')];
  const s = signalTwoUngrantedActions({ events, workObjects: [], seats: SEATS, enforcedOps: SCOPABLE });
  assert.equal(s.denominator, 1, 'only the known seat counts');
  assert.equal(s.excludedNonSeat, 3);
});

test('#755-signals signal 2 numerator is structurally 0 while no work objects exist — and says so', () => {
  // ⚠️ This test used to assert /no work-object store/ for an EMPTY array,
  // which is the conflation the two tests further down split apart: an empty
  // store and an absent one are different facts. It now checks the property it
  // was always about — the numerator is structurally 0 and the output says so —
  // without caring which of the two reasons applies.
  const events = [ev('ada', 'update')];
  for (const workObjects of [null, []]) {
    const s = signalTwoUngrantedActions({ events, workObjects, seats: SEATS, enforcedOps: SCOPABLE });
    assert.equal(s.numerator, 0);
    assert.match(s.caveat, /STRUCTURAL ZERO/);
    assert.match(s.caveat, /not evidence of compliance/i);
  }
});

test('#755-signals with work objects present, an action inside an open window IS counted', () => {
  const events = [ev('ada', 'update', 'card', '2026-08-10T02:10:00.000Z')];
  const workObjects = [
    {
      id: 'wo-1',
      card: 700,
      declaredBy: 'ada',
      replyBy: '2026-08-10T02:20:00.000Z',
      required: ['ada', 'bo'],
      transitions: [
        { type: 'declare', by: 'ada', at: '2026-08-10T02:00:00.000Z' },
        { type: 'bid', by: 'ada', at: '2026-08-10T02:00:00.000Z' },
      ],
    },
  ];
  const s = signalTwoUngrantedActions({ events, workObjects, seats: SEATS, enforcedOps: SCOPABLE });
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
  const events = [ev('ada', 'update')];
  const s = signalTwoUngrantedActions({ events, workObjects: null, seats: SEATS, enforcedOps: SCOPABLE });
  assert.match(s.caveat, /no work-object store/i);
  assert.match(s.caveat, /not evidence of compliance/i);
});

test('#755-signals ⚠️ AN EMPTY STORE IS A DIFFERENT CAVEAT — the store exists and is empty', () => {
  const events = [ev('ada', 'update')];
  const s = signalTwoUngrantedActions({ events, workObjects: [], seats: SEATS, enforcedOps: SCOPABLE });
  assert.equal(/no work-object store/i.test(s.caveat || ''), false, 'still claiming there is no store');
  assert.match(s.caveat, /empty/i);
  // ⚠️ It is STILL not evidence of compliance — nothing can be counted as
  // ungranted when nothing was ever recorded. But it is a different reason.
  assert.match(s.caveat, /not evidence of compliance/i);
});

test('#755-signals a POPULATED store carries no caveat at all', () => {
  const events = [ev('ada', 'update', 'card', '2026-08-10T02:10:00.000Z')];
  const workObjects = [{
    id: 'wo-1', card: 700, declaredBy: 'ada', replyBy: '2026-08-10T02:20:00.000Z', required: ['ada', 'bo'],
    transitions: [
      { type: 'declare', by: 'ada', at: '2026-08-10T02:00:00.000Z' },
      { type: 'bid', by: 'ada', at: '2026-08-10T02:00:00.000Z' },
    ],
  }];
  const s = signalTwoUngrantedActions({ events, workObjects, seats: SEATS, enforcedOps: SCOPABLE });
  assert.equal(s.caveat, undefined);
  assert.equal(s.numerator, 1);
});

// ── ⛔ THE DENOMINATOR MUST BE DERIVED FROM WHAT IS ENFORCED ─────────────────
//
// Found when the board owner asked the obvious question: "how did we scope it to only
// creating a card? What if I said 'take on card nnn, coordinate'?"
//
//   the gate ENFORCES : card_create
//   the denominator COUNTED : create · update · move · claim · release
//
// So `0 / 65` read as "65 actions, zero violations" and MEANT "65 actions, 64
// of which the rail cannot see." The mismatch flattered us, on the first
// number the experiment ever produced.
//
// ⇒ The fix is not to correct the list. It is to stop having TWO lists. The
//   enforced set lives in the gate — the only place that knows what it wraps —
//   and the signal imports it. They cannot drift because there is nothing to
//   drift from.
//
// ⚠️ This is the MEASUREMENT half only. Whether the rail should be widened to
//    claim/move is a live question for the room and touches a running service.
//    Narrowing the denominator to the truth needs no restart and no permission.

test('#755-signals ⭐⭐ the denominator counts ONLY what the gate actually enforces', () => {
  assert.deepEqual([...COVERED_OPS], [...ENFORCED_OPS], 'two lists means they can disagree');
});

test('#755-signals ⛔ an action the rail cannot see is NOT in the denominator', () => {
  // A claim is the shape of "I am taking this card" — the exact scenario that
  // exposed the gap — and the gate does not wrap it today. Counting it would
  // credit us with compliance on an action nothing checks.
  const events = [ev('ada', 'create'), ev('ada', 'claim'), ev('ada', 'move'), ev('ada', 'update')];
  const s = signalTwoUngrantedActions({ events, workObjects: [], seats: SEATS, enforcedOps: SCOPABLE });
  assert.equal(s.denominator, 1, 'counted actions the gate does not enforce');
});

test('#755-signals the report NAMES the ops it counted, so the reach is visible', () => {
  // An instrument whose scope is invisible in its output is the defect this
  // whole card is a catalogue of.
  const events = [ev('ada', 'create')];
  const s = signalTwoUngrantedActions({ events, workObjects: [], seats: SEATS });
  assert.deepEqual(s.countedOps, [...ENFORCED_OPS]);
  assert.match(renderSignal('signal 2', s), /create/);
});

test('#755-signals widening the gate widens the denominator automatically', () => {
  // The property that makes this a fix rather than a patch: if the room later
  // gates card_claim, the measurement follows without anyone remembering to
  // update a second list.
  const events = [ev('ada', 'create'), ev('ada', 'claim')];
  const widened = signalTwoUngrantedActions({ events, workObjects: [], seats: SEATS, enforcedOps: ['create', 'claim'] });
  assert.equal(widened.denominator, 2);
  assert.deepEqual(widened.countedOps, ['create', 'claim']);
});

// ── ⛔⛔ #890 R4 — A RAIL WHOSE COVERED POPULATION IS EMPTY MUST SAY SO ───────
//
// The room's taxonomy names denominator defects R1–R3: a check that cannot run
// reports ERROR; an unwatched card reports UNWATCHED; the headline never counts
// watched and unwatched together. R4 is the same shape with an ENFORCEMENT verb
// instead of a reporting one:
//
//   ⇒ zero refusals and zero refusable actions are byte-identical from outside
//     the rail, and only the rail can tell them apart.

test('#890 R4 ⛔ every enforced op unscopable ⇒ UNMEASURABLE, never a zero', () => {
  const events = [ev('ada', 'create'), ev('bo', 'create')];
  const s = signalTwoUngrantedActions({ events, workObjects: [], seats: SEATS, enforcedOps: ['create'] });

  assert.equal(s.status, 'unmeasurable',
    'a 0/2 here would read as two compliant actions, and means two actions that '
    + 'could not have been violations no matter what the seats did');
  assert.equal('numerator' in s, false, 'the module contract: unmeasurable carries no number');
  assert.equal('denominator' in s, false);
  assert.match(s.missingInput, /cannot scope/i);
  assert.match(s.missingInput, /#889/, 'name the card that would restore measurability');
});

test('#890 R4 the diagnostics SURVIVE unmeasurable — the filter stays auditable', () => {
  // ⚠️ Dropping these was a real regression the CLI test caught: an unmeasurable
  // signal that hides its own population cannot be checked at all, which is a
  // quieter version of the silence R4 exists to break. The SCORE is what must
  // not print; what was counted and who was excluded are diagnostics.
  const events = [ev('ada', 'create'), ev('stranger', 'create')];
  const s = signalTwoUngrantedActions({ events, workObjects: [], seats: SEATS, enforcedOps: ['create'] });
  const line = renderSignal('signal 2', s);

  assert.match(line, /enforced ops counted: create/);
  assert.match(line, /1 non-seat action\(s\) excluded/);
  assert.equal(/\d+ *\/ *\d+/.test(line), false, 'a ratio leaked into an unmeasurable line');
});

test('#890 R4 ONE scopable op among unscopable ones keeps the signal measurable', () => {
  // ⭐ The boundary. R4 fires only when NOTHING counted can be a violation — not
  // whenever an unscopable op appears. Otherwise gating update AND create would
  // silently blind the instrument to the update violations it can see.
  const events = [ev('ada', 'create'), ev('ada', 'update', 'card', '2026-08-10T02:10:00.000Z')];
  const workObjects = [{
    id: 'wo-1', card: 700, declaredBy: 'ada', replyBy: '2026-08-10T02:20:00.000Z', required: ['ada', 'bo'],
    transitions: [
      { type: 'declare', by: 'ada', at: '2026-08-10T02:00:00.000Z' },
      { type: 'bid', by: 'ada', at: '2026-08-10T02:00:00.000Z' },
    ],
  }];
  const s = signalTwoUngrantedActions({ events, workObjects, seats: SEATS, enforcedOps: ['create', 'update'] });
  assert.equal(s.status, 'measured');
  assert.equal(s.numerator, 1, 'the update inside the open window on #700 is a real violation');
  assert.equal(s.denominator, 2, 'and the unscopable create still counts as an ACTION');
});

test('#890 ⭐⭐⭐ the instrument and the gate cannot disagree — they call the same function', async () => {
  // ⛔ THE WHOLE CARD. Before this, each held its own copy of the rule; they
  // agreed until #886 changed one, and then the instrument spent an afternoon
  // reporting 10/10 violations the gate permitted.
  //
  // ⚠️ Asserting "signal 2 matches on the card" would NOT catch a recurrence —
  // that is a third expression of the rule, correct on the day it is written.
  // This asserts they produce the SAME ANSWER on cases chosen to straddle every
  // boundary the rule has: right seat/wrong card, wrong seat/right card, both.
  const { decideCoveredAction } = await import('../core/work-gate.mjs');
  const wo = {
    id: 'wo-1', card: 700, declaredBy: 'ada', replyBy: '2026-08-10T02:20:00.000Z', required: ['ada', 'bo'],
    transitions: [
      { type: 'declare', by: 'ada', at: '2026-08-10T02:00:00.000Z' },
      { type: 'bid', by: 'ada', at: '2026-08-10T02:00:00.000Z' },
    ],
  };
  const AT = '2026-08-10T02:10:00.000Z';

  for (const [actor, card] of [['ada', 700], ['ada', 701], ['bo', 700], ['cy', 700]]) {
    const s = signalTwoUngrantedActions({
      events: [ev(actor, 'update', 'card', AT, card)],
      workObjects: [wo], seats: SEATS, enforcedOps: ['update'],
    });
    const gateRefuses = decideCoveredAction({ actor, card, workObjects: [wo], now: AT }).allow === false;
    assert.equal(s.numerator === 1, gateRefuses,
      `instrument and gate disagree for ${actor} on #${card} — the predicate has forked again`);
  }
});
