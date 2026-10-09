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
 *   - on both of those lines, WHO asked: `caller=` (the request's User-Agent, sanitised to [A-Za-z0-9._/:+()-], at most 64
 *     characters) and `peer=` (the socket's remote port, so `lsof -iTCP:<port>` names the process while the connection
 *     lives, since every Node client's User-Agent is just "node"). Never in the minute line's buckets: callers are
 *     unbounded, and the minute line must stay bounded.
 *
 * It changes no behaviour: it observes calls that happen anyway, and a meter failure is swallowed.
 */
import crypto, { createHash } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const ms = (ns) => Math.round(ns / 1e6);

export function createExecutorMeter({ routeOf = () => 'background', ridOf = () => null, callerOf = () => null, peerOf = () => null, extras = () => '', slowMs = 1000, log = (line) => console.error(line), now = () => new Date(), loopResolutionMs = 20, loopFactory = () => monitorEventLoopDelay({ resolution: loopResolutionMs }) } = {}) {
  let buckets = new Map();
  // #1570 — who asked, as a single safe token: anything outside the allowed set becomes "_" (so a header can't forge a
  // field or break the line), at most 64 characters, "-" when absent or when reading it throws.
  const callerToken = () => {
    try {
      const c = callerOf();
      if (c == null || c === '') return '-';
      return String(c).replace(/[^A-Za-z0-9._/:+()-]/g, '_').slice(0, 64) || '-';
    } catch { return '-'; }
  };
  const peerToken = () => {
    try { const p = peerOf(); return Number.isInteger(p) && p >= 1 && p <= 65535 ? String(p) : '-'; } catch { return '-'; }
  };
  // #1570 — the running totals the daily "still running" post reports (owner decision, 2026-10-07: so nobody forgets it is out there).
  let day = { since: now(), calls: 0, slow: 0, unavailable: 0, loopMaxMs: 0 };
  // The worst loop delay seen AFTER the outstanding snapshot was taken: it belongs to the next post, so an ack keeps it.
  let snapOutstanding = false;
  let peakSinceSnap = 0;
  const notePeak = (v) => { if (v > day.loopMaxMs) day.loopMaxMs = v; if (snapOutstanding && v > peakSinceSnap) peakSinceSnap = v; };
  let loop = null;
  try { loop = loopFactory(); loop.enable(); } catch { loop = null; }   // loopFactory: injectable for tests

  function record({ label = 'unlabelled', kind, outcome, elapsedMs, body }) {
    try {
      const route = routeOf() || 'background';
      const key = `${label}|${kind}|${outcome}|${route}`;
      const b = buckets.get(key) || { label, kind, outcome, route, n: 0, totalMs: 0, maxMs: 0 };
      b.n += 1; b.totalMs += elapsedMs; if (elapsedMs > b.maxMs) b.maxMs = elapsedMs;
      buckets.set(key, b);
      day.calls += 1;
      if (elapsedMs >= slowMs) {
        day.slow += 1;
        const sha = typeof body === 'string' ? createHash('sha256').update(body).digest('hex').slice(0, 16) : '-';
        log(`${now().toISOString()} executor-meter slow: ${Math.round(elapsedMs)}ms label=${label} kind=${kind} outcome=${outcome} route=${route} rid=${ridOf() || '-'} caller=${callerToken()} peer=${peerToken()} body=${sha}`);
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
      day.unavailable += 1;
      const l = loopNow();
      log(`${now().toISOString()} executor-meter 503: code=${code} route=${routeOf() || 'background'} rid=${ridOf() || '-'} caller=${callerToken()} peer=${peerToken()} loopMaxThisMinuteMs=${l ? l.max : 'n/a'}`);
    } catch { /* never breaks the response */ }
  }

  /** The minute's line (and resets the minute). Returns the line, for tests. */
  function flush() {
    const rows = [...buckets.values()].sort((a, b) => b.totalMs - a.totalMs);
    buckets = new Map();
    const l = loopNow();
    if (l) notePeak(l.max);
    if (loop) loop.reset();
    const calls = rows.reduce((s, r) => s + r.n, 0);
    const parts = rows.map((r) => `${r.label}/${r.kind}/${r.outcome}@${r.route} n=${r.n} total=${Math.round(r.totalMs)}ms max=${Math.round(r.maxMs)}ms`);
    let extra = '';
    try { extra = extras() || ''; } catch { extra = ''; }
    const line = `${now().toISOString()} executor-meter minute: calls=${calls} loopDelayMs(res=${loopResolutionMs})=${l ? `p50=${l.p50} p99=${l.p99} max=${l.max}` : 'n/a'}${extra ? ` ${extra}` : ''}${parts.length ? ` | ${parts.join(' | ')}` : ''}`;
    log(line);
    return line;
  }

  /**
   * The daily keep-alive: a SNAPSHOT of what ran since the last confirmed post, and how to turn it off. Nothing is reset
   * here: the counters keep running, and only ackDaily(snap) — called once the post is CONFIRMED delivered — subtracts
   * exactly what that post reported. A refused or failed post leaves the day intact for the retry (review 2026-10-07).
   */
  function prepareDaily({ pid = process.pid, off = 'set SCRUM_EXECUTOR_METER=0 in the REST launchd plist and restart REST' } = {}) {
    const l = loopNow();
    if (l) notePeak(l.max);
    if (loop) loop.reset();   // what the histogram held is now in the snapshot; anything later is post-snapshot
    const snap = { ...day, until: now() };
    snapOutstanding = true;
    peakSinceSnap = 0;
    const text = `📈 #1570 executor meter is still running in REST (pid ${pid}). From ${snap.since.toISOString()} to ${snap.until.toISOString()}: ${snap.calls} executor calls, ${snap.slow} slow (>= ${slowMs} ms), ${snap.unavailable} graph-unavailable 503s, worst event-loop delay ${snap.loopMaxMs} ms. Per-minute detail: "executor-meter" lines in the REST log. To turn it off: ${off}.`;
    return { text, snap };
  }
  function ackDaily(snap) {
    const l = loopNow();
    if (l) notePeak(l.max);
    day = { since: snap.until, calls: Math.max(0, day.calls - snap.calls), slow: Math.max(0, day.slow - snap.slow), unavailable: Math.max(0, day.unavailable - snap.unavailable), loopMaxMs: peakSinceSnap };
    snapOutstanding = false;
    peakSinceSnap = 0;
  }

  function stop() { try { loop?.disable(); } catch { /* already off */ } }

  return { record, unavailable, flush, prepareDaily, ackDaily, stop, loopNow };
}

/**
 * #1570 — the keep-alive's delivery loop, kept apart from the server so it can be tested with a failing `post`.
 * `post(text, requestId)` resolves to true only when the board CONFIRMED the post. The meter's counters are reduced by
 * what a post reported only after that confirmation; a refusal or failure keeps the SAME text and requestId and retries
 * after `retryMs` (REST's post-create replays a known requestId, so a retry can never post twice).
 */
export function createKeepAlive({ meter, post, retryMs = 300_000, log = (line) => console.error(line), now = () => new Date(), setTimer = (fn, ms) => setTimeout(fn, ms).unref?.(), newId = () => crypto.randomUUID() }) {
  let pending = null;
  let inFlight = false;
  async function fire() {
    if (inFlight) return;
    if (!pending) pending = { ...meter.prepareDaily(), requestId: newId() };
    const p = pending;
    inFlight = true;
    let ok = false;
    try { ok = (await post(p.text, p.requestId)) === true; } catch (e) { log(`${now().toISOString()} #1570 meter keep-alive post failed: ${e.message}`); }
    inFlight = false;
    if (ok) { meter.ackDaily(p.snap); pending = null; return true; }
    log(`${now().toISOString()} #1570 meter keep-alive not confirmed; retrying in ${retryMs} ms with the same requestId`);
    setTimer(fire, retryMs);
    return false;
  }
  return { fire, pending: () => pending };
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
