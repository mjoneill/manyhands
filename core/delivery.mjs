/**
 * #1346 — the one place the delivery record's TIME RULE lives, shared by the
 * runner (which sweeps) and the MCP status page (which counts), so the two
 * cannot disagree about what "stuck" means.
 *
 * A delivery at `claimed` (née `runner-claimed`, #1373) or `turn-started` is somebody's turn in
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
const IN_TURN = new Set(['claimed', 'runner-claimed', 'turn-started']);   // #1373 — the old spelling reads as the new
const OPEN = new Set(['offered', 'queued']);
/**
 * The retry budget: a failed delivery is open while it has tries left, capped
 * at this many claims. One constant, imported by the server's `open=1` and
 * used by the counter below, so the status page and the drain query cannot
 * disagree by one on a delivery's third failure.
 */
export const DELIVERY_MAX_ATTEMPTS = 3;
const claims = (d) => (Array.isArray(d?.events) ? d.events : []).filter((e) => e?.state === 'claimed' || e?.state === 'runner-claimed').length;
/** The drain rule on a WIRE record: never claimed, or failed with tries left. */
export function isOpenDelivery(d) {
  if (OPEN.has(d?.state)) return true;
  return d?.state === 'failed' && claims(d) < DELIVERY_MAX_ATTEMPTS;
}
const latestAt = (d) => Date.parse(d?.events?.at(-1)?.at ?? d?.offeredAt ?? 0) || 0;

/** True when the record is in a turn that has outlived the window. */
export function isStaleDelivery(d, { now = Date.now(), staleMs = DELIVERY_STALE_MS_DEFAULT } = {}) {
  return IN_TURN.has(d?.state) && now - latestAt(d) > staleMs;
}

/** {open, inTurn, stuck} over a seat's wire records — what /channel/status shows. */
export function classifyDeliveries(list, opts = {}) {
  const out = { open: 0, inTurn: 0, stuck: 0 };
  for (const d of Array.isArray(list) ? list : []) {
    if (isOpenDelivery(d)) out.open++;
    else if (IN_TURN.has(d?.state)) { if (isStaleDelivery(d, opts)) out.stuck++; else out.inTurn++; }
  }
  return out;
}

/**
 * A BOUNDED read with a remembered answer, for /channel/status. The status
 * page is read by the deploy's seat check in the seconds after a restart —
 * exactly when the board's REST is blocked on its graph sync (5.8 s measured
 * on the first call after the slice-4 deploy, 6 ms on the next). An instrument
 * that waits on that is unmeasured at the one moment it is read. So: race the
 * read against `timeoutMs`; on a miss answer with the last good reading and
 * SAY it is stale (when, and why). No reading yet ⇒ an error field, never an
 * empty map pretending to be zero.
 */
export function boundedResidentReader({ timeoutMs = 1500, now = Date.now } = {}) {
  let last = null;   // { residents, at }
  return async function read(fn) {
    let timer;
    const bound = new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), timeoutMs); });
    try {
      const r = await Promise.race([fn().then((residents) => ({ residents })).catch((e) => ({ error: e?.message ?? String(e) })), bound]);
      if (r.residents) { last = { residents: r.residents, at: new Date(now()).toISOString() }; return { residents: r.residents, read: { at: last.at, fresh: true } }; }
      const reason = r.timeout ? `timeout after ${timeoutMs}ms` : r.error;
      if (last) return { residents: last.residents, read: { at: last.at, fresh: false, reason } };
      return { residents: { error: `resident inboxes unreadable: ${reason}` }, read: { at: null, fresh: false, reason } };
    } finally { clearTimeout(timer); }
  };
}
