/**
 * #1150 — the warm activity read skips day files it cannot need.
 *
 * Measured on a copy of the live log (125 MB, 32 day segments): a warm sync
 * that returned ZERO new events spent 400–580 ms in readEvents, the largest
 * term of the per-sync floor, because sinceSeq is applied after every segment
 * is parsed. These pin the cursor and window rules, and that readEvents with
 * the window a warm sync now sends never opens an older day's file while still
 * returning every event past the cursor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEvents, activityReadWindow, advanceActivityCursor } from '../core/event-log.mjs';

const ev = (seq, day, extra = {}) => JSON.stringify({ seq, recorded_at: `${day}T12:00:00.000Z`, op: 'update', entity: { kind: 'card', id: `c${seq}` }, state: {}, ...extra });
function logDir(days) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evlog-1150-'));
  for (const [day, seqs] of Object.entries(days)) {
    fs.writeFileSync(path.join(dir, `events-${day}.jsonl`), seqs.map((s) => ev(s, day)).join('\n') + '\n');
  }
  return dir;
}

test('#1150 a cold cursor reads everything: no date, seq 0', () => {
  assert.deepEqual(activityReadWindow(0, null), { sinceSeq: 0 });
  assert.deepEqual(activityReadWindow(undefined, undefined), { sinceSeq: 0 });
});

test('#1150 the cursor advances to the newest seq AND carries its recorded_at; older or malformed rows never move it', () => {
  const c1 = advanceActivityCursor({ seq: 0, at: null }, [
    { seq: 3, recorded_at: '2026-09-01T10:00:00.000Z' }, { seq: 5, recorded_at: '2026-09-02T10:00:00.000Z' }, { seq: 4, recorded_at: '2026-09-01T11:00:00.000Z' },
  ]);
  assert.deepEqual(c1, { seq: 5, at: '2026-09-02T10:00:00.000Z' });
  const c2 = advanceActivityCursor(c1, [{ seq: 2 }, { junk: true }, null]);
  assert.deepEqual(c2, c1, 'nothing newer: unchanged');
  const c3 = advanceActivityCursor(c1, [{ seq: 6 }]);
  assert.deepEqual(c3, { seq: 6, at: '2026-09-02T10:00:00.000Z' }, 'a newer row with no timestamp advances seq and keeps the last known day');
});

test('#1150 a warm window skips older day files and still returns every event past the cursor', () => {
  const dir = logDir({ '2026-08-04': [1, 2], '2026-08-20': [3, 4], '2026-09-02': [5, 6], '2026-09-03': [7, 8] });
  try {
    // Sabotage the older files AFTER a cold read proves they were readable: a
    // warm read that parsed them would now throw, so "skipped" is observable.
    const cold = readEvents(dir, activityReadWindow(0, null));
    assert.deepEqual(cold.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
    const cursor = advanceActivityCursor({ seq: 0, at: null }, cold.slice(0, 6));  // projected through seq 6, day 09-02
    for (const day of ['2026-08-04', '2026-08-20']) fs.writeFileSync(path.join(dir, `events-${day}.jsonl`), 'not json\n');
    assert.equal(activityReadWindow(cursor.seq, cursor.at).sinceDate.slice(0, 10), '2026-09-01', 'the skip day is ONE DAY before the cursor (the margin)');
    const warm = readEvents(dir, activityReadWindow(cursor.seq, cursor.at));
    assert.deepEqual(warm.map((e) => e.seq), [7, 8], 'only the events past the cursor');
    // ⚠️ same-day segment is NOT skipped: an event landing later on the cursor's day is still read.
    fs.appendFileSync(path.join(dir, 'events-2026-09-02.jsonl'), ev(9, '2026-09-02') + '\n');
    const sameDay = readEvents(dir, activityReadWindow(cursor.seq, cursor.at));
    assert.deepEqual(sameDay.map((e) => e.seq), [7, 8, 9]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#1150 NEGATIVE CONTROL — without the date the same warm read parses the sabotaged files (the skip is what changed)', () => {
  const dir = logDir({ '2026-08-04': [1], '2026-09-03': [2] });
  try {
    fs.writeFileSync(path.join(dir, 'events-2026-08-04.jsonl'), 'not json\n');
    // parseSegment tolerates junk lines (the log carries junk by design), so the
    // observable is not a throw: it is that the old file is OPENED. Pin that by
    // making it unreadable.
    fs.chmodSync(path.join(dir, 'events-2026-08-04.jsonl'), 0o000);
    assert.throws(() => readEvents(dir, { sinceSeq: 1 }), /EACCES|permission/i, 'no date ⇒ every segment is opened');
    assert.deepEqual(readEvents(dir, activityReadWindow(1, '2026-09-03T00:00:00.000Z')).map((e) => e.seq), [2]);
  } finally { fs.chmodSync(path.join(dir, 'events-2026-08-04.jsonl'), 0o644); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#1150 ⛔ NEGATIVE CONTROL (a second reader\'s) — an event BACKDATED into the previous day\'s segment, with a newer seq, is still read by the warm window', () => {
  // Segments are chosen by the record's own recorded_at (appendEvent), so an
  // event stamped earlier than the cursor lands in an OLDER file. With a
  // zero-margin skip that file is never opened and the event is silently lost.
  const dir = logDir({ '2026-09-01': [1, 2], '2026-09-02': [3, 4] });
  try {
    const cursor = advanceActivityCursor({ seq: 0, at: null }, readEvents(dir, { sinceSeq: 0 }));   // through seq 4, day 09-02
    fs.appendFileSync(path.join(dir, 'events-2026-09-01.jsonl'), ev(5, '2026-09-01') + '\n');       // seq 5, backdated a day
    const warm = readEvents(dir, activityReadWindow(cursor.seq, cursor.at));
    assert.deepEqual(warm.map((e) => e.seq), [5], 'the backdated event is projected, not dropped');
    // And the same read with NO margin would have dropped it — pins that the margin is what saves it.
    const zeroMargin = readEvents(dir, { sinceSeq: cursor.seq, sinceDate: cursor.at });
    assert.deepEqual(zeroMargin, [], 'zero margin loses the event silently; this is the defect the margin exists for');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('#1150 WIRING — the warm sync in server.js reads activities through the window, not a bare sinceSeq', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(src, /readEvents\(EVENT_LOG_DIR, activityReadWindow\(_activitySeq, _activityAt\)\)/);
  assert.doesNotMatch(src, /readEvents\(EVENT_LOG_DIR, \{ sinceSeq: _activitySeq \}\)/);
});
