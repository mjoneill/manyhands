/**
 * #1672 — the suite leaves temp entries behind. Chosen shape (decided in the room, 2026-10-11): the RUNNER owns a private TMPDIR for the whole invocation and removes it after its children
 * have exited; it never removes on a creator's exit, and it REPORTS what it removed. Written BEFORE that is built (RED rows), by a different hand than the fix.
 *
 * The seam: run `sh scripts/run-tests.sh <fixture files>` with an OUTER TMPDIR the row owns (a fresh directory outside the repo), then look at the outer TMPDIR after the runner has exited.
 * The runner's own temp files (`run-tests.*`) are removed by the runner today, so a clean run leaves the outer TMPDIR empty: that is the control, and it passes now.
 *
 *   T0a/T0b CONTROLS   the on-demand per-file detector (scripts/tmp-leak-check-1672.mjs, which answers "which FILE leaks") sees a leaking fixture and a clean one
 *   R0  CONTROL        the runner on a clean fixture exits 0 and leaves the outer TMPDIR empty
 *   RA  light real file  `sh scripts/run-tests.sh tests/executor-meter-1570.test.mjs` REPORTS 0 removed entries (the file leaks 11 when run bare; measured on 69931f0). "Nothing left in the outer TMPDIR"
 *                        would be vacuous here: a backstop leaves it empty even after cleaning up a leak. Only the report can say the file did not leak.
 *   RB0 a store outlives its creator   a store made by a test file that has already ended is still readable by that file's child 2 s later (the runner is running other files), so a cleanup keyed to the
 *                        creator's exit would fail it; nothing is left in the outer TMPDIR when the runner exits
 *   RB  a DETACHED survivor   a test file leaves a detached process (its own session, argv naming a store under TMPDIR) running after it ends: the runner finds it, names its pid in the output, kills it, and
 *                        only then removes the folder. After the runner exits the process is gone and the outer TMPDIR is empty.
 *                        It must also never print the survivor's environment or its full argv (a secret held only in either must not appear in the output).
 *   RC  a killed test    a test file that makes an entry and then SIGKILLs itself: the runner exits non-zero (a killed file is not green) AND the outer TMPDIR is empty
 *   RD  the removal report   the runner prints what it removed, never silently: a clean run says 0 entries; a run whose files left exactly 3 entries (2 directories and a file, 2 KiB of data) says
 *                        3 entries and a byte count of at least 2048, on one line matching /removed N entr../ with a number of bytes. (The wording is mine; the builder may change it if the
 *                        row's regexes change with it, in the same commit.) Whether a nonzero count FAILS the run is not decided yet; no row asserts the exit code of a run that left entries, except RC.
 *   RH  a stranger     a detached process that does NOT carry the runner's ownership token (it is spawned with a minimal environment) and references a store under TMPDIR: it is never killed, the run FAILS,
 *                        the suite folder is RETAINED, and the output prints the pid and the folder path. Nothing is deleted beneath a process the runner cannot prove is its own.
 *   RE  a TERMed runner  SIGTERM to the runner while a test file hangs and has left a detached survivor: the runner is gone within 20 s, the hanging file and the survivor are gone, and no
 *                        `manyhands-suite.*` folder is left behind (the process tree is settled before the folder is removed)
 *
 * The ratchet (decided 16:39Z): each test file gets its OWN sub-TMPDIR inside the suite folder, so leaks are attributed per file on every run. A file that leaves anything fails the run BY NAME unless it is
 * on the checked-in baseline (`scripts/tmp-leak-baseline.json`); a baselined file that leaks is reported and green; a baselined file that now leaves nothing is reported as a candidate for removal and
 * is green too (delisting is a deliberate edit). The rows below need a way to point the runner at THEIR baseline without touching the real one; I specify it as the environment variable TMP_LEAK_BASELINE naming a JSON file that
 * holds an array of test-file paths exactly as given on the runner's command line. That interface is mine; the builder may change it if these rows change with it, in the same commit.
 *   RG1 a new leaking file, not on the baseline: the run FAILS and the output names the file, its 3 entries and its bytes (>= 2048)
 *   RG2 a baselined file that leaks: green, still reported by name
 *   RG3 a baselined file that is clean: reported as a "candidate" for removal from the baseline, and the run stays green (decided 16:43Z: a flapping leaker must not block a landing)
 *
 *   RI  another run's files   a second, concurrent run (its own token) finishes while the first run's file is still hanging: the first run's file process is NOT killed and its folder is intact. A guard
 *                        against over-reach: it passes on a runner with no teardown at all, so it means something only against the build (a mutant that matches any token must fail it).
 *   RJ  an early TERM  SIGTERM to the runner at 0, 30, 60, 100, 160 and 250 ms after it starts (before and around the moment its node process has recorded its pid): the runner is gone within 20 s each
 *                        time, no file process or survivor outlives it, and nothing is left in the outer TMPDIR
 *
 *   RK  an argv impostor   a detached process with NO token in its environment whose argv merely contains the text `MANYHANDS_SUITE_RUN=<this run's token>` (it is read from the fixture's own environment)
 *                        is not the runner's: it is never killed. Ownership is the environment entry, not a substring of anything that mentions it.
 *   RM  an env-value impostor   a detached process whose environment holds `OTHER="x MANYHANDS_SUITE_RUN=<this run's token> y"` but NOT the entry itself, and which names a store under the folder in its argv:
 *                        the token text inside another variable's value is not the entry, so it is not the runner's: never killed, the run FAILS, the folder is RETAINED and named
 *   RN  a descendant spawned between inspections   a surviving owned process that keeps spawning new detached owned children every 20 ms: whatever the runner inspects, new ones appear after it. The
 *                        property is safety, not a particular remedy: either every process the fixture recorded is gone when the runner exits, or the run FAILED and the suite folder was RETAINED. A folder
 *                        deleted from under a live owned process is the failure.
 *   RO  an owned process with an EMPTY argv[0] and the token as the FIRST environment entry   its argv does not name the folder, so only the environment can identify it. Measured on the macOS helper at c4a767d:
 *                        called directly it reads this process as NOT owned (the empty argv[0] is swallowed as padding, which shifts the split by one and drops the first environment entry). It needs BOTH an empty
 *                        argv[0] and the token first: the runner's own children have the token LAST, and the same process with a normal environment WAS found and killed (measured). The same safety property as
 *                        RN: either it is gone when the runner exits, or the run FAILED and the folder was RETAINED.
 *   RL  inspection fails   the runner cannot list processes (a `ps` that exits 1 is first on PATH): it cannot establish that the folder is unused, so the run FAILS, the suite folder is RETAINED and named,
 *                        and the output says inspection failed. macOS only: on Linux the runner reads /proc, which a row cannot make fail, so the row is skipped there with that reason.
 *
 * Not covered: SIGKILL of the runner itself (it leaves one `manyhands-suite.<pid>.*` folder by design, recorded not swept); the browser entry point (`node run-tests.js`); paths outside TMPDIR;
 * a leak that appears only under suite load; and which FILE leaks (scripts/tmp-leak-check-1672.mjs does that, on demand).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withOwned } from './helpers/ready-world-1644.mjs';
import { HAVE_PY } from './helpers/graph-executor-proc.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(ROOT, 'scripts', 'run-tests.sh');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const entries = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };
const SKIP_PY = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';

const FIXTURES = {
  'clean.test.mjs': `import { test } from 'node:test'; test('clean', () => {});\n`,
  // two directories (one holding 1 KiB) and a 1 KiB file, all at the top level of TMPDIR
  'leak.test.mjs': `import { test } from 'node:test'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
test('leak', () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-a-')); fs.writeFileSync(path.join(a, 'data'), 'x'.repeat(1024));
  fs.writeFileSync(path.join(os.tmpdir(), 'fx-b.dat'), 'y'.repeat(1024));
  fs.mkdtempSync(path.join(os.tmpdir(), 'fx-c-'));
});\n`,
  // makes a store with data and ends at once; its non-detached child reads the store 2 s later and records what it saw
  'creator.test.mjs': `import { test } from 'node:test'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawn } from 'node:child_process';
test('creator', () => {
  const s = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-store-')); fs.writeFileSync(path.join(s, 'data'), 'present');
  const code = \`setTimeout(() => { let r; try { r = require('fs').readFileSync(\${JSON.stringify(path.join(s, 'data'))}, 'utf8'); } catch (e) { r = 'FAILED ' + e.code; } require('fs').writeFileSync(process.env.RESULT_FILE, r); }, 2000)\`;
  spawn(process.execPath, ['-e', code], { stdio: 'ignore' }).unref();
});\n`,
  // a detached survivor: its own session, argv naming a store under TMPDIR, records its pid, runs for 5 minutes unless killed
  'survivor.test.mjs': `import { test } from 'node:test'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawn } from 'node:child_process';
test('survivor', () => {
  const s = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-surv-'));
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300000)', '--', '--store', s, '--api-key', process.env.FIXTURE_ARGV_SECRET_1672], { stdio: 'ignore', detached: true });
  fs.writeFileSync(process.env.SURVIVOR_PID_FILE, String(c.pid)); c.unref();
});\n`,
  // a process that is NOT the runner's: detached, a minimal environment (nothing inherited, so no ownership token of any name), argv naming a store under TMPDIR
  'stranger.test.mjs': `import { test } from 'node:test'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawn } from 'node:child_process';
test('stranger', () => {
  const s = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-stranger-'));
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300000)', '--', '--store', s], { stdio: 'ignore', detached: true, env: { PATH: process.env.PATH } });
  fs.writeFileSync(process.env.STRANGER_PID_FILE, String(c.pid)); c.unref();
});\n`,
  // a process whose environment has NO token but whose argv quotes this run's token (read from the fixture's own environment, which the runner marked)
  'impostor.test.mjs': `import { test } from 'node:test'; import fs from 'node:fs'; import { spawn } from 'node:child_process';
test('impostor', () => {
  const tok = process.env.MANYHANDS_SUITE_RUN;
  if (!tok) throw new Error('CONTROL: the file\\'s own environment carries no MANYHANDS_SUITE_RUN token');
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300000)', '--', 'MANYHANDS_SUITE_RUN=' + tok], { stdio: 'ignore', detached: true, env: {} });   // an EMPTY environment: where a parser splits argv from environment by position, the process line then ENDS with the quoted token
  fs.writeFileSync(process.env.IMPOSTOR_PID_FILE, String(c.pid)); c.unref();
});\n`,
  // an environment that quotes the token INSIDE another variable's value (not as an entry of its own), and an argv that names a store under TMPDIR
  'envimpostor.test.mjs': `import { test } from 'node:test'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawn } from 'node:child_process';
test('envimpostor', () => {
  const tok = process.env.MANYHANDS_SUITE_RUN;
  if (!tok) throw new Error('CONTROL: the file\\'s own environment carries no MANYHANDS_SUITE_RUN token');
  const s = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-envimp-'));
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300000)', '--', '--store', s], { stdio: 'ignore', detached: true, env: { OTHER: 'x MANYHANDS_SUITE_RUN=' + tok + ' y' } });
  fs.writeFileSync(process.env.ENVIMPOSTOR_PID_FILE, String(c.pid)); c.unref();
});\n`,
  // an owned survivor that keeps making new owned (token-inheriting) detached children, each naming a store under TMPDIR; every pid is appended to a file
  'spawner.test.mjs': `import { test } from 'node:test'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawn } from 'node:child_process';
test('spawner', () => {
  const s = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-spawner-'));
  const code = \`const { spawn } = require('child_process'), fs = require('fs');
    setInterval(() => { const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300000)', '--', '--store', \${JSON.stringify(s)}], { stdio: 'ignore', detached: true }); c.unref(); fs.appendFileSync(process.env.SPAWNED_PIDS_FILE, c.pid + '\\\\n'); }, 20);\`;
  const sp = spawn(process.execPath, ['-e', code], { stdio: 'ignore', detached: true }); sp.unref();
  fs.writeFileSync(process.env.SPAWNER_PID_FILE, String(sp.pid));
});\n`,
  // an owned process with an EMPTY argv[0] (inherits the token), whose argv does not name any folder
  'emptyargv0.test.mjs': `import { test } from 'node:test'; import fs from 'node:fs'; import { spawn } from 'node:child_process';
test('emptyargv0', () => {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300000)'], { stdio: 'ignore', detached: true, argv0: '', env: { MANYHANDS_SUITE_RUN: process.env.MANYHANDS_SUITE_RUN } });   // the token is the FIRST (only) environment entry
  fs.writeFileSync(process.env.EMPTYARGV0_PID_FILE, String(c.pid)); c.unref();
});\n`,
  // keeps the runner alive past the child's read
  'holder.test.mjs': `import { test } from 'node:test'; test('holder', async () => { await new Promise((r) => setTimeout(r, 5000)); });\n`,
  'killed.test.mjs': `import { test } from 'node:test'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
test('killed', () => { fs.mkdtempSync(path.join(os.tmpdir(), 'fx-killed-')); process.kill(process.pid, 'SIGKILL'); });\n`,
  'hang.test.mjs': `import { test } from 'node:test'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawn } from 'node:child_process';
test('hang', { timeout: 120000 }, async () => {
  const s = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-hang-'));
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300000)', '--', '--store', s], { stdio: 'ignore', detached: true }); c.unref();
  fs.writeFileSync(process.env.SURVIVOR_PID_FILE, String(c.pid)); fs.writeFileSync(process.env.PID_FILE, String(process.pid));
  setInterval(() => {}, 1000); await new Promise(() => {});
});\n`,
};

/** Set up a row-owned world: fixtures, an outer TMPDIR, a results directory. Everything is outside the repo and removed when the row ends. */
async function withWorld(body) {
  return withOwned(async (own) => {
    const base = own.dir('r44u-1672r-');
    const fx = path.join(base, 'fixtures'); const outer = path.join(base, 'outer'); const res = path.join(base, 'res');
    for (const d of [fx, outer, res]) fs.mkdirSync(d);
    for (const [name, src] of Object.entries(FIXTURES)) fs.writeFileSync(path.join(fx, name), src);
    const f = (name) => path.join(fx, name);
    own.adopt(async () => { try { for (const l of fs.readFileSync(path.join(res, 'spawned.pids'), 'utf8').split('\n')) { if (l) { try { process.kill(Number(l), 'SIGKILL'); } catch { /* gone */ } } } } catch { /* none */ } });   // registered first, so it runs LAST: after the spawner itself is killed
    // a survivor the runner failed to reap is killed here, by the pid its fixture recorded, never by pattern
    own.adopt(async () => { for (const n of ['survivor.pid', 'hang-survivor.pid', 'stranger.pid', 'hang.pid', 'impostor.pid', 'envimpostor.pid', 'spawner.pid', 'emptyargv0.pid']) { try { process.kill(Number(fs.readFileSync(path.join(res, n), 'utf8')), 'SIGKILL'); } catch { /* none, or gone */ } } });
    /** Start the runner on `files` with TMPDIR = the outer directory. Resolves a handle; `done` settles when the runner has exited. */
    const start = (files, extraEnv = {}) => {
      const env = { ...process.env, TMPDIR: outer, RUN_TESTS_CONCURRENCY: '2', RUN_TESTS_FILE_TIMEOUT_MS: '90000', ...extraEnv };
      for (const k of ['NODE_TEST_CONTEXT', 'RUN_TESTS_LEDGER', 'RUN_TESTS_RUN_ID', 'RUN_TESTS_PARENT_RUN_ID']) delete env[k];
      const child = spawn('sh', [RUNNER, ...files], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      let output = ''; child.stdout.on('data', (d) => { output += d; }); child.stderr.on('data', (d) => { output += d; });
      // the whole group by the captured pid; the pipes are destroyed too, because an orphan that kept them open would otherwise keep THIS process alive after the row has ended
      own.adopt(async () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } child.stdout.destroy(); child.stderr.destroy(); });
      const done = new Promise((r) => child.once('exit', (code, sig) => r({ code, sig })));
      return { child, done, out: () => output };
    };
    const baseline = (paths) => { const p = path.join(res, 'baseline.json'); fs.writeFileSync(p, JSON.stringify(paths)); return { TMP_LEAK_BASELINE: p }; };
    return body({ own, base, outer, res, f, start, baseline, left: () => entries(outer) });
  });
}
const finish = async (h, boundMs) => {
  let timer;
  try { return await Promise.race([h.done, new Promise((r) => { timer = setTimeout(() => r({ code: 'TIMEOUT' }), boundMs); })]); } finally { clearTimeout(timer); }
};

const CHECK = path.join(ROOT, 'scripts', 'tmp-leak-check-1672.mjs');
const runCheck = (file) => new Promise((resolve) => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const c = spawn(process.execPath, [CHECK, '--bound-ms', '60000', file], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
  c.once('exit', (code) => resolve({ code, out }));
});

test('T0a CONTROL: the on-demand detector sees the 3 entries a leaking file leaves, with their bytes, and exits 1', { timeout: 120000 }, () => withWorld(async (w) => {
  const r = await runCheck(w.f('leak.test.mjs'));
  assert.equal(r.code, 1, `a leaking file makes the detector exit 1 (got ${r.code}); output: ${r.out.slice(-400)}`);
  const m = /: (\d+) entr\w+ left, (\d+) bytes/.exec(r.out);
  assert.ok(m && Number(m[1]) === 3 && Number(m[2]) >= 2048, `it reports 3 entries and at least 2048 bytes (got ${m && m[0]}); output: ${r.out.slice(-400)}`);
}));

test('T0b CONTROL: the on-demand detector reports 0 entries for a clean file and exits 0', { timeout: 120000 }, () => withWorld(async (w) => {
  const r = await runCheck(w.f('clean.test.mjs'));
  assert.equal(r.code, 0, `a clean file makes the detector exit 0 (got ${r.code}); output: ${r.out.slice(-400)}`);
  assert.ok(/: 0 entr\w+ left/.test(r.out), `it says 0 entries: ${r.out.slice(-300)}`);
}));

test('R0 CONTROL: the runner on a clean fixture exits 0 and leaves the outer TMPDIR empty', { timeout: 120000 }, () => withWorld(async (w) => {
  const h = w.start([w.f('clean.test.mjs')]);
  const r = await finish(h, 90000);
  assert.equal(r.code, 0, `the runner passes a clean fixture (got ${JSON.stringify(r)}); output tail: ${h.out().slice(-300)}`);
  assert.deepEqual(w.left(), [], 'a clean run leaves nothing in the outer TMPDIR (the runner removes its own temp files)');
}));

const removedLine = (out) => out.split('\n').find((l) => /removed\s+\d+\s+entr/i.test(l));
const removedCount = (line) => Number(/removed\s+(\d+)\s+entr/i.exec(line)[1]);

test('RA the light real file, run through the runner with an EMPTY baseline, passes and reports 0 removed entries', { timeout: 600000, skip: SKIP_PY }, () => withWorld(async (w) => {
  const h = w.start(['tests/executor-meter-1570.test.mjs'], w.baseline([]));
  const r = await finish(h, 540000);
  assert.equal(r.code, 0, `the file passes under the runner with nothing baselined (got ${JSON.stringify(r)}); output tail: ${h.out().slice(-300)}`);
  const line = removedLine(h.out());
  assert.ok(line, `the runner prints a removal line (none found in: ${h.out().slice(-300)})`);
  assert.equal(removedCount(line), 0, `executor-meter-1570 leaves nothing for the runner to remove (it leaks 11 entries when run bare): ${line}`);
  assert.deepEqual(w.left(), [], 'and nothing is left in the outer TMPDIR');
}));

test('RB0 a store outlives its creator: still readable by its child 2 s later, and nothing is left when the runner exits', { timeout: 120000 }, () => withWorld(async (w) => {
  const resultFile = path.join(w.res, 'child-read');
  const h = w.start([w.f('creator.test.mjs'), w.f('holder.test.mjs')], { RESULT_FILE: resultFile });
  const r = await finish(h, 90000);
  assert.notEqual(r.code, 'TIMEOUT', `the runner ends (output tail: ${h.out().slice(-300)})`);
  await sleep(500);
  const seen = fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8') : '(the child recorded nothing)';
  assert.equal(seen, 'present', 'the store a finished file made was still there when its child read it 2 s later (creator-exit cleanup would have removed it)');
  assert.deepEqual(w.left(), [], 'nothing is left in the outer TMPDIR when the runner exits');
}));

test('RB a detached survivor: the runner finds it, names its pid, kills it, and only then removes the folder', { timeout: 120000 }, () => withWorld(async (w) => {
  const pidFile = path.join(w.res, 'survivor.pid');
  const rnd = () => Math.random().toString(36).slice(2);
  const secret = 'SECRET-ENV-1672-' + rnd();      // lives in every descendant's environment, the survivor's included; the runner must never print an environment
  const argvSecret = 'SECRET-ARGV-1672-' + rnd();  // sits in the survivor's argv; diagnostics show pid, executable and folder-relative path, not the full argv
  const h = w.start([w.f('survivor.test.mjs'), w.f('holder.test.mjs')], { SURVIVOR_PID_FILE: pidFile, FIXTURE_SECRET_1672: secret, FIXTURE_ARGV_SECRET_1672: argvSecret });
  const r = await finish(h, 90000);
  assert.notEqual(r.code, 'TIMEOUT', `the runner ends (output tail: ${h.out().slice(-300)})`);
  assert.ok(fs.existsSync(pidFile), 'CONTROL: the fixture started a detached survivor and recorded its pid');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  for (let t = 0; t < 5000 && alive(pid); t += 100) await sleep(100);
  assert.equal(alive(pid), false, `the detached survivor ${pid} is gone when the runner exits`);
  assert.ok(new RegExp(`\\b${pid}\\b`).test(h.out()), `the runner names the survivor's pid ${pid} in its output as a leak (output tail: ${h.out().slice(-400)})`);
  assert.equal(h.out().includes(secret), false, 'the runner never prints a descendant\'s environment (a value that only the environment holds does not appear in the output)');
  assert.equal(h.out().includes(argvSecret), false, 'and never its full argv (a value that only the argv holds does not appear in the output)');
  assert.deepEqual(w.left(), [], 'nothing is left in the outer TMPDIR when the runner exits');
}));

test('RC a test file that is SIGKILLed mid-run: the runner exits non-zero and the outer TMPDIR is empty', { timeout: 120000 }, () => withWorld(async (w) => {
  const h = w.start([w.f('killed.test.mjs'), w.f('clean.test.mjs')]);
  const r = await finish(h, 90000);
  assert.ok(r.code !== 0 && r.code !== 'TIMEOUT', `a killed file is not green: the runner exits non-zero (got ${JSON.stringify(r)})`);
  assert.deepEqual(w.left(), [], 'the runner removed what the killed file made');
}));

test('RD the runner reports what it removed: 0 for a clean run, 3 entries and at least 2048 bytes for the (baselined) leak fixture', { timeout: 120000 }, () => withWorld(async (w) => {
  const line = removedLine;
  const clean = w.start([w.f('clean.test.mjs')]); await finish(clean, 90000);
  const cl = line(clean.out());
  assert.ok(cl, `the runner prints a removal line on a clean run (none found in: ${clean.out().slice(-300)})`);
  assert.equal(removedCount(cl), 0, `a clean run removed 0 entries: ${cl}`);
  const leak = w.start([w.f('leak.test.mjs')], w.baseline([w.f('leak.test.mjs')])); await finish(leak, 90000);
  const ll = line(leak.out());
  assert.ok(ll, `the runner prints a removal line when files left entries (none found in: ${leak.out().slice(-300)})`);
  assert.equal(removedCount(ll), 3, `the leak fixture left 3 entries: ${ll}`);
  const bytes = /(\d+)\s*bytes/i.exec(ll);
  assert.ok(bytes && Number(bytes[1]) >= 2048, `the line carries a byte count of at least the 2048 bytes the fixture wrote: ${ll}`);
}));

test('RH a process that is not the runner\'s holds the folder: never killed, the run fails, the folder is retained and named', { timeout: 120000 }, () => withWorld(async (w) => {
  const pidFile = path.join(w.res, 'stranger.pid');
  const h = w.start([w.f('stranger.test.mjs'), w.f('holder.test.mjs')], { STRANGER_PID_FILE: pidFile, ...w.baseline([w.f('stranger.test.mjs')]) });
  const r = await finish(h, 90000);
  assert.notEqual(r.code, 'TIMEOUT', `the runner ends (output tail: ${h.out().slice(-300)})`);
  assert.ok(fs.existsSync(pidFile), 'CONTROL: the fixture started the stranger and recorded its pid');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  const stillAlive = alive(pid);
  const kept = w.left().filter((n) => n.startsWith('manyhands-suite.'));
  assert.deepEqual({ runFails: r.code !== 0, strangerStillAlive: stillAlive, suiteFolderKept: kept.length === 1, pidNamed: new RegExp(`\\b${pid}\\b`).test(h.out()),
    folderNamed: kept.length === 1 && h.out().includes(kept[0]) }, { runFails: true, strangerStillAlive: true, suiteFolderKept: true, pidNamed: true, folderNamed: true },
  `outer TMPDIR holds ${JSON.stringify(w.left())}; output tail: ${h.out().slice(-500)}`);
}));

test('RI a second run finishing does not kill the first run\'s hanging file (different token) or touch its folder', { timeout: 120000 }, async () => {
  await withWorld(async (a) => {
    await withWorld(async (b) => {
      const pidFile = path.join(a.res, 'hang.pid'); const survPidFile = path.join(a.res, 'hang-survivor.pid');
      const ha = a.start([a.f('hang.test.mjs')], { PID_FILE: pidFile, SURVIVOR_PID_FILE: survPidFile });
      for (let t = 0; t < 30000 && !fs.existsSync(pidFile); t += 100) await sleep(100);
      assert.ok(fs.existsSync(pidFile), 'CONTROL: run A\'s hanging file started');
      const hangPid = Number(fs.readFileSync(pidFile, 'utf8'));
      const hb = b.start([b.f('clean.test.mjs')]);
      const rb = await finish(hb, 60000);
      assert.equal(rb.code, 0, `CONTROL: run B (a clean fixture, its own outer TMPDIR and token) passes (got ${JSON.stringify(rb)})`);
      assert.equal(alive(hangPid), true, 'run A\'s hanging file is still alive after run B has finished and torn down');
      assert.ok(a.left().some((n) => n.startsWith('manyhands-suite.') || n.startsWith('fx-hang-')), `and run A\'s temp space is still there (outer A holds ${JSON.stringify(a.left())})`);
      try { process.kill(ha.child.pid, 'SIGTERM'); } catch { /* gone */ }
      await finish(ha, 20000);
    });
  });
});

test('RJ SIGTERM at 0..250 ms after the runner starts: gone within 20 s, nothing outlives it, nothing left', { timeout: 300000 }, async () => {
  for (const delay of [0, 30, 60, 100, 160, 250]) {
    await withWorld(async (w) => {
      const pidFile = path.join(w.res, 'hang.pid'); const survPidFile = path.join(w.res, 'hang-survivor.pid');
      const h = w.start([w.f('hang.test.mjs')], { PID_FILE: pidFile, SURVIVOR_PID_FILE: survPidFile });
      await sleep(delay);
      try { process.kill(h.child.pid, 'SIGTERM'); } catch { /* gone already */ }
      const r = await finish(h, 20000);
      await sleep(1500);   // a file that was started at the last moment records its pid late
      const pids = [pidFile, survPidFile].filter((p) => fs.existsSync(p)).map((p) => Number(fs.readFileSync(p, 'utf8')));
      assert.deepEqual({ delay, runnerGone: r.code !== 'TIMEOUT', stillAlive: pids.filter(alive), outerLeft: w.left() }, { delay, runnerGone: true, stillAlive: [], outerLeft: [] },
        `SIGTERM ${delay} ms after the runner started`);
    });
  }
});

test('RK a process that only quotes the run\'s token in its argv is not the runner\'s and is never killed', { timeout: 120000 }, () => withWorld(async (w) => {
  const pidFile = path.join(w.res, 'impostor.pid');
  const h = w.start([w.f('impostor.test.mjs'), w.f('holder.test.mjs')], { IMPOSTOR_PID_FILE: pidFile, ...w.baseline([]) });
  const r = await finish(h, 90000);
  assert.notEqual(r.code, 'TIMEOUT', `the runner ends (output tail: ${h.out().slice(-300)})`);
  assert.ok(fs.existsSync(pidFile), `CONTROL: the fixture started the impostor (its file saw the run's token); output tail: ${h.out().slice(-400)}`);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  await sleep(1000);
  assert.equal(alive(pid), true, `the impostor ${pid} (token only in its argv, none in its environment) is still alive after the runner exits: ownership is the environment entry, not any text that mentions it`);
}));

test('RM a process that only quotes the run\'s token inside another variable\'s value is not the runner\'s: never killed, the run fails, the folder is retained and named', { timeout: 120000 }, () => withWorld(async (w) => {
  const pidFile = path.join(w.res, 'envimpostor.pid');
  const h = w.start([w.f('envimpostor.test.mjs'), w.f('holder.test.mjs')], { ENVIMPOSTOR_PID_FILE: pidFile, ...w.baseline([w.f('envimpostor.test.mjs')]) });
  const r = await finish(h, 90000);
  assert.notEqual(r.code, 'TIMEOUT', `the runner ends (output tail: ${h.out().slice(-300)})`);
  assert.ok(fs.existsSync(pidFile), `CONTROL: the fixture started the impostor (its file saw the run's token); output tail: ${h.out().slice(-400)}`);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  const kept = w.left().filter((n) => n.startsWith('manyhands-suite.'));
  assert.deepEqual({ runFails: r.code !== 0, impostorStillAlive: alive(pid), suiteFolderKept: kept.length === 1, pidNamed: new RegExp(`\\b${pid}\\b`).test(h.out()), folderNamed: kept.length === 1 && h.out().includes(kept[0]) },
    { runFails: true, impostorStillAlive: true, suiteFolderKept: true, pidNamed: true, folderNamed: true },
    `outer TMPDIR holds ${JSON.stringify(w.left())}; output tail: ${h.out().slice(-500)}`);
}));

test('RN a descendant spawned between the runner\'s inspections: no owned process outlives the deletion of the folder it uses', { timeout: 120000 }, () => withWorld(async (w) => {
  const spawnerPidFile = path.join(w.res, 'spawner.pid'); const spawnedFile = path.join(w.res, 'spawned.pids');
  const h = w.start([w.f('spawner.test.mjs'), w.f('holder.test.mjs')], { SPAWNER_PID_FILE: spawnerPidFile, SPAWNED_PIDS_FILE: spawnedFile, ...w.baseline([w.f('spawner.test.mjs')]) });
  const r = await finish(h, 90000);
  assert.notEqual(r.code, 'TIMEOUT', `the runner ends (output tail: ${h.out().slice(-300)})`);
  assert.ok(fs.existsSync(spawnerPidFile), 'CONTROL: the fixture started the spawner');
  await sleep(1500);
  const spawnerPid = Number(fs.readFileSync(spawnerPidFile, 'utf8'));
  const spawned = fs.existsSync(spawnedFile) ? fs.readFileSync(spawnedFile, 'utf8').split('\n').filter(Boolean).map(Number) : [];
  assert.ok(spawned.length >= 20, `CONTROL: the spawner made children while the runner ran (${spawned.length})`);
  const aliveNow = [spawnerPid, ...spawned].filter(alive);
  const kept = w.left().filter((n) => n.startsWith('manyhands-suite.'));
  const safe = aliveNow.length === 0 || (r.code !== 0 && kept.length === 1);
  assert.equal(safe, true, `${aliveNow.length} of ${spawned.length + 1} owned processes are still alive after the runner exited (run exit ${JSON.stringify(r)}, suite folder kept: ${kept.length === 1}): the folder was deleted from under them, or the run did not fail`);
}));

test('RO an owned process with an empty argv[0] is not left alive beneath a deleted folder', { timeout: 120000 }, () => withWorld(async (w) => {
  const pidFile = path.join(w.res, 'emptyargv0.pid');
  const h = w.start([w.f('emptyargv0.test.mjs'), w.f('holder.test.mjs')], { EMPTYARGV0_PID_FILE: pidFile, ...w.baseline([]) });
  const r = await finish(h, 90000);
  assert.notEqual(r.code, 'TIMEOUT', `the runner ends (output tail: ${h.out().slice(-300)})`);
  assert.ok(fs.existsSync(pidFile), 'CONTROL: the fixture started the process');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  await sleep(1000);
  const kept = w.left().filter((n) => n.startsWith('manyhands-suite.'));
  const safe = !alive(pid) || (r.code !== 0 && kept.length === 1);
  assert.equal(safe, true, `the owned process ${pid} (token in its environment, empty argv[0]) is alive after the runner exited and the run ${r.code === 0 ? 'PASSED' : 'failed'} with the suite folder ${kept.length === 1 ? 'kept' : 'removed'}: owned, and invisible to the inspection`);
}));

const ON_MAC = process.platform === 'darwin';
test('RL the runner cannot inspect processes: the run fails, the suite folder is retained and named, and the output says why', { timeout: 120000, skip: ON_MAC ? false : 'UNAVAILABLE: inspection failure can only be injected through `ps` on macOS; on Linux the runner reads /proc' }, () => withWorld(async (w) => {
  const bin = path.join(w.base, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const h = w.start([w.f('clean.test.mjs')], { PATH: `${bin}:${process.env.PATH}`, ...w.baseline([]) });
  const r = await finish(h, 90000);
  const kept = w.left().filter((n) => n.startsWith('manyhands-suite.'));
  const said = h.out().split('\n').some((l) => /tmp:/.test(l) && /(inspect|enumerat|process (table|list)|\bps\b)/i.test(l));
  assert.deepEqual({ runFails: r.code !== 0 && r.code !== 'TIMEOUT', suiteFolderKept: kept.length === 1, folderNamed: kept.length === 1 && h.out().includes(kept[0]), saysInspectionFailed: said },
    { runFails: true, suiteFolderKept: true, folderNamed: true, saysInspectionFailed: true },
    `a runner that cannot list processes cannot know the folder is unused (outer holds ${JSON.stringify(w.left())}; output tail: ${h.out().slice(-500)})`);
}));

const namedLine = (out, name) => out.split('\n').find((l) => l.includes(name) && /\d+\s+entr/i.test(l));

test('RG1 a new leaking file that is not on the baseline fails the run by name, with its entries and bytes', { timeout: 120000 }, () => withWorld(async (w) => {
  const h = w.start([w.f('leak.test.mjs'), w.f('clean.test.mjs')], w.baseline([]));
  const r = await finish(h, 90000);
  assert.ok(r.code !== 0 && r.code !== 'TIMEOUT', `a leaking file that is not baselined fails the run (got ${JSON.stringify(r)})`);
  const line = namedLine(h.out(), 'leak.test.mjs');
  assert.ok(line, `the output names leak.test.mjs with its entry count (output tail: ${h.out().slice(-500)})`);
  assert.equal(Number(/(\d+)\s+entr/i.exec(line)[1]), 3, `the file left 3 entries: ${line}`);
  const bytes = /(\d+)\s*bytes/i.exec(line);
  assert.ok(bytes && Number(bytes[1]) >= 2048, `and at least 2048 bytes: ${line}`);
  assert.equal(h.out().split('\n').some((l) => l.includes('clean.test.mjs') && /fail|leak/i.test(l) && /\d+\s+entr/i.test(l)), false, 'the clean file is not blamed');
  assert.deepEqual(w.left(), [], 'nothing is left in the outer TMPDIR');
}));

test('RG2 a baselined file that leaks is reported by name and the run stays green', { timeout: 120000 }, () => withWorld(async (w) => {
  const h = w.start([w.f('leak.test.mjs')], w.baseline([w.f('leak.test.mjs')]));
  const r = await finish(h, 90000);
  assert.equal(r.code, 0, `a baselined leaker does not fail the run (got ${JSON.stringify(r)}); output tail: ${h.out().slice(-400)}`);
  assert.ok(namedLine(h.out(), 'leak.test.mjs'), `it is still reported by name with its entry count (output tail: ${h.out().slice(-500)})`);
  assert.deepEqual(w.left(), [], 'nothing is left in the outer TMPDIR');
}));

test('RG3 a baselined file that comes back clean is reported as a candidate for removal and does NOT fail the run', { timeout: 120000 }, () => withWorld(async (w) => {
  const h = w.start([w.f('clean.test.mjs')], w.baseline([w.f('clean.test.mjs')]));
  const r = await finish(h, 90000);
  assert.equal(r.code, 0, `a flapping leaker must not block a landing: a stale baseline entry is reported, not failed (got ${JSON.stringify(r)}); output tail: ${h.out().slice(-400)}`);
  assert.ok(h.out().split('\n').some((l) => l.includes('clean.test.mjs') && /candidate/i.test(l)), `the output names clean.test.mjs as a candidate for removal from the baseline (output tail: ${h.out().slice(-500)})`);
}));

test('RE SIGTERM to the runner while a file hangs: the runner, the file and its detached survivor are gone within 20 s and no suite folder is left', { timeout: 120000 }, () => withWorld(async (w) => {
  const pidFile = path.join(w.res, 'hang.pid'); const survPidFile = path.join(w.res, 'hang-survivor.pid');
  const h = w.start([w.f('hang.test.mjs')], { PID_FILE: pidFile, SURVIVOR_PID_FILE: survPidFile });
  for (let t = 0; t < 30000 && !fs.existsSync(pidFile); t += 100) await sleep(100);
  assert.ok(fs.existsSync(pidFile), 'CONTROL: the hanging fixture started and recorded its pid');
  const hangPid = Number(fs.readFileSync(pidFile, 'utf8')); const survPid = Number(fs.readFileSync(survPidFile, 'utf8'));
  process.kill(h.child.pid, 'SIGTERM');
  const r = await finish(h, 20000);
  for (let t = 0; t < 5000 && (alive(hangPid) || alive(survPid)); t += 100) await sleep(100);
  const suiteFolders = w.left().filter((n) => n.startsWith('manyhands-suite.'));
  assert.deepEqual({ runnerGone: r.code !== 'TIMEOUT', hangingFileGone: !alive(hangPid), survivorGone: !alive(survPid), suiteFolders, outerLeft: w.left() }, { runnerGone: true, hangingFileGone: true, survivorGone: true, suiteFolders: [], outerLeft: [] },
    'after SIGTERM to the runner (the runner\'s own run-tests.* temp files count: a TERMed run leaves nothing behind either)');
}));
