/**
 * #794 — UNIT tests for the comment-metadata helper.
 *
 * ⚠️ WHY THIS FILE EXISTS SEPARATELY FROM card-comment-metadata.test.mjs.
 * That file asserts on the HTTP/MCP response. It passed 7/7 against an
 * implementation whose source comment claimed a fixed-size buffer and whose
 * code accumulated the entire population and sorted it. The response was
 * correct, so no wire-level test could have failed.
 *
 * ⭐⭐ THE GENERAL FORM: a claim about INTERNAL behaviour is not testable from
 * a surface that only shows OUTPUT. The two tests below are the ones that can
 * disagree with the source comment — everything else in #794 cannot.
 *
 * ⇒ Defect found in independent read-only review, 2026-08-12.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  commentMetadata,
  COMMENT_RECENT_CAP,
  COMMENT_PREVIEW_CHARS,
} from '../core/card-comments.mjs';

const comment = (n, attachedTo, body) => ({
  id: `conv-${n}`,
  body,
  author: n % 2 ? 'ann' : 'ben',
  attachedTo,
  createdAt: new Date(Date.UTC(2026, 7, 12, 0, n)).toISOString(),
});

// ── ⭐⭐ THE BOUND THE WIRE TESTS CANNOT SEE ─────────────────────────────────

test('#794 ⭐⭐ INTERNAL BOUND — the population is never accumulated or sorted', () => {
  // The discriminator, stated as the two operations an accumulate-then-trim
  // implementation cannot avoid:
  //   ACCUMULATE  it must push every match onto an array   ⇒ 200 pushes
  //   SORT        it must order the whole array afterwards ⇒ sort over 200
  // A true fixed-size buffer does neither. Instrumenting the prototypes is the
  // only way to observe this from outside the function, and it is restored in
  // a finally so no later test inherits a patched Array.
  const N = 200;
  const convs = Array.from({ length: N }, (_, i) => comment(i + 1, 'c1', `comment ${i + 1}`));

  const realSort = Array.prototype.sort;
  const realPush = Array.prototype.push;
  const sortedLengths = [];
  let pushes = 0;

  Array.prototype.sort = function patchedSort(...a) {
    realPush.call(sortedLengths, this.length);
    return realSort.apply(this, a);
  };
  Array.prototype.push = function patchedPush(...a) {
    pushes += a.length;
    return realPush.apply(this, a);
  };

  let got;
  try {
    got = commentMetadata(convs, 'c1');
  } finally {
    Array.prototype.sort = realSort;
    Array.prototype.push = realPush;
  }

  assert.equal(got.total, N, 'the count is still exact — bounding retention must not bound counting');
  assert.equal(got.recent.length, COMMENT_RECENT_CAP);

  assert.ok(
    pushes <= COMMENT_RECENT_CAP,
    `the helper pushed ${pushes} times over ${N} comments — it is accumulating the population `
    + 'before trimming, which is what the source comment claims it does not do',
  );
  const overCap = sortedLengths.filter((len) => len > COMMENT_RECENT_CAP);
  assert.deepEqual(
    overCap, [],
    `sort() was called on arrays of length ${overCap.join(', ')} — a fixed-size buffer is maintained `
    + 'by insertion and never sorts the population',
  );
});

test('#794 the newest CAP survive, newest-first, regardless of arrival order', () => {
  // Correctness of the insertion, since there is no longer a sort to fall back
  // on. Shuffled deterministically — the newest three are 98, 99, 100.
  const ordered = Array.from({ length: 100 }, (_, i) => comment(i + 1, 'c1', `body ${i + 1}`));
  const shuffled = [...ordered.slice(50), ...ordered.slice(0, 50).reverse()];

  const got = commentMetadata(shuffled, 'c1');
  assert.equal(got.total, 100);
  assert.deepEqual(
    got.recent.map((s) => s.id),
    ['conv-100', 'conv-99', 'conv-98'],
    'insertion order must not affect which comments are retained or how they are ordered',
  );
});

test('#794 the helper reads its input ONCE, so a generator works without materialising it', () => {
  // The source claims this; a claim in a comment is worth what a test says it
  // is worth. A second pass over a spent generator would yield nothing and the
  // count would come back wrong.
  function* stream() {
    for (let i = 1; i <= 50; i += 1) yield comment(i, 'c1', `body ${i}`);
  }
  const got = commentMetadata(stream(), 'c1');
  assert.equal(got.total, 50);
  assert.equal(got.recent[0].id, 'conv-50');
});

// ── ⭐ THE SCOPE MISS: "first line", not "first 140 characters" ──────────────

test('#794 ⭐ preview stops at the FIRST LINE — a multi-line comment is not flattened', () => {
  // #794 asks for "author, date, first line". 6b32d96 sliced 140 code units
  // regardless of newlines, so a structured comment came back as a run-on that
  // read as one sentence and misrepresented its shape.
  const body = 'The headline finding.\nSupporting detail nobody asked for.\nAnd more.';
  const got = commentMetadata([comment(1, 'c1', body)], 'c1');
  assert.equal(
    got.recent[0].preview, 'The headline finding.',
    'the preview must end at the first newline — otherwise a three-line comment reads as one line',
  );
});

test('#794 ⭐⭐ the preview is the BEGINNING of the line — length alone does not pin content', () => {
  // ⚠️ Review mutation F, 2026-08-12: a preview returning the LAST 140 chars
  // passed every test #794 had. My first-line test did not close it either —
  // its first line is 21 chars, and slice(-140) on a short string is the
  // IDENTITY. A content assertion only discriminates ABOVE the cap.
  const line = `HEAD${'-'.repeat(300)}TAIL`;
  const got = commentMetadata([comment(1, 'c1', line)], 'c1');
  assert.ok(
    got.recent[0].preview.startsWith('HEAD'),
    `preview began "${got.recent[0].preview.slice(0, 12)}…" — a correctly-SIZED preview taken from the `
    + 'wrong end of the body is still the wrong text, and length assertions cannot see it',
  );
});

test('#794 a long FIRST line is still truncated — the two bounds compose', () => {
  // First-line extraction must not become an escape hatch from the length cap:
  // a single 40KB line has no newline to stop at.
  const got = commentMetadata([comment(1, 'c1', 'x'.repeat(40_000))], 'c1');
  assert.ok(
    got.recent[0].preview.length <= COMMENT_PREVIEW_CHARS,
    `preview carried ${got.recent[0].preview.length} chars — taking the first LINE does not bound `
    + 'anything when the body has no newline in it',
  );
});

test('#794 a CRLF body does not smuggle a trailing carriage return into the preview', () => {
  // Review finding, 2026-08-12. indexOf('\n') stops after the '\r', so the preview
  // would carry an invisible trailing character — equality assertions on it
  // fail for a reason nobody can see by reading the output.
  const got = commentMetadata([comment(1, 'c1', 'windows line\r\nsecond line')], 'c1');
  assert.equal(got.recent[0].preview, 'windows line');
});

test('#794 a missing or empty body does not throw and yields an empty preview', () => {
  const got = commentMetadata(
    [{ id: 'a', author: 'ann', attachedTo: 'c1', createdAt: '2026-08-12T00:00:00.000Z' }],
    'c1',
  );
  assert.equal(got.recent[0].preview, '');
});
