/**
 * #804 F1 — the FAIL-SILENT contract, encoded as a discriminating control
 * rather than asserted in a comment.
 *
 * Fail-silent was a product decision on 2026-08-14: a failure burns that
 * offer, there is no retry. The Value Steward's condition was that the
 * behaviour must be DEMONSTRATED, not stated — "neither behavior will be
 * chosen by editing the comment."
 *
 * ⭐ THE DISCRIMINATION: the wrong implementation is the one the previous
 * comment DESCRIBED — commit the window only after delivery succeeds, so a
 * failed post leaves the window mintable and the next tick retries. These
 * tests must fail against that implementation. `mintOnce` is the real store
 * function against a real temp file, so the ordering under test is the
 * ordering that ships.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { tendingTick } from '../core/tending-tick.mjs';
import { mintOnce } from '../whisper-store.mjs';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tending-')), 's.json');
const T = (h, m = 0) => `2026-08-14T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;

function harness({ file, pool = ['alpha'], postImpl }) {
  const posts = [];
  const errors = [];
  const logs = [];
  return {
    posts,
    errors,
    logs,
    tick: (now, seats = []) => tendingTick({
      now,
      mint: ({ now: n }) => mintOnce({ now: n, file, pool }),
      post: async (body) => {
        posts.push(body);
        if (postImpl) return postImpl(body);
        return undefined;
      },
      reachedSeats: () => seats,
      log: (l) => logs.push(l),
      onError: (e) => errors.push(e),
    }),
  };
}

// ── the happy path, so the failure tests are not vacuous ───────────────────

test('a successful tick mints, posts once, and carries the key in the message', async () => {
  const file = tmp();
  const h = harness({ file });
  const r = await h.tick(T(14, 0));
  assert.equal(r.minted, true);
  assert.equal(r.delivered, true);
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].author, 'board');
  assert.match(h.posts[0].body, /^\[tending 2026-08-14T14:00:00\.000Z\] alpha$/);
});

test('the window is idempotent — later ticks in the same window post nothing', async () => {
  const file = tmp();
  const h = harness({ file });
  await h.tick(T(14, 0));
  for (const m of [1, 17, 59]) await h.tick(T(14, m));
  assert.equal(h.posts.length, 1, 'one offer per window regardless of tick rate');
});

// ── ⭐ F1: THE DISCRIMINATING CONTROL ──────────────────────────────────────

test('⭐ F1 FAIL-SILENT — a delivery failure BURNS the offer and no later tick retries it', async () => {
  // ⇒ THE WRONG IMPLEMENTATION (commit-after-delivery) POSTS AGAIN HERE.
  // That is the whole discrimination: under retry semantics posts.length grows
  // on every subsequent tick; under fail-silent it stays at exactly 1.
  const file = tmp();
  const h = harness({ file, postImpl: () => { throw new Error('board unreachable'); } });

  const first = await h.tick(T(4, 0));
  assert.equal(first.minted, true);
  assert.equal(first.delivered, false);
  assert.equal(first.reason, 'delivery-failed');

  for (const m of [1, 2, 30, 59]) {
    const r = await h.tick(T(4, m));
    assert.equal(r.minted, false, `tick 04:${m} must NOT re-mint a burned window`);
    assert.equal(r.reason, 'nothing-to-mint');
  }
  assert.equal(h.posts.length, 1, 'exactly one delivery ATTEMPT, never a retry');
});

test('⚠️ F1 — the burned offer is NAMED in the error stream, not swallowed', async () => {
  // Fail-silent is only defensible because the loss leaves a trace. A silent
  // burn is the version that was NOT chosen.
  const file = tmp();
  const h = harness({ file, postImpl: () => { throw new Error('board unreachable'); } });
  await h.tick(T(4, 0));
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /BURNED/);
  assert.match(h.errors[0], /no retry/);
  assert.match(h.errors[0], /2026-08-14T04:00:00\.000Z/, 'the lost key is identified');
});

test('F1 — a burned window does not poison the NEXT window', async () => {
  const file = tmp();
  let fail = true;
  const h = harness({ file, postImpl: () => { if (fail) throw new Error('down'); } });
  await h.tick(T(4, 0));
  fail = false;
  const r = await h.tick(T(5, 0));
  assert.equal(r.delivered, true, 'the schedule recovers on the next window');
  assert.equal(h.posts.length, 2);
});

// ── telemetry naming ──────────────────────────────────────────────────────

test('the log names seatNamesWithOpenStreamsAtSend, never "reached"', async () => {
  // ⚠️ `reached` overclaims: an open stream is not an awake seat, and the field
  // reads healthiest during exactly the multi-hour block this feature exists to
  // survive. The name has to carry its own bound.
  const file = tmp();
  const h = harness({ file });
  await h.tick(T(14, 0), ['ada', 'bo']);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /seatNamesWithOpenStreamsAtSend=\[ada,bo\]/);
  assert.equal(/\breached=/.test(h.logs[0]), false, 'the overclaiming name must not appear');
});

test('duplicate stream holders collapse — a seat with two streams is named once', async () => {
  const file = tmp();
  const h = harness({ file });
  await h.tick(T(14, 0), ['ada', 'ada', 'bo']);
  assert.match(h.logs[0], /seatNamesWithOpenStreamsAtSend=\[ada,bo\]/);
});

test('a mint that throws is contained and reported, and does not post', async () => {
  const h = {
    ...harness({ file: tmp() }),
  };
  const errors = [];
  const posts = [];
  const r = await tendingTick({
    now: T(14, 0),
    mint: () => { throw new Error('store corrupt'); },
    post: async (b) => { posts.push(b); },
    onError: (e) => errors.push(e),
  });
  assert.equal(r.minted, false);
  assert.equal(r.reason, 'mint-threw');
  assert.equal(posts.length, 0);
  assert.equal(errors.length, 1);
});
