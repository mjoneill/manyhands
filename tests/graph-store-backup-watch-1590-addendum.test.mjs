/**
 * #1590 ADDENDUM (the separate test author, found by reading the builder's implementation against the LIVE
 * ~/Library/LaunchAgents, not by the frozen file). The frozen file is NOT changed: its hash
 * 2c7231ff79e0b27b44858d147163c752a16a454d136119d224cb007e2a8e7401 stands. This is a second,
 * separate pre-registered file.
 *
 * GAP: the live plist directory holds `com.scrumboard.graph-store-backup-monitor.plist.bak-pre-alert-1791157484`,
 * a BACKUP copy of an old monitor plist that names the monitor script. Contract line added here:
 *   ONLY files whose name ends in `.plist` are installed jobs. A backup or editor copy (`.bak-*`,
 *   `.orig`, `~`, `.plist.old`) is never read as a job, whatever its content.
 * A watcher that reads every file classifies the backup as a second monitor job; the day the live
 * interval changes, the stale copy disagrees and the watcher alerts `config-invalid` forever, or
 * (if it kept the first it found) limits come from the wrong file.
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
const NOW = Date.parse('2026-10-04T20:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const stampOf = (ms) => iso(ms).replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

function fixture(monitorIv = 300) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch1590add-'));
  const f = { root, dest: path.join(root, 'dest'), plists: path.join(root, 'plists'), alertState: path.join(root, 'alert-state.json'),
    config: path.join(root, 'config.json'), status: path.join(root, 'status.json') };
  fs.mkdirSync(f.dest); fs.mkdirSync(f.plists);
  const base = { dest: '/tmp/dest', url: 'http://127.0.0.1:9', code: '/tmp/code', node: '/usr/bin/node', home: '/tmp/home' };
  fs.writeFileSync(path.join(f.plists, 'com.x.tick.plist'), renderPlist({ job: 'tick', ...base, interval: 900 }));
  fs.writeFileSync(path.join(f.plists, 'com.x.monitor.plist'), renderPlist({ job: 'monitor', ...base, interval: monitorIv }));
  fs.writeFileSync(path.join(f.plists, 'com.x.watch.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>
<key>ProgramArguments</key><array><string>/usr/bin/node</string><string>/x/scripts/graph-store-backup-watch.mjs</string></array>
<key>StartInterval</key><integer>300</integer></dict></plist>`);
  fs.writeFileSync(f.config, JSON.stringify({ freshnessK: 3, maxClockSkewSec: 60, graceIntervals: 1, stateStalenessIntervals: 3 }));
  const copy = path.join(f.dest, `graph-store-${stampOf(NOW - 2 * MIN)}`);
  fs.mkdirSync(copy);
  fs.writeFileSync(path.join(copy, 'CURRENT'), 'MANIFEST-000001\n');
  fs.writeFileSync(path.join(copy, 'backup-manifest.json'), JSON.stringify({ files: [{ name: 'CURRENT', size: 16 }] }));
  fs.writeFileSync(path.join(f.dest, 'backup-schedule-state.json'), JSON.stringify({ ticks: [{ at: iso(NOW - 2 * MIN), ok: true, timings: { checkpointMs: 600, copyMs: 1800, verifyMs: 600 } }] }));
  fs.writeFileSync(f.alertState, JSON.stringify({ episode: null, pending: [], lastRunAt: iso(NOW - MIN), lastVerdict: 'OK' }));
  return f;
}
function run(f) {
  const r = spawnSync(process.execPath, [SCRIPT, '--dest', f.dest, '--alert-state', f.alertState, '--plist-dir', f.plists, '--config', f.config, '--status', f.status, '--now', iso(NOW)], { encoding: 'utf8', timeout: 8000 });
  let status = null; try { status = JSON.parse(fs.readFileSync(f.status, 'utf8')); } catch { /* none */ }
  return { code: r.status, err: r.stderr, status };
}

test('A1 twin: the plain fixture is OK with the monitor interval from the live plist (stateMin 15)', () => {
  const r = run(fixture());
  assert.equal(r.code, 0, r.err + JSON.stringify(r.status?.causes));
  assert.equal(r.status.limits.stateMin, 15);
});

for (const suffix of ['.bak-pre-alert-1791157484', '.orig', '.old', '~', '.bak']) {
  test(`A2 a stale copy named *.plist${suffix} with a DIFFERENT monitor interval is never read as a job: still OK, limits from the live plist`, () => {
    const f = fixture(300);
    const base = { dest: '/tmp/dest', url: 'http://127.0.0.1:9', code: '/tmp/code', node: '/usr/bin/node', home: '/tmp/home' };
    fs.writeFileSync(path.join(f.plists, `com.x.monitor.plist${suffix}`), renderPlist({ job: 'monitor', ...base, interval: 900 }));
    const r = run(f);
    assert.equal(r.code, 0, `${r.err}${JSON.stringify(r.status?.causes)}`);
    assert.deepEqual(r.status.causes, []);
    assert.equal(r.status.limits.stateMin, 15, 'the live plist (300 s x 3), not the stale copy (900 s x 3 = 45)');
  });
}

test('A3 a stale backup of the TICK or WATCHER plist is ignored the same way, and a directory with only backups for a job is config-invalid', () => {
  const f = fixture();
  const base = { dest: '/tmp/dest', url: 'http://127.0.0.1:9', code: '/tmp/code', node: '/usr/bin/node', home: '/tmp/home' };
  fs.writeFileSync(path.join(f.plists, 'com.x.tick.plist.bak-1'), renderPlist({ job: 'tick', ...base, interval: 60 }));
  assert.equal(run(f).code, 0);
  // the live monitor plist removed, only its backup left: the job is MISSING, not satisfied by the backup
  const g = fixture();
  fs.renameSync(path.join(g.plists, 'com.x.monitor.plist'), path.join(g.plists, 'com.x.monitor.plist.bak-1'));
  const r = run(g);
  assert.equal(r.code, 3);
  assert.ok(r.status.causes.some((c) => c.code === 'config-invalid'));
});
