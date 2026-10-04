/**
 * core/cursors.mjs — #683 (slice 3 of #642): per-seat cursors, server-side.
 *
 * THE DEAFNESS CURE. A seat whose stream died currently receives nothing: no
 * queue, no replay (#624). The fix is not a better stream — it is to stop
 * treating delivery as the guarantee at all:
 *
 *   PUSH IS A DOORBELL. PULL IS THE GUARANTEE.
 *
 * Fan-out never advances anything; it only invites a pull. What a seat has
 * actually received is tracked here, server-side, because the clients are
 * measurably heterogeneous (one treats re-init as terminal) and a guarantee
 * that depends on client cooperation is not a guarantee.
 *
 * ── SERVED-THEN-ACKED ─────────────────────────────────────────────────────
 * Two numbers per seat, and the gap between them is the whole design:
 *
 *   acked   — the seat has SAID it received everything ≤ this (an explicit ack)
 *   served  — the max seq a pull put into a response, not yet acknowledged
 *
 * A pull serves events > `acked` and records `served`. `acked` does not move.
 * #1576 — it moves ONLY on an EXPLICIT client ack (core/cursor-service.mjs
 * `ackFor`, POST /api/cursors/ack with the pull's `ack_token`), clamped to
 * `served` and never backward.
 *
 * ⚠️ WHY NOT THE IMPLICIT ACK THIS MODULE SHIPPED WITH (#683). It treated the
 * seat's NEXT inbound call as the ack — "aliveness after the response" — and
 * recorded `served` in `res.end`'s callback. Measured on Node 22 (#1571/#1576):
 * `res.end`'s callback fires even when the client destroyed the socket
 * mid-body, so a response that died was recorded as served, and the seat's next
 * call of ANY kind acked it. #624's loss class inside its own cure. Neither a
 * completed server-side write nor a later inbound call is delivery evidence;
 * only the client saying what it got is. `recordInbound` is now liveness only.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** Reachability, from INBOUND evidence only. See `reachability`. */
export const REACHABLE = 'reachable';
/**
 * ⛔ NOT "deaf". #992.
 *
 * This state fires on UNACKED LAG — see `reachability()` — and lag measures
 * PULL ADOPTION, not reception. A push-only seat that is receiving everything
 * perfectly still accrues lag forever, because `acked` advances only through a
 * pull. Calling that "deaf" asserts NOT RECEIVING, which the server has no
 * evidence for either way.
 *
 * Measured 2026-08-23: /api/cursors reported deaf for 5 of 5 lanes, including
 * two seats demonstrably reading the room. The oracle was not broken; the WORD
 * was, and the word is what a human acts on at 06:00.
 *
 * ⚠️ AND THERE IS A SECOND, HONEST `deaf` ONE MODULE OVER — mcp-server.mjs's
 * #726 detector, which fires when a seat HAD a stream, has NONE, and just made
 * a request. That one measures actual unreachability and is CORRECTLY named.
 * Renaming both would have deleted a working signal; only this one moves.
 *
 * Under "no smart clients" there is no server-side evidence of deafness
 * available at all, so no state here may claim it.
 */
export const UNCONFIRMED = 'unconfirmed';
export const UNREACHABLE = 'unreachable';

const DEFAULTS = Object.freeze({
  unreachableMs: 30 * 60 * 1000, // no inbound this long ⇒ we cannot say it is reachable
  deafLagEvents: 1,              // inbound recent AND anything unacked ⇒ deaf
});

const emptyState = () => ({ version: 1, seats: {} });

export function cursorsPath(eventDir) {
  return join(eventDir, 'cursors.json');
}

/** Missing/corrupt cursor state is EMPTY, never an error: a fresh board has none. */
export function loadCursors(eventDir) {
  const p = cursorsPath(eventDir);
  if (!existsSync(p)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.seats !== 'object') return emptyState();
    return { version: 1, seats: parsed.seats || {} };
  } catch {
    return emptyState();
  }
}

/**
 * Persist atomically. Cursors survive restarts by definition — a cursor that
 * resets on restart would make every restart a deafness event, which is the
 * ceremony this slice retires.
 */
export function saveCursors(eventDir, state) {
  if (!existsSync(eventDir)) mkdirSync(eventDir, { recursive: true });
  const p = cursorsPath(eventDir);
  const tmp = join(dirname(p), `.cursors.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, p);   // rename is atomic within a filesystem
  return state;
}

const seatOf = (state, seat) => (state.seats[seat] ||= {
  acked: 0, served: null, last_inbound_at: null, last_inbound_seq: null, registered_at: null,
});

/**
 * A seat we have never seen starts at HEAD, not at zero.
 *
 * Deliberate: the log's genesis is 2026-08-04, but the board is older, so
 * replaying from 0 would hand a brand-new seat a "change" list that is really
 * the log's own beginning — arriving as news. Earlier history is a store query
 * (card_list / conversation_list), not a replay. A seat we already know keeps
 * its cursor: re-registration is exactly the case where NOT resetting is the
 * entire point.
 */
export function registerSeat(state, seat, headSeq, { now = new Date().toISOString() } = {}) {
  const existing = state.seats[seat];
  if (existing) {
    existing.last_inbound_at = now;
    return { state, seat, cursor: existing.acked, fresh: false };
  }
  state.seats[seat] = {
    acked: Number(headSeq) || 0,
    served: null,
    last_inbound_at: now,
    last_inbound_seq: Number(headSeq) || 0,
    registered_at: now,
  };
  return { state, seat, cursor: state.seats[seat].acked, fresh: true };
}

/**
 * Record that a COMPLETED response carried events up to `maxSeq`.
 *
 * ⚠️ Call this only after the response is fully written. Calling it at the
 * moment of DECIDING what to send re-creates #624 exactly: the cursor would
 * advance for a response that never arrived.
 */
export function recordServed(state, seat, maxSeq) {
  const s = seatOf(state, seat);
  const n = Number(maxSeq);
  if (!Number.isFinite(n) || n <= s.acked) return state;   // nothing new was served
  s.served = Math.max(s.served ?? 0, n);
  return state;
}

/**
 * An inbound call from the seat: LIVENESS evidence for `reachability`, nothing more.
 *
 * ⛔ #1576 — NOT an ack. This used to move `acked` to `served` ("the seat was alive
 * after the response, so it got it"); a response that died mid-body is still
 * `served` (Node 22 fires `res.end`'s callback for it), so that rule acked pages the
 * seat never received. `acked` / `graph_acked` move only in cursor-service `ackFor`.
 */
export function recordInbound(state, seat, headSeq, { now = new Date().toISOString() } = {}) {
  const s = seatOf(state, seat);
  s.last_inbound_at = now;
  s.last_inbound_seq = Number(headSeq) || s.last_inbound_seq || 0;
  return state;
}

/** What a pull should serve from: everything with seq > this. */
export function cursorFor(state, seat) {
  return state.seats[seat]?.acked ?? null;
}

/**
 * Reachability from INBOUND evidence ONLY.
 *
 * ⚠️ `stream_open` is BANNED as an input here, and the ban is the finding, not
 * a preference: an open-stream health check scored a seat healthy for EIGHT
 * HOURS while it received nothing. An outbound-shaped signal answers "did we
 * try", which is not the question. Inbound answers "did anything come back".
 *
 *   unreachable — no inbound within `unreachableMs`. We cannot say it is fine.
 *   unconfirmed — inbound is RECENT but unacked events are piling up: the seat
 *                 is alive and talking, and not receiving. This is the state
 *                 the 8-hour incident was actually in and nothing could name.
 *   reachable   — recent inbound, nothing meaningful outstanding.
 */
export function reachability(state, seat, headSeq, { now = Date.now(), ...opts } = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const s = state.seats[seat];
  if (!s || !s.last_inbound_at) {
    return { state: UNREACHABLE, lag: null, last_inbound_at: null, reason: 'never seen inbound' };
  }
  const age = now - Date.parse(s.last_inbound_at);
  const lag = Math.max(0, (Number(headSeq) || 0) - s.acked);
  if (age > cfg.unreachableMs) {
    return { state: UNREACHABLE, lag, last_inbound_at: s.last_inbound_at, reason: `no inbound for ${Math.round(age / 1000)}s` };
  }
  if (lag >= cfg.deafLagEvents) {
    return { state: UNCONFIRMED, lag, last_inbound_at: s.last_inbound_at, reason: `${lag} event(s) unacked while inbound is recent — the seat may be receiving them and simply not pulling` };
  }
  return { state: REACHABLE, lag, last_inbound_at: s.last_inbound_at, reason: 'current' };
}

/**
 * The oldest seq any live seat still needs — the retention floor's other half.
 * Retention may drop a segment only when it is older than the time floor AND
 * entirely below this. Null means no seats: nothing is pinned.
 */
export function oldestLiveCursor(state) {
  const acked = Object.values(state.seats).map((s) => s.acked);
  return acked.length ? Math.min(...acked) : null;
}

/**
 * Which day-segments may be deleted. Deliberately returns a DECISION per
 * segment with a reason, rather than a bare list: a retention sweep that
 * silently keeps or drops files is impossible to debug after the fact.
 */
export function retentionPlan(state, segments, { floorDays = 30, now = Date.now() } = {}) {
  const pinned = oldestLiveCursor(state);
  const floorMs = floorDays * 24 * 60 * 60 * 1000;
  return segments.map((seg) => {
    const day = String(seg.file || '').match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
    const ageMs = day ? now - Date.parse(`${day}T23:59:59.999Z`) : 0;
    if (!day) return { ...seg, drop: false, reason: 'unparseable segment name — never drop what we cannot date' };
    if (ageMs < floorMs) return { ...seg, drop: false, reason: `within the ${floorDays}-day floor` };
    if (pinned != null && seg.maxSeq >= pinned) {
      return { ...seg, drop: false, reason: `a live cursor at ${pinned} still precedes this segment` };
    }
    return { ...seg, drop: true, reason: `older than floor and fully below the oldest live cursor (${pinned ?? 'none'})` };
  });
}
