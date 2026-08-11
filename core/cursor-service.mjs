/**
 * core/cursor-service.mjs — #683 slice 3b: binding the cursors to the log.
 *
 * Slice 3a shipped `core/cursors.mjs` — correct, tested, and imported by
 * NOTHING for six days, while the room spent an evening diagnosing the exact
 * deafness it cures. This module is the wiring, and it is deliberately the only
 * place that knows both the event log and a seat's delivery identity.
 *
 * ── WHAT A CURSOR IS KEYED ON, and why it took three seats to settle ───────
 *
 * The board has TWO identity maps and they are DISJOINT — measured, not assumed:
 *
 *     #410 registry (scrum/session/register)   #703 binding (bearer token)
 *       92  minimo.sb                            7151  healthcheck
 *       89  minimo.cs                              15  wren
 *        1  probe-timing                           10  indigo
 *
 * Keying on the bearer seat gives @minimo — the seat this whole slice exists
 * for — nothing, because her client cannot send a token until #779. Keying on
 * the registry id gives @wren and @indigo nothing, because neither has ever
 * registered. Either choice alone silently covers half a room.
 *
 * So a cursor is keyed on the DELIVERY LANE, which names itself in precedence
 * order: a declared registry id first, a proven bearer seat second, and nothing
 * third — an anonymous stream gets no cursor, because there is nothing durable
 * to resume it by and inventing a key would pin retention forever.
 *
 * ⚠️ REGISTRY FIRST IS THE LOAD-BEARING HALF, and it is not an ordering
 * preference. When #779 gives @minimo's client a bearer token, her lane names
 * do not change — so her cursors survive. The other precedence would re-key
 * every cursor she owns on the day we make her visible: an outage caused by
 * fixing observability.
 *
 * ⚠️ AND THE COST, stated because it is real: the registry id is CLIENT-SUPPLIED
 * and unauthenticated (`core/seat-registry.mjs`: "author is client-supplied;
 * auth is deferred"). We are keying durable state on a declaration. The fence
 * below is what makes that acceptable rather than merely tolerated, and the
 * #779 upgrade path is to cross-check a declared id against the token that may
 * claim it — which makes #779 an upgrade to this slice rather than a
 * prerequisite for it.
 *
 * ── THE FENCE: why `serveFor` returns a `commit` you have to call ──────────
 *
 * Two sessions can hold one lane name. The registry's own log cannot tell a
 * reconnect from a duplicate config — it says so out loud: "(reconnect or
 * DUPLICATE config?)". Under one shared cursor, session A acking would mark
 * events delivered that session B never received: #624 exactly, arriving
 * through the key of the thing built to cure it, and silent, because a cursor's
 * whole job is to assert delivery.
 *
 * So a serve records WHO it was served to (`served_via`), and an ack from
 * anyone else does not advance the cursor — it invalidates the outstanding
 * range so it is served again. At-least-once holds, which is the contract.
 *
 * `via` is whatever uniquely names the serving connection: the registry epoch
 * for a registered lane, the MCP session id for a bearer lane. A bearer seat
 * with two live sessions has the same hazard and gets the same protection.
 */

import { readEvents, nextSeq } from './event-log.mjs';
import {
  loadCursors, saveCursors, registerSeat, recordServed, recordInbound,
  reachability, REACHABLE,
} from './cursors.mjs';

/** How many events one pull may carry. Bounded: a replay is not a history dump. */
export const PULL_LIMIT = 200;

const KINDS = Object.freeze({ registry: 'registry', bearer: 'bearer' });

const clean = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * The cursor key for a connection, or null if it has no durable identity.
 *
 * Namespaced on purpose: the two identity spaces have no authority keeping
 * their vocabularies apart, and the registry already accepts arbitrary strings
 * from client config (`probe-timing` registered on 2026-08-11). Unprefixed, a
 * registered endpoint named `wren` would silently share one cursor with the
 * bearer seat `wren` — two lanes robbing each other with no error anywhere.
 */
export function deliveryIdentity({ registrySeatId = null, bearerSeat = null } = {}) {
  const reg = clean(registrySeatId);
  if (reg) return { key: `${KINDS.registry}:${reg}`, kind: KINDS.registry, id: reg };
  const bearer = clean(bearerSeat);
  if (bearer) return { key: `${KINDS.bearer}:${bearer}`, kind: KINDS.bearer, id: bearer };
  return null;
}

/** The highest seq the log has assigned. `nextSeq` is the NEXT one to hand out. */
export function headSeq(eventDir) {
  return nextSeq(eventDir) - 1;
}

/**
 * What this lane is owed, computed server-side so the client compares nothing.
 *
 * The room's ruling on the card's open staleness question: the asymmetry is not
 * "who decides", it is "who computes". A client acting on these fields is
 * following an instruction, not holding policy — so the no-smart-clients
 * contract survives. `oldest_unserved_at` is the AGE signal, and it is the one
 * a future enforcement card keys on: age catches a three-day-stale harness,
 * while divergence (`served != head`) fires constantly on a healthy room.
 */
export function envelopeFor(eventDir, key, { state = null, head = null } = {}) {
  const st = state || loadCursors(eventDir);
  const h = head == null ? headSeq(eventDir) : head;
  const s = st.seats[key];
  const base = {
    delivery_identity: key,
    head_seq: h,
    dedup: 'by seq — delivery is at-least-once; a seat may see an event twice, never zero times',
  };
  // ⚠️ An unknown lane reports UNKNOWN, not zero. A confident zero for a
  // question we cannot answer is the defect class this board catalogued on
  // 2026-08-10 (#776/#777/#778) — an endpoint answering what it did not
  // understand, in the shape of success.
  if (!s) {
    return {
      ...base, known: false, last_acked_seq: null, last_served_seq: null,
      lag: null, oldest_unserved_at: null,
    };
  }
  const lag = Math.max(0, h - s.acked);
  return {
    ...base,
    known: true,
    last_acked_seq: s.acked,
    last_served_seq: s.served,
    lag,
    oldest_unserved_at: lag > 0
      ? (readEvents(eventDir, { sinceSeq: s.acked, limit: 1 })[0]?.recorded_at ?? null)
      : null,
  };
}

/** Register a lane. A lane we already know KEEPS its cursor — that is the cure. */
export function registerFor(eventDir, key, { now = new Date().toISOString() } = {}) {
  const state = loadCursors(eventDir);
  const head = headSeq(eventDir);
  const { cursor, fresh } = registerSeat(state, key, head, { now });
  saveCursors(eventDir, state);
  return { cursor, fresh, envelope: envelopeFor(eventDir, key, { state, head }) };
}

/**
 * Read what this lane is owed. WRITES NOTHING.
 *
 * ⚠️ The returned `commit()` is not a convenience — it is the #624 guard. A
 * single-call API would record the serve at the moment of DECIDING what to
 * send, so a response that died in flight would still advance the cursor: the
 * original bug, reimplemented inside its own cure, and invisible to any test
 * that only checks "the right events came back". Call `commit()` after the
 * response is fully written, and never before.
 */
export function serveFor(eventDir, key, { limit = PULL_LIMIT, via = null } = {}) {
  const state = loadCursors(eventDir);
  const head = headSeq(eventDir);
  const s = state.seats[key];
  const events = s ? readEvents(eventDir, { sinceSeq: s.acked, limit }) : [];
  const maxSeq = events.length ? events[events.length - 1].seq : null;
  return {
    events,
    envelope: envelopeFor(eventDir, key, { state, head }),
    known: !!s,
    commit() {
      if (!s || maxSeq == null) return null;
      const fresh = loadCursors(eventDir);          // re-read: another process may have moved
      recordServed(fresh, key, maxSeq);
      const seat = fresh.seats[key];
      if (seat) seat.served_via = via;
      saveCursors(eventDir, fresh);
      return maxSeq;
    },
  };
}

/**
 * An inbound call from the lane. This is the implicit ack: the seat was alive
 * AFTER we finished the last response, so we believe it arrived.
 *
 * Returns `{acked, fenced}`. `fenced` means a DIFFERENT connection is acking a
 * range served to someone else — two sessions sharing one lane name. We refuse
 * to advance and drop the outstanding range so it is served again. Losing the
 * range to the wrong session is silent and permanent; re-serving it costs a
 * duplicate, which the contract already permits.
 */
export function noteInbound(eventDir, key, { via = null, now = new Date().toISOString() } = {}) {
  const state = loadCursors(eventDir);
  // A lane we have never seen ADOPTS a cursor at head on its first inbound call.
  // Deliberate, and it is what makes the bearer half of the room work at all:
  // @wren and @indigo never call scrum/session/register, so they would
  // otherwise have no cursor and no replay. Head, not zero — earlier history is
  // a store query, not a replay (the card is explicit), and a lane cannot be
  // owed events from before we knew it existed.
  if (!state.seats[key]) {
    registerSeat(state, key, headSeq(eventDir), { now });
    saveCursors(eventDir, state);
    return { acked: false, fenced: false, adopted: true, envelope: envelopeFor(eventDir, key, { state }) };
  }
  const s = state.seats[key];
  if (!s) return { acked: false, fenced: false, envelope: envelopeFor(eventDir, key, { state }) };
  const outstanding = s.served != null && s.served > s.acked;
  const fenced = outstanding && (s.served_via ?? null) !== via;
  if (fenced) s.served = null;                     // invalidate — it will be re-served
  const before = s.acked;
  recordInbound(state, key, headSeq(eventDir), { now });
  delete s.served_via;
  saveCursors(eventDir, state);
  return {
    acked: s.acked > before,
    fenced,
    envelope: envelopeFor(eventDir, key, { state }),
  };
}

/**
 * Reachability for every known lane, from INBOUND evidence only.
 *
 * `inputs: 'stream_open'` exists ONLY as the positive control the card demands.
 * It is the banned instrument — the one that scored a seat healthy for eight
 * hours while it received nothing — and it is kept here, runnable, so the
 * disagreement between the two projections can be demonstrated on one state
 * rather than argued about. It must never be used as health evidence.
 */
export function reachabilityReport(eventDir, { now = Date.now(), inputs = 'inbound', streamOpen = {}, ...opts } = {}) {
  const state = loadCursors(eventDir);
  const head = headSeq(eventDir);
  return Object.keys(state.seats).map((key) => {
    if (inputs === 'stream_open') {
      return {
        identity: key,
        state: streamOpen[key] ? REACHABLE : 'unreachable',
        lag: Math.max(0, head - state.seats[key].acked),
        reason: 'stream_open — BANNED as health evidence; positive control only',
        instrument: 'stream_open',
      };
    }
    const r = reachability(state, key, head, { now, ...opts });
    return { identity: key, ...r, instrument: 'inbound' };
  });
}

/**
 * Drop every pending (served-but-unacked) range. The server calls this at boot.
 *
 * ⚠️ NOT tidiness — soundness. The fence discriminates on the registry epoch,
 * and `core/seat-registry.mjs` keeps `epochCounter` in a closure with no
 * persistence, so epochs restart at 1 with the process. Measured across three
 * restarts: 3,4 → 5,6 → 1,2 — BACKWARDS. A fence that survived a restart could
 * therefore be satisfied by coincidence, an obsolete session's ack matching a
 * fresh epoch by number. The fence must be as ephemeral as its discriminator.
 *
 * The DURABLE cursor (`acked`) is untouched: a restart costs at most a re-serve
 * of the outstanding range, which is exactly the at-least-once contract.
 */
export function discardPendingServes(eventDir) {
  const state = loadCursors(eventDir);
  let dropped = 0;
  for (const s of Object.values(state.seats)) {
    if (s.served != null || s.served_via !== undefined) dropped++;
    s.served = null;
    delete s.served_via;
  }
  if (dropped) saveCursors(eventDir, state);
  return dropped;
}
