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
 *   SUITE_WATCH_RUN_TIMEOUT_MS  how long the suite may run before the group is
 *                           KILLED and the red signed [timeout] (default 15m)
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = process.env.SUITE_WATCH_REPO
  || path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const POST_URL = process.env.SUITE_WATCH_POST_URL || 'http://127.0.0.1:3141/api/conversations';
const STATE_FILE = process.env.SUITE_WATCH_STATE || path.join(os.homedir(), '.claude', 'scrum-suite-watch.state');
const COOLDOWN_MS = Number(process.env.SUITE_WATCH_COOLDOWN_MS ?? 6 * 3600 * 1000);
const DRYRUN = process.env.SUITE_WATCH_DRYRUN === '1';
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

let out = '';
let red = false;
let timedOut = false;
{
  const child = spawn('sh', [path.join(suiteDir, 'scripts', 'run-tests.sh')], {
    cwd: suiteDir, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });

  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      // The GROUP, not the shell. Killing the shell alone is defect 1 above.
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, RUN_TIMEOUT_MS);
    child.on('close', (c) => { clearTimeout(timer); resolve(c); });
    child.on('error', () => { clearTimeout(timer); resolve(1); });
  });
  red = timedOut || code !== 0;
}

// The signature: which test FILES failed. Parsed from the runner's failure
// section; a parse that finds nothing on a red run still fires (sig 'unparsed')
// — an unreadable red must not be a silent one.
const files = [...new Set([...out.matchAll(/location: '([^']*\/tests\/[^']+\.test\.mjs)/g)]
  .map((m) => path.basename(m[1])))].sort();

/**
 * FLAKE TRIAGE, mechanized. Three parallel-load flakes were hand-triaged the
 * same day this shipped (ENOTEMPTY teardown, commons-panel, commons-e2e) —
 * each by the same ritual: isolate the failing file, re-run it, believe the
 * isolated verdict. The watch performs that ritual itself: a red full run is
 * confirmed by re-running the failing files in isolation, and only a red
 * that SURVIVES isolation posts. A flake is logged, never alarmed.
 */
let flake = false;
if (red && !timedOut && files.length) {
  try {
    execFileSync('node', ['--test', ...files.map((f) => path.join('tests', f))], {
      cwd: suiteDir, timeout: 10 * 60 * 1000,
    });
    flake = true; // isolated re-run green: parallel-load flake, not a regression
    red = false;
  } catch { /* still red in isolation — a real red */ }
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
      + `and its process group terminated. This is a HANG, not a failing assertion: `
      + `${summary || 'no summary — it never reached one'}. `
      + `${files.length ? `Last files seen: ${files.join(', ')}. ` : ''}`
    : `🔴 suite watch: the FULL test suite is RED (${summary || 'summary unparsed'}). `
      + `Failing file(s): ${files.length ? files.join(', ') : 'unparsed — read the log'}. `
    + `A red suite invalidates every "no regressions" claim until it is green (the #465 lesson: `
    + `the rail worked and nobody read it — this post is the subscription). `
    + `Repro: scripts/run-tests.sh in the repo. (This signature now mutes for `
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
