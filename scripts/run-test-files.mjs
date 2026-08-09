#!/usr/bin/env node
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import {
  appendVerdict, ledgerScope, newRunId,
} from './verdict-ledger.mjs';

const files = process.argv.slice(2);
const startedAt = Date.now();
// #746 — the failing set, taken from each child's own exit code. This is better
// ground truth than anything downstream: suite-watch currently reverse-engineers
// the same list with a `location: '…'` regex over TAP, which depends on the
// reporter's formatting. Here the file and its verdict are both in hand.
const failedFiles = [];
const requested = Number(process.env.RUN_TESTS_CONCURRENCY);
const workers = Number.isInteger(requested) && requested > 0
  ? requested
  : Math.max(2, Math.min(os.availableParallelism(), 8));
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
  let commit = null;
  try {
    commit = String(execFileSync('git', ['rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] })).trim();
  } catch { /* fixture repos are not git checkouts */ }
  appendVerdict({
    at: new Date().toISOString(),
    runId: process.env.RUN_TESTS_RUN_ID || newRunId(),
    parentRunId: process.env.RUN_TESTS_PARENT_RUN_ID || null,
    scope,
    verdict: failed || totals.fail > 0 ? 'red' : 'green',
    repo: process.cwd(),
    commit,
    fileCount: files.length,
    // Deduped: a spawn failure fires 'error' AND 'close', so a file can be
    // recorded twice and inflate its own red count in the summary.
    failed: [...new Set(failedFiles)].sort(),
    totals: { ...totals },
    durationMs: Date.now() - startedAt,
  });
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
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', file], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    // Node's test reporter writes TAP to stdout. Keep other diagnostics visible
    // without allowing them to become another TAP summary.
    child.stderr.on('data', (chunk) => { process.stderr.write(chunk); });
    child.on('error', () => { failed = true; failedFiles.push(file); });
    child.on('close', (code) => {
      if (code !== 0) { failed = true; failedFiles.push(file); }
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
