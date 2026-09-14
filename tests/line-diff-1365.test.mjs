/**
 * #1365 — the conflict view shows a DIFF, not two blobs. A pure line diff
 * (LCS), small enough to read, tested on the shapes a description edit takes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineDiff, renderLineDiff } from '../core/line-diff.mjs';

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
