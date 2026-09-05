/**
 * #1189 — the LIVE seam: what the firing path actually mints.
 *
 * The defect this card exists for is not "wrong words". It is that the graph
 * described one system while another one ran: 393 firings, 1 TendingMint. So
 * these tests are about PROVENANCE ON THE MINT — a whisper that cannot say
 * which graph version it came from is indistinguishable from the hardcoded
 * array we are replacing, no matter how correct the text is.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { mintOnce } from '../whisper-store.mjs';

const NOW = '2026-09-05T04:00:00.000Z';

function tmpState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tending-live-'));
  return path.join(dir, 'whisper-state.json');
}

const GRAPH_POOL = [
  { slug: 'alpha', body: 'A body', versionId: 'https://scrumboard.local/tending/prompt/alpha/v1', version: 1 },
  { slug: 'bravo', body: 'B body', versionId: 'https://scrumboard.local/tending/prompt/bravo/v2', version: 2 },
];

test('a minted prompt carries the graph version it came from', () => {
  // DEFECT: minting a bare string. The room gets the right words and the
  // board cannot say which entity produced them — which is the 393-vs-1 gap
  // reproduced exactly, with better text.
  const p = mintOnce({ now: NOW, file: tmpState(), pool: GRAPH_POOL });
  assert.ok(p, 'nothing minted');
  assert.ok(p.versionId, 'minted prompt has no version provenance');
  assert.ok(p.slug, 'minted prompt has no slug');
  assert.ok(GRAPH_POOL.some((e) => e.body === p.body && e.versionId === p.versionId),
    'body and versionId came from different entries');
});

test('a plain string pool still works — the legacy shape is not broken', () => {
  const p = mintOnce({ now: NOW, file: tmpState(), pool: ['only one'] });
  assert.equal(p.body, 'only one');
  assert.equal(p.versionId, null);
});

test('shuffle OFF is the existing deterministic rotation, unchanged by this card', () => {
  // Two different windows, same pool, must be reproducible per-window.
  const a = mintOnce({ now: NOW, file: tmpState(), pool: GRAPH_POOL });
  const b = mintOnce({ now: NOW, file: tmpState(), pool: GRAPH_POOL });
  assert.equal(a.body, b.body, 'rotation is not deterministic for a window');
});

test('shuffle ON uses the injected rand and can reach every entry', () => {
  // DEFECT: a "shuffle" that always returns index 0 passes every other test.
  const first = mintOnce({ now: NOW, file: tmpState(), pool: GRAPH_POOL, shuffle: true, rand: () => 0 });
  const last = mintOnce({ now: NOW, file: tmpState(), pool: GRAPH_POOL, shuffle: true, rand: () => 0.99 });
  assert.equal(first.slug, 'alpha');
  assert.equal(last.slug, 'bravo');
});

test('an empty pool mints NOTHING and does not fall back to built-in words', () => {
  // DEFECT: inheriting readPool()'s #809 fallback. the operator disabling every
  // whisper must produce silence, not the three defaults he thought he removed.
  assert.equal(mintOnce({ now: NOW, file: tmpState(), pool: [] }), null);
});

test('once per window still holds with a graph pool', () => {
  const file = tmpState();
  assert.ok(mintOnce({ now: NOW, file, pool: GRAPH_POOL }));
  assert.equal(mintOnce({ now: NOW, file, pool: GRAPH_POOL }), null, 'minted twice in one window');
});

// ── the mint RECORD — #1189's 393-vs-1 fix ─────────────────────────────────

import { tendingTick } from '../core/tending-tick.mjs';

function tickHarness({ file, pool, postImpl }) {
  const minted = [];
  const errors = [];
  return {
    minted,
    errors,
    run: (now, seats = []) => tendingTick({
      now,
      mint: ({ now: n }) => mintOnce({ now: n, file, pool }),
      post: async (b) => { if (postImpl) return postImpl(b); return undefined; },
      reachedSeats: () => seats,
      onError: (e) => errors.push(e),
      onMinted: (prompt, reached) => minted.push({ prompt, reached }),
    }),
  };
}

test('a DELIVERED firing records a mint carrying its graph version', async () => {
  const h = tickHarness({ file: tmpState(), pool: GRAPH_POOL });
  await h.run(NOW, ['bee', 'cyd']);
  assert.equal(h.minted.length, 1, 'the firing left no graph record — this is the 393-vs-1 gap');
  assert.ok(h.minted[0].prompt.versionId, 'the mint cannot say which entity produced the words');
  assert.deepEqual(h.minted[0].reached, ['bee', 'cyd']);
});

test('a FAILED delivery records NO mint — the graph must not claim the room was tended', async () => {
  // DEFECT: recording at mint time rather than after delivery. The board would
  // then answer "the room was tended at 04:00" for a whisper nobody received,
  // which is worse than the missing record it replaces.
  const h = tickHarness({
    file: tmpState(), pool: GRAPH_POOL,
    postImpl: async () => { throw new Error('delivery down'); },
  });
  await h.run(NOW);
  assert.equal(h.minted.length, 0, 'an undelivered whisper was recorded as a firing');
});

test('a throwing recorder never breaks the whisper', async () => {
  // The room getting the whisper is the deliverable; bookkeeping is not.
  const h = tickHarness({ file: tmpState(), pool: GRAPH_POOL });
  const res = await tendingTick({
    now: NOW,
    mint: ({ now: n }) => mintOnce({ now: n, file: tmpState(), pool: GRAPH_POOL }),
    post: async () => undefined,
    reachedSeats: () => [],
    onError: (e) => h.errors.push(e),
    onMinted: () => { throw new Error('recorder exploded'); },
  });
  assert.equal(res.delivered, true, 'a bookkeeping failure suppressed the whisper');
  assert.ok(h.errors.some((e) => /mint recording threw/.test(e)), 'the failure was swallowed silently');
});
