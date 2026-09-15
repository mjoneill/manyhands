/**
 * core/token-ring-direct.mjs — #1362, THE DIRECT SEGMENT of the token ring.
 *
 * The ring runs its registered stream seats (#410, core/token-ring.mjs), then
 * the direct-wired residents — seats whose transport is their inbox, not a
 * stream (#1346). This module is the residents' turn: ONE SLOT at the end of
 * each cycle, offering each resident ONE delivery record; the slot advances
 * when every record it is waiting on reaches a terminal state, or at its
 * deadline. Like the stream engine it is CLOCK-FREE and TRANSPORT-FREE: every
 * call takes `now`, the record ids are handed to the caller, and nothing here
 * sends anything. mcp-server.mjs turns a record into a delivery (slice 2).
 *
 * The rules, as ruled on the card (2026-09-15 14:2xZ, by the room):
 *   enumerate   direct seats are read from `directSeats()` when the slot OPENS,
 *               never cached across cycles
 *   one slot    one slot per cycle, one record per seat; a second openSlot
 *               while a slot is open is a no-op
 *   timeout     max(ring TTL, DIRECT_SLOT_FLOOR_MS = 180 s): a resident's
 *               turn is a 60 s runner tick plus a model turn, and the ring's
 *               90 s config floor would time out a HEALTHY runner every cycle
 *   early       the slot advances the moment every waited-on record is terminal
 *   latch       a seat whose last record ended by TIMEOUT is `notAnswering`:
 *               still OFFERED a record each cycle (the ledger must show every
 *               miss, #1349) but not WAITED on, so a dead runner costs the room
 *               one slow cycle, not one per cycle; any non-timeout terminal
 *               state clears it (a decline is an answer, #1351)
 *   one record  at advance every record still open closes `advanced`, so each
 *               cycle starts with exactly one record per seat
 *   never ring  no direct seat is ever registered into the stream ring; an
 *               empty stream segment holds the RING, never the INBOX
 */

export const DIRECT_SLOT_FLOOR_MS = 180_000;
export const TERMINAL = new Set(['published', 'declined', 'failed', 'timeout', 'advanced']);

export const HISTORY_CYCLES = 50;   // records kept for status/tests: the last N cycles, not forever (#1392's lesson)

export function createDirectSegment({ directSeats, ttlMs, floorMs = DIRECT_SLOT_FLOOR_MS, genRecordId, historyCycles = HISTORY_CYCLES } = {}) {
  if (typeof directSeats !== 'function') throw new Error('direct segment needs directSeats()');
  let seq = 0;
  const nextId = genRecordId ?? (() => `direct-${++seq}`);
  // The TTL is read when a slot OPENS (a function is called each time), so a
  // config change reaches the next cycle without an adapter restart.
  const slotTtlNow = () => Math.max(Number(typeof ttlMs === 'function' ? ttlMs() : ttlMs) || 0, floorMs);

  let slot = null;                 // { openedAt, deadline, cycle, records: Map<seat, record> }
  const latched = new Map();       // seat → { since, lastTimeoutAt }
  const history = [];              // every record ever opened, for status and tests
  let cycles = 0;
  let lastCycle = null;

  const waitSet = () => [...slot.records.keys()].filter((seat) => !latched.has(seat));
  const openRecords = () => [...slot.records.values()].filter((r) => r.state === 'open');

  function close(record, state, now) {
    record.state = state;
    record.closedAt = now;
  }

  function advance(now, reason) {
    // Every record still open closes `advanced` — the slot never leaves a
    // second open record behind for a seat (a latched seat's, typically).
    const closed = [];
    for (const r of openRecords()) { close(r, 'advanced', now); closed.push({ id: r.id, seat: r.seat }); }
    lastCycle = { cycle: slot.cycle, openedAt: slot.openedAt, closedAt: now, reason, records: [...slot.records.values()].map((r) => ({ id: r.id, seat: r.seat, state: r.state })) };
    slot = null;
    cycles += 1;
    return { reason, closed, cycle: lastCycle.cycle };
  }

  function maybeAdvance(now) {
    if (!slot) return null;
    const waiting = waitSet().filter((seat) => slot.records.get(seat).state === 'open');
    if (waiting.length) return null;
    return advance(now, 'terminal');
  }

  /** Open the cycle's slot: one record per direct seat, enumerated NOW. Null if a slot is already open. */
  function openSlot({ now, posts = [] } = {}) {
    if (slot) return null;
    const seats = [...new Set(directSeats())];
    const records = new Map();
    for (const seat of seats) {
      const r = { id: nextId(), seat, cycle: cycles, state: 'open', openedAt: now, closedAt: null, posts: posts.map((p) => (typeof p === 'string' ? p : p.id)) };
      records.set(seat, r);
      history.push(r);
    }
    const ttl = slotTtlNow();
    slot = { openedAt: now, deadline: new Date(Date.parse(now) + ttl).toISOString(), ttlMs: ttl, cycle: cycles, records };
    while (history.length && history[0].cycle < cycles - historyCycles) history.shift();
    return { records: [...records.values()].map((r) => ({ id: r.id, seat: r.seat, posts: r.posts })), deadline: slot.deadline };
  }

  /**
   * A record reached a terminal state (from the resident's runner: published /
   * declined / failed). Returns { accepted, advanced }: accepted=false when the
   * record was no longer open (it had timed out or the slot had moved on).
   */
  function recordTerminal({ seat, state, now } = {}) {
    if (!TERMINAL.has(state) || state === 'timeout' || state === 'advanced') throw new Error(`recordTerminal: ${state} is not a runner-reported terminal state`);
    const r = slot?.records.get(seat);
    if (!r || r.state !== 'open') return { accepted: false, advanced: null };
    close(r, state, now);
    latched.delete(seat);            // an answer of any kind clears the latch
    return { accepted: true, advanced: maybeAdvance(now) };
  }

  /** The clock: at the deadline, every open record times out (latching its seat) and the slot advances. */
  function tick({ now } = {}) {
    if (!slot) return { advanced: null };
    if (Date.parse(now) < Date.parse(slot.deadline)) return { advanced: maybeAdvance(now) };
    for (const r of openRecords()) {
      close(r, 'timeout', now);
      const prev = latched.get(r.seat);
      latched.set(r.seat, { since: prev?.since ?? now, lastTimeoutAt: now });
    }
    return { advanced: advance(now, 'timeout') };
  }

  function status() {
    const seats = slot ? [...slot.records.keys()] : [...new Set(directSeats())];
    return {
      slot: slot ? {
        state: 'open', cycle: slot.cycle, openedAt: slot.openedAt, ttlMs: slot.ttlMs, deadline: slot.deadline,
        records: [...slot.records.values()].map((r) => ({ id: r.id, seat: r.seat, state: r.state, waitedOn: !latched.has(r.seat) })),
      } : null,
      seats: seats.map((seat) => ({ seat, notAnswering: latched.has(seat), since: latched.get(seat)?.since ?? null, lastTimeoutAt: latched.get(seat)?.lastTimeoutAt ?? null })),
      lastCycle,
      cycles,
      cannotSee: 'a resident whose runner is not ticking is indistinguishable from a slow one until the deadline; the notAnswering latch is set only by a timeout, never by silence before it',
    };
  }

  return { openSlot, recordTerminal, tick, status, allRecords: () => history.map((r) => ({ ...r })), slotTtlMs: slotTtlNow };
}
