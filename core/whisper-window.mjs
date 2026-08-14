/**
 * core/whisper-window.mjs — #802, the settlement half of board-owned tending.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * The room's hourly tending lived inside one seat's `/loop`. On 2026-08-13 both
 * Claude seats were blocked 10h40m and the room went untended; the seat on a
 * different runtime never stopped. Moving the SCHEDULE to the board fixes that.
 *
 * ⚠️ But fan-out creates a defect that the single-seat rail did not have:
 * three seats receive "if it's quiet, whisper" at the same instant, and each
 * seat's independent judgement AGREES. Agreement is precisely why they collide —
 * this is #798 (a card minted twice, 48s apart) except scheduled and guaranteed.
 *
 *   ⛔ DO NOT   key the whisper on each seat's own read of "is it quiet"
 *   ✅ KEY ON   board state — "has anyone whispered in THIS window" is a fact
 *
 * ── WHAT THE BOARD DECIDES, AND WHAT IT DOES NOT ───────────────────────────
 * The board decides whether a whisper MAY happen this window. It does not
 * decide whether one SHOULD. Reading the room, judging the quiet and choosing
 * the words is the tending, and it stays with whoever holds the grant — that
 * distinction is the whole reason the delivery was moved to the board at all.
 * There is a test asserting this module exposes no `quiet` / `shouldWhisper`.
 *
 * ── FAILURE CLASS ──────────────────────────────────────────────────────────
 * MITIGATES: runtime-scoped unavailability. Two seats on the same runtime fail
 *   together; a third on another runtime keeps the rhythm.
 * DOES NOT MITIGATE: a gateway, board, network or upstream failure takes every
 *   seat together, and the schedule now lives in the thing that failed.
 *   (Value Steward review — carried in so the build cannot quietly drop it.)
 *
 * ── NO WALL CLOCK ──────────────────────────────────────────────────────────
 * Every function takes `now`. The failure being guarded IS a seat resuming ten
 * hours late holding a stale clock, and a module that reads its own clock
 * cannot be tested against that. Same discipline as work-auction.mjs.
 */

export const HOUR_MS = 3600000;

export const EMPTY_STATE = Object.freeze({
  lastWhisperWindow: null,
  lastWhisperBy: null,
  lastWhisperAt: null,
});

/**
 * Window ids are compared as STRINGS throughout this module, so an instant that
 * parses but does not round-trip would compare lexicographically and be wrong
 * chronologically — `'…00.100Z' < '…00Z'` is true as text and false in time.
 * Caught on #797's first validator by review, which accepted any
 * syntactically-valid ISO-8601. Canonical round-trip is the only check that
 * makes string comparison a legitimate substitute for time comparison.
 */
function assertCanonical(iso, what) {
  if (!iso) throw new Error(`${what} is required — this module never reads the wall clock`);
  let ok = false;
  try {
    ok = typeof iso === 'string' && new Date(iso).toISOString() === iso;
  } catch { ok = false; }
  if (!ok) throw new Error(`${what} must be a canonical UTC instant (e.g. 2026-08-13T14:00:00.000Z), got ${JSON.stringify(iso)}`);
}

/** The period-aligned window containing `iso`, as a canonical instant. */
export function windowAt(iso, periodMs = HOUR_MS) {
  assertCanonical(iso, 'windowAt: instant');
  const ms = Date.parse(iso);
  return new Date(Math.floor(ms / periodMs) * periodMs).toISOString();
}

/**
 * Mint the prompt for the window containing `now`.
 *
 * ⭐ Pool selection is keyed on the WINDOW INDEX, not on an rng. Two seats
 * minting independently in the same window must compute the same prompt, and a
 * random draw would make the pool a source of divergence rather than content.
 * It is a playlist, and the pool is board data — any seat may add, remove,
 * reword or reorder it without a deploy.
 *
 * Returns null on an empty pool: nothing to say is not the same as an empty
 * whisper, and a blank message reaching three seats is worse than silence.
 */
export function mintPrompt({ pool, now, periodMs = HOUR_MS }) {
  const window = windowAt(now, periodMs);
  const items = Array.isArray(pool) ? pool.filter((p) => typeof p === 'string' && p.trim()) : [];
  if (items.length === 0) return null;
  const idx = Math.floor(Date.parse(window) / periodMs) % items.length;
  return { window, body: items[idx], mintedAt: now };
}

/**
 * Claim the right to whisper for `prompt.window`. Pure: returns the next state
 * rather than mutating, so the caller's write boundary decides serialization —
 * the same shape as work-tools.mjs, where load→append is a critical section.
 *
 * Three outcomes, and the two refusals are DISTINCT reasons on purpose:
 *
 *   granted                        — this seat holds the window
 *   already-whispered-this-window  — someone else got there first
 *   expired-window                 — the prompt is not for the current window
 *
 * ⚠️ THE SECOND REFUSAL IS THE POSITIVE CONTROL, and it is the one an obvious
 * implementation misses. Keying only on `lastWhisperWindow !== prompt.window`
 * looks complete and passes every same-window test — but a prompt minted at
 * 09:25 and redeemed at 20:03, in a window where nobody whispered, satisfies it
 * and GRANTS. That is the 10h38m resume I nearly shipped by hand: a queued
 * prompt carrying a clock stale by exactly the block duration. So the prompt is
 * checked against the window containing `now`, in BOTH directions — a skewed
 * seat must not be able to burn a future window early either.
 */
export function claimWhisper({ state = EMPTY_STATE, prompt, seat, now, periodMs = HOUR_MS }) {
  assertCanonical(now, 'claimWhisper: now');
  if (!prompt) throw new Error('claimWhisper: prompt is required');
  assertCanonical(prompt.window, 'claimWhisper: prompt.window');
  if (!seat) throw new Error('claimWhisper: seat is required');

  const current = windowAt(now, periodMs);
  if (prompt.window !== current) {
    return { granted: false, reason: 'expired-window', state, window: prompt.window, currentWindow: current };
  }
  if (state.lastWhisperWindow === current) {
    return { granted: false, reason: 'already-whispered-this-window', state, window: current, heldBy: state.lastWhisperBy };
  }
  return {
    granted: true,
    reason: 'granted',
    window: current,
    state: Object.freeze({ lastWhisperWindow: current, lastWhisperBy: seat, lastWhisperAt: now }),
  };
}
