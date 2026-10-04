/**
 * #1559 — the SUPERVISOR around the latched executor: the healthcheck's decision
 * (pure), one tick with an injected restart, a REAL end-to-end recovery, and the
 * launchd plist renderer (dry run only: nothing is installed by these tests).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGraphClient } from '../core/graph-client.mjs';
import { decide, tick } from '../scripts/graph-executor-healthcheck.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXEC = path.join(ROOT, 'graph-executor', 'executor.py');
const HC = path.join(ROOT, 'scripts', 'graph-executor-healthcheck.mjs');
const INSTALLER = path.join(ROOT, 'scripts', 'install-graph-executor.sh');
const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(ROOT, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = !HAVE_PY ? `UNAVAILABLE: no python with pyoxigraph at ${PY}` : process.getuid?.() === 0 ? 'UNAVAILABLE: root' : false;

const T0 = Date.parse('2026-10-04T12:00:00Z');
const MIN = 600_000;
const ok = { reachable: true, httpStatus: 200, health: { status: 'OK', degraded: null } };
const degraded = (opId = 'urn:ex:op/x') => ({ reachable: true, httpStatus: 200, health: { status: 'DEGRADED',
  degraded: { since: '2026-10-04T11:59:00Z', reason: 'IO error: While appending to file: 000008.log: Permission denied', failedOpId: opId } } });

// ── the pure decision ─────────────────────────────────────────────────────────

test('#1559 healthcheck: OK → no action, no log line, state unchanged', () => {
  const st = { restarts: [] };
  const d = decide({ probe: ok, state: st, nowMs: T0, minIntervalMs: MIN });
  assert.equal(d.verdict, 'OK');
  assert.equal(d.restart, false);
  assert.equal(d.logLine, null);
  assert.deepEqual(d.nextState, st);
});

test('#1559 healthcheck: DEGRADED → ONE log line naming since, reason and failedOpId, ONE restart, recorded', () => {
  const d = decide({ probe: degraded('urn:ex:op/f1'), state: {}, nowMs: T0, minIntervalMs: MIN });
  assert.equal(d.verdict, 'DEGRADED-RESTART');
  assert.equal(d.restart, true);
  assert.equal(d.logLine.split('\n').length, 1, 'one line');
  assert.match(d.logLine, /since=2026-10-04T11:59:00Z/);
  assert.match(d.logLine, /failedOpId=urn:ex:op\/f1/);
  assert.match(d.logLine, /reason="IO error: While appending/);
  assert.equal(d.nextState.restarts.length, 1);
  assert.equal(d.nextState.restarts[0].failedOpId, 'urn:ex:op/f1');
  assert.equal(d.nextState.restarts[0].at, new Date(T0).toISOString());
});

test('#1559 healthcheck: a repeated DEGRADED within the min interval is HELD (no second restart); after the interval it restarts again (twin)', () => {
  const first = decide({ probe: degraded(), state: {}, nowMs: T0, minIntervalMs: MIN });
  const again = decide({ probe: degraded(), state: first.nextState, nowMs: T0 + MIN - 1, minIntervalMs: MIN });
  assert.equal(again.verdict, 'DEGRADED-HELD');
  assert.equal(again.restart, false);
  assert.match(again.logLine, /DEGRADED-HELD .*next-allowed-in=1s/);
  assert.equal(again.nextState.restarts.length, 1, 'a held tick records no restart');
  const later = decide({ probe: degraded(), state: first.nextState, nowMs: T0 + MIN, minIntervalMs: MIN });
  assert.equal(later.restart, true, 'the guard is an interval, not a one-shot');
  assert.equal(later.nextState.restarts.length, 2);
});

test('#1559 healthcheck: unreachable → UNAVAILABLE, no restart (a dead process is KeepAlive\'s job); a non-200 or an unknown status too', () => {
  for (const p of [{ reachable: false, error: 'ECONNREFUSED' }, { reachable: true, httpStatus: 500, health: null },
    { reachable: true, httpStatus: 200, health: { status: 'WEIRD' } }, { reachable: true, httpStatus: 200, health: null }]) {
    const d = decide({ probe: p, state: {}, nowMs: T0, minIntervalMs: MIN });
    assert.equal(d.verdict, 'UNAVAILABLE', JSON.stringify(p));
    assert.equal(d.restart, false);
    assert.match(d.logLine, /UNAVAILABLE/);
  }
});

test('#1559 healthcheck tick: three DEGRADED ticks inside the interval → the injected restart runs ONCE, one DEGRADED-RESTART line, the record is written BEFORE the restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-'));
  const logFile = path.join(dir, 'h.log'), stateFile = path.join(dir, 'h.state.json');
  const fetchImpl = async () => ({ status: 200, json: async () => degraded('urn:ex:op/t').health });
  let calls = 0, recordedAtRestart = null;
  const restart = () => { calls++; recordedAtRestart = JSON.parse(fs.readFileSync(stateFile, 'utf8')).restarts.length; return { ok: true, detail: 'fake' }; };
  const outs = [];
  for (let i = 0; i < 3; i++) outs.push((await tick({ url: 'http://x', logFile, stateFile, restart, minIntervalMs: MIN, nowMs: T0 + i * 60_000, fetchImpl })).verdict);
  assert.deepEqual(outs, ['DEGRADED-RESTART', 'DEGRADED-HELD', 'DEGRADED-HELD']);
  assert.equal(calls, 1);
  assert.equal(recordedAtRestart, 1, 'the restart was already recorded when it ran');
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
  assert.equal(lines.filter((l) => / DEGRADED-RESTART /.test(l)).length, 1);
  assert.equal(lines.filter((l) => / DEGRADED-HELD /.test(l)).length, 2);
  assert.equal(lines.filter((l) => / RESTART issued /.test(l)).length, 1);
});

// ── a REAL executor, a REAL fault, a REAL restart ─────────────────────────────

const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const health = async (base) => (await fetch(`${base}/health`)).json();
const rule = (n) => ({ kind: 'rule', opId: `urn:ex:op/sup-${n}`, actor: 'urn:ex:admin', rule: { iri: `urn:ex:R/sup-${n}` } });
const runHc = (args) => new Promise((res) => execFile(process.execPath, [HC, ...args], (err, stdout, stderr) => res({ code: err ? err.code : 0, out: stdout.trim(), err: stderr })));

/** A stand-in for launchd KeepAlive: when the executor exits, start it again on the same store and port. */
function keepAlive(store, port, create) {
  const ka = { launches: 0, pid: null, stopping: false, child: null };
  const launch = (first) => {
    if (ka.stopping) return;   // a relaunch scheduled before stop() must not outlive the test
    const c = spawn(PY, [EXEC, '--store', store, '--port', String(port), '--dataset-id', 'sup', ...(first && create ? ['--create'] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
    ka.launches++; ka.pid = c.pid; ka.child = c;
    c.stdout.resume(); c.stderr.resume();
    c.on('exit', () => { if (!ka.stopping) setTimeout(() => launch(false), 50); });
  };
  launch(true);
  ka.stop = async () => {
    ka.stopping = true;
    const c = ka.child;
    if (c.exitCode === null && c.signalCode === null) { c.kill('SIGKILL'); await new Promise((r) => c.on('exit', r)); }
  };
  return ka;
}
async function waitHealth(base, pred, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const h = await health(base); if (pred(h)) return h; } catch {}
    if (Date.now() > end) throw new Error('timed out waiting for executor health');
    await sleep(50);
  }
}

test('#1559 END TO END: a real storage fault latches the executor; the healthcheck logs it and restarts it ONCE; /health is OK after; a second fault inside the interval is HELD; the failed op reconciles to exactly one receipt', { skip: SKIP, timeout: 60_000 }, async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-hc-'));
  const logFile = path.join(dir, 'health.log'), stateFile = path.join(dir, 'health.state.json');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const ka = keepAlive(store, port, true);
  const hcArgs = () => ['--url', base, '--log', logFile, '--state', stateFile, '--min-interval-sec', '600', '--restart-cmd', `kill ${ka.pid}`];
  try {
    await waitHealth(base, (h) => h.status === 'OK');
    const c = createGraphClient({ baseUrl: base });
    assert.equal((await c.update(rule(0))).outcome, 'APPLIED');

    const healthy = await runHc(hcArgs());
    assert.equal(healthy.code, 0, healthy.err);
    assert.equal(JSON.parse(healthy.out).verdict, 'OK');
    assert.equal(fs.existsSync(logFile), false, 'an OK tick writes nothing');

    // the fault a reviewer's latch tests use: the store directory made read-only
    fs.chmodSync(store, 0o555);
    const failed = rule(1);
    assert.equal((await c.update(failed)).outcome, 'UNKNOWN');
    const h1 = await health(base);
    assert.equal(h1.status, 'DEGRADED');
    fs.chmodSync(store, 0o755);   // the cause cleared; the latch holds (RocksDB's error is sticky)
    assert.equal((await health(base)).status, 'DEGRADED', 'still latched with the cause gone: only a restart heals it');

    const pidBefore = ka.pid;
    const r = await runHc(hcArgs());
    assert.equal(r.code, 4, r.err + r.out);
    assert.equal(JSON.parse(r.out).verdict, 'DEGRADED-RESTART');
    const log = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    const line = log.filter((l) => / DEGRADED-RESTART /.test(l));
    assert.equal(line.length, 1);
    assert.ok(line[0].includes(`since=${h1.degraded.since}`) && line[0].includes(`failedOpId=${failed.opId}`) && /reason="IO error/.test(line[0]), line[0]);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).restarts.length, 1);

    const h2 = await waitHealth(base, (h) => h.status === 'OK');
    assert.notEqual(ka.pid, pidBefore, 'a NEW process answers');
    assert.equal(ka.launches, 2);
    assert.equal(h2.degraded, null);
    assert.equal(JSON.parse((await runHc(hcArgs())).out).verdict, 'OK', 'no restart on a healthy executor');

    // the failed op: reconcile by its receipt, then replay the same intention → exactly one receipt
    const rec = await c.reconcile(failed);
    assert.ok(['APPLIED', 'ABSENT'].includes(rec.outcome), rec.outcome);
    assert.equal((await c.update(failed)).outcome, 'APPLIED');
    const n = (await c.query(`SELECT ?o WHERE { <${failed.opId}> <urn:ex:outcome> ?o }`)).rows.length;
    assert.equal(n, 1, 'exactly one receipt for the failed op');

    // a SECOND fault inside the min interval: logged, HELD, the process is not touched
    fs.chmodSync(store, 0o555);
    assert.equal((await c.update(rule(2))).outcome, 'UNKNOWN');
    fs.chmodSync(store, 0o755);
    const pidHeld = ka.pid;
    const held = await runHc(hcArgs());
    assert.equal(held.code, 5, held.err + held.out);
    assert.equal(JSON.parse(held.out).verdict, 'DEGRADED-HELD');
    await sleep(300);
    assert.equal(ka.pid, pidHeld, 'no restart inside the interval');
    assert.equal(ka.launches, 2);
    assert.equal((await health(base)).status, 'DEGRADED');
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).restarts.length, 1);
  } finally {
    try { fs.chmodSync(store, 0o755); } catch {}
    await ka.stop();
  }
});

test('#1559 healthcheck CLI: an executor that is not there → UNAVAILABLE (exit 3) and the restart command is NOT run', { skip: SKIP }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-hc-'));
  const marker = path.join(dir, 'restarted');
  const port = await freePort();
  const r = await runHc(['--url', `http://127.0.0.1:${port}`, '--log', path.join(dir, 'h.log'), '--state', path.join(dir, 's.json'), '--restart-cmd', `touch ${marker}`]);
  assert.equal(r.code, 3, r.err);
  assert.equal(JSON.parse(r.out).verdict, 'UNAVAILABLE');
  assert.equal(fs.existsSync(marker), false);
  assert.match(fs.readFileSync(path.join(dir, 'h.log'), 'utf8'), /UNAVAILABLE ECONNREFUSED/);
});

// ── the plist renderer: dry run only ──────────────────────────────────────────

function render(args, home) {
  return spawnSync('sh', [INSTALLER, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home } });
}
const SECRETS = /token|password|secret|bearer|api[_-]?key|find-generic-password|EnvironmentVariables/i;

test('#1559 plist (executor): KeepAlive true, the store/port/dataset/log as arguments in order, no stdin-EOF exit, no --create, no secrets; nothing installed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plist-home-'));
  const r = render(['--store', '/srv/graph/store', '--port', '3170', '--dataset-id', 'board-prod', '--log', '/srv/graph/requests.log'], home);
  assert.equal(r.status, 0, r.stderr);
  const p = r.stdout;
  assert.match(p, /<key>KeepAlive<\/key><true\/>/);
  assert.match(p, /<key>Label<\/key><string>com\.scrumboard\.graph-executor<\/string>/);
  const args = [...p.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  const i = args.indexOf('--store');
  assert.deepEqual(args.slice(i, i + 8), ['--store', '/srv/graph/store', '--port', '3170', '--dataset-id', 'board-prod', '--log', '/srv/graph/requests.log']);
  assert.ok(args[i - 1].endsWith('/graph-executor/executor.py'));
  assert.ok(!p.includes('--exit-on-stdin-eof'), 'launchd stdin is /dev/null: this flag would make it exit at start');
  assert.ok(!p.includes('--create'));
  assert.doesNotMatch(p, SECRETS);
  if (fs.existsSync('/usr/bin/plutil')) assert.equal(spawnSync('/usr/bin/plutil', ['-lint', '-'], { input: p }).status, 0, 'a valid plist');
  assert.deepEqual(fs.readdirSync(home), [], 'a dry run writes nothing under HOME (no LaunchAgents)');
});

test('#1559 plist (healthcheck): StartInterval, kickstarts the executor label, min restart interval, no secrets; --out writes only the named file', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plist-home-'));
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plist-out-')), 'hc.plist');
  const r = render(['--job', 'healthcheck', '--store', '/srv/graph/store', '--port', '3170', '--dataset-id', 'board-prod', '--min-restart-sec', '900', '--out', out], home);
  assert.equal(r.status, 0, r.stderr);
  const p = fs.readFileSync(out, 'utf8');
  assert.match(p, /<key>StartInterval<\/key><integer>60<\/integer>/);
  assert.match(p, /<string>--url<\/string>\s*<string>http:\/\/127\.0\.0\.1:3170<\/string>/);
  assert.match(p, /<string>--label<\/string>\s*<string>com\.scrumboard\.graph-executor<\/string>/);
  assert.match(p, /<string>--min-interval-sec<\/string>\s*<string>900<\/string>/);
  assert.ok(!/KeepAlive/.test(p), 'the tick is a timer, not a daemon');
  assert.doesNotMatch(p, SECRETS);
  assert.deepEqual(fs.readdirSync(home), []);
});

test('#1559 plist: refuses a relative path, a bad port, and a value that would need XML escaping', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plist-home-'));
  const base = ['--store', '/s', '--port', '3170', '--dataset-id', 'ok'];
  const bad = [['--store', 'rel/store'], ['--port', '80x'], ['--port', '70000'], ['--dataset-id', 'a</string><string>--create'], ['--log', '/a b']];
  for (const [k, v] of bad) {
    const args = [...base]; const j = args.indexOf(k);
    if (j >= 0) args[j + 1] = v; else args.push(k, v);
    const r = render(args, home);
    assert.equal(r.status, 2, `${k} ${v} → ${r.stdout}`);
    assert.equal(r.stdout, '', 'nothing rendered');
  }
});
