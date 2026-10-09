/**
 * #1590 — THE MONITOR'S TOLERANCE, written by the separate test author BEFORE the change (2026-10-09). The contract, from the builder's proposal and
 * the fallback owner's agreement:
 *
 *   limit = interval + max(c + v, FLOOR) + JITTER      FLOOR = 60 s, JITTER = 60 s
 *   c = (checkpointMs + copyMs) x timeScale, v = verifyMs x timeScale, both from the LAST SUCCESSFUL tick (failed ticks never widen it).
 *   FLOOR and JITTER are in CLOCK units: they are NOT multiplied by --time-scale. (ASSUMPTION, named: asked of the builder; one constant to change.)
 *   UNCHANGED: with no successful tick on record the limit is the interval alone and the line says UNMEASURED; --limit-min overrides the whole limit exactly
 *   (no floor, no jitter) and the line says OVERRIDDEN; age == limit is OK, beyond it is STALE; NO-COPY, and a newer UNVERIFIED copy never refreshing the age.
 *   The line names the floor and the jitter.
 *
 * WHY: copies land every 15 min + ~2 s (end-of-run timing drifts about +2 s a cycle) and the monitor's own 5-minute schedule reads them, so a healthy
 * newest copy is 15.05 min old at some pass; with a limit of interval + ~2 s that read as STALE on several cycles a day (a measured, healthy backup).
 * The cost, stated: a real outage alerts up to 2 min later (the 17-minute limit instead of 15.05), plus up to one 5-min monitor pass.
 *
 *   T1  the measured drift is OK: a copy at 15 min + 2 s, + 3 s and 16.9 min; the limit is exactly 17.0 min.
 *   T2  the boundary: exactly 17.0 min is OK, one second beyond is STALE, and the line names the floor and the jitter.
 *   T3  a measured c + v ABOVE the floor wins: 3 min of timings → limit 19.0 min.
 *   T4  failed ticks (huge timings) never widen it.
 *   T5  UNMEASURED is unchanged: no successful tick → limit 15.0 min, age 15.05 min is STALE, the line says UNMEASURED.
 *   T6  --limit-min is exact: no floor, no jitter, the line says OVERRIDDEN.
 *   T7  --time-scale: measured durations are scaled, the floor and the jitter are not.
 *   T8  a real miss is still caught: a copy 17.1 min old, 20 min, and 35 min (one and two missed ticks) are STALE.
 *   T9  the watcher and the monitor compute the SAME limit from the same state (one definition, two implementations): a differential over several states.
 *
 * NOT COVERED, by name: monitor() reading a real DEST directory (the existing #1566 rows do); the alert script's delivery; launchd.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { assess } = await import(pathToFileURL(path.join(HERE, '..', 'scripts', 'graph-store-backup-monitor.mjs')).href);
const MIN = 60_000, SEC = 1000;
const T0 = Date.parse('2026-10-09T00:00:00Z');
const at = (ms) => ({ name: `graph-store-${new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`, atMs: ms, state: 'verified' });
const tick = (copyMs, verifyMs, checkpointMs = 0, ok = true) => ({ at: new Date(T0).toISOString(), ok, timings: { checkpointMs, copyMs, verifyMs } });
const STATE = (copyMs, verifyMs, checkpointMs = 0) => ({ ticks: [tick(copyMs, verifyMs, checkpointMs)] });
const copies = [at(T0)];
const age = (state, ageMs, extra = {}) => assess({ copies, state, nowMs: T0 + ageMs, ...extra });

test('T1 the measured drift is OK: a copy 15 min + 2 s, + 3 s and 16.9 min old on a 2 s timing; the limit is exactly 17.0 min', () => {
  const st = STATE(1000, 1000);
  for (const ageMs of [15 * MIN + 2 * SEC, 15 * MIN + 3 * SEC, 16.9 * MIN]) { const r = age(st, ageMs); assert.equal(r.verdict, 'OK', `age ${ageMs / MIN} min`); assert.equal(r.alert, false); }
  assert.equal(age(st, 0).limitMs, 17 * MIN);
});

test('T2 the boundary: exactly 17.0 min is OK, one second beyond is STALE; the line names the floor and the jitter', () => {
  const st = STATE(1000, 1000);
  assert.equal(age(st, 17 * MIN).verdict, 'OK', 'age == limit is not beyond it');
  const stale = age(st, 17 * MIN + SEC);
  assert.equal(stale.verdict, 'STALE'); assert.equal(stale.alert, true); assert.match(stale.line, /^ALERT STALE/);
  for (const r of [age(st, 17 * MIN), stale]) { assert.match(r.line, /nominal limit 17\.0 min/); assert.match(r.line, /15\.0 min interval/); assert.match(r.line, /floor/); assert.match(r.line, /jitter/); }
});

test('T3 a measured c + v ABOVE the floor wins: 3 min of timings → the limit is 15 + 3 + 1 = 19.0 min', () => {
  const st = STATE(120_000, 60_000);   // c = 2 min, v = 1 min
  assert.equal(age(st, 0).limitMs, 19 * MIN);
  assert.equal(age(st, 19 * MIN).verdict, 'OK');
  assert.equal(age(st, 19 * MIN + SEC).verdict, 'STALE');
  assert.match(age(st, 0).line, /copy 2\.0 min/); assert.match(age(st, 0).line, /verify 1\.0 min/);
});

test('T4 failed ticks (huge timings) never widen the limit, with the floor and the jitter in force', () => {
  const st = { ticks: [tick(1000, 1000), { at: 'x', ok: false, error: 'missed' }, tick(900_000, 900_000, 0, false)] };
  assert.equal(age(st, 0).limitMs, 17 * MIN);
  assert.equal(age(st, 17 * MIN + SEC).verdict, 'STALE');
});

test('T5 UNMEASURED is unchanged: no successful tick → the limit is the interval alone, the line says UNMEASURED, and a 15.05 min copy IS stale', () => {
  const r = age({}, 15 * MIN + 3 * SEC);
  assert.equal(r.limitMs, 15 * MIN); assert.equal(r.verdict, 'STALE'); assert.match(r.line, /UNMEASURED/);
  assert.equal(age({}, 15 * MIN).verdict, 'OK');
});

test('T6 --limit-min is exact: no floor, no jitter, and the line says OVERRIDDEN', () => {
  const r = age(STATE(1000, 1000), 16 * MIN, { limitMs: 16 * MIN });
  assert.equal(r.limitMs, 16 * MIN); assert.equal(r.verdict, 'OK'); assert.match(r.line, /OVERRIDDEN/);
  assert.equal(age(STATE(1000, 1000), 16 * MIN + SEC, { limitMs: 16 * MIN }).verdict, 'STALE');
});

test('T7 --time-scale scales the measured durations but NOT the floor or the jitter (clock units)', () => {
  // 2 s x 60 = 2 min of clock, above the floor: 15 + 2 + 1 = 18.0
  assert.equal(age(STATE(1000, 1000), 0, { timeScale: 60 }).limitMs, 18 * MIN);
  // 100 ms + 100 ms x 60 = 12 s of clock, below the floor: 15 + 1 + 1 = 17.0 (an unscaled floor; a scaled one would be 15 + 60 + 60 min)
  assert.equal(age(STATE(100, 100), 0, { timeScale: 60 }).limitMs, 17 * MIN);
});

test('T8 a real miss is still caught: 17.1, 20 and 35 min (one and two missed ticks) are STALE; the alert is not blind', () => {
  const st = STATE(1000, 1000);
  for (const m of [17.1, 20, 35]) assert.equal(age(st, m * MIN).alert, true, `age ${m} min`);
  assert.equal(assess({ copies: [], state: st, nowMs: T0 }).verdict, 'NO-COPY');
  const newerUnverified = assess({ copies: [at(T0), { name: 'u', atMs: T0 + 40 * MIN, state: 'unverified' }], state: st, nowMs: T0 + 45 * MIN });
  assert.equal(newerUnverified.ageMs, 45 * MIN); assert.equal(newerUnverified.alert, true);
});

// ── T9: the watcher computes its own copy limit from its own inputs. The two must agree for the same state, or the independent fallback alarms while the primary is quiet (or the reverse) ──
const WATCH = path.join(HERE, '..', 'scripts', 'graph-store-backup-watch.mjs');
function watcherCopyMin(tickIntervalS, timings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tol1590-')); const dest = path.join(dir, 'dest'); const plists = path.join(dir, 'plists'); fs.mkdirSync(dest); fs.mkdirSync(plists);
  const stamp = new Date(T0).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const cdir = path.join(dest, `graph-store-${stamp}`); fs.mkdirSync(cdir); fs.writeFileSync(path.join(cdir, 'CURRENT'), 'MANIFEST-000001\n'); fs.writeFileSync(path.join(cdir, 'backup-manifest.json'), JSON.stringify({ files: [{ name: 'CURRENT', size: 16 }] }));
  fs.writeFileSync(path.join(dest, 'backup-schedule-state.json'), JSON.stringify({ ticks: [{ at: new Date(T0 + MIN).toISOString(), ok: true, timings }] }));
  const job = (script, interval, label) => fs.writeFileSync(path.join(plists, `${label}.plist`), `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/usr/bin/node</string><string>/x/scripts/${script}</string></array><key>StartInterval</key><integer>${interval}</integer></dict></plist>\n`);
  job('graph-store-backup-schedule.mjs', tickIntervalS, 'tick'); job('graph-store-backup-monitor.mjs', 300, 'monitor'); job('graph-store-backup-watch.mjs', 300, 'watch');
  const alertState = path.join(dir, 'alert-state.json'); fs.writeFileSync(alertState, JSON.stringify({ lastVerdict: 'OK', lastRunAt: new Date(T0 + 2 * MIN).toISOString() }));
  const config = path.join(dir, 'config.json'); fs.writeFileSync(config, JSON.stringify({ freshnessK: 3, maxClockSkewSec: 60, graceIntervals: 1, stateStalenessIntervals: 3 }));
  const status = path.join(dir, 'status.json');
  spawnSync(process.execPath, [WATCH, '--dest', dest, '--alert-state', alertState, '--plist-dir', plists, '--config', config, '--status', status, '--now', new Date(T0 + 3 * MIN).toISOString()], { encoding: 'utf8', timeout: 15000 });
  return JSON.parse(fs.readFileSync(status, 'utf8')).limits.copyMin;
}
test('T9 the watcher and the monitor compute the SAME copy limit from the same state (one definition, two implementations): below, at and above the floor, with a slow tick, and with a 30-minute tick', () => {
  for (const [tickS, cp, cy, v] of [[900, 0, 1000, 1000], [900, 20000, 20000, 20000], [900, 30000, 30000, 30000], [900, 120000, 480000, 300000], [1800, 0, 1000, 2000]]) {
    const m = assess({ copies, state: { ticks: [tick(cy, v, cp)] }, nowMs: T0, intervalMs: tickS * SEC }).limitMs / MIN;
    const w = watcherCopyMin(tickS, { checkpointMs: cp, copyMs: cy, verifyMs: v });
    assert.ok(Math.abs(m - w) < 1e-9, `tick ${tickS}s timings ${cp}+${cy}+${v} ms: monitor ${m} min, watcher ${w} min`);
  }
});
