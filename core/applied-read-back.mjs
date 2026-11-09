/**
 * #1868: a write the executor APPLIED never answers 5xx. If the read-back after it
 * fails, the request answers 200 and the body says so. Generic retry logic acts on a
 * status code, and a retry of an applied append lands it twice. A re-read never does.
 */

/** The body for an applied write whose read-back failed: what was composed and sent, plus the truth about the read. */
export function appliedUnconfirmed(composedWire, { opId, reason }) {
  return { ...composedWire, outcome: 'APPLIED', readBack: { status: 'unavailable', reason: reason ?? null }, opId: opId ?? null };
}

/** The line a tool shows ABOVE the JSON for that body, or null for every other result. */
export function appliedReadBackNotice(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.outcome !== 'APPLIED' || result.readBack?.status !== 'unavailable') return null;
  return `APPLIED: the write was stored (opId ${result.opId ?? 'unknown'}), but reading it back failed, so the body below is what was SENT, not a confirmed read. Re-read the memory to see its stored state. Do not retry: a retry would apply the change a second time.`;
}
