/**
 * #1324 — after an MCP restart, NAME the seats that did not come back.
 *
 * The deploy verified the SERVER (mcp 200 · rest 200) and called it done while
 * a seat sat deaf: 57 min (09-09), 12 h (09-10), 51 h (09-10 → 09-13) — two
 * seats, three deploys. Three instances, two failure shapes:
 *
 *   dropped   the seat's stream never returned (streams 1 → 0, or the seat is
 *             simply absent from the table, because sessionMeta is in-memory
 *             and a restart empties it)
 *   held      the stream is back — or was never lost — and the CLIENT behind
 *             it has made no request since the restart. streams=1 read healthy
 *             for twelve hours. lastClientRequestAt is the field that moves.
 *
 * ⭐ Both fixtures below are built from the real /channel/status shape, and the
 * pair is the test: the same function must flag the dropped seat AND the held
 * one, and must NOT flag the healthcheck (streams=0 before, by design — a check
 * that names it gets muted within a week, acceptance 3) nor a seat that
 * reconnected (acceptance 5's spirit: a report that fires every deploy is one
 * nobody reads).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seatsNotBack, formatReport, unboundWithStream } from '../scripts/deploy-seat-check.mjs';

const RESTART_AT = '2026-09-10T23:07:00.000Z';
const seat = (streams, lastClientRequestAt, sessions = streams || 1) =>
  ({ streams, sessions, lastBeatAt: null, lastBeatOk: null, lastClientRequestAt });

const BEFORE = { seats: {
  alpha:        seat(1, '2026-09-10T23:06:40.000Z'),
  bravo:      seat(1, '2026-09-10T23:05:12.000Z'),
  charlie:      seat(4, '2026-09-10T23:06:58.000Z'),
  healthcheck: seat(0, null, 5),
} };

test('#1324 a seat whose stream did not return is NAMED as dropped', () => {
  const after = { seats: {
    alpha:   seat(1, '2026-09-10T23:07:31.000Z'),
    charlie: seat(4, '2026-09-10T23:07:20.000Z'),
    // bravo absent: sessionMeta was emptied by the restart and nothing rebound
  } };
  const r = seatsNotBack(BEFORE, after, RESTART_AT);
  assert.deepEqual(r.map((x) => [x.seat, x.shape]), [['bravo', 'dropped']]);
});

test('#1324 a seat whose stream is back but whose client has not spoken since the restart is NAMED as held (the 12-hour shape; after a real restart it means the table was never emptied)', () => {
  const after = { seats: {
    alpha:   seat(1, '2026-09-10T23:07:31.000Z'),
    bravo: seat(1, '2026-09-10T23:05:12.000Z'),   // streams=1, request predates the restart
    charlie: seat(4, '2026-09-10T23:07:20.000Z'),
  } };
  const r = seatsNotBack(BEFORE, after, RESTART_AT);
  assert.deepEqual(r.map((x) => [x.seat, x.shape]), [['bravo', 'held']]);
  assert.equal(r[0].lastClientRequestAt, '2026-09-10T23:05:12.000Z');
});

test('#1324 a seat with a stream and a NULL lastClientRequestAt after the restart is held, not healthy — unknown is not "spoke"', () => {
  const after = { seats: { alpha: seat(1, null), bravo: seat(1, '2026-09-10T23:07:31.000Z'), charlie: seat(4, '2026-09-10T23:07:20.000Z') } };
  const r = seatsNotBack(BEFORE, after, RESTART_AT);
  assert.deepEqual(r.map((x) => [x.seat, x.shape]), [['alpha', 'held']]);
});

test('#1324 NEGATIVE CONTROL — every seat reconnected: the report is EMPTY, and the healthcheck (streams=0 before) is never named', () => {
  const after = { seats: {
    alpha:        seat(1, '2026-09-10T23:07:31.000Z'),
    bravo:      seat(1, '2026-09-10T23:07:33.000Z'),
    charlie:      seat(4, '2026-09-10T23:07:20.000Z'),
    healthcheck: seat(0, null, 5),
  } };
  assert.deepEqual(seatsNotBack(BEFORE, after, RESTART_AT), []);
  // and with the healthcheck gone entirely — it holds no stream to lose
  const { healthcheck, ...rest } = after.seats;
  assert.deepEqual(seatsNotBack(BEFORE, { seats: rest }, RESTART_AT), []);
});

test('#1324 a seat that was NOT receiving before the restart is not blamed on the restart', () => {
  const before = { seats: { ...BEFORE.seats, delta: seat(0, '2026-09-08T10:00:00.000Z', 1) } };
  const after = { seats: { alpha: seat(1, '2026-09-10T23:07:31.000Z'), bravo: seat(1, '2026-09-10T23:07:33.000Z'), charlie: seat(4, '2026-09-10T23:07:20.000Z') } };
  assert.deepEqual(seatsNotBack(before, after, RESTART_AT), []);
});

test('#1324 a malformed or missing snapshot is reported as UNMEASURED, never as an all-clear', () => {
  assert.throws(() => seatsNotBack(null, { seats: {} }, RESTART_AT), /unmeasured/);
  assert.throws(() => seatsNotBack({ seats: {} }, 'not json', RESTART_AT), /unmeasured/);
  assert.throws(() => seatsNotBack({ nope: 1 }, { seats: {} }, RESTART_AT), /unmeasured/);
});

test('#1324 the report names seats, states the shape, and says what a human must do — and is empty text when nothing is wrong', () => {
  const lines = formatReport([
    { seat: 'bravo', shape: 'dropped', lastClientRequestAt: '2026-09-10T23:05:12.000Z' },
    { seat: 'alpha', shape: 'held', lastClientRequestAt: null },
  ], { restartAt: RESTART_AT, settleSeconds: 30 });
  assert.match(lines, /bravo/);
  assert.match(lines, /alpha/);
  assert.match(lines, /\/mcp reconnect/);
  assert.doesNotMatch(lines, /charlie/);
  assert.equal(formatReport([], { restartAt: RESTART_AT, settleSeconds: 30 }), '');
});

// #1353 — found on the first live run: two "dropped" names beside two unbound
// sessions that held streams four seconds after the restart. Back on the wire,
// not yet in the seats table. The report says so — and still names the seats.
test('#1353 unbound sessions that hold a stream are COUNTED and the report says a named seat may already be back', () => {
  const after = { seats: { alpha: seat(1, '2026-09-10T23:07:31.000Z') }, unboundSessions: [
    { sid: 'a', streams: 1, lastClientRequestAt: '2026-09-10T23:07:04.000Z' },
    { sid: 'b', streams: 1, lastClientRequestAt: '2026-09-10T23:07:04.000Z' },
    { sid: 'c', streams: 0, lastClientRequestAt: '2026-09-10T23:07:04.000Z' },   // tool-only: not counted (#707)
  ] };
  assert.equal(unboundWithStream(after), 2);
  const rows = seatsNotBack(BEFORE, after, RESTART_AT);
  assert.deepEqual(rows.map((r) => r.seat), ['bravo', 'charlie'], 'the names are NOT suppressed by the count');
  const text = formatReport(rows, { restartAt: RESTART_AT, settleSeconds: 30, unboundStreams: unboundWithStream(after) });
  assert.match(text, /2 unbound sessions hold a stream/);
  assert.match(text, /bravo/); assert.match(text, /charlie/);
});

test('#1353 NEGATIVE CONTROL — no unbound stream ⇒ no extra line; a payload without the field counts zero', () => {
  const after = { seats: { alpha: seat(1, '2026-09-10T23:07:31.000Z') }, unboundSessions: [{ sid: 'c', streams: 0, lastClientRequestAt: null }] };
  assert.equal(unboundWithStream(after), 0);
  assert.equal(unboundWithStream({ seats: {} }), 0);
  const text = formatReport(seatsNotBack(BEFORE, after, RESTART_AT), { restartAt: RESTART_AT, settleSeconds: 30, unboundStreams: 0 });
  assert.doesNotMatch(text, /unbound/);
  assert.match(text, /bravo/);
});
