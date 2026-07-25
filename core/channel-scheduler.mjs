/**
 * core/channel-scheduler.mjs — config-driven channel delivery scheduler
 * (#263/#265/#266). One scheduler, two modes, chosen live from a getConfig()
 * getter re-read on every dispatch — so flipping the mode or the timings in the
 * settings page applies with NO restart.
 *
 *   - soft (#265): one random seat gets the message immediately, the
 *     rest each wait a random [minMs, maxMs]. Fast, rarely collides, never reorders.
 *   - hard (#266): strict one-at-a-time — a random turn order, serial slots
 *     `timeoutMs` apart. Never overlaps; the (n-1)*timeout tail is the cost.
 *   - off: immediate for everyone (test-harness default).
 *
 * Both modes are just "assign a per-seat delay, then schedule with the per-seat
 * order-clamp." Delay assignment is pure (softDelays / hardDelays); now/schedule/
 * rng are injectable so the logic is testable against a fake clock.
 */

/** Soft: one random index → 0 (immediate); the rest → random in [minMs, maxMs]. */
export function softDelays(n, minMs, maxMs, rng) {
  const immediateIdx = Math.floor(rng() * n); // fresh uniform draw every dispatch
  const span = Math.max(0, maxMs - minMs);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = i === immediateIdx ? 0 : minMs + Math.round(rng() * span);
  }
  return out;
}

/** Hard: a random permutation; the seat in slot p gets delay p*timeoutMs. */
export function hardDelays(n, timeoutMs, rng) {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
  }
  const out = new Array(n);
  for (let p = 0; p < n; p++) out[order[p]] = p * timeoutMs;
  return out;
}

/**
 * @param {{
 *   getConfig: () => ({mode:'soft'|'hard'|'off', soft?:{minMs:number,maxMs:number}, hard?:{timeoutMs:number}}),
 *   rng?: () => number, now?: () => number,
 *   schedule?: (fn: () => void, ms: number) => unknown,
 *   deliver: (sessionId: string, message: any) => void,
 * }} opts
 */
export function createChannelScheduler({
  getConfig,
  rng = Math.random,
  now = Date.now,
  schedule = (fn, ms) => setTimeout(fn, ms),
  deliver,
} = {}) {
  // sessionId -> earliest time its NEXT message may be delivered (order-clamp).
  const nextAvailable = new Map();
  // #303-7 — count of deliveries scheduled-but-not-yet-fired (the staggered tail
  // "in flight"), so a UI can show "N deliveries pending" instead of the room
  // looking silently stalled. Immediate ('off'/first slot) deliveries never
  // increment it — they're already delivered.
  let inFlight = 0;

  function dispatch(sessionIds, message) {
    const n = sessionIds.length;
    if (n === 0) return;

    const cfg = getConfig() || { mode: 'off' };
    if (cfg.mode === 'off') {
      for (const sid of sessionIds) deliver(sid, message); // immediate, in order
      return;
    }

    const delays = cfg.mode === 'hard'
      ? hardDelays(n, cfg.hard.timeoutMs, rng)
      : softDelays(n, cfg.soft.minMs, cfg.soft.maxMs, rng);

    const t = now();
    sessionIds.forEach((sid, i) => {
      const target = Math.max(t + delays[i], nextAvailable.get(sid) ?? 0);
      nextAvailable.set(sid, target + 1);
      const wait = target - t;
      if (wait <= 0) {
        deliver(sid, message); // due now — no in-flight accounting needed
        return;
      }
      inFlight++;
      schedule(() => { inFlight = Math.max(0, inFlight - 1); deliver(sid, message); }, wait);
    });
  }

  /** #303-7 — how many staggered deliveries are still waiting to fire. */
  function pending() { return inFlight; }

  return { dispatch, pending };
}
