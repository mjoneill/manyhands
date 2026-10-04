#!/usr/bin/env node
/**
 * #1559 — the graph executor's supervisor tick. Run on an interval (launchd StartInterval).
 *
 *   node scripts/graph-executor-healthcheck.mjs --url http://127.0.0.1:PORT --log FILE --state FILE
 *        (--label LABEL | --restart-cmd 'SHELL COMMAND') [--min-interval-sec 600]
 *
 * Division of labour with launchd:
 *   * a DEAD executor is launchd's job (KeepAlive). This tick reports UNAVAILABLE and
 *     restarts nothing: kickstarting a process that is crash-looping (e.g. its startup
 *     self-check refusing a store that cannot flush) would only add a second loop.
 *   * a LIVE executor whose durability latch is set (/health status DEGRADED) cannot heal
 *     itself: RocksDB's background error is sticky for the life of the open store, so the
 *     only recovery is a restart. That is the one thing this tick does: one log line naming
 *     since / reason / failedOpId, a restart record in the state file, then the restart
 *     (`launchctl kickstart -k gui/<uid>/<label>` unless a command is injected).
 *   * never twice in a tight loop: a second DEGRADED within --min-interval-sec of the last
 *     restart is HELD (logged, not restarted). The restart is RECORDED BEFORE it runs, so a
 *     tick that dies mid-restart still counts against the interval.
 *
 * After a restart, the failed op's outcome is still UNKNOWN to its caller: it must be
 * reconciled by its receipt (core/graph-client.mjs reconcile) before any retry. This
 * script does not do that; it names the opId in the log so a human or caller can.
 *
 * The decision is the pure function `decide`; everything with a side effect is in `tick`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MIN_INTERVAL_MS = 10 * 60 * 1000;
const KEEP_RESTARTS = 50;
const oneLine = (s) => String(s ?? '-').replace(/\s+/g, ' ').trim();

/**
 * Pure. probe: { reachable: false, error } | { reachable: true, httpStatus, health }.
 * state: { restarts: [{ at, since, reason, failedOpId }] } (newest last).
 * Returns { verdict, restart, logLine, nextState }.
 *   verdict ∈ OK | UNAVAILABLE | DEGRADED-RESTART | DEGRADED-HELD
 */
export function decide({ probe, state = {}, nowMs, minIntervalMs = DEFAULT_MIN_INTERVAL_MS }) {
  const restarts = Array.isArray(state.restarts) ? state.restarts : [];
  const ts = new Date(nowMs).toISOString();
  const keep = { ...state, restarts };
  if (!probe || !probe.reachable || probe.httpStatus !== 200 || !probe.health || typeof probe.health !== 'object') {
    const why = !probe?.reachable ? oneLine(probe?.error) : `http ${probe.httpStatus}`;
    return { verdict: 'UNAVAILABLE', restart: false, logLine: `${ts} UNAVAILABLE ${why} (no restart: a dead process is launchd KeepAlive's job)`, nextState: keep };
  }
  const h = probe.health;
  if (h.status === 'OK') return { verdict: 'OK', restart: false, logLine: null, nextState: keep };
  if (h.status !== 'DEGRADED') {
    return { verdict: 'UNAVAILABLE', restart: false, logLine: `${ts} UNAVAILABLE unrecognised status ${oneLine(h.status)}`, nextState: keep };
  }
  const d = h.degraded || {};
  const facts = `since=${oneLine(d.since)} failedOpId=${oneLine(d.failedOpId)} reason=${JSON.stringify(oneLine(d.reason))}`;
  const last = restarts.length ? Date.parse(restarts[restarts.length - 1].at) : NaN;
  if (Number.isFinite(last) && nowMs - last < minIntervalMs) {
    const wait = Math.ceil((minIntervalMs - (nowMs - last)) / 1000);
    return { verdict: 'DEGRADED-HELD', restart: false,
      logLine: `${ts} DEGRADED-HELD ${facts} last-restart=${restarts[restarts.length - 1].at} next-allowed-in=${wait}s`, nextState: keep };
  }
  const rec = { at: ts, since: d.since ?? null, reason: d.reason ?? null, failedOpId: d.failedOpId ?? null };
  return { verdict: 'DEGRADED-RESTART', restart: true, logLine: `${ts} DEGRADED-RESTART ${facts}`,
    nextState: { ...state, restarts: [...restarts, rec].slice(-KEEP_RESTARTS) } };
}

export async function probe(url, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  try {
    const r = await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    let health = null;
    try { health = await r.json(); } catch { /* non-JSON → unavailable */ }
    return { reachable: true, httpStatus: r.status, health };
  } catch (e) {
    return { reachable: false, error: e.cause?.code || e.name || e.message };
  }
}

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function writeState(file, s) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** One supervisor tick. `restart` is the injected side effect: () => { ok, detail }. */
export async function tick({ url, logFile, stateFile, restart, minIntervalMs = DEFAULT_MIN_INTERVAL_MS, nowMs = Date.now(), fetchImpl }) {
  const p = await probe(url, { fetchImpl });
  const d = decide({ probe: p, state: readState(stateFile), nowMs, minIntervalMs });
  if (d.logLine) { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, d.logLine + '\n'); }
  let restartResult = null;
  if (d.restart) {
    writeState(stateFile, d.nextState);   // recorded BEFORE the restart runs
    restartResult = restart();
    fs.appendFileSync(logFile, `${new Date().toISOString()} RESTART ${restartResult.ok ? 'issued' : 'FAILED'} ${oneLine(restartResult.detail)}\n`);
  }
  return { verdict: d.verdict, restarted: d.restart, restartResult };
}

export function commandRestart({ label, cmd }) {
  const argv = cmd ? ['/bin/sh', '-c', cmd] : ['launchctl', 'kickstart', '-k', `gui/${process.getuid()}/${label}`];
  return () => {
    const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 60_000 });
    return { ok: r.status === 0, detail: `${argv.join(' ')} → rc ${r.status}${r.stderr ? ` ${r.stderr.trim()}` : ''}` };
  };
}

function parseArgs(argv) {
  const a = { minIntervalMs: DEFAULT_MIN_INTERVAL_MS };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--url') a.url = argv[++i];
    else if (k === '--log') a.logFile = argv[++i];
    else if (k === '--state') a.stateFile = argv[++i];
    else if (k === '--label') a.label = argv[++i];
    else if (k === '--restart-cmd') a.cmd = argv[++i];
    else if (k === '--min-interval-sec') a.minIntervalMs = Number(argv[++i]) * 1000;
    else throw new Error(`unknown arg: ${k}`);
  }
  if (!a.url || !a.logFile || !a.stateFile) throw new Error('--url, --log and --state are required');
  if (!a.label === !a.cmd) throw new Error('exactly one of --label (launchctl kickstart) or --restart-cmd');
  if (!(a.minIntervalMs >= 0)) throw new Error('--min-interval-sec must be a number >= 0');
  return a;
}

const EXIT = { OK: 0, UNAVAILABLE: 3, 'DEGRADED-RESTART': 4, 'DEGRADED-HELD': 5 };

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let a;
  try { a = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  tick({ ...a, restart: commandRestart(a) }).then((r) => {
    console.log(JSON.stringify(r));
    process.exit(r.restartResult && !r.restartResult.ok ? 6 : EXIT[r.verdict]);
  }, (e) => { console.error(`HEALTHCHECK ERROR: ${e.message}`); process.exit(1); });
}
