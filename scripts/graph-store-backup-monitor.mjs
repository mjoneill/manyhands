#!/usr/bin/env node
/**
 * #1566 T4 — FRESHNESS MONITOR for the graph-store backups in DEST.
 *
 *   node scripts/graph-store-backup-monitor.mjs --dest DIR [--now ISO] [--interval-min 15]
 *        [--time-scale K] [--limit-min M] [--state FILE] [--store DIR] [--rehash] [--python PY] [--json]
 *
 * It reports the AGE of the NEWEST VERIFIED copy and ALERTS when that age is beyond the
 * NOMINAL limit:
 *     nominal = interval (15 min) + c + v
 * c = checkpoint + copy time and v = verification time, both MEASURED by the most recent
 * SUCCESSFUL tick and read from its record in DEST/backup-schedule-state.json (the output
 * line names that tick). With no successful tick on record, c and v are UNMEASURED and the
 * limit is the interval alone (stricter, and said so). The threshold is ALWAYS the nominal
 * limit: missed or failed ticks never widen it — a missed tick is exactly what it must
 * catch. --limit-min overrides the whole limit (and the line says so).
 * --time-scale K multiplies the recorded (real) durations into clock units when the clock
 * is SIMULATED at K x real time (default 1).
 *
 * "Newest verified" TRUSTS the publication name (graph-store-backup.mjs renames a copy to
 * graph-store-<stamp> only after verifyBackup passed) plus a CHEAP check: the manifest
 * parses and every listed file exists at its recorded size. It does NOT re-hash unless
 * --rehash, which runs the full verifyBackup (sha256 + nlink + separate read-only open) on
 * the newest one; if that fails the verdict is UNVERIFIED-NEWEST (alert). A -UNVERIFIED,
 * .partial or incomplete copy never counts, however new. Age = now − the <stamp> in the
 * copy's name (the tick's clock at the checkpoint).
 *
 * Verdicts / exit: OK 0 · UNAVAILABLE 3 (DEST unreadable/missing — never healthy) ·
 * STALE 4 · NO-COPY 5 · UNVERIFIED-NEWEST 6 · usage 2. Every alert is ONE line starting
 * "ALERT <VERDICT>" on stdout. Delivery to a human is NOT built: under launchd the line
 * lands in the job's log only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanDest, readState, STATE_FILE, steadyStateCount, destinationLine, DEFAULT_POLICY } from './graph-store-backup-schedule.mjs';
import { verifyBackup, DEFAULT_PYTHON } from './graph-store-backup.mjs';

const MIN = 60_000;
export const DEFAULT_INTERVAL_MS = 15 * MIN;
const fmtMin = (ms) => (ms / MIN).toFixed(1);
const iso = (ms) => new Date(ms).toISOString();

/** The timings of the most recent SUCCESSFUL tick, or null. Failed ticks are skipped and never widen the limit. */
export function measuredTimings(state) {
  const ticks = Array.isArray(state?.ticks) ? state.ticks : [];
  for (let i = ticks.length - 1; i >= 0; i--) {
    const t = ticks[i];
    if (t && t.ok === true && t.timings && Number.isFinite(t.timings.copyMs) && Number.isFinite(t.timings.verifyMs)) return { at: t.at, ...t.timings };
  }
  return null;
}

/** Pure. Returns { verdict, alert, ageMs, limitMs, newest, line }. */
export function assess({ copies, state, nowMs, intervalMs = DEFAULT_INTERVAL_MS, timeScale = 1, limitMs: override = null }) {
  const m = measuredTimings(state);
  let limitMs, why;
  if (override != null) {
    limitMs = override; why = `limit ${fmtMin(limitMs)} min (OVERRIDDEN by --limit-min; not derived from measurements)`;
  } else if (m) {
    const c = ((m.checkpointMs || 0) + m.copyMs) * timeScale, v = m.verifyMs * timeScale;
    limitMs = intervalMs + c + v;
    why = `nominal limit ${fmtMin(limitMs)} min = ${fmtMin(intervalMs)} min interval + copy ${fmtMin(c)} min + verify ${fmtMin(v)} min (measured by the tick at ${m.at}${timeScale !== 1 ? `, x${timeScale} time scale` : ''})`;
  } else {
    limitMs = intervalMs; why = `nominal limit ${fmtMin(limitMs)} min = ${fmtMin(intervalMs)} min interval; copy and verify time UNMEASURED (no successful tick on record)`;
  }
  const verified = copies.filter((c) => c.state === 'verified').sort((a, b) => a.atMs - b.atMs);
  if (!verified.length) {
    const others = copies.length ? ` (${copies.length} non-verified: ${[...new Set(copies.map((c) => c.state))].join(', ')})` : '';
    return { verdict: 'NO-COPY', alert: true, ageMs: null, limitMs, newest: null, line: `ALERT NO-COPY no verified copy at ${iso(nowMs)}${others}; ${why}` };
  }
  const newest = verified[verified.length - 1];
  const ageMs = nowMs - newest.atMs;
  if (ageMs > limitMs) {
    return { verdict: 'STALE', alert: true, ageMs, limitMs, newest: newest.name,
      line: `ALERT STALE newest verified copy ${newest.name} age ${fmtMin(ageMs)} min > ${why}` };
  }
  return { verdict: 'OK', alert: false, ageMs, limitMs, newest: newest.name, line: `OK newest verified copy ${newest.name} age ${fmtMin(ageMs)} min <= ${why}` };
}

function freeBytes(dir) { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); }
function dirBytes(p) {
  let n = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const q = path.join(p, e.name);
    if (e.isDirectory()) n += dirBytes(q); else if (e.isFile()) n += fs.statSync(q).size;
  }
  return n;
}

export function capacity({ dest, copies, intervalMs = DEFAULT_INTERVAL_MS }) {
  let retainedBytes = 0;
  for (const c of copies) { try { retainedBytes += dirBytes(path.join(dest, c.name)); } catch { /* vanished */ } }
  const verified = copies.filter((c) => c.state === 'verified').sort((a, b) => a.atMs - b.atMs);
  const newestBytes = verified.length ? dirBytes(path.join(dest, verified[verified.length - 1].name)) : 0;
  const retentionCount = steadyStateCount({ intervalMs, policy: DEFAULT_POLICY });
  const projectedBytes = retentionCount * newestBytes;
  return { retainedBytes, retainedCopies: copies.length, newestBytes, retentionCount, projectedBytes, projected2xBytes: 2 * projectedBytes, freeBytes: freeBytes(dest) };
}
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
export function capacityLine(c) {
  return `CAPACITY retained ${mb(c.retainedBytes)} in ${c.retainedCopies} copies; newest verified copy ${mb(c.newestBytes)} (measured); `
    + `full retention ${c.retentionCount} copies (steady state of the rule, simulated) → ${mb(c.projectedBytes)} at the measured size, `
    + `${mb(c.projected2xBytes)} at 2x (ASSUMPTION: 2x growth, not measured); free on DEST's volume ${mb(c.freeBytes)} (measured). `
    + 'A projection at today\'s size, not a bound on growth; local hard-link checkpoints are not counted.';
}

/** Side effects: reads DEST (and optionally re-verifies). Never throws for an unreadable DEST. */
export function monitor({ dest, nowMs = Date.now(), intervalMs = DEFAULT_INTERVAL_MS, timeScale = 1, limitMs = null,
  stateFile = null, store = null, rehash = false, python = DEFAULT_PYTHON }) {
  let copies;
  try { copies = scanDest(dest); }
  catch (e) {
    return { verdict: 'UNAVAILABLE', alert: true, ageMs: null, limitMs: null, newest: null,
      line: `ALERT UNAVAILABLE DEST ${dest} cannot be read (${e.code || e.message}) at ${iso(nowMs)}: freshness UNKNOWN, not healthy` };
  }
  const state = readState(stateFile || path.join(dest, STATE_FILE));
  let r = assess({ copies, state, nowMs, intervalMs, timeScale, limitMs });
  if (rehash && r.newest) {
    const v = verifyBackup(path.join(dest, r.newest), { python });
    if (!v.ok) r = { ...r, verdict: 'UNVERIFIED-NEWEST', alert: true, line: `ALERT UNVERIFIED-NEWEST ${r.newest} failed re-verification: ${v.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; ')}` };
  }
  const lastTick = Array.isArray(state.ticks) ? state.ticks[state.ticks.length - 1] : null;
  let cap = null, capLine;
  try { cap = capacity({ dest, copies, intervalMs }); capLine = capacityLine(cap); } catch (e) { capLine = `CAPACITY UNAVAILABLE: ${e.message}`; }
  return { ...r, capacity: cap, capacityLine: capLine, destinationLine: destinationLine(dest, store || lastTick?.checkpointDir || null),
    unverifiedCount: copies.filter((c) => c.state !== 'verified').length };
}

const EXIT = { OK: 0, UNAVAILABLE: 3, STALE: 4, 'NO-COPY': 5, 'UNVERIFIED-NEWEST': 6 };

function parseArgs(argv) {
  const a = { intervalMs: DEFAULT_INTERVAL_MS, timeScale: 1, python: DEFAULT_PYTHON };
  const num = (k, v) => { const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new Error(`${k} must be a number >= 0`); return n; };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dest') a.dest = argv[++i];
    else if (k === '--now') { a.nowMs = Date.parse(argv[++i]); if (!Number.isFinite(a.nowMs)) throw new Error('--now must be an ISO timestamp'); }
    else if (k === '--interval-min') a.intervalMs = num(k, argv[++i]) * MIN;
    else if (k === '--time-scale') a.timeScale = num(k, argv[++i]);
    else if (k === '--limit-min') a.limitMs = num(k, argv[++i]) * MIN;
    else if (k === '--state') a.stateFile = argv[++i];
    else if (k === '--store') a.store = argv[++i];
    else if (k === '--rehash') a.rehash = true;
    else if (k === '--python') a.python = argv[++i];
    else if (k === '--json') a.json = true;
    else throw new Error(`unknown arg: ${k}`);
  }
  if (!a.dest) throw new Error('--dest is required');
  return a;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let a;
  try { a = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  const r = monitor(a);
  console.log(r.line);
  if (r.destinationLine) console.log(r.destinationLine);
  if (r.capacityLine) console.log(r.capacityLine);
  if (r.unverifiedCount) console.log(`NOTE ${r.unverifiedCount} non-verified entr${r.unverifiedCount === 1 ? 'y' : 'ies'} in DEST (never pruned, never counted)`);
  if (a.json) console.log(JSON.stringify({ verdict: r.verdict, alert: r.alert, ageMs: r.ageMs, limitMs: r.limitMs, newest: r.newest, capacity: r.capacity ?? null }));
  process.exit(EXIT[r.verdict]);
}
