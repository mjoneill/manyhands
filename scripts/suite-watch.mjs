#!/usr/bin/env node
/**
 * #670 half 2 — the suite's SUBSCRIPTION: a smoke detector for silent red.
 *
 * The 2026-08-04 finding: an invariant test fired red on 08-03 and stayed red
 * for a DAY — the rail worked and nobody read it, because the suite's alarm
 * only reaches whoever happens to run it. This gives the suite a subscription:
 * run the FULL suite on a schedule, post to the commons ONLY on red.
 *
 * Fan-pattern discipline (#664/#666/#668, inherited whole):
 *   - signature = the sorted set of failing test FILES. A standing red posts
 *     once per cooldown; a NEW failing file is a new signature and fires
 *     through the mute. Recovery to green clears all signatures.
 *   - green runs are SILENT. The subscription is for red, not for reassurance.
 *
 * Runs the suite via scripts/run-tests.sh — the toolkit's verdict pipeline —
 * so the exit code is the runner's own and the scope is always FULL.
 *
 * Env:
 *   SUITE_WATCH_REPO        default: this script's own repo (the launchd job
 *                           passes the serving tree explicitly)
 *   SUITE_WATCH_POST_URL    default http://127.0.0.1:3141/api/conversations
 *   SUITE_WATCH_STATE       default ~/.claude/scrum-suite-watch.state
 *   SUITE_WATCH_COOLDOWN_MS default 6h
 *   SUITE_WATCH_DRYRUN=1    print the would-be post instead of posting
 *   SUITE_WATCH_RUN_TIMEOUT_MS  how long the suite may run before it is killed
 *   SUITE_WATCH_ISOLATION_TIMEOUT_MS  isolation rerun deadline (default 10m)
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBoundedProcessTree } from './run-process-tree.mjs';
import { newRunId } from './verdict-ledger.mjs';

const REPO = process.env.SUITE_WATCH_REPO
  || path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const POST_URL = process.env.SUITE_WATCH_POST_URL || 'http://127.0.0.1:3141/api/conversations';

/**
 * #1042 — WHICH TREE DID THIS MEASURE?
 *
 * ⛔ THE COST, on 2026-08-24T09:49Z: this watch posted "the FULL test suite is
 * RED · 1782 tests · 6 fail" and named four files. Two seats spent forty minutes
 * on it. One could not reproduce it and formed a specific, plausible, wrong
 * hypothesis; the other accused a correct tool of miscounting. Neither error was
 * possible to avoid from the message, because the message never said which of
 * this room's FOUR trees it ran in — and the answer (a tree twelve commits
 * behind) made the red a deploy-drift report rather than a regression.
 *
 * ⭐ So the identity rides the alarm itself, unprompted. A reader must be able to
 * tell WHICH tree went red without running anything.
 *
 * ⚠️ AND IT MUST NOT LIE WHEN IT CANNOT TELL. The read-only export has no `.git`
 * BY DESIGN, so `rev-parse` fails there legitimately; DEPLOYED-SHA is the answer
 * in that tree. When neither resolves, it SAYS so rather than printing a bare
 * path that reads as though the sha were checked and matched.
 */
function treeIdentity(repo) {
  try {
    const sha = execFileSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (sha) return `${repo} @ ${sha}`;
  } catch { /* no .git — expected in the read-only export */ }
  try {
    const deployed = fs.readFileSync(path.join(repo, 'DEPLOYED-SHA'), 'utf8').trim();
    if (deployed) return `${repo} @ ${deployed.slice(0, 7)} (DEPLOYED-SHA; no .git)`;
  } catch { /* not a deployed export either */ }
  return `${repo} (sha UNRESOLVABLE — no .git and no DEPLOYED-SHA)`;
}
const STATE_FILE = process.env.SUITE_WATCH_STATE || path.join(os.homedir(), '.claude', 'scrum-suite-watch.state');
const COOLDOWN_MS = Number(process.env.SUITE_WATCH_COOLDOWN_MS ?? 6 * 3600 * 1000);
const DRYRUN = process.env.SUITE_WATCH_DRYRUN === '1';
/**
 * #746 — where a red's raw TAP is kept. Defaults ON: the failure this fixes is
 * that evidence was discarded by default, so opt-in retention would ship the
 * same hole behind a flag nobody sets. Set to '' to disable deliberately.
 */
const ARTIFACT_DIR = process.env.SUITE_WATCH_ARTIFACTS
  ?? path.join(os.homedir(), '.claude', 'scrum-suite-watch-artifacts');
const ARTIFACT_KEEP = Number(process.env.SUITE_WATCH_ARTIFACT_KEEP ?? 20);
const NO_CLONE = process.env.SUITE_WATCH_NO_CLONE === '1'; // tests: fixture repos aren't git

const now = new Date().toISOString();

/**
 * Run in an ISOLATED CLONE, never the live tree. The first live run of this
 * watch (2026-08-04) ran the suite inside the prod tree beside the running
 * server — the exact thing CLAUDE.md forbids — and drew a parallel-load flake
 * as its first "red". `git clone --no-local` copies via the pack protocol
 * (no hardlinked object store), takes seconds, and gives the suite a tree
 * where the only server is its own.
 */
let suiteDir = REPO;
let cloneDir = null;
if (!NO_CLONE) {
  cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-watch-'));
  execFileSync('git', ['clone', '--no-local', '-q', REPO, path.join(cloneDir, 'tree')]);
  suiteDir = path.join(cloneDir, 'tree');
  execFileSync('npm', ['ci', '--ignore-scripts', '--silent'], { cwd: suiteDir, timeout: 5 * 60 * 1000 });
}
const cleanup = () => { if (cloneDir) fs.rmSync(cloneDir, { recursive: true, force: true }); };

/**
 * #735 — run it so the deadline can actually STOP it, and keep what it said.
 *
 * This was `execFileSync(..., {timeout: 15min})`. Two defects, both measured on
 * the 2026-08-08 09:45Z incident:
 *
 *  1. execFileSync's timeout signals the SHELL. `node --test` is its child, is
 *     not killed, is reparented to init, and KEEPS RUNNING. Twelve seconds
 *     after a kill: the full runner still going, seven orphaned `node server.js`
 *     children holding ports, and the suite went on to complete all 743 tests
 *     into a temp file nobody reads. The watch stopped WATCHING; it never
 *     stopped the run. A deadline that abandons rather than terminates is not
 *     a deadline — it is the #736 orphan mechanism with a different trigger.
 *
 *  2. A killed run was signed `unparsed`, which claims the output was
 *     unreadable and sends the reader to hunt a broken parser. The run simply
 *     never finished. Different events, different responses.
 *
 * `detached: true` makes the shell a process-group leader, so `kill(-pid)`
 * reaps the group — shell, node --test, and every test server it spawned.
 * Output is accumulated as it streams (run-tests.sh now tees), so whatever the
 * run managed to say survives being killed.
 */
const RUN_TIMEOUT_MS = Number(process.env.SUITE_WATCH_RUN_TIMEOUT_MS ?? 15 * 60 * 1000);
const ISOLATION_TIMEOUT_MS = Number(process.env.SUITE_WATCH_ISOLATION_TIMEOUT_MS ?? 10 * 60 * 1000);

/**
 * #746 — the watcher mints the run id so the isolation rerun below can append a
 * LINKED child event without parsing anything out of the run's own output. The
 * id has to exist before the first verdict is written, or the link can only be
 * reconstructed from mutable text.
 */
const runId = newRunId();
process.env.RUN_TESTS_RUN_ID = runId;

let red = false;
const full = await runBoundedProcessTree({
  file: 'sh', args: [path.join(suiteDir, 'scripts', 'run-tests.sh')], cwd: suiteDir, timeout: RUN_TIMEOUT_MS,
});
const out = full.stdout + full.stderr;
const timedOut = full.timedOut;
red = timedOut || full.code !== 0;

/**
 * #746 — a ledger write that failed must be observable HERE, not merely
 * captured. The runner writes its warning to stderr, which this process
 * concatenates into `out` and then, on a green run, never prints: the whole
 * output is discarded and the log says `suite green — silent`. Captured is not
 * observable — the unattended path is exactly where nobody is watching, so a
 * warning that only a local terminal sees does not exist for the run that most
 * needs it.
 *
 * Re-emitted into the watch's own log, and deliberately NOT posted: a failed
 * ledger write is not a red suite and must not spend the alarm's credibility
 * (#670). It also does not touch the verdict.
 */
for (const line of out.split('\n')) {
  if (line.startsWith('# WARNING: verdict ledger')) console.log(`${now} ${line.replace(/^# /, '')}`);
}

// The signature: which test FILES failed. Parsed from the runner's failure
// section; a parse that finds nothing on a red run still fires (sig 'unparsed')
// — an unreadable red must not be a silent one.
const files = [...new Set([...out.matchAll(/location: '([^']*\/tests\/[^']+\.test\.mjs)/g)]
  .map((m) => path.basename(m[1])))].sort();
const completedFiles = timedOut
  ? new Set([...out.matchAll(/^# file: (.+) complete$/gm)].map((m) => path.basename(m[1])))
  : new Set();
const incompleteFiles = timedOut
  ? fs.readdirSync(path.join(suiteDir, 'tests'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map((entry) => entry.name)
    .filter((file) => !completedFiles.has(file))
    .sort()
  : [];

/**
 * FLAKE TRIAGE, mechanized. Three parallel-load flakes were hand-triaged the
 * same day this shipped (ENOTEMPTY teardown, commons-panel, commons-e2e) —
 * each by the same ritual: isolate the failing file, re-run it, believe the
 * isolated verdict. The watch performs that ritual itself: a red full run is
 * confirmed by re-running the failing files in isolation, and only a red
 * that SURVIVES isolation posts. A flake is logged, never alarmed.
 */
let flake = false;
let isolationOut = null;
/**
 * #746 — snapshot BEFORE the flake branch can flip it. `red` is the verdict;
 * this is the EVENT. A flake is a red that resolved, and it is precisely the
 * evidence this card exists to stop losing, so it must not be excluded by the
 * variable that records the alarm decision.
 */
const fullRunRed = red;
if (red && !timedOut && files.length) {
  // #746 — the isolation rerun is a SUBSET and calls run-test-files.mjs
  // directly, so run-tests.sh's opt-in never runs. Opt it in explicitly: this is
  // the one subset whose verdict is worth keeping, because it is the event that
  // turns a red into a flake. Appended as its own immutable line carrying the
  // parent's id — never as an edit to the red, which is the only irreplaceable
  // part of the record.
  process.env.RUN_TESTS_LEDGER = 'isolation';
  process.env.RUN_TESTS_PARENT_RUN_ID = runId;
  delete process.env.RUN_TESTS_RUN_ID; // the child mints its own
  const isolated = await runBoundedProcessTree({
    file: 'node', args: ['scripts/run-test-files.mjs', ...files.map((f) => path.join('tests', f))],
    cwd: suiteDir, timeout: ISOLATION_TIMEOUT_MS,
  });
  isolationOut = isolated.stdout + isolated.stderr;
  if (!isolated.timedOut && isolated.code === 0) {
    flake = true; // isolated re-run green: parallel-load flake, not a regression
    red = false;
  }
}

/**
 * #746 — PRESERVE THE EVIDENCE BEFORE DESTROYING THE TREE.
 *
 * On 2026-08-11 this card got the real red it had been gated on for two days:
 * `css-custom-properties.test.mjs`, fourth sighting (Aug 5, 6, 9, 11), and it
 * SURVIVED isolation — the watcher reproduced an intermittent failure in a
 * clean single-file run, which is the most valuable event this instrument can
 * produce. Nothing was learned from it, because:
 *
 *   - the full run's TAP lived only in `out`, a local variable
 *   - the isolation run's output was captured into `isolated` and NEVER READ —
 *     only `.timedOut` and `.code` were consulted
 *   - `cleanup()` then deleted the clone
 *
 * ⚠️ The card's own warning was aimed at the wrong actor: "if you see a red,
 * read the ledger before you RERUN it — the rerun is what destroys the
 * evidence." The rerun was not the destroyer. The instrument was.
 *
 * Written for ANY red full run, flake or not: a flake is a red that resolved,
 * and it is exactly the case the ledger reduces to a verdict and a filename.
 * Ordering is load-bearing — this runs BEFORE cleanup(), because the isolation
 * TAP is only reconstructible from a tree that is about to stop existing.
 */
if (fullRunRed && ARTIFACT_DIR) {
  try {
    const runDir = path.join(ARTIFACT_DIR, runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'full.tap'), out);
    if (isolationOut !== null) fs.writeFileSync(path.join(runDir, 'isolation.tap'), isolationOut);
    fs.writeFileSync(path.join(runDir, 'meta.json'), `${JSON.stringify({
      runId, at: now, files, timedOut, flake, survivedIsolation: !flake && isolationOut !== null,
    }, null, 2)}\n`);
    // Bounded: newest-first by name, since run ids sort chronologically.
    const kept = fs.readdirSync(ARTIFACT_DIR).sort().reverse();
    for (const stale of kept.slice(ARTIFACT_KEEP)) {
      fs.rmSync(path.join(ARTIFACT_DIR, stale), { recursive: true, force: true });
    }
    console.log(`${now} artifacts preserved: ${runDir}`);
  } catch (e) {
    // ⚠️ Never let evidence-keeping break the alarm. A watcher that dies while
    // saving a log is worse than one that loses the log — #670's whole point is
    // that the subscription must fire.
    console.log(`${now} WARNING: could not preserve artifacts: ${e.message}`);
  }
}
cleanup();
// #735 — a killed run is a TIMEOUT, never 'unparsed'. 'unparsed' claims the
// output was unreadable and aims the reader at the parser; the run never
// finished, which aims them at the hang.
const sig = red ? (timedOut ? 'timeout' : (files.join(',') || 'unparsed')) : null;
if (flake) console.log(`${now} full-run red did NOT survive isolation — flake, silent: [${files.join(', ')}]`);

let st = { sigTimes: {} };
try { st = { sigTimes: {}, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch { /* first run */ }
for (const [k, at] of Object.entries(st.sigTimes)) {
  if (Date.now() - at >= COOLDOWN_MS) delete st.sigTimes[k];
}

if (!red) {
  st.sigTimes = {}; // recovery clears every signature — the next red is news
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(st));
  console.log(`${now} suite green — silent`);
  process.exit(0);
}

const summary = (out.match(/# (tests|pass|fail) \d+/g) || []).join(' · ');
const muted = st.sigTimes[sig] != null;
console.log(`${now} suite RED sig=[${sig}] ${muted ? 'muted' : 'FIRING'} ${summary}`);

if (!muted) {
  st.sigTimes[sig] = Date.now();
  const body = timedOut
    ? `🔴 suite watch: the FULL suite did not FINISH — killed after ${Math.round(RUN_TIMEOUT_MS / 1000)}s `
      + `${full.terminationVerified ? 'and its process tree terminated' : 'but cleanup could not be verified'}. This is a HANG, not a failing assertion: `
      + `Incomplete test file(s): ${incompleteFiles.join(', ') || 'none'}. `
      + `${summary || 'no summary — it never reached one'}. `
    : `🔴 suite watch: the FULL test suite is RED in ${treeIdentity(REPO)} `
      + `(${summary || 'summary unparsed'}). `
      + `Failing file(s): ${files.length ? files.join(', ') : 'unparsed — read the log'}. `
    + `A red suite invalidates every "no regressions" claim until it is green (the #465 lesson: `
    + `the rail worked and nobody read it — this post is the subscription). `
    + `Repro: sh scripts/run-tests.sh in THAT tree — not in yours; they may differ. `
    + `(This signature now mutes for `
    + `${Math.round(COOLDOWN_MS / 3600000)}h; a NEW failing file fires immediately.)`;
  if (DRYRUN) {
    console.log(`${now} DRYRUN would post: ${body}`);
  } else {
    try {
      const res = await fetch(POST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body, author: 'board' }),
        signal: AbortSignal.timeout(5000),
      });
      console.log(`${now} posted: HTTP ${res.status}`);
    } catch (e) {
      console.log(`${now} post failed: ${e.message}`);
    }
  }
}
fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
fs.writeFileSync(STATE_FILE, JSON.stringify(st));
process.exit(0);
