/**
 * #730 item 3 — THE RUN MUST FAIL LOUDLY ON A HANG.
 *
 * The card has said this since 2026-08-07, in its own words:
 *
 *   "A test running 6h40m must be killed and reported, not left holding a
 *    socket. `--test-timeout` bounds a single test; it did not bound the run
 *    that hung — the hang was a child process holding a port, which is a
 *    different failure than a slow test. THE MECHANISM MUST SIT ON THE RUN,
 *    NOT ON THE TEST."
 *
 * ⇒ That framing was verified against a live 31-hour specimen on 2026-08-20:
 * the test process was pinned AFTER its tests had finished, by the stdio
 * handles of an abandoned child. No per-test timeout can reach that, because
 * there is no test still running to time out.
 *
 * ⛔ THE GAP, demonstrated by the suite's OWN existing test: `#735 a later fast
 * file is visible while an earlier file hangs` plants a hanging file and then
 * calls `stopTree(child)` — THE TEST HAS TO KILL THE RUNNER, because the runner
 * would wait forever. That kill is the missing feature, written by hand, in the
 * test that needed it.
 *
 * ── WHY A BOUND IS SAFE HERE ────────────────────────────────────────────────
 * Measured 2026-08-20 across 195 files under the runner's own 8 workers:
 * p50 1.4s · p90 8.6s · p99 38.6s · max 48.2s (commons-entrance). A default of
 * 300s is >6× the slowest observed file, so it cannot fail honest work at
 * today's distribution — and it is overridable per run.
 *
 * ⭐ The kill targets the process GROUP, not the pid. #736's lesson: a bare pid
 * leaves the children — and the children are the servers holding the ports.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE_RUNNER = path.join(ROOT, 'scripts', 'run-test-files.mjs');

/**
 * ⚠️ The inner runner must NOT inherit this process's test context, or node
 * refuses to run files ("run() is being called recursively") and the fixture
 * silently produces no tests — which reads as "the file didn't run" rather than
 * "the harness lied". Same guard `run-tests-helper.test.mjs` already carries.
 */
function cleanEnv() {
  const env = { ...process.env, SCRUM_VERDICT_LEDGER: path.join(os.tmpdir(), `ledger730-${process.pid}.jsonl`) };
  for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST')) delete env[k];
  delete env.NODE_OPTIONS;
  return env;
}

/** Run the file-runner directly and collect everything it says. */
function runRunner(files, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [FILE_RUNNER, ...files], {
      cwd: ROOT,
      env: { ...cleanEnv(), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    // A generous outer bound so THIS test cannot itself hang forever if the
    // feature is missing — but long enough that a working bound reports first.
    // ⚠️ `child.killed` is set by child.kill() only — a group kill via
    // process.kill(-pid) leaves it FALSE, so the flag would have reported "the
    // runner exited on its own" for a runner this test had just killed. Track
    // it explicitly. (It caught me: the first run reported a passing guard
    // assertion for a runner that hung.)
    let guardFired = false;
    const guard = setTimeout(() => {
      guardFired = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, 30_000);
    child.on('close', (code) => { clearTimeout(guard); resolve({ code, out, killedByGuard: guardFired }); });
  });
}

const fixtureDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `rt730-${tag}-`));

/**
 * ⭐ THE HANGING FIXTURE. `setInterval` keeps the loop alive with no work left —
 * the same shape as an abandoned child's stdio handle, which is what the real
 * defect looks like from the runner's side.
 */
const HANGS = 'import { test } from "node:test";\n'
  + 'test("hangs forever", () => new Promise(() => { setInterval(() => {}, 1000); }));\n';
const FAST = 'import { test } from "node:test"; test("FAST_OK", () => {});\n';

test('#730 the runner BOUNDS a hanging file, reports it, and exits nonzero', async () => {
  const dir = fixtureDir('hang');
  const hang = path.join(dir, 'a-hang.test.mjs');
  const fast = path.join(dir, 'b-fast.test.mjs');
  fs.writeFileSync(hang, HANGS);
  fs.writeFileSync(fast, FAST);

  const { code, out, killedByGuard } = await runRunner([hang, fast], { RUN_TESTS_FILE_TIMEOUT_MS: '2500' });

  // ⭐⭐⭐ THE CORE PROPERTY: the runner RETURNED ON ITS OWN. Everything else is
  // detail. Today this is false — the runner waits forever and the outer guard
  // has to kill it, which is exactly what the #735 test does by hand.
  assert.equal(killedByGuard, false,
    'the runner had to be killed by this test\'s own guard — it did not bound the hang itself, '
    + 'which is #730 item 3 and the whole point');

  assert.notEqual(code, 0, 'a run containing a hung file must not report success');

  assert.match(out, /a-hang\.test\.mjs/,
    `the hung file must be NAMED, or a reader cannot act on the verdict:\n${out.slice(0, 800)}`);
  assert.match(out, /hung|timed out|exceeded/i,
    `the verdict must say HUNG, distinctly from an ordinary failure:\n${out.slice(0, 800)}`);

  // The other file still ran: a bound that aborts the whole run trades one
  // outage for another.
  assert.match(out, /FAST_OK/, `the non-hanging file must still complete:\n${out.slice(0, 800)}`);
});

/**
 * ⛔ THE DISCRIMINATING CONTROL. A bound that fires on everything is not a
 * bound, it is an outage — and it would pass the test above just as well.
 */
test('#730 a slow-but-finishing file is NOT reported as hung', async () => {
  const dir = fixtureDir('slow');
  const slow = path.join(dir, 'slow.test.mjs');
  fs.writeFileSync(slow,
    'import { test } from "node:test";\n'
    + 'test("SLOW_BUT_FINISHES", async () => { await new Promise((r) => setTimeout(r, 1200)); });\n');

  const { code, out, killedByGuard } = await runRunner([slow], { RUN_TESTS_FILE_TIMEOUT_MS: '15000' });

  assert.equal(killedByGuard, false, 'the runner should have exited on its own');
  assert.match(out, /SLOW_BUT_FINISHES/, `the slow file must run to completion:\n${out.slice(0, 500)}`);
  assert.doesNotMatch(out, /hung/i,
    `a file that finished inside its bound must NOT be called hung:\n${out.slice(0, 500)}`);
  assert.equal(code, 0, 'a slow but passing run is a PASSING run');
});
