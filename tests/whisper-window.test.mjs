/**
 * #802 — the board owns the hourly tending, so it survives any one seat.
 *
 * Delivery already exists (broadcastFanout → channelScheduler). What did not
 * exist is SETTLEMENT: the prompt reaches three seats, each seat's judgement
 * agrees, and agreement is exactly why they collide. So the whisper is claimed
 * against BOARD state, once per window, and a prompt minted for a window that
 * has since passed cannot be redeemed at all.
 *
 * Every function here is pure and takes `now` — this module never reads the
 * wall clock, for the same reason work-auction.mjs does not: the failure being
 * guarded is a seat resuming ten hours late, and a module that reads its own
 * clock cannot be tested against that.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOUR_MS,
  windowAt,
  mintPrompt,
  claimWhisper,
  EMPTY_STATE,
} from '../core/whisper-window.mjs';

const W = (h, m = 0) => `2026-08-13T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;

// ── window arithmetic ──────────────────────────────────────────────────────

test('windowAt floors to the period boundary, and is stable across the window', () => {
  assert.equal(windowAt(W(14, 0), HOUR_MS), W(14));
  assert.equal(windowAt(W(14, 1), HOUR_MS), W(14));
  assert.equal(windowAt(W(14, 59), HOUR_MS), W(14));
  // ⚠️ the discriminating case: one millisecond later is a DIFFERENT window.
  assert.equal(windowAt('2026-08-13T14:59:59.999Z', HOUR_MS), W(14));
  assert.equal(windowAt(W(15, 0), HOUR_MS), W(15));
});

test('windowAt refuses a non-canonical instant rather than silently comparing', () => {
  // The whole module compares window ids as strings. A value that parses but
  // does not round-trip would compare lexicographically and be WRONG
  // chronologically — the defect found on #797 by review.
  assert.throws(() => windowAt('2026-08-13T14:00:00Z', HOUR_MS), /canonical/);
  assert.throws(() => windowAt(1755093600000, HOUR_MS), /canonical/);
  assert.throws(() => windowAt(undefined, HOUR_MS), /required/);
});

// ── the pool: editable without a deploy, selected without an rng ────────────

test('mintPrompt stamps the window it was minted FOR, not the time it was sent', () => {
  const pool = ['alpha', 'beta'];
  const p = mintPrompt({ pool, now: W(14, 37) });
  assert.equal(p.window, W(14));
  assert.equal(p.mintedAt, W(14, 37));
});

test('mintPrompt walks the pool as a playlist keyed on the window, so every seat computes the same prompt', () => {
  const pool = ['alpha', 'beta', 'gamma'];
  const at = (h) => mintPrompt({ pool, now: W(h) }).body;
  // Two seats minting independently in the same window must agree — no rng.
  assert.equal(mintPrompt({ pool, now: W(14, 2) }).body, mintPrompt({ pool, now: W(14, 51) }).body);
  // ...and consecutive windows advance, so the pool is a playlist not a constant.
  const seq = [at(12), at(13), at(14), at(15)];
  assert.equal(new Set(seq.slice(0, 3)).size, 3, 'three consecutive windows give three distinct prompts');
  assert.equal(seq[3], seq[0], 'and it wraps');
});

test('an empty pool mints nothing rather than an empty whisper', () => {
  assert.equal(mintPrompt({ pool: [], now: W(14) }), null);
});

// ── settlement: at most one whisper per window ─────────────────────────────

test('the first seat to claim a window gets it', () => {
  const p = mintPrompt({ pool: ['alpha'], now: W(14, 5) });
  const r = claimWhisper({ state: EMPTY_STATE, prompt: p, seat: 'ada', now: W(14, 5) });
  assert.equal(r.granted, true);
  assert.equal(r.reason, 'granted');
  assert.equal(r.state.lastWhisperWindow, W(14));
  assert.equal(r.state.lastWhisperBy, 'ada');
});

test('⭐ three seats acting in the SAME INSTANT produce exactly one whisper', () => {
  // The card's central defect: each seat's read of "is it quiet" AGREES, so
  // independent judgement guarantees the collision rather than avoiding it.
  const p = mintPrompt({ pool: ['alpha'], now: W(14, 0) });
  let state = EMPTY_STATE;
  const granted = [];
  for (const seat of ['ada', 'bo', 'cy']) {
    const r = claimWhisper({ state, prompt: p, seat, now: W(14, 0) });
    if (r.granted) granted.push(seat);
    state = r.state; // serialized by the store's write boundary, as with work objects
  }
  assert.deepEqual(granted, ['ada']);
  assert.equal(state.lastWhisperBy, 'ada');
});

test('a losing seat is told WHY, and the reason is distinct from expiry', () => {
  const p = mintPrompt({ pool: ['alpha'], now: W(14, 0) });
  const first = claimWhisper({ state: EMPTY_STATE, prompt: p, seat: 'ada', now: W(14, 0) });
  const second = claimWhisper({ state: first.state, prompt: p, seat: 'bo', now: W(14, 10) });
  assert.equal(second.granted, false);
  assert.equal(second.reason, 'already-whispered-this-window');
  assert.equal(second.state, first.state, 'a refused claim does not touch state');
});

test('the NEXT window is a fresh grant — settlement bounds the window, it does not stop the practice', () => {
  const p14 = mintPrompt({ pool: ['alpha'], now: W(14) });
  const s = claimWhisper({ state: EMPTY_STATE, prompt: p14, seat: 'ada', now: W(14) }).state;
  const p15 = mintPrompt({ pool: ['alpha'], now: W(15) });
  const r = claimWhisper({ state: s, prompt: p15, seat: 'bo', now: W(15, 3) });
  assert.equal(r.granted, true);
  assert.equal(r.state.lastWhisperBy, 'bo');
});

// ── POSITIVE CONTROL: the ten-hour resume ──────────────────────────────────

test('⚠️ POSITIVE CONTROL — a prompt redeemed after its window has passed is REFUSED, even though nobody whispered in it', () => {
  // This is the case I nearly shipped by hand on 2026-08-13: blocked 10h38m,
  // then a queued prompt bearing a stale clock, nearly producing a whisper that
  // said "Thursday 9:25am" at 8pm.
  //
  // ⭐ THE FIXTURE DISCRIMINATES, and that is the point of choosing THIS state:
  // nobody whispered in window 09:00. An implementation keyed ONLY on
  // `lastWhisperWindow !== prompt.window` — the obvious one — GRANTS here.
  // Only an implementation that also checks the prompt against the CURRENT
  // window refuses. The two candidate answers differ on this input.
  const p = mintPrompt({ pool: ['alpha'], now: W(9, 25) });
  const state = EMPTY_STATE; // ← no whisper ever happened in window 09:00
  const r = claimWhisper({ state, prompt: p, seat: 'ada', now: '2026-08-13T20:03:00.000Z' });
  assert.equal(r.granted, false);
  assert.equal(r.reason, 'expired-window');
  assert.equal(r.state, state);
});

test('the expiry is the WINDOW, not a duration — one second past the boundary is already expired', () => {
  const p = mintPrompt({ pool: ['alpha'], now: W(14, 59) });
  const r = claimWhisper({ state: EMPTY_STATE, prompt: p, seat: 'ada', now: W(15, 0) });
  assert.equal(r.granted, false);
  assert.equal(r.reason, 'expired-window');
});

test('a prompt from the FUTURE is refused too — a skewed seat cannot burn a window early', () => {
  const p = mintPrompt({ pool: ['alpha'], now: W(15) });
  const r = claimWhisper({ state: EMPTY_STATE, prompt: p, seat: 'ada', now: W(14, 30) });
  assert.equal(r.granted, false);
  assert.equal(r.reason, 'expired-window');
});

test('claimWhisper requires canonical instants on BOTH the prompt and now', () => {
  const p = mintPrompt({ pool: ['alpha'], now: W(14) });
  assert.throws(() => claimWhisper({ state: EMPTY_STATE, prompt: p, seat: 'ada', now: '2026-08-13T14:00:00Z' }), /canonical/);
  assert.throws(
    () => claimWhisper({ state: EMPTY_STATE, prompt: { ...p, window: 'nonsense' }, seat: 'ada', now: W(14) }),
    /canonical/,
  );
});

// ── what this does NOT do ──────────────────────────────────────────────────

test('settlement is silent about whether the room was actually quiet — that judgement stays with the seat', () => {
  // ⚠️ Deliberate scope limit, stated as a test so it cannot be quietly widened:
  // the board decides WHETHER A WHISPER MAY HAPPEN THIS WINDOW. It does not
  // decide whether one SHOULD. Reading the room and composing the words is the
  // tending, and it stays with whoever holds the grant.
  const p = mintPrompt({ pool: ['alpha'], now: W(14) });
  const r = claimWhisper({ state: EMPTY_STATE, prompt: p, seat: 'ada', now: W(14) });
  assert.equal(r.granted, true);
  assert.equal('quiet' in r, false);
  assert.equal('shouldWhisper' in r, false);
});
