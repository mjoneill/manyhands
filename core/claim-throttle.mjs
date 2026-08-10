/**
 * core/claim-throttle.mjs — #755 BRANCH E. the board owner's design, 2026-08-10.
 *
 * A claim is refused if it arrives within a cooldown of a DIFFERENT seat's
 * claim, and the refusal asks the question the seat should have asked:
 *
 *   "Claim cooldown is in effect. Was a claim for this already acknowledged
 *    (bid by someone else)? If not, you can retry in N seconds."
 *
 * ── WHY THIS AND NOT THE THREE BRANCHES THE ROOM PROPOSED ───────────────────
 * Measured against three real collisions and a 21-incident corpus:
 *
 *   A enforcement            needs a declaration to exist  ⇒ 3 of 3 had none
 *   B visibility             needs a declaration to exist  ⇒ empty, 3 of 3
 *   C action-as-declaration  needs a shared KEY            ⇒ 0 of 3, unkeyed
 *   E throttle               needs NEITHER
 *
 * ⭐⭐ Two properties do the work, and neither belongs to A/B/C:
 *
 * 1. IT NEVER DECIDES WHETHER TWO THINGS ARE THE SAME WORK. That question
 *    killed C — every real collision was unkeyed, two seats reacting to
 *    different triggers with nothing to match them on.
 *
 * 2. IT FIRES ON THE ATTEMPT, NOT ON REMEMBERING. Every other variant, and the
 *    author's own standing notes, failed the same way in one afternoon: the
 *    moment of action does not pause to consult a rule. So the rule has to sit
 *    in the path rather than in anyone's memory.
 *
 * ⇒ It does not PREVENT the duplicate. It converts an invisible collision into
 *   a visible one — the second seat is delayed until the first seat's card
 *   exists, so the retry happens in a world where there is something to see.
 *   That is why the message matters as much as the delay.
 *
 * ── COST, MEASURED BEFORE IT WAS BUILT ──────────────────────────────────────
 *   60s ⇒ 16 of 21 historical incidents intercepted, for 5 delays.
 *
 * ⚠️⚠️ REPORT THE REACHABLE DENOMINATOR, NOT THE TOTAL:
 *        5 of 125 reachable  = 4.0 %   ⇐ the cost anyone actually feels
 *        5 of 702 total      = 0.71 %  ⇐ true, and six-fold flattering
 *
 *   375 of 500 sampled cards carry `createdBy: null` and are exempt BY
 *   CONSTRUCTION — the rule cannot fire on them, ever. Counting them in the
 *   denominator makes cases the rule can never reach look like cases it passed.
 *
 * ⛔ This is the SAME defect as ENFORCED_OPS: a denominator counting five ops
 *    while the gate enforced one, "0/65" that was really "0/6". That fix
 *    shipped the same morning this table was published with the identical
 *    error in it. The exempt population is invisible in the output, which is
 *    why it recurs — a rule that cannot fire leaves no trace on what it skipped.
 *
 * ⚠️ AND BOTH KNOWN ERRORS POINT THE SAME WAY, in this branch's favour:
 *    `createdBy` postdates #631, so pre-#631 AGENT cards are exempted as if
 *    they were human. Some of the 375 are therefore collisions the rule SHOULD
 *    have caught, counted as passes.
 *      ⇒ 5 delays is a LOWER bound.  ⇒ 76 % coverage is an UPPER bound.
 *
 *   Table produced by scripts/race-corpus.mjs by a seat who argued for stopping
 *   instead; every error found so far has run against this branch, and it has
 *   been corrected in its favour three times by its own opponent.
 *
 * ── FAIL OPEN ───────────────────────────────────────────────────────────────
 * Throttling requires establishing that two DIFFERENT NAMED seats acted inside
 * the window. Anything unknown allows. A rail whose failure mode is "the board
 * stops accepting cards" is worse than the problem it solves.
 */

/** The measured efficiency peak. 10s catches 38%; 60s catches 76% at the same cost. */
export const COOLDOWN_MS = 60_000;

/** Named here so a caller cannot re-derive it and disagree. */
export const THROTTLE_REASON = '#755 claim cooldown';

/**
 * May `actor` claim right now?
 *
 * @param {object}   arg
 * @param {?string}  arg.actor      seat key; null/absent is the HUMAN PATH
 * @param {?object}  arg.previous   { actor, at } of the most recent claim, or null
 * @param {string}   arg.now        ISO timestamp. Required, never defaulted.
 * @param {number}  [arg.cooldownMs]
 * @returns {{allow: boolean, reason?: string, retryAfterSeconds?: number, message?: string}}
 */
export function decideThrottle({ actor, previous, now, cooldownMs = COOLDOWN_MS }) {
  if (!now) throw new Error('decideThrottle: now is required — this module never reads the wall clock');

  // ⛔ THE HUMAN PATH, EXEMPT BY CONSTRUCTION.
  //
  // 375 of 500 cards carry createdBy:null — every card the owner files through
  // the browser. "Same seat" cannot rescue him: null is not a seat, so two
  // consecutive human filings look exactly like two strangers racing. Without
  // this line the owner is refused in his own board by a rail built to keep his
  // agents from colliding. He cannot race himself through a form.
  if (!actor) return { allow: true };

  // Nothing to be second to.
  if (!previous || !previous.at) return { allow: true };

  // ⛔ Fail open on an unknown predecessor. It is not established that a
  // DIFFERENT seat acted, so it is not established that this is a race — and
  // most of the board's history has no recorded author at all.
  if (!previous.actor) return { allow: true };

  // ⛔ One seat cannot race itself. Bulk filing is not a collision, and on the
  // measurable subset it is 8 of 13 of everything inside the window.
  if (previous.actor === actor) return { allow: true };

  const elapsedMs = Date.parse(now) - Date.parse(previous.at);
  if (!Number.isFinite(elapsedMs) || elapsedMs >= cooldownMs) return { allow: true };

  // Always at least one second: a refusal that says "retry in 0 seconds" is a
  // refusal with no remedy attached.
  const retryAfterSeconds = Math.max(1, Math.ceil((cooldownMs - elapsedMs) / 1000));

  return {
    allow: false,
    reason: THROTTLE_REASON,
    retryAfterSeconds,
    // ⭐ The question is the visibility layer. The room spent a day establishing
    // that a board of open declarations renders empty at the moment it is
    // needed; this arrives where the seat already is, at the instant it acts.
    message:
      `Claim cooldown is in effect — ${previous.actor} claimed ${Math.round(elapsedMs / 1000)}s ago. `
      + 'Has this work already been claimed or acknowledged by someone else? '
      + `Check first. If not, you can retry in ${retryAfterSeconds} seconds.`,
  };
}
