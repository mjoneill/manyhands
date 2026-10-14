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
import { execFile } from 'node:child_process';
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
  return { d, tapPath, manPath, receipt: path.join(d, 'ci-receipt.json') };
}
const check = (s, extra = []) => exec(CHECK, [s.tapPath, '--manifest', s.manPath, '--sha', SHA_A, '--receipt', s.receipt, ...extra]);

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
  assert.equal(rec.sha, SHA_A);
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
  return { root, manPath, receipt: path.join(root, 'mac-receipt.json'), marker: path.join(root, 'ran-outside-manifest') };
}
const mac = (f, extra = []) => exec(MAC, ['--manifest', f.manPath, '--root', f.root, '--sha', SHA_A, '--receipt', f.receipt, ...extra], { env: { MARKER: f.marker } });

test('#1690 (M1) CONTROL — the named tests run and pass: clean, and the receipt lists exactly the files it ran', async () => {
  const f = fixtureRoot(
    { 'tests/a.test.mjs': T('A1 named test passes') },
    [{ file: 'tests/a.test.mjs', name: 'A1 named test passes', reason: 'UNAVAILABLE: needs a mac' }],
  );
  const r = await mac(f);
  assert.equal(r.code, 0, r.out);
  const rec = JSON.parse(fs.readFileSync(f.receipt, 'utf8'));
  assert.deepEqual(rec.files, ['tests/a.test.mjs']);
  assert.equal(rec.sha, SHA_A);
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
  const base = { sha: SHA_A, manifestSha256: 'm'.repeat(64), ok: true };
  const a = path.join(d, 'ci.json');
  const b = path.join(d, 'mac.json');
  fs.writeFileSync(a, JSON.stringify({ leg: 'ci', ...base, ...ci }));
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
