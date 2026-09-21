/**
 * core/token-ring-engine.mjs — the orchestration layer that maps live commons posts
 * onto the pure ring reducer (#410) and computes who, if anyone, should be
 * delivered a turn-envelope.
 *
 * It is deliberately CLOCK-FREE and TRANSPORT-FREE: it takes an abstract seat
 * registry and an envelope-id generator, and returns delivery *intents*
 * ({seatId, sessionId, envelope}) plus telemetry. The mcp-server integration
 * turns an intent into an actual SSE push; the dead-seat timer lives there too.
 * That keeps this fully deterministic and unit-testable with a populated
 * registry but zero live sessions.
 *
 * Inertness (the safety property): the ring is built from registry.seats(). With
 * an unpopulated registry — the state until the presence-side registration seam
 * is built — the ring is empty, no seat is ever queued, the engine stays
 * QUIESCENT, and it emits ZERO deliveries. So wiring this branch cannot move a
 * live session until BOTH (a) mode is set to 'token-ring' AND (b) seats are actually
 * registered. Two independent gates, both currently closed.
 *
 * Classification (reconciled with the three-layer identity model):
 *   - The poster's seat is resolved by SESSION first (registry.seatForSession),
 *     never by author. Author is a non-injective label.
 *   - A REST-posted reply (presence's reply-dispatch) has no session; during an
 *     active lease the dormancy gate means only the HOLDER was invoked, so a post
 *     whose author matches the holder's label is attributed to the holder. This
 *     author-match is used ONLY to recognise the holder's own RESPOND, never to
 *     key or merge a seat.
 *   - Holder's post → RESPOND (advance the ring). Anyone else → additive append.
 */

import { initialState, reduce, delivery, queuedSeats } from './token-ring.mjs';

/**
 * Adjust ring membership to the current registry seats. Joiners enter at
 * cursor=HWM (they participate going forward, not flooded with backlog);
 * departed seats are dropped. Safe ONLY with no lease held — the caller gates on
 * a quiescent/fresh boundary so the active holder is never removed mid-turn.
 */
export function reconcileRing(state, seats) {
  const hwm = state.log.length;
  const ring = [...seats];
  const cursors = {};
  for (const seat of ring) {
    cursors[seat] = seat in state.cursors ? state.cursors[seat] : hwm;
  }
  const ringPos = ring.length ? state.ringPos % ring.length : 0;
  return { ...state, ring, cursors, ringPos };
}

export function createTokenRingEngine({ registry, genEnvelopeId, isDeliverable = null }) {
  if (!registry) throw new Error('token-ring engine requires a seat registry');
  // #1424 — the caller's liveness verdict per seat (an open, recently-spoken
  // stream), beyond "a session is registered". Absent ⇒ every registered seat
  // is deliverable, which is the pre-#1424 behaviour and what the pure tests use.
  let envSeq = 0;
  const nextEnvelopeId = genEnvelopeId ?? (() => `env-${++envSeq}`);
  let state = initialState([]); // empty ring until seats register (inert)

  // Build the delivery intent for a freshly granted lease, if the grant is new.
  // A new grant = there is a holder now whose leaseId differs from beforeLease.
  function grantDeliveries(beforeLease) {
    const after = state.lease;
    if (!after || (beforeLease && beforeLease.id === after.id)) {
      return { deliveries: [], needsTimeout: null };
    }
    const seatId = after.holder;
    const sessionId = registry.sessionForSeat(seatId);
    const payload = delivery(state, seatId).map((m) => ({
      seq: m.seq, author: m.author, kind: m.kind, body: m.body,
    }));
    const envelope = {
      seatId,
      leaseId: after.id,
      envelopeId: nextEnvelopeId(),
      epoch: registry.epochForSeat(seatId) ?? null,
      kind: 'scheduled-turn',
      payload,
    };
    // Holder with no live session ⇒ dead seat: the caller must schedule a TIMEOUT
    // to advance the ring rather than push into the void.
    if (!sessionId) return { deliveries: [], needsTimeout: { seatId, leaseId: after.id } };
    return { deliveries: [{ seatId, sessionId, envelope }], needsTimeout: null };
  }

  // #1424 — a grant to a member the caller says is NOT deliverable (registered,
  // but its stream is dead or stale) does not wait out a lease: the token moves
  // on at once, at most once around the ring; if nobody is deliverable the ring
  // quiesces. Measured 2026-09-20: two ghost registrations each held a full
  // 300 s lease while the owner posted into silence. `skipped` names them.
  function grantDeliverable(beforeLease) {
    const skipped = [];
    let out = grantDeliveries(beforeLease);
    if (!isDeliverable) return { ...out, skipped };
    // A SKIP is a TIMEOUT that does NOT charge the seat. The reducer's TIMEOUT sets
    // cursors[holder] = lease.snapshot (the seat is deemed to have seen the
    // interlude), which for a seat that never received the envelope means the
    // posts are lost to it (R1 review finding: with everyone dead, a post reached nobody).
    // So the cursors of every skipped seat are remembered and put back AFTER the
    // lap — not inside it, or a dead seat would re-queue and be granted again in
    // the same lap. Each in-lap TIMEOUT un-queues that seat, so the lap ends with
    // either a deliverable holder or no lease (QUIESCENT); the restored cursors
    // then re-queue the skipped seats for the NEXT dispatch, and the one that
    // comes back receives what it was skipped over for on its first turn.
    const cursorsBefore = {};
    let guard = state.ring.length + 1;
    while (state.lease && !isDeliverable(state.lease.holder, { queued: queuedSeats(state) }) && guard-- > 0) {
      const { holder, id } = state.lease;
      skipped.push(holder);
      cursorsBefore[holder] = state.cursors[holder];
      const before = state.lease;
      state = reduce(state, { type: 'TIMEOUT', holder, leaseId: id });
      out = grantDeliveries(before);
    }
    if (skipped.length) state = { ...state, cursors: { ...state.cursors, ...cursorsBefore } };
    return { ...out, skipped };
  }

  /**
   * #1424 — drop the held lease and the queued interlude, keep membership: the
   * caller uses it when the delivery mode leaves token-ring, so a lease timer
   * that fires later is a stale no-op instead of the next grant.
   */
  function quiesce() {
    const hadLease = !!state.lease;
    state = { ...initialState(state.ring), cursors: Object.fromEntries(state.ring.map((a) => [a, 0])), nextLeaseId: state.nextLeaseId, ringPos: state.ringPos };
    return { hadLease };
  }

  /**
   * Feed a new commons post. Returns { deliveries, needsTimeout, telemetry }.
   * @param {{author:string, body:string, id?:string, originSessionId?:string}} post
   */
  function handlePost({ author, body, id, originSessionId } = {}) {
    // Reconcile membership only at a non-active boundary (never mid-lease).
    if (!state.lease) state = reconcileRing(state, registry.seats());

    const holder = state.lease?.holder ?? null;
    let originSeatId = originSessionId ? registry.seatForSession(originSessionId) : null;
    if (!originSeatId && holder && registry.authorForSeat(holder) === author) {
      originSeatId = holder; // dormancy gate ⇒ a REST reply mid-lease is the holder's RESPOND
    }

    const beforeLease = state.lease;
    let event;
    if (holder && originSeatId === holder) {
      event = { type: 'RESPOND', holder, leaseId: state.lease.id, body };
    } else {
      event = { type: 'INTERJECT', author, body }; // additive: human or non-holder chorus
    }
    state = reduce(state, event);

    const { deliveries, needsTimeout, skipped } = grantDeliverable(beforeLease);
    const telemetry = {
      event: event.type,
      skipped,   // #1424
      poster: originSeatId ?? `author:${author}`,
      holder: state.lease?.holder ?? null,
      leaseId: state.lease?.id ?? null,
      envelopeId: deliveries[0]?.envelope.envelopeId ?? null,
      ringSize: state.ring.length,
      status: state.status,
      postId: id ?? null,
    };
    return { deliveries, needsTimeout, telemetry };
  }

  /**
   * Dead-seat / slow-holder recovery. Feed a TIMEOUT for the current lease;
   * fenced by (holder, leaseId), so a stale timer for a consumed lease is a
   * no-op. Advances the ring and may produce the next holder's delivery.
   */
  function handleTimeout({ seatId, leaseId } = {}) {
    const beforeLease = state.lease;
    state = reduce(state, { type: 'TIMEOUT', holder: seatId, leaseId });
    const { deliveries, needsTimeout, skipped } = grantDeliverable(beforeLease);
    const telemetry = {
      event: 'TIMEOUT',
      skipped,   // #1424
      poster: seatId,
      holder: state.lease?.holder ?? null,
      leaseId: state.lease?.id ?? null,
      envelopeId: deliveries[0]?.envelope.envelopeId ?? null,
      ringSize: state.ring.length,
      status: state.status,
    };
    return { deliveries, needsTimeout, telemetry };
  }

  return {
    handlePost,
    handleTimeout,
    quiesce,   // #1424
    /** Read-only peek for tests/telemetry. */
    snapshot: () => ({ status: state.status, lease: state.lease, ring: [...state.ring], hwm: state.log.length }),
  };
}
