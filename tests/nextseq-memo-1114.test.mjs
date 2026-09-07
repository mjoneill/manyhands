/**
 * #1114 — `nextSeq` re-parsed the whole newest segment to read ONE integer.
 *
 * Measured on the live log (2026-09-07): 26 ms per call against an 8.5 MB
 * segment at midday, and `writeBoard` calls it ONCE PER EVENT. The segment is
 * day-scoped, so the cost grows all day and resets at midnight — the previous
 * day's peak was 23 MB. It is the one straightforwardly wasteful line in a
 * write path whose measured floor is ~430 ms.
 *
 * The fix memoizes the last seq per directory. THE HAZARD THAT MEMO CREATES is
 * an appender this process cannot see: today the REST server is the only writer
 * (MCP proxies to it over HTTP), but tests, repair scripts and a second server
 * on the same directory all append, and a stale memo would MINT A DUPLICATE
 * SEQ — silently, into an append-only log whose whole promise is a total order.
 *
 * So the memo is validated by a `stat` of the segment it was built from, which
 * is the cheap half of what the parse was buying. The tests below are mostly
 * about the invalidation, not the speedup: a memo that is merely fast is not
 * the deliverable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextSeq, appendEvent } from '../core/event-log.mjs';

const seg = (iso) => `events-${iso.slice(0, 10)}.jsonl`;
const line = (seq, recorded_at) => JSON.stringify({
  seq, recorded_at, occurred_at: recorded_at, actor: 'ada', op: 'update',
  entity: { kind: 'card', id: 'c1' }, state: { id: 'c1' },
}) + '\n';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'nextseq-1114-'));
  return dir;
}

test('#1114 — the seq an event is STAMPED with is the one nextSeq promised', (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = new Date().toISOString();
  writeFileSync(join(dir, seg(now)), line(41, now));

  assert.equal(nextSeq(dir), 42);
  const stored = appendEvent(dir, { op: 'update', actor: 'ada', entity: { kind: 'card', id: 'c1' }, state: { id: 'c1' } });
  assert.equal(stored.seq, 42, 'appendEvent must stamp the seq nextSeq reported');
  assert.equal(nextSeq(dir), 43, 'and the NEXT one must move past it');
});

test('#1114 — a run of appends is strictly monotonic with no gaps and no repeats', (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seqs = [];
  for (let i = 0; i < 25; i++) {
    seqs.push(appendEvent(dir, { op: 'update', actor: 'ada', entity: { kind: 'card', id: 'c1' }, state: { i } }).seq);
  }
  assert.deepEqual(seqs, Array.from({ length: 25 }, (_, i) => i + 1));
  // The FILE, not the return values — a memo that drifts from disk is the bug.
  const onDisk = readFileSync(join(dir, seg(new Date().toISOString())), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l).seq);
  assert.deepEqual(onDisk, seqs, 'what was written must match what was reported');
});

test('#1114 ⛔ THE MEMO HAZARD — an append by ANOTHER writer must not be overwritten', (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = new Date().toISOString();

  // This process appends, so it now holds a memo.
  assert.equal(appendEvent(dir, { op: 'update', actor: 'ada', entity: { kind: 'card', id: 'c1' }, state: {} }).seq, 1);

  // Something outside this process appends 2 and 3 — a repair script, a test,
  // a second server. The memo says "next is 2" and the memo is now WRONG.
  appendFileSync(join(dir, seg(now)), line(2, now) + line(3, now));

  assert.equal(nextSeq(dir), 4, 'nextSeq must see the foreign append, not its own stale memo');
  const stored = appendEvent(dir, { op: 'update', actor: 'ada', entity: { kind: 'card', id: 'c1' }, state: {} });
  assert.equal(stored.seq, 4, 'and must not MINT A DUPLICATE of a seq it did not write');

  const seqs = readFileSync(join(dir, seg(now)), 'utf8').trim().split('\n').map((l) => JSON.parse(l).seq);
  assert.deepEqual(seqs, [1, 2, 3, 4], 'the log stays a total order');
  assert.equal(new Set(seqs).size, seqs.length, 'no duplicate seq reaches disk');
});

test('#1114 — a TRUNCATED segment invalidates the memo too (size change, not just growth)', (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = new Date().toISOString();
  for (let i = 0; i < 5; i++) appendEvent(dir, { op: 'update', actor: 'ada', entity: { kind: 'card', id: 'c1' }, state: {} });
  assert.equal(nextSeq(dir), 6);

  // A rollback/repair rewrites the segment shorter. A memo keyed on "did it
  // GROW" would sail past this; the seq must follow the FILE.
  writeFileSync(join(dir, seg(now)), line(1, now) + line(2, now));
  assert.equal(nextSeq(dir), 3, 'the memo must follow a segment that got SMALLER');
});

test('#1114 — the memo is per-DIRECTORY, so two logs cannot bleed into each other', (t) => {
  const a = fixture(), b = fixture();
  t.after(() => { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); });
  for (let i = 0; i < 7; i++) appendEvent(a, { op: 'update', actor: 'ada', entity: { kind: 'card', id: 'c1' }, state: {} });
  assert.equal(nextSeq(a), 8);
  assert.equal(nextSeq(b), 1, 'an untouched log starts at 1 regardless of the other');
  assert.equal(appendEvent(b, { op: 'update', actor: 'ada', entity: { kind: 'card', id: 'c1' }, state: {} }).seq, 1);
  assert.equal(nextSeq(a), 8, 'and writing b must not disturb a');
});

test('#1114 — the memo does NOT re-read the segment (the point of the card)', (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (let i = 0; i < 200; i++) appendEvent(dir, { op: 'update', actor: 'ada', entity: { kind: 'card', id: 'c1' }, state: { pad: 'x'.repeat(2000) } });

  // A behavioural proxy for "it didn't parse 200 lines": make the segment
  // UNPARSEABLE while holding its IDENTITY (size AND mtime) fixed, so a
  // re-parse would give a different answer than the memo. A memo that is
  // genuinely answering from cache returns 201; any implementation that reads
  // the file falls back, because every line is now torn.
  //
  // ⚠️ The mtime restore is what makes this a test of the memo rather than a
  // test of the invalidation — WITHOUT it the write bumps mtime, the memo
  // correctly invalidates, and this test would pass for the opposite reason.
  const p = join(dir, seg(new Date().toISOString()));
  // Pin the segment to a WHOLE-SECOND mtime before the memo is built. Real
  // mtimes carry sub-millisecond precision that `utimes` rounds away, so a
  // restore of a natural mtime cannot reproduce the identity the memo holds —
  // which would make this a test of the invalidation instead.
  const pinned = new Date(Math.floor(Date.now() / 1000) * 1000);
  utimesSync(p, pinned, pinned);
  assert.equal(nextSeq(dir), 201, 'memo established against the pinned identity');

  const before = readFileSync(p);
  const st = statSync(p);
  const corrupted = Buffer.from(before.toString('utf8').replace(/^\{/gm, '#'), 'utf8');
  assert.equal(corrupted.length, before.length, 'the corruption must be size-neutral or this test proves nothing');
  writeFileSync(p, corrupted);
  utimesSync(p, st.atime, st.mtime);
  assert.equal(statSync(p).mtimeMs, st.mtimeMs, 'identity must be unchanged or this test proves nothing');

  assert.equal(nextSeq(dir), 201, 'answered from the memo, without parsing');
});
