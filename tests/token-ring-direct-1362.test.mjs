/**
 * #1362 slice 1 — THE DIRECT SEGMENT, SIMULATED. The ring runs its registered
 * stream seats, then the direct-wired residents; a resident's inbox is its
 * transport; a silent turn is a completed turn. This file drives the pure
 * segment with a fake clock and fake record states — the engine is clock-free
 * and transport-free by design (#410), so the whole design is provable here
 * before mcp-server.mjs touches it.
 *
 * The five answers on the card, each pinned by a case and a sabotage:
 *   (1) direct seats are enumerated when the slot OPENS, never cached
 *   (2) ONE slot per cycle; one record per seat
 *   (3) timeout = max(ring TTL, 180 s) — at the ring's 90 s floor a healthy
 *       runner (60 s tick + a turn) would time out every cycle; the slot
 *       advances EARLY when every waited-on record is terminal; a seat whose
 *       last record ended by TIMEOUT is `not-answering` — still offered, not
 *       waited on — so a dead runner costs ONE slow cycle, not one per cycle;
 *       at advance every open record closes `advanced`, one record per seat
 *   (4) status carries the slot, the records, and the latch
 *   (5) the STREAM ring never sees a direct seat: an empty stream segment
 *       holds the ring, never the inbox (the negative control)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDirectSegment, DIRECT_SLOT_FLOOR_MS } from '../core/token-ring-direct.mjs';
import { createSeatRegistry } from '../core/seat-registry.mjs';
import { createTokenRingEngine } from '../core/token-ring-engine.mjs';

const S = 1000, MIN = 60 * S;
const T0 = Date.parse('2026-09-15T15:00:00.000Z');
const at = (ms) => new Date(T0 + ms).toISOString();

function seg(opts = {}) {
  let seats = opts.seats ?? ['ada', 'grace'];
  const s = createDirectSegment({ directSeats: () => seats, ttlMs: opts.ttlMs ?? 300 * S });
  return { s, setSeats: (next) => { seats = next; } };
}

test('#1362 (1)(2) — one slot per cycle, one record per direct seat, enumerated at OPEN', () => {
  const { s, setSeats } = seg();
  const open = s.openSlot({ now: at(0), posts: [{ id: 'p1' }, { id: 'p2' }] });
  assert.deepEqual(open.records.map((r) => r.seat).sort(), ['ada', 'grace']);
  assert.equal(new Set(open.records.map((r) => r.id)).size, 2, 'two records, two ids');
  assert.deepEqual(open.records[0].posts, ['p1', 'p2'], 'the cycle\'s posts ride the record');
  assert.equal(s.openSlot({ now: at(1 * S), posts: [] }), null, 'a second open while the slot is open does nothing — one slot per cycle');
  setSeats(['ada', 'grace', 'lin']);          // a seat flipped to channel mid-cycle
  assert.equal(s.status().slot.records.length, 2, 'the open slot keeps its enumeration');
  s.recordTerminal({ seat: 'ada', state: 'published', now: at(70 * S) });
  s.recordTerminal({ seat: 'grace', state: 'declined', now: at(71 * S) });
  const next = s.openSlot({ now: at(72 * S), posts: [] });
  assert.equal(next.records.length, 3, 'the NEXT cycle sees the new seat');
});

test('#1362 (3) early advance — the slot closes the moment every waited-on record is terminal, reason=terminal', () => {
  const { s } = seg();
  s.openSlot({ now: at(0), posts: [] });
  assert.equal(s.recordTerminal({ seat: 'ada', state: 'published', now: at(65 * S) }).advanced, null, 'one of two answered: still open');
  const adv = s.recordTerminal({ seat: 'grace', state: 'declined', now: at(80 * S) }).advanced;
  assert.ok(adv, 'both answered: advanced');
  assert.equal(adv.reason, 'terminal');
  assert.equal(s.status().slot, null);
  assert.equal(s.status().lastCycle.reason, 'terminal');
  assert.equal(s.status().lastCycle.closedAt, at(80 * S));
});

test('#1362 (3) floor — at the ring\'s 90 s TTL a healthy runner must NOT time out: the direct slot clamps to 180 s', () => {
  const { s } = seg({ ttlMs: 90 * S, seats: ['ada'] });
  let timeouts = 0;
  for (let cycle = 0; cycle < 5; cycle++) {
    const base = cycle * 200 * S;
    s.openSlot({ now: at(base), posts: [] });
    s.tick({ now: at(base + 120 * S) });                          // the runner is mid-turn at 120 s (60 s tick + a 60 s turn)
    const r = s.recordTerminal({ seat: 'ada', state: 'published', now: at(base + 125 * S) });
    if (!r.accepted) timeouts += 1;                               // the record had already timed out
  }
  assert.equal(timeouts, 0, `a healthy runner answering at 125 s timed out ${timeouts}× under a 90 s TTL — the floor is not clamped`);
  assert.equal(s.status().seats.find((x) => x.seat === 'ada').notAnswering, false);
  assert.equal(DIRECT_SLOT_FLOOR_MS, 180 * S);
});

test('#1362 (3) latch — a dead runner costs the room ONE full-TTL wait, then is offered but not waited on', () => {
  const { s } = seg({ ttlMs: 300 * S });
  let fullWaits = 0;
  for (let cycle = 0; cycle < 5; cycle++) {
    const base = cycle * 400 * S;
    const open = s.openSlot({ now: at(base), posts: [] });
    assert.equal(open.records.length, 2, `cycle ${cycle}: the dead seat is STILL offered its record (the ledger shows the miss)`);
    const r = s.recordTerminal({ seat: 'ada', state: 'published', now: at(base + 70 * S) });   // ada answers; grace never does
    if (r.advanced) continue;                                        // advanced without waiting on grace
    const t = s.tick({ now: at(base + 300 * S) });                   // deadline
    if (t.advanced) { fullWaits += 1; assert.equal(t.advanced.reason, 'timeout'); }
  }
  assert.equal(fullWaits, 1, `the slot waited the full TTL on the dead seat ${fullWaits} times over 5 cycles; must be exactly 1`);
  const grace = s.status().seats.find((x) => x.seat === 'grace');
  assert.equal(grace.notAnswering, true);
  assert.ok(grace.since && grace.lastTimeoutAt, 'the latch says since when');
});

test('#1362 (3) latch clears on any non-timeout terminal state — a slow-but-alive runner costs nothing new', () => {
  const { s } = seg({ ttlMs: 300 * S });
  s.openSlot({ now: at(0), posts: [] });
  s.recordTerminal({ seat: 'ada', state: 'published', now: at(60 * S) });
  s.tick({ now: at(300 * S) });                                        // grace times out → latched
  assert.equal(s.status().seats.find((x) => x.seat === 'grace').notAnswering, true);
  s.openSlot({ now: at(400 * S), posts: [] });
  s.recordTerminal({ seat: 'grace', state: 'declined', now: at(430 * S) });   // grace answers this time (a decline is an answer, #1351)
  assert.equal(s.status().seats.find((x) => x.seat === 'grace').notAnswering, false, 'answered ⇒ unlatched');
  s.recordTerminal({ seat: 'ada', state: 'published', now: at(431 * S) });
  s.openSlot({ now: at(800 * S), posts: [] });
  s.recordTerminal({ seat: 'ada', state: 'published', now: at(860 * S) });
  assert.equal(s.status().slot?.records.find((r) => r.seat === 'grace').state, 'open', 'and the slot WAITS on grace again');
});

test('#1362 (3) one record per seat at every moment — a latched seat\'s open record closes `advanced` when the slot moves', () => {
  const { s } = seg({ ttlMs: 300 * S });
  const maxOpenPerSeat = () => {
    const counts = {};
    for (const r of s.allRecords()) if (r.state === 'open') counts[r.seat] = (counts[r.seat] || 0) + 1;
    return Math.max(0, ...Object.values(counts));
  };
  for (let cycle = 0; cycle < 3; cycle++) {
    const base = cycle * 400 * S;
    s.openSlot({ now: at(base), posts: [] });
    assert.ok(maxOpenPerSeat() <= 1, `cycle ${cycle} open: ${maxOpenPerSeat()} open records for one seat`);
    s.recordTerminal({ seat: 'ada', state: 'published', now: at(base + 60 * S) });
    s.tick({ now: at(base + 300 * S) });
    assert.ok(maxOpenPerSeat() <= 1, `cycle ${cycle} after advance: ${maxOpenPerSeat()} open records for one seat`);
  }
  const guestStates = s.allRecords().filter((r) => r.seat === 'grace').map((r) => r.state);
  assert.deepEqual(guestStates, ['timeout', 'advanced', 'advanced'], 'first miss by timeout, then closed by advance each cycle — every miss visible');
});

test('#1362 (4) status — the slot, its records, the deadline and the latch are all readable, with what it cannot see', () => {
  const { s } = seg({ ttlMs: 300 * S });
  assert.deepEqual(s.status().slot, null);
  s.openSlot({ now: at(0), posts: [{ id: 'p1' }] });
  const st = s.status();
  assert.equal(st.slot.state, 'open');
  assert.equal(st.slot.openedAt, at(0));
  assert.equal(st.slot.ttlMs, 300 * S);
  assert.equal(st.slot.deadline, at(300 * S));
  assert.deepEqual(st.slot.records.map((r) => [r.seat, r.state]), [['ada', 'open'], ['grace', 'open']]);
  assert.deepEqual(st.seats.map((x) => x.seat), ['ada', 'grace']);
  assert.match(st.cannotSee, /runner/i, 'says that a runner that is not ticking looks like a slow one until the deadline');
});

test('#1362 (5) NEGATIVE CONTROL — direct seats never enter the stream ring: an empty stream segment holds the ring, never the inbox', () => {
  const registry = createSeatRegistry();                              // no stream seats registered at all
  const engine = createTokenRingEngine({ registry });
  const { s } = seg();
  const post = { author: 'owner', body: 'hello residents', id: 'p-1' };
  const r = engine.handlePost(post);
  assert.equal(r.deliveries.length, 0, 'the stream engine delivers nothing');
  assert.equal(engine.snapshot().ring.length, 0, 'and its ring is EMPTY — no resident was ever registered into it');
  assert.equal(engine.snapshot().lease, null, 'no lease is held by anyone who cannot answer it');
  const open = s.openSlot({ now: at(0), posts: [post] });
  assert.equal(open.records.length, 2, 'while the direct segment offers the post to both residents');
  assert.equal(engine.snapshot().ring.length, 0, 'still empty after the direct slot opened');
});

test('#1362 bounded — history keeps the last N cycles, and the TTL is read at each open', () => {
  let ttl = 300 * S;
  const s = createDirectSegment({ directSeats: () => ['ada'], ttlMs: () => ttl, historyCycles: 3 });
  for (let c = 0; c < 10; c++) {
    s.openSlot({ now: at(c * 400 * S), posts: [] });
    s.recordTerminal({ seat: 'ada', state: 'published', now: at(c * 400 * S + 10 * S) });
  }
  assert.ok(s.allRecords().length <= 4, `history grew to ${s.allRecords().length} records over 10 cycles with a cap of 3`);
  ttl = 600 * S;                                                       // config changed between cycles
  s.openSlot({ now: at(5000 * S), posts: [] });
  assert.equal(s.status().slot.ttlMs, 600 * S, 'the new TTL applied at the next open without a restart');
});
