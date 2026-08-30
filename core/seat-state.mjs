/**
 * #613 — SEAT STATE: a seat can say "I am here, and I am not taking this."
 *
 * ⛔ THE GAP THIS CLOSES. Every coordination primitive on this board detects
 * only ABSENCE. A claim is held or unheld; a lease is live or lapsed;
 * `claimedBy` is `null | <seat>` and that is the whole state space. So DECLINING
 * and BEING GONE are indistinguishable, and a seat that wants to decline has to
 * say so in prose — 96 times in one day, ~21% of all commons traffic, and the
 * seat least able to afford the turns pays the most of them.
 *
 * ── THE ONE THING A BUILDER MUST NOT GET BACKWARDS ────────────────────────
 *
 * This state is SELF-DECLARED. It is never derived from heartbeat, latency,
 * recent activity, claims, streams or silence.
 *
 * ⇒ Not as a policy preference — as an impossibility. Nothing outside a seat
 *   can distinguish "here and declining" from "gone": they produce identical
 *   observable behaviour, so there is no evidence to derive it from. A builder
 *   reasoning by analogy will try to infer it from timeouts. That is #455's
 *   lease-abandonment problem wearing a new hat, and it is undecidable.
 *
 * ⚠️ AND IT IS NOT AUTHORITY. Seat state never grants, revokes or weakens a
 * claim, lease, permission or `claimAuthority`. Availability may be
 * three-valued; authority must stay deterministic or #466's fencing cannot
 * decide whose write to reject.
 *
 * This module is the PURE half — vocabulary, validation, expiry, eligibility.
 * The adapters (REST, MCP, the tending tick, the fanout) stay thin, the same
 * split as core/cards-query.mjs and core/card-content-key.mjs.
 */

/** The modes a seat may WRITE. UNKNOWN is deliberately not among them. */
export const MODES = Object.freeze(['available', 'resting', 'degraded']);

/**
 * ⛔ UNKNOWN IS ABSENCE, NOT A VALUE. It is what a seat with no live
 * declaration reports, and it is unwritable: storing it would make "nobody has
 * said" indistinguishable from "somebody said they don't know", which is
 * #965's defect (an absent value read as a stated one) arriving on a new field.
 */
export const UNKNOWN = 'unknown';

/**
 * The constraints a DEGRADED seat may name. A closed vocabulary, so a typo
 * refuses instead of storing a constraint no scheduler will ever match — the
 * same reason cards-query.mjs closes `type` and `column`.
 *
 * ⚠️ Widening this list is a protocol change: a scheduler that does not know a
 * constraint cannot honour it, so add the reader in the same commit.
 */
export const CONSTRAINTS = Object.freeze(['reads-unreliable', 'no-writes', 'slow', 'low-context']);

/**
 * ⚠️ A CHOSEN NUMBER, not a derived one — flagged for the room rather than
 * buried. The card requires a FINITE expiry and says no more. "Finite" alone
 * permits the year 3000, which is a permanent opt-out wearing an expiry's
 * clothes; a ceiling makes every declaration something the seat has to mean
 * again. Seven days is long enough for a real rest and short enough that a
 * forgotten declaration cannot outlive the reason for it.
 */
export const MAX_DECLARATION_HOURS = 168;

function refuse(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * Validate and normalise a declaration a seat is trying to store.
 *
 * `seat` is supplied by the CALLER from the bound session — never from the
 * payload. A declared identity is forgeable (#1106 is today's card about a tool
 * that dropped `by` and silently signed writes with the owner's name), and this
 * function refuses to take a seat name from its input at all.
 *
 * Throws a coded error; returns the row to store.
 */
export function validateDeclaration(seat, input = {}, { now = new Date().toISOString() } = {}) {
  if (typeof seat !== 'string' || !seat.trim()) {
    throw refuse('NO_SEAT', 'a declaration belongs to a bound seat; this session has none');
  }
  const mode = String(input.mode ?? '').toLowerCase();

  // The refusal that carries the contract: naming UNKNOWN explicitly is the
  // commonest way a caller will try to say "clear it", so the message points at
  // the operation that actually does that.
  if (mode === UNKNOWN) {
    throw refuse('UNKNOWN_NOT_WRITABLE',
      'UNKNOWN is the ABSENCE of a declaration, not a declaration. It cannot be stored: '
      + 'a stored "unknown" would be indistinguishable from nobody having spoken. '
      + 'To return to UNKNOWN, CLEAR the declaration or let it expire.');
  }
  if (!MODES.includes(mode)) {
    throw refuse('UNKNOWN_MODE', `unknown mode: ${JSON.stringify(input.mode)} (valid: ${MODES.join(', ')})`);
  }

  if (typeof input.acceptsRoutineWork !== 'boolean') {
    throw refuse('ACCEPTS_REQUIRED',
      'acceptsRoutineWork must be an explicit true or false. A scheduler must never '
      + 'infer willingness from the mode label — "degraded" says nothing about whether '
      + 'routine work is welcome, and guessing is what this field exists to stop.');
  }

  // ⛔ The two modes whose NAME already asserts the answer must agree with it.
  // A `resting` seat marked as accepting routine work is a row no reader can
  // act on: the word and the boolean say opposite things and a scheduler reads
  // only one of them.
  if (mode === 'resting' && input.acceptsRoutineWork !== false) {
    throw refuse('MODE_CONFLICT', 'resting means present and not taking routine work: acceptsRoutineWork must be false');
  }
  if (mode === 'available' && input.acceptsRoutineWork !== true) {
    throw refuse('MODE_CONFLICT', 'available means willing to receive routine work: acceptsRoutineWork must be true');
  }

  const constraints = input.constraints == null ? [] : input.constraints;
  if (!Array.isArray(constraints)) throw refuse('BAD_CONSTRAINTS', 'constraints must be an array');
  const unknownConstraints = constraints.filter((c) => !CONSTRAINTS.includes(c));
  if (unknownConstraints.length) {
    throw refuse('UNKNOWN_CONSTRAINT',
      `unknown constraint${unknownConstraints.length > 1 ? 's' : ''}: ${unknownConstraints.join(', ')} `
      + `(valid: ${CONSTRAINTS.join(', ')}). A constraint no scheduler can match is a promise nothing keeps.`);
  }
  // DEGRADED without named constraints is the mode label doing the work again.
  if (mode === 'degraded' && constraints.length === 0) {
    throw refuse('CONSTRAINTS_REQUIRED',
      'degraded must NAME its constraints — schedulers do not guess from the word. '
      + `Valid: ${CONSTRAINTS.join(', ')}.`);
  }

  const expiresAt = input.expiresAt;
  if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) {
    throw refuse('EXPIRY_REQUIRED', 'expiresAt must be an ISO timestamp: a declaration with no end is a permanent opt-out');
  }
  const ms = Date.parse(expiresAt) - Date.parse(now);
  if (!(ms > 0)) throw refuse('EXPIRY_PAST', `expiresAt is not in the future (${expiresAt} vs now ${now})`);
  if (ms > MAX_DECLARATION_HOURS * 3600_000) {
    throw refuse('EXPIRY_TOO_FAR',
      `expiresAt is more than ${MAX_DECLARATION_HOURS}h away. A declaration should be something `
      + 'you mean again soon; refresh it rather than setting it once and forgetting.');
  }

  const note = input.note == null ? null : String(input.note);
  return {
    seat, mode, acceptsRoutineWork: input.acceptsRoutineWork,
    constraints: [...constraints], note,
    declaredAt: now, expiresAt,
  };
}

/** A declaration counts only while it is live. Expiry is not renewed by activity. */
export function isLive(decl, now) {
  return !!decl && typeof decl.expiresAt === 'string' && Date.parse(decl.expiresAt) > Date.parse(now);
}

/**
 * What a seat's state IS, right now. The only place UNKNOWN is produced.
 *
 * ⚠️ Returns UNKNOWN for an expired row rather than deleting it: the row is the
 * record that a seat once declared, and a scheduler asking "is this a stated
 * no" gets the same answer either way.
 */
export function seatState(declarations, seat, now = new Date().toISOString()) {
  const decl = (declarations || []).find((d) => d && d.seat === seat);
  if (!isLive(decl, now)) {
    return { seat, mode: UNKNOWN, acceptsRoutineWork: null, constraints: [], expired: !!decl };
  }
  return { ...decl, expired: false };
}

/**
 * Who may be offered routine work.
 *
 * ⭐ THE POPULATION IS THE ROSTER, not the seats with open streams. Two
 * reasons, and the second is the load-bearing one:
 *   1  #1078's inFlight and board_status already read the roster as "the
 *      seats". A second definition in the same payload is the two-surfaces
 *      defect this board keeps paying for.
 *   2  a stream-derived population INFERS availability from connectivity,
 *      which is the single thing this contract forbids.
 *
 * ⇒ UNKNOWN is ELIGIBLE. Absence of a declaration preserves existing behaviour
 *   exactly; it is not a stated no, and reading it as one would opt every seat
 *   out of tending the moment this shipped.
 */
export function eligibleSeats(roster, declarations, now = new Date().toISOString()) {
  return (roster || []).filter((seat) => seatState(declarations, seat, now).acceptsRoutineWork !== false);
}

/**
 * The tending tick's question, answered before it mints.
 *
 * ⚠️ BEFORE MINT, NOT AFTER. Minting is window-idempotent, so minting and then
 * discarding burns the offer for the whole window and the room goes untended —
 * the reason #953's silence gate returns early in the same file, documented
 * there after it was got wrong once.
 */
export function tendingEligibility(roster, declarations, now = new Date().toISOString()) {
  const eligible = eligibleSeats(roster, declarations, now);
  const declining = (roster || []).filter((s) => !eligible.includes(s));
  return {
    anyEligible: eligible.length > 0,
    eligible,
    declining,
    // The honest record for the "nobody is available" case: not a delivery, not
    // a failure, and never replayed when the declarations expire.
    reason: eligible.length > 0 ? null : 'no-eligible-seats',
  };
}
