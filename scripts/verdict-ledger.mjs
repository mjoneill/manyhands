/**
 * #746 — the verdict ledger: an append-only record of what the suite said the
 * FIRST time, before anyone triaged it.
 *
 * WHY THIS EXISTS. The suite watch detects flakes correctly, classifies them
 * correctly, logs one line, and tells nobody — by design, because alarming on
 * every parallel-load blip destroyed the alarm's credibility (#670). So a file
 * that flaked every morning would be correctly detected and never mentioned.
 * Three instances on 2026-08-09 alone (mcp.test.mjs at 13:25Z; #291/#303-1 in
 * commons-e2e twice) and all three are known only because a seat happened to be
 * watching for something else.
 *
 * ⚠️ THE REASON IT CANNOT LIVE IN THE TRIAGE. Measured over one morning:
 * "a green rerun actively destroys the evidence." The standard response to a
 * suspected flake — run it again — is the thing that removes the record. Red at
 * 09:17, isolation green at 09:18, full greens at 09:19 and 09:21, and the only
 * surviving trace of the red was a human typing it into a card by hand.
 *
 * ⇒ So this records VERDICTS, not flakes. At write time you cannot know a red is
 *   a flake — that classification needs a later green, which is to say it is
 *   retrospective by nature. Anything that tries to decide at write time either
 *   waits for the rerun (losing every red nobody reruns) or guesses. Record what
 *   happened; derive flakiness later from a record that exists.
 *
 * APPEND-ONLY, NEVER ANNOTATED. Review proposed appending the red and then
 * annotating that event with the triage result. Same information, but annotation
 * is a mutation: a process that dies mid-write, or two runs interleaving, puts
 * the first observation — the only irreplaceable part — at risk. Two immutable
 * events linked by parentRunId carry the same facts with no such window.
 *
 * COVERAGE BOUNDARY, stated rather than assumed. This hooks the runner, so it
 * sees `npm test`, `npm run test:server`, and the watcher. A bare
 * `node --test tests/*.test.mjs` bypasses it entirely. That is a known,
 * written-down limit — which is a different object from an assumed-complete one.
 * It is why the reader says "recorded runs" and never "runs".
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Outside the repo tree, always. The watcher runs the suite in a temp clone and
 * deletes it on the way out (`cleanup()` in suite-watch.mjs), so a repo-relative
 * ledger would silently record nothing for the one run that happens unattended —
 * failing precisely where no human is present to notice the absence.
 */
export function ledgerPath() {
  return process.env.SCRUM_VERDICT_LEDGER
    || path.join(os.homedir(), '.claude', 'scrum-verdict-ledger.jsonl');
}

/**
 * Opt-IN. `run-tests.sh` sets this on the full-suite path; the watcher sets it
 * for the isolation rerun. Everything else — every subset, every fixture run
 * inside our own tests — writes nothing because it never asked to.
 */
export function ledgerScope() {
  return process.env.RUN_TESTS_LEDGER || null;
}

/**
 * #746 — the tree the verdict is ABOUT, sampled at a boundary.
 *
 * Sampled at BOTH ends by the runner, not once. A one-boundary check declares a
 * mid-run mutation clean: a seat edited this repo continuously across an
 * eighteen-minute window while another ran a seventy-second suite inside it, and
 * a start-only check would have called that result attributable. The steward who
 * proposed the weaker check supplied the case against it.
 *
 * ⚠️ `null` means "could not tell" and is never the same as clean. An unknown
 * reported as clean is the fail-open shape that #745 spent two review rounds on.
 */
export function treeState(cwd = process.cwd()) {
  try {
    const git = (args) => String(execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })).trim();
    return { commit: git(['rev-parse', '--short', 'HEAD']), dirty: git(['status', '--porcelain']).length > 0 };
  } catch {
    return { commit: null, dirty: null };
  }
}

/**
 * A verdict is attributable to an exact tree only if it did not move under the
 * run and was clean at both ends. Everything else is still recorded — it is just
 * never mixed into the clean denominator.
 */
export function isAttributable(entry) {
  return Boolean(entry.startCommit)
    && entry.startCommit === entry.endCommit
    && entry.startDirty === false
    && entry.endDirty === false;
}

export function newRunId() {
  return `${Date.now().toString(36)}-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * One line, one run. Appended with a single write: O_APPEND on POSIX makes a
 * lone small write atomic, so two seats running suites at once interleave lines
 * rather than corrupting each other's.
 *
 * ⚠️ Never throws. A ledger that can fail a test run would be a worse defect
 * than the silence it replaces — the suite's verdict must not depend on whether
 * a home directory happened to be writable.
 */
export function appendVerdict(entry) {
  try {
    const file = ledgerPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
    return true;
  } catch {
    return false;
  }
}

export function readVerdicts(file = ledgerPath()) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return raw.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

/**
 * Per-file red counts over recorded runs.
 *
 * ⚠️ The denominator is "recorded runs", and the reader must say so. A bare
 * "2 of 47 runs" invites the reading that 47 runs happened; on the day this was
 * written that would have been wrong by most of them, since the raw
 * `node --test` path is not instrumented. This is the same defect as reporting a
 * subset-green as a suite-green — a true number about a smaller world than the
 * reader assumes.
 */
export function summarize(entries) {
  const all = entries.filter((e) => e.scope === 'full');
  // Counted over ATTRIBUTABLE runs only. A dirty-tree verdict and a clean-tree
  // verdict are different objects; averaging them yields a number describing
  // neither, and the dirty ones describe a state that never shipped.
  const runs = all.filter(isAttributable);
  const reds = new Map();
  for (const run of runs) {
    for (const file of run.failed || []) {
      reds.set(file, (reds.get(file) || 0) + 1);
    }
  }
  return {
    recordedRuns: runs.length,
    unattributableRuns: all.length - runs.length,
    redRuns: runs.filter((r) => r.verdict === 'red').length,
    files: [...reds.entries()]
      .map(([file, count]) => ({ file, count, ofRecordedRuns: runs.length }))
      .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file)),
  };
}
