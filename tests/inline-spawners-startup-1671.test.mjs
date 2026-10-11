/**
 * #1671 — the test files that start the executor with their OWN copy of the spawn code (21 of them; `git grep -l "spawn(PY" -- tests`) share the shape #1670 fixed in the shared helpers:
 * a first stdout line that is not JSON rejects the start but leaves the spawned process running. Written BEFORE any of them is touched (RED rows), by a different hand than the fix.
 *
 * The seam: run a NAMED test file as a child (`node --test <file>`) with GRAPH_EXECUTOR_PYTHON pointing at a stub whose first stdout line is not JSON and which then stays alive. The file's own tests
 * fail (the stub is no executor); that is expected and ignored. What is checked is only what outlives the file: every stub process it started (each records its pid) must be gone a moment after the file ends.
 *
 *   F0 CONTROL   a tiny script using the FIXED shared helper (startExecutor) against the same stub leaves nothing alive: the harness can pass, and the survivor check is not vacuous
 *   F1 graph-executor.test.mjs               the base shape: start() rejects on a junk line (spawn, parse, reject; no kill)
 *   F2 graph-store-backup-1559.test.mjs      a second shape: the JSON parse runs INSIDE the stdout handler that resolves, so a junk line is an uncaught exception, not a rejection
 * Two files of 21; the other 19 are listed on #1671 and are not rowed here.
 *
 * P1-P3 (added after the fix): the three one-shot probes that stay inline on purpose each carry a 15 s timer that kills a start that never prints. A selective stub is the REAL executor for every start
 * except the probe's own (matched by a flag only that call passes), and for that one it records its pid, prints nothing and stays alive. The first such process must be gone ~19 s after it appeared.
 *   P1 copy-guard-bytes-1577 (`--create`, its only spawn)   P2 epoch-cursor-1575 (`--promote-epoch`)   P3 incarnation-1577 (`--promote-epoch`)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withOwned } from './helpers/ready-world-1644.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STUB = `#!/bin/sh
# a stand-in for the executor's python: "-c" (the import check) succeeds; any other call records its pid, prints a first line that is not JSON, and stays alive
case "$1" in -c) exit 0;; esac
echo $$ >> "$STUB_PID_FILE"
echo "this first line is not json"
while true; do sleep 1; done
`;

// the real executor for every start but the one carrying $SILENT_FLAG; that one records its pid and then prints nothing, ever
const SELECTIVE_STUB = `#!/bin/sh
case "$1" in -c) exec "$REAL_PY" "$@";; esac
for a in "$@"; do
  if [ "$a" = "$SILENT_FLAG" ]; then echo $$ >> "$STUB_PID_FILE"; while true; do sleep 1; done; fi
done
exec "$REAL_PY" "$@"
`;
const REAL_PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(ROOT, 'graph-executor', '.venv', 'bin', 'python');
// P1-P3 run the probe files against the REAL executor (all but the probe's own start), so they need a python with pyoxigraph; F0-F2 are stub-only and need none. Without it the nested file skips its own tests,
// no stub pid ever appears, and the row would wait out its bound and fail: that is an unavailable prerequisite, reported as a skip like the probe files' own.
const HAVE_REAL_PY = fs.existsSync(REAL_PY) && spawnSync(REAL_PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP_P = HAVE_REAL_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${REAL_PY}`;

/** Run `argv` (node arguments) with the stub as the executor's python. Resolves { exited, pids, survivors }; the stub processes are killed after the check. */
async function withStub(argv, { boundMs }) {
  return withOwned(async (own) => {
    const dir = own.dir('r44u-1671-');
    const stub = path.join(dir, 'python-stub'); fs.writeFileSync(stub, STUB, { mode: 0o755 });
    const pidFile = path.join(dir, 'stub.pids');
    const readPids = () => { try { return fs.readFileSync(pidFile, 'utf8').split('\n').map(Number).filter(Boolean); } catch { return []; } };
    own.adopt(async () => { for (const pid of readPids()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } });
    // NODE_TEST_CONTEXT is set by the runner that is running THIS file; inherited by a nested `node --test` it makes the child behave as a runner-child (no isolation, no real run), so it is removed
    const env = { ...process.env, GRAPH_EXECUTOR_PYTHON: stub, STUB_PID_FILE: pidFile }; delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, argv, { cwd: ROOT, env, stdio: 'ignore' });
    own.adopt(async () => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
    const exited = await Promise.race([new Promise((r) => child.once('exit', () => r(true))), sleep(boundMs).then(() => false)]);
    for (let t = 0; t < 3000 && readPids().some(alive); t += 100) await sleep(100);   // 3 s grace for a fix that kills on rejection
    const pids = readPids();
    return { exited, pids, survivors: pids.filter(alive) };
  });
}

test('F0 CONTROL: a caller of the FIXED shared helper leaves no process alive after a junk first line', { timeout: 60000 }, async () => {
  const helper = path.join(ROOT, 'tests', 'helpers', 'graph-executor-proc.mjs');
  const script = `import { startExecutor } from ${JSON.stringify(helper)}; try { await startExecutor({ store: '/nonexistent-1671', datasetId: 'x' }); } catch {} process.exit(0);`;
  const r = await withStub(['--input-type=module', '-e', script], { boundMs: 30000 });
  assert.equal(r.exited, true, 'the control script ends by itself');
  assert.ok(r.pids.length >= 1, 'CONTROL: the stub really started');
  assert.deepEqual(r.survivors, [], 'the fixed helper kills the process it started before rejecting');
});

for (const [tag, file] of [['F1', 'tests/graph-executor.test.mjs'], ['F2', 'tests/graph-store-backup-1559.test.mjs']]) {
  test(`${tag} ${file}: against an executor that prints a non-JSON first line, the file leaves no executor process running`, { timeout: 120000 }, async () => {
    const r = await withStub(['--test', path.join(ROOT, file)], { boundMs: 45000 });
    assert.ok(r.pids.length >= 1, `CONTROL: ${file} really started the stub (${r.pids.length} start(s))`);
    assert.deepEqual(r.survivors, [], `${file} started ${r.pids.length} executor process(es) and left ${r.survivors.length} running after its own start failed: ${r.survivors.join(' ')} (the file ${r.exited ? 'ended' : 'did NOT end within 45 s: the leaked process keeps it alive'})`);
    assert.equal(r.exited, true, `${file} ends by itself within 45 s against this stub`);
  });
}

/** Run a probe file under the selective stub. Resolves { appeared, aliveAfter, pid }: did a silent start appear within appearBoundMs, and was its process still alive `waitMs` after it did. */
async function silentStart(file, flag, { appearBoundMs, waitMs }) {
  return withOwned(async (own) => {
    const dir = own.dir('r44u-1671p-');
    const stub = path.join(dir, 'python-stub'); fs.writeFileSync(stub, SELECTIVE_STUB, { mode: 0o755 });
    const pidFile = path.join(dir, 'stub.pids');
    const readPids = () => { try { return fs.readFileSync(pidFile, 'utf8').split('\n').map(Number).filter(Boolean); } catch { return []; } };
    own.adopt(async () => { for (const pid of readPids()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } });
    const env = { ...process.env, GRAPH_EXECUTOR_PYTHON: stub, REAL_PY, SILENT_FLAG: flag, STUB_PID_FILE: pidFile }; delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--test', path.join(ROOT, file)], { cwd: ROOT, env, stdio: 'ignore' });
    own.adopt(async () => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
    for (let t = 0; t < appearBoundMs && readPids().length === 0; t += 100) await sleep(100);
    const pid = readPids()[0];
    if (pid === undefined) return { appeared: false };
    await sleep(waitMs);
    return { appeared: true, pid, aliveAfter: alive(pid) };
  });
}

for (const [tag, file, flag] of [['P1', 'tests/copy-guard-bytes-1577.test.mjs', '--create'], ['P2', 'tests/epoch-cursor-1575.test.mjs', '--promote-epoch'], ['P3', 'tests/incarnation-1577.test.mjs', '--promote-epoch']]) {
  test(`${tag} ${file}: a probe start that never prints is killed by the file itself (~15 s), not left running`, { timeout: 240000, skip: SKIP_P }, async () => {
    const r = await silentStart(file, flag, { appearBoundMs: 150000, waitMs: 19000 });
    assert.equal(r.appeared, true, `CONTROL: the file reached its silent-able start (${flag}) within 150 s`);
    assert.equal(r.aliveAfter, false, `${file}: the process ${r.pid} that printed nothing was still running 19 s after it started`);
  });
}
