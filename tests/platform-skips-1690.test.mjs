/**
 * #1690 — the landing gate split by platform (decision 45a5d8e4): CI runs every test it can with the executor
 * venv; the Mac runs only the NAMED tests CI cannot; no test is dropped because it will not run on CI.
 *
 * WHAT CAN GO WRONG SILENTLY, and what each group of rows pins:
 *   · the list of platform-only tests shrinks or grows without anyone deciding it (a skip is not a pass)
 *   · a skip for any OTHER reason hides on the CI leg
 *   · the Mac leg runs the wrong set (the whole suite, or the L1 burner file) or passes while a named test never ran
 *   · the two legs are judged at different commits or against different manifests
 *   · a checker that cannot read its input says "clean" (empty is not clean)
 *
 * INTERFACES THESE ROWS PROPOSE (the builder may rename them; the rows then follow):
 *   tests/platform-only-manifest.json              [{ file, name, reason }, ...]
 *   scripts/check-platform-skips.mjs <tap> --manifest <path> --sha <sha> [--receipt <path>]
 *   scripts/run-platform-only.mjs --manifest <path> --root <dir> --sha <sha> [--receipt <path>]
 *   scripts/check-gate-pair.mjs <ci-receipt> <mac-receipt>
 *   Exit 0 clean · 1 mismatch (stdout or stderr NAMES the test, file or sha) · 2 could not check (fails closed).
 *

 * ADDED AFTER REVIEW OF THE FIRST BUILD (1c1a6de): the first build trusted what it was told. Three findings, each
 * asserted below on the PRINTED output and the receipt:
 *   · the Mac leg read only the TAP of the named tests, so a child that exited non-zero (or was killed) after they
 *     passed still read clean
 *   · the CI leg judged skips only, so a failing suite, a `# fail N` summary or a non-zero suite exit still read clean
 *   · the commit was whatever string the caller declared; now the declared sha must equal the checked-out HEAD, the
 *     receipt carries the TREE hash, tracked changes are refused, and the pair must agree on the tree
 *   Interface additions: `--suite-exit <n>` and `--root <dir>` on check-platform-skips.mjs (required); receipts gain
 *   `tree` (git HEAD^{tree}) and, for the CI leg, `suiteExit`. A declared sha that is not the checked-out HEAD, a
 *   missing or malformed sha, or modified tracked files exit 2 (the tool cannot attest what was tested).
 *
 * Every row that expects exit 1 also asserts the output names the offender. node itself exits 1 for a missing
 * script, so a row that only looked at the exit code would pass before anything is built; each script's existence
 * is asserted first, and the named-offender assertion cannot be met by a stack trace.
 *
 * FIXTURE TAP LINES are shaped like the real ones read from CI run 38620804697: a skipped test prints
 * `ok N - <name> # SKIP UNAVAILABLE: <reason>`; a TODO prints `not ok N - <name> # TODO ...` and is not a skip;
 * a test whose NAME contains the word UNAVAILABLE but ran is a plain `ok` line.
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
const MAC = path.join(REPO, 'scripts', 'run-platform-only.mjs');
const PAIR = path.join(REPO, 'scripts', 'check-gate-pair.mjs');
const REAL_MANIFEST = path.join(REPO, 'tests', 'platform-only-manifest.json');

const dirs = [];
const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'platskip-1690-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// These rows run under `node --test`, which sets NODE_TEST_CONTEXT for its children; a nested `node --test` that
// inherits it reports through the parent's channel instead of printing TAP. The scripts are run as a person or CI
// would run them, so that variable is removed from their environment.
const cleanEnv = (extra = {}) => { const e = { ...process.env, ...extra }; delete e.NODE_TEST_CONTEXT; return e; };
async function exec(script, args, opts = {}) {
  assert.ok(fs.existsSync(script), `${path.relative(REPO, script)} must exist`);
  try {
    const { stdout, stderr } = await run(process.execPath, [script, ...args], { cwd: REPO, timeout: 120000, ...opts, env: cleanEnv(opts.env && { MARKER: opts.env.MARKER }) });
    return { code: 0, out: `${stdout}\n${stderr}` };
  } catch (e) {
    return { code: typeof e.code === 'number' ? e.code : -1, out: `${e.stdout ?? ''}\n${e.stderr ?? ''}` };
  }
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();
/** Commit everything currently in `dir` as a tiny repo; returns its HEAD and tree. */
function commitAll(dir) {
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture');
  return { head: git(dir, 'rev-parse', 'HEAD'), tree: git(dir, 'rev-parse', 'HEAD^{tree}') };
}
function repoDir() {
  const d = mk();
  fs.writeFileSync(path.join(d, 'tracked.txt'), 'one\n');
  return { dir: d, ...commitAll(d) };
}
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ------------------------------------------------------------------- the CI-side checker

const PLATFORM = [
  { name: 'P1 NO REACH: the sandbox keeps the decoy out', reason: 'UNAVAILABLE: no sandbox-exec on this machine (a skip is not a pass)' },
  { name: 'P2 NO KILL: every way of signalling the decoy leaves it alive', reason: 'UNAVAILABLE: no sandbox-exec on this machine (a skip is not a pass)' },
  { name: 'P3 THE RUNNER cannot inspect processes: the run fails and says why', reason: 'UNAVAILABLE: inspection failure can only be injected through `ps` on macOS' },
];
const skipLine = (n, t) => `ok ${n} - ${t.name} # SKIP ${t.reason}`;
const NOISE = [
  'ok 1 - an ordinary test',
  // the trap: UNAVAILABLE in the NAME of a test that ran
  'ok 336 - UNAVAILABLE: missing marker yields UNAVAILABLE, never empty',
  'ok 337 - UNAVAILABLE: query transport failure yields UNAVAILABLE',
  // TODO rows are not skips
  'not ok 373 - T3 the reader implements the read-back rule # TODO NOT IN THIS FILE: R1',
  'not ok 378 - U5e the fields survive the rollback export # TODO OWED once a script exists: a row, not a pass',
  'ok 4001 - another ordinary test',
];
function tap({ skips = PLATFORM, extra = [] } = {}) {
  let n = 600;
  return [`TAP version 13`, ...NOISE, ...skips.map((t) => skipLine(n++, t)), ...extra, `# tests ${NOISE.length + skips.length + extra.length}`, `# pass 1`].join('\n') + '\n';
}
function setup({ tapText = tap(), manifest = PLATFORM.map((t) => ({ file: 'tests/x.test.mjs', name: t.name, reason: t.reason })) } = {}) {
  const d = mk();
  const tapPath = path.join(d, 'out.tap');
  const manPath = path.join(d, 'manifest.json');
  fs.writeFileSync(tapPath, tapText);
  fs.writeFileSync(manPath, typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  const repo = repoDir();
  return { d, tapPath, manPath, receipt: path.join(d, 'ci-receipt.json'), repo, sha: repo.head };
}
// the suite's own exit status is a required input of the CI leg; 0 here unless a row says otherwise
const check = (s, extra = []) => exec(CHECK, [s.tapPath, '--manifest', s.manPath, '--root', s.repo.dir, '--sha', s.sha, '--suite-exit', '0', '--receipt', s.receipt, ...extra]);
const checkWith = (s, args) => exec(CHECK, [s.tapPath, '--manifest', s.manPath, '--receipt', s.receipt, ...args]);

test('#1690 (C1) CONTROL — the skip set equals the manifest, with UNAVAILABLE-named tests that ran and TODO rows in the stream: clean', async () => {
  const s = setup();
  const r = await check(s);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /3/, 'says how many platform-only skips it matched');
});

test('#1690 (C2) a test named in the manifest RAN instead of skipping: refused, and named', async () => {
  const s = setup({ tapText: tap({ skips: PLATFORM.slice(0, 2), extra: [`ok 700 - ${PLATFORM[2].name}`] }) });
  const r = await check(s);
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes(PLATFORM[2].name), 'names the test that did not skip');
});

test('#1690 (C3) an UNAVAILABLE skip that is NOT in the manifest: refused, and named (the list grew without a decision)', async () => {
  const stray = { name: 'P9 a new platform skip nobody listed', reason: 'UNAVAILABLE: needs a thing' };
  const s = setup({ tapText: tap({ skips: [...PLATFORM, stray] }) });
  const r = await check(s);
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes(stray.name));
});

test('#1690 (C3b) the drop-one mutant: the manifest loses one name while the suite still skips it: refused, naming the dropped test', async () => {
  const s = setup({ manifest: PLATFORM.slice(0, 2).map((t) => ({ file: 'tests/x.test.mjs', name: t.name, reason: t.reason })) });
  const r = await check(s);
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes(PLATFORM[2].name));
});

test('#1690 (C4) a skip for any OTHER reason hides nowhere: refused, and named', async () => {
  const other = { name: 'Q1 flaky on CI so it was skipped', reason: 'flaky on the runner' };
  const s = setup({ tapText: tap({ extra: [skipLine(800, other)] }) });
  const r = await check(s);
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes(other.name));
});

test('#1690 (C4b) a bare `# SKIP` with no reason is also refused', async () => {
  const s = setup({ tapText: tap({ extra: ['ok 801 - Q2 skipped with no reason # SKIP'] }) });
  const r = await check(s);
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes('Q2 skipped with no reason'));
});

test('#1690 (C5) a manifest test that does not appear in the run AT ALL is refused, and named', async () => {
  const s = setup({ tapText: tap({ skips: PLATFORM.slice(0, 2) }) });
  const r = await check(s);
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes(PLATFORM[2].name));
});

test('#1690 (C6) a TAP-escaped hash in a test name matches the manifest’s plain hash', async () => {
  const t = { name: 'H1 the #1558 case keeps its hash', reason: 'UNAVAILABLE: no sandbox-exec on this machine' };
  const s = setup({
    tapText: tap({ skips: [t] }).replace(t.name, 'H1 the \\#1558 case keeps its hash'),
    manifest: [{ file: 'tests/x.test.mjs', name: t.name, reason: t.reason }],
  });
  const r = await check(s);
  assert.equal(r.code, 0, r.out);
});

test('#1690 (C7) FAILS CLOSED: input it cannot read is never clean (exit 2)', async () => {
  const empty = setup({ tapText: '' });
  assert.equal((await check(empty)).code, 2, 'an empty TAP');
  const noTests = setup({ tapText: 'TAP version 13\n# some words with no test lines\n' });
  assert.equal((await check(noTests)).code, 2, 'a TAP with no ok / not ok lines');
  const noManifest = setup();
  fs.rmSync(noManifest.manPath);
  assert.equal((await check(noManifest)).code, 2, 'a missing manifest');
  const emptyManifest = setup({ manifest: [] });
  assert.equal((await check(emptyManifest)).code, 2, 'an empty manifest');
  const badManifest = setup({ manifest: '{ not json' });
  assert.equal((await check(badManifest)).code, 2, 'a malformed manifest');
  const noTap = setup();
  fs.rmSync(noTap.tapPath);
  assert.equal((await check(noTap)).code, 2, 'a missing TAP file');
});

test('#1690 (C8) the receipt records the commit, the manifest’s content hash, and the verdict', async () => {
  const s = setup();
  const r = await check(s);
  assert.equal(r.code, 0, r.out);
  const rec = JSON.parse(fs.readFileSync(s.receipt, 'utf8'));
  assert.equal(rec.sha, s.sha);
  assert.equal(rec.manifestSha256, sha256(fs.readFileSync(s.manPath)));
  assert.equal(rec.ok, true);
  assert.equal(typeof rec.leg, 'string', 'says which leg wrote it');
});

// ------------------------------------------------------------------- the Mac leg

const T = (name, body = '', opts = '') => `test(${JSON.stringify(name)}, ${opts ? opts + ', ' : ''}async () => { ${body} });`;
function fixtureRoot(files, manifestEntries) {
  const root = mk();
  fs.mkdirSync(path.join(root, 'tests'));
  for (const [f, src] of Object.entries(files)) fs.writeFileSync(path.join(root, f), `import { test } from 'node:test';\nimport fs from 'node:fs';\n${src}\n`);
  const manPath = path.join(root, 'manifest.json');
  fs.writeFileSync(manPath, JSON.stringify(manifestEntries));
  const { head, tree } = commitAll(root);
  return { root, manPath, receipt: path.join(root, 'mac-receipt.json'), marker: path.join(root, 'ran-outside-manifest'), sha: head, tree };
}
const mac = (f, extra = []) => exec(MAC, ['--manifest', f.manPath, '--root', f.root, '--sha', f.sha, '--receipt', f.receipt, ...extra], { env: { MARKER: f.marker } });

test('#1690 (M1) CONTROL — the named tests run and pass: clean, and the receipt lists exactly the files it ran', async () => {
  const f = fixtureRoot(
    { 'tests/a.test.mjs': T('A1 named test passes') },
    [{ file: 'tests/a.test.mjs', name: 'A1 named test passes', reason: 'UNAVAILABLE: needs a mac' }],
  );
  const r = await mac(f);
  assert.equal(r.code, 0, r.out);
  const rec = JSON.parse(fs.readFileSync(f.receipt, 'utf8'));
  assert.deepEqual(rec.files, ['tests/a.test.mjs']);
  assert.equal(rec.sha, f.sha);
  assert.equal(rec.manifestSha256, sha256(fs.readFileSync(f.manPath)));
  assert.equal(rec.ok, true);
});

test('#1690 (M2) a named test is SKIPPED: the leg fails, and names it', async () => {
  const f = fixtureRoot(
    { 'tests/a.test.mjs': T('A2 named test is skipped', '', "{ skip: 'not today' }") },
    [{ file: 'tests/a.test.mjs', name: 'A2 named test is skipped', reason: 'UNAVAILABLE: needs a mac' }],
  );
  const r = await mac(f);
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes('A2 named test is skipped'));
});

test('#1690 (M3) a named test no longer exists in its file (renamed): the leg fails, and names the old name', async () => {
  const f = fixtureRoot(
    { 'tests/a.test.mjs': T('A3 the new name') },
    [{ file: 'tests/a.test.mjs', name: 'A3 the old name', reason: 'UNAVAILABLE: needs a mac' }],
  );
  const r = await mac(f);
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes('A3 the old name'));
});

test('#1690 (M4) a named file is missing: the leg fails, and names the file', async () => {
  const f = fixtureRoot({}, [{ file: 'tests/gone.test.mjs', name: 'A4 anything', reason: 'UNAVAILABLE: needs a mac' }]);
  const r = await mac(f);
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes('tests/gone.test.mjs'));
});

test('#1690 (M5) a named test FAILS: the leg fails, and names it', async () => {
  const f = fixtureRoot(
    { 'tests/a.test.mjs': T('A5 named test fails', "throw new Error('boom');") },
    [{ file: 'tests/a.test.mjs', name: 'A5 named test fails', reason: 'UNAVAILABLE: needs a mac' }],
  );
  const r = await mac(f);
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes('A5 named test fails'));
});

test('#1690 (M6) SCOPE — a test file that is NOT in the manifest is never run, and the receipt names only the manifest’s files', async () => {
  const f = fixtureRoot(
    {
      'tests/a.test.mjs': T('A6 named test passes'),
      'tests/outside.test.mjs': T('A6x outside the manifest', "fs.writeFileSync(process.env.MARKER, 'ran');"),
    },
    [{ file: 'tests/a.test.mjs', name: 'A6 named test passes', reason: 'UNAVAILABLE: needs a mac' }],
  );
  const r = await mac(f);
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.existsSync(f.marker), false, 'a file outside the manifest was executed');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.receipt, 'utf8')).files, ['tests/a.test.mjs']);
});

test('#1690 (M7) SCOPE — it runs only the named TEST, not the other tests in that file', async () => {
  const f = fixtureRoot(
    {
      'tests/a.test.mjs': `${T('A7 named test passes')}\n${T('A7x another test in the same file', "fs.writeFileSync(process.env.MARKER, 'ran');")}`,
    },
    [{ file: 'tests/a.test.mjs', name: 'A7 named test passes', reason: 'UNAVAILABLE: needs a mac' }],
  );
  const r = await mac(f);
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.existsSync(f.marker), false, 'a test outside the manifest ran because it shares a file with a named one');
});

test('#1690 (M8) FAILS CLOSED: an empty or unreadable manifest is never clean (exit 2)', async () => {
  const f = fixtureRoot({ 'tests/a.test.mjs': T('A8 passes') }, []);
  assert.equal((await mac(f)).code, 2, 'an empty manifest');
  fs.writeFileSync(f.manPath, '{ not json');
  assert.equal((await mac(f)).code, 2, 'a malformed manifest');
  fs.rmSync(f.manPath);
  assert.equal((await mac(f)).code, 2, 'a missing manifest');
});

// ------------------------------------------------------------------- the pair: one commit, one manifest

function receipts({ ci = {}, macR = {} } = {}) {
  const d = mk();
  const base = { sha: SHA_A, tree: 't'.repeat(40), manifestSha256: 'm'.repeat(64), ok: true };
  const a = path.join(d, 'ci.json');
  const b = path.join(d, 'mac.json');
  fs.writeFileSync(a, JSON.stringify({ leg: 'ci', ...base, suiteExit: 0, ...ci }));
  fs.writeFileSync(b, JSON.stringify({ leg: 'mac', ...base, ...macR }));
  return [a, b];
}

test('#1690 (G1) CONTROL — both legs at the same commit and manifest, both clean: the pair is complete', async () => {
  const r = await exec(PAIR, receipts());
  assert.equal(r.code, 0, r.out);
});

test('#1690 (G2) a Mac receipt from ANOTHER commit cannot complete the CI leg: refused, naming both shas', async () => {
  const r = await exec(PAIR, receipts({ macR: { sha: SHA_B } }));
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes(SHA_A) && r.out.includes(SHA_B));
});

test('#1690 (G3) the legs judged against DIFFERENT manifests: refused, naming both hashes', async () => {
  const other = 'n'.repeat(64);
  const r = await exec(PAIR, receipts({ macR: { manifestSha256: other } }));
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes('m'.repeat(64)) && r.out.includes(other));
});

test('#1690 (G4) a leg that is not clean cannot complete the pair, whichever leg it is', async () => {
  assert.equal((await exec(PAIR, receipts({ ci: { ok: false } }))).code, 1, 'CI leg red');
  assert.equal((await exec(PAIR, receipts({ macR: { ok: false } }))).code, 1, 'Mac leg red');
});

test('#1690 (G5) FAILS CLOSED: a receipt missing its sha or manifest hash, or unreadable, is never clean (exit 2)', async () => {
  const [a, b] = receipts();
  const noSha = JSON.parse(fs.readFileSync(b, 'utf8'));
  delete noSha.sha;
  fs.writeFileSync(b, JSON.stringify(noSha));
  assert.equal((await exec(PAIR, [a, b])).code, 2, 'no sha');
  const [c, d2] = receipts();
  fs.writeFileSync(d2, '{ not json');
  assert.equal((await exec(PAIR, [c, d2])).code, 2, 'unreadable');
  const [e, f2] = receipts();
  fs.rmSync(f2);
  assert.equal((await exec(PAIR, [e, f2])).code, 2, 'missing');
});

// ------------------------------------------------------------------- the real manifest and the real workflow

test('#1690 (W1) the checked-in manifest lists exactly the six platform-only tests, each with a reason, in a file that exists and names it', () => {
  assert.ok(fs.existsSync(REAL_MANIFEST), 'tests/platform-only-manifest.json must exist');
  const m = JSON.parse(fs.readFileSync(REAL_MANIFEST, 'utf8'));
  assert.equal(m.length, 6, 'six entries today: I1 to I5 and RL');
  const ids = m.map((e) => e.name.split(' ')[0]).sort();
  assert.deepEqual(ids, ['I1', 'I2', 'I3', 'I4', 'I5', 'RL']);
  for (const e of m) {
    assert.ok(e.reason && /\S/.test(e.reason), `${e.name}: a reason`);
    const file = path.join(REPO, e.file);
    assert.ok(fs.existsSync(file), `${e.file} exists`);
    assert.ok(fs.readFileSync(file, 'utf8').includes(e.name), `${e.file} contains the test name "${e.name.slice(0, 40)}…"`);
  }
});

test('#1690 (W2) the workflow wires the executor venv and the skip check into the server job, with timeout headroom', () => {
  const yml = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
  const server = yml.slice(yml.indexOf('server:'), yml.indexOf('browser:'));
  assert.match(server, /setup-python/, 'the server job installs Python for the executor');
  assert.match(server, /pyoxigraph|requirements\.txt/, 'and the executor’s pinned requirements');
  assert.match(server, /scripts\/check-platform-skips\.mjs/, 'and runs the skip check over the suite’s TAP');
  const t = Number((server.match(/timeout-minutes:\s*(\d+)/) || [])[1]);
  // the trial run took 17 minutes against a 20-minute cap; 25 leaves 8 minutes, not 3
  assert.ok(t >= 25, `server job timeout-minutes is ${t}; the 17-minute trial needs at least 25`);
});


// ======================================================================= ADDED AFTER REVIEW OF 1c1a6de

// ---- (1) the Mac leg judges the child process, not only the named tests' TAP

test('#1690 (N1) the child exits NON-ZERO after the named test passed: the Mac leg is not clean, and names the file', async () => {
  const f = fixtureRoot(
    { 'tests/a.test.mjs': `${T('N1 named test passes')}\nprocess.on('exit', () => { process.exitCode = 1; });` },
    [{ file: 'tests/a.test.mjs', name: 'N1 named test passes', reason: 'UNAVAILABLE: needs a mac' }],
  );
  const r = await mac(f);
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes('tests/a.test.mjs'), 'names the file whose process failed');
  assert.equal(JSON.parse(fs.readFileSync(f.receipt, 'utf8')).ok, false);
});

test('#1690 (N2) the child is KILLED BY A SIGNAL after the named test passed: the Mac leg is not clean, and names the file', async () => {
  const f = fixtureRoot(
    // the kill comes AFTER the TAP is complete and flushed, so the named test's row reads ok and only the child's
    // status says it did not end cleanly (a kill inside the run would also truncate the TAP and be caught by that)
    { 'tests/a.test.mjs': `${T('N2 named test passes')}\nimport { after } from 'node:test';\nafter(() => { setTimeout(() => process.kill(process.pid, 'SIGKILL'), 800); });` },
    [{ file: 'tests/a.test.mjs', name: 'N2 named test passes', reason: 'UNAVAILABLE: needs a mac' }],
  );
  const r = await mac(f);
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes('tests/a.test.mjs'));
});

// ---- (2) a CI leg is only ok if the suite itself finished clean

const FAILING = 'not ok 7 - X1 an ordinary test that FAILS';
test('#1690 (N3) the expected skips AND a failing test in the TAP: refused, the failing test is named, the receipt is not ok', async () => {
  const s = setup({ tapText: tap({ extra: [FAILING] }) });
  const r = await check(s);
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes('X1 an ordinary test that FAILS'));
  assert.equal(JSON.parse(fs.readFileSync(s.receipt, 'utf8')).ok, false);
});

test('#1690 (N4) a clean-looking TAP but a NON-ZERO suite exit (the "fail 0, exit 1" run): refused, and the receipt says why', async () => {
  const s = setup();
  const r = await checkWith(s, ['--root', s.repo.dir, '--sha', s.sha, '--suite-exit', '1']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /exit/i, 'says it is the suite exit status');
  const rec = JSON.parse(fs.readFileSync(s.receipt, 'utf8'));
  assert.equal(rec.ok, false);
  assert.equal(rec.suiteExit, 1);
});

test('#1690 (N5) a `# fail N` summary with N above zero is refused even when no single line is a plain failure', async () => {
  const s = setup({ tapText: tap().replace('# pass 1', '# pass 1\n# fail 2') });
  const r = await check(s);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /fail/i);
});

test('#1690 (N6) FAILS CLOSED: no --suite-exit, or one that is not a number, cannot be checked (exit 2)', async () => {
  const s = setup();
  assert.equal((await checkWith(s, ['--root', s.repo.dir, '--sha', s.sha])).code, 2, 'no --suite-exit');
  assert.equal((await checkWith(s, ['--root', s.repo.dir, '--sha', s.sha, '--suite-exit', 'zero'])).code, 2, 'not a number');
});

test('#1690 (N7) a green receipt records the suite exit it was given', async () => {
  const s = setup();
  assert.equal((await check(s)).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(s.receipt, 'utf8')).suiteExit, 0);
});

// ---- (3) the commit is VERIFIED against the checked-out tree, not asserted

test('#1690 (N8) the CI leg: a declared sha that is not the checked-out HEAD exits 2, naming both', async () => {
  const s = setup();
  const r = await checkWith(s, ['--root', s.repo.dir, '--sha', SHA_B, '--suite-exit', '0']);
  assert.equal(r.code, 2, r.out);
  assert.ok(r.out.includes(SHA_B) && r.out.includes(s.sha), 'names the declared sha and the real HEAD');
});

test('#1690 (N9) the Mac leg: a declared sha that is not the checked-out HEAD exits 2, naming both', async () => {
  const f = fixtureRoot({ 'tests/a.test.mjs': T('N9 passes') }, [{ file: 'tests/a.test.mjs', name: 'N9 passes', reason: 'UNAVAILABLE: needs a mac' }]);
  const r = await exec(MAC, ['--manifest', f.manPath, '--root', f.root, '--sha', SHA_B, '--receipt', f.receipt], { env: { MARKER: f.marker } });
  assert.equal(r.code, 2, r.out);
  assert.ok(r.out.includes(SHA_B) && r.out.includes(f.sha));
});

test('#1690 (N10) both receipts carry the TREE of the checked-out commit', async () => {
  const s = setup();
  assert.equal((await check(s)).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(s.receipt, 'utf8')).tree, s.repo.tree);
  const f = fixtureRoot({ 'tests/a.test.mjs': T('N10 passes') }, [{ file: 'tests/a.test.mjs', name: 'N10 passes', reason: 'UNAVAILABLE: needs a mac' }]);
  assert.equal((await mac(f)).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(f.receipt, 'utf8')).tree, f.tree);
});

test('#1690 (N11) a MODIFIED tracked file means the tested tree is not the commit: both legs exit 2, naming the file', async () => {
  const s = setup();
  fs.writeFileSync(path.join(s.repo.dir, 'tracked.txt'), 'changed\n');
  const r = await check(s);
  assert.equal(r.code, 2, r.out);
  assert.ok(r.out.includes('tracked.txt'));
  const f = fixtureRoot({ 'tests/a.test.mjs': T('N11 passes') }, [{ file: 'tests/a.test.mjs', name: 'N11 passes', reason: 'UNAVAILABLE: needs a mac' }]);
  fs.appendFileSync(path.join(f.root, 'tests/a.test.mjs'), '// edited after the commit\n');
  const m = await mac(f);
  assert.equal(m.code, 2, m.out);
  assert.ok(m.out.includes('tests/a.test.mjs'));
});

test('#1690 (N12) CONTROL — an UNTRACKED file (the TAP, a receipt, a venv) does not count as a modified tree', async () => {
  const s = setup();
  fs.writeFileSync(path.join(s.repo.dir, 'server-suite.tap'), 'untracked output\n');
  const r = await check(s);
  assert.equal(r.code, 0, r.out);
});

test('#1690 (N13) a missing or malformed --sha cannot be checked (exit 2) on both legs', async () => {
  const s = setup();
  assert.equal((await checkWith(s, ['--root', s.repo.dir, '--suite-exit', '0'])).code, 2, 'CI leg, no sha');
  assert.equal((await checkWith(s, ['--root', s.repo.dir, '--sha', 'abc123', '--suite-exit', '0'])).code, 2, 'CI leg, short sha');
  const f = fixtureRoot({ 'tests/a.test.mjs': T('N13 passes') }, [{ file: 'tests/a.test.mjs', name: 'N13 passes', reason: 'UNAVAILABLE: needs a mac' }]);
  assert.equal((await exec(MAC, ['--manifest', f.manPath, '--root', f.root, '--receipt', f.receipt])).code, 2, 'Mac leg, no sha');
  assert.equal((await exec(MAC, ['--manifest', f.manPath, '--root', f.root, '--sha', 'zzz', '--receipt', f.receipt])).code, 2, 'Mac leg, short sha');
});

test('#1690 (N14) a root that is not a git checkout cannot attest a commit (exit 2) on both legs', async () => {
  const s = setup();
  const plain = mk();
  assert.equal((await checkWith(s, ['--root', plain, '--sha', s.sha, '--suite-exit', '0'])).code, 2, 'CI leg');
  const f = fixtureRoot({ 'tests/a.test.mjs': T('N14 passes') }, [{ file: 'tests/a.test.mjs', name: 'N14 passes', reason: 'UNAVAILABLE: needs a mac' }]);
  fs.rmSync(path.join(f.root, '.git'), { recursive: true, force: true });
  assert.equal((await mac(f)).code, 2, 'Mac leg');
});

// ---- the pair judges the tree and the suite exit too

test('#1690 (N15) the legs tested DIFFERENT TREES (the same sha label can hide a merge ref): refused, naming both trees', async () => {
  const other = 'u'.repeat(40);
  const r = await exec(PAIR, receipts({ macR: { tree: other } }));
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes('t'.repeat(40)) && r.out.includes(other));
});

test('#1690 (N16) a CI receipt whose suite exit was non-zero cannot complete the pair, even marked ok', async () => {
  const r = await exec(PAIR, receipts({ ci: { suiteExit: 1 } }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /exit/i);
});

test('#1690 (N17) FAILS CLOSED: a receipt with no tree, or a CI receipt with no suite exit, or none for ok, exits 2', async () => {
  const noTree = receipts();
  const m = JSON.parse(fs.readFileSync(noTree[1], 'utf8')); delete m.tree; fs.writeFileSync(noTree[1], JSON.stringify(m));
  assert.equal((await exec(PAIR, noTree)).code, 2, 'Mac receipt without a tree');
  const noExit = receipts();
  const c = JSON.parse(fs.readFileSync(noExit[0], 'utf8')); delete c.suiteExit; fs.writeFileSync(noExit[0], JSON.stringify(c));
  assert.equal((await exec(PAIR, noExit)).code, 2, 'CI receipt without a suite exit');
  const noOk = receipts();
  const k = JSON.parse(fs.readFileSync(noOk[1], 'utf8')); delete k.ok; fs.writeFileSync(noOk[1], JSON.stringify(k));
  assert.equal((await exec(PAIR, noOk)).code, 2, 'a receipt without a verdict');
});

// ---- survivors from the mutants run against 1c1a6de

test('#1690 (N18) a manifest path that climbs out of the root is refused and never run, naming the path', async () => {
  const f = fixtureRoot({ 'tests/a.test.mjs': T('N18 passes') }, [{ file: 'tests/a.test.mjs', name: 'N18 passes', reason: 'UNAVAILABLE: needs a mac' }]);
  const outside = mk();
  fs.writeFileSync(path.join(outside, 'escape.test.mjs'), "import { test } from 'node:test';\nimport fs from 'node:fs';\ntest('E1 escaped', () => { fs.writeFileSync(process.env.MARKER, 'ran'); });\n");
  const rel = path.relative(f.root, path.join(outside, 'escape.test.mjs'));
  assert.ok(rel.startsWith('..'), 'the fixture file really is outside the root');
  fs.writeFileSync(f.manPath, JSON.stringify([
    { file: 'tests/a.test.mjs', name: 'N18 passes', reason: 'UNAVAILABLE: needs a mac' },
    { file: rel, name: 'E1 escaped', reason: 'UNAVAILABLE: x' },
  ]));
  git(f.root, 'add', '-A');
  git(f.root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'manifest with an escaping path');
  f.sha = git(f.root, 'rev-parse', 'HEAD');
  const r = await mac(f);
  assert.notEqual(r.code, 0, r.out);
  assert.ok(r.out.includes('escape.test.mjs'), 'names the path');
  assert.equal(fs.existsSync(f.marker), false, 'a file outside the root was executed');
});


// ======================================================================= ADDED AFTER REVIEW OF 8e4cbc4

// ---- the pair judges WHICH leg is in which slot

test('#1690 (G6) the SAME receipt in both slots cannot complete the pair (one CI run is not both legs): refused, naming the legs', async () => {
  const [ci] = receipts();
  const r = await exec(PAIR, [ci, ci]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /leg/i);
});

test('#1690 (G6b) the slots SWAPPED (Mac receipt first, CI second) are refused', async () => {
  const [ci, macR] = receipts();
  const r = await exec(PAIR, [macR, ci]);
  // refused either as a mismatch (1) or because the "CI" slot holds a receipt that lacks a CI suite exit (2); what
  // matters is that it is never complete
  assert.notEqual(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /gate complete|pair complete/i);
});

test('#1690 (G6c) FAILS CLOSED: a receipt that does not say which leg it is cannot be paired (exit 2)', async () => {
  const [ci, macR] = receipts();
  const c = JSON.parse(fs.readFileSync(ci, 'utf8')); delete c.leg; fs.writeFileSync(ci, JSON.stringify(c));
  assert.equal((await exec(PAIR, [ci, macR])).code, 2);
});

// ---- the Mac leg wants an ORDINARY pass

test('#1690 (M9) a named test marked TODO is not a pass: the Mac leg fails and names it', async () => {
  const f = fixtureRoot(
    { 'tests/a.test.mjs': T('M9 named test is a todo', '', "{ todo: 'not implemented' }") },
    [{ file: 'tests/a.test.mjs', name: 'M9 named test is a todo', reason: 'UNAVAILABLE: needs a mac' }],
  );
  const r = await mac(f);
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes('M9 named test is a todo'));
  assert.equal(JSON.parse(fs.readFileSync(f.receipt, 'utf8')).ok, false);
});

// ---- the workflow passes the suite's real status, not a constant (a hole no row pinned in 8e4cbc4)

function serverJob() {
  const yml = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
  return yml.slice(yml.indexOf('server:'), yml.indexOf('browser:'));
}

test('#1690 (W3) the server job records the suite’s exit status and hands THAT to the checker, which also gets the checkout and the sha', () => {
  const job = serverJob();
  assert.match(job, /SUITE_EXIT=\$rc|SUITE_EXIT=\$\{?\??/, 'the suite step records its exit status for the next step');
  assert.match(job, />>\s*"?\$GITHUB_ENV"?/, 'in the job environment');
  const step = job.slice(job.indexOf('check-platform-skips.mjs'));
  assert.match(step, /--suite-exit\s+"?\$\{?SUITE_EXIT/, 'the checker is given the recorded status, not a literal');
  assert.doesNotMatch(step, /--suite-exit\s+"?\d/, 'and never a numeric literal');
  assert.match(step, /--root\s+\./, 'the checkout that was tested');
  assert.match(step, /--sha\s+"?\$\{\{\s*github\.event\.pull_request\.head\.sha/, 'the commit the event names');
});

test('#1690 (W4) the check runs even when the suite failed, and the suite step still fails the job on a red suite', () => {
  const job = serverJob();
  const at = job.indexOf('Platform-only skips');
  assert.ok(at > 0, 'a named step runs the checker');
  assert.match(job.slice(at, at + 400), /if:\s*always\(\)/, 'the check step runs on a red suite');
  assert.match(job, /exit\s+\$rc/, 'the suite step re-raises the suite’s own status');
});

test('#1690 (W5) the checkout tests the pull request’s head commit, so the sha handed to the checker names the tree that was tested', () => {
  const job = serverJob();
  assert.match(job, /actions\/checkout@v4\s+with:\s+ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha/, 'checkout ref is the PR head');
});
