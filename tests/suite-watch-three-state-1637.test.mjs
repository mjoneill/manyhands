/**
 * #1637 — THE NIGHTLY SUITE WATCH: THREE STATES, NOT TWO. Rows written by the separate test author BEFORE the change (the same author owns the change, so the rows exist, RED, before the script is touched).
 * REVISED 13:35Z for the reviewer's 13:29:55Z review: unclassified skips are INCOMPLETE, a documented-exclusion mechanism now, checkout-relative paths, counts as test OUTCOMES, and proof that required executor tests RAN.
 *
 * THE RULE (reviewer rulings 09:49Z-13:29Z): independent states.
 *   FAILED      tests that really failed: a LEAF `not ok` without `# TODO` (a parent suite/file wrapper whose only failure is its failing child is NOT a second failure)
 *   TODO        expected-failure rows (`not ok ... # TODO ...`): visible on a line of their own, NEVER in the failing-file list, NEVER a red
 *   INCOMPLETE  missing REQUIRED coverage: any `# SKIP UNAVAILABLE: ...` row; any skip NOT covered by a documented exclusion ("unclassified"); a required test file that did not run
 *   DOCUMENTED  a skip matched by an entry in the exclusions file (exact file + exact test title + reason + scope): counted, visible, not INCOMPLETE. A skip reason alone is NOT a waiver, and an
 *               entry never waives an `UNAVAILABLE:` skip.
 *
 * THE OBSERVABLE CONTRACT THESE ROWS PIN (proposed by the author of the rows; the reviewer found V1-V4 sound in principle, V5 and T4 revised):
 *   V1  every run prints exactly one line `VERDICT failed=<n> todo=<n> unavailable=<n> unclassified=<n> documented=<n> required=<ran>/<total> failing-files=[..] todo-files=[..]`; file entries are
 *       CHECKOUT-RELATIVE paths (`tests/a.test.mjs`), sorted, comma-separated, no spaces. For a location outside the checkout (an old artifact) the path is the suffix from the last `/tests/`.
 *   V2  a post (DRYRUN: `DRYRUN would post: <body>`) goes out for FAILED (the word RED, the failing files) and/or INCOMPLETE (the word INCOMPLETE; unavailable and unclassified counts stated separately).
 *   V3  the cooldown is per STATE: a muted RED does not mute INCOMPLETE and the reverse; a NEW failing FILE fires through RED's mute; a new TODO-only file never fires.
 *   V4  a FAILED or INCOMPLETE run keeps its TAP (artifact dir full.tap + meta.json with `incomplete`, `unavailable`, `unclassified`, and its own coverage.json); EVERY run overwrites ONE file
 *       `scrum-suite-watch-coverage.json` beside the state file (the required files and, per file, executed/passed/failed/skipped), so a green night leaves PROOF that the required tests ran, not just a lower
 *       skip count, WITHOUT a per-night directory (#746: a green run writes no artifacts; per-night dirs would evict the red evidence from the bounded window). Shape: {required:[{file, passed, skipped}]}.
 *   V5  `suite green — silent` is printed ONLY with no failures, no UNAVAILABLE, no UNCLASSIFIED skips and every required file run.
 *   V6  exclusions: `scripts/suite-watch-exclusions.json` in the checkout (or SUITE_WATCH_EXCLUSIONS): [{file, test, reason, scope}] all four non-empty strings; a malformed file is INCOMPLETE and named, never ignored.
 *   V7  required coverage: `scripts/suite-watch-required.json` (or SUITE_WATCH_REQUIRED): ["tests/x.test.mjs", ...]. For each required file the watch tracks executed / passed / failed / skipped SEPARATELY (reviewer, 13:34:15Z):
 *       RAN != PASSED: a required file whose tests all execute and fail RAN (required counts it) and the run is RED, not INCOMPLETE. A required file is INCOMPLETE when it has no completed run (its
 *       `# file: <path> complete` marker is absent, or the TAP is TRUNCATED: no summary), or executed nothing, or still has skips. The manifest MISSING / unreadable / invalid JSON / not an array of non-empty
 *       strings is INCOMPLETE and named; it never becomes an empty list. An explicit `[]` is allowed and prints required=0/0. The checked-in manifest must equal the executor-backed test files discovered in tests/.
 *       coverage.json: {required:[{file, executed, passed, failed, skipped}]}.
 *
 * INPUTS: none required. WATCH_REPO optionally points at another checkout (the mutation runs use mutated copies). The real-artifact control reads tests/fixtures/suite-watch-20261008-reduced.tap, a reduced copy of the 10-08 nightly TAP.
 * The watch runs against FIXTURE universes (SUITE_WATCH_REPO=<scratch>, NO_CLONE, DRYRUN, scratch state/artifacts/ledger): never the live state file, ledger or artifacts.
 * NOT COVERED: the launchd plist (verified by a real nightly run, not a row); timeouts/hangs (unchanged); stale-exclusion detection (an entry matching no skip is not flagged).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// the checkout whose watch is under test: this one, unless a mutation run points WATCH_REPO at a mutated copy
const REPO = () => path.resolve(process.env.WATCH_REPO || ROOT);
const WATCH = () => path.join(REPO(), 'scripts', 'suite-watch.mjs');
const REAL_TAP = path.join(ROOT, 'tests', 'fixtures', 'suite-watch-20261008-reduced.tap');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'sw1637-'));
const LEDGER = path.join(SCRATCH, 'ledger.jsonl'); const ARTIFACTS = path.join(SCRATCH, 'artifacts');

// ---------- TAP synthesis (the shape of the real 10-08 artifact: `# file:` markers, `# Subtest:` lines, yaml blocks) -----------------------------------------
let N = 0; let DIR = '/nowhere';
const yaml = (extra = '', type = 'test', ind = '') => `${ind}  ---\n${ind}  duration_ms: 1.5\n${ind}  type: '${type}'\n${extra}${ind}  ...\n`;
const file = (rel) => `# file: ${rel} complete\n`;
const tOk = (title) => `# Subtest: ${title}\nok ${++N} - ${title}\n${yaml()}`;
const tSkip = (title, reason) => `# Subtest: ${title}\nok ${++N} - ${title} # SKIP ${reason}\n${yaml()}`;
const loc = (rel, ind = '', line = 10) => `${ind}  location: '${DIR}/${rel}:${line}:1'\n${ind}  failureType: 'testCodeFailure'\n${ind}  error: |-\n${ind}    boom\n${ind}  code: 'ERR_ASSERTION'\n`;
const tFail = (title, rel) => `# Subtest: ${title}\nnot ok ${++N} - ${title}\n${yaml(loc(rel))}`;
const tTodo = (title, rel, why = 'owed') => `# Subtest: ${title}\nnot ok ${++N} - ${title} # TODO ${why}\n${yaml(loc(rel))}`;
/** a describe() parent with one failing child: the parent's own row is a WRAPPER (failureType subtestsFailed) and must not be a second failure */
const tNestedFail = (suite, child, rel) => `# Subtest: ${suite}\n    # Subtest: ${child}\n    not ok 1 - ${child}\n${yaml(loc(rel, '    '), 'test', '    ')}    1..1\nnot ok ${++N} - ${suite}\n  ---\n  duration_ms: 2.5\n  type: 'suite'\n  location: '${DIR}/${rel}:3:1'\n  failureType: 'subtestsFailed'\n  error: '1 subtest failed'\n  ...\n`;
function tap(parts, { tests, pass, fail, skipped, todo }) {
  return `TAP version 13\n${parts.join('')}1..${tests}\n# tests ${tests}\n# suites 0\n# pass ${pass}\n# fail ${fail}\n# cancelled 0\n# skipped ${skipped}\n# todo ${todo}\n# duration_ms 1000\n`;
}
const UNAV = 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';

// ---------- the fixture universe + one tick ------------------------------------------------------------------------------------------------------------------
function universe({ isolationCode = 1, exclusions = null, required = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, 'u-')); fs.mkdirSync(path.join(dir, 'tests')); fs.mkdirSync(path.join(dir, 'scripts')); DIR = dir;
  fs.writeFileSync(path.join(dir, 'scripts', 'run-tests.sh'), '#!/bin/sh\ncat "$FAKE_TAP"\nexit "${FAKE_CODE:-0}"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'scripts', 'run-test-files.mjs'), `process.exit(${isolationCode});\n`);
  fs.writeFileSync(path.join(dir, 'tests', 'green.test.mjs'), 'import { test } from "node:test"; test("g", () => {});\n');
  if (exclusions != null) fs.writeFileSync(path.join(dir, 'scripts', 'suite-watch-exclusions.json'), typeof exclusions === 'string' ? exclusions : JSON.stringify(exclusions));
  if (required !== false) fs.writeFileSync(path.join(dir, 'scripts', 'suite-watch-required.json'), typeof required === 'string' ? required : JSON.stringify(required));   // an explicit [] by default: every row but the manifest rows is about something else
  return { dir, state: path.join(dir, 'watch.state') };
}
async function tick(u, tapText, code) {
  const tapFile = path.join(u.dir, `fake-${Date.now()}-${Math.random().toString(36).slice(2)}.tap`); fs.writeFileSync(tapFile, tapText);
  const env = { ...process.env, SUITE_WATCH_REPO: u.dir, SUITE_WATCH_STATE: u.state, SUITE_WATCH_DRYRUN: '1', SUITE_WATCH_NO_CLONE: '1', SCRUM_VERDICT_LEDGER: LEDGER, SUITE_WATCH_ARTIFACTS: ARTIFACTS, FAKE_TAP: tapFile, FAKE_CODE: String(code) };
  for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST')) delete env[k]; delete env.NODE_OPTIONS;
  const r = await run(process.execPath, [WATCH()], { env, maxBuffer: 64 * 1024 * 1024 }).catch((e) => e);
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const posts = [...out.matchAll(/DRYRUN would post: (.*)/g)].map((m) => m[1]);
  const vl = out.split('\n').filter((l) => /\sVERDICT\s/.test(l));
  const v = vl.length === 1 ? Object.fromEntries([...vl[0].matchAll(/(\w[\w-]*)=(\[[^\]]*\]|\S+)/g)].map((m) => [m[1], m[2]])) : null;
  const list = (s) => (s == null ? null : s.replace(/^\[|\]$/g, '').split(',').filter(Boolean));
  return { out, posts, verdictLines: vl, v, failing: list(v?.['failing-files']), todoFiles: list(v?.['todo-files']), code: r.code ?? 0, dir: u.dir };
}
const clean = (n) => ({ tests: n, pass: n, fail: 0, skipped: 0, todo: 0 });
const green = (t) => /suite green — silent/.test(t.out);
const artifactsWith = (pred) => (fs.existsSync(ARTIFACTS) ? fs.readdirSync(ARTIFACTS).map((d) => path.join(ARTIFACTS, d)) : []).filter((d) => fs.existsSync(path.join(d, 'meta.json'))).map((d) => ({ d, meta: JSON.parse(fs.readFileSync(path.join(d, 'meta.json'), 'utf8')) })).filter((x) => pred(x.meta));

// ---------- rows ---------------------------------------------------------------------------------------------------------------------------------------------
test('T0 CONTROL: a fully green universe is silent, prints exactly one VERDICT line with zeros (V1, V5)', { timeout: 120000 }, async () => {
  N = 0; const u = universe(); const t = await tick(u, tap([file('tests/a.test.mjs'), tOk('a'), tOk('b')], clean(2)), 0);
  assert.equal(t.verdictLines.length, 1, `exactly one VERDICT line per run (V1); got ${t.verdictLines.length}. output: ${t.out.slice(0, 400)}`);
  assert.deepEqual([t.v.failed, t.v.todo, t.v.unavailable, t.v.unclassified, t.v.documented], ['0', '0', '0', '0', '0']);
  assert.deepEqual(t.posts, [], 'green posts nothing'); assert.ok(green(t), 'and says so (V5)');
});

test('T1 TODO-ONLY: `not ok ... # TODO` rows in two files and exit 0 are NOT red; the files appear as TODO files (relative paths), never as failing files, and are visible', { timeout: 120000 }, async () => {
  N = 0; const u = universe();
  const t = await tick(u, tap([file('tests/alpha.test.mjs'), tOk('a'), tTodo('owed one', 'tests/alpha.test.mjs'), tTodo('owed two', 'tests/alpha.test.mjs'), file('tests/beta.test.mjs'), tTodo('owed three', 'tests/beta.test.mjs')], { tests: 4, pass: 1, fail: 0, skipped: 0, todo: 3 }), 0);
  assert.deepEqual(t.posts, [], `TODO-only must not post: ${t.posts[0]?.slice(0, 200)}`);
  assert.equal(t.v?.failed, '0', `failed=${t.v?.failed}`); assert.equal(t.v?.todo, '3'); assert.deepEqual(t.failing, []); assert.deepEqual(t.todoFiles, ['tests/alpha.test.mjs', 'tests/beta.test.mjs'], 'TODO files are named, on their own');
  assert.ok(green(t));
});

test('T2 REAL FAILURE next to TODO rows: red names ONLY the really failing file; the TODO files are on their own', { timeout: 120000 }, async () => {
  N = 0; const u = universe();
  const t = await tick(u, tap([file('tests/real.test.mjs'), tOk('a'), tFail('really broken', 'tests/real.test.mjs'), file('tests/alpha.test.mjs'), tTodo('owed', 'tests/alpha.test.mjs'), file('tests/beta.test.mjs'), tTodo('owed too', 'tests/beta.test.mjs')], { tests: 4, pass: 1, fail: 1, skipped: 0, todo: 2 }), 1);
  assert.equal(t.posts.length, 1, `exactly one post for a red: ${JSON.stringify(t.posts).slice(0, 300)}`);
  assert.deepEqual(t.failing, ['tests/real.test.mjs'], `failing-files must be only the real failure: ${JSON.stringify(t.failing)}`);
  assert.deepEqual(t.todoFiles, ['tests/alpha.test.mjs', 'tests/beta.test.mjs']);
  assert.match(t.posts[0], /RED/, 'the post says RED');
  const section = (t.posts[0].split('Failing file(s):')[1] ?? '').split('. ')[0];
  assert.ok(section.includes('tests/real.test.mjs'), `CONTROL: the Failing file(s) section was found and names the real failure: "${section}"`);
  assert.ok(!/alpha\.test\.mjs|beta\.test\.mjs/.test(section), `and it does not list the TODO files: "${section}"`);
  assert.ok(!/INCOMPLETE/.test(t.posts[0]), 'no skips => the post does not claim INCOMPLETE');
});

test('T3 UNAVAILABLE SKIPS with zero failures are INCOMPLETE: not silent, not success, the count is stated, evidence is kept', { timeout: 120000 }, async () => {
  N = 0; const u = universe(); const parts = [file('tests/needs-py.test.mjs'), tOk('a')]; for (let i = 0; i < 7; i++) parts.push(tSkip(`needs python ${i}`, UNAV));
  const t = await tick(u, tap(parts, { tests: 8, pass: 1, fail: 0, skipped: 7, todo: 0 }), 0);
  assert.ok(!green(t), 'INCOMPLETE must never print the all-clear (V5)');
  assert.equal(t.v?.unavailable, '7'); assert.equal(t.v?.unclassified, '0'); assert.equal(t.v?.failed, '0');
  assert.equal(t.posts.length, 1, `INCOMPLETE posts once: ${JSON.stringify(t.posts).slice(0, 300)}`);
  assert.match(t.posts[0], /INCOMPLETE/); assert.match(t.posts[0], /\b7\b/, 'and states the count'); assert.ok(!/\bRED\b/.test(t.posts[0]), 'no failure => the post does not say RED');
  const mine = artifactsWith((m) => m.incomplete === true && m.unavailable === 7);
  assert.equal(mine.length, 1, `V4: an INCOMPLETE run keeps its TAP with meta {incomplete:true, unavailable:7}; found ${mine.length}`);
  assert.ok(fs.existsSync(path.join(mine[0].d, 'full.tap')), 'full.tap kept');
});

test('T4 UNCLASSIFIED SKIPS are INCOMPLETE too (reviewer ruling 13:29:55Z): never the all-clear, counted apart from UNAVAILABLE, and the post says so', { timeout: 120000 }, async () => {
  N = 0; const u = universe();
  const t = await tick(u, tap([file('tests/misc.test.mjs'), tOk('a'), tSkip('darwin only', 'not applicable on linux'), tSkip('flaky upstream', 'waiting on upstream fix'), tSkip('needs py', UNAV)], { tests: 4, pass: 1, fail: 0, skipped: 3, todo: 0 }), 0);
  assert.equal(t.v?.unclassified, '2', JSON.stringify(t.v)); assert.equal(t.v?.unavailable, '1');
  assert.ok(!green(t), 'an unclassified skip must not print "suite green"');
  assert.equal(t.posts.length, 1); assert.match(t.posts[0], /INCOMPLETE/); assert.match(t.posts[0], /unclassified/i, 'the post distinguishes unclassified from unavailable'); assert.match(t.posts[0], /unavailable/i);
});

test('T4b DOCUMENTED EXCLUSIONS: an exact (file, test, reason, scope) entry makes a non-UNAVAILABLE skip DOCUMENTED (not INCOMPLETE); near-misses, UNAVAILABLE skips and malformed files do not', { timeout: 300000 }, async () => {
  const entry = { file: 'tests/misc.test.mjs', test: 'darwin only', reason: 'the kernel feature does not exist off darwin', scope: 'linux CI only; revisit if a linux runner is added' };
  // exact match: documented, green, silent
  N = 0; let u = universe({ exclusions: [entry] });
  let t = await tick(u, tap([file('tests/misc.test.mjs'), tOk('a'), tSkip('darwin only', 'not applicable on linux')], { tests: 2, pass: 1, fail: 0, skipped: 1, todo: 0 }), 0);
  assert.equal(t.v?.documented, '1'); assert.equal(t.v?.unclassified, '0'); assert.ok(green(t), `a documented skip alone is complete: ${t.out.slice(0, 300)}`); assert.deepEqual(t.posts, []);
  assert.match(t.out, /documented/i, 'but it stays visible in the log');
  // near misses: same title in another file; same file with another title; a substring of the title
  for (const [label, rel, title] of [['same title, other file', 'tests/other.test.mjs', 'darwin only'], ['other title, same file', 'tests/misc.test.mjs', 'darwin only too'], ['substring of the title', 'tests/misc.test.mjs', 'darwin']]) {
    N = 0; u = universe({ exclusions: [entry] });
    t = await tick(u, tap([file(rel), tOk('a'), tSkip(title, 'not applicable on linux')], { tests: 2, pass: 1, fail: 0, skipped: 1, todo: 0 }), 0);
    assert.equal(t.v?.unclassified, '1', `${label}: must stay unclassified (identity is exact): ${JSON.stringify(t.v)}`); assert.equal(t.v?.documented, '0'); assert.ok(!green(t));
  }
  // an entry never waives UNAVAILABLE
  N = 0; u = universe({ exclusions: [{ ...entry, test: 'needs py' }] });
  t = await tick(u, tap([file('tests/misc.test.mjs'), tOk('a'), tSkip('needs py', UNAV)], { tests: 2, pass: 1, fail: 0, skipped: 1, todo: 0 }), 0);
  assert.equal(t.v?.unavailable, '1', 'UNAVAILABLE stays UNAVAILABLE even when listed'); assert.equal(t.v?.documented, '0'); assert.ok(!green(t));
  // malformed: an entry without a scope => the file is invalid, named, nothing is honoured, INCOMPLETE
  N = 0; const bad = { ...entry }; delete bad.scope; u = universe({ exclusions: [bad] });
  t = await tick(u, tap([file('tests/misc.test.mjs'), tOk('a'), tSkip('darwin only', 'not applicable on linux')], { tests: 2, pass: 1, fail: 0, skipped: 1, todo: 0 }), 0);
  assert.ok(!green(t), 'a malformed exclusions file must not produce an all-clear'); assert.equal(t.v?.documented, '0', 'and honours none of it');
  assert.match(t.out + t.posts.join(' '), /exclusions?.*(invalid|malformed)|(invalid|malformed).*exclusions?/i, `and says so: ${t.out.slice(0, 300)}`);
  N = 0; u = universe({ exclusions: '{not json' });
  t = await tick(u, tap([file('tests/misc.test.mjs'), tOk('a')], clean(2)), 0);
  assert.ok(!green(t), 'an unparseable exclusions file is INCOMPLETE too, not ignored');
});

test('T5 INDEPENDENCE over the cooldown: a muted RED does not mute INCOMPLETE, and a muted INCOMPLETE does not mute a new RED', { timeout: 300000 }, async () => {
  const u = universe();
  const red = (extra = []) => { N = 0; return tap([file('tests/real.test.mjs'), tOk('a'), tFail('broken', 'tests/real.test.mjs'), ...(extra.length ? [file('tests/misc.test.mjs'), ...extra] : [])], { tests: 2 + extra.length, pass: 1, fail: 1, skipped: extra.length, todo: 0 }); };
  const r1 = await tick(u, red(), 1);   assert.equal(r1.posts.length, 1, 'run 1: RED fires');
  const r2 = await tick(u, red(), 1);   assert.equal(r2.posts.length, 0, 'run 2: the same RED is muted');
  const skips = () => [tSkip('s', UNAV), tSkip('s2', UNAV)];
  const r3 = await tick(u, red(skips()), 1);
  assert.equal(r3.posts.length, 1, `run 3: INCOMPLETE appears next to a muted RED and must FIRE: ${JSON.stringify(r3.posts).slice(0, 300)}`);
  assert.match(r3.posts[0], /INCOMPLETE/); assert.ok(!/Failing file\(s\):/.test(r3.posts[0]), 'the muted RED is not repeated as news');
  const r4 = await tick(u, red(skips()), 1);  assert.equal(r4.posts.length, 0, 'run 4: both standing, both muted');
  const r4b = await tick(u, red([...skips(), tSkip('s3', UNAV), tSkip('s4', UNAV), tSkip('s5', UNAV)]), 1);
  assert.equal(r4b.posts.length, 0, `run 4b: the SAME gap with more skips in the same file is not news (the count must not be part of the mute key): ${JSON.stringify(r4b.posts).slice(0, 200)}`);
  N = 0; const withNew = tap([file('tests/real.test.mjs'), tOk('a'), tFail('broken', 'tests/real.test.mjs'), file('tests/second.test.mjs'), tFail('also broken', 'tests/second.test.mjs'), file('tests/misc.test.mjs'), tSkip('s', UNAV), tSkip('s2', UNAV)], { tests: 5, pass: 1, fail: 2, skipped: 2, todo: 0 });
  const r5 = await tick(u, withNew, 1); assert.equal(r5.posts.length, 1, `run 5: a new failing FILE fires through RED's mute: ${JSON.stringify(r5.posts).slice(0, 300)}`);
  N = 0; const r6 = await tick(u, tap([file('tests/a.test.mjs'), tOk('a')], clean(1)), 0); assert.deepEqual(r6.posts, []); assert.ok(green(r6));
  N = 0; const r7 = await tick(u, tap([file('tests/a.test.mjs'), tOk('a'), tSkip('s', UNAV)], { tests: 2, pass: 1, fail: 0, skipped: 1, todo: 0 }), 0);
  assert.equal(r7.posts.length, 1, 'run 7: after a clean run an INCOMPLETE is news again');
});

test('T6 SIGNATURE: a new TODO-only file never fires; a new REAL failing file does (the 10-08 outbox-board-key-g6 defect)', { timeout: 300000 }, async () => {
  const u = universe();
  const base = (more = []) => { N = 0; return tap([file('tests/real.test.mjs'), tOk('a'), tFail('broken', 'tests/real.test.mjs'), file('tests/alpha.test.mjs'), tTodo('owed', 'tests/alpha.test.mjs'), ...more], { tests: 3 + more.length, pass: 1, fail: 1, skipped: 0, todo: 1 + more.length }); };
  const r1 = await tick(u, base(), 1); assert.equal(r1.posts.length, 1, 'RED fires once');
  const r2 = await tick(u, base([file('tests/outbox-board-key-g6.test.mjs'), tTodo('brand new owed row', 'tests/outbox-board-key-g6.test.mjs')]), 1);
  assert.equal(r2.posts.length, 0, `a new TODO-only file fired the alarm: ${JSON.stringify(r2.posts).slice(0, 300)}`);
  assert.deepEqual(r2.failing, ['tests/real.test.mjs']); assert.ok(r2.todoFiles.includes('tests/outbox-board-key-g6.test.mjs'), 'it is visible as a TODO file');
});

test('T7 PRECEDENCE: RED + INCOMPLETE together are reported as BOTH, in one verdict line, with each state\'s own evidence', { timeout: 120000 }, async () => {
  N = 0; const u = universe();
  const t = await tick(u, tap([file('tests/real.test.mjs'), tOk('a'), tFail('broken', 'tests/real.test.mjs'), file('tests/alpha.test.mjs'), tTodo('owed', 'tests/alpha.test.mjs'), file('tests/misc.test.mjs'), tSkip('s', UNAV), tSkip('s2', UNAV), tSkip('s3', 'no reason given')], { tests: 6, pass: 1, fail: 1, skipped: 3, todo: 1 }), 1);
  assert.equal(t.verdictLines.length, 1); assert.deepEqual([t.v.failed, t.v.todo, t.v.unavailable, t.v.unclassified], ['1', '1', '2', '1'], JSON.stringify(t.v));
  const body = t.posts.join(' || '); assert.match(body, /RED/); assert.match(body, /INCOMPLETE/); assert.match(body, /tests\/real\.test\.mjs/);
  const metas = artifactsWith((m) => m.incomplete === true && m.unavailable === 2 && m.unclassified === 1 && m.files?.includes('tests/real.test.mjs'));
  assert.equal(metas.length, 1, 'V4: one artifact carries the failing file and both incomplete counts'); assert.ok(!metas[0].meta.files.includes('tests/alpha.test.mjs'), 'and the TODO file is not in the failing `files`');
});

test('T9 PATHS ARE CHECKOUT-RELATIVE: two failing files with the same basename in different directories stay distinct (no basename merge), in the list and in the signature', { timeout: 300000 }, async () => {
  const u = universe();
  const two = (both) => { N = 0; return tap([file('tests/a/dup.test.mjs'), tFail('broken a', 'tests/a/dup.test.mjs'), ...(both ? [file('tests/b/dup.test.mjs'), tFail('broken b', 'tests/b/dup.test.mjs')] : [])], { tests: both ? 2 : 1, pass: 0, fail: both ? 2 : 1, skipped: 0, todo: 0 }); };
  const r1 = await tick(u, two(false), 1); assert.deepEqual(r1.failing, ['tests/a/dup.test.mjs'], JSON.stringify(r1.failing)); assert.equal(r1.posts.length, 1);
  const r2 = await tick(u, two(true), 1);
  assert.deepEqual(r2.failing, ['tests/a/dup.test.mjs', 'tests/b/dup.test.mjs'], `both files, by path: ${JSON.stringify(r2.failing)}`);
  assert.equal(r2.posts.length, 1, 'the second dup.test.mjs is a NEW failing file and must fire through the mute (a basename signature would merge them and stay silent)');
});

test('T10 COUNTS ARE TEST OUTCOMES, NOT WRAPPERS: a describe() parent whose only failure is its failing child counts as ONE failure in ONE file', { timeout: 120000 }, async () => {
  N = 0; const u = universe();
  const t = await tick(u, tap([file('tests/nested.test.mjs'), tOk('a'), tNestedFail('a suite', 'a child', 'tests/nested.test.mjs')], { tests: 2, pass: 1, fail: 1, skipped: 0, todo: 0 }), 1);
  assert.equal(t.v?.failed, '1', `failed=${t.v?.failed}: the suite wrapper was counted as a second failure`); assert.deepEqual(t.failing, ['tests/nested.test.mjs']);
});

test('T12 REQUIRED COVERAGE RAN: a required file with a completed run is proven by coverage.json on a green night (executed/passed/failed/skipped); skipped or absent required files make the run INCOMPLETE and name the file', { timeout: 300000 }, async () => {
  const req = ['tests/graph-executor.test.mjs'];
  N = 0; let u = universe({ required: req });
  let t = await tick(u, tap([file('tests/graph-executor.test.mjs'), tOk('e1'), tOk('e2'), tOk('e3')], clean(3)), 0);
  assert.equal(t.v?.required, '1/1', JSON.stringify(t.v)); assert.ok(green(t), `${t.out.slice(0, 300)}`);
  const covFile = path.join(path.dirname(u.state), 'scrum-suite-watch-coverage.json');
  assert.ok(fs.existsSync(covFile), `V4: every run leaves ${covFile} proving the required file ran`);
  const mine = [JSON.parse(fs.readFileSync(covFile, 'utf8'))];
  assert.ok(JSON.stringify(mine[0]).includes('tests/graph-executor.test.mjs'), 'and it names the required file');
  assert.equal((fs.existsSync(ARTIFACTS) ? fs.readdirSync(ARTIFACTS) : []).filter((d) => fs.existsSync(path.join(ARTIFACTS, d, 'coverage.json')) && JSON.stringify(JSON.parse(fs.readFileSync(path.join(ARTIFACTS, d, 'coverage.json'), 'utf8'))).includes('"ran":"1/1"')).length, 0, 'but a COMPLETE night creates no per-run directory');
  const row = mine[0].required?.find?.((f) => f.file === 'tests/graph-executor.test.mjs');
  assert.deepEqual(row && { executed: row.executed, passed: row.passed, failed: row.failed, skipped: row.skipped }, { executed: 3, passed: 3, failed: 0, skipped: 0 }, `coverage.json records the four counts separately: ${JSON.stringify(mine[0]).slice(0, 300)}`);
  // skipped: the file is in the TAP but its tests all skipped
  N = 0; u = universe({ required: req });
  t = await tick(u, tap([file('tests/graph-executor.test.mjs'), tSkip('e1', UNAV), tSkip('e2', UNAV)], { tests: 2, pass: 0, fail: 0, skipped: 2, todo: 0 }), 0);
  assert.equal(t.v?.required, '0/1'); assert.ok(!green(t)); assert.match(t.posts.join(' '), /graph-executor\.test\.mjs/, 'the post names the required file that did not run');
  // absent: the file vanished from the run entirely (renamed, filtered out, never listed)
  N = 0; u = universe({ required: req });
  t = await tick(u, tap([file('tests/other.test.mjs'), tOk('o1')], clean(1)), 0);
  assert.equal(t.v?.required, '0/1'); assert.ok(!green(t)); assert.match(t.posts.join(' '), /graph-executor\.test\.mjs/, 'an absent required file is named');
});

test('T12b RAN != PASSED: a required file whose tests all execute and FAIL ran (required=1/1) and the run is RED, not INCOMPLETE merely for having zero passes', { timeout: 120000 }, async () => {
  N = 0; const u = universe({ required: ['tests/graph-executor.test.mjs'] });
  const t = await tick(u, tap([file('tests/graph-executor.test.mjs'), tFail('e1', 'tests/graph-executor.test.mjs'), tFail('e2', 'tests/graph-executor.test.mjs')], { tests: 2, pass: 0, fail: 2, skipped: 0, todo: 0 }), 1);
  assert.equal(t.v?.required, '1/1', `a required file that executed and failed RAN: ${JSON.stringify(t.v)}`); assert.equal(t.v?.failed, '2');
  assert.deepEqual(t.failing, ['tests/graph-executor.test.mjs']); assert.equal(t.posts.length, 1); assert.match(t.posts[0], /RED/);
  assert.ok(!/INCOMPLETE/.test(t.posts[0]), `and it is not also reported as incomplete coverage: ${t.posts[0].slice(0, 300)}`);
  const m = artifactsWith((x) => x.files?.includes('tests/graph-executor.test.mjs')); assert.ok(m.length >= 1);
  const covPath = path.join(m.at(-1).d, 'coverage.json'); assert.ok(fs.existsSync(covPath), 'a RED run records coverage.json as well');
  const row = JSON.parse(fs.readFileSync(covPath, 'utf8')).required.find((f) => f.file === 'tests/graph-executor.test.mjs');
  assert.deepEqual({ executed: row.executed, passed: row.passed, failed: row.failed, skipped: row.skipped }, { executed: 2, passed: 0, failed: 2, skipped: 0 });
});

test('T12c COMPLETED FILE RUN, not one passing row: rows without the file\'s `# file: ... complete` marker, or a TRUNCATED TAP (no summary), leave the required file INCOMPLETE', { timeout: 120000 }, async () => {
  // rows present but the completion marker for the required file is absent
  N = 0; let u = universe({ required: ['tests/graph-executor.test.mjs'] });
  let t = await tick(u, tap([tOk('e1'), tOk('e2')], clean(2)), 0);   // no `# file:` marker at all
  assert.equal(t.v?.required, '0/1', `passing rows with no completed-file marker are not a completed run: ${JSON.stringify(t.v)}`); assert.ok(!green(t)); assert.match(t.posts.join(' '), /graph-executor\.test\.mjs/);
  // failing rows that name the required file by `location:` but carry no completed-file marker: the failure is real, the run of that file is not proven complete
  N = 0; u = universe({ required: ['tests/graph-executor.test.mjs'] });
  t = await tick(u, tap([tOk('o'), tFail('e1', 'tests/graph-executor.test.mjs')], { tests: 2, pass: 1, fail: 1, skipped: 0, todo: 0 }), 1);
  assert.equal(t.v?.required, '0/1', `rows reachable only by location, with no completed-file marker, do not make the file a completed run: ${JSON.stringify(t.v)}`);
  // a truncated TAP: everything passed so far, the file marker is there, but the run never reached its summary
  N = 0; u = universe({ required: ['tests/graph-executor.test.mjs'] });
  const body = `TAP version 13\n${[file('tests/graph-executor.test.mjs'), tOk('e1'), tOk('e2')].join('')}`;   // cut here: no 1..N, no # tests
  t = await tick(u, body, 0);
  assert.ok(!green(t), `a TRUNCATED tap with no failures must not print the all-clear: ${t.out.slice(0, 300)}`); assert.equal(t.v?.required, '0/1', 'and its required file is not counted as run');
  assert.match(t.posts.join(' '), /INCOMPLETE/); assert.match(t.posts.join(' '), /truncat/i, 'the post says the TAP was truncated');
});

test('T13 THE MANIFESTS FAIL CLOSED: a missing, unreadable, unparseable or wrongly shaped required-coverage file is INCOMPLETE and named; an explicit [] is accepted and shows required=0/0', { timeout: 300000 }, async () => {
  const good = tap([file('tests/a.test.mjs'), tOk('a')], clean(1));
  for (const [label, required] of [['missing', false], ['not json', '{nope'], ['not an array', '{"a":1}'], ['non-string entry', '[1]'], ['empty string entry', '[""]']]) {
    N = 0; const u = universe({ required }); const t = await tick(u, good, 0);
    assert.ok(!green(t), `${label}: a bad required-coverage manifest produced an all-clear`); assert.match(t.out + t.posts.join(' '), /required|manifest/i, `${label}: and the problem is named: ${t.out.slice(0, 200)}`);
  }
  // unreadable: a directory where the file should be
  N = 0; let u = universe({ required: false }); fs.mkdirSync(path.join(u.dir, 'scripts', 'suite-watch-required.json'));
  let t = await tick(u, good, 0); assert.ok(!green(t), 'an unreadable manifest (a directory) produced an all-clear');
  N = 0; u = universe({ required: [] }); t = await tick(u, good, 0);
  assert.equal(t.v?.required, '0/0', 'an explicit empty array is a choice and is visible'); assert.ok(green(t));
});

test('T14 THE CHECKED-IN MANIFEST EQUALS THE DISCOVERED EXECUTOR-BACKED TESTS (and covers the 10-08 skips, which are a seed, not the inventory)', { timeout: 120000 }, async () => {
  const repo = REPO(); const mf = path.join(repo, 'scripts', 'suite-watch-required.json');
  assert.ok(fs.existsSync(mf), 'scripts/suite-watch-required.json is not checked in');
  const listed = JSON.parse(fs.readFileSync(mf, 'utf8'));
  // the pattern is assembled from pieces so that THIS file does not match it (a test about executor-backed files is not itself executor-backed)
  const EXECUTOR_BACKED = new RegExp([['graph-executor', 'proc'].join('-'), 'HAVE' + '_PY', 'GRAPH_EXECUTOR' + '_PYTHON', 'start' + 'Executor'].join('|'));
  const discovered = fs.readdirSync(path.join(repo, 'tests')).filter((f) => f.endsWith('.test.mjs')).filter((f) => EXECUTOR_BACKED.test(fs.readFileSync(path.join(repo, 'tests', f), 'utf8'))).map((f) => `tests/${f}`).sort();
  assert.ok(discovered.length >= 20, `CONTROL: discovery found ${discovered.length} executor-backed test files`);
  const d = { unlisted: discovered.filter((f) => !listed.includes(f)), stale: listed.filter((f) => !fs.existsSync(path.join(repo, f))) };
  assert.deepEqual(d, { unlisted: [], stale: [] }, `executor-backed tests missing from the manifest: ${d.unlisted.join(', ')}; manifest entries that are not files: ${d.stale.join(', ')}`);
  const real = REAL_TAP;
  const seeds = new Set(); let cur = null; for (const L of fs.readFileSync(real, 'utf8').split('\n')) { const m = /^# file: (.+) complete$/.exec(L); if (m) cur = m[1]; if (cur && / # SKIP UNAVAILABLE:/.test(L)) seeds.add(cur); }
  const missing = [...seeds].filter((f) => !listed.includes(f)).sort(); assert.deepEqual(missing, [], `files that skipped UNAVAILABLE on 10-08 and are not in the manifest: ${missing.join(', ')}`);
});

test('T15 A ROW\'S OWN DIAGNOSTICS ARE NOT ROWS: TAP-looking lines quoted inside a failing test\'s error block (the suite-watch tests do exactly this) add no failure, no skip, no UNAVAILABLE', { timeout: 120000 }, async () => {
  N = 0; const u = universe();
  const quoted = `  error: |-\n    expected the child output to be clean but it said:\n    ok 1 - embedded passing # SKIP UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)\n    not ok 2 - embedded failing\n    not ok 3 - embedded owed # TODO later\n`;
  const text = tap([file('tests/meta.test.mjs'), tOk('a'), `# Subtest: outer\nnot ok ${++N} - outer\n${yaml(`  location: '${DIR}/tests/meta.test.mjs:9:1'\n  failureType: 'testCodeFailure'\n${quoted}  code: 'ERR_ASSERTION'\n`)}`], { tests: 2, pass: 1, fail: 1, skipped: 0, todo: 0 });
  const t = await tick(u, text, 1);
  assert.deepEqual([t.v?.failed, t.v?.unavailable, t.v?.todo, t.v?.unclassified], ['1', '0', '0', '0'], `rows quoted inside a diagnostics block were counted: ${JSON.stringify(t.v)}`);
  assert.deepEqual(t.failing, ['tests/meta.test.mjs']);
});

test('T8 CONTROL ON A REAL ARTIFACT: a reduced copy of the 10-08 nightly TAP (real markers, titles, locations, directives; summary recomputed) classifies as RED + INCOMPLETE; files and every count equal an INDEPENDENT parse of the same TAP', { timeout: 300000 }, async () => {
  const text = fs.readFileSync(REAL_TAP, 'utf8');
  // independent parse: walk rows, the NEXT yaml block's `location:` names the file; the `# file:` marker names the file of a skip row
  const lines = text.split('\n'); const failFiles = new Set(), todoFiles = new Set(); let unavailable = 0, skippedRows = 0, marker = null;
  const rel = (p) => 'tests/' + p.split('/tests/').pop().replace(/:\d+:\d+$/, '');
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (/^1\.\.\d+$/.test(L)) break;   // rows after the plan are the runner's recap, not outcomes
    { const m = /^# file: (.+) complete$/.exec(L); if (m) marker = m[1]; }
    if (/^ok \d+ .* # TODO\b/.test(L) && marker) todoFiles.add(marker);
    if (/^(\s*)(not )?ok \d+ .* # SKIP /.test(L)) { skippedRows++; if (/ # SKIP UNAVAILABLE:/.test(L)) unavailable++; }
    if (/^not ok \d+ /.test(L)) {
      let f = null; for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) { const m = /location: '([^']*\/tests\/[^']+\.test\.mjs:\d+:\d+)'/.exec(lines[j]); if (m) { f = rel(m[1]); break; } if (/^(not )?ok \d+ /.test(lines[j])) break; }
      if (/ # TODO\b/.test(L)) { if (f) todoFiles.add(f); } else if (f) failFiles.add(f);
    }
  }
  const sumLine = (k) => Number((new RegExp(`^# ${k} (\\d+)$`, 'm').exec(text) ?? [])[1]);
  const expectFail = [...failFiles].sort(); const expectTodo = [...todoFiles].filter((f) => !failFiles.has(f)).sort();
  assert.ok(expectFail.length >= 1 && expectTodo.length >= 5 && unavailable > 100, `CONTROL: the independent parse found ${expectFail.length} failing file(s), ${expectTodo.length} TODO-only file(s), ${unavailable} UNAVAILABLE skips`);
  // the TAP's own summary is a SECOND independent source for the counts
  assert.equal(skippedRows, sumLine('skipped'), `CONTROL: my row count of skips (${skippedRows}) equals the TAP summary (${sumLine('skipped')})`);
  const u = universe(); const t = await tick(u, text, 1);
  assert.deepEqual(t.failing, expectFail, `failing-files differ from the independent parse. got ${JSON.stringify(t.failing)}, want ${JSON.stringify(expectFail)}`);
  assert.deepEqual(t.todoFiles, expectTodo, 'todo-files differ from the independent parse');
  assert.equal(Number(t.v.unavailable), unavailable, `unavailable=${t.v.unavailable}, want ${unavailable}`);
  assert.equal(Number(t.v.failed), sumLine('fail'), `failed=${t.v.failed} but the TAP summary says # fail ${sumLine('fail')}`);
  assert.equal(Number(t.v.todo), sumLine('todo'), `todo=${t.v.todo} but the TAP summary says # todo ${sumLine('todo')}`);
  assert.equal(Number(t.v.unavailable) + Number(t.v.unclassified) + Number(t.v.documented), sumLine('skipped'), 'every skipped row is classified exactly once');
  const body = t.posts.join(' || '); assert.match(body, /RED/); assert.match(body, /INCOMPLETE/);
});
