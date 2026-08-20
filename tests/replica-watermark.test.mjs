/**
 * #949 — THE REPLICA MUST BE ABLE TO SAY WHICH STORE STATE IT REPRESENTS.
 *
 * ⛔ THE DEFECT IS UNKNOWABILITY, NOT LAG. Measured 2026-08-20: the replica was
 * current at that moment, and `cursors.json` tracks an `acked` position for
 * FOUR consumers — every one of them a seat. The replica, whose answers this
 * room treats as authoritative, is not a consumer and records nothing.
 *
 * ⇒ So a caller cannot distinguish "current" from "four minutes behind", which
 * is exactly what #931 produced against #857's own acceptance query: a wrong
 * number that looked right, found by accident.
 *
 * ⭐ THE MECHANISM READS A NUMBER THAT ALREADY FLOWS PAST. `seq` is monotonic on
 * every event; `writeBoard` stamps the document and its events with the SAME
 * `now`. So the document's `lastUpdated` maps exactly onto a seq, and no new
 * bookkeeping is invented.
 *
 * ⚠️ WHAT THIS FILE PINS, AND WHAT IT CANNOT.
 *
 * The write order is `appendEvent` → `saveDomain` → `_graphDirty = true`, and
 * the sync reads the DOCUMENT (server.js:695) then the EVENTS (server.js:739)
 * with an awaited, yielding projection between them. So the two halves can sit
 * at different positions, and the activity cursor `_activitySeq` would
 * OVERSTATE what the document half contains.
 *
 * ⇒ `seqAsOf(docStamp)` is therefore the honest anchor: the newest seq whose
 * event was recorded at or before the bytes we actually projected.
 *
 * ⛔ These are single-threaded tests. They prove the number is DERIVED
 * CORRECTLY. They do NOT prove it is correct under concurrency — and per
 * a colleague, that is the only failure mode this path actually has, because #931
 * is a race that tests structurally do not catch. That limit is stated on the
 * card rather than papered over with an easier control.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, seqAsOf } from '../core/event-log.mjs';
// ⛔ headSeq lives in cursor-service, not here — see the note in event-log.mjs.
// I wrote a duplicate before discovering it; the parser caught the collision.
import { headSeq } from '../core/cursor-service.mjs';

function freshLog() {
  return mkdtempSync(join(tmpdir(), 'watermark-'));
}

/** One ordinary card write, stamped at `now` — the shape writeBoard produces. */
function write(dir, id, now) {
  return appendEvent(dir, {
    op: 'update',
    entity: { kind: 'card', id: String(id) },
    actor: 'ada',
    state: { id: String(id) },
  }, { now });
}

test('headSeq reports the log head', () => {
  const dir = freshLog();
  try {
    assert.equal(headSeq(dir), 0, 'an empty log has no head');
    write(dir, 1, '2026-08-20T10:00:00.000Z');
    write(dir, 2, '2026-08-20T10:01:00.000Z');
    const last = write(dir, 3, '2026-08-20T10:02:00.000Z');
    assert.equal(headSeq(dir), last.seq);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/**
 * ⭐ THE CONTROL. This is the test that fails if `seqAsOf` ignores its stamp and
 * returns the head — which is the single most likely way to ship a watermark
 * that is always green. An implementation that cannot return an OLDER seq than
 * head is not a watermark, it is a constant wearing one's name.
 */
test('seqAsOf DISCRIMINATES — an older document stamp yields an older seq', () => {
  const dir = freshLog();
  try {
    const a = write(dir, 1, '2026-08-20T10:00:00.000Z');
    const b = write(dir, 2, '2026-08-20T10:01:00.000Z');
    const c = write(dir, 3, '2026-08-20T10:02:00.000Z');

    assert.equal(headSeq(dir), c.seq, 'precondition: c is the head');

    // The document was saved at b's stamp: two writes are in those bytes, the
    // third is not. A watermark that answers `c.seq` here is lying by exactly
    // the amount that matters.
    assert.equal(seqAsOf(dir, '2026-08-20T10:01:00.000Z'), b.seq);
    assert.notEqual(seqAsOf(dir, '2026-08-20T10:01:00.000Z'), c.seq);

    assert.equal(seqAsOf(dir, '2026-08-20T10:00:00.000Z'), a.seq);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('seqAsOf is INCLUSIVE of its stamp — the write that produced the document counts', () => {
  const dir = freshLog();
  try {
    const a = write(dir, 1, '2026-08-20T10:00:00.000Z');
    // writeBoard stamps the doc and its events with the SAME instant, so an
    // exclusive comparison would report the replica as behind on every single
    // sync — permanently, quietly, and in the reassuring direction.
    assert.equal(seqAsOf(dir, a.recorded_at), a.seq);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('seqAsOf returns 0 when the document predates every event', () => {
  const dir = freshLog();
  try {
    write(dir, 1, '2026-08-20T10:00:00.000Z');
    assert.equal(seqAsOf(dir, '2026-08-19T00:00:00.000Z'), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/**
 * Segments are day-named, so an anchor older than the newest day must walk back
 * a file rather than stopping at the newest one — the same bounded-scan shape
 * `nextSeq` uses, and the case a single-segment test would silently miss.
 */
test('seqAsOf crosses segment boundaries', () => {
  const dir = freshLog();
  try {
    const older = write(dir, 1, '2026-08-18T09:00:00.000Z');
    write(dir, 2, '2026-08-20T09:00:00.000Z');
    write(dir, 3, '2026-08-20T09:30:00.000Z');
    assert.equal(seqAsOf(dir, '2026-08-19T12:00:00.000Z'), older.seq);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/**
 * ⚠️ THE PROPERTY THAT MAKES THE WATERMARK WORTH SHIPPING, stated as a test so
 * it cannot quietly stop being true: when the document is BEHIND the log, the
 * pair must be UNEQUAL. That inequality is the only thing that would have
 * turned #931's four silent minutes into a four-second answer.
 */
test('a document behind the log reports projectedThrough < storeHead', () => {
  const dir = freshLog();
  try {
    write(dir, 1, '2026-08-20T10:00:00.000Z');
    const docStamp = '2026-08-20T10:00:00.000Z';
    // A write lands after the document was snapshotted — the #931 window.
    write(dir, 2, '2026-08-20T10:00:30.000Z');

    const projectedThrough = seqAsOf(dir, docStamp);
    const storeHead = headSeq(dir);

    assert.ok(projectedThrough < storeHead, 'the gap must be visible');
    assert.equal(storeHead - projectedThrough, 1, 'and it must say how far behind');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
