/**
 * core/sprint-signals.mjs — #755's REVIEW INSTRUMENT.
 *
 * The sprint carries three pre-registered abandon signals. Until this file
 * existed, not one of them had anything that could compute it — so on the
 * closing day somebody would have sat down and NARRATED the verdict. That is
 * precisely the failure #762's guard names: "every outcome narrates as a
 * lesson; a sprint that produced nothing reports 'we learned it's harder than
 * we thought.'"
 *
 * ── THE RULE THAT SHAPES EVERYTHING HERE ────────────────────────────────────
 *
 * Signal 1 is "ZERO contested bids after 20+ real bids ⇒ abandon the window."
 * If this instrument printed `0 contests` because it could not SEE bids, that
 * would read as signal 1 FIRING — an abandon verdict for the sprint's central
 * mechanism, manufactured out of missing instrumentation, and indistinguishable
 * from a result.
 *
 * ⇒ So every signal returns exactly one of:
 *
 *     measured      { numerator, denominator }
 *     unmeasurable  { missingInput }   ← and NO number, ever
 *     zero          { numerator: 0, denominator: >0 }
 *
 * ⇒ And `0` over an empty denominator is NOT a zero. It is unmeasurable.
 *   An instrument that reports a number where it has no input is worse than no
 *   instrument: the gap is visible, a plausible zero is not.
 *
 * ── WHAT IS ACTUALLY COMPUTABLE TODAY ───────────────────────────────────────
 *   ✅ signal 2's DENOMINATOR   the event log carries actor · op · occurred_at
 *   ⛔ signal 2's NUMERATOR     needs work objects; no store ⇒ structurally 0
 *   ⛔ signal 1's BID COUNT     bids are PROSE. See below.
 *   ⛔ signal 3                 human-supplied by construction
 *
 * ⇒ One of four. That IS the day-one finding, and it is reported every time
 *   this runs rather than discovered on the closing day.
 */

import { stateAt, STATES } from './work-auction.mjs';

/**
 * The board-mediated actions a work gate can reach (#755's railable list).
 *
 * ⛔ `post` is deliberately absent. You cannot mutex a conversation (#646) —
 * a protocol that covered speech would deadlock its own negotiation, since
 * answering a bid would breach the window the bid opened.
 */
export const COVERED_OPS = Object.freeze(['create', 'update', 'move', 'claim', 'release']);

const unmeasurable = (missingInput, extra = {}) => ({ status: 'unmeasurable', missingInput, fires: false, ...extra });

function scored(numerator, denominator, extra = {}) {
  if (denominator === 0) throw new Error('scored() called with an empty denominator — that is unmeasurable, not zero');
  return { status: numerator === 0 ? 'zero' : 'measured', numerator, denominator, ...extra };
}

/**
 * SIGNAL 1 — "ZERO contested bids after 20+ real bids ⇒ the window bought
 * nothing; abandon it and keep the public work object."
 *
 * ⛔ IT REFUSES TO COUNT PROSE. Bids currently live as sentences in the
 * commons, and this room MEASURED why that cannot be parsed: a refusal and a
 * politeness are the same string. One seat's harness re-emitted "Nothing to
 * add on my side" eleven times in forty-seven minutes, including seven seconds
 * after the post that asked whether it was a refusal. Any counter over prose
 * would have scored those as answers.
 *
 * ⇒ Not best-effort. Not heuristic. UNMEASURABLE until bids are records.
 */
export function signalOneContestedBids({ bidRecords }) {
  if (!Array.isArray(bidRecords)) {
    return unmeasurable(
      'no bid RECORDS exist — bids are prose in the commons, and a token is required before they can be counted',
    );
  }
  const denominator = bidRecords.length;
  if (denominator === 0) return unmeasurable('no bids have been recorded yet');

  const numerator = bidRecords.filter((b) => b.contested).length;

  // ⚠️ The threshold is part of the signal, not decoration. "ZERO contested
  // bids AFTER 20+ REAL BIDS" — three bids with no contest is a small sample,
  // not a finding. Firing early is how a pre-registered signal becomes a story.
  const THRESHOLD = 20;
  const fires = numerator === 0 && denominator >= THRESHOLD;

  return scored(numerator, denominator, {
    fires,
    note: fires
      ? `FIRES: ${denominator} bids, none contested`
      : `does not fire: needs 0 contested across 20+ bids (have ${denominator})`,
  });
}

/**
 * SIGNAL 2 (v2) — "from the moment the adapter is LIVE: any covered action by
 * a seat holding an open work object, taken without a recorded grant.
 * Denominator: covered actions in the same period."
 *
 * ⚠️ Human actions are EXCLUDED. The gate measures seats; the owner's browser
 * edits would dilute the rate and make the rail look better-obeyed than it is.
 * The excluded count is returned so the filter is auditable rather than a
 * silent narrowing — an instrument's reach must be visible in its output.
 */
export function signalTwoUngrantedActions({ events, workObjects, seats }) {
  const seatSet = new Set(seats);
  const covered = events.filter((e) => COVERED_OPS.includes(e.op));
  const bySeat = covered.filter((e) => e.actor && seatSet.has(e.actor));
  const excludedNonSeat = covered.length - bySeat.length;

  if (bySeat.length === 0) {
    return unmeasurable('no covered actions by a known seat in this period', { excludedNonSeat });
  }

  const numerator = bySeat.filter((e) => {
    // Did this actor hold an OPEN window at the moment they acted?
    return workObjects.some((wo) => {
      const s = stateAt(wo, e.occurred_at);
      if (!s.bidders.includes(e.actor)) return false;
      return s.state === STATES.OPEN || s.state === STATES.BIDDING || s.state === STATES.ARBITRATION_DUE;
    });
  }).length;

  // ⚠️ A structural zero is the worst cell on this report: it looks like "no
  // bypasses" and means "no instrument". Say which one it is, in the output.
  const caveat = workObjects.length === 0
    ? 'STRUCTURAL ZERO: there is no work-object store, so no action CAN be counted as ungranted. This is not evidence of compliance.'
    : undefined;

  return scored(numerator, bySeat.length, { excludedNonSeat, caveat });
}

/**
 * SIGNAL 3 — "the two unkeyed race shapes recur and v1 is structurally blind
 * to them ⇒ the experiment succeeds while aimed at the wrong third."
 *
 * ⛔ THIS CAN NEVER COME FROM THE LOG, and that is not a limitation to be
 * engineered away — it is the definition of the blind spot. It requires a
 * human to notice a duplicate the protocol never opened a bid for. An
 * instrument cannot report on the events it structurally cannot see.
 *
 * ⇒ So the slot exists, is loud, and stays empty until a person fills it.
 */
export function signalThreeOutOfBand({ humanSuppliedCount }) {
  if (typeof humanSuppliedCount !== 'number') {
    return unmeasurable(
      'requires a HUMAN-supplied count of duplicates the protocol never saw — this number cannot come from the log, by construction',
    );
  }
  if (humanSuppliedCount === 0) {
    return { status: 'zero', numerator: 0, denominator: 1, source: 'human', fires: false };
  }
  return { status: 'measured', numerator: humanSuppliedCount, denominator: humanSuppliedCount, source: 'human', fires: true };
}

/** One line per signal. An unmeasurable line carries no ratio to misread. */
export function renderSignal(label, s) {
  if (s.status === 'unmeasurable') {
    return `${label}: UNMEASURABLE — ${s.missingInput}`;
  }
  const verdict = s.fires ? 'FIRES' : 'does not fire';
  const bits = [`${label}: ${s.numerator} / ${s.denominator}`, verdict];
  if (s.excludedNonSeat) bits.push(`(${s.excludedNonSeat} non-seat action(s) excluded)`);
  if (s.caveat) bits.push(`⚠️ ${s.caveat}`);
  if (s.note) bits.push(s.note);
  return bits.join(' · ');
}
