/**
 * #670 — the verdict pipeline's own controls.
 *
 * A test of a rail needs a positive control (the morning's lesson, applied
 * one level up): a runner that always exits zero is indistinguishable from a
 * green suite until it swallows a red one. So: deliberate-fail fixture must
 * produce nonzero; a green subset must produce zero WITH the exclusion
 * banner; the banner is what makes a subset-green unreportable as a green.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = path.join(ROOT, 'scripts', 'run-tests.sh');
const FILE_RUNNER = path.join(ROOT, 'scripts', 'run-test-files.mjs');
const LEDGER = path.join(ROOT, 'scripts', 'verdict-ledger.mjs');

// #746 — every fixture run in this file goes to a scratch ledger, never the
// real one. This file's whole job is running the helper against DELIBERATELY RED
// fixtures, and one of its tests invokes it with NO ARGS — a full run by the
// pipeline's own definition, which is exactly what opts a run into recording.
// Without this redirect the suite's own harness would file `deliberate-red` and
// `only.test.mjs` as failing files in the live ledger every time it ran, and the
// first thing the flake counter ever said would be a libel of a file doing its
// job. Set at the ENV level so it covers every invocation here, including ones
// nobody has written yet.
const SCRATCH_LEDGER = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger670-')), 'ledger.jsonl');

// The inner `node --test` must not inherit the OUTER runner's context, or it
// reports to our runner instead of exiting on its own verdict — the harness
// itself would mask the exit code, which is this card's entire subject.
function cleanEnv() {
  const env = { ...process.env, SCRUM_VERDICT_LEDGER: SCRATCH_LEDGER };
  for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST')) delete env[k];
  delete env.NODE_OPTIONS;
  return env;
}

async function helper(...args) {
  try {
    const { stdout } = await run('sh', [HELPER, ...args], { env: cleanEnv() });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.code, out: String(e.stdout) + String(e.stderr) };
  }
}

async function waitFor(check, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

// #998 — SIGTERM FIRST, then SIGKILL. This is not politeness; it is the only
// way the runner can reap its own children.
//
// The helper spawns each test file `detached`, so every file is its own
// process-group leader. Our `kill(-child.pid)` reaches the helper's group and
// CANNOT reach theirs — only the runner knows those pgids. SIGKILL is
// unhandleable, so a straight SIGKILL here left every file's group orphaned to
// pid 1, forever, once per run. Measured 2026-08-23: 11 such groups alive,
// oldest 7h40m, while this file's tests reported 8/8 green.
//
// SIGTERM gives run-test-files.mjs its one chance to reap. The SIGKILL below is
// the backstop for a runner that ignores or outlives the grace period.
async function stopTree(child, graceMs = 750) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && child.exitCode === null && !child.killed) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (child.exitCode !== null) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
}

function summaryValues(out, name) {
  return [...out.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))].map((match) => Number(match[1]));
}

function copyHelper(dir) {
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(HELPER, path.join(dir, 'scripts', 'run-tests.sh'));
  if (fs.existsSync(FILE_RUNNER)) fs.copyFileSync(FILE_RUNNER, path.join(dir, 'scripts', 'run-test-files.mjs'));
  // run-test-files.mjs imports the ledger; a fixture universe missing it would
  // fail to start the runner at all, which reads as "the pipeline is broken"
  // rather than "the fixture is incomplete".
  if (fs.existsSync(LEDGER)) fs.copyFileSync(LEDGER, path.join(dir, 'scripts', 'verdict-ledger.mjs'));
}

test('positive control: a deliberately failing fixture exits nonzero and shows the failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt670-'));
  const bad = path.join(dir, 'deliberate-red.test.mjs');
  fs.writeFileSync(bad, `
    import { test } from 'node:test';
    import assert from 'node:assert/strict';
    test('deliberately red', () => { assert.equal(1, 2, 'the control failure'); });
  `);
  const r = await helper(bad);
  assert.notEqual(r.code, 0, 'a red fixture must produce a nonzero exit');
  assert.match(r.out, /not ok/, 'the failure is shown, not just counted');
  assert.match(r.out, /SUBSET/, 'a named file is a subset and says so');
});

test('a green subset exits zero but carries the exclusion banner', async () => {
  const r = await helper('tests/cards-query.test.mjs');
  assert.equal(r.code, 0, `known-green subset should pass: ${r.out.slice(0, 300)}`);
  assert.match(r.out, /SUBSET: 1 of \d+ files — NOT a full-suite verdict/,
    'the banner names the narrowing');
  assert.match(r.out, /subset green ≠ suite green/,
    'a green subset explicitly refuses to be read as a suite verdict');
});

test('the no-args invocation declares itself the full suite', async () => {
  // Not running the whole suite inside a suite (recursion, minutes); assert the
  // declaration logic only, via a dry parse of the helper's banner on a
  // single-file "full" universe: point it at a temp repo shaped like ours.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt670full-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  copyHelper(dir);
  fs.writeFileSync(path.join(dir, 'tests', 'only.test.mjs'), `
    import { test } from 'node:test';
    test('green', () => {});
  `);
  const { stdout } = await run('sh', [path.join(dir, 'scripts', 'run-tests.sh')], { env: cleanEnv() });
  assert.match(stdout, /FULL SUITE \(1 files\)/, 'no-args = full suite, declared');
  assert.doesNotMatch(stdout, /SUBSET/, 'a full run carries no subset banner');
});

test('#735 multiple files produce one combined TAP summary', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt735-summary-'));
  const first = path.join(dir, 'a-two.test.mjs');
  const second = path.join(dir, 'b-one.test.mjs');
  fs.writeFileSync(first, `
    import { test } from 'node:test';
    test('a one', () => {});
    test('a two', () => {});
  `);
  fs.writeFileSync(second, 'import { test } from "node:test"; test("b one", () => {});\n');

  const result = await helper(first, second);
  assert.equal(result.code, 0, result.out);
  assert.deepEqual(summaryValues(result.out, 'tests'), [3], `one combined tests total required:\n${result.out}`);
  assert.deepEqual(summaryValues(result.out, 'pass'), [3], `one combined pass total required:\n${result.out}`);
  assert.deepEqual(summaryValues(result.out, 'fail'), [0], `one combined fail total required:\n${result.out}`);
});

test('#735 aggregate failure retains its file location and one verdict', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt735-failure-'));
  const failing = path.join(dir, 'a-failing.test.mjs');
  const passing = path.join(dir, 'b-passing.test.mjs');
  fs.writeFileSync(failing, `
    import assert from 'node:assert/strict';
    import { test } from 'node:test';
    test('intentional failure', () => assert.equal(1, 2));
  `);
  fs.writeFileSync(passing, 'import { test } from "node:test"; test("later pass", () => {});\n');

  const result = await helper(failing, passing);
  assert.notEqual(result.code, 0, 'a failure in any completed file is the aggregate verdict');
  assert.match(result.out, new RegExp(`location: '.*${path.basename(failing)}:`),
    `the watcher needs the failing file location:\n${result.out}`);
  assert.deepEqual(summaryValues(result.out, 'tests'), [2], `one aggregate verdict required:\n${result.out}`);
  assert.deepEqual(summaryValues(result.out, 'pass'), [1], `combined passing total required:\n${result.out}`);
  assert.deepEqual(summaryValues(result.out, 'fail'), [1], `combined failing total required:\n${result.out}`);
});

// ── #735 — the runner must EMIT as it goes, not only at the end ───────────
//
// The 2026-08-08 09:45Z suite watch fired `RED (summary unparsed)` and the log
// held no diagnostics. The run had produced 1,555 lines of perfectly good TAP;
// they were thrown away. `run-tests.sh` buffered everything into a mktemp file
// and printed greps of it only AFTER `node --test` returned, so a run killed by
// the watcher's deadline emitted nothing at all — and the alarm reported the
// blankness as "unparsed", which reads as "the output was garbled" and sends
// the reader hunting a broken parser instead of the hang.
//
// Measured before the fix: killed run → 0 bytes captured, 158,338 bytes of real
// TAP left in the temp file nobody reads.
//
test('#735 a later fast file is visible while an earlier file hangs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt735-'));
  fs.writeFileSync(path.join(dir, 'a-hang.test.mjs'),
    'import { test } from "node:test";\n'
    + 'test("hangs forever", () => new Promise(() => { setInterval(() => {}, 1000); }));\n');
  fs.writeFileSync(path.join(dir, 'b-fast.test.mjs'),
    'import { test } from "node:test"; test("LAYER_2_FAST_COMPLETE", () => {});\n');

  const child = spawn('sh', [HELPER, path.join(dir, 'a-hang.test.mjs'), path.join(dir, 'b-fast.test.mjs')],
    { env: { ...cleanEnv(), RUN_TESTS_CONCURRENCY: '2' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });

  let seen = '';
  child.stdout.on('data', (d) => { seen += d.toString(); });
  child.stderr.on('data', (d) => { seen += d.toString(); });

  await new Promise((r) => setTimeout(r, 3000));
  const streamedBeforeKill = seen;
  const runningBeforeKill = child.exitCode === null && !child.killed;

  await stopTree(child);
  await new Promise((r) => setTimeout(r, 500));

  assert.match(streamedBeforeKill, /LAYER_2_FAST_COMPLETE/,
    'a later completed file must be visible before the earlier hanging file is killed; got '
    + `${Buffer.byteLength(streamedBeforeKill)} bytes: ${JSON.stringify(streamedBeforeKill.slice(0, 200))}`);
  assert.match(streamedBeforeKill, /# file: .*b-fast\.test\.mjs complete/,
    `progress must name the completed later file:\n${streamedBeforeKill}`);

  // Anti-vacuity: prove the hang was real, i.e. this run genuinely did not
  // finish. If it had completed, "output was emitted" would be trivially true
  // and would say nothing about streaming.
  assert.ok(runningBeforeKill,
    'the run must NOT have completed — otherwise this asserts nothing about streaming');
});

test('#735 the layer-2 probe observes early output from a fast control', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt735-probe-'));
  const fast = path.join(dir, 'fast-control.test.mjs');
  fs.writeFileSync(fast,
    'import { test } from "node:test"; test("PROBE_FAST_CONTROL", () => {});\n');

  const child = spawn('sh', [HELPER, fast], {
    env: cleanEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let seen = '';
  child.stdout.on('data', (chunk) => { seen += chunk; });
  child.stderr.on('data', (chunk) => { seen += chunk; });
  try {
    await waitFor(() => /PROBE_FAST_CONTROL/.test(seen), `the output probe saw no fast control:\n${seen}`);
  } finally {
    await stopTree(child);
  }
});

test('#735 file execution is concurrently greater than one and bounded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt735-concurrency-'));
  const gate = path.join(dir, 'release');
  const started = (name) => path.join(dir, `${name}.started`);
  for (const name of ['a', 'b', 'c']) {
    fs.writeFileSync(path.join(dir, `${name}.test.mjs`), `
      import fs from 'node:fs';
      import { test } from 'node:test';
      const gate = ${JSON.stringify(gate)};
      const started = ${JSON.stringify(started(name))};
      test('${name} blocks at the concurrency gate', async () => {
        fs.writeFileSync(started, 'started');
        while (!fs.existsSync(gate)) await new Promise((resolve) => setTimeout(resolve, 20));
      });
    `);
  }

  const child = spawn('sh', [HELPER,
    path.join(dir, 'a.test.mjs'), path.join(dir, 'b.test.mjs'), path.join(dir, 'c.test.mjs')], {
    env: { ...cleanEnv(), RUN_TESTS_CONCURRENCY: '2' }, detached: true, stdio: 'ignore',
  });
  try {
    await waitFor(() => fs.existsSync(started('a')) && fs.existsSync(started('b')),
      'two independent files must start before the gate opens');
    assert.equal(fs.existsSync(started('c')), false,
      'the third file must wait while the bounded two-worker pool is full');
    fs.writeFileSync(gate, 'release');
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0, 'the released bounded run should finish green');
    assert.equal(fs.existsSync(started('c')), true, 'the queued file must run after capacity opens');
  } finally {
    await stopTree(child);
  }
});
