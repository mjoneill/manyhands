/**
 * #1703 — the L1 verdict, as a pure function (decision a74dc60a). The latency test (tests/latency/ready-executor-1644-latency.test.mjs) measures; this
 * decides. Kept apart so the verdict can be tested without executors, burners or a clock (tests/l1-ceilings-1703.test.mjs).
 *
 * The gate is a USABILITY ceiling on the executor path's p95, per phase: 1.5 s idle, 3.0 s under six CPU burners. The ratio to the in-process path is
 * computed and returned as data; nothing fails on it. These are chosen numbers, not a claim about production's tail (#1701); a regression baseline,
 * which these ceilings would not catch, is #1702.
 */

export const L1_CEILING_MS = Object.freeze({ idle: 1500, loaded: 3000 });

/** Nearest-rank p95 on an ascending copy: index min(n-1, ceil(0.95 n)-1). The same definition the latency test has always printed. */
export function p95(xs) {
  if (!xs || xs.length === 0) throw new Error('p95 of an empty sample list');
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
}

/**
 * The verdict for one phase. `ph` is what the latency test's phase() returns: { on: { ms, queries }, off: { ms, queries }, line }.
 * Returns { ok, failures, executorP95, inProcessP95, ratio, ceilingMs }; `failures` is empty exactly when `ok`.
 */
export function l1Verdict(phase, ph) {
  if (!Object.prototype.hasOwnProperty.call(L1_CEILING_MS, phase)) throw new Error(`l1Verdict: phase must be 'idle' or 'loaded', got ${JSON.stringify(phase)}`);
  const ceilingMs = L1_CEILING_MS[phase];
  const failures = [];
  if (!(ph.on.queries >= 1)) failures.push(`PRECONDITION: the switched run read the executor (${ph.on.queries} queries)`);
  const executorP95 = ph.on.ms.length ? p95(ph.on.ms) : null;
  const inProcessP95 = ph.off.ms.length ? p95(ph.off.ms) : null;
  if (executorP95 === null) failures.push(`no executor samples in the ${phase} phase; ${ph.line}`);
  else if (executorP95 > ceilingMs) failures.push(`executor p95 ${Math.round(executorP95)} ms must be <= ${ceilingMs} ms (hard ceiling, ${phase}); ${ph.line}`);
  const ratio = executorP95 !== null && inProcessP95 ? executorP95 / inProcessP95 : null;
  return { ok: failures.length === 0, failures, executorP95, inProcessP95, ratio, ceilingMs };
}
