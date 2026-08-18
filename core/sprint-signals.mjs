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
 *                              AND entity{kind, id, shortId} — measured 2014/2014
 *                              card events carry shortId, 0 without. ⚠️ THAT OMISSION
 *                              COST TWO SEATS SIX HOURS: both read this inventory as
 *                              exhaustive and neither looked at `entity`, so one went
 *                              off to build a uuid→shortId resolver for a value that
 *                              was already in the parameter. An incomplete inventory
 *                              of a surface is a CLAIM about what it does not have.
 *                              (The replica is different: it drops entity.shortId and
 *                              needs a join — same name, two surfaces, #891.)
 *   ⛔ signal 2's NUMERATOR     needs work objects; no store ⇒ structurally 0
 *   ⛔ signal 1's BID COUNT     bids are PROSE. See below.
 *   ⛔ signal 3                 human-supplied by construction
 *
 * ⇒ One of four. That IS the day-one finding, and it is reported every time
 *   this runs rather than discovered on the closing day.
 */

import { stateAt, STATES } from './work-auction.mjs';
import { ENFORCED_OPS, UNSCOPABLE_OPS, holdsOpenWindow } from './work-gate.mjs';

/**
 * The board-mediated actions a work gate can reach (#755's railable list).
 *
 * ⛔ `post` is deliberately absent. You cannot mutex a conversation (#646) —
 * a protocol that covered speech would deadlock its own negotiation, since
 * answering a bid would breach the window the bid opened.
 */
export const COVERED_OPS = ENFORCED_OPS;

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
export function signalTwoUngrantedActions({ events, workObjects, seats, enforcedOps = ENFORCED_OPS }) {
  // ⚠️ NULL AND EMPTY ARE DIFFERENT FACTS, and they mean opposite things about
  // the evidence:
  //   null → no store is configured. The instrument does not exist and the
  //          zero is meaningless.
  //   []   → the store exists and has recorded nothing, which is expected
  //          while the flag is off, and becomes a REAL zero over a real
  //          denominator once it is armed.
  //
  // The first version branched on `length === 0` and printed "there is no
  // work-object store" for both. It said that the morning AFTER the store
  // landed — a stale caveat about a condition that had ended, inside the
  // instrument built to stop exactly that.
  const storeConfigured = Array.isArray(workObjects);
  const objects = storeConfigured ? workObjects : [];
  const seatSet = new Set(seats);
  const covered = events.filter((e) => enforcedOps.includes(e.op));
  const bySeat = covered.filter((e) => e.actor && seatSet.has(e.actor));
  const excludedNonSeat = covered.length - bySeat.length;

  if (bySeat.length === 0) {
    return unmeasurable('no covered actions by a known seat in this period', { excludedNonSeat, countedOps: [...enforcedOps] });
  }

  // ⛔⛔ #890 R4 — AN INSTRUMENT THAT CANNOT REPRODUCE THE RULE MUST SAY SO.
  //
  // If every op we count is one the gate structurally cannot scope, then no
  // action in this denominator CAN be a violation, and a 0/N here would read as
  // compliance when it means "the population cannot contain a violation". That
  // is the same defect `scored()` refuses one function up: an empty denominator
  // is unmeasurable, not zero.
  //
  // ⚠️ Today ENFORCED_OPS is ['create'] and create is unscopable, so this fires
  // in production. That is not a bug in this signal — it is #889 showing through
  // the instrument, which is exactly what an instrument is for.
  const scopable = [...enforcedOps].filter((op) => !UNSCOPABLE_OPS.includes(op));
  if (scopable.length === 0) {
    return unmeasurable(
      `every enforced op (${[...enforcedOps].join(', ')}) is one the gate cannot scope to a card, `
      + 'so no counted action can be a violation and a zero here would mean nothing. See #889.',
      { excludedNonSeat, countedOps: [...enforcedOps], unscopableOps: [...UNSCOPABLE_OPS] },
    );
  }

  const numerator = bySeat.filter((e) => {
    // ⛔⛔ #890 — AN UNSCOPABLE OP CANNOT BE A VIOLATION, PER EVENT.
    //
    // Caught by this card's own boundary test, and it is the whole defect in
    // miniature. A `create` event RECORDS the shortId of the card it brought
    // into existence, so after the fact it looks exactly like an action
    // targeting that card — and if the actor held a window on it, the
    // instrument would score a violation the gate COULD NOT HAVE REFUSED,
    // because at decision time no card existed to compare.
    //
    // ⇒ The per-list R4 check above is not enough on its own: it only fires
    //   when EVERY enforced op is unscopable. This is the same rule applied
    //   where a single mixed event set would otherwise slip through.
    //
    // ⚠️ It stays in the DENOMINATOR. It was a real action by a real seat; it
    // simply cannot be a bypass. Dropping it from both would flatter the rate.
    if (UNSCOPABLE_OPS.includes(e.op)) return false;

    // ⭐⭐⭐ #890 — THE RULE IS ASKED OF THE MODULE THAT ENFORCES IT.
    //
    // This used to be a hand-written copy that matched on the actor alone. It
    // agreed with the gate until #886 scoped the gate to the declared card, and
    // then this instrument spent an afternoon reporting 10/10 violations of a
    // rule the gate no longer implemented — every one of them permitted.
    //
    // ⚠️ The test built to catch that divergence (COVERED_OPS deepEqual
    // ENFORCED_OPS) was green the whole time, because the previous instance was
    // two LISTS and this one was the PREDICATE. Sharing a constant is not
    // sharing a rule.
    //
    // `e.entity?.shortId` is the raw log's own field, the same identifier space
    // `wo.card` holds — no join, no resolution. A `post` event has no shortId
    // and correctly matches NO window rather than every one.
    return holdsOpenWindow({
      actor: e.actor,
      card: e.entity?.shortId ?? null,
      workObjects: objects,
      now: e.occurred_at,
    }) !== null;
  }).length;

  // ⚠️ A structural zero is the worst cell on this report: it looks like "no
  // bypasses" and means "no instrument". Say WHICH one it is, in the output —
  // and there are two different ones.
  let caveat;
  if (!storeConfigured) {
    caveat = 'STRUCTURAL ZERO: no work-object store is configured, so no action CAN be counted as ungranted. This is not evidence of compliance.';
  } else if (objects.length === 0) {
    caveat = 'STRUCTURAL ZERO: the work-object store is configured and EMPTY — nothing has been recorded, which is expected while the gate is unarmed. This is not evidence of compliance.';
  }

  return scored(numerator, bySeat.length, { excludedNonSeat, caveat, countedOps: [...enforcedOps] });
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
    // ⚠️ #890 — THE DIAGNOSTICS SURVIVE UNMEASURABLE, the SCORE does not.
    //
    // The rule this file exists to enforce is "no number where there is no
    // input", and a ratio is the number that misleads. But how many actions
    // were counted and how many were excluded are not a score — they are what
    // makes the FILTER auditable, and dropping them meant an unmeasurable
    // signal could not be checked at all. R4's whole point is that a rail
    // covering nothing must say so LOUDLY, and a one-line "UNMEASURABLE" that
    // hides its own population is a quieter version of the same silence.
    const bits = [`${label}: UNMEASURABLE — ${s.missingInput}`];
    if (s.countedOps) bits.push(`[enforced ops counted: ${s.countedOps.join(', ')}]`);
    if (s.excludedNonSeat) bits.push(`(${s.excludedNonSeat} non-seat action(s) excluded)`);
    return bits.join(' · ');
  }
  const verdict = s.fires ? 'FIRES' : 'does not fire';
  const bits = [`${label}: ${s.numerator} / ${s.denominator}`, verdict];
  if (s.countedOps) bits.push(`[enforced ops counted: ${s.countedOps.join(', ')}]`);
  if (s.excludedNonSeat) bits.push(`(${s.excludedNonSeat} non-seat action(s) excluded)`);
  if (s.caveat) bits.push(`⚠️ ${s.caveat}`);
  if (s.note) bits.push(s.note);
  return bits.join(' · ');
}
