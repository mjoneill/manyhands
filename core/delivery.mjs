/**
 * #1346 — the one place the delivery record's TIME RULE lives, shared by the
 * runner (which sweeps) and the MCP status page (which counts), so the two
 * cannot disagree about what "stuck" means.
 *
 * A delivery at `runner-claimed` or `turn-started` is somebody's turn in
 * progress — until it is older than the stale window, after which the runner
 * that held it is presumed dead (SIGKILL, host reboot: the crash leaves the
 * record not open, not terminal, not claimable, and no producer can move it).
 * The window defaults to the wake lock's own (10 min); SCRUM_DELIVERY_STALE_MS
 * overrides it, mainly so a test need not wait ten minutes.
 */
export const DELIVERY_STALE_MS_DEFAULT = 10 * 60_000;
export function deliveryStaleMs(env = process.env) {
  const n = Number(env.SCRUM_DELIVERY_STALE_MS);
  return Number.isFinite(n) && n > 0 ? n : DELIVERY_STALE_MS_DEFAULT;
}
const IN_TURN = new Set(['runner-claimed', 'turn-started']);
const OPEN = new Set(['offered', 'queued', 'failed']);   // failed = tries left, as far as this counter knows; the server's open=1 applies the attempt cap
const latestAt = (d) => Date.parse(d?.events?.at(-1)?.at ?? d?.offeredAt ?? 0) || 0;

/** True when the record is in a turn that has outlived the window. */
export function isStaleDelivery(d, { now = Date.now(), staleMs = DELIVERY_STALE_MS_DEFAULT } = {}) {
  return IN_TURN.has(d?.state) && now - latestAt(d) > staleMs;
}

/** {open, inTurn, stuck} over a seat's wire records — what /channel/status shows. */
export function classifyDeliveries(list, opts = {}) {
  const out = { open: 0, inTurn: 0, stuck: 0 };
  for (const d of Array.isArray(list) ? list : []) {
    if (OPEN.has(d?.state)) out.open++;
    else if (IN_TURN.has(d?.state)) { if (isStaleDelivery(d, opts)) out.stuck++; else out.inTurn++; }
  }
  return out;
}
