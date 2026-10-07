/**
 * #1570 — what REST asks the graph executor, and whether REST's own event loop is the thing that is slow.
 *
 * Measured 2026-10-07 16:2xZ: card and post reads failed with "no answer within 3000 ms" while the executor's own log
 * shows the same queries finishing in under 70 ms, and a static file from REST took 3.1 s. So a timeout can be spent in
 * REST (a blocked event loop) as easily as in the executor, and a number taken on one side cannot say which. This meter
 * records BOTH sides of that question in one line a minute, so a 503 can be lined up against a measured stall:
 *
 *   - every executor call: caller label, kind (query/update/…), outcome, the route of the request that caused it
 *     (bounded: the route table's pattern, or "background"), count, total ms and max ms;
 *   - the event-loop delay over the same minute (p50 / p99 / max, ms);
 *   - one line per slow call (>= slowMs) with the request body's sha256 prefix, which matches the executor's own log
 *     line for that body. NEVER the query text: a body can carry card or post content.
 *   - one line per 503 the server sends for an unreadable graph, with the loop delay max so far this minute.
 *
 * It changes no behaviour: it observes calls that happen anyway, and a meter failure is swallowed.
 */
import { createHash } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const ms = (ns) => Math.round(ns / 1e6);

export function createExecutorMeter({ routeOf = () => 'background', extras = () => '', slowMs = 1000, log = (line) => console.error(line), now = () => new Date(), loopResolutionMs = 20 } = {}) {
  let buckets = new Map();
  let loop = null;
  try { loop = monitorEventLoopDelay({ resolution: loopResolutionMs }); loop.enable(); } catch { loop = null; }

  function record({ label = 'unlabelled', kind, outcome, elapsedMs, body }) {
    try {
      const route = routeOf() || 'background';
      const key = `${label}|${kind}|${outcome}|${route}`;
      const b = buckets.get(key) || { label, kind, outcome, route, n: 0, totalMs: 0, maxMs: 0 };
      b.n += 1; b.totalMs += elapsedMs; if (elapsedMs > b.maxMs) b.maxMs = elapsedMs;
      buckets.set(key, b);
      if (elapsedMs >= slowMs) {
        const sha = typeof body === 'string' ? createHash('sha256').update(body).digest('hex').slice(0, 16) : '-';
        log(`${now().toISOString()} executor-meter slow: ${Math.round(elapsedMs)}ms label=${label} kind=${kind} outcome=${outcome} route=${route} body=${sha}`);
      }
    } catch { /* a meter never breaks the call it observes */ }
  }

  function loopNow() {
    if (!loop || loop.count === 0) return null;
    return { p50: ms(loop.percentile(50)), p99: ms(loop.percentile(99)), max: ms(loop.max) };
  }

  /** A 503 the server sent because the graph could not be read; `code` is the response's code. */
  function unavailable(code) {
    try {
      const l = loopNow();
      log(`${now().toISOString()} executor-meter 503: code=${code} route=${routeOf() || 'background'} loopMaxThisMinuteMs=${l ? l.max : 'n/a'}`);
    } catch { /* never breaks the response */ }
  }

  /** The minute's line (and resets the minute). Returns the line, for tests. */
  function flush() {
    const rows = [...buckets.values()].sort((a, b) => b.totalMs - a.totalMs);
    buckets = new Map();
    const l = loopNow();
    if (loop) loop.reset();
    const calls = rows.reduce((s, r) => s + r.n, 0);
    const parts = rows.map((r) => `${r.label}/${r.kind}/${r.outcome}@${r.route} n=${r.n} total=${Math.round(r.totalMs)}ms max=${Math.round(r.maxMs)}ms`);
    let extra = '';
    try { extra = extras() || ''; } catch { extra = ''; }
    const line = `${now().toISOString()} executor-meter minute: calls=${calls} loopDelayMs(res=${loopResolutionMs})=${l ? `p50=${l.p50} p99=${l.p99} max=${l.max}` : 'n/a'}${extra ? ` ${extra}` : ''}${parts.length ? ` | ${parts.join(' | ')}` : ''}`;
    log(line);
    return line;
  }

  function stop() { try { loop?.disable(); } catch { /* already off */ } }

  return { record, unavailable, flush, stop, loopNow };
}

/**
 * A bounded CPU profile of THIS process, taken in-process through node:inspector's Session: no debugger port is opened.
 * One capture at a time, at most `maxMs` long, written to `dir`. Returns the file path, or null when one is running.
 */
export async function captureCpuProfile({ dir, maxMs = 60000, now = () => new Date() } = {}) {
  if (captureCpuProfile.running) return null;
  captureCpuProfile.running = true;
  const { Session } = await import('node:inspector');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const session = new Session();
  const post = (method, params) => new Promise((resolve, reject) => session.post(method, params, (e, r) => (e ? reject(e) : resolve(r))));
  try {
    session.connect();
    await post('Profiler.enable');
    await post('Profiler.start');
    await new Promise((r) => setTimeout(r, Math.max(1000, Math.min(maxMs, 60000))));
    const { profile } = await post('Profiler.stop');
    const file = path.join(dir, `rest-${now().toISOString().replace(/[:.]/g, '-')}.cpuprofile`);
    fs.writeFileSync(file, JSON.stringify(profile));
    return file;
  } finally {
    try { session.disconnect(); } catch { /* already gone */ }
    captureCpuProfile.running = false;
  }
}
captureCpuProfile.running = false;
