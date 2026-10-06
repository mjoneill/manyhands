/**
 * THE EVENT LOG IS NO LONGER FULLY PARSED ON EVERY INBOUND CALL (the builder's perf commit 4d8668f: `readEvents` skips day-segments whose cached max seq cannot satisfy `sinceSeq`;
 * new `oldestEvent` answers `retentionGap` from the first valid line instead of parsing and sorting every segment). Written by the separate test author after reading the diff, with the
 * OLD module as the oracle: `core/event-log-oracle-before-4d8668f.mjs` is `git show 4d8668f~1:core/event-log.mjs` BYTE FOR BYTE (sha256 9b8cb4ef96f8c6ea453e91bed2d52b9b020af6eb27730789df5a6427f69a9fbf),
 * so every equivalence row compares the new code against the old BYTES, not against my reading of them. Synthetic logs, written to a temp directory per row.
 *
 *   V0  CONTROL: the oracle is the old module (it has no `oldestEvent`), the corpus is non-trivial, and old and new both read it.
 *   V1  readEvents EQUIVALENCE: for each log shape (ordinary; later segment holding LOWER seqs than an earlier one; torn/blank/garbage lines and odd seq types; multi-byte text; duplicate seqs across
 *       segments; empty, absent and non-segment files) and each of sinceSeq x limit x sinceDate, new deep-equals old. The new reader is called in an order that exercises its cache (a full read
 *       first, then ascending, then descending sinceSeq), so a stale skip shows up. V1b: odd sinceSeq values (-1, 2.5, Infinity, null, '3').
 *   V2  THE CACHE NEVER RETURNS LESS: after the cache is populated, a segment that is appended to (an old one and the newest), added, deleted, rewritten at a different size, rewritten at the same
 *       size with a different mtime (V2b: the cached max is below the next sinceSeq and the rewrite raises it), or GROWN with its mtime put back (V2e) is read as the old code reads it. A lower sinceSeq after a higher one returns the full window. Two directories with the SAME segment file names and different
 *       content never see each other's cache.
 *   V3  oldestEvent EQUIVALENCE (and retentionGap, V6) on logs where seq grows with the segment name and within a segment: ordinary; the first segment empty; the first lines torn or garbage; a 3-byte
 *       character straddling the 64 KB read boundary; a first line longer than 64 KB; a last line with no newline; no segments; an absent directory.
 *   V3b THE DOCUMENTED ASSUMPTION, PINNED (ruled by the builder 12:50Z, was a todo): on an out-of-order log (a later-named segment holding a lower seq, or a lower seq after the first valid line within a
 *       segment) the old function returned the minimum seq and the new one returns the first valid line of the earliest-named segment. That is the documented behaviour; the row pins it so it cannot change silently.
 *   V4  oldestEvent's cache is invalidated: the first segment is pruned; an EARLIER segment appears (a backfill); the only segment goes from empty to one line; the first segment is rewritten (the
 *       oldest event redacted in place) at a different size, and at the same size with a different mtime. Each answer equals the old function's.
 *   V5  POSITIVE CONTROLS, so a skip that never fires cannot pass: on a 16-segment, ~48 MB log, a second `readEvents` at sinceSeq = the highest seq is more than 5x faster than the first full read
 *       and returns what the oracle returns; a cold `oldestEvent` is more than 10x faster than the old `readEvents(dir, {limit: 1})[0]` and returns what it returns.
 *   V5c/V5d DETERMINISTIC COST PROOFS (no clock): the later segments are made UNREADABLE (mode 000; stat still works, read does not). The old reader throws EACCES on such a log, so the control
 *       proves the files are unreadable; the new `oldestEvent` still answers from the first segment (it reads nothing past it), and a cached `readEvents` still answers when the unreadable segment
 *       cannot hold anything newer than sinceSeq (it is skipped, not read).
 *   V7  #684, folded in at the builder's question, and SEPARATE from the equivalence rows: one day-segment above the engine's spread-argument limit (150,000 events; the limit on this node is between 110k
 *       and 120k) must still be readable. The old code throws RangeError on it (control). RED on 4d8668f by design: the spread `all.push(...evs)` is still there.
 *   V6  retentionGap EQUIVALENCE: the new `retentionGap(dir, acked)` deep-equals the old body (reproduced from the diff: `readEvents(dir, {limit: 1})[0]`, then the same four fields) for acked values
 *       around the first seq, on the V3 shapes.
 *
 * NOT COVERED, by name: a segment rewritten with the SAME size AND the SAME mtimeMs (the cache keys on both and cannot see it; not pinned as behaviour either way); a write between the stat and the parse
 * (a race, argued correct in the code's comment, not driven here); concurrent appenders; the cursor service's other uses of readEvents; memory growth of the per-path cache; the live log (measured once
 * by hand against a copy of the oracle, not a row).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as NEW from '../core/event-log.mjs';
import * as OLD from '../core/event-log-oracle-before-4d8668f.mjs';
import { retentionGap } from '../core/cursor-service.mjs';

let n = 0;
const made = [];
process.on('exit', () => { for (const d of made) { try { fs.chmodSync(d, 0o755); fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } } });   // ~55 MB of synthetic logs per run: do not leave them
const mkdir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `evl-${process.pid}-${++n}-`)); made.push(d); return d; };
const ev = (seq, day, extra = {}) => ({ seq, op: 'create', actor: 'ada', entity: { kind: 'card', id: `c${seq}` }, recorded_at: `${day}T10:00:${String(seq % 60).padStart(2, '0')}.000Z`, state: { n: seq }, ...extra });
const line = (o) => (typeof o === 'string' ? o : JSON.stringify(o));
const seg = (dir, day, lines, { mtime = null, trailingNewline = true } = {}) => {
  const f = path.join(dir, `events-${day}.jsonl`);
  fs.writeFileSync(f, lines.map(line).join('\n') + (lines.length && trailingNewline ? '\n' : ''));
  if (mtime != null) fs.utimesSync(f, new Date(mtime), new Date(mtime));
  return f;
};
const T0 = Date.UTC(2026, 9, 1);
const touch = (f, ms) => fs.utimesSync(f, new Date(ms), new Date(ms));
const range = (a, b, day) => Array.from({ length: b - a + 1 }, (_, i) => ev(a + i, day));

/** Every shape builds into a fresh directory and returns it. `lawful` = seq grows with the segment name and within a segment. */
const SHAPES = {
  ordinary: { lawful: true, build: (d) => { seg(d, '2026-09-01', range(1, 10, '2026-09-01')); seg(d, '2026-09-02', range(11, 20, '2026-09-02')); seg(d, '2026-09-03', range(21, 30, '2026-09-03')); seg(d, '2026-09-04', range(31, 40, '2026-09-04')); } },
  'later segment holds lower seqs': { lawful: false, build: (d) => { seg(d, '2026-09-01', range(11, 14, '2026-09-01')); seg(d, '2026-09-02', range(5, 8, '2026-09-02')); seg(d, '2026-09-03', range(20, 22, '2026-09-03')); } },
  'torn, blank, garbage and odd seq types': { lawful: true, build: (d) => {
    seg(d, '2026-09-01', ['{"seq": 1, "op": "create", "tor', '', '   ', 'not json at all', line(ev(2, '2026-09-01')), '{"seq":"7","op":"create"}', '{"seq":1.5,"op":"create"}', '{"seq":null}', '{"op":"create"}', line(ev(3, '2026-09-01'))]);
    seg(d, '2026-09-02', [line(ev(10, '2026-09-02')), '{"seq": 11, "op": "cre']);
    seg(d, '2026-09-03', [line(ev(12, '2026-09-03')), line(ev(13, '2026-09-03'))], { trailingNewline: false });
  } },
  'multi-byte text': { lawful: true, build: (d) => { seg(d, '2026-09-01', [ev(1, '2026-09-01', { state: { t: 'café € \u{1F600}' } }), ev(2, '2026-09-01', { state: { t: '€€€' } })]); seg(d, '2026-09-02', [ev(3, '2026-09-02', { state: { t: '\u{1F600}' } })]); } },
  'duplicate seqs across segments': { lawful: true, build: (d) => { seg(d, '2026-09-01', range(1, 5, '2026-09-01')); seg(d, '2026-09-02', [ev(5, '2026-09-02', { state: { copy: 'second' } }), ...range(6, 8, '2026-09-02')]); } },
  'an empty segment first': { lawful: true, build: (d) => { seg(d, '2026-09-01', []); seg(d, '2026-09-02', range(4, 6, '2026-09-02')); seg(d, '2026-09-03', range(7, 9, '2026-09-03')); } },
  'first segment all torn': { lawful: true, build: (d) => { seg(d, '2026-09-01', ['{"seq": 1, "op"', 'garbage', '']); seg(d, '2026-09-02', range(4, 6, '2026-09-02')); } },
  'a single segment, no trailing newline': { lawful: true, build: (d) => { seg(d, '2026-09-01', range(1, 3, '2026-09-01'), { trailingNewline: false }); } },
  'non-segment files only': { lawful: true, build: (d) => { fs.writeFileSync(path.join(d, 'cursors.json'), '{}'); fs.writeFileSync(path.join(d, 'events-2026-09-01.jsonl.bak'), line(ev(1, '2026-09-01'))); fs.writeFileSync(path.join(d, 'notes.txt'), 'x'); } },
  'no segments, empty directory': { lawful: true, build: () => {} },
  'absent directory': { lawful: true, build: (d) => { fs.rmSync(d, { recursive: true, force: true }); } },
};
const shape = (name) => { const d = mkdir(); SHAPES[name].build(d); return d; };
const eq = (a, b, why) => assert.deepEqual(a, b, why);
const seqsOf = (events) => events.map((e) => e.seq);

test('V0 CONTROL: the oracle is the old module, the corpus is non-trivial, and old and new both read it', () => {
  assert.equal(typeof OLD.oldestEvent, 'undefined', 'the oracle has no oldestEvent: it is the module before the change');
  assert.equal(typeof OLD.readEvents, 'function');
  assert.equal(typeof NEW.readEvents, 'function');
  const d = shape('ordinary');
  assert.equal(OLD.readEvents(d).length, 40, 'the oracle reads 40 events');
  assert.equal(NEW.readEvents(d).length, 40, 'the new code reads 40 events');
  assert.equal(OLD.readEvents(d, { sinceSeq: 40 }).length, 0, 'and a read past the end is empty, so the grid below has both empty and non-empty cells');
});

test('V1 readEvents EQUIVALENCE: every log shape x sinceSeq x limit x sinceDate, with the new reader called in an order that exercises its cache', () => {
  let cells = 0; let nonEmpty = 0; let empty = 0;
  for (const name of Object.keys(SHAPES)) {
    const d = shape(name);
    const all = OLD.readEvents(d); const seqs = seqsOf(all);
    const lo = seqs.length ? Math.min(...seqs) : 1; const hi = seqs.length ? Math.max(...seqs) : 1;
    const sinces = [...new Set([0, lo - 1, Math.floor((lo + hi) / 2), hi - 1, hi, hi + 1])];
    const grid = [];
    for (const sinceDate of [null, '2026-09-02']) for (const limit of [Infinity, 1, 3]) for (const s of sinces) grid.push({ sinceSeq: s, limit, sinceDate });
    // new reader: a full read first (populates the cache), then ascending, then descending sinceSeq
    NEW.readEvents(d);
    const order = [...grid.sort((a, b) => a.sinceSeq - b.sinceSeq), ...[...grid].reverse()];
    for (const opts of order) {
      const o = OLD.readEvents(d, opts); const nw = NEW.readEvents(d, opts);
      eq(nw, o, `[${name}] ${JSON.stringify(opts)}: new differs from old (new seqs ${JSON.stringify(seqsOf(nw))} vs old ${JSON.stringify(seqsOf(o))})`);
      cells++; if (o.length) nonEmpty++; else empty++;
    }
  }
  assert.ok(cells > 300 && nonEmpty > 100 && empty > 50, `the grid really ran and has both outcomes (${cells} cells, ${nonEmpty} non-empty, ${empty} empty)`);
});

test('V1b odd sinceSeq values read the same as the old code: -1, 2.5, Infinity, null, "3", undefined', () => {
  for (const name of ['ordinary', 'torn, blank, garbage and odd seq types', 'duplicate seqs across segments']) {
    const d = shape(name);
    NEW.readEvents(d);
    for (const sinceSeq of [-1, 2.5, Infinity, null, '3', undefined, 3]) {
      eq(NEW.readEvents(d, { sinceSeq }), OLD.readEvents(d, { sinceSeq }), `[${name}] sinceSeq=${String(sinceSeq)}`);
    }
  }
});

test('V2a THE CACHE NEVER RETURNS LESS: an appended old segment, an appended newest segment, an added segment and a deleted segment are read as the old code reads them', () => {
  const d = shape('ordinary');
  const check = (what, opts = { sinceSeq: 0 }) => eq(NEW.readEvents(d, opts), OLD.readEvents(d, opts), what);
  NEW.readEvents(d); NEW.readEvents(d, { sinceSeq: 40 });   // every segment is now cached with max <= 40
  check('baseline, after the cache is populated', { sinceSeq: 40 });
  const old1 = path.join(d, 'events-2026-09-01.jsonl');
  fs.appendFileSync(old1, line(ev(41, '2026-09-01')) + '\n'); touch(old1, T0 + 10_000);
  check('an OLD cached segment gained an event above sinceSeq: it must be read', { sinceSeq: 40 });
  assert.ok(seqsOf(NEW.readEvents(d, { sinceSeq: 40 })).includes(41), 'and 41 is in the answer');
  const newest = path.join(d, 'events-2026-09-04.jsonl');
  fs.appendFileSync(newest, line(ev(42, '2026-09-04')) + '\n'); touch(newest, T0 + 20_000);
  check('the newest segment gained an event', { sinceSeq: 41 });
  seg(d, '2026-09-05', [ev(43, '2026-09-05')], { mtime: T0 + 30_000 });
  check('a new segment appeared', { sinceSeq: 42 });
  fs.rmSync(path.join(d, 'events-2026-09-02.jsonl'));
  check('a cached segment was deleted (pruned)', { sinceSeq: 0 });
  assert.ok(!seqsOf(NEW.readEvents(d)).includes(15), 'and its events are gone from the answer');
});

test('V2b THE CACHE NEVER RETURNS LESS: a segment rewritten at a different size, and one rewritten at the SAME size with a different mtime, are read as the old code reads them', () => {
  const d = shape('ordinary');
  NEW.readEvents(d); NEW.readEvents(d, { sinceSeq: 40 });
  const f2 = path.join(d, 'events-2026-09-02.jsonl');
  fs.writeFileSync(f2, [ev(11, '2026-09-02'), ev(99, '2026-09-02', { state: { rewritten: 'longer content than before' } })].map(line).join('\n') + '\n'); touch(f2, T0 + 40_000);
  eq(NEW.readEvents(d, { sinceSeq: 40 }), OLD.readEvents(d, { sinceSeq: 40 }), 'rewritten at a different size');
  assert.ok(seqsOf(NEW.readEvents(d, { sinceSeq: 40 })).includes(99), 'and 99 is in the answer');
  // same size, new mtime. The cache must hold max 55 <= the sinceSeq of the next read, and the rewrite must RAISE the max, so a cache that ignores the mtime answers from the stale max.
  fs.writeFileSync(f2, [ev(11, '2026-09-02'), ev(55, '2026-09-02', { state: { rewritten: 'a different length of content, so the size differs from the step above' } })].map(line).join('\n') + '\n'); touch(f2, T0 + 45_000);
  NEW.readEvents(d, { sinceSeq: 99 });   // the size changed, so this re-reads f2 and caches it with max 55
  const before = fs.readFileSync(f2, 'utf8');
  const swapped = before.replace('"seq":55', '"seq":88');
  assert.equal(swapped.length, before.length, 'SETUP CONTROL: the rewrite keeps the byte length');
  fs.writeFileSync(f2, swapped); touch(f2, T0 + 50_000);
  eq(NEW.readEvents(d, { sinceSeq: 60 }), OLD.readEvents(d, { sinceSeq: 60 }), 'rewritten at the same size, different mtime');
  assert.ok(seqsOf(NEW.readEvents(d, { sinceSeq: 60 })).includes(88), 'and 88, above the cached max of 55, is in the answer');
  eq(NEW.readEvents(d, { sinceSeq: 0 }), OLD.readEvents(d, { sinceSeq: 0 }), 'and a full read agrees');
});

test('V2e THE CACHE NEVER RETURNS LESS: a segment that GROWS while its mtime is put back to the cached value is read as the old code reads it (the size half of the key)', () => {
  const d = shape('ordinary');
  const f3 = path.join(d, 'events-2026-09-03.jsonl');
  touch(f3, T0 + 5_000);
  NEW.readEvents(d); NEW.readEvents(d, { sinceSeq: 99 });   // every segment cached, f3 with max 30 at mtime T0+5000
  fs.appendFileSync(f3, line(ev(120, '2026-09-03')) + '\n'); touch(f3, T0 + 5_000);   // bigger, same mtime
  eq(NEW.readEvents(d, { sinceSeq: 100 }), OLD.readEvents(d, { sinceSeq: 100 }), 'grown at the same mtime');
  assert.deepEqual(seqsOf(NEW.readEvents(d, { sinceSeq: 100 })), [120], '120, above the cached max, is in the answer');
});

test('V2c A LOWER sinceSeq AFTER A HIGHER ONE returns the full window, not the cached emptiness', () => {
  const d = shape('ordinary');
  assert.equal(NEW.readEvents(d, { sinceSeq: 40 }).length, 0, 'SETUP: a read at the top caches every segment as <= 40');
  for (const s of [39, 25, 10, 0]) eq(NEW.readEvents(d, { sinceSeq: s }), OLD.readEvents(d, { sinceSeq: s }), `sinceSeq=${s}`);
  assert.equal(NEW.readEvents(d, { sinceSeq: 0 }).length, 40);
});

test('V2d TWO DIRECTORIES WITH THE SAME SEGMENT NAMES never see each other\'s cache', () => {
  const a = mkdir(); const b = mkdir();
  seg(a, '2026-09-01', range(1, 5, '2026-09-01')); seg(b, '2026-09-01', range(100, 105, '2026-09-01'));
  NEW.readEvents(a, { sinceSeq: 5 }); NEW.readEvents(b, { sinceSeq: 105 });
  eq(NEW.readEvents(a, { sinceSeq: 2 }), OLD.readEvents(a, { sinceSeq: 2 }), 'a, after b was cached');
  eq(NEW.readEvents(b, { sinceSeq: 102 }), OLD.readEvents(b, { sinceSeq: 102 }), 'b, after a was cached');
  eq(NEW.readEvents(a, { sinceSeq: 0 }), OLD.readEvents(a, { sinceSeq: 0 }), 'a, full');
  assert.deepEqual(seqsOf(NEW.readEvents(b, { sinceSeq: 0 })), [100, 101, 102, 103, 104, 105]);
});

const LAWFUL = Object.keys(SHAPES).filter((k) => SHAPES[k].lawful);
test('V3 oldestEvent EQUIVALENCE: on logs where seq grows with the segment name, it returns what the old readEvents(dir, {limit: 1})[0] returned', () => {
  assert.equal(typeof NEW.oldestEvent, 'function', 'the new module exports oldestEvent');
  for (const name of LAWFUL) { const d = shape(name); eq(NEW.oldestEvent(d), OLD.readEvents(d, { limit: 1 })[0] ?? null, `[${name}]`); }
});

test('V3 oldestEvent EQUIVALENCE: a 3-byte character straddling the 64 KB read boundary, a first line longer than 64 KB, and a last line with no newline', () => {
  assert.equal(typeof NEW.oldestEvent, 'function', 'the new module exports oldestEvent');
  // a first line whose bytes put the euro sign (3 bytes) across offset 65536
  const head = JSON.stringify(ev(1, '2026-09-01', { state: { t: '' } }));
  const pad = 65536 - Buffer.byteLength(head) - 2;   // the closing "}} sits after the string; position the sign to straddle
  for (const offset of [0, 1, 2]) {
    const d = mkdir();
    const text = 'x'.repeat(Math.max(0, pad + 1 - offset)) + '€€€';
    seg(d, '2026-09-01', [ev(1, '2026-09-01', { state: { t: text } }), ev(2, '2026-09-01')]);
    const first = NEW.oldestEvent(d);
    eq(first, OLD.readEvents(d, { limit: 1 })[0], `a euro sign near byte 65536 (offset ${offset}): the first event is read intact`);
    assert.equal(first.state.t, text, 'and its text is byte-for-byte what was written');
  }
  const big = mkdir(); seg(big, '2026-09-01', [ev(1, '2026-09-01', { state: { t: 'y'.repeat(200_000) } }), ev(2, '2026-09-01')]);
  eq(NEW.oldestEvent(big), OLD.readEvents(big, { limit: 1 })[0], 'a 200 KB first line');
  const nonl = mkdir(); seg(nonl, '2026-09-01', [ev(7, '2026-09-01')], { trailingNewline: false });
  eq(NEW.oldestEvent(nonl), OLD.readEvents(nonl, { limit: 1 })[0], 'a single line with no newline');
});

test('V3b THE DOCUMENTED ASSUMPTION, PINNED: oldestEvent returns the first valid line of the earliest-named segment, NOT the minimum seq, when the log is out of order (a regressed seq or a backward clock step: corruption by #1114)', () => {
  assert.equal(typeof NEW.oldestEvent, 'function', 'the new module exports oldestEvent');
  // segments 2026-09-01: 11..14, 2026-09-02: 5..8, 2026-09-03: 20..22. The old function answered the global minimum (5); the documented behaviour answers the earliest segment's first event (11).
  const a = shape('later segment holds lower seqs');
  assert.equal(OLD.readEvents(a, { limit: 1 })[0].seq, 5, 'CONTROL: the old function answered the global minimum');
  assert.equal(NEW.oldestEvent(a).seq, 11, 'the new function answers the earliest segment\'s first valid event');
  // the same inside ONE segment: a first valid line of 9 then a 3
  const b = mkdir(); seg(b, '2026-09-01', [ev(9, '2026-09-01'), ev(3, '2026-09-01'), ev(10, '2026-09-01')]);
  assert.equal(OLD.readEvents(b, { limit: 1 })[0].seq, 3, 'CONTROL: the old function answered 3');
  assert.equal(NEW.oldestEvent(b).seq, 9, 'the new function answers the first valid line, 9');
});

test('V4 oldestEvent\'s cache is invalidated: the first segment is pruned, an EARLIER segment appears, the only segment goes from empty to one line, and the oldest event is rewritten at a different size and at the same size', () => {
  assert.equal(typeof NEW.oldestEvent, 'function', 'the new module exports oldestEvent');
  const d = shape('ordinary');
  const both = (what) => eq(NEW.oldestEvent(d), OLD.readEvents(d, { limit: 1 })[0] ?? null, what);
  both('baseline (cached)'); both('and again');
  fs.rmSync(path.join(d, 'events-2026-09-01.jsonl')); both('the first segment was pruned');
  assert.equal(NEW.oldestEvent(d).seq, 11, 'the oldest is now the next segment\'s first event');
  seg(d, '2026-08-30', [ev(3, '2026-08-30'), ev(4, '2026-08-30')], { mtime: T0 + 60_000 }); both('an earlier segment appeared (a backfill)');
  assert.equal(NEW.oldestEvent(d).seq, 3);
  const first = path.join(d, 'events-2026-08-30.jsonl');
  fs.writeFileSync(first, [ev(3, '2026-08-30', { state: { redacted: true, text: '[redacted]' } }), ev(4, '2026-08-30')].map(line).join('\n') + '\n'); touch(first, T0 + 70_000);
  both('the oldest event was rewritten in place at a different size');
  const before = fs.readFileSync(first, 'utf8');
  fs.writeFileSync(first, before.replace('"text":"[redacted]"', '"text":"[REDACTED]"')); touch(first, T0 + 80_000);
  assert.equal(fs.readFileSync(first, 'utf8').length, before.length, 'SETUP CONTROL: the second rewrite keeps the byte length');
  both('the oldest event was rewritten at the same size with a different mtime');
  assert.equal(NEW.oldestEvent(d).state.text, '[REDACTED]', 'and the answer carries the new content');
  // a pruned first segment whose successor has the SAME size and the SAME mtime: only the segment list tells them apart
  const c = mkdir();
  const A = seg(c, '2026-09-01', [ev(1, '2026-09-01')]); const B = seg(c, '2026-09-02', [ev(2, '2026-09-02')]);
  assert.equal(fs.statSync(A).size, fs.statSync(B).size, 'SETUP CONTROL: the two segments have the same size');
  touch(A, T0 + 7_000); touch(B, T0 + 7_000);
  assert.equal(NEW.oldestEvent(c).seq, 1);
  fs.rmSync(A);
  eq(NEW.oldestEvent(c), OLD.readEvents(c, { limit: 1 })[0], 'the first segment was pruned and the next has the same size and mtime');
  assert.equal(NEW.oldestEvent(c).seq, 2, 'the oldest is the successor\'s event');
  const e = mkdir();
  const only = seg(e, '2026-09-01', []);
  eq(NEW.oldestEvent(e), null, 'an empty only segment has no oldest event');
  fs.writeFileSync(only, line(ev(1, '2026-09-01')) + '\n'); touch(only, T0 + 90_000);
  eq(NEW.oldestEvent(e), OLD.readEvents(e, { limit: 1 })[0], 'the only segment went from empty to one line');
  assert.equal(NEW.oldestEvent(e).seq, 1);
});

const BIG = (() => {
  let dir = null;
  return () => {
    if (dir) return dir;
    dir = mkdir();
    const pad = 'z'.repeat(900);
    for (let s = 0; s < 16; s++) {
      const day = `2026-08-${String(10 + s).padStart(2, '0')}`;
      const lines = []; for (let i = 0; i < 3300; i++) lines.push(JSON.stringify(ev(s * 3300 + i + 1, day, { state: { pad } })));
      seg(dir, day, lines, { mtime: T0 + s * 1000 });
    }
    return dir;
  };
})();
const timed = (f) => { const t = process.hrtime.bigint(); const r = f(); return { r, ms: Number(process.hrtime.bigint() - t) / 1e6 }; };

test('V5a POSITIVE CONTROL, the skip fires: on a 16-segment, ~48 MB log a second readEvents at sinceSeq = the highest seq is more than 5x faster than the first full read and returns what the oracle returns', () => {
  const d = BIG(); const hi = 16 * 3300;
  const first = timed(() => NEW.readEvents(d, { sinceSeq: 0, limit: 5 }));
  const again = timed(() => NEW.readEvents(d, { sinceSeq: hi - 3 }));
  eq(again.r, OLD.readEvents(d, { sinceSeq: hi - 3 }), 'the skipping read returns exactly what the oracle returns');
  assert.equal(again.r.length, 3);
  assert.ok(again.ms * 5 < first.ms, `the second read (${again.ms.toFixed(1)} ms) is >5x faster than the first (${first.ms.toFixed(1)} ms): the skip fires`);
});

test('V5b POSITIVE CONTROL, oldestEvent does not parse the log: a cold oldestEvent is more than 10x faster than the old readEvents(dir, {limit: 1})[0] and returns the same event', () => {
  assert.equal(typeof NEW.oldestEvent, 'function', 'the new module exports oldestEvent');
  const d = BIG();
  const oldWay = timed(() => OLD.readEvents(d, { limit: 1 })[0]);
  const newWay = timed(() => NEW.oldestEvent(d));
  eq(newWay.r, oldWay.r, 'the same event');
  assert.ok(newWay.ms * 10 < oldWay.ms, `oldestEvent (${newWay.ms.toFixed(1)} ms) is >10x faster than the old way (${oldWay.ms.toFixed(1)} ms)`);
});

const unreadable = (files, body) => { for (const f of files) fs.chmodSync(f, 0o000); try { return body(); } finally { for (const f of files) fs.chmodSync(f, 0o644); } };

test('V5c DETERMINISTIC: oldestEvent reads nothing past the first non-empty segment (the later segments are unreadable, and the old reader throws on them)', () => {
  assert.equal(typeof NEW.oldestEvent, 'function', 'the new module exports oldestEvent');
  const d = shape('ordinary');
  const later = ['2026-09-02', '2026-09-03', '2026-09-04'].map((day) => path.join(d, `events-${day}.jsonl`));
  unreadable(later, () => {
    assert.throws(() => OLD.readEvents(d, { limit: 1 }), /EACCES|permission/i, 'CONTROL: the old reader cannot read this log (it parses every segment)');
    const first = NEW.oldestEvent(d);
    assert.equal(first?.seq, 1, 'the new oldestEvent answers from the first segment alone');
  });
});

test('V5d DETERMINISTIC: a cached readEvents does not read a segment that cannot hold anything newer than sinceSeq (the segment is unreadable, and the old reader throws on it)', () => {
  const d = shape('ordinary');
  NEW.readEvents(d);   // every segment cached with its max (10, 20, 30, 40)
  const old = ['2026-09-01', '2026-09-02', '2026-09-03'].map((day) => path.join(d, `events-${day}.jsonl`));
  unreadable(old, () => {
    assert.throws(() => OLD.readEvents(d, { sinceSeq: 35 }), /EACCES|permission/i, 'CONTROL: the old reader cannot read this log');
    assert.deepEqual(seqsOf(NEW.readEvents(d, { sinceSeq: 35 })), [36, 37, 38, 39, 40], 'the new reader answers from the newest segment and never opens the unreadable ones');
  });
});

test('V7 (#684, folded in) one day-segment above the spread-argument limit is still readable: 150,000 events in one segment', () => {
  const d = mkdir();
  const f = path.join(d, 'events-2026-09-01.jsonl');
  const N = 150_000;
  const chunks = []; for (let i = 1; i <= N; i++) chunks.push(`{"seq":${i},"op":"create"}`);
  fs.writeFileSync(f, chunks.join('\n') + '\n');
  assert.throws(() => OLD.readEvents(d), RangeError, 'CONTROL: the old code throws RangeError on this segment, so 150,000 is above the limit on this node');
  const all = NEW.readEvents(d);
  assert.equal(all.length, N, 'the new reader returns every event');
  assert.equal(all[0].seq, 1); assert.equal(all[N - 1].seq, N);
  assert.deepEqual(seqsOf(NEW.readEvents(d, { sinceSeq: N - 2 })), [N - 1, N], 'and a since-read of it works');
});

const oldRetentionGap = (dir, acked) => {   // the body of retentionGap at 4d8668f~1, from the diff
  const first = OLD.readEvents(dir, { limit: 1 })[0];
  if (!first || first.seq <= acked + 1) return null;
  return { oldestSeq: first.seq, oldestAt: first.recorded_at ?? null, missingFrom: acked + 1, missingTo: first.seq - 1 };
};
test('V6 retentionGap EQUIVALENCE: for acked values around the first seq, on the lawful shapes, the new retentionGap deep-equals the old body', () => {
  let cells = 0; let gaps = 0; let nulls = 0;
  for (const name of LAWFUL) {
    const d = shape(name); const f = OLD.readEvents(d, { limit: 1 })[0]; const s = f ? f.seq : 1;
    for (const acked of [...new Set([0, s - 3, s - 2, s - 1, s, s + 1, s + 100, -1])]) {
      const o = oldRetentionGap(d, acked); const nw = retentionGap(d, acked);
      eq(nw, o, `[${name}] acked=${acked}`);
      cells++; if (o) gaps++; else nulls++;
    }
  }
  assert.ok(cells >= 60 && gaps >= 5 && nulls >= 20, `the grid ran and has both outcomes (${cells} cells, ${gaps} gaps, ${nulls} null)`);
});
