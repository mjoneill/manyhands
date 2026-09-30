/**
 * core/ring-shadow.mjs — #1513 SHADOW records. LOG ONLY: pure functions that turn
 * facts the server already holds into one record to print. Nothing here decides,
 * gates or schedules anything, and nothing consults what it returns.
 *
 * residentSlotShadow: a resident's slot against the receipt trail its runner
 * writes (offered → claimed → turn-started → published/declined/failed). The
 * ring's direct segment (core/token-ring-direct.mjs) ignores that trail and runs
 * the slot to its deadline whatever `turn-started` says; this is how often that
 * costs a live turn, and how long the turns actually run.
 */

const ms = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };
const TERMINAL_EVENTS = new Set(['published', 'declined', 'failed']);
const first = (xs) => xs.length ? xs.reduce((a, b) => (ms(a) <= ms(b) ? a : b)) : null;
const last = (xs) => xs.length ? xs.reduce((a, b) => (ms(a) >= ms(b) ? a : b)) : null;
const diff = (a, b) => (a && b ? ms(b) - ms(a) : null);

/**
 * @param {{seat:string, cycle:number, openedAt?:string, slotOpenedAt?:string, deadline:string,
 *          outcome:string, closedAt:string, deliveries:Array<{id:string, offeredAt?:string, events?:Array<{state:string, at:string}>}>}} p
 */
export function residentSlotShadow({ seat, cycle, slotOpenedAt, openedAt, deadline, outcome, closedAt, deliveries = [] } = {}) {
  const at = (state) => deliveries.flatMap((d) => (d.events ?? []).filter((e) => e.state === state && ms(e.at) !== null).map((e) => e.at));
  const offeredAt = first([...at('offered'), ...deliveries.map((d) => d.offeredAt).filter((x) => ms(x) !== null)]);
  const claimedAt = first(at('claimed'));
  const turnStartedAt = first(at('turn-started'));
  const publishedAt = last(at('published'));
  // A turn is "running at close" if some delivery had a turn-started at or before the
  // close and no terminal event at or before it — the slot ended over a live turn.
  const running = deliveries.some((d) => {
    const evs = d.events ?? [];
    const started = evs.some((e) => e.state === 'turn-started' && ms(e.at) !== null && ms(e.at) <= ms(closedAt));
    const done = evs.some((e) => TERMINAL_EVENTS.has(e.state) && ms(e.at) !== null && ms(e.at) <= ms(closedAt));
    return started && !done;
  });
  const opened = slotOpenedAt ?? openedAt ?? null;
  return {
    seat, cycle, outcome,
    slotOpenedAt: opened, deadline, closedAt,
    slotMs: diff(opened, deadline),
    deliveryCount: deliveries.length,
    offeredAt, claimedAt, turnStartedAt, publishedAt,
    offerToClaimMs: diff(offeredAt, claimedAt),
    claimToTurnStartMs: diff(claimedAt, turnStartedAt),
    turnRunningAtClose: running,
    turnRunMsAtClose: running ? diff(turnStartedAt, closedAt) : null,
    turnMs: diff(turnStartedAt, publishedAt),
    publishedAfterClose: publishedAt !== null && ms(publishedAt) > ms(closedAt),
  };
}
