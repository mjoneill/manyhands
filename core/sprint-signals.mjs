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
 *   ⛔ signal 2                 RETIRED with the work ledger (#1763): it answers `retired`
 *   ⛔ signal 1's BID COUNT     bids are PROSE. See below.
 *   ⛔ signal 3                 human-supplied by construction
 *
 * ⇒ One of four. That IS the day-one finding, and it is reported every time
 *   this runs rather than discovered on the closing day.
 */


/**
 * The board-mediated actions a work gate can reach (#755's railable list).
 *
 * ⛔ `post` is deliberately absent. You cannot mutex a conversation (#646) —
 * a protocol that covered speech would deadlock its own negotiation, since
 * answering a bid would breach the window the bid opened.
 */
// #1763 — the work gate is RETIRED, so no board action is gated any more.
export const COVERED_OPS = Object.freeze([]);
export const WORK_LEDGER_RETIRED = Object.freeze({ since: '2026-08-18', card: '#1763' });

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
 * SIGNAL 2 — RETIRED with the work ledger (#1763, owner 2026-10-27: "let it go"). It measured whether seats honoured the
 * #755 work gate's windows; the gate and its ledger are gone (no transition since 2026-08-18), so there is nothing to
 * measure. It answers `retired`, never fires, and reads no ledger — whatever is passed in.
 */
export function signalTwoUngrantedActions() {
  return { status: 'retired', fires: false, ...WORK_LEDGER_RETIRED, reason: 'the work ledger and its gate are retired' };
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
  if (s.status === 'retired') return `${label}: RETIRED since ${s.since} (${s.card}) — ${s.reason}`;
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
