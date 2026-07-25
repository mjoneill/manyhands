/**
 * core/seat-registry.mjs — the abstract seat registry for TokenRing mode (#410).
 *
 * Reconciled after review killed "author as the seat key":
 * reply-dispatch POSTs replies straight to REST (author present, MCP session
 * gone), and first-post binding deadlocks under the dormancy gate on reconnect.
 * So identity is THREE distinct layers, never conflated:
 *
 *   - seatId    — stable, explicit, UNIQUE ring identity (e.g. "robin.sb").
 *                 Ring membership and leases key on this and only this.
 *   - author    — display / logical identity. NON-INJECTIVE: several seats may
 *                 legitimately publish as "robin". Labels a seat; never keys or
 *                 merges one.
 *   - sessionId — ephemeral MCP transport incarnation. Rebound on reconnect.
 *
 * This module is a pure in-memory abstraction: no I/O, no transport, no clock.
 * It does NOT decide HOW a seat comes to be registered — that population seam
 * (explicit registration at MCP connect, presence supplying its configured
 * seatId) is designed jointly with the presence side and wired later. Until
 * then this stays unpopulated, and the scheduler targets seats through it so no
 * identity assumption is smuggled into the ring core.
 *
 * Fencing (an async-correctness requirement): a reconnect is a NEW session
 * claiming an existing seat — it SUPERSEDES the prior transport (last claim
 * wins), and a late close from the superseded session must NOT unbind the fresh
 * one. Session-match on release gives that for free; a monotonic per-seat epoch
 * is exposed so a delivery in flight can be fenced against a reconnect race.
 *
 * Trust: registration is trusted input in v1 (author is client-supplied; auth
 * is deferred as a non-threat in a trusted room, per Alex). The only conflict
 * rejected here is structural: one live session cannot hold two seat identities.
 */

export function createSeatRegistry() {
  const seatToSession = new Map(); // seatId  -> sessionId (the ONE live transport)
  const sessionToSeat = new Map(); // sessionId -> seatId  (inverse; enforces bijection)
  const seatAuthor = new Map();    // seatId  -> author label (display only)
  const seatEpoch = new Map();     // seatId  -> monotonic epoch, bumped on each (re)bind
  let epochCounter = 0;

  /**
   * Bind (or rebind) a seat to a live session.
   * @returns {{ok:true, seatId, epoch, supersededSession:string|null}
   *          | {ok:false, reason:string, heldBy?:string}}
   *   - Reconnect: a new session claiming an existing seat supersedes the old
   *     transport (supersededSession names it so the caller can drop that GET).
   *   - Conflict: a session already bound to a DIFFERENT seat cannot re-declare;
   *     a session identifies as exactly one persona. Rejected, binding untouched.
   */
  function register({ seatId, sessionId, author } = {}) {
    if (!seatId || !sessionId) return { ok: false, reason: 'seatId and sessionId are required' };

    const priorSeatOfSession = sessionToSeat.get(sessionId);
    if (priorSeatOfSession && priorSeatOfSession !== seatId) {
      return { ok: false, reason: 'session-already-bound', heldBy: priorSeatOfSession };
    }

    // Supersede whatever session currently holds this seat (reconnect).
    const supersededSession = seatToSession.get(seatId) ?? null;
    if (supersededSession && supersededSession !== sessionId) {
      sessionToSeat.delete(supersededSession);
    }

    seatToSession.set(seatId, sessionId);
    sessionToSeat.set(sessionId, seatId);
    if (author !== undefined) seatAuthor.set(seatId, author);
    const epoch = ++epochCounter;
    seatEpoch.set(seatId, epoch);
    return { ok: true, seatId, epoch, supersededSession: supersededSession === sessionId ? null : supersededSession };
  }

  /**
   * Release a session's binding — typically on transport close.
   * FENCED: only removes the binding if `sessionId` is still the seat's CURRENT
   * session, so a late close from a superseded (reconnected-away) transport is a
   * no-op and cannot unbind the fresh session.
   * @returns {string|null} the seatId released, or null if nothing/stale.
   */
  function release({ sessionId } = {}) {
    if (!sessionId) return null;
    const seatId = sessionToSeat.get(sessionId);
    if (!seatId) return null; // unknown or already superseded — nothing to do
    // seatToSession.get(seatId) === sessionId is guaranteed here: sessionToSeat is
    // deleted for a superseded session at register time, so a stale close never
    // reaches this line with a live inverse entry.
    seatToSession.delete(seatId);
    sessionToSeat.delete(sessionId);
    seatEpoch.delete(seatId);
    seatAuthor.delete(seatId);
    return seatId;
  }

  /** Current live session for a seat, or null. Delivery targeting resolves fresh through this. */
  function sessionForSeat(seatId) {
    return seatToSession.get(seatId) ?? null;
  }

  /** The seat a known session belongs to, or null. Used to attribute a session-scoped action. */
  function seatForSession(sessionId) {
    return sessionToSeat.get(sessionId) ?? null;
  }

  /** The display author label for a seat (never used to key or merge). */
  function authorForSeat(seatId) {
    return seatAuthor.get(seatId);
  }

  /** The seat's current bind epoch (for fencing a delivery against a reconnect race). */
  function epochForSeat(seatId) {
    return seatEpoch.get(seatId);
  }

  /** All registered seatIds — the source of ring membership. */
  function seats() {
    return [...seatToSession.keys()];
  }

  /** True if this seat currently has a live session. */
  function isLive(seatId) {
    return seatToSession.has(seatId);
  }

  return {
    register,
    release,
    sessionForSeat,
    seatForSession,
    authorForSeat,
    epochForSeat,
    seats,
    isLive,
  };
}
