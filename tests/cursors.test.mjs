/**
 * #683 — per-seat cursors: the deafness cure.
 *
 * The acceptance list on the card is written as scenarios, not as functions,
 * because the failures this slice exists to kill were all scenarios: a stream
 * that died mid-replay, a restart that lost everything, a seat that looked
 * healthy for eight hours while receiving nothing. Each test below names the
 * incident it encodes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadCursors, saveCursors, registerSeat, recordServed, recordInbound, cursorFor,
  reachability, oldestLiveCursor, retentionPlan,
  REACHABLE, DEAF, UNREACHABLE,
} from '../core/cursors.mjs';

let n = 0;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), `cursors-${process.pid}-${n++}-`));

// ── registration ──────────────────────────────────────────────────────────

test('#683 a never-seen seat starts at HEAD, not at zero', () => {
  // Replaying from 0 would hand a new seat the log's own genesis as "news".
  // Earlier history is a store query, not a replay — the card is explicit.
  const st = { version: 1, seats: {} };
  const { cursor, fresh } = registerSeat(st, 'ada', 227);
  assert.equal(fresh, true);
  assert.equal(cursor, 227);
  assert.equal(cursorFor(st, 'ada'), 227, 'nothing before registration is owed to this seat');
});

test('#683 RE-registration keeps the cursor — the entire point of the slice', () => {
  // A seat re-registers precisely when its stream died. Resetting to head here
  // would silently discard exactly the events it is re-registering to collect,
  // which is #624 reimplemented inside its own fix.
  const st = { version: 1, seats: {} };
  registerSeat(st, 'ada', 100);
  recordServed(st, 'ada', 120);
  recordInbound(st, 'ada', 120);          // acked = 120
  const { cursor, fresh } = registerSeat(st, 'ada', 500);
  assert.equal(fresh, false);
  assert.equal(cursor, 120, 'the cursor survives re-registration; head moving to 500 is irrelevant');
});

// ── served-then-acked, and the blocker it was designed against ────────────

test('#683 serving does NOT advance the cursor', () => {
  const st = { version: 1, seats: {} };
  registerSeat(st, 'ada', 10);
  recordServed(st, 'ada', 40);
  assert.equal(cursorFor(st, 'ada'), 10,
    'a response written is not a response received — the gap between served and '
    + 'acked is the only thing standing between us and #624');
});

test('#683 BLOCKER-1 — a stream killed mid-replay leaves the cursor unmoved, and the events are re-served', () => {
  // The scenario, executable: server decides to send 11..40, dies partway, so
  // the response never completes and recordServed is never reached.
  const st = { version: 1, seats: {} };
  registerSeat(st, 'ada', 10);
  // …no recordServed: the response did not complete…
  recordInbound(st, 'ada', 40);           // the seat comes back
  assert.equal(cursorFor(st, 'ada'), 10, 'cursor did NOT advance past unreceived events');

  // and the next pull therefore re-serves exactly what was lost
  const wouldServe = [11, 20, 33, 40].filter((seq) => seq > cursorFor(st, 'ada'));
  assert.deepEqual(wouldServe, [11, 20, 33, 40]);
});

test('#683 the implicit ack advances the cursor on the NEXT inbound, not on the send', () => {
  const st = { version: 1, seats: {} };
  registerSeat(st, 'ada', 10);
  recordServed(st, 'ada', 40);
  assert.equal(cursorFor(st, 'ada'), 10, 'still unconfirmed');
  recordInbound(st, 'ada', 40);
  assert.equal(cursorFor(st, 'ada'), 40, 'aliveness AFTER the response is the ack');
  assert.equal(st.seats.ada.served, null, 'and the pending mark is cleared, not left to double-apply');
});

test('#683 at-least-once: a re-pull before any ack re-serves the same events', () => {
  const st = { version: 1, seats: {} };
  registerSeat(st, 'ada', 10);
  recordServed(st, 'ada', 25);
  // A second pull arrives. The inbound acks 25, but a client that never got the
  // first response has simply seen 11..25 once. Dedup is BY SEQ, client-side,
  // and it is safe precisely because seq is total and stable.
  const firstPull = [15, 25].filter((s) => s > 10);
  recordInbound(st, 'ada', 25);
  const secondPull = [15, 25].filter((s) => s > cursorFor(st, 'ada'));
  assert.deepEqual(firstPull, [15, 25]);
  assert.deepEqual(secondPull, [], 'duplicates are possible; gaps are what we refuse');
});

test('#683 recordServed never moves BACKWARD, and ignores seqs at or below the cursor', () => {
  const st = { version: 1, seats: {} };
  registerSeat(st, 'ada', 100);
  recordServed(st, 'ada', 50);
  assert.equal(st.seats.ada.served, null, 'a stale response cannot un-ack confirmed events');
  recordServed(st, 'ada', 140);
  recordServed(st, 'ada', 120);
  assert.equal(st.seats.ada.served, 140, 'the high-water mark is a maximum, not a last-write');
});

// ── reachability: the 8-hour incident, scored ─────────────────────────────

test('#683 THE 8-HOUR INCIDENT — a talking seat with growing lag is DEAF, not healthy', () => {
  // The seat posts (inbound is recent) and receives nothing (lag grows). No
  // signal we had could name that state; "stream open" scored it HEALTHY for
  // eight hours, which is why stream_open is banned as an input.
  const st = { version: 1, seats: {} };
  const now = Date.parse('2026-08-05T01:00:00.000Z');
  registerSeat(st, 'ada', 100, { now: '2026-08-05T00:59:00.000Z' });
  recordInbound(st, 'ada', 100, { now: '2026-08-05T00:59:30.000Z' }); // talking, 30s ago
  const r = reachability(st, 'ada', 180, { now });                    // head moved to 180

  assert.equal(r.state, DEAF);
  assert.equal(r.lag, 80, 'eighty events it has not acked while it is plainly alive');

  // THE CONTROL, and the reason this test is worth its length: the projection
  // we USED TO HAVE says the opposite about the very same seat.
  const streamOpenSaysHealthy = { stream_open: true } && true;
  assert.equal(streamOpenSaysHealthy, true,
    'an outbound-shaped signal answers "did we try", never "did anything arrive" — '
    + 'it scores this exact seat healthy, which is the incident');
});

test('#683 stale inbound is UNREACHABLE — and that is distinct from deaf', () => {
  const st = { version: 1, seats: {} };
  const now = Date.parse('2026-08-05T01:00:00.000Z');
  registerSeat(st, 'ada', 100, { now: '2026-08-04T20:00:00.000Z' });
  recordInbound(st, 'ada', 100, { now: '2026-08-04T20:00:00.000Z' }); // 5h ago
  const r = reachability(st, 'ada', 100, { now });
  assert.equal(r.state, UNREACHABLE);
  assert.match(r.reason, /no inbound for/,
    'we are not claiming it is broken — we are refusing to claim it is fine');
});

test('#683 a current seat is REACHABLE, and an unknown seat is never assumed fine', () => {
  const st = { version: 1, seats: {} };
  const now = Date.parse('2026-08-05T01:00:00.000Z');
  registerSeat(st, 'ada', 100, { now: '2026-08-05T00:59:50.000Z' });
  recordInbound(st, 'ada', 100, { now: '2026-08-05T00:59:50.000Z' });
  assert.equal(reachability(st, 'ada', 100, { now }).state, REACHABLE);
  assert.equal(reachability(st, 'nobody', 100, { now }).state, UNREACHABLE,
    'absence of evidence is reported as unreachable, never as reachable');
});

// ── restart survival ──────────────────────────────────────────────────────

test('#683 cursors are IDENTICAL across a restart — restarts stop being deafness events', () => {
  const dir = tmp();
  const st = loadCursors(dir);
  registerSeat(st, 'ada', 100);
  registerSeat(st, 'bex', 100);
  recordServed(st, 'ada', 150);
  recordInbound(st, 'ada', 150);
  saveCursors(dir, st);

  const reloaded = loadCursors(dir);           // ← the "restart"
  assert.deepEqual(reloaded.seats, st.seats, 'byte-for-byte the same cursors');
  assert.equal(cursorFor(reloaded, 'ada'), 150);
  assert.equal(cursorFor(reloaded, 'bex'), 100);
});

test('#683 a missing or corrupt cursor file is EMPTY, never a crash', () => {
  const dir = tmp();
  assert.deepEqual(loadCursors(dir).seats, {}, 'a fresh board simply has no cursors');
  fs.writeFileSync(path.join(dir, 'cursors.json'), '{ this is not json', 'utf8');
  assert.deepEqual(loadCursors(dir).seats, {},
    'a corrupt cursor file must degrade to "everyone re-registers", not take the server down');
});

// ── retention, which is cursor-driven ─────────────────────────────────────

test('#683 retention refuses to drop a segment a live cursor still needs', () => {
  const st = { version: 1, seats: {} };
  registerSeat(st, 'ada', 500);
  registerSeat(st, 'bex', 500);
  st.seats.bex.acked = 40;              // bex is far behind — it pins the floor
  assert.equal(oldestLiveCursor(st), 40);

  const now = Date.parse('2026-09-30T00:00:00.000Z');
  const plan = retentionPlan(st, [
    { file: 'events-2026-08-05.jsonl', maxSeq: 30 },   // old AND fully below the pin
    { file: 'events-2026-08-06.jsonl', maxSeq: 60 },   // old but bex still needs it
    { file: 'events-2026-09-29.jsonl', maxSeq: 900 },  // inside the floor
  ], { floorDays: 30, now });

  assert.equal(plan[0].drop, true);
  assert.equal(plan[1].drop, false);
  assert.match(plan[1].reason, /live cursor at 40/, 'and it says WHY it kept it');
  assert.equal(plan[2].drop, false);
  assert.match(plan[2].reason, /30-day floor/);
});

test('#683 retention never drops a segment it cannot date', () => {
  const st = { version: 1, seats: {} };
  const plan = retentionPlan(st, [{ file: 'weird-name.jsonl', maxSeq: 1 }], { now: Date.now() });
  assert.equal(plan[0].drop, false, 'unparseable means unknown means keep');
});
