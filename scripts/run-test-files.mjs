#!/usr/bin/env node
import os from 'node:os';
import { spawn } from 'node:child_process';
import {
  appendVerdict, ledgerPath, ledgerScope, newRunId, treeState,
} from './verdict-ledger.mjs';

const files = process.argv.slice(2);
const startedAt = Date.now();
// Sampled before a single test runs, so a tree that moves DURING the run is
// visible as startCommit !== endCommit rather than silently attributed.
const start = treeState();
// #746 — the failing set, taken from each child's own exit code. This is better
// ground truth than anything downstream: suite-watch currently reverse-engineers
// the same list with a `location: '…'` regex over TAP, which depends on the
// reporter's formatting. Here the file and its verdict are both in hand.
const failedFiles = [];
const requested = Number(process.env.RUN_TESTS_CONCURRENCY);
const workers = Number.isInteger(requested) && requested > 0
  ? requested
  : Math.max(2, Math.min(os.availableParallelism(), 8));
// #730 item 3 — per-file wall bound. 300s is >6× the slowest file ever measured
// here (48.2s, commons-entrance, under this runner's own 8 workers), so it
// cannot fail honest work at today's distribution. Override per run.
const requestedFileTimeout = Number(process.env.RUN_TESTS_FILE_TIMEOUT_MS);
const FILE_TIMEOUT_MS = Number.isFinite(requestedFileTimeout) && requestedFileTimeout > 0
  ? requestedFileTimeout
  : 300_000;
const totals = { tests: 0, pass: 0, fail: 0, suites: 0, cancelled: 0, skipped: 0, todo: 0 };
let next = 0;
let active = 0;
let failed = false;
let testNumber = 0;

function count(raw, name) {
  const matches = [...raw.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))];
  return matches.length ? Number(matches.at(-1)[1]) : 0;
}

function emitCompletedFile(file, raw) {
  for (const name of Object.keys(totals)) totals[name] += count(raw, name);

  // Each child owns a complete TAP document. Keep its test records, but hold
  // back its plan and summary so this coordinator owns the sole final verdict.
  const body = raw
    .replace(/^TAP version 13\r?\n/, '')
    .replace(/\r?\n1\.\.\d+[\s\S]*$/, '')
    .replace(/^(not )?ok \d+ -/gm, (_, not) => `${not || ''}ok ${++testNumber} -`);
  process.stdout.write(`# file: ${file} complete\n${body}`);
  if (body && !body.endsWith('\n')) process.stdout.write('\n');
}

function emitSummary() {
  process.stdout.write(`1..${totals.tests}\n`);
  process.stdout.write(`# tests ${totals.tests}\n`);
  process.stdout.write(`# suites ${totals.suites}\n`);
  process.stdout.write(`# pass ${totals.pass}\n`);
  process.stdout.write(`# fail ${totals.fail}\n`);
  process.stdout.write(`# cancelled ${totals.cancelled}\n`);
  process.stdout.write(`# skipped ${totals.skipped}\n`);
  process.stdout.write(`# todo ${totals.todo}\n`);
}

/**
 * #746 — record the FIRST verdict, here, before any triage can reach it.
 *
 * Opt-in via RUN_TESTS_LEDGER, which `run-tests.sh` sets on the full-suite path
 * and the watcher sets for its isolation rerun. The gate is opt-IN rather than
 * "full runs only" for a reason found while planning: `run-tests-helper.test.mjs`
 * invokes the helper with NO ARGS in a temp repo, which is a full run by the
 * pipeline's own definition — so a full-runs-only gate would have written
 * fixture files into the real ledger. A gate I would have called closed.
 */
function record() {
  const scope = ledgerScope();
  if (!scope) return;
  // Provenance at BOTH boundaries. A verdict about a commit and a verdict about
  // someone's half-applied work are different objects, and nothing in a suite's
  // output distinguishes them: a steward measuring this repo mid-build got 771
  // tests with 11 failures, then 779 with none, minutes apart, and was one
  // sentence from reporting the first as a defect. Sampling only at the start
  // would additionally declare a mid-run mutation clean.
  const end = treeState();
  const written = appendVerdict({
    at: new Date().toISOString(),
    runId: process.env.RUN_TESTS_RUN_ID || newRunId(),
    parentRunId: process.env.RUN_TESTS_PARENT_RUN_ID || null,
    scope,
    verdict: failed || totals.fail > 0 ? 'red' : 'green',
    repo: process.cwd(),
    startCommit: start.commit,
    startDirty: start.dirty,
    endCommit: end.commit,
    endDirty: end.dirty,
    fileCount: files.length,
    // Deduped: a spawn failure fires 'error' AND 'close', so a file can be
    // recorded twice and inflate its own red count in the summary.
    failed: [...new Set(failedFiles)].sort(),
    totals: { ...totals },
    durationMs: Date.now() - startedAt,
  });

  // ⚠️ A failed write must be LOUD without touching the verdict. The first cut
  // swallowed the boolean this already returns: no record, no diagnostic,
  // confident green — which is the exact silence #746 exists to remove, aimed by
  // the ledger at itself. stderr, so it survives the tee into a local terminal
  // and lands in the watcher's captured output on the unattended path; and
  // deliberately NOT an exit-code change, because a suite's verdict must never
  // depend on whether a home directory happened to be writable.
  if (!written) {
    process.stderr.write(
      `# WARNING: verdict ledger write FAILED — this run is NOT recorded (${ledgerPath()}).\n`
      + '# The suite verdict above is unaffected. Flake counts will under-report until this is fixed.\n',
    );
  }
}

function finish() {
  emitSummary();
  record();
  process.exitCode = failed || totals.fail > 0 ? 1 : 0;
}

function launch() {
  while (active < workers && next < files.length) {
    const file = files[next++];
    active += 1;
    // #730 item 3 — DETACHED so the file gets its OWN process group. A hung
    // file is not alone: it holds spawned servers, and a bare pid kill leaves
    // them bound to their ports (#736's lesson, and the shape of every orphan
    // this repo has measured). `-pid` takes the whole subtree.
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', file], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '';
    let hung = false;

    // #730 item 3 — BOUND THE RUN, NOT THE TEST.
    //
    // `--test-timeout` bounds a single test's execution. It cannot reach the
    // failure this repo actually suffers: a file whose tests have FINISHED and
    // whose process is pinned open by the live stdio handles of a server child
    // it never stopped. There is no running test left to time out. Measured on
    // a 31-hour specimen — see #730's forensic block.
    //
    // ⚠️ The default is deliberately far above the observed distribution
    // (2026-08-20, 195 files, 8 workers: p50 1.4s · p90 8.6s · p99 38.6s ·
    // max 48.2s), so it cannot fail honest work. A bound that fires on real
    // work is an outage, not a guard.
    const timer = setTimeout(() => {
      hung = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, FILE_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    // Node's test reporter writes TAP to stdout. Keep other diagnostics visible
    // without allowing them to become another TAP summary.
    child.stderr.on('data', (chunk) => { process.stderr.write(chunk); });
    child.on('error', () => { failed = true; failedFiles.push(file); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (hung) {
        // Named as HUNG, not merely failed. A hang and a failing assertion need
        // different responses from a reader, and the old behaviour offered
        // neither — the run simply never returned.
        failed = true;
        failedFiles.push(file);
        process.stdout.write(
          `# ⛔ HUNG: ${file} exceeded ${FILE_TIMEOUT_MS}ms and was killed with its process group.\n`
          + '#    This is NOT a failing test — the file never exited. The usual cause is a spawned\n'
          + '#    child (a test server) that was never stopped: its stdio handles keep the file\n'
          + `#    process alive after its tests finish. Raise RUN_TESTS_FILE_TIMEOUT_MS if ${FILE_TIMEOUT_MS}ms\n`
          + '#    is genuinely too short for this file.\n',
        );
      } else if (code !== 0) { failed = true; failedFiles.push(file); }
      emitCompletedFile(file, stdout);
      active -= 1;
      if (next === files.length && active === 0) finish();
      else launch();
    });
  }
}

process.stdout.write('TAP version 13\n');
if (!files.length) finish();
else launch();
