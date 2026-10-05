/**
 * #1590 ADDENDUM 2 (the separate test author, found by mutating the real watcher: a copy-name
 * check could be removed and the frozen file plus addendum 1 still passed). Separate file;
 * the other two are unchanged.
 *
 * Contract line added here:
 *   A directory whose name carries a calendar-IMPOSSIBLE stamp (graph-store-20260231T095900Z) is not
 *   a copy. Date arithmetic normalises it to a real moment (2026-03-03 09:59), so a garbled or
 *   forged name could otherwise look like a fresh copy and hide a stale real one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.WATCH_SCRIPT || path.join(HERE, '..', 'scripts', 'graph-store-backup-watch.mjs');
const PLIST_MOD = process.env.WATCH_PLIST_MODULE || path.join(HERE, '..', 'scripts', 'graph-store-backup-plist.mjs');
const { renderPlist } = await import(pathToFileURL(PLIST_MOD).href);
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const stampOf = (ms) => iso(ms).replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

function writeCopy(dest, name) {
  const d = path.join(dest, name);
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'CURRENT'), 'MANIFEST-000001\n');
  fs.writeFileSync(path.join(d, 'backup-manifest.json'), JSON.stringify({ files: [{ name: 'CURRENT', size: 16 }] }));
}
function fixture(nowMs, copyNames) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch1590add2-'));
  const f = { root, dest: path.join(root, 'dest'), plists: path.join(root, 'plists'), alertState: path.join(root, 'alert-state.json'),
    config: path.join(root, 'config.json'), status: path.join(root, 'status.json') };
  fs.mkdirSync(f.dest); fs.mkdirSync(f.plists);
  const base = { dest: '/tmp/dest', url: 'http://127.0.0.1:9', code: '/tmp/code', node: '/usr/bin/node', home: '/tmp/home' };
  fs.writeFileSync(path.join(f.plists, 'com.x.tick.plist'), renderPlist({ job: 'tick', ...base, interval: 900 }));
  fs.writeFileSync(path.join(f.plists, 'com.x.monitor.plist'), renderPlist({ job: 'monitor', ...base, interval: 300 }));
  fs.writeFileSync(path.join(f.plists, 'com.x.watch.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>
<key>ProgramArguments</key><array><string>/usr/bin/node</string><string>/x/scripts/graph-store-backup-watch.mjs</string></array>
<key>StartInterval</key><integer>300</integer></dict></plist>`);
  fs.writeFileSync(f.config, JSON.stringify({ freshnessK: 3, maxClockSkewSec: 60, graceIntervals: 1, stateStalenessIntervals: 3 }));
  for (const n of copyNames) writeCopy(f.dest, n);
  fs.writeFileSync(path.join(f.dest, 'backup-schedule-state.json'), JSON.stringify({ ticks: [{ at: iso(nowMs - 2 * MIN), ok: true, timings: { checkpointMs: 600, copyMs: 1800, verifyMs: 600 } }] }));
  fs.writeFileSync(f.alertState, JSON.stringify({ episode: null, pending: [], lastRunAt: iso(nowMs - MIN), lastVerdict: 'OK' }));
  return f;
}
function run(f, nowMs) {
  const r = spawnSync(process.execPath, [SCRIPT, '--dest', f.dest, '--alert-state', f.alertState, '--plist-dir', f.plists, '--config', f.config, '--status', f.status, '--now', iso(nowMs)], { encoding: 'utf8', timeout: 8000 });
  let status = null; try { status = JSON.parse(fs.readFileSync(f.status, 'utf8')); } catch { /* none */ }
  return { code: r.status, err: r.stderr, status };
}

// [impossible stamp, the clock at which a lenient reading of that stamp is ONE MINUTE old, the valid stamp for the twin]
const ROWS = [
  ['Feb 31', '20260231T095900Z', '2026-03-03T10:00:00Z', '20260303T095900Z'],
  ['Apr 31', '20260431T095900Z', '2026-05-01T10:00:00Z', '20260501T095900Z'],
  ['Feb 29 in a non-leap year', '20250229T095900Z', '2025-03-01T10:00:00Z', '20250301T095900Z'],
  ['Dec 32', '20261232T095900Z', '2027-01-01T10:00:00Z', '20270101T095900Z'],
];
for (const [label, bad, nowIso, good] of ROWS) {
  const now = Date.parse(nowIso);
  const stale = `graph-store-${stampOf(now - 60 * MIN)}`;
  test(`D1 ${label}: a copy named with an impossible stamp does NOT count as the newest copy (the real copy is 60 min old: ALERT copy-stale)`, () => {
    const r = run(fixture(now, [stale, `graph-store-${bad}`]), now);
    assert.equal(r.code, 3, r.err + JSON.stringify(r.status?.causes));
    assert.ok(r.status.causes.some((c) => c.code === 'copy-stale'), JSON.stringify(r.status.causes));
    assert.ok(Math.abs(r.status.ages.newestCopyMin - 60) < 1e-9, `newest age ${r.status.ages.newestCopyMin}`);
  });
  test(`D1 twin (${label}): the same fixture with a REAL stamp one minute old is OK`, () => {
    const r = run(fixture(now, [stale, `graph-store-${good}`]), now);
    assert.equal(r.code, 0, r.err + JSON.stringify(r.status?.causes));
    assert.ok(Math.abs(r.status.ages.newestCopyMin - 1) < 1e-9, `newest age ${r.status.ages.newestCopyMin}`);
  });
}
