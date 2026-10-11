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
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
