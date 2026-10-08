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
import { rmTreeForce, withSystemBins } from './watch-env.mjs';   // #1417
import { parseTap, classify, loadExclusions, loadRequired, verdictLine } from './suite-watch-verdict.mjs';   // #1637

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
/** #1637 — the latest run's required-coverage proof: one file, overwritten every run (see the artifact block) */
const COVERAGE_FILE = process.env.SUITE_WATCH_COVERAGE || path.join(path.dirname(STATE_FILE), 'scrum-suite-watch-coverage.json');
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
// #1417 — the clone holds a deliberately read-only deploy fixture; a plain
// rmSync died EACCES on it every night AFTER the verdict, and that crash was
// the exit code launchd reported. Cleanup makes the tree writable first, and a
// cleanup failure is LOGGED, never the run's verdict.
const cleanup = () => {
  if (!cloneDir) return;
  try { rmTreeForce(cloneDir); }
  catch (e) { console.error(`${new Date().toISOString()} cleanup could not remove ${cloneDir}: ${e?.code || e?.message || e} — left in place, verdict unaffected`); }
};
// #1417 — the plist's PATH has no /usr/sbin, so `lsof` (which #884's tests
// run) was "command not found" under the nightly and nowhere else. The suite
// runs with the system bin dirs on its PATH whatever the launcher handed us.
process.env.PATH = withSystemBins(process.env.PATH);

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

// #1637 — THE VERDICT: one parse of the merged TAP, three independent states (FAILED / TODO / INCOMPLETE) plus DOCUMENTED. The earlier signature was "every file named by any `location:` line", which also
// matched `# TODO` rows: on 2026-10-08 it listed 9 files for one real failure and a new TODO-only file fired as a new failing file. See scripts/suite-watch-verdict.mjs for the rules.
const parsed = parseTap(out, { suiteDir });
const exclPath = process.env.SUITE_WATCH_EXCLUSIONS || path.join(suiteDir, 'scripts', 'suite-watch-exclusions.json');
const reqPath = process.env.SUITE_WATCH_REQUIRED || path.join(suiteDir, 'scripts', 'suite-watch-required.json');
const excl = loadExclusions(exclPath); const req = loadRequired(reqPath);
const verdict = classify(parsed, { exclusions: excl.entries, required: req.files, problems: [...excl.problems, ...req.problems] });
console.log(`${now} ${verdictLine(verdict)}`);
if (verdict.todo) console.log(`${now} TODO rows (expected failures, not red): ${verdict.todo} in ${verdict.todoFiles.length} file(s): ${verdict.todoFiles.join(', ') || 'none beyond the failing files'}`);
if (verdict.documented) console.log(`${now} documented exclusions applied: ${verdict.documented} skip(s)`);
for (const p of verdict.problems) console.log(`${now} PROBLEM: ${p}`);
if (verdict.unclassified) console.log(`${now} unclassified skips (INCOMPLETE until documented in ${path.relative(suiteDir, exclPath)}): ${verdict.unclassified}`);
const files = verdict.failingFiles;
if (!red && verdict.failed > 0) red = true;          // the exit code said success but the TAP holds a leaf failure: believe the rows
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
    file: 'node', args: ['scripts/run-test-files.mjs', ...files.filter((f) => /\.test\.mjs$/.test(f))],   // #1637: checkout-relative paths already
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
 *
 * #1637: an INCOMPLETE run keeps its TAP too (a green night with missing coverage left no evidence at
 * all), and EVERY run leaves the proof that the required tests RAN (a lower skip count is not that proof)
 * in one overwritten file; full.tap / isolation.tap stay confined to runs that have something to explain.
 */
// The proof that the required tests RAN is ONE overwritten file beside the state file, written on EVERY run: per-run directories for green nights would push the red evidence out of the bounded
// ARTIFACT_KEEP window (#746: "a green run writes no artifacts"). A run that fails or is incomplete ALSO keeps coverage.json in its own run directory, next to the TAP it explains.
const coverageDoc = {
  runId, at: now, required: verdict.coverage.map(({ file, executed, passed, failed, skipped }) => ({ file, executed, passed, failed, skipped })),
  ran: verdict.required, truncated: verdict.truncated, failed: verdict.failed, incomplete: verdict.incomplete,
};
try {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(COVERAGE_FILE, `${JSON.stringify(coverageDoc, null, 2)}\n`);
} catch (e) { console.log(`${now} WARNING: could not write ${COVERAGE_FILE}: ${e.message}`); }
if (ARTIFACT_DIR && (fullRunRed || verdict.incomplete)) {
  try {
    const runDir = path.join(ARTIFACT_DIR, runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'coverage.json'), `${JSON.stringify(coverageDoc, null, 2)}\n`);
    fs.writeFileSync(path.join(runDir, 'full.tap'), out);
    if (isolationOut !== null) fs.writeFileSync(path.join(runDir, 'isolation.tap'), isolationOut);
    fs.writeFileSync(path.join(runDir, 'meta.json'), `${JSON.stringify({
      runId, at: now, files, timedOut, flake, survivedIsolation: !flake && isolationOut !== null,
      incomplete: verdict.incomplete, unavailable: verdict.unavailable, unclassified: verdict.unclassified, documented: verdict.documented,
      todo: verdict.todo, failed: verdict.failed, required: verdict.required, truncated: verdict.truncated, problems: verdict.problems,
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
if (flake) console.log(`${now} full-run red did NOT survive isolation — flake, silent: [${files.join(', ')}]`);

/**
 * #1637 — STATES ARE INDEPENDENT, so are their signatures and their mutes. Members, not one composite key:
 *   red:<file>   one per really failing file (or red:timeout / red:unparsed)
 *   inc:<member> one per gap: a file with UNAVAILABLE or unclassified skips, a required file not run, a problem, truncation
 * A state posts when ANY of its members is new (not muted); members that merely LEAVE do not re-fire it. The count of skips is deliberately NOT part of the key: a night that adds three more
 * skips in a file already known is the same gap. Recovery of one state clears only that state's members.
 */
const redMembers = red ? (timedOut ? ['timeout'] : (files.length ? files : ['unparsed'])) : [];
const incMembers = verdict.incomplete ? [
  ...verdict.incompleteFiles.map((f) => `skips:${f}`),
  ...verdict.requiredMissing.map((c) => `required:${c.file}`),
  ...verdict.problems.map((p) => `problem:${p.slice(0, 80)}`),
  ...(verdict.truncated ? ['truncated'] : []),
] : [];

let st = { sigTimes: {} };
try { st = { sigTimes: {}, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch { /* first run */ }
for (const [k, at] of Object.entries(st.sigTimes)) {
  // pre-#1637 keys (a bare comma-joined basename list) can never match a member again; let them go
  if (Date.now() - at >= COOLDOWN_MS || !/^(red|inc):/.test(k)) delete st.sigTimes[k];
}
if (!red) for (const k of Object.keys(st.sigTimes)) if (k.startsWith('red:')) delete st.sigTimes[k];
if (!verdict.incomplete) for (const k of Object.keys(st.sigTimes)) if (k.startsWith('inc:')) delete st.sigTimes[k];

const summary = (out.match(/# (tests|pass|fail) \d+/g) || []).join(' · ');
const fresh = (prefix, members) => members.filter((m) => st.sigTimes[`${prefix}:${m}`] == null);
const bodies = [];
if (red) {
  const news = fresh('red', redMembers);
  console.log(`${now} suite RED sig=[${redMembers.join(',')}] ${news.length ? 'FIRING' : 'muted'} ${summary}`);
  if (news.length) {
    const todoSentence = verdict.todo ? `TODO rows (expected failures, NOT failures): ${verdict.todo} in ${verdict.todoFiles.length} file(s)${verdict.todoFiles.length ? `: ${verdict.todoFiles.join(', ')}` : ''}. ` : '';
    bodies.push(timedOut
      ? `🔴 suite watch: the FULL suite did not FINISH — killed after ${Math.round(RUN_TIMEOUT_MS / 1000)}s `
        + `${full.terminationVerified ? 'and its process tree terminated' : 'but cleanup could not be verified'}. This is a HANG, not a failing assertion: `
        + `Incomplete test file(s): ${incompleteFiles.join(', ') || 'none'}. `
        + `${summary || 'no summary — it never reached one'}. `
      : `🔴 suite watch: the FULL test suite is RED in ${treeIdentity(REPO)} `
        + `(${summary || 'summary unparsed'}). `
        + `Failing file(s): ${files.length ? files.join(', ') : 'unparsed — read the log'}. `
        + todoSentence
        + `A red suite invalidates every "no regressions" claim until it is green (the #465 lesson: `
        + `the rail worked and nobody read it — this post is the subscription). `
        + `Repro: sh scripts/run-tests.sh in THAT tree — not in yours; they may differ. `
        + `(A failing file now mutes for ${Math.round(COOLDOWN_MS / 3600000)}h; a NEW failing file fires immediately.)`);
    for (const m of redMembers) if (st.sigTimes[`red:${m}`] == null) st.sigTimes[`red:${m}`] = Date.now();
  }
}
if (verdict.incomplete) {
  const news = fresh('inc', incMembers);
  console.log(`${now} suite INCOMPLETE members=${incMembers.length} ${news.length ? 'FIRING' : 'muted'} unavailable=${verdict.unavailable} unclassified=${verdict.unclassified}`);
  if (news.length) {
    const reqLine = verdict.requiredMissing.length ? `Required test file(s) that did NOT run: ${verdict.requiredMissing.map((c) => `${c.file} (${c.why})`).join('; ')}. ` : '';
    const probLine = verdict.problems.length ? `Problem(s): ${verdict.problems.join('; ')}. ` : '';
    bodies.push(`🟠 suite watch: the run is INCOMPLETE in ${treeIdentity(REPO)} — required coverage is missing, so this is NOT a pass even with zero failures. `
      + `Unavailable (environment) skips: ${verdict.unavailable}; unclassified skips: ${verdict.unclassified}${verdict.incompleteFiles.length ? ` — in ${verdict.incompleteFiles.length} file(s), e.g. ${verdict.incompleteFiles.slice(0, 5).join(', ')}` : ''}. `
      + reqLine + probLine + (verdict.truncated ? 'The TAP was truncated (no summary line): the run did not finish reporting. ' : '')
      + `Failures: ${verdict.failed}, reported separately. An UNAVAILABLE skip is never a pass; fix the environment (e.g. GRAPH_EXECUTOR_PYTHON) or document an intentional exclusion `
      + `(exact file + test + reason + scope) in scripts/suite-watch-exclusions.json. `
      + `(This gap mutes for ${Math.round(COOLDOWN_MS / 3600000)}h; a NEW gap fires immediately, and it does not depend on the red state.)`);
    for (const m of incMembers) if (st.sigTimes[`inc:${m}`] == null) st.sigTimes[`inc:${m}`] = Date.now();
  }
}
if (!red && !verdict.incomplete) console.log(`${now} suite green — silent`);

for (const body of bodies) {
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
