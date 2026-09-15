/**
 * #1388 — ONE guarded read of /api/checks per tick, shared by every consumer.
 *
 * Why this exists: on 2026-09-15 the adapter's #1216 digest tick and #1215
 * emitter tick each fetched GET /api/checks on their own 60 s setInterval,
 * with no in-flight guard and no timeout. /api/checks runs every card
 * tripwire synchronously on the REST main thread; the moment one call ran
 * longer than a minute the adapter opened another, and another — 40 queued
 * by 01:12Z, REST at 100 % answering clients that had already hung up. A slow
 * board became a wedged board three times in one night, and the queue was the
 * mechanism, not the slowness.
 *
 * The rails, in one place so a third consumer cannot re-create the pile:
 *   guard    a tick that starts while the previous one is still waiting does
 *            NOTHING except say so — no second request, no queue
 *   timeout  the read carries AbortSignal.timeout(timeoutMs): a hung REST
 *            costs one abort, and the guard is released
 *   shared   consumers receive the one object the tick read; two consumers
 *            are not two reads
 *   report   a skipped or aborted tick logs one line naming which, so the
 *            fanout watch and the digest can see the breaker fire
 *
 * ⚠️ Nothing here retries. A skipped tick self-heals on the next interval,
 * exactly as #1216 already promises for an unreadable checks surface.
 */

/**
 * @param {object} deps
 * @param {(opts: { signal: AbortSignal }) => Promise<any>} deps.fetchChecks
 *   one read of /api/checks; MUST honour the signal (fetch does)
 * @param {Array<(checks: any) => any>} deps.consumers
 *   run in order with the same checks object; a throwing consumer is logged
 *   and the next still runs
 * @param {number} [deps.timeoutMs=45000] abort the read after this long —
 *   shorter than the tick interval, or a slow board still queues
 * @param {(line: string) => void} [deps.log]
 * @returns {(() => Promise<{ran?: true, skipped?: true, reason?: string}>) & { state(): {inFlight: boolean, skipped: number} }}
 */
export function makeChecksTick({ fetchChecks, consumers = [], timeoutMs = 45_000, log = () => {} }) {
  let inFlight = false;
  let skipped = 0;

  const tick = async () => {
    if (inFlight) {
      skipped += 1;
      log(`[#1388] checks tick skipped: previous /api/checks read still in flight (${skipped} in a row)`);
      return { skipped: true, reason: 'in-flight', skippedInARow: skipped };
    }
    inFlight = true;
    try {
      let checks;
      try {
        checks = await fetchChecks({ signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError' || e?.cause?.name === 'TimeoutError';
        log(timedOut
          ? `[#1388] /api/checks read aborted after ${timeoutMs} ms — skipping this tick`
          : `[#1388] /api/checks unreadable — skipping this tick: ${e?.message ?? e}`);
        return { skipped: true, reason: timedOut ? 'timeout' : 'unreadable' };
      }
      skipped = 0;
      for (const consume of consumers) {
        try { await consume(checks); } catch (e) {
          log(`[#1388] checks consumer failed (the next still runs): ${e?.message ?? e}`);
        }
      }
      return { ran: true };
    } finally {
      inFlight = false;
    }
  };
  tick.state = () => ({ inFlight, skipped });
  return tick;
}
