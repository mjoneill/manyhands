/**
 * #1590 — the WATCHER's launchd plist, rendered by graph-store-backup-plist.mjs `--job watch`.
 * Builder-authored (not one of the separate author's frozen files). Dry run only: these tests
 * render into temp directories and never touch launchd or a LaunchAgents directory.
 *
 * The load-bearing test is the ROUND TRIP: the watcher finds every job, its own included, by the
 * script named in ProgramArguments. A plist the renderer produces must therefore be found by the
 * watcher's own reader when it sits in a plist directory beside rendered tick and monitor plists.
 * The watcher is run for real against that directory; no limit may be config-invalid.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PLIST_MOD = process.env.WATCH_PLIST_MODULE || path.join(ROOT, 'scripts', 'graph-store-backup-plist.mjs');
const WATCH = path.join(ROOT, 'scripts', 'graph-store-backup-watch.mjs');
const { renderPlist } = await import(pathToFileURL(PLIST_MOD).href);
const { readPlistText } = await import(pathToFileURL(WATCH).href);

const MIN = 60_000;
const NOW = Date.parse('2026-10-04T20:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const stampOf = (ms) => iso(ms).replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const URL_ = 'http://127.0.0.1:9';

function paths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watchplist1590-'));
  const p = { root, dest: path.join(root, 'dest'), plists: path.join(root, 'agents'), alertState: path.join(root, 'alert-state.json'),
    config: path.join(root, 'watch-config.json'), status: path.join(root, 'out', 'watch-status.json'), ack: path.join(root, 'ack.json'),
    home: path.join(root, 'home') };
  fs.mkdirSync(p.dest); fs.mkdirSync(p.plists);
  return p;
}
const watchArgs = (p, extra = {}) => ({ job: 'watch', dest: p.dest, alertState: p.alertState, plistDir: p.plists, config: p.config,
  status: p.status, interval: 240, code: ROOT, node: process.execPath, home: p.home, ...extra });

test('W1 ROUND TRIP: rendered tick + monitor + watch plists in one directory; the real watcher finds all three and is OK', () => {
  const p = paths();
  const base = { dest: p.dest, url: URL_, code: ROOT, node: process.execPath, home: p.home };
  // file names follow each plist's own Label, as an install would
  const put = (xml) => { const label = /<key>Label<\/key><string>([^<]+)<\/string>/.exec(xml)[1]; fs.writeFileSync(path.join(p.plists, `${label}.plist`), xml); return label; };
  const labels = [put(renderPlist({ job: 'tick', ...base })), put(renderPlist({ job: 'monitor', ...base })), put(renderPlist(watchArgs(p)))];
  assert.deepEqual(labels, ['com.scrumboard.graph-store-backup-tick', 'com.scrumboard.graph-store-backup-monitor', 'com.scrumboard.graph-store-backup-watch']);

  // a healthy fixture at NOW
  const copy = path.join(p.dest, `graph-store-${stampOf(NOW - 2 * MIN)}`);
  fs.mkdirSync(copy);
  fs.writeFileSync(path.join(copy, 'CURRENT'), 'MANIFEST-000001\n');
  fs.writeFileSync(path.join(copy, 'backup-manifest.json'), JSON.stringify({ files: [{ name: 'CURRENT', size: 16 }] }));
  fs.writeFileSync(path.join(p.dest, 'backup-schedule-state.json'), JSON.stringify({ ticks: [{ at: iso(NOW - 2 * MIN), ok: true, timings: { checkpointMs: 600, copyMs: 1800, verifyMs: 600 } }] }));
  fs.writeFileSync(p.alertState, JSON.stringify({ episode: null, pending: [], lastRunAt: iso(NOW - MIN), lastVerdict: 'OK' }));
  fs.writeFileSync(p.config, JSON.stringify({ freshnessK: 3, maxClockSkewSec: 60, graceIntervals: 1, stateStalenessIntervals: 3 }));

  const r = spawnSync(process.execPath, [WATCH, '--dest', p.dest, '--alert-state', p.alertState, '--plist-dir', p.plists,
    '--config', p.config, '--status', p.status, '--now', iso(NOW)], { encoding: 'utf8', timeout: 8000 });
  const st = JSON.parse(fs.readFileSync(p.status, 'utf8'));
  assert.equal(r.status, 0, `${r.stderr}${JSON.stringify(st.causes)}`);
  assert.equal(st.verdict, 'OK');
  assert.ok(!st.causes.some((c) => c.code === 'config-invalid'), JSON.stringify(st.causes));
  assert.equal(st.limits.snapshotMin, 12, 'freshnessK 3 x the RENDERED watcher interval 240 s');
  assert.equal(st.limits.stateMin, 15, '3 x the rendered monitor interval 300 s');
  assert.ok(Math.abs(st.limits.copyMin - 15.05) < 1e-9, 'the rendered tick interval 900 s + 3 s of timings');
});

test('W2 the watcher\'s own reader identifies the rendered plist as the watch job with the given interval', () => {
  const p = paths();
  const r = readPlistText(renderPlist(watchArgs(p, { interval: 420 })));
  assert.equal(r.job, 'watch');
  assert.equal(r.interval, 420);
  assert.equal(r.error, null);
  assert.equal(r.script, path.join(ROOT, 'scripts', 'graph-store-backup-watch.mjs'));
});

test('W3 ProgramArguments: node, the watcher script, then exactly the five required flags with the given absolute paths; --ack-file only when given', () => {
  const p = paths();
  const xml = renderPlist(watchArgs(p));
  const args = [.../<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  assert.deepEqual(args, [process.execPath, path.join(ROOT, 'scripts', 'graph-store-backup-watch.mjs'),
    '--dest', p.dest, '--alert-state', p.alertState, '--plist-dir', p.plists, '--config', p.config, '--status', p.status]);
  assert.match(xml, /<key>Label<\/key><string>com\.scrumboard\.graph-store-backup-watch<\/string>/);
  assert.match(xml, /<key>StartInterval<\/key><integer>240<\/integer>/);
  assert.doesNotMatch(xml, /--url|--board|--key-file|--now/, 'the watcher takes no URL, no board, no key and never a pinned clock');
  const withAck = renderPlist(watchArgs(p, { ackFile: p.ack }));
  assert.match(withAck, /<string>--ack-file<\/string>\s*<string>[^<]*ack\.json<\/string>/);
  if (fs.existsSync('/usr/bin/plutil')) assert.equal(spawnSync('/usr/bin/plutil', ['-lint', '-'], { input: xml }).status, 0, 'a valid plist');
});

test('W4 nothing is defaulted: a missing interval or any missing required path is refused; relative paths and a board are refused', () => {
  const p = paths();
  assert.throws(() => renderPlist(watchArgs(p, { interval: null })), /--interval/);
  assert.throws(() => renderPlist(watchArgs(p, { interval: undefined })), /--interval/);
  assert.throws(() => renderPlist(watchArgs(p, { interval: 0 })), /--interval/);
  for (const [k, flag] of [['dest', '--dest'], ['alertState', '--alert-state'], ['plistDir', '--plist-dir'], ['config', '--config'], ['status', '--status']]) {
    assert.throws(() => renderPlist(watchArgs(p, { [k]: undefined })), new RegExp(flag), `${flag} missing`);
    assert.throws(() => renderPlist(watchArgs(p, { [k]: 'relative/x' })), /absolute/, `${flag} relative`);
  }
  assert.throws(() => renderPlist(watchArgs(p, { ackFile: 'relative/ack.json' })), /absolute/);
  assert.throws(() => renderPlist(watchArgs(p, { board: URL_, keyFile: '/opt/k' })), /monitor only/);
});

test('W5 CLI: --job watch prints the plist without --url; a missing --interval is a usage error (exit 2); nothing is written but --out', () => {
  const p = paths();
  const cli = path.join(ROOT, 'scripts', 'graph-store-backup-plist.mjs');
  const flags = ['--job', 'watch', '--dest', p.dest, '--alert-state', p.alertState, '--plist-dir', p.plists, '--config', p.config,
    '--status', p.status, '--code', ROOT, '--node', process.execPath];
  const ok = spawnSync(process.execPath, [cli, ...flags, '--interval', '300'], { encoding: 'utf8', timeout: 8000, env: { ...process.env, HOME: p.home } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /graph-store-backup-watch\.mjs/);
  assert.match(ok.stdout, /<key>StartInterval<\/key><integer>300<\/integer>/);
  const missing = spawnSync(process.execPath, [cli, ...flags], { encoding: 'utf8', timeout: 8000, env: { ...process.env, HOME: p.home } });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--interval/);
  assert.deepEqual(fs.readdirSync(p.plists), [], 'printing installs nothing into the plist directory');
});
