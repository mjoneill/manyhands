/**
 * #1693 — L1 latency in its own sequential CI step, and the landing oracle refuses a verdict without L1 evidence for
 * the same head and tree (the #1644 steward rescope, option A, chosen on 2026-10-15).
 *
 * WHAT CAN GO WRONG SILENTLY, and what each group of rows pins:
 *   · L1 moves out of the suite and nothing notices. The suite glob is tests/*.test.mjs (scripts/run-tests.sh), so a
 *     test moved out of it leaves NO skip line, and the #1690 skip gate (which only sees skips) cannot see it missing.
 *     A skip-based exclusion is no way out either: that gate refuses every skip that is not in its manifest.
 *   · the snapshot tests (S1 to S3 and their controls) leave with it, or the nightly stops requiring the L1 file
 *   · the CI receipt, hence the landing verdict, completes with L1 never having run, skipped, red, or half-run
 *   · an old-format CI receipt (no L1 field) still completes the pair
 *   · GitHub enforces nothing on main (no required status checks, no rulesets; read with `gh api` on 2026-10-15), so the
 *     oracle (the receipt and the pair check) is the only enforcement. Row groups C, P and X pin the oracle.
 *
 * INTERFACES THESE ROWS PROPOSE (the builder may rename them; the rows then follow):
 *   tests/latency/ready-executor-1644-latency.test.mjs   the L1 test alone; outside the suite glob
 *   check-platform-skips.mjs ... --l1-tap <file> --l1-exit <n>   both required; absent or malformed: exit 2, no
 *       marked line, no receipt file (it cannot check)
 *   the CI receipt gains ONE allowlisted boolean `l1Ok`: true only if the L1 exit was 0 AND the L1 TAP has the
 *       L1 LATENCY test as a plain `ok` (not skipped, not TODO) AND both phase lines (`# L1 idle:` and
 *       `# L1 loaded`) are present. The overall `ok` is false whenever `l1Ok` is false.
 *   check-gate-pair.mjs: a CI receipt without a boolean l1Ok exits 2; l1Ok false exits 1, naming L1.
 *   extract-ci-receipt.mjs: l1Ok joins the strict allowlist, so a receipt without it, or with a non-boolean one, exits 2.
 *   ci.yml (server job): a step that runs the L1 file by itself, after the suite step and before the checker step;
 *       the checker step passes --l1-tap and an --l1-exit that is a recorded value, never a typed constant.
 *   The existing #1690 rows (ci-receipt-1690, platform-skips-1690) will need `l1Ok` added to their fixtures and to
 *   the allowlist they assert; that is a separate commit and is not done here.
 *
 * Every row that expects exit 1 also asserts the output names the offender. node itself exits 1 for a missing script,
 * so each script's existence is asserted first and the named-offender assertion cannot be met by a stack trace.
 *
 * FIXTURE TAP LINES are shaped like the real ones read from CI run 38657787589: node's TAP reporter prints a test's
 * console output as `# ` comment lines before its `# Subtest:` line; the L1 test prints `L1 idle: ...` and
 * `L1 loaded (6 CPU burners): ...`.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = path.join(REPO, 'scripts', 'check-platform-skips.mjs');
const PAIR = path.join(REPO, 'scripts', 'check-gate-pair.mjs');
const EXTRACT = path.join(REPO, 'scripts', 'extract-ci-receipt.mjs');
const L1_FILE = 'tests/latency/ready-executor-1644-latency.test.mjs';
const SNAPSHOT = 'tests/ready-executor-1644-snapshot.test.mjs';
const L1_NAME = 'L1 LATENCY on a production-sized board: executor p95 <= 1.0 s AND <= 2x the in-process p95, idle and under CPU load';
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const topLevelTests = (src) => [...src.matchAll(/^test\(\s*(['"`])((?:\\.|(?!\1).)*)\1/gm)].map((m) => m[2]);

const dirs = [];
const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'l1step-1693-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const cleanEnv = () => { const e = { ...process.env }; delete e.NODE_TEST_CONTEXT; return e; };
async function exec(script, args) {
  assert.ok(fs.existsSync(script), `${path.relative(REPO, script)} must exist`);
  try {
    const { stdout, stderr } = await run(process.execPath, [script, ...args], { cwd: REPO, timeout: 120000, env: cleanEnv() });
    return { code: 0, stdout, out: `${stdout}\n${stderr}` };
  } catch (e) {
    return { code: typeof e.code === 'number' ? e.code : -1, stdout: e.stdout ?? '', out: `${e.stdout ?? ''}\n${e.stderr ?? ''}` };
  }
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();
function repoDir() {
  const d = mk();
  fs.writeFileSync(path.join(d, 'tracked.txt'), 'one\n');
  git(d, 'init', '-q'); git(d, 'add', '-A');
  git(d, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture');
  return { dir: d, head: git(d, 'rev-parse', 'HEAD'), tree: git(d, 'rev-parse', 'HEAD^{tree}') };
}

// ------------------------------------------------------------------- F: where the tests live

test('#1693 (F1) the L1 test lives alone in its own file, outside the suite glob', () => {
  assert.ok(fs.existsSync(path.join(REPO, L1_FILE)), `${L1_FILE} must exist`);
  const names = topLevelTests(read(L1_FILE));
  assert.equal(names.length, 1, `exactly one top-level test, got: ${JSON.stringify(names)}`);
  assert.ok(names[0].startsWith('L1 LATENCY'), `it is the L1 LATENCY test: ${names[0]}`);
  assert.ok(!/^tests\/[^/]+\.test\.mjs$/.test(L1_FILE), 'its path is not matched by the suite glob tests/*.test.mjs');
});

test('#1693 (F2) the snapshot file keeps S1, S1-CONTROL, S2, S2-CONTROL and S3, and no longer holds L1', () => {
  const names = topLevelTests(read(SNAPSHOT));
  for (const prefix of ['S1 SNAPSHOT', 'S1-CONTROL', 'S2 TWO WRITERS', 'S2-CONTROL', 'S3 SNAPSHOT WITHIN ONE QUERY']) {
    assert.ok(names.some((n) => n.startsWith(prefix)), `still has ${prefix}`);
  }
  assert.deepEqual(names.filter((n) => n.startsWith('L1 LATENCY')), [], 'L1 has left this file');
});

test('#1693 (F3) no file the suite runs (tests/*.test.mjs) contains the L1 LATENCY test: it runs once, alone, not in the suite', () => {
  const files = fs.readdirSync(path.join(REPO, 'tests')).filter((f) => f.endsWith('.test.mjs'));
  assert.ok(files.length > 100, `the glob really lists the suite (${files.length} files)`);
  // this file quotes the test's name in its fixtures; it is a row about L1, not the test itself
  const holders = files.filter((f) => f !== path.basename(fileURLToPath(import.meta.url))
    && topLevelTests(read(path.join('tests', f))).some((n) => n.startsWith('L1 LATENCY')));
  assert.deepEqual(holders, [], 'a suite file still carries the L1 test');
});

test('#1693 (F4) the nightly suite watch requires the new L1 file, and still requires the snapshot file', () => {
  const required = JSON.parse(read('scripts/suite-watch-required.json'));
  assert.ok(Array.isArray(required), 'the required list is an array');
  assert.ok(required.includes(L1_FILE), `the required list names ${L1_FILE}`);
  assert.ok(required.includes(SNAPSHOT), 'and still names the snapshot file');
});

// ------------------------------------------------------------------- W: the workflow runs it as its own step

const serverJob = () => {
  const yml = read('.github/workflows/ci.yml');
  const a = yml.search(/^ {2}server:/m);
  const b = yml.search(/^ {2}browser:/m);
  assert.ok(a >= 0 && b > a, 'the server job is found in ci.yml');
  return yml.slice(a, b);
};

test('#1693 (W1) ci.yml runs the L1 file in its own step, after the suite step and before the checker step', () => {
  const job = serverJob();
  const suite = job.indexOf('Run the server suite');
  const l1 = job.indexOf(L1_FILE);
  const checker = job.indexOf('check-platform-skips.mjs');
  assert.ok(suite >= 0 && checker >= 0, 'the suite step and the checker step are found');
  assert.ok(l1 >= 0, `a step names ${L1_FILE}`);
  assert.ok(suite < l1 && l1 < checker, 'order: suite step, then the L1 step, then the checker step');
});

test('#1693 (W2) the checker step is handed the L1 TAP and a recorded L1 exit status, never a typed constant', () => {
  const job = serverJob();
  const checker = job.slice(job.indexOf('check-platform-skips.mjs'));
  assert.ok(/--l1-tap\s+\S+/.test(checker), 'passes --l1-tap');
  const m = checker.match(/--l1-exit\s+("[^"]*"|'[^']*'|\S+)/);
  assert.ok(m, 'passes --l1-exit');
  assert.ok(!/^["']?\d+["']?$/.test(m[1]), `--l1-exit is a recorded value, not the constant ${m[1]}`);
});

// ------------------------------------------------------------------- C: the CI-side checker

const PLATFORM = [
  { name: 'P1 NO REACH: the sandbox keeps the decoy out', reason: 'UNAVAILABLE: no sandbox-exec on this machine (a skip is not a pass)' },
  { name: 'P2 THE RUNNER cannot inspect processes', reason: 'UNAVAILABLE: inspection failure can only be injected through `ps` on macOS' },
];
const suiteTap = () => ['TAP version 13', 'ok 1 - an ordinary test', ...PLATFORM.map((t, i) => `ok ${600 + i} - ${t.name} # SKIP ${t.reason}`), '# tests 3', '# pass 1', ''].join('\n');
const IDLE = '# L1 idle: load1=2.00  in-process n=40 p50=80 p95=120 ms | executor n=40 p50=150 p95=210 ms (ratio 1.75; 40 readiness queries on the executor leg, 0 on the in-process leg; responses said off:replica, on:executor)';
const LOADED = '# L1 loaded (6 CPU burners): load1=9.00  in-process n=40 p50=200 p95=300 ms | executor n=40 p50=380 p95=520 ms (ratio 1.73; 40 readiness queries on the executor leg, 0 on the in-process leg; responses said off:replica, on:executor)';
function l1tap({ status = 'ok', idle = true, loaded = true, name = L1_NAME } = {}) {
  const result = {
    ok: `ok 1 - ${name}`,
    skip: `ok 1 - ${name} # SKIP the executor venv is missing`,
    fail: `not ok 1 - ${name}`,
    todo: `not ok 1 - ${name} # TODO not yet`,
    absent: 'ok 1 - some other test entirely',
  }[status];
  return ['TAP version 13', ...(idle ? [IDLE] : []), ...(loaded ? [LOADED] : []), `# Subtest: ${name}`, result, '# tests 1', '# pass 1', ''].join('\n');
}
function setup({ l1 = l1tap(), l1Exit = '0' } = {}) {
  const d = mk();
  const repo = repoDir();
  const files = { tap: path.join(d, 'suite.tap'), man: path.join(d, 'manifest.json'), l1: path.join(d, 'l1.tap'), receipt: path.join(d, 'ci-receipt.json') };
  fs.writeFileSync(files.tap, suiteTap());
  fs.writeFileSync(files.man, JSON.stringify(PLATFORM.map((t) => ({ file: 'tests/x.test.mjs', name: t.name, reason: t.reason }))));
  if (l1 !== null) fs.writeFileSync(files.l1, l1);
  const base = [files.tap, '--manifest', files.man, '--root', repo.dir, '--sha', repo.head, '--suite-exit', '0', '--receipt', files.receipt];
  const l1args = [...(l1 === null ? [] : ['--l1-tap', files.l1]), ...(l1Exit === null ? [] : ['--l1-exit', l1Exit])];
  return { d, repo, files, base, args: [...base, ...l1args] };
}
const marked = (stdout) => stdout.split('\n').filter((l) => l.startsWith('PLATFORM-RECEIPT '));
const printed = (r) => JSON.parse(marked(r.stdout)[0].slice('PLATFORM-RECEIPT '.length));

test('#1693 (C1) CONTROL — a clean suite and a clean L1 step: exit 0, and the receipt says l1Ok:true both printed and in the file', async () => {
  const s = setup();
  const r = await exec(CHECK, s.args);
  assert.equal(r.code, 0, r.out);
  assert.equal(marked(r.stdout).length, 1);
  assert.equal(printed(r).l1Ok, true);
  assert.deepEqual(printed(r), JSON.parse(fs.readFileSync(s.files.receipt, 'utf8')));
  assert.equal(printed(r).ok, true);
});

test('#1693 (C2) FAILS CLOSED: no --l1-tap, or no --l1-exit, or a non-numeric one: exit 2, no marked line, no receipt file', async () => {
  for (const [label, s] of [
    ['no --l1-tap', setup({ l1: null })],
    ['no --l1-exit', setup({ l1Exit: null })],
    ['a non-numeric --l1-exit', setup({ l1Exit: 'zero' })],
    ['an empty --l1-exit', setup({ l1Exit: '' })],
  ]) {
    const r = await exec(CHECK, s.args);
    assert.equal(r.code, 2, `${label}: ${r.out}`);
    assert.equal(marked(r.stdout).length, 0, `${label}: no marked line`);
    assert.ok(!fs.existsSync(s.files.receipt), `${label}: no receipt file`);
  }
});

test('#1693 (C3) FAILS CLOSED: an L1 TAP that is missing, empty, or has no test line: exit 2', async () => {
  for (const [label, text] of [['empty', ''], ['no test line', 'TAP version 13\n# tests 0\n']]) {
    const s = setup({ l1: text });
    const r = await exec(CHECK, s.args);
    assert.equal(r.code, 2, `${label}: ${r.out}`);
    assert.equal(marked(r.stdout).length, 0, `${label}: no marked line`);
  }
  const s = setup();
  fs.rmSync(s.files.l1);
  assert.equal((await exec(CHECK, s.args)).code, 2, 'a missing file');
});

test('#1693 (C4) the L1 test SKIPPED is not a pass: exit 1, l1Ok:false, overall ok:false, and it names the L1 test', async () => {
  const s = setup({ l1: l1tap({ status: 'skip' }) });
  const r = await exec(CHECK, s.args);
  assert.equal(r.code, 1, r.out);
  assert.equal(printed(r).l1Ok, false);
  assert.equal(printed(r).ok, false);
  assert.ok(printed(r).problems.some((p) => p.includes('L1 LATENCY')), 'names the L1 test');
});

test('#1693 (C5) the L1 test FAILED, or marked TODO: exit 1, l1Ok:false, naming it', async () => {
  for (const status of ['fail', 'todo']) {
    const s = setup({ l1: l1tap({ status }) });
    const r = await exec(CHECK, s.args);
    assert.equal(r.code, 1, `${status}: ${r.out}`);
    assert.equal(printed(r).l1Ok, false, status);
    assert.ok(printed(r).problems.some((p) => p.includes('L1 LATENCY')), `${status}: names the L1 test`);
  }
});

test('#1693 (C6) a clean-looking L1 TAP but a NON-ZERO L1 exit (the "fail 0, exit 1" shape): exit 1, l1Ok:false, saying the exit', async () => {
  const s = setup({ l1Exit: '1' });
  const r = await exec(CHECK, s.args);
  assert.equal(r.code, 1, r.out);
  assert.equal(printed(r).l1Ok, false);
  assert.ok(printed(r).problems.some((p) => /L1/.test(p) && /exit/i.test(p)), 'the problem says the L1 step exited non-zero');
});

test('#1693 (C7) a phase that never ran: the idle line missing, or the loaded line missing, is not a pass; it names the phase', async () => {
  for (const [phase, opts] of [['idle', { idle: false }], ['loaded', { loaded: false }]]) {
    const s = setup({ l1: l1tap(opts) });
    const r = await exec(CHECK, s.args);
    assert.equal(r.code, 1, `${phase}: ${r.out}`);
    assert.equal(printed(r).l1Ok, false, phase);
    assert.ok(printed(r).problems.some((p) => p.toLowerCase().includes(phase)), `${phase}: the problem names the phase`);
  }
});

test('#1693 (C8) a TAP with no L1 LATENCY test at all (some other test passed): exit 1, l1Ok:false', async () => {
  const s = setup({ l1: l1tap({ status: 'absent' }) });
  const r = await exec(CHECK, s.args);
  assert.equal(r.code, 1, r.out);
  assert.equal(printed(r).l1Ok, false);
  assert.ok(printed(r).problems.some((p) => p.includes('L1 LATENCY')), 'says the L1 test is absent');
});

test('#1693 (C9) a red L1 makes the overall verdict red even though the suite and its skips are clean; `matched` is null', async () => {
  const s = setup({ l1: l1tap({ status: 'fail' }) });
  const r = await exec(CHECK, s.args);
  assert.equal(r.code, 1, r.out);
  assert.equal(printed(r).ok, false);
  assert.equal(printed(r).matched, null);
  assert.equal(printed(r).suiteExit, 0, 'the suite itself exited 0: the red comes from L1 alone');
});

// ------------------------------------------------------------------- P: the pair check

const SHA = 'a'.repeat(40);
const TREE = 'c'.repeat(40);
const MAN = 'd'.repeat(64);
const ci = (over = {}) => ({ leg: 'ci', sha: SHA, tree: TREE, manifestSha256: MAN, suiteExit: 0, ok: true, matched: 6, l1Ok: true, problems: [], at: '2026-10-15T12:00:00.000Z', ...over });
const mac = (over = {}) => ({ leg: 'mac', sha: SHA, tree: TREE, manifestSha256: MAN, ok: true, files: ['tests/a.test.mjs'], problems: [], at: '2026-10-15T12:00:00.000Z', ...over });
function pairFiles(ciR, macR) {
  const d = mk();
  const c = path.join(d, 'ci.json'); const m = path.join(d, 'mac.json');
  fs.writeFileSync(c, typeof ciR === 'string' ? ciR : JSON.stringify(ciR));
  fs.writeFileSync(m, JSON.stringify(macR));
  return [c, m];
}

test('#1693 (P1) CONTROL — both legs clean and the CI receipt carries l1Ok:true: the pair is complete', async () => {
  const r = await exec(PAIR, pairFiles(ci(), mac()));
  assert.equal(r.code, 0, r.out);
});

test('#1693 (P2) FAILS CLOSED: a CI receipt with no l1Ok (the old format, or an L1 that never ran) cannot complete the pair: exit 2', async () => {
  const old = ci(); delete old.l1Ok;
  const r = await exec(PAIR, pairFiles(old, mac()));
  assert.equal(r.code, 2, r.out);
  assert.ok(/l1/i.test(r.out), 'says it is the L1 evidence that is missing');
});

test('#1693 (P3) l1Ok:false cannot complete the pair even when ok:true and suiteExit:0 say clean: exit 1, naming L1', async () => {
  const r = await exec(PAIR, pairFiles(ci({ l1Ok: false, ok: true, suiteExit: 0 }), mac()));
  assert.equal(r.code, 1, r.out);
  assert.ok(/L1/.test(r.out), 'names L1');
});

test('#1693 (P4) FAILS CLOSED: a non-boolean l1Ok ("true", 1, null) is never read as true: exit 2', async () => {
  for (const bad of ['true', 1, null]) {
    const r = await exec(PAIR, pairFiles(ci({ l1Ok: bad }), mac()));
    assert.equal(r.code, 2, `${JSON.stringify(bad)}: ${r.out}`);
  }
});

// ------------------------------------------------------------------- X: recovering the receipt from the log

const HEAD = SHA;
const JOB = 'server suite';
const STEP = 'Platform-only skips equal the manifest';
const ts = (i) => `2026-10-15T12:${String(10 + i).padStart(2, '0')}:00.0000000Z`;
const logLine = (step, text, i = 0) => `${JOB}\t${step}\t${ts(i)} ${text}`;
function logWith(receiptObj) {
  const d = mk();
  const f = path.join(d, 'job.log');
  fs.writeFileSync(f, `${[logLine('Set up job', 'runner', 0), logLine(STEP, `PLATFORM-RECEIPT ${JSON.stringify(receiptObj)}`, 3)].join('\n')}\n`);
  return { f, out: path.join(d, 'ci.json') };
}
const extract = (l) => exec(EXTRACT, [l.f, '--run-id', '38657787589', '--attempt', '1', '--head-sha', HEAD, '--out', l.out]);

test('#1693 (X1) CONTROL — a receipt with l1Ok:true is extracted whole, l1Ok preserved', async () => {
  const l = logWith(ci());
  const r = await extract(l);
  assert.equal(r.code, 0, r.out);
  assert.equal(JSON.parse(fs.readFileSync(l.out, 'utf8')).l1Ok, true);
});

test('#1693 (X2) FAILS CLOSED: a receipt with no l1Ok, or a non-boolean one, is not extracted: exit 2, nothing written', async () => {
  const noField = ci(); delete noField.l1Ok;
  for (const [label, rec] of [['missing', noField], ['a string', ci({ l1Ok: 'true' })], ['null', ci({ l1Ok: null })]]) {
    const l = logWith(rec);
    const r = await extract(l);
    assert.equal(r.code, 2, `${label}: ${r.out}`);
    assert.ok(!fs.existsSync(l.out), `${label}: nothing written`);
  }
});
