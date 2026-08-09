/**
 * #746 — the verdict ledger's own controls.
 *
 * THE PROMISE THIS FILE EXISTS TO PIN: the first red verdict survives isolation
 * triage and every later green rerun. That is not a property of a data
 * structure, it is a property of a SEQUENCE — red, then green, then look — so
 * the central test performs the sequence rather than asserting a shape.
 *
 * The motivating measurement (2026-08-09):
 *
 *   09:17  full suite   771 tests, 1 failed — #291/#303-1
 *   09:18  isolation    commons-e2e 15/15
 *   09:19  full rerun   771/771
 *   09:21  full rerun   771/771
 *
 * ⇒ "the only surviving record of the red is this card, because I typed it here
 *   by hand." The rerun is the standard response to a suspected flake AND the
 *   thing that destroys the evidence.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAttributable, readVerdicts, summarize } from '../scripts/verdict-ledger.mjs';

const run = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A fixture repo shaped like ours: scripts/ + tests/, no git, no server. */
function universe(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger746-'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'tests'));
  for (const name of ['run-tests.sh', 'run-test-files.mjs', 'verdict-ledger.mjs']) {
    fs.copyFileSync(path.join(ROOT, 'scripts', name), path.join(dir, 'scripts', name));
  }
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, 'tests', name), body);
  }
  return { dir, ledger: path.join(dir, 'ledger.jsonl') };
}

/** Commit the fixture, so its runs are attributable and enter the denominator. */
function commitUniverse(dir) {
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args],
    { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'ledger.jsonl\n');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
}

const GREEN = 'import { test } from "node:test"; test("g", () => {});\n';
const RED = 'import { test } from "node:test"; import a from "node:assert/strict";'
  + ' test("r", () => a.equal(1, 2));\n';

function baseEnv(ledger, extra = {}) {
  const env = { ...process.env, SCRUM_VERDICT_LEDGER: ledger, ...extra };
  for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST')) delete env[k];
  delete env.NODE_OPTIONS;
  return env;
}

async function suite({ dir, ledger }, args = [], extraEnv = {}) {
  try {
    await run('sh', [path.join(dir, 'scripts', 'run-tests.sh'), ...args], { env: baseEnv(ledger, extraEnv) });
  } catch { /* red runs exit nonzero; the verdict is the ledger's business here */ }
  return readVerdicts(ledger);
}

test('#746 a full run records one verdict naming the failing file', async () => {
  const u = universe({ 'a-green.test.mjs': GREEN, 'b-red.test.mjs': RED });
  const entries = await suite(u);

  assert.equal(entries.length, 1, `exactly one event per run: ${JSON.stringify(entries)}`);
  assert.equal(entries[0].scope, 'full');
  assert.equal(entries[0].verdict, 'red');
  assert.deepEqual(entries[0].failed, ['tests/b-red.test.mjs'],
    'the failing FILE is the datum — a count alone cannot be attributed to anything');
  assert.equal(entries[0].fileCount, 2);
});

test('#746 a subset run records NOTHING — a subset is not a verdict about the suite', async () => {
  const u = universe({ 'a-green.test.mjs': GREEN, 'b-red.test.mjs': RED });
  const entries = await suite(u, ['tests/b-red.test.mjs']);
  assert.deepEqual(entries, [], 'a named-file run must not enter the trend');
});

/**
 * ⚠️ THE HOLE REVIEW NAMED BEFORE IT SHIPPED. `run-tests-helper.test.mjs` runs
 * this same script INSIDE the suite, so a full run's environment is inherited by
 * its fixture invocations — and those fixtures are deliberately red. "Don't set
 * it on the subset path" is not the same statement as "it is absent"; only an
 * explicit `unset` makes them the same.
 *
 * Without the unset this test fails and the live ledger fills with
 * `deliberate-red.test.mjs` — the counter's first act would be to libel a file
 * for doing exactly its job.
 */
test('#746 an INHERITED full-run env does not leak into a subset run', async () => {
  const u = universe({ 'a-green.test.mjs': GREEN, 'b-red.test.mjs': RED });
  const entries = await suite(u, ['tests/b-red.test.mjs'], {
    RUN_TESTS_LEDGER: 'full',            // as if a parent full run exported it
    RUN_TESTS_RUN_ID: 'parent-run-id',
  });
  assert.deepEqual(entries, [],
    'the subset path must UNSET the gate, not merely decline to set it');
});

/**
 * THE CARD'S PROMISE, performed rather than asserted. The exact sequence:
 * red, then triage-green, then green again — and the red must still be there.
 */
test('#746 a green rerun does not erase the red that preceded it', async () => {
  const u = universe({ 'a-green.test.mjs': GREEN, 'flaky.test.mjs': RED });
  commitUniverse(u.dir);

  const afterRed = await suite(u);
  assert.equal(afterRed.at(-1).verdict, 'red', 'setup: the first run must be red');

  // "Pass this time", the way a flake does on a rerun. Committed, so all three
  // runs stay attributable and the denominator means what it says.
  fs.writeFileSync(path.join(u.dir, 'tests', 'flaky.test.mjs'), GREEN);
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-aqm', 'pass'],
    { cwd: u.dir, stdio: ['ignore', 'pipe', 'ignore'] });
  await suite(u);
  const entries = await suite(u);

  assert.equal(entries.length, 3, 'three runs, three immutable events');
  assert.equal(entries[0].verdict, 'red', 'THE PROMISE: the first red is still on record');
  assert.deepEqual(entries[0].failed, ['tests/flaky.test.mjs'],
    'and it still names the file — this is the fact two green reruns destroyed');
  assert.deepEqual(entries.slice(1).map((e) => e.verdict), ['green', 'green']);

  const summary = summarize(entries);
  assert.equal(summary.recordedRuns, 3);
  assert.deepEqual(summary.files, [{ file: 'tests/flaky.test.mjs', count: 1, ofRecordedRuns: 3 }],
    'red in 1 of 3 RECORDED runs — the denominator is recorded runs, never runs');
});

test('#746 the isolation rerun appends its own event linked to the parent, never an edit', async () => {
  const u = universe({ 'a-green.test.mjs': GREEN, 'b-red.test.mjs': RED });
  const first = await suite(u, [], { RUN_TESTS_RUN_ID: 'run-one' });
  assert.equal(first.length, 1);

  // The watcher's isolation rerun: a SUBSET that opts in explicitly, because it
  // is the event that turns a red into a flake.
  try {
    await run(process.execPath, [path.join(u.dir, 'scripts', 'run-test-files.mjs'), 'tests/b-red.test.mjs'], {
      cwd: u.dir,
      env: baseEnv(u.ledger, { RUN_TESTS_LEDGER: 'isolation', RUN_TESTS_PARENT_RUN_ID: 'run-one' }),
    });
  } catch { /* still red in isolation */ }

  const entries = readVerdicts(u.ledger);
  assert.equal(entries.length, 2, 'two events — the first is never rewritten');
  assert.deepEqual(entries[0], first[0], 'the original event is byte-identical afterwards');
  assert.equal(entries[1].scope, 'isolation');
  assert.equal(entries[1].parentRunId, 'run-one', 'the link is carried, not parsed out of output');
  assert.notEqual(entries[1].runId, 'run-one', 'the child mints its own id');
});

test('#746 isolation events are excluded from the run denominator', async () => {
  // A rerun is not another run of the suite; counting it would inflate the
  // denominator with exactly the events that follow a red, making flakes look
  // rarer the more carefully they were triaged.
  const clean = { startCommit: 'aaaaaaa', startDirty: false, endCommit: 'aaaaaaa', endDirty: false };
  const entries = [
    { scope: 'full', verdict: 'red', failed: ['tests/x.test.mjs'], ...clean },
    { scope: 'isolation', verdict: 'green', failed: [], ...clean },
    { scope: 'full', verdict: 'green', failed: [], ...clean },
  ];
  const summary = summarize(entries);
  assert.equal(summary.recordedRuns, 2, 'two full runs, not three events');
  assert.deepEqual(summary.files, [{ file: 'tests/x.test.mjs', count: 1, ofRecordedRuns: 2 }]);
});

test('#746 a dirty run is recorded but kept OUT of the clean denominator', () => {
  const clean = { startCommit: 'aaaaaaa', startDirty: false, endCommit: 'aaaaaaa', endDirty: false };
  const summary = summarize([
    { scope: 'full', verdict: 'red', failed: ['tests/x.test.mjs'], ...clean },
    { scope: 'full', verdict: 'red', failed: ['tests/x.test.mjs'], ...clean, startDirty: true },
  ]);
  assert.equal(summary.recordedRuns, 1, 'only the attributable run counts');
  assert.equal(summary.unattributableRuns, 1, 'but the other is still recorded and reported');
  assert.deepEqual(summary.files, [{ file: 'tests/x.test.mjs', count: 1, ofRecordedRuns: 1 }],
    'a dirty red must not inflate a file\'s count against a clean denominator');
});

/**
 * A ledger that can fail a suite run would be a worse defect than the silence it
 * replaces: the verdict must never depend on whether a directory was writable.
 */
test('#746 an unwritable ledger does not disturb the run\'s own verdict', async () => {
  const u = universe({ 'a-green.test.mjs': GREEN });
  const blocked = path.join(u.dir, 'nope');
  fs.writeFileSync(blocked, 'I am a file, not a directory');

  const { stdout } = await run('sh', [path.join(u.dir, 'scripts', 'run-tests.sh')], {
    env: baseEnv(path.join(blocked, 'ledger.jsonl')),
  });
  assert.match(stdout, /# fail 0/, 'the green run is still green and still reports');
  assert.equal(fs.readFileSync(blocked, 'utf8'), 'I am a file, not a directory',
    'and nothing was clobbered trying');
});

/**
 * A verdict about a commit and a verdict about somebody's half-applied work are
 * different objects, and nothing in a suite's output distinguishes them. A
 * steward measuring this repo mid-build got 771 tests / 11 failures, then 779 /
 * 0, minutes apart, and was one sentence from reporting the first as a defect.
 * The count moving is what gave it away — the runner said nothing.
 */
test('#746 provenance is sampled at BOTH boundaries and gates attributability', async () => {
  const u = universe({ 'a-green.test.mjs': GREEN });
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args],
    { cwd: u.dir, stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'fixture');

  const clean = (await suite(u)).at(-1);
  assert.equal(clean.startDirty, false, 'a committed tree is clean at the start');
  assert.equal(clean.endDirty, false, 'and at the end');
  assert.equal(clean.startCommit, clean.endCommit, 'the tree did not move under the run');
  assert.ok(isAttributable(clean), 'so the verdict is attributable to an exact tree');

  fs.writeFileSync(path.join(u.dir, 'tests', 'a-green.test.mjs'), `${GREEN}// edited\n`);
  const dirty = (await suite(u)).at(-1);
  assert.equal(dirty.startDirty, true, 'uncommitted work must be recorded, not silently absorbed');
  assert.equal(dirty.startCommit, clean.startCommit,
    'the SHA alone cannot tell these two apart — which is why dirty is recorded beside it');
  assert.equal(isAttributable(dirty), false, 'and it is NOT attributable to that SHA');
});

/**
 * ⚠️ The case a start-only check gets wrong. A tree that is clean when the run
 * begins and edited while it executes yields a verdict about neither state — and
 * a one-boundary check declares it attributable. This is not hypothetical: it is
 * the window a steward's 70-second run sat inside while this repo was being
 * edited continuously for eighteen minutes.
 */
test('#746 a tree that moves DURING the run is not attributable', () => {
  assert.equal(isAttributable({
    startCommit: 'aaaaaaa', startDirty: false, endCommit: 'bbbbbbb', endDirty: false,
  }), false, 'the commit changed under the run');
  assert.equal(isAttributable({
    startCommit: 'aaaaaaa', startDirty: false, endCommit: 'aaaaaaa', endDirty: true,
  }), false, 'clean at the start is not clean — a start-only check would pass this');
  assert.equal(isAttributable({
    startCommit: 'aaaaaaa', startDirty: false, endCommit: 'aaaaaaa', endDirty: false,
  }), true, 'ANTI-VACUITY: the attributable case must still be attributable');
});

test('#746 a non-git tree is unknown, and unknown is never clean', async () => {
  const u = universe({ 'a-green.test.mjs': GREEN });
  const entry = (await suite(u)).at(-1);
  assert.equal(entry.startDirty, null, 'unknown must not be reported as clean');
  assert.equal(entry.startCommit, null);
  assert.equal(isAttributable(entry), false, 'and it cannot enter the clean denominator');
});

/**
 * ⚠️ A reader that hides the record it exists to surface. Written to gate on the
 * ATTRIBUTABLE count, `verdict-report` printed "No recorded server-suite runs
 * yet" while sitting on three real events — so the first person to read it would
 * have concluded the hook was not firing and gone looking for a bug in the
 * runner. Found by running the reader against the live ledger instead of a
 * fixture; every fixture I had used happened to contain a clean run.
 */
test('#746 the reader never reports "no runs" while holding unattributable ones', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger746-report-'));
  const ledger = path.join(dir, 'ledger.jsonl');
  fs.writeFileSync(ledger, `${JSON.stringify({
    at: '2026-08-09T14:29:57.325Z',
    scope: 'full',
    verdict: 'red',
    failed: ['tests/x.test.mjs'],
    startCommit: 'aaaaaaa',
    startDirty: true,
    endCommit: 'aaaaaaa',
    endDirty: true,
  })}\n`);

  const { stdout } = await run(process.execPath, [path.join(ROOT, 'scripts', 'verdict-report.mjs')], {
    env: { ...process.env, SCRUM_VERDICT_LEDGER: ledger },
  });
  assert.doesNotMatch(stdout, /No recorded server-suite runs yet/,
    'the ledger holds a run; saying otherwise sends the reader hunting a hook that works');
  assert.match(stdout, /1 further run\(s\) recorded but NOT counted/,
    'it must say what it has and why the count excludes it');
});

test('#746 the reader states the boundary and never says a bare "runs"', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger746-words-'));
  const ledger = path.join(dir, 'ledger.jsonl');
  const clean = { startCommit: 'aaaaaaa', startDirty: false, endCommit: 'aaaaaaa', endDirty: false };
  fs.writeFileSync(ledger, `${JSON.stringify({
    at: '2026-08-09T15:00:00.000Z', scope: 'full', verdict: 'red', failed: ['tests/x.test.mjs'], ...clean,
  })}\n`);

  const { stdout } = await run(process.execPath, [path.join(ROOT, 'scripts', 'verdict-report.mjs')], {
    env: { ...process.env, SCRUM_VERDICT_LEDGER: ledger },
  });
  assert.match(stdout, /recorded CLEAN server-suite run/,
    'the denominator must name itself — "N runs" is a claim about a bigger world than the file describes');
  assert.match(stdout, /NOT covered: bare `node --test`/,
    'the coverage boundary is stated in the output, not only on the card');
  assert.match(stdout, /red in\s+1 of 1 recorded runs/, 'and the per-file count is against that denominator');
});

test('#746 ANTI-VACUITY: the fixture universe can actually write a ledger', async () => {
  // If the universe were mis-wired — a missing script, an unresolvable import —
  // every "records nothing" assertion above would pass for the wrong reason.
  const u = universe({ 'a-green.test.mjs': GREEN });
  const entries = await suite(u);
  assert.equal(entries.length, 1, 'the positive control must produce an event');
  assert.equal(entries[0].verdict, 'green');
});
