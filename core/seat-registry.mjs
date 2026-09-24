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
 * is deferred as a non-threat in a trusted room). The only conflict
 * rejected here is structural: one live session cannot hold two seat identities.
 */

export function createSeatRegistry() {
  const seatToSession = new Map(); // seatId  -> sessionId (the ONE live transport)
  const sessionToSeat = new Map(); // sessionId -> seatId  (inverse; enforces bijection)
  const seatAuthor = new Map();    // seatId  -> author label (display only)
  const seatEpoch = new Map();     // seatId  -> monotonic epoch, bumped on each (re)bind
  const seatSurfaces = new Map();  // seatId  -> true | false (#1453b; absent = undeclared)
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
  function register({ seatId, sessionId, author, surfaces } = {}) {
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
    // #1453b — a lane DECLARES whether it surfaces (is the seat's presence /
    // chat lane). Declared, never inferred from recency or bind order.
    // A re-register WITHOUT `surfaces` keeps the lane's earlier declaration:
    // a reconnect is not a retraction (only an explicit false withdraws it).
    // From review: a SECOND lane of the same seat claiming surfaces:true
    // would otherwise be settled by bind order, the one tiebreak the card
    // rules out. So it is REFUSED as a conflict: the lane still registers and
    // receives, its claim is not recorded, and the holder is named so the
    // caller can say so loudly.
    let surfacesConflict = null;
    if (surfaces === true) {
      const group = author ?? seatAuthor.get(seatId) ?? seatId;
      for (const [other, v] of seatSurfaces) {
        if (other !== seatId && v === true && seatToSession.has(other) && (seatAuthor.get(other) ?? other) === group) { surfacesConflict = other; break; }
      }
    }
    if (surfaces === false || (surfaces === true && !surfacesConflict)) seatSurfaces.set(seatId, surfaces);
    const epoch = ++epochCounter;
    seatEpoch.set(seatId, epoch);
    return { ok: true, seatId, epoch, supersededSession: supersededSession === sessionId ? null : supersededSession, ...(surfacesConflict ? { surfacesConflict } : {}) };
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
    seatSurfaces.delete(seatId);
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

  /** #1453b — the lane's declared `surfaces`, or null when it declared nothing. */
  function surfacesForSeat(seatId) {
    return seatSurfaces.has(seatId) ? seatSurfaces.get(seatId) : null;
  }

  /**
   * #1453b — RING membership, one member per SEAT where the seat has said which
   * lane surfaces. Lanes group by `author` (the seat key; a lane with no author
   * is its own group). A group with a lane that declared `surfaces: true`
   * contributes THAT lane only; its siblings (a probe, a bare-key tool
   * connection) receive but take no turn. A group with no such declaration
   * contributes every lane, exactly as `seats()` did. Registration (the
   * receive-set) is untouched: this only narrows who holds a turn.
   */
  function ringSeats() {
    const groups = new Map();
    for (const seatId of seatToSession.keys()) {
      const key = seatAuthor.get(seatId) ?? seatId;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(seatId);
    }
    const out = [];
    for (const lanes of groups.values()) {
      const surfacing = lanes.filter((l) => seatSurfaces.get(l) === true);
      out.push(...(surfacing.length ? surfacing.slice(0, 1) : lanes));
    }
    return out;
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
    ringSeats,        // #1453b
    surfacesForSeat,  // #1453b
    isLive,
  };
}
