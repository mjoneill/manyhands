/**
 * #1670 — `startExecutor` (tests/helpers/graph-executor-proc.mjs) on its STARTUP FAILURE paths. Written against the current helper before any fix (RED rows), by a different hand than the fix.
 * The seam: the helper takes its interpreter from GRAPH_EXECUTOR_PYTHON at import time, so each row runs a small child node process with that variable pointing at a STUB script that behaves like
 * an executor that is broken in one way. The stub records its own pid, so the row can check, from outside, whether the process the helper spawned is still alive after the helper has answered.
 *
 * Every row runs for BOTH helpers (tag A = startExecutor in graph-executor-proc.mjs, tag B = startExecutorOnCopy in ready-world-1644.mjs: the same shape, written separately):
 *   E1 JUNK     the stub's first stdout line is not JSON: the helper must reject AND must not leave the spawned process running
 *   E2 SILENT   the stub never prints and never exits: the helper must settle (reject) within 20 s, and leave no surviving process. PRE-REGISTERED 2026-10-11, before any run: 20 s is the outer bound on this row, NOT the
 *               helper's own timeout (the fix chooses that; a real executor prints its ready line in about a second or two, so a helper timeout well under 20 s and well over real startup is the intent)
 *   E4 ARGS     the arguments the executor is started with: the copy helper adds --promote-epoch and never --create; the plain helper adds neither (a delegation that drops the flag would otherwise be invisible to a stub that ignores arguments)
 *   E3 CONTROL  the stub's first line is a valid ready line: the helper resolves with that port and a live process (so the seam works and a fix cannot break the healthy path)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withOwned } from './helpers/ready-world-1644.mjs';

const HELPERS = {   // the two functions that start an executor for tests; same contract, two files
  startExecutor: { file: path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'graph-executor-proc.mjs'), call: (store) => `startExecutor({ store: ${JSON.stringify(store)}, datasetId: 'x1670' })` },
  startExecutorOnCopy: { file: path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'ready-world-1644.mjs'), call: (store) => `startExecutorOnCopy({ store: ${JSON.stringify(store)}, datasetId: 'x1670' })` },
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitDead = async (pid, ms = 3000) => { for (let t = 0; t < ms && alive(pid); t += 100) await sleep(100); return !alive(pid); };

const STUB = `#!/bin/sh
# a stand-in for the executor's python: "-c" (the helper's own import check) succeeds; any other call records its pid and misbehaves as STUB_MODE says
case "$1" in -c) exit 0;; esac
echo $$ > "$STUB_PID_FILE"
echo "$@" > "$STUB_ARGS_FILE"
case "$STUB_MODE" in
  junk) echo "this first line is not json" ;;
  ready) echo '{"port": 59999}' ;;
esac
while true; do sleep 1; done
`;

/** Run startExecutor against a stub in a child process. Resolves { outcome, text, stubPid, ms } where outcome is RESOLVED | REJECTED | NEVER_SETTLED (the child had to be killed). */
async function runStartup(mode, { settleWithinMs, helper }) {
  return withOwned(async (own) => {
    const dir = own.dir('r44u-1670-');
    const stub = path.join(dir, 'python-stub'); fs.writeFileSync(stub, STUB, { mode: 0o755 });
    const pidFile = path.join(dir, 'stub.pid'); const argsFile = path.join(dir, 'stub.args');
    const script = `import { ${helper} } from ${JSON.stringify(HELPERS[helper].file)};\ntry { const x = await ${HELPERS[helper].call(path.join(dir, 'store'))}; console.log('RESOLVED ' + x.port); } catch (e) { console.log('REJECTED ' + String(e.message).slice(0, 100)); }\nprocess.exit(0);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, GRAPH_EXECUTOR_PYTHON: stub, STUB_MODE: mode, STUB_PID_FILE: pidFile, STUB_ARGS_FILE: argsFile }, stdio: ['ignore', 'pipe', 'pipe'] });
    own.adopt(async () => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
    own.adopt(async () => { try { const pid = Number(fs.readFileSync(pidFile, 'utf8')); if (pid) process.kill(pid, 'SIGKILL'); } catch { /* never started or gone */ } });
    let text = ''; child.stdout.on('data', (d) => { text += d; }); child.stderr.on('data', (d) => { text += d; });
    const t0 = performance.now();
    const exited = new Promise((r) => child.once('exit', () => r(true)));
    const settled = await Promise.race([exited, sleep(settleWithinMs).then(() => false)]);
    const ms = Math.round(performance.now() - t0);
    // read survival BEFORE this function's cleanups run (they kill the stub): did the process the helper spawned outlive the helper's answer? (3 s grace for a fix that kills it on rejection)
    const stubPid = readPid(pidFile); const gone = stubPid ? await waitDead(stubPid) : false; const survived = stubPid ? !gone : false;
    const args = (() => { try { return fs.readFileSync(argsFile, 'utf8').trim().split(/\s+/); } catch { return []; } })();
    if (!settled) return { outcome: 'NEVER_SETTLED', text, stubPid, survived, ms, args };
    const outcome = /^RESOLVED/.test(text.trim()) ? 'RESOLVED' : /^REJECTED/.test(text.trim()) ? 'REJECTED' : 'UNKNOWN';
    return { outcome, text: text.trim(), stubPid, survived, ms, args };
  });
}
const readPid = (f) => { try { return Number(fs.readFileSync(f, 'utf8')); } catch { return 0; } };

for (const [tag, helper] of [['A', 'startExecutor'], ['B', 'startExecutorOnCopy']]) {
  test(`${tag} E1 JUNK: a first stdout line that is not JSON makes ${helper} reject AND leaves no spawned process running`, { timeout: 60000 }, async () => {
    let pid = 0;
    try {
      const r = await runStartup('junk', { settleWithinMs: 15000, helper }); pid = r.stubPid;
      assert.equal(r.outcome, 'REJECTED', `the helper rejects a non-JSON ready line (${r.outcome}: ${r.text})`);
      assert.ok(pid > 0, 'CONTROL: the stub really started (its pid was recorded)');
      assert.equal(r.survived, false, `the process the helper spawned (pid ${pid}) is gone after the helper rejected; a surviving executor is an orphan nobody can adopt`);
    } finally { if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
  });

  test(`${tag} E2 SILENT: an executor that never prints a ready line makes ${helper} settle within 20 s, and leaves no spawned process running`, { timeout: 60000 }, async () => {
    let pid = 0;
    try {
      const r = await runStartup('silent', { settleWithinMs: 20000, helper }); pid = r.stubPid;
      assert.ok(pid > 0, 'CONTROL: the stub really started (its pid was recorded)');
      assert.equal(r.outcome, 'REJECTED', `the helper must settle by rejecting within 20 s when no ready line ever comes (${r.outcome} after ${r.ms} ms)`);
      assert.equal(r.survived, false, `the process the helper spawned (pid ${pid}) is gone after the helper gave up`);
    } finally { if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
  });

  test(`${tag} E3 CONTROL: a valid ready line still resolves with that port and a live process (the seam works; the healthy path is not broken)`, { timeout: 60000 }, async () => {
    let pid = 0;
    try {
      const r = await runStartup('ready', { settleWithinMs: 15000, helper }); pid = r.stubPid;
      assert.equal(r.outcome, 'RESOLVED', `a valid ready line resolves (${r.outcome}: ${r.text})`);
      assert.match(r.text, /RESOLVED 59999/, 'with the port the stub printed');
      assert.ok(pid > 0 && r.survived, 'the spawned process is alive after a successful start (the helper must not kill a healthy executor)');
    } finally { if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
  });

  test(`${tag} E4 ARGS: ${helper} starts the executor with the arguments its contract promises (the delegation must not drop or add any)`, { timeout: 60000 }, async () => {
    let pid = 0;
    try {
      const r = await runStartup('ready', { settleWithinMs: 15000, helper }); pid = r.stubPid;
      assert.equal(r.outcome, 'RESOLVED', `a valid ready line resolves (${r.outcome}: ${r.text})`);
      const a = r.args; const flag = (f) => a.includes(f);
      assert.ok(flag('--store') && flag('--dataset-id') && flag('--port'), `always: --store, --dataset-id, --port (got ${a.join(' ')})`);
      if (helper === 'startExecutorOnCopy') { assert.ok(flag('--promote-epoch'), `a COPY must be started with --promote-epoch, or the executor refuses to serve it (got ${a.join(' ')})`); assert.ok(!flag('--create'), 'and never with --create'); }
      else { assert.ok(!flag('--promote-epoch'), `the plain helper must NOT promote an epoch (got ${a.join(' ')})`); assert.ok(!flag('--create'), 'create is off unless asked for'); }
    } finally { if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
  });
}
