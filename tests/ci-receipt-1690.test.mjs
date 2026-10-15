/**
 * #1690 — the CI leg's receipt has to leave the runner without leaving it as a file (#837 forbids uploading artifacts from this public workflow), so the checker PRINTS it, and a person
 * (or a script) later recovers it from the job log of a SPECIFIED run attempt to feed `check-gate-pair.mjs`. This file pins that recovery. The room's requirements, in order:
 *
 *   · the printed receipt is one marked line, `PLATFORM-RECEIPT {json}`, and it IS the receipt the file holds
 *   · the JSON is on a STRICT field allowlist, and carries nothing #837 bans: no env, no secrets, no absolute path
 *   · extraction reads only the dedicated checker step of the named job in a specified run attempt, never a matching line anywhere in the suite log
 *   · the receipt's sha is verified against that run's head sha; missing, ambiguous or mismatched evidence fails closed
 *
 * INTERFACES THESE ROWS PROPOSE (the builder may rename them; the rows then follow):
 *   scripts/check-platform-skips.mjs  prints exactly one line `PLATFORM-RECEIPT <json>` on stdout whenever it reaches a verdict (exit 0 or 1), and none when it cannot check (exit 2)
 *   scripts/extract-ci-receipt.mjs <log-file> --run-id <n> --attempt <n> --head-sha <40-hex> [--job <name>] [--step <name>] [--out <file>]
 *       <log-file> is `gh run view <run> --attempt <n> --log` output: every line is `<job>\t<step>\t<timestamp> <text>`.
 *       --job and --step default to the names in .github/workflows/ci.yml. Exit 0 extracted · 1 the receipt's sha is not --head-sha · 2 cannot extract (fails closed).
 *
 * ALLOWLIST (exactly these keys, no others): leg, sha, tree, manifestSha256, suiteExit, ok, matched, problems, at.
 *   leg 'ci'; sha and tree 40-hex; manifestSha256 64-hex; suiteExit an integer; ok a boolean; matched an integer or null; problems an array of strings each at most 400 characters; at a string.
 *
 * Rows that expect exit 1 or 2 also assert the output names what was wrong, and each script's existence is asserted first (node exits 1 for a missing script).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = path.join(REPO, 'scripts', 'check-platform-skips.mjs');
const EXTRACT = path.join(REPO, 'scripts', 'extract-ci-receipt.mjs');
const PAIR = path.join(REPO, 'scripts', 'check-gate-pair.mjs');

const dirs = [];
const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cireceipt-1690-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const cleanEnv = (extra = {}) => { const e = { ...process.env, ...extra }; delete e.NODE_TEST_CONTEXT; return e; };
async function exec(script, args, opts = {}) {
  assert.ok(fs.existsSync(script), `${path.relative(REPO, script)} must exist`);
  try {
    const { stdout, stderr } = await run(process.execPath, [script, ...args], { cwd: REPO, timeout: 120000, ...opts, env: cleanEnv(opts.env) });
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

// ------------------------------------------------------------ the checker prints its receipt

const PLATFORM = [
  { name: 'P1 NO REACH: the sandbox keeps the decoy out', reason: 'UNAVAILABLE: no sandbox-exec on this machine (a skip is not a pass)' },
  { name: 'P2 THE RUNNER cannot inspect processes', reason: 'UNAVAILABLE: inspection failure can only be injected through `ps` on macOS' },
];
function tap({ extra = [], skips = PLATFORM } = {}) {
  let n = 600;
  return ['TAP version 13', 'ok 1 - an ordinary test', ...skips.map((t) => `ok ${n++} - ${t.name} # SKIP ${t.reason}`), ...extra, '# tests 3', '# pass 1', ''].join('\n');
}
const ALLOWED = ['leg', 'sha', 'tree', 'manifestSha256', 'suiteExit', 'ok', 'matched', 'problems', 'at'];

function setup({ tapText = tap(), env = {}, suiteExit = '0' } = {}) {
  const d = mk();
  const repo = repoDir();
  const tapPath = path.join(d, 'out.tap');
  const manPath = path.join(d, 'manifest.json');
  fs.writeFileSync(tapPath, tapText);
  fs.writeFileSync(manPath, JSON.stringify(PLATFORM.map((t) => ({ file: 'tests/x.test.mjs', name: t.name, reason: t.reason }))));
  const receipt = path.join(d, 'ci-receipt.json');
  const args = [tapPath, '--manifest', manPath, '--root', repo.dir, '--sha', repo.head, '--suite-exit', suiteExit, '--receipt', receipt];
  return { d, repo, tapPath, manPath, receipt, args, env, sha: repo.head };
}
const markedLines = (stdout) => stdout.split('\n').filter((l) => l.startsWith('PLATFORM-RECEIPT '));

test('#1690 (P1) CONTROL — a clean verdict prints exactly one marked line whose JSON IS the receipt file, on the allowlist', async () => {
  const s = setup();
  const r = await exec(CHECK, s.args, { env: s.env });
  assert.equal(r.code, 0, r.out);
  const lines = markedLines(r.stdout);
  assert.equal(lines.length, 1, 'exactly one marked line');
  const printed = JSON.parse(lines[0].slice('PLATFORM-RECEIPT '.length));
  assert.deepEqual(printed, JSON.parse(fs.readFileSync(s.receipt, 'utf8')), 'the printed receipt is the file’s receipt');
  assert.deepEqual(Object.keys(printed).filter((k) => !ALLOWED.includes(k)), [], 'no key outside the allowlist');
  for (const k of ['leg', 'sha', 'tree', 'manifestSha256', 'suiteExit', 'ok', 'problems']) assert.ok(k in printed, `has ${k}`);
  assert.equal(printed.leg, 'ci');
  assert.equal(printed.sha, s.sha);
  assert.equal(printed.ok, true);
});

test('#1690 (P2) a NOT-clean verdict prints the marked line too, with ok:false and the problems', async () => {
  const s = setup({ tapText: tap({ extra: ['not ok 7 - X1 an ordinary test that FAILS'] }) });
  const r = await exec(CHECK, s.args, { env: s.env });
  assert.equal(r.code, 1, r.out);
  const lines = markedLines(r.stdout);
  assert.equal(lines.length, 1);
  const printed = JSON.parse(lines[0].slice('PLATFORM-RECEIPT '.length));
  assert.equal(printed.ok, false);
  assert.ok(printed.problems.some((p) => p.includes('X1 an ordinary test that FAILS')), 'names the failing test');
});

test('#1690 (P3) the printed line carries nothing #837 bans: no environment value, no absolute path', async () => {
  const s = setup({ env: { SECRET_TOKEN: 's3cr3t-value-for-the-row', HOME: '/home/someone-else' } });
  const r = await exec(CHECK, s.args, { env: s.env });
  assert.equal(r.code, 0, r.out);
  const line = markedLines(r.stdout)[0];
  assert.ok(line, 'a marked line');
  assert.ok(!line.includes('s3cr3t-value-for-the-row'), 'no env value');
  assert.ok(!line.includes('/home/someone-else'), 'no home directory');
  assert.ok(!line.includes(REPO), 'no absolute repo path');
  assert.ok(!line.includes(s.d) && !line.includes(s.repo.dir), 'no absolute temp path');
  assert.ok(!/\/(home|Users|tmp|var)\//.test(line), 'no absolute path of any kind');
});

test('#1690 (P4) FAILS CLOSED: when the checker cannot check (exit 2) it prints NO marked line', async () => {
  const s = setup();
  const r = await exec(CHECK, s.args.filter((a, i, all) => a !== '--suite-exit' && all[i - 1] !== '--suite-exit'), { env: s.env });
  assert.equal(r.code, 2, r.out);
  assert.equal(markedLines(r.stdout).length, 0, 'an uncheckable run leaves no receipt line for anyone to mistake');
});

test('#1690 (P5) a test name with quotes, a backslash and non-ASCII still prints ONE line that parses', async () => {
  const odd = { name: 'Q1 "quoted" \\ back — naïve ✓ test', reason: 'UNAVAILABLE: x' };
  const s = setup({ tapText: tap({ extra: [`not ok 9 - ${odd.name}`] }) });
  const r = await exec(CHECK, s.args, { env: s.env });
  const lines = markedLines(r.stdout);
  assert.equal(lines.length, 1);
  const printed = JSON.parse(lines[0].slice('PLATFORM-RECEIPT '.length));
  assert.ok(printed.problems.some((p) => p.includes('naïve ✓')), 'the odd name survives the round trip');
});

test('#1690 (P6) a failing test with a very long name still prints a receipt every problem of which fits the allowlist (400 characters), and the file matches', async () => {
  const long = `L1 ${'very long test name '.repeat(40)}`;
  const s = setup({ tapText: tap({ extra: [`not ok 9 - ${long}`] }) });
  const r = await exec(CHECK, s.args, { env: s.env });
  assert.equal(r.code, 1, r.out);
  const printed = JSON.parse(markedLines(r.stdout)[0].slice('PLATFORM-RECEIPT '.length));
  assert.ok(printed.problems.length >= 1 && printed.problems.every((p) => p.length <= 400), 'each problem is at most 400 characters');
  assert.deepEqual(printed, JSON.parse(fs.readFileSync(s.receipt, 'utf8')), 'and the file holds the same receipt');
});

// ------------------------------------------------------------ extraction from a specified run attempt

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const JOB = 'server suite';
const STEP = 'Platform-only skips equal the manifest';
const ts = (i) => `2026-10-14T21:${String(10 + i).padStart(2, '0')}:00.0000000Z`;
const logLine = (job, step, text, i = 0) => `${job}\t${step}\t${ts(i)} ${text}`;
const receipt = (over = {}) => ({
  leg: 'ci', sha: HEAD, tree: 'c'.repeat(40), manifestSha256: 'd'.repeat(64), suiteExit: 0, ok: true, matched: 2, problems: [], at: '2026-10-14T21:30:00.000Z', ...over,
});
const marker = (r) => `PLATFORM-RECEIPT ${typeof r === 'string' ? r : JSON.stringify(r)}`;

function makeLog(lines) {
  const d = mk();
  const f = path.join(d, 'job.log');
  fs.writeFileSync(f, `${lines.join('\n')}\n`);
  return { d, f, out: path.join(d, 'ci.json') };
}
const noise = [
  logLine(JOB, 'Set up job', 'Current runner version: 2.3'),
  logLine(JOB, 'Run the server suite', 'ok 1 - an ordinary test', 1),
  logLine('browser suite', 'Run the browser suite', 'ok 1 - a browser test', 1),
];
const extract = (l, flags = {}, extra = []) => exec(EXTRACT, [
  l.f, '--run-id', flags.runId ?? '38636094051', '--attempt', flags.attempt ?? '1', '--head-sha', flags.headSha ?? HEAD, '--out', l.out, ...extra,
]);

test('#1690 (X1) CONTROL — one marked line in the checker step: extracted to a file equal to the printed receipt, naming the run and attempt', async () => {
  const r0 = receipt();
  const l = makeLog([...noise, logLine(JOB, STEP, marker(r0), 3)]);
  const r = await extract(l);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(JSON.parse(fs.readFileSync(l.out, 'utf8')), r0);
  assert.ok(r.out.includes('38636094051') && /attempt\D{0,3}1\b/i.test(r.out), 'says which run and attempt it read');
});

test('#1690 (X2) a marked line in ANOTHER step (a test printing the marker) is never taken, even when it is the only one: exit 2', async () => {
  const decoy = receipt({ ok: true, sha: HEAD, matched: 99 });
  const l = makeLog([...noise, logLine(JOB, 'Run the server suite', marker(decoy), 2)]);
  const r = await extract(l);
  assert.equal(r.code, 2, r.out);
  assert.ok(!fs.existsSync(l.out), 'nothing written');
});

test('#1690 (X2b) a decoy in the suite step AND the real line in the checker step: the checker step’s receipt wins', async () => {
  const real = receipt({ matched: 2 });
  const decoy = receipt({ matched: 99, ok: true });
  const l = makeLog([...noise, logLine(JOB, 'Run the server suite', marker(decoy), 2), logLine(JOB, STEP, marker(real), 3)]);
  const r = await extract(l);
  assert.equal(r.code, 0, r.out);
  assert.equal(JSON.parse(fs.readFileSync(l.out, 'utf8')).matched, 2);
});

test('#1690 (X3) the same step name under ANOTHER job is not taken: exit 2', async () => {
  const l = makeLog([...noise, logLine('browser suite', STEP, marker(receipt()), 3)]);
  const r = await extract(l);
  assert.equal(r.code, 2, r.out);
});

test('#1690 (X4) the receipt’s sha is not the run’s head sha: exit 1, naming both', async () => {
  const l = makeLog([...noise, logLine(JOB, STEP, marker(receipt({ sha: OTHER })), 3)]);
  const r = await extract(l, { headSha: HEAD });
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes(OTHER) && r.out.includes(HEAD));
});

test('#1690 (X5) FAILS CLOSED on count: no marked line, two different lines, or even two identical lines in the checker step: exit 2', async () => {
  const none = makeLog([...noise, logLine(JOB, STEP, 'platform skips: nothing printed here', 3)]);
  assert.equal((await extract(none)).code, 2, 'none');
  const two = makeLog([...noise, logLine(JOB, STEP, marker(receipt({ matched: 1 })), 3), logLine(JOB, STEP, marker(receipt({ matched: 2 })), 4)]);
  const r2 = await extract(two);
  assert.equal(r2.code, 2, 'two different');
  assert.match(r2.out, /ambiguous|more than one|two|2 /i);
  const same = makeLog([...noise, logLine(JOB, STEP, marker(receipt()), 3), logLine(JOB, STEP, marker(receipt()), 4)]);
  assert.equal((await extract(same)).code, 2, 'two identical');
});

test('#1690 (X6) FAILS CLOSED on shape: a key outside the allowlist, a missing key, a wrong type, a short sha: exit 2, naming the field', async () => {
  const bad = [
    ['an extra key', receipt({ env: { TOKEN: 'x' } }), 'env'],
    ['a missing key', (() => { const r = receipt(); delete r.tree; return r; })(), 'tree'],
    ['ok as a string', receipt({ ok: 'true' }), 'ok'],
    ['suiteExit as a string', receipt({ suiteExit: '0' }), 'suiteExit'],
    ['a short sha', receipt({ sha: 'abc123' }), 'sha'],
    ['a wrong leg', receipt({ leg: 'mac' }), 'leg'],
    ['problems not an array', receipt({ problems: 'none' }), 'problems'],
    ['a non-string problem', receipt({ problems: [1] }), 'problems'],
    ['an over-long problem', receipt({ problems: ['x'.repeat(401)] }), 'problems'],
    ['a manifest hash of the wrong length', receipt({ manifestSha256: 'abc' }), 'manifestSha256'],
  ];
  for (const [label, r0, field] of bad) {
    const l = makeLog([...noise, logLine(JOB, STEP, marker(r0), 3)]);
    const r = await extract(l);
    assert.equal(r.code, 2, `${label}: ${r.out}`);
    assert.ok(r.out.includes(field), `${label}: names ${field}`);
    assert.ok(!fs.existsSync(l.out), `${label}: nothing written`);
  }
});

test('#1690 (X7) FAILS CLOSED: a marker followed by something that is not JSON, an empty log, or a missing file: exit 2', async () => {
  const notJson = makeLog([...noise, logLine(JOB, STEP, marker('{ not json'), 3)]);
  assert.equal((await extract(notJson)).code, 2, 'not JSON');
  const empty = makeLog([]);
  assert.equal((await extract(empty)).code, 2, 'empty log');
  const l = makeLog(noise);
  fs.rmSync(l.f);
  assert.equal((await extract(l)).code, 2, 'missing file');
});

test('#1690 (X8) FAILS CLOSED on the request: no --run-id, no --attempt, or no --head-sha (or a short one): exit 2', async () => {
  const l = makeLog([...noise, logLine(JOB, STEP, marker(receipt()), 3)]);
  const base = [l.f, '--out', l.out];
  assert.equal((await exec(EXTRACT, [...base, '--attempt', '1', '--head-sha', HEAD])).code, 2, 'no run id');
  assert.equal((await exec(EXTRACT, [...base, '--run-id', '1', '--head-sha', HEAD])).code, 2, 'no attempt');
  assert.equal((await exec(EXTRACT, [...base, '--run-id', '1', '--attempt', '1'])).code, 2, 'no head sha');
  assert.equal((await exec(EXTRACT, [...base, '--run-id', '1', '--attempt', '1', '--head-sha', 'abc'])).code, 2, 'short head sha');
});

test('#1690 (X9) the default job and step names are the workflow’s own: a log built from ci.yml’s names extracts with no --job or --step', async () => {
  const yml = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
  const jobName = /\n  server:\n    name: ([^\n]+)/.exec(yml)?.[1].trim();
  const stepName = /- name: (Platform-only skips[^\n]*)/.exec(yml)?.[1].trim();
  assert.ok(jobName && stepName, 'ci.yml names the server job and the check step');
  const l = makeLog([...noise, logLine(jobName, stepName, marker(receipt()), 3)]);
  const r = await extract(l);
  assert.equal(r.code, 0, r.out);
});

test('#1690 (X10) --job and --step select another job and step when given', async () => {
  const l = makeLog([...noise, logLine('other job', 'other step', marker(receipt()), 3)]);
  const r = await extract(l, {}, ['--job', 'other job', '--step', 'other step']);
  assert.equal(r.code, 0, r.out);
});

// ------------------------------------------------------------ the extracted file completes the pair

function macReceipt(over = {}) {
  const f = path.join(mk(), 'mac.json');
  fs.writeFileSync(f, JSON.stringify({ leg: 'mac', sha: HEAD, tree: 'c'.repeat(40), manifestSha256: 'd'.repeat(64), ok: true, files: ['tests/a.test.mjs'], ...over }));
  return f;
}

test('#1690 (G1) the extracted receipt is accepted by the pair check with a matching Mac receipt', async () => {
  const l = makeLog([...noise, logLine(JOB, STEP, marker(receipt()), 3)]);
  assert.equal((await extract(l)).code, 0);
  const r = await exec(PAIR, [l.out, macReceipt()]);
  assert.equal(r.code, 0, r.out);
});

test('#1690 (G2) …and refused when the Mac receipt is for another tree, or the extracted CI receipt was a red one', async () => {
  const l = makeLog([...noise, logLine(JOB, STEP, marker(receipt()), 3)]);
  assert.equal((await extract(l)).code, 0);
  const other = await exec(PAIR, [l.out, macReceipt({ tree: 'e'.repeat(40) })]);
  assert.equal(other.code, 1, other.out);
  const red = makeLog([...noise, logLine(JOB, STEP, marker(receipt({ ok: false, suiteExit: 1, problems: ['the suite exited 1, not 0'] })), 3)]);
  assert.equal((await extract(red)).code, 0, 'a red receipt is still a faithful receipt');
  const r = await exec(PAIR, [red.out, macReceipt()]);
  assert.equal(r.code, 1, r.out);
});
