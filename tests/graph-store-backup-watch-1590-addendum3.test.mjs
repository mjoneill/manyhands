/**
 * #1590 ADDENDUM 3 (the separate test author, from the publication review: an unknown verdict string
 * such as "BOGUS" was given the non-OK GRACE and could read as OK). Separate file; the other three
 * are unchanged.
 *
 * Contract line added here:
 *   lastVerdict is one of the monitor's verdicts: OK, UNAVAILABLE, STALE, NO-COPY, UNVERIFIED-NEWEST
 *   (the set graph-store-backup-monitor.mjs returns and the deliverer writes). A RECOGNIZED non-OK
 *   verdict gets the grace (observed, then ALERT `deliverer-verdict` beyond it). ANY OTHER string, in
 *   any case or with any padding, is ALERT `state-verdict-invalid` at once, with no grace: an
 *   unrecognised verdict can never read as OK.
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
function fixture(nowMs, verdict) {
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
  writeCopy(f.dest, `graph-store-${stampOf(nowMs - 2 * MIN)}`);
  fs.writeFileSync(path.join(f.dest, 'backup-schedule-state.json'), JSON.stringify({ ticks: [{ at: iso(nowMs - 2 * MIN), ok: true, timings: { checkpointMs: 600, copyMs: 1800, verifyMs: 600 } }] }));
  fs.writeFileSync(f.alertState, JSON.stringify({ episode: null, pending: [], lastRunAt: iso(nowMs - MIN), lastVerdict: verdict }));
  return f;
}
function run(f, nowMs) {
  const r = spawnSync(process.execPath, [SCRIPT, '--dest', f.dest, '--alert-state', f.alertState, '--plist-dir', f.plists, '--config', f.config, '--status', f.status, '--now', iso(nowMs)], { encoding: 'utf8', timeout: 8000 });
  let status = null; try { status = JSON.parse(fs.readFileSync(f.status, 'utf8')); } catch { /* none */ }
  return { code: r.status, err: r.stderr, status };
}


const NOW = Date.parse('2026-10-04T20:00:00Z');
test('V1 twin: the recognized OK verdict is OK', () => {
  const r = run(fixture(NOW, 'OK'), NOW);
  assert.equal(r.code, 0, r.err + JSON.stringify(r.status?.causes));
  assert.deepEqual(r.status.observed, []);
});
for (const v of ['UNAVAILABLE', 'STALE', 'NO-COPY', 'UNVERIFIED-NEWEST']) {
  test(`V2 recognized non-OK verdict ${v}: at first sight it is OBSERVED inside the grace and the verdict stays OK`, () => {
    const r = run(fixture(NOW, v), NOW);
    assert.equal(r.code, 0, r.err + JSON.stringify(r.status?.causes));
    assert.equal(r.status.observed.length, 1);
    assert.equal(r.status.observed[0].code, 'deliverer-verdict');
  });
}
for (const v of ['BOGUS', 'ok', 'Ok', 'OK ', ' OK', 'stale', 'ERROR', 'UNKNOWN', 'FAILED', 'OK|STALE', 'NO_COPY', 'true']) {
  test(`V3 unknown verdict ${JSON.stringify(v)}: ALERT state-verdict-invalid AT ONCE, no grace, never OK`, () => {
    const r = run(fixture(NOW, v), NOW);
    assert.equal(r.code, 3, r.err + JSON.stringify(r.status?.causes));
    assert.equal(r.status.verdict, 'ALERT');
    assert.ok(r.status.causes.some((c) => c.code === 'state-verdict-invalid'), JSON.stringify(r.status.causes));
    assert.ok(!r.status.observed.some((o) => o.code === 'deliverer-verdict'), 'an unrecognised verdict is not given the grace of a recognized one');
  });
}
