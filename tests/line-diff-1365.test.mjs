/**
 * #1365 — the conflict view shows a DIFF, not two blobs. A pure line diff
 * (LCS), small enough to read, tested on the shapes a description edit takes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineDiff, renderLineDiff, diffTooLarge, MAX_DIFF_LINES } from '../core/line-diff.mjs';

const ops = (d) => d.map((x) => `${x.op}${x.text}`);

test('#1365 identical ⇒ all equal; empty vs text ⇒ all adds', () => {
  assert.deepEqual(ops(lineDiff('a\nb', 'a\nb')), ['=a', '=b']);
  assert.deepEqual(ops(lineDiff('', 'a\nb')), ['+a', '+b']);
  assert.deepEqual(ops(lineDiff('a\nb', '')), ['-a', '-b']);
});

test('#1365 a changed middle line is one removal and one addition, the rest kept', () => {
  assert.deepEqual(ops(lineDiff('one\ntwo\nthree', 'one\n2\nthree')), ['=one', '-two', '+2', '=three']);
});

test('#1365 an insertion and a deletion at different places both show', () => {
  assert.deepEqual(ops(lineDiff('a\nb\nc\nd', 'a\nc\nd\ne')), ['=a', '-b', '=c', '=d', '+e']);
});

test('#1365 render escapes HTML and marks each line by op', () => {
  const html = renderLineDiff('<b>x</b>', '<i>y</i>');
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'), 'removed line escaped');
  assert.ok(html.includes('&lt;i&gt;y&lt;/i&gt;'), 'added line escaped');
  assert.ok(!html.includes('<b>'), 'no live markup from the texts');
  assert.ok(/class="diff-line del"/.test(html) && /class="diff-line add"/.test(html));
});

test('#1365 a big description stays linear-ish: 2,000 lines diffs in well under a second', () => {
  const a = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
  const b = a.replace('line 1000', 'line one thousand');
  const t = performance.now();
  const d = lineDiff(a, b);
  assert.ok(performance.now() - t < 1000);
  assert.equal(d.filter((x) => x.op !== '=').length, 2);
});

test('#1365 ⛔ THE CAP — past MAX_DIFF_LINES the diff REFUSES before allocating, and the render says so with the doors', () => {
  // The table is (n+1)(m+1)×4 bytes; 10,000 a side is 400 MB on the main thread.
  // A reviewer caught that the timing test above proved only the friendly case.
  const big = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `line ${i}`).join('\n');
  const small = 'one\ntwo';
  assert.equal(diffTooLarge(big, small), true);
  assert.equal(diffTooLarge(small, big), true, 'either side past the cap counts');
  assert.equal(diffTooLarge(small, small), false);
  const before = process.memoryUsage().heapUsed;
  assert.throws(() => lineDiff(big, big), RangeError, 'lineDiff refuses rather than allocating');
  assert.ok(process.memoryUsage().heapUsed - before < 50 * 1024 * 1024, 'and allocated no table on the way out');
  const html = renderLineDiff(big, small);
  assert.match(html, /too-large/);
  assert.match(html, /Use theirs/);
  assert.match(html, /Save mine anyway/);
  assert.ok(!html.includes('line 1500'), 'no lines rendered past the cap');
  // exactly at the cap still works
  const atCap = Array.from({ length: MAX_DIFF_LINES }, (_, i) => `l${i}`).join('\n');
  assert.equal(lineDiff(atCap, atCap).length, MAX_DIFF_LINES);
});
