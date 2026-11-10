/**
 * #1847 slice 2 — the services a deploy left on the old folder are RESTARTED, in a safe order, by a script that takes
 * the operation lock ITSELF, cannot act without a before-state, and posts the before→after diff to the room.
 *
 * Done-when (the groom on #1847, 2026-11-09, extended 2026-11-10 from #1018's conditions 3 and 5):
 *   - executor + projector + MCP stale → backup, then executor, then its readiness, then REST only if readGate lost
 *     anything; the projector is restarted; MCP is NOT (a kick deafens every stream seat until a human reconnects),
 *     it is NAMED, and the exit is non-zero;
 *   - with the lock held by another operation, nothing is restarted;
 *   - no baseline → nothing is restarted;
 *   - REST down → the lock still carries the claim and note, and the room post is skipped, said out loud.
 *
 * THE SEAM: only the OS and the services are faked. launchctl and lsof are scripts on PATH that read one state file
 * (kickstart gives the job a new pid whose cwd is the serve folder); the REAL serve-cwd-check classifies them. The
 * executor and REST are HTTP servers in this process. Every side effect lands in ONE log, in order, and each kickstart
 * also records what the lock file said at that moment.
 *
 * Mutations this file must kill (each was applied and seen red before commit, see the card):
 *   (a) restart MCP too                        → S1
 *   (b) delete the lock acquire                → S3 (and S1's lock-at-kickstart rows)
 *   (c) skip the diff in the room post         → S1
 *   (d) restart REST whatever readGate says    → S2
 *   (e) restart the executor before the backup → S1, S6
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, appendFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/restart-stale.mjs', import.meta.url));
const LOCK_SCRIPT = fileURLToPath(new URL('../scripts/operation-lock.sh', import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'restart-1847-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const P = 'com.scrumboard.';

/** A world: serve + serve.previous folders, a state file the fakes read, a log every side effect appends to. */
function world(jobs, { failKickstart = [] } = {}) {
  const dir = mkdtempSync(join(ROOT, 'w-'));
  const serve = join(dir, 'serve'); const previous = `${serve}.previous`;
  mkdirSync(serve); mkdirSync(previous);
  const stateFile = join(dir, 'state.json'); const log = join(dir, 'calls.log'); const lock = join(dir, 'operation-lock.json');
  const state = { serve, previous, lock, log, failKickstart, jobs: Object.fromEntries(Object.entries(jobs).map(([k, v]) => [P + k, v])) };
  writeFileSync(stateFile, JSON.stringify(state));
  writeFileSync(log, '');
  const bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'launchctl'), `#!/usr/bin/env node
const fs = require('node:fs'); const F = ${JSON.stringify(stateFile)};
const s = JSON.parse(fs.readFileSync(F, 'utf8')); const a = process.argv.slice(2);
if (a[0] === 'list') {
  let out = 'PID\\tStatus\\tLabel\\n';
  for (const [label, j] of Object.entries(s.jobs)) out += (j.pid ?? '-') + '\\t0\\t' + label + '\\n';
  process.stdout.write(out); process.exit(0);
}
if (a[0] === 'kickstart') {
  const label = a[a.length - 1].split('/').pop();
  let lock = 'none'; try { lock = fs.readFileSync(s.lock, 'utf8').trim(); } catch {}
  fs.appendFileSync(s.log, 'kickstart ' + label.replace('${P}', '') + ' lock=' + lock + '\\n');
  if (s.failKickstart.includes(label.replace('${P}', ''))) process.exit(1);
  const j = s.jobs[label]; j.pid = (j.pid ?? 0) + 1000; j.cwd = 'serve';
  fs.writeFileSync(F, JSON.stringify(s)); process.exit(0);
}
process.exit(3);
`);
  writeFileSync(join(bin, 'lsof'), `#!/usr/bin/env node
const fs = require('node:fs'); const s = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
const pid = Number(process.argv[process.argv.indexOf('-p') + 1]);
const j = Object.values(s.jobs).find((x) => x.pid === pid);
if (!j || j.cwd === 'none') process.exit(1);
const p = j.cwd === 'serve' ? s.serve : s.previous;
process.stdout.write('p' + pid + '\\nfcwd\\ni' + fs.statSync(p).ino + '\\nn' + p + '\\n');
`);
  chmodSync(join(bin, 'launchctl'), 0o755); chmodSync(join(bin, 'lsof'), 0o755);
  const backup = join(dir, 'backup.sh');
  const n = join(dir, 'backup-runs');
  writeFileSync(backup, `#!/bin/sh\necho backup >> ${JSON.stringify(log)}\nif [ -n "\${FAKE_BACKUP_SEQ:-}" ]; then\n  i=$(cat ${JSON.stringify(n)} 2>/dev/null || echo 0); echo $((i + 1)) > ${JSON.stringify(n)}\n  rc=$(printf '%s' "$FAKE_BACKUP_SEQ" | tr ',' '\\n' | sed -n "$((i + 1))p"); [ -n "$rc" ] || rc=$(printf '%s' "$FAKE_BACKUP_SEQ" | tr ',' '\\n' | tail -n 1)\n  exit "$rc"\nfi\nexit \${FAKE_BACKUP_RC:-0}\n`); chmodSync(backup, 0o755);
  const agents = join(dir, 'LaunchAgents'); mkdirSync(agents);   // #1876 — the plists this world's jobs have; empty unless a row writes one
  return { dir, serve, stateFile, log, lock, bin, backup, agents, calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
}

/** Fake executor (/health) and REST (/api/health, /api/conversations), logging into the world's log. */
async function services(w, { lost = 0, executorStatus = 'OK', restDown = false } = {}) {
  const posts = [];
  const exec = http.createServer((req, res) => {
    appendFileSync(w.log, 'executor-health\n');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: executorStatus, epoch: '3', commitSeq: '100' }));
  });
  const rest = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; }).on('end', () => {
      if (req.method === 'POST') { posts.push(JSON.parse(b)); res.writeHead(201); res.end('{}'); return; }
      appendFileSync(w.log, 'rest-health\n');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, readGate: { running: 0, lost, waiting: 0 }, graph: { ready: true } }));
    });
  });
  await new Promise((r) => exec.listen(0, '127.0.0.1', r));
  await new Promise((r) => rest.listen(0, '127.0.0.1', r));
  const restUrl = restDown ? 'http://127.0.0.1:9' : `http://127.0.0.1:${rest.address().port}`;
  return {
    posts, restUrl, execUrl: `http://127.0.0.1:${exec.address().port}`,
    close: () => Promise.all([new Promise((r) => exec.close(r)), new Promise((r) => rest.close(r))]),
  };
}

function restart(w, svc, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [SCRIPT, '--serve', w.serve, ...args], {
      env: {
        PATH: `${w.bin}:${process.env.PATH}`, DEPLOY_LOCK: w.lock, DEPLOY_BOARD_API: svc.restUrl,
        RESTART_REST_URL: svc.restUrl, RESTART_EXECUTOR_URL: svc.execUrl, RESTART_BACKUP_CMD: w.backup,
        RESTART_POLL_MS: '30', RESTART_READY_TIMEOUT_MS: '1500', RESTART_LAUNCHAGENTS_DIR: w.agents, ...extraEnv,
      },
    });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => c.kill('SIGKILL'), 30000);
    c.on('close', (status) => { clearTimeout(t); resolve({ status, out }); });
  });
}

const kicks = (calls) => calls.filter((c) => c.startsWith('kickstart ')).map((c) => c.split(' ')[1]);
const STALE3 = () => ({ 'graph-executor': { pid: 12, cwd: 'previous' }, 'activity-projector': { pid: 13, cwd: 'previous' },
  mcp: { pid: 14, cwd: 'previous' }, rest: { pid: 11, cwd: 'serve' }, 'backup-tick': { pid: null } });

test('S1 THE DONE-WHEN: executor + projector + MCP stale, readGate lost 2 → backup, executor, readiness, REST; projector; MCP named, NOT restarted; exit non-zero; the room gets the diff', async () => {
  const w = world(STALE3()); const svc = await services(w, { lost: 2 });
  try {
    const r = await restart(w, svc, ['--holder', 'alpha', '--ask', 'post-9', '--note', 'after f7cc787']);
    const calls = w.calls();
    assert.equal(r.status, 4, `only MCP is left: ACTION NEEDED (4), not a failure (1) — the slice 2 review, post 52152\n${r.out}`);
    assert.deepEqual(kicks(calls), ['graph-executor', 'rest', 'activity-projector'], `restarted, in order, never MCP\n${calls.join('\n')}`);
    const at = (pred) => calls.findIndex(pred);
    const iBackup = at((c) => c === 'backup'); const iExec = at((c) => c.startsWith('kickstart graph-executor'));
    const iReady = calls.findIndex((c, i) => i > iExec && c === 'executor-health');
    const iLost = calls.findIndex((c, i) => i > iReady && c === 'rest-health'); const iRest = at((c) => c.startsWith('kickstart rest'));
    assert.ok(iBackup >= 0 && iBackup < iExec, `backup BEFORE the executor\n${calls.join('\n')}`);
    assert.ok(iExec < iReady && iReady < iLost && iLost < iRest, `executor → readiness → readGate read → REST\n${calls.join('\n')}`);
    for (const c of calls.filter((x) => x.startsWith('kickstart '))) {
      assert.match(c, /"holder":"alpha"/, `every kickstart happened under OUR lock: ${c}`);
      assert.match(c, /"ask":"post-9"/); assert.match(c, /"op":"restart"/);
    }
    assert.match(r.out, /mcp/i); assert.match(r.out, /\/mcp reconnect/, 'it says what the human has to do');
    assert.ok(!existsSync(w.lock), 'the lock is released afterwards');
    const diff = svc.posts.find((p) => /graph-executor/.test(p.body));
    assert.ok(diff, `a diff post reached the room: ${JSON.stringify(svc.posts)}`);
    assert.equal(diff.author, 'board');
    assert.match(diff.body, /graph-executor[^\n]*12 → 1012/, `the diff shows the executor's pid before → after\n${diff.body}`);
    assert.match(diff.body, /activity-projector[^\n]*13 → 1013/);
    assert.match(diff.body, /rest[^\n]*11 → 1011[^\n]*lost 2/, 'and why REST was restarted');
    assert.match(diff.body, /NOT restarted[^\n]*\n- mcp/i, 'MCP is named as left');
    assert.doesNotMatch(diff.body, /backup-tick/, 'a job that is not running is not in the diff');
  } finally { await svc.close(); }
});

test('S2 readGate lost 0 → the executor is restarted and REST is NOT', async () => {
  const w = world({ 'graph-executor': { pid: 12, cwd: 'previous' }, rest: { pid: 11, cwd: 'serve' } });
  const svc = await services(w, { lost: 0 });
  try {
    const r = await restart(w, svc, ['--holder', 'alpha']);
    assert.equal(r.status, 0, `everything is current afterwards\n${r.out}`);
    assert.deepEqual(kicks(w.calls()), ['graph-executor']);
  } finally { await svc.close(); }
});

test('S3 THE LOCK IS HELD BY ANOTHER OPERATION → nothing is backed up or restarted, the holder is named', async () => {
  const w = world(STALE3()); const svc = await services(w);
  try {
    const held = await new Promise((res) => spawn('sh', [LOCK_SCRIPT, 'acquire', 'deploy', 'bravo', '--ask', 'post-1'], { env: { ...process.env, DEPLOY_LOCK: w.lock } }).on('close', res));
    assert.equal(held, 0, 'CONTROL: bravo holds the lock');
    const r = await restart(w, svc, ['--holder', 'alpha']);
    assert.notEqual(r.status, 0);
    assert.deepEqual(w.calls().filter((c) => c === 'backup' || c.startsWith('kickstart')), [], `nothing acted\n${w.calls().join('\n')}`);
    assert.match(r.out, /bravo/, 'the refusal names who holds it');
    assert.match(readFileSync(w.lock, 'utf8'), /"holder":"bravo"/, 'and bravo still holds it');
  } finally { await svc.close(); }
});

test('S4 --under-lock: inside a deploy that holds the lock it acts; with the lock FREE it refuses (no unlocked restart)', async () => {
  const w = world({ 'activity-projector': { pid: 13, cwd: 'previous' } }); const svc = await services(w);
  try {
    const free = await restart(w, svc, ['--under-lock', 'deploy', '--holder', 'alpha-deploy']);
    assert.notEqual(free.status, 0); assert.deepEqual(kicks(w.calls()), [], `free lock → no restart\n${free.out}`);
    await new Promise((res) => spawn('sh', [LOCK_SCRIPT, 'acquire', 'deploy', 'alpha-deploy'], { env: { ...process.env, DEPLOY_LOCK: w.lock } }).on('close', res));
    const r = await restart(w, svc, ['--under-lock', 'deploy', '--holder', 'alpha-deploy']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(kicks(w.calls()), ['activity-projector']);
    assert.ok(existsSync(w.lock), 'the deploy\'s lock is the deploy\'s to release, not ours');
  } finally { await svc.close(); }
});

test('S5 NO BASELINE → nothing is restarted: a running job whose cwd cannot be read makes the before-state unmeasured', async () => {
  const w = world({ 'graph-executor': { pid: 12, cwd: 'previous' }, ghost: { pid: 77, cwd: 'none' } });
  const svc = await services(w);
  try {
    const r = await restart(w, svc, ['--holder', 'alpha']);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /baseline/i);
    assert.deepEqual(w.calls().filter((c) => c === 'backup' || c.startsWith('kickstart')), []);
    assert.ok(!existsSync(w.lock), 'and the lock is released');
  } finally { await svc.close(); }
});

test('S6 THE BACKUP FAILS → the executor is NOT restarted, and nothing after it is', async () => {
  const w = world(STALE3()); const svc = await services(w, { lost: 2 });
  try {
    const r = await restart(w, svc, ['--holder', 'alpha'], { FAKE_BACKUP_RC: '1' });
    assert.notEqual(r.status, 0);
    assert.deepEqual(kicks(w.calls()), [], `no kickstart after a failed backup\n${w.calls().join('\n')}`);
    assert.match(r.out, /backup/i);
  } finally { await svc.close(); }
});

test('S7 THE EXECUTOR NEVER COMES BACK READY → stop there: no REST, no projector', async () => {
  const w = world(STALE3()); const svc = await services(w, { lost: 2, executorStatus: 'DEGRADED' });
  try {
    const r = await restart(w, svc, ['--holder', 'alpha']);
    assert.notEqual(r.status, 0);
    assert.deepEqual(kicks(w.calls()), ['graph-executor'], r.out);
    assert.match(r.out, /not ready|DEGRADED/i);
  } finally { await svc.close(); }
});

test('S8 REST IS DOWN: the lock carries the claim and note while acting, the room post is skipped and SAID, the restart still runs', async () => {
  const w = world({ 'activity-projector': { pid: 13, cwd: 'previous' } }); const svc = await services(w, { restDown: true });
  try {
    const r = await restart(w, svc, ['--holder', 'alpha', '--note', 'projector after deploy']);
    assert.equal(r.status, 0, r.out);
    const [k] = w.calls().filter((c) => c.startsWith('kickstart'));
    assert.match(k, /"note":"projector after deploy"/, 'the intent is in the lock file, where it survives REST being down');
    assert.match(r.out, /not posted|tell the room by hand/i);
    assert.equal(svc.posts.length, 0);
  } finally { await svc.close(); }
});

test('S9 NOTHING STALE → no restart, no post, exit 0', async () => {
  const w = world({ rest: { pid: 11, cwd: 'serve' } }); const svc = await services(w);
  try {
    const r = await restart(w, svc, ['--holder', 'alpha']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(w.calls().filter((c) => c === 'backup' || c.startsWith('kickstart')), []);
    assert.equal(svc.posts.length, 0);
    assert.ok(statSync(w.serve));
  } finally { await svc.close(); }
});

test('S10 A SCHEDULED BACKUP TICK HOLDS ITS LOCK (exit 7) → wait and try again; the executor restarts after the backup that succeeded', async () => {
  const w = world({ 'graph-executor': { pid: 12, cwd: 'previous' } }); const svc = await services(w);
  try {
    const r = await restart(w, svc, ['--holder', 'alpha'], { FAKE_BACKUP_SEQ: '7,0', RESTART_BACKUP_WAIT_MS: '20' });
    assert.equal(r.status, 0, r.out);
    const calls = w.calls();
    assert.deepEqual(calls.filter((c) => c === 'backup' || c.startsWith('kickstart')).map((c) => c.split(' ')[0]), ['backup', 'backup', 'kickstart'], calls.join('\n'));
  } finally { await svc.close(); }
});

test('S11 THE TICK NEVER LETS GO → no executor restart, and it says a scheduled backup is running (not that the backup is broken)', async () => {
  const w = world({ 'graph-executor': { pid: 12, cwd: 'previous' } }); const svc = await services(w);
  try {
    const r = await restart(w, svc, ['--holder', 'alpha'], { FAKE_BACKUP_SEQ: '7', RESTART_BACKUP_WAIT_MS: '20', RESTART_BACKUP_TRIES: '3' });
    assert.equal(r.status, 1, r.out);
    assert.equal(w.calls().filter((c) => c === 'backup').length, 3, 'three tries, no more');
    assert.deepEqual(kicks(w.calls()), []);
    assert.match(r.out, /STOPPED: a scheduled backup is running[^\n]*re-run in a minute/i, 'the VERDICT names the busy tick, not only the retry lines');
    assert.doesNotMatch(r.out, /backup exited 7/, 'and never reads as a broken backup');
  } finally { await svc.close(); }
});

test('S12 ANOTHER JOB LEFT STALE beside MCP → exit 1 (a real leftover), not 4', async () => {
  const w = world({ mcp: { pid: 14, cwd: 'previous' }, fanoutwatch: { pid: 15, cwd: 'previous' } }); const svc = await services(w);
  try {
    const r = await restart(w, svc, ['--holder', 'alpha']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /fanoutwatch/);
  } finally { await svc.close(); }
});

// ── #1876: a PERIODIC job (StartInterval / StartCalendarInterval, no KeepAlive) caught mid-tick is not a failure ──
function plist(w, label, keys) {
  const body = Object.entries(keys).map(([k, v]) => `\t<key>${k}</key>\n\t${v}`).join('\n');
  writeFileSync(join(w.agents, `${P}${label}.plist`), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${P}${label}</string>
${body}
</dict>
</plist>
`);
}

test('S13 #1876 A PERIODIC JOB CAUGHT MID-TICK → named as periodic, not kickstarted, exit 0 (it picks up the served tree at its next start)', async () => {
  const w = world({ 'guestwake-alpha': { pid: 21, cwd: 'previous' } }); const svc = await services(w);
  plist(w, 'guestwake-alpha', { StartInterval: '<integer>60</integer>', RunAtLoad: '<true/>' });
  try {
    const r = await restart(w, svc, ['--holder', 'alpha']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(kicks(w.calls()), [], 'a periodic job is not kickstarted');
    assert.match(r.out, /guestwake-alpha[^\n]*periodic[^\n]*next start/);
    assert.doesNotMatch(r.out, /no readiness check is written down for it/);
  } finally { await svc.close(); }
});

test('S14 #1876 MCP + a PERIODIC job (StartCalendarInterval) left → exit 4, ACTION NEEDED for MCP only', async () => {
  const w = world({ mcp: { pid: 14, cwd: 'previous' }, 'nightly-alpha': { pid: 22, cwd: 'previous' } }); const svc = await services(w);
  plist(w, 'nightly-alpha', { StartCalendarInterval: '<dict>\n\t\t<key>Hour</key>\n\t\t<integer>3</integer>\n\t</dict>' });
  try {
    const r = await restart(w, svc, ['--holder', 'alpha']);
    assert.equal(r.status, 4, r.out);
    assert.match(r.out, /nightly-alpha[^\n]*periodic/);
    assert.deepEqual(kicks(w.calls()), []);
  } finally { await svc.close(); }
});

test('S15 #1876 A StartInterval job WITH KeepAlive is long-running → still named for a hand restart, exit 1', async () => {
  const w = world({ 'watch-alpha': { pid: 23, cwd: 'previous' } }); const svc = await services(w);
  plist(w, 'watch-alpha', { StartInterval: '<integer>60</integer>', KeepAlive: '<true/>' });
  try {
    const r = await restart(w, svc, ['--holder', 'alpha']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /watch-alpha — no readiness check is written down for it/);
  } finally { await svc.close(); }
});

test('S16 #1876 a stale job with NO plist, or KeepAlive given as a dict, is not presumed periodic → exit 1', async () => {
  const w = world({ 'ghost-alpha': { pid: 24, cwd: 'previous' }, 'cond-alpha': { pid: 25, cwd: 'previous' } }); const svc = await services(w);
  plist(w, 'cond-alpha', { StartInterval: '<integer>60</integer>', KeepAlive: '<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>\n\t</dict>' });
  try {
    const r = await restart(w, svc, ['--holder', 'alpha']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /ghost-alpha — no readiness check/); assert.match(r.out, /cond-alpha — no readiness check/);
  } finally { await svc.close(); }
});
