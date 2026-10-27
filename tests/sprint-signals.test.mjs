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

const SEATS = ['ada', 'bo', 'cy'];

// ── the three-state contract, which is the point of the file ────────────────

test('#755-signals a signal is exactly one of measured | unmeasurable | zero | retired', () => {
  for (const s of [
    signalOneContestedBids({ bidRecords: null }),
    signalTwoUngrantedActions(),
    signalThreeOutOfBand({ humanSuppliedCount: null }),
  ]) {
    assert.ok(['measured', 'unmeasurable', 'zero', 'retired'].includes(s.status), `bad status: ${s.status}`);
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

test('#755-signals renderSignal NEVER prints a bare number for an unmeasurable signal', () => {
  const line = renderSignal('signal 1', signalOneContestedBids({ bidRecords: null }));
  assert.match(line, /UNMEASURABLE/);
  assert.equal(/\b\d+ *\/ *\d+/.test(line), false, 'a ratio leaked into an unmeasurable line');
});

// ── signal 2: the denominator is real today; the numerator is not ───────────

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

// ── #1763 — SIGNAL 2 IS RETIRED with the work ledger ────────────────────────
test('#1763 signal 2 answers RETIRED, never fires, and reads nothing it is handed', () => {
  const s = signalTwoUngrantedActions({ events: [{ op: 'update' }], workObjects: [{ id: 'w' }], seats: ['ada'] });
  assert.equal(s.status, 'retired'); assert.equal(s.fires, false); assert.equal(s.since, '2026-08-18'); assert.equal(s.card, '#1763');
  assert.equal('numerator' in s || 'denominator' in s, false, 'a retired signal carries no score');
  assert.match(renderSignal('SIGNAL 2', s), /^SIGNAL 2: RETIRED since 2026-08-18 \(#1763\)/);
});

test('#1763 no board action is gated any more: COVERED_OPS is empty', () => {
  assert.deepEqual([...COVERED_OPS], []);
});
