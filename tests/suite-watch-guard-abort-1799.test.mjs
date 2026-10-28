/**
 * #1799 — A HOST-GUARD ABORT IS INCOMPLETE ("host unfit, no verdict"), NEVER RED. Rows written by the separate test author BEFORE the change, so they exist, RED, before scripts/suite-watch.mjs is touched.
 *
 * THE INCIDENT THESE ROWS PIN (2026-10-28 09:45Z, the nightly in the deployed tree): the #1588 host guard self-aborted at load 13.52 (ceiling 10), exit 75, with its own line in the TAP. The watch posted TWO
 * alerts for that one event: "RED ... (summary unparsed) Failing file(s): unparsed" and "INCOMPLETE ... TAP truncated ... 183 required files did not run" (a ~12 KB post). Cause, read from source (not run):
 * scripts/suite-watch.mjs:162 `red = timedOut || full.code !== 0` makes ANY non-zero exit red, and with no failing leaf `redMembers` falls to ['unparsed'].
 *
 * THE OBSERVABLE CONTRACT THESE ROWS PIN (proposed by the author of the rows from the #1799 done-when and the owner's proposed design; the reviewer may revise any line, as with #1637):
 *   A1  exit 75 AND a guard line at the START of a TAP line (`# self-aborted:` mid-run, or `# host guard: REFUSED` at launch) is a GUARD ABORT. It posts ONCE, as INCOMPLETE, and the post says the host was
 *       unfit and that there is no verdict, and CARRIES THE NUMBERS the card asks for (load, ceiling, rows run). It never says RED, never says "unparsed", and never prints the all-clear.
 *   A2  its state member is `inc:host-guard`; it creates no `red:` member. The kept artifact's meta.json carries `aborted: {load, ceiling, rowsRun}` (numbers parsed from the guard's line; the card's done-when item 1) and `incomplete: true`; full.tap is kept.
 *       A launch refusal (`# host guard: REFUSED`) says `Nothing was run`, so its object is {load, ceiling, rowsRun: 0} (the author's reading; the reviewer may revise).
 *   A3  a REAL leaf failure in the partial TAP is still RED, naming its file, next to the INCOMPLETE guard post (states are independent, #1637 V3). A guard abort must never swallow a failure.
 *   A4  the fix keys on the guard's line AND exit 75: exit 75 with no guard line stays RED (an unknown non-zero is not waived); a guard-looking phrase in a TEST TITLE (not at a line start) with exit 1 stays RED.
 *   A5  the per-state mute holds: a repeat guard abort is muted; a genuine failure afterwards still fires; a clean run afterwards clears `inc:host-guard` and is silent-green.
 *   A6  (the author's PROPOSAL, for the reviewer to accept or strike) an abort post does NOT enumerate the required files that did not run, and does not say "TAP was truncated": a designed abort is not a hang and
 *       its missing coverage is the whole point of "no verdict". The 12 KB post of 09:47Z is the specimen.
 * REAL-ARTIFACT CONTROL: tests/fixtures/suite-watch-20261028-guard-abort-reduced.tap is the first 39 lines and the abort line (line 9181) of the real full.tap of that run (no row edited; the lines between are cut).
 * The watch runs against FIXTURE universes (SUITE_WATCH_REPO=<scratch>, NO_CLONE, DRYRUN, scratch state/artifacts/ledger): never the live state file, ledger or artifacts.
 * NOT COVERED: that the guard itself aborts at a given load (tests/host-guard-1588.test.mjs owns that); the launchd plist.
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
  const env = { ...process.env, SUITE_WATCH_REPO: u.dir, SUITE_WATCH_STATE: u.state, SUITE_WATCH_DRYRUN: '1', SUITE_WATCH_NO_CLONE: '1', SCRUM_VERDICT_LEDGER: LEDGER, SUITE_WATCH_ARTIFACTS: path.join(u.dir, 'artifacts'), FAKE_TAP: tapFile, FAKE_CODE: String(code) };
  // a fixture run must see ONLY what it sets: a SUITE_WATCH_* variable inherited from the process running the suite (the nightly, or a verification run of the whole suite through the watch) would redirect
  // the fixture's state, coverage or manifests to the OUTER run's files. Found by exactly that: the first real executor-backed run failed T12 because SUITE_WATCH_COVERAGE leaked in.
  for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST') || (k.startsWith('SUITE_WATCH_') && !['SUITE_WATCH_REPO', 'SUITE_WATCH_STATE', 'SUITE_WATCH_DRYRUN', 'SUITE_WATCH_NO_CLONE', 'SUITE_WATCH_ARTIFACTS'].includes(k))) delete env[k]; delete env.NODE_OPTIONS;
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

// ---------- #1799 helpers ----------------------------------------------------------------------------------------------------------------------------------
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'suite-watch-20261028-guard-abort-reduced.tap');
const BANNER = '# host guard: on, load 2.43, ceiling 10 (provisional: the core count, until #1487 measures it), sampled every 5000 ms\n';
const ABORT = (rows = 12) => `# self-aborted: load crossed 13.52 at 2026-10-28T09:47:12.758Z (ceiling 10 (provisional: the core count, until #1487 measures it)), rows run ${rows}, host-preservation guard (#1588). This run is INCOMPLETE: no verdict, and its rows are not full-suite evidence.\n# tmp: owned process pid 5067 outlived its test file: a leak; killing it\n`;
const REFUSED = '# host guard: REFUSED to start: load 9.50 is over the ceiling 10 (provisional: the core count, until #1487 measures it); this host also serves production (#1588, #1487). Nothing was run. Try again when the host is quiet.\n';
/** a run cut off by the guard: rows, then the abort line, NO summary (the guard stopped the run before one) */
const cut = (...parts) => `TAP version 13\n${BANNER}${parts.join('')}${ABORT()}`;
const members = (u) => { try { return Object.keys(JSON.parse(fs.readFileSync(u.state, 'utf8')).sigTimes ?? {}).sort(); } catch { return null; } };
const artifactsOf = (u) => { const d = path.join(u.dir, 'artifacts'); return fs.existsSync(d) ? fs.readdirSync(d).map((x) => path.join(d, x)).filter((x) => fs.existsSync(path.join(x, 'meta.json'))).map((x) => ({ d: x, meta: JSON.parse(fs.readFileSync(path.join(x, 'meta.json'), 'utf8')) })) : []; };
const isHostUnfit = (post) => /INCOMPLETE/.test(post) && /host unfit/i.test(post) && /no verdict/i.test(post);
const hasNum = (post, n) => post.includes(String(n)) || post.includes(Number(n).toFixed(2));
const guardAbortAsserts = (t, u, what, nums) => {
  assert.equal(t.posts.length, 1, `${what}: a guard abort posts exactly ONCE (the 09:47Z night posted two): ${JSON.stringify(t.posts.map((p) => p.slice(0, 120)))}`);
  assert.ok(isHostUnfit(t.posts[0]), `${what}: the post says INCOMPLETE, host unfit, no verdict: "${t.posts[0]?.slice(0, 300)}"`);
  assert.ok(!/\bRED\b/.test(t.posts[0]) && !/unparsed/i.test(t.posts[0]), `${what}: and never RED / "unparsed": "${t.posts[0]?.slice(0, 300)}"`);
  assert.ok(!green(t), `${what}: never the all-clear`);
  assert.equal(t.v?.failed, '0', `${what}: failed=${t.v?.failed}`);
  const m = members(u);
  assert.ok(m, `${what}: CONTROL: the state file was written and read`);
  assert.ok(m.includes('inc:host-guard'), `${what}: the state member is inc:host-guard; got ${JSON.stringify(m)}`);
  assert.ok(!m.some((k) => k.startsWith('red:')), `${what}: and there is no red: member; got ${JSON.stringify(m)}`);
  const mine = artifactsOf(u).filter((a) => a.meta.aborted && typeof a.meta.aborted === 'object' && a.meta.incomplete === true);
  assert.equal(mine.length, 1, `${what}: the kept artifact's meta.json says {aborted:{...}, incomplete:true}; artifacts: ${JSON.stringify(artifactsOf(u).map((a) => a.meta))}`);
  assert.deepStrictEqual(mine[0].meta.aborted, nums, `${what}: aborted is exactly {load, ceiling, rowsRun} as NUMBERS parsed from the guard's line (a bare true carries none of them); got ${JSON.stringify(mine[0].meta.aborted)}`);
  assert.ok(hasNum(t.posts[0], nums.load) && hasNum(t.posts[0], nums.ceiling), `${what}: the post states the load ${nums.load} and the ceiling ${nums.ceiling}: "${t.posts[0]?.slice(0, 400)}"`);
  if (nums.rowsRun > 0) assert.ok(hasNum(t.posts[0], nums.rowsRun), `${what}: and the rows run ${nums.rowsRun}: "${t.posts[0]?.slice(0, 400)}"`);
  assert.ok(fs.existsSync(path.join(mine[0].d, 'full.tap')), `${what}: full.tap kept`);
};

// ---------- rows -------------------------------------------------------------------------------------------------------------------------------------------
test('G0 CONTROL: a genuine failing leaf with exit 1 is RED, names its file, and is not a host-unfit post', { timeout: 120000 }, async () => {
  N = 0; const u = universe();
  const t = await tick(u, tap([file('tests/real.test.mjs'), tOk('a'), tFail('really broken', 'tests/real.test.mjs')], { tests: 2, pass: 1, fail: 1, skipped: 0, todo: 0 }), 1);
  assert.equal(t.posts.length, 1, JSON.stringify(t.posts).slice(0, 300)); assert.match(t.posts[0], /RED/); assert.deepEqual(t.failing, ['tests/real.test.mjs']);
  assert.ok(!/host unfit/i.test(t.posts[0]), 'a real failure is not a host-unfit post');
  assert.ok(members(u)?.some((k) => k.startsWith('red:')), `and its member is red:...; got ${JSON.stringify(members(u))}`);
});

test('G1 MID-RUN ABORT (synthetic): exit 75 + the `# self-aborted:` line, zero failing rows, no summary -> ONE INCOMPLETE "host unfit, no verdict" post, member inc:host-guard, meta aborted:{load,ceiling,rowsRun}', { timeout: 120000 }, async () => {
  N = 0; const u = universe();
  const t = await tick(u, cut(file('tests/a.test.mjs'), tOk('a'), tOk('b')), 75);
  guardAbortAsserts(t, u, 'G1', { load: 13.52, ceiling: 10, rowsRun: 12 });
});

test('G2 REAL ARTIFACT: the reduced full.tap of the 09:47Z abort, exit 75 -> the same single INCOMPLETE host-unfit post (the incident, replayed)', { timeout: 120000 }, async () => {
  N = 0; const u = universe(); const real = fs.readFileSync(FIXTURE, 'utf8');
  assert.match(real, /^# self-aborted: load crossed 13\.52 at 2026-10-28T09:47:12\.758Z/m, 'CONTROL: the fixture is the real abort tail, not a lookalike');
  assert.ok(!/^# tests \d+/m.test(real), 'CONTROL: and it has no summary line (the shape that read as "summary unparsed")');
  const t = await tick(u, real, 75);
  guardAbortAsserts(t, u, 'G2', { load: 13.52, ceiling: 10, rowsRun: 1454 });
});

test('G3 LAUNCH REFUSAL: exit 75 + `# host guard: REFUSED to start` (nothing ran, no rows) -> the same INCOMPLETE host-unfit post, never RED', { timeout: 120000 }, async () => {
  N = 0; const u = universe();
  const t = await tick(u, `TAP version 13\n${REFUSED}`, 75);
  guardAbortAsserts(t, u, 'G3', { load: 9.5, ceiling: 10, rowsRun: 0 });
});

test('G4 ABORT + A REAL FAILURE in the rows already run: RED still fires, naming the failing file (not "unparsed"), beside the INCOMPLETE host-unfit post', { timeout: 120000 }, async () => {
  N = 0; const u = universe();
  const t = await tick(u, cut(file('tests/real.test.mjs'), tOk('a'), tFail('really broken', 'tests/real.test.mjs')), 75);
  assert.equal(t.v?.failed, '1', `the failing leaf is counted: ${JSON.stringify(t.v)}`);
  const red = t.posts.filter((p) => /\bRED\b/.test(p)); const inc = t.posts.filter(isHostUnfit);
  assert.equal(red.length, 1, `exactly one RED post: ${JSON.stringify(t.posts.map((p) => p.slice(0, 100)))}`);
  assert.ok(red[0].includes('tests/real.test.mjs') && !/Failing file\(s\): unparsed/.test(red[0]), `RED names the real file in its Failing file(s) section, not "unparsed" there: "${red[0]?.slice(0, 300)}"`);
  assert.equal(inc.length, 1, `and one INCOMPLETE host-unfit post: ${JSON.stringify(t.posts.map((p) => p.slice(0, 100)))}`);
  const m = members(u); assert.ok(m?.some((k) => k.startsWith('red:')) && m.includes('inc:host-guard'), `both members present; got ${JSON.stringify(m)}`);
});

test('G5 CONTROL (A4): exit 75 with NO guard line is not waived: RED (a non-zero the watch cannot explain stays an alarm)', { timeout: 120000 }, async () => {
  N = 0; const u = universe();
  const t = await tick(u, `TAP version 13\n${file('tests/a.test.mjs')}${tOk('a')}`, 75);
  assert.ok(t.posts.some((p) => /\bRED\b/.test(p)), `an unexplained exit 75 is RED: ${JSON.stringify(t.posts.map((p) => p.slice(0, 100)))}`);
  assert.ok(!t.posts.some((p) => /host unfit/i.test(p)), 'and nothing calls the host unfit without the guard having said so');
  assert.ok(!(members(u) ?? []).includes('inc:host-guard'), 'no inc:host-guard member without the guard line');
});

test('G6 CONTROL (A4): a guard-looking phrase inside a TEST TITLE (not at a line start) with a real failing leaf and exit 1 is RED, not host-unfit', { timeout: 120000 }, async () => {
  N = 0; const u = universe();
  const title = 'the watcher reads `# self-aborted: load crossed 13.52` only at a line start';
  const t = await tick(u, tap([file('tests/real.test.mjs'), tFail(title, 'tests/real.test.mjs')], { tests: 1, pass: 0, fail: 1, skipped: 0, todo: 0 }), 1);
  assert.ok(t.posts.some((p) => /\bRED\b/.test(p)), `RED: ${JSON.stringify(t.posts.map((p) => p.slice(0, 100)))}`);
  assert.ok(!t.posts.some((p) => /host unfit/i.test(p)), 'a phrase in a title is not the guard');
  assert.ok(!(members(u) ?? []).includes('inc:host-guard'));
});

test('G7 MUTE: a repeat guard abort is muted; a genuine failure afterwards still fires; a clean run afterwards clears inc:host-guard and is silent-green', { timeout: 180000 }, async () => {
  N = 0; const u = universe();
  const a = await tick(u, cut(file('tests/a.test.mjs'), tOk('a')), 75);
  assert.equal(a.posts.length, 1, `first abort posts once: ${JSON.stringify(a.posts.map((p) => p.slice(0, 100)))}`);
  assert.ok((members(u) ?? []).includes('inc:host-guard'), `CONTROL: the member exists after the first abort; got ${JSON.stringify(members(u))}`);
  const b = await tick(u, cut(file('tests/a.test.mjs'), tOk('a')), 75);
  assert.deepEqual(b.posts, [], `the repeat abort is muted: ${JSON.stringify(b.posts.map((p) => p.slice(0, 100)))}`);
  const c = await tick(u, tap([file('tests/real.test.mjs'), tFail('really broken', 'tests/real.test.mjs')], { tests: 1, pass: 0, fail: 1, skipped: 0, todo: 0 }), 1);
  assert.ok(c.posts.some((p) => /\bRED\b/.test(p) && p.includes('tests/real.test.mjs')), `a genuine failure fires through the abort's mute: ${JSON.stringify(c.posts.map((p) => p.slice(0, 100)))}`);
  const d = await tick(u, tap([file('tests/a.test.mjs'), tOk('a')], clean(1)), 0);
  assert.ok(green(d), `a clean run is silent-green: ${d.out.slice(-300)}`);
  assert.deepEqual(members(u), [], `and every member is cleared; got ${JSON.stringify(members(u))}`);
});

test('G8 (author\'s PROPOSAL, A6): an abort post does not enumerate the required files that did not run and does not say the TAP was truncated', { timeout: 120000 }, async () => {
  N = 0; const required = ['tests/r1.test.mjs', 'tests/r2.test.mjs', 'tests/r3.test.mjs']; const u = universe({ required });
  const t = await tick(u, cut(file('tests/a.test.mjs'), tOk('a')), 75);
  assert.equal(t.posts.length, 1, `one post: ${JSON.stringify(t.posts.map((p) => p.slice(0, 100)))}`);
  assert.ok(isHostUnfit(t.posts[0]), `CONTROL: it is the host-unfit post: "${t.posts[0]?.slice(0, 200)}"`);
  for (const f of required) assert.ok(!t.posts[0].includes(f), `the post does not list ${f}`);
  assert.ok(!/truncated/i.test(t.posts[0]), 'and does not call a designed abort a truncation');
  assert.ok(t.posts[0].length < 1500, `and is short (${t.posts[0].length} chars; the 09:47Z specimen was ~12 KB)`);
});
