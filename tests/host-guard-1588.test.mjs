/**
 * #1588 — the full suite's host-preservation guard (scripts/host-guard.mjs, wired into scripts/run-test-files.mjs).
 *
 * The real runner is the child; the host's load is the test seam RUN_TESTS_LOAD_PROBE (a file whose number stands in for
 * the 1-minute load average), so no row needs an actually overloaded machine. Every row points the verdict ledger at a
 * temp file, so nothing here writes the real one.
 *
 *   HG1  LAUNCH: a full suite on a host over the ceiling does NOT start: exit 75, a REFUSED line, no test file ran
 *   HG2  MID-RUN: load crossing the ceiling during the run SELF-ABORTS: exit 75, the self-aborted line (distinct wording),
 *        no final verdict summary, and no ledger verdict appended
 *   HG3  one sample over the ceiling is not enough: it takes two consecutive samples (driven deterministically, mock timers)
 *   HG4  OFF under CI, OFF for a subset (not a full suite), and OFF by RUN_TESTS_HOST_GUARD=off, which SAYS so
 *   HG5  CONTROL: under the ceiling a full suite runs to its verdict with the guard on, saying it is on and provisional
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(ROOT, 'scripts', 'run-test-files.mjs');
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function world() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hg1588-')); dirs.push(d);
  const probe = path.join(d, 'load'); const ledger = path.join(d, 'ledger.jsonl'); const marker = path.join(d, 'ran');
  const quick = path.join(d, 'quick.test.mjs');
  fs.writeFileSync(quick, `import { test } from 'node:test';\nimport fs from 'node:fs';\ntest('quick', () => { fs.appendFileSync(${JSON.stringify(marker)}, 'q\\n'); });\n`);
  // a file that runs long enough for the guard to sample, and RAISES the load half-way (the host turning hostile mid-run)
  const slow = path.join(d, 'slow.test.mjs');
  fs.writeFileSync(slow, `import { test } from 'node:test';\nimport fs from 'node:fs';\ntest('slow', async () => { fs.appendFileSync(${JSON.stringify(marker)}, 's\\n'); fs.writeFileSync(${JSON.stringify(probe)}, process.env.HG_RAISE_TO ?? '1'); await new Promise((r) => setTimeout(r, 4000)); });\n`);
  fs.writeFileSync(probe, '1');
  return { d, probe, ledger, marker, quick, slow };
}
const run = (files, env) => new Promise((resolve) => {
  const base = { ...process.env };
  for (const k of ['NODE_TEST_CONTEXT', 'CI', 'RUN_TESTS_LEDGER', 'RUN_TESTS_HOST_GUARD', 'RUN_TESTS_LOAD_CEILING', 'RUN_TESTS_LOAD_PROBE', 'RUN_TESTS_LOAD_INTERVAL_MS', 'RUN_TESTS_PIDFILE']) delete base[k];
  const p = spawn(process.execPath, [RUNNER, ...files], { cwd: ROOT, env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; p.stdout.on('data', (b) => { out += b; }); p.stderr.on('data', (b) => { err += b; });
  const timer = setTimeout(() => p.kill('SIGTERM'), 60000);
  p.on('close', (status) => { clearTimeout(timer); resolve({ status, out, err }); });
});
const full = (w, extra = {}) => ({ RUN_TESTS_LEDGER: 'full', SCRUM_VERDICT_LEDGER: w.ledger, RUN_TESTS_LOAD_PROBE: w.probe, RUN_TESTS_LOAD_CEILING: '4', RUN_TESTS_LOAD_INTERVAL_MS: '100', ...extra });
const ranAnything = (w) => fs.existsSync(w.marker);
const ledgerLines = (w) => (fs.existsSync(w.ledger) ? fs.readFileSync(w.ledger, 'utf8').split('\n').filter(Boolean).length : 0);

test('#1588 HG1 — LAUNCH: a full suite on a host over the ceiling does not start (exit 75, REFUSED, no test file ran)', async () => {
  const w = world(); fs.writeFileSync(w.probe, '9.5');
  const r = await run([w.quick], full(w));
  assert.equal(r.status, 75, `refused with EX_TEMPFAIL (got ${r.status}: ${(r.out + r.err).slice(-300)})`);
  assert.match(r.out, /# host guard: REFUSED to start: load 9\.50 is over the ceiling 4/, 'and says why, with both numbers');
  assert.equal(ranAnything(w), false, 'no test file ran');
  assert.doesNotMatch(r.out, /^# pass /m, 'and there is no verdict summary');
  assert.equal(ledgerLines(w), 0, 'and no ledger verdict');
});

test('#1588 HG2 — MID-RUN: load crossing the ceiling SELF-ABORTS (exit 75, the self-aborted line, no verdict, no ledger entry)', async () => {
  const w = world();
  const r = await run([w.slow, w.quick], full(w, { HG_RAISE_TO: '12', RUN_TESTS_CONCURRENCY: '1' }));
  assert.equal(r.status, 75, `self-aborted with EX_TEMPFAIL (got ${r.status}: ${(r.out + r.err).slice(-400)})`);
  assert.match(r.out, /# self-aborted: load crossed 12\.00 at \S+ \(ceiling 4\), rows run \d+, host-preservation guard \(#1588\)\. This run is INCOMPLETE/, 'the line names itself as the guard, distinct from a hang-kill or a duration cap');
  assert.doesNotMatch(r.out, /^# pass /m, 'no verdict summary: aborted rows are not full-suite evidence');
  assert.equal(ledgerLines(w), 0, 'and nothing is appended to the verdict ledger');
  assert.equal(fs.readFileSync(w.marker, 'utf8').includes('q'), false, 'the file queued after the abort never ran');
});

test('#1588 HG3 — it takes TWO consecutive samples over the ceiling: a lone spike, or spikes split by a quiet sample, never abort; two in a row abort once', async (t) => {
  const { startGuard } = await import('../scripts/host-guard.mjs');
  t.mock.timers.enable({ apis: ['setInterval'] });
  const cfg = { enabled: true, ceiling: 4, provisional: false, intervalMs: 100 };
  const drive = (loads) => {
    const seq = [...loads]; const aborts = [];
    const stop = startGuard(cfg, { abort: (line) => aborts.push(line), sample: () => seq.shift() ?? 1, now: () => 'T' });
    for (let i = 0; i < loads.length + 2; i++) t.mock.timers.tick(100);
    stop();
    return aborts;
  };
  assert.deepEqual(drive([12, 1, 12, 1, 12, 1]), [], 'spikes split by a quiet sample: no abort');
  assert.deepEqual(drive([1, 12]), [], 'a lone spike at the end: no abort');
  const two = drive([1, 12, 12, 12, 12]);
  assert.equal(two.length, 1, 'two consecutive samples over: it aborts, and only once');
  assert.match(two[0], /^# self-aborted: load crossed 12\.00 at T \(ceiling 4\)/);
  assert.deepEqual(drive([4, 4, 4]), [], 'AT the ceiling is not over it');
});

for (const [label, env, says] of [
  ['under CI', { CI: 'true' }, null],
  ['for a subset (not a full suite)', { RUN_TESTS_LEDGER: '' }, null],
  ['by RUN_TESTS_HOST_GUARD=off, which says so', { RUN_TESTS_HOST_GUARD: 'off' }, /# host guard: OFF \(RUN_TESTS_HOST_GUARD=off\)/],
]) {
  test(`#1588 HG4 — the guard is OFF ${label}: an overloaded probe neither refuses nor aborts`, async () => {
    const w = world(); fs.writeFileSync(w.probe, '50');
    const r = await run([w.quick], full(w, env));
    assert.equal(r.status, 0, `the run completes (got ${r.status}: ${(r.out + r.err).slice(-300)})`);
    assert.doesNotMatch(r.out, /REFUSED|self-aborted/);
    if (says) assert.match(r.out, says, 'turning it off is said aloud, never silent');
  });
}

test('#1588 HG5 CONTROL — under the ceiling a full suite runs to its verdict with the guard on, saying so and that the ceiling is provisional', async () => {
  const w = world();
  const r = await run([w.quick], full(w, { RUN_TESTS_LOAD_CEILING: '' }));
  assert.equal(r.status, 0, `(got ${r.status}: ${(r.out + r.err).slice(-300)})`);
  assert.match(r.out, /# host guard: on, load 1\.00, ceiling \d+ \(provisional: the core count, until #1487 measures it\)/);
  assert.match(r.out, /^# pass 1$/m);
  assert.equal(ranAnything(w), true);
});
