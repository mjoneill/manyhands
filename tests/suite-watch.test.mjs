/**
 * #670 half 2 — controls for the suite subscription.
 *
 * Exercised whole against fixture repos (the stub-harness rule): a green
 * universe is silent and clears state; a red universe posts once (DRYRUN);
 * the same red is muted inside the cooldown; a NEW failing file is a new
 * signature and fires through the mute. Sandboxed state + repo per test —
 * a positive control for an alarm must never touch the live one.
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
const WATCH = path.join(ROOT, 'scripts', 'suite-watch.mjs');

// #746 — fixture universes here are deliberately red; their verdicts belong in a
// scratch ledger, never the live one. Same reasoning as run-tests-helper: a
// positive control for an alarm must never touch the real instrument, and that
// now includes the record as well as the state file.
const SCRATCH_LEDGER = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-sw-')), 'ledger.jsonl');

/**
 * #746 — the artifact directory is the THIRD live surface these fixtures can
 * reach, after the state file and the ledger. It defaults ON in the watcher
 * (opt-in retention would ship the very hole this fixes), so every deliberately
 * red fixture universe here writes real TAP somewhere.
 *
 * ⚠️ Caught by the change that introduced it: the first run of these tests wrote
 * ELEVEN run directories into ~/.claude/scrum-suite-watch-artifacts. The rule
 * was already on this file — "a positive control for an alarm must never touch
 * the real instrument, and that now includes the record as well as the state
 * file" — and adding a new record surface did not carry it across.
 */
const SCRATCH_ARTIFACTS = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-sw-'));

function cleanEnv(extra) {
  const env = {
    ...process.env,
    SCRUM_VERDICT_LEDGER: SCRATCH_LEDGER,
    SUITE_WATCH_ARTIFACTS: SCRATCH_ARTIFACTS,
    ...extra,
  };
  for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST')) delete env[k];
  delete env.NODE_OPTIONS;
  return env;
}

function makeUniverse() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw670-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'run-tests.sh'), path.join(dir, 'scripts', 'run-tests.sh'));
  const fileRunner = path.join(ROOT, 'scripts', 'run-test-files.mjs');
  if (fs.existsSync(fileRunner)) fs.copyFileSync(fileRunner, path.join(dir, 'scripts', 'run-test-files.mjs'));
  // The runner imports the ledger — a universe without it cannot start.
  const ledger = path.join(ROOT, 'scripts', 'verdict-ledger.mjs');
  if (fs.existsSync(ledger)) fs.copyFileSync(ledger, path.join(dir, 'scripts', 'verdict-ledger.mjs'));
  fs.chmodSync(path.join(dir, 'scripts', 'run-tests.sh'), 0o755);
  fs.writeFileSync(path.join(dir, 'tests', 'green.test.mjs'),
    'import { test } from "node:test"; test("g", () => {});\n');
  return { dir, state: path.join(dir, 'watch.state') };
}

function goRed(dir, name = 'red.test.mjs') {
  fs.writeFileSync(path.join(dir, 'tests', name),
    'import { test } from "node:test"; import a from "node:assert/strict"; test("r", () => a.equal(1, 2));\n');
}

async function tick({ dir, state }, extra = {}) {
  // NO_CLONE: fixture universes aren't git repos; the clone isolation is
  // covered by the live deployment, the logic under test here is the alarm's.
  const { stdout } = await run(process.execPath, [WATCH], {
    env: cleanEnv({
      SUITE_WATCH_REPO: dir,
      SUITE_WATCH_STATE: state,
      SUITE_WATCH_DRYRUN: '1',
      SUITE_WATCH_NO_CLONE: '1',
      ...extra,
    }),
  });
  return stdout;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(check, message, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

function stop(pid) {
  try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ }
}

const posted = (out) => /DRYRUN would post/.test(out);

test('green universe: silent, and state is cleared', async () => {
  const u = makeUniverse();
  const out = await tick(u);
  assert.equal(posted(out), false, 'green must not post');
  assert.match(out, /suite green — silent/);
  assert.deepEqual(JSON.parse(fs.readFileSync(u.state, 'utf8')).sigTimes, {});
});

/**
 * #746 — CAPTURED IS NOT OBSERVABLE, and the unattended path is the one that
 * matters. The runner writes its ledger warning to stderr; this process
 * concatenates it into `out` and, on a green run, prints nothing but
 * `suite green — silent`. So the warning existed, was read into memory, and was
 * discarded — on the exact run where nobody is watching a terminal.
 *
 * The green case is the one under test on purpose: a red run prints its output
 * anyway, so a warning would surface there by accident rather than by design.
 */
test('#746 a failed ledger write is re-emitted into the watch log on a GREEN run', async () => {
  const u = makeUniverse();
  const blocked = path.join(u.dir, 'not-a-dir');
  fs.writeFileSync(blocked, 'a file where a directory would be needed');

  const out = await tick(u, { SCRUM_VERDICT_LEDGER: path.join(blocked, 'ledger.jsonl') });

  assert.match(out, /suite green — silent/, 'the verdict is untouched: a bad ledger is not a red suite');
  assert.equal(posted(out), false, 'and it must NOT post — a failed write must not spend the alarm\'s credibility');
  assert.match(out, /WARNING: verdict ledger write FAILED/,
    'but the watch log must carry it, or the unattended run records nothing and says nothing');
});

test('#746 ANTI-VACUITY: a healthy ledger produces no watch-log warning', async () => {
  const u = makeUniverse();
  const out = await tick(u, { SCRUM_VERDICT_LEDGER: path.join(u.dir, 'ledger.jsonl') });
  assert.match(out, /suite green — silent/);
  assert.doesNotMatch(out, /WARNING: verdict ledger/,
    'a warning that always fires cannot distinguish a failed write from a good one');
});

test('red posts once, repeat red is muted, recovery clears, next red is news again', async () => {
  const u = makeUniverse();
  goRed(u.dir);
  const first = await tick(u);
  assert.equal(posted(first), true, 'fresh red must post');
  assert.match(first, /red\.test\.mjs/, 'the post names the failing file');
  assert.equal(posted(await tick(u)), false, 'same red inside cooldown is muted');

  fs.rmSync(path.join(u.dir, 'tests', 'red.test.mjs')); // recovery
  assert.equal(posted(await tick(u)), false, 'recovery is silent');
  goRed(u.dir);
  assert.equal(posted(await tick(u)), true, 'post-recovery red is a fresh signature');
});

test('#1042 the alarm NAMES the tree it measured — a reader must not guess which of four', async () => {
  // ⛔ THE NIGHT THIS COMES FROM: this alarm posted "the FULL test suite is RED,
  // 1782 tests, 6 fail" naming four files, and two seats spent forty minutes on
  // it. One could not reproduce it and formed a specific, plausible, WRONG
  // hypothesis; the other accused a correct tool of miscounting. Neither error
  // was avoidable FROM THE MESSAGE, because it never said which of four trees it
  // ran in — and the answer (a tree twelve commits behind) turned the red from a
  // regression into a deploy-drift report.
  const u = makeUniverse();
  goRed(u.dir);
  const out = await tick(u);
  assert.equal(posted(out), true, 'precondition: a red must post, or there is no alarm to inspect');

  const alarm = out.split('\n').find((l) => /DRYRUN would post:/.test(l));
  assert.ok(alarm, `expected one dry-run alarm:\n${out}`);
  assert.ok(alarm.includes(u.dir),
    `the alarm must name the tree it measured. This room has FOUR, and the message is `
    + `the only thing a reader has. Got:\n${alarm}`);
});

test('#1042 ⛔ NEGATIVE CONTROL — an unresolvable sha SAYS SO, it does not print a bare path', async () => {
  // ⚠️ A path alone reads as though the sha were checked and matched. The
  // read-only export has no `.git` BY DESIGN, so "cannot resolve" is a NORMAL
  // state that must be stated rather than hidden — the same rule as
  // deploy-drift's UNAVAILABLE and #1029's skipped-blob disclosure: "I could not
  // find out" must never render as "there is nothing to report".
  const u = makeUniverse();          // a temp dir: no .git, no DEPLOYED-SHA
  goRed(u.dir);
  const out = await tick(u);
  const alarm = out.split('\n').find((l) => /DRYRUN would post:/.test(l));
  assert.ok(alarm, `expected one dry-run alarm:\n${out}`);
  assert.match(alarm, /UNRESOLVABLE/,
    `with neither .git nor DEPLOYED-SHA the alarm must SAY the sha is unresolvable, `
    + `rather than print a path that looks verified. Got:\n${alarm}`);
});

test('a flake — red in the full run, green in isolation — is logged, never posted', async () => {
  // Reproduces the day's three hand-triages mechanically: the fixture fails
  // on its first execution (no marker) and passes on the isolated re-run
  // (marker present) — exactly the shape of a parallel-load flake.
  const u = makeUniverse();
  fs.writeFileSync(path.join(u.dir, 'tests', 'flaky.test.mjs'), `
    import fs from 'node:fs';
    import { test } from 'node:test';
    import assert from 'node:assert/strict';
    const marker = new URL('./flake.marker', import.meta.url);
    test('flaky once', () => {
      if (!fs.existsSync(marker)) { fs.writeFileSync(marker, 'x'); assert.fail('first-run flake'); }
    });
  `);
  const out = await tick(u);
  assert.equal(posted(out), false, 'a flake must not alarm the room');
  assert.match(out, /did NOT survive isolation — flake, silent/, 'the flake is logged with its files');
});

test('a NEW failing file is a new signature and fires through the mute', async () => {
  const u = makeUniverse();
  goRed(u.dir, 'red-a.test.mjs');
  assert.equal(posted(await tick(u)), true, 'first red fires');
  goRed(u.dir, 'red-b.test.mjs'); // deepens: now two failing files
  const out = await tick(u);
  assert.equal(posted(out), true, 'a deeper red must fire through the standing mute');
  assert.match(out, /red-b\.test\.mjs/, 'the new file is named');
});

test('#735 watcher consumes one aggregate runner verdict for a multi-file red', async () => {
  const u = makeUniverse();
  goRed(u.dir, 'failing-file.test.mjs');

  const out = await tick(u);
  const summary = out.split('\n').find((line) => /suite RED sig=/.test(line));
  assert.ok(summary, `the watcher must emit its parsed verdict:\n${out}`);
  assert.match(summary, /sig=\[failing-file\.test\.mjs\]/,
    `the watcher signature must name the failure, never unparsed:\n${out}`);
  assert.match(summary, /# tests 2 · # pass 1 · # fail 1/,
    `the watcher must parse exactly the combined totals:\n${out}`);
  assert.equal((summary.match(/# (tests|pass|fail) \d+/g) || []).length, 3,
    `the watcher summary must contain one tests/pass/fail triple:\n${out}`);
  assert.match(out, /Failing file\(s\): failing-file\.test\.mjs/,
    `the watcher consumer output must retain its parsed files list:\n${out}`);
  assert.ok(posted(out), 'the hermetic dry-run watcher must alarm without contacting a board');
});

// ── #735 — a timeout is not "unparsed", and a deadline must TERMINATE ─────
//
// Two defects from the 2026-08-08 09:45Z incident, both measured:
//
// 1. The watch reported `sig=[unparsed]` for a run it had KILLED. Those are
//    different events with different responses — "the output was unreadable"
//    sends you to the parser, "the run never finished" sends you to the hang —
//    and collapsing them cost a morning.
//
// 2. `execFileSync(..., {timeout})` signals the SHELL. `node --test` is its
//    child, is not killed, is reparented to init, and KEEPS RUNNING. Measured
//    directly: 12s after the kill, the full 91-file runner was still going with
//    seven orphaned `node server.js` children holding ports, and the suite went
//    on to complete all 743 tests into a temp file nobody reads. The alarm
//    stopped watching; it never stopped the run.
//
// A deadline that abandons rather than terminates is not a deadline.
function makeHangingUniverse({ detached = false } = {}) {
  const u = makeUniverse();
  const pidFile = path.join(u.dir, 'descendant.pid');
  const runnerPidFile = path.join(u.dir, 'runner.pid');
  fs.writeFileSync(path.join(u.dir, 'tests', 'zz-hang.test.mjs'),
    'import { test } from "node:test";\n'
    + `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(runnerPidFile)}, String(process.pid));\n`
    + (detached
      ? `import { spawn } from "node:child_process";\n`
        + `const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });\n`
        + `child.unref(); fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));\n`
      : '')
    + 'test("hangs", () => new Promise(() => { setInterval(() => {}, 1000); }));\n');
  return { ...u, pidFile, runnerPidFile };
}

function makeMarkedHangingUniverse() {
  const u = makeUniverse();
  const passed = path.join(u.dir, 'green-finished');
  fs.writeFileSync(path.join(u.dir, 'tests', 'green.test.mjs'),
    'import fs from "node:fs"; import { test } from "node:test"; '
    + `test("g", () => fs.writeFileSync(${JSON.stringify(passed)}, "done"));\n`);
  fs.writeFileSync(path.join(u.dir, 'tests', 'zz-hang.test.mjs'),
    'import fs from "node:fs"; import { test } from "node:test";\n'
    + `const passed = ${JSON.stringify(passed)};\n`
    + 'test("hangs", async () => {\n'
    + '  while (!fs.existsSync(passed)) await new Promise((resolve) => setTimeout(resolve, 10));\n'
    + '  await new Promise((resolve) => setTimeout(resolve, 250));\n'
    + '  return new Promise(() => { setInterval(() => {}, 1000); });\n'
    + '});\n');
  return u;
}

test('#735 a killed run reports sig=[timeout], never [unparsed]', async () => {
  const u = makeHangingUniverse();
  const { stdout } = await run(process.execPath, [WATCH], {
    env: cleanEnv({
      SUITE_WATCH_REPO: u.dir, SUITE_WATCH_STATE: u.state,
      SUITE_WATCH_DRYRUN: '1', SUITE_WATCH_NO_CLONE: '1',
      SUITE_WATCH_RUN_TIMEOUT_MS: '4000',
    }),
  });

  assert.match(stdout, /sig=\[timeout\]/,
    `a run killed by the deadline must be signed as a timeout, not unparsed: ${stdout}`);
  assert.doesNotMatch(stdout, /sig=\[unparsed\]/,
    `"unparsed" claims the output was unreadable; the run simply never finished: ${stdout}`);
  assert.ok(posted(stdout), 'a timeout is still a red worth posting');
});

test('#735 timeout post names incomplete files, not completed markers', async () => {
  const u = makeMarkedHangingUniverse();
  const { stdout } = await run(process.execPath, [WATCH], {
    env: cleanEnv({
      SUITE_WATCH_REPO: u.dir, SUITE_WATCH_STATE: u.state,
      SUITE_WATCH_DRYRUN: '1', SUITE_WATCH_NO_CLONE: '1',
      SUITE_WATCH_RUN_TIMEOUT_MS: '4000',
      RUN_TESTS_CONCURRENCY: '1',
      TMPDIR: u.dir,
    }),
  });

  const runnerOut = fs.readdirSync(u.dir)
    .filter((name) => name.startsWith('run-tests.'))
    .map((name) => fs.readFileSync(path.join(u.dir, name), 'utf8'))
    .join('\n');
  const marker = runnerOut.match(/^# file: tests\/green\.test\.mjs complete$/m)?.[0];
  assert.ok(marker, `the completed-file control must arrive before the deadline:\n${runnerOut}`);
  assert.doesNotMatch(marker, /# (tests|pass|fail) \d+/,
    `a completion marker must not match the aggregate summary shape: ${marker}`);
  assert.doesNotMatch(marker, /location: '([^']*\/tests\/[^']+\.test\.mjs)/,
    `a completion marker must not match the failure-location shape: ${marker}`);
  const verdict = stdout.split('\n').find((line) => /suite RED sig=\[timeout\]/.test(line));
  assert.ok(verdict, `the timeout must retain a watcher verdict:\n${stdout}`);

  const alarm = stdout.split('\n').find((line) => /DRYRUN would post:/.test(line));
  assert.ok(alarm, `the timeout must issue one dry-run alarm:\n${stdout}`);
  assert.match(alarm, /Incomplete test file\(s\): zz-hang\.test\.mjs/,
    `the primary timeout diagnostic must be expected files minus completed markers:\n${stdout}`);
  assert.doesNotMatch(alarm, /Incomplete test file\(s\):[^\n]*green\.test\.mjs/,
    `a completed marker must not be reported as incomplete:\n${stdout}`);
  assert.doesNotMatch(alarm, /Last files seen: green\.test\.mjs/,
    `a completed marker must not be parsed as a failure location:\n${stdout}`);
  assert.doesNotMatch(alarm, /unparsed/i,
    `a timeout with a completion marker is neither incomplete parsing nor unparsed output:\n${stdout}`);
});

test('#735 the deadline terminates ordinary and detached descendants', async () => {
  const u = makeHangingUniverse({ detached: true });
  const watcher = spawn(process.execPath, [WATCH], {
    env: cleanEnv({
      SUITE_WATCH_REPO: u.dir, SUITE_WATCH_STATE: u.state,
      SUITE_WATCH_DRYRUN: '1', SUITE_WATCH_NO_CLONE: '1',
      SUITE_WATCH_RUN_TIMEOUT_MS: '1500',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  watcher.stdout.on('data', (chunk) => { output += chunk; });
  watcher.stderr.on('data', (chunk) => { output += chunk; });

  let detachedPid;
  let runnerPid;
  try {
    await waitFor(() => fs.existsSync(u.pidFile) && fs.existsSync(u.runnerPidFile), 'the detached descendant never started');
    detachedPid = Number(fs.readFileSync(u.pidFile, 'utf8'));
    runnerPid = Number(fs.readFileSync(u.runnerPidFile, 'utf8'));
    assert.ok(alive(detachedPid), 'the detached descendant must be alive before the deadline');
    assert.ok(alive(runnerPid), 'the ordinary descendant must be alive before the deadline');
    await new Promise((resolve) => watcher.on('close', resolve));
    await waitFor(() => !alive(detachedPid), `detached descendant ${detachedPid} survived:\n${output}`);
    await waitFor(() => !alive(runnerPid), `ordinary descendant ${runnerPid} survived:\n${output}`);
  } finally {
    if (runnerPid) stop(runnerPid);
    if (detachedPid) stop(detachedPid);
    if (!watcher.killed) stop(watcher.pid);
  }
});

test('#735 isolation deadlines terminate their detached descendants', async () => {
  const u = makeUniverse();
  const countFile = path.join(u.dir, 'isolation-count');
  const pidFile = path.join(u.dir, 'isolation-descendant.pid');
  const runnerPidFile = path.join(u.dir, 'isolation-runner.pid');
  fs.writeFileSync(path.join(u.dir, 'tests', 'a-red-then-hang.test.mjs'), `
    import assert from 'node:assert/strict';
    import { spawn } from 'node:child_process';
    import fs from 'node:fs';
    import { test } from 'node:test';
    const count = fs.existsSync(${JSON.stringify(countFile)}) ? Number(fs.readFileSync(${JSON.stringify(countFile)}, 'utf8')) : 0;
    fs.writeFileSync(${JSON.stringify(countFile)}, String(count + 1));
    test('red once, then hang', () => {
      if (!count) assert.fail('the full run must be red first');
      fs.writeFileSync(${JSON.stringify(runnerPidFile)}, String(process.pid));
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      child.unref();
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      return new Promise(() => { setInterval(() => {}, 1000); });
    });
  `);
  const watcher = spawn(process.execPath, [WATCH], {
    env: cleanEnv({
      SUITE_WATCH_REPO: u.dir, SUITE_WATCH_STATE: u.state,
      SUITE_WATCH_DRYRUN: '1', SUITE_WATCH_NO_CLONE: '1',
      SUITE_WATCH_ISOLATION_TIMEOUT_MS: '1000',
      PATH: `/opt/homebrew/opt/node@22/bin:${process.env.PATH}`,
    }),
    stdio: 'ignore',
  });
  let closed = false;
  watcher.on('close', () => { closed = true; });
  let detachedPid;
  let runnerPid;
  try {
    await waitFor(() => fs.existsSync(pidFile) && fs.existsSync(runnerPidFile), 'the isolation rerun never reached its detached child');
    detachedPid = Number(fs.readFileSync(pidFile, 'utf8'));
    runnerPid = Number(fs.readFileSync(runnerPidFile, 'utf8'));
    assert.ok(alive(detachedPid), 'the isolation descendant must be alive before its deadline');
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.ok(closed, 'the isolation deadline must return the watcher within its bound');
    await waitFor(() => !alive(detachedPid), `isolation descendant ${detachedPid} survived its timeout`);
  } finally {
    if (runnerPid) stop(runnerPid);
    if (detachedPid) stop(detachedPid);
    if (!closed) stop(watcher.pid);
  }
});

/**
 * #746 — THE EVIDENCE THE WATCHER DESTROYS ITSELF.
 *
 * The card's thesis was aimed at humans: "if you see a red, read the ledger
 * before you rerun it — the rerun is what destroys the evidence." On
 * 2026-08-11 the card got its long-awaited real red, and the evidence was
 * destroyed anyway — not by a human rerunning, but by the watcher:
 *
 *   09:45:05Z  suite RED sig=[css-custom-properties.test.mjs] FIRING
 *              # tests 1013 · # pass 1012 · # fail 1
 *
 * The failure SURVIVED isolation (a flake would have logged "did not survive
 * isolation — flake, silent"), so the watcher reproduced it in a clean tree —
 * the single most valuable event this instrument can produce. Then:
 *
 *   - the full run's TAP lived only in `out`, a local variable
 *   - the isolation run's TAP was captured into `isolated` and NEVER READ:
 *     only `.timedOut` and `.code` are consulted
 *   - `cleanup()` deleted the clone
 *
 * ⇒ Fourth sighting of this flake (Aug 5, 6, 9, 11) and still no assertion,
 *   no diff, no stack — because the one run that reproduced it threw its
 *   output away. The ledger keeps the verdict and the filename; neither
 *   explains occurrence five.
 *
 * These assert the artifacts EXIST and CARRY THE FAILURE TEXT. A test that
 * only checked "a file was written" would pass on an empty file, which is the
 * same defect one layer up.
 */
test('#746 a RED preserves BOTH the full-run and isolation TAP, with the failure text', async () => {
  const u = makeUniverse();
  goRed(u.dir);
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-art-'));
  const out = await tick(u, { SUITE_WATCH_ARTIFACTS: artifacts });
  assert.equal(posted(out), true, 'a red that survives isolation must post');

  const runs = fs.readdirSync(artifacts);
  assert.equal(runs.length, 1, `expected one run directory, got ${JSON.stringify(runs)}`);
  const runDir = path.join(artifacts, runs[0]);

  const full = path.join(runDir, 'full.tap');
  const iso = path.join(runDir, 'isolation.tap');
  assert.ok(fs.existsSync(full), 'the full-run TAP must be preserved');
  assert.ok(fs.existsSync(iso), 'the ISOLATION TAP must be preserved — it is the irreplaceable half');

  // ⚠️ Not "a file exists" — the file must carry the assertion that explains
  // the failure. An empty artifact is the same silence with a filename.
  const fullText = fs.readFileSync(full, 'utf8');
  const isoText = fs.readFileSync(iso, 'utf8');
  assert.match(fullText, /red\.test\.mjs/, 'full TAP must name the failing file');
  assert.match(isoText, /red\.test\.mjs/, 'isolation TAP must name the failing file');
  assert.match(isoText, /not ok|Expected values to be strictly equal|AssertionError/,
    'isolation TAP must carry the actual failure, not just a verdict');

  // The run id links the artifact to the ledger line, so a reader who finds
  // one can reach the other.
  const meta = JSON.parse(fs.readFileSync(path.join(runDir, 'meta.json'), 'utf8'));
  assert.equal(typeof meta.runId, 'string');
  assert.deepEqual(meta.files, ['red.test.mjs']);
});

test('#746 a GREEN run writes NO artifacts — evidence retention is for reds only', async () => {
  const u = makeUniverse();
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-art-'));
  await tick(u, { SUITE_WATCH_ARTIFACTS: artifacts });
  assert.deepEqual(fs.readdirSync(artifacts), [],
    'a green run must not accumulate artifacts — unbounded growth is its own defect');
});

test('#746 artifact retention is BOUNDED — oldest runs are pruned', async () => {
  const u = makeUniverse();
  goRed(u.dir);
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-art-'));
  // Pre-seed more run dirs than the cap so pruning has something to do.
  for (const n of ['aaa', 'bbb', 'ccc']) {
    fs.mkdirSync(path.join(artifacts, n));
    fs.writeFileSync(path.join(artifacts, n, 'full.tap'), 'old\n');
  }
  await tick(u, { SUITE_WATCH_ARTIFACTS: artifacts, SUITE_WATCH_ARTIFACT_KEEP: '2' });
  const runs = fs.readdirSync(artifacts);
  assert.equal(runs.length, 2, `retention cap not applied: ${JSON.stringify(runs)}`);
});
