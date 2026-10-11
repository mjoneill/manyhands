/**
 * #1672 — 78 of 82 test files that call tmpStore() never remove the store it makes. Written BEFORE the sweep (RED rows), by a different hand than the fix.
 *
 * The seam: run ONE named test file as a child (`node --test <file>`) with TMPDIR pointing at a fresh private directory, so every store the file makes lands there and nothing else does
 * (os.tmpdir() reads TMPDIR). While it runs the harness samples the directory; when it ends it counts what is left. The directory is removed afterwards, leaked stores included.
 *
 *   T0 CONTROL (leaks)    a script that calls tmpStore('t0-') and removes nothing: the counter sees 1 entry. The counter is not blind.
 *   T0 CONTROL (removes)  the same script that removes its store: the counter sees 0. The counter is not a constant.
 *   T0 CONTROL (test run) a trivial file run through `node --test` itself leaves nothing, so what T1/T2 find is the file's, not the runner's.
 *   T1 columns-graph-c1   NOTHING the file made is left in its TMPDIR when it ends (tmpStore stores, mkdtemp directories, files; whatever the prefix or helper)
 *   T2 executor-meter-1570 the same
 * Per #1672's widened DONE WHEN ("nothing the file made is left in its TMPDIR"): a per-prefix count would let the next helper's leak through. The message still breaks the leftovers down by what
 * tmpStore() made (prefixes read from the file's own source) and what it did not, for whoever sweeps. A separate CONTROL says the file really made temp entries while it ran (peak sampled during the
 * run >= 1, tmpStore prefixes >= 1 in its source): without it "0 left" could mean "never made any".
 * Two files of 82 (or 78); the others are not rowed here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withOwned } from './helpers/ready-world-1644.mjs';
import { HAVE_PY } from './helpers/graph-executor-proc.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = path.join(ROOT, 'tests', 'helpers', 'graph-executor-proc.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const entries = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
const prefixesOf = (file) => [...new Set([...fs.readFileSync(path.join(ROOT, file), 'utf8').matchAll(/tmpStore\('([^']+)'\)/g)].map((m) => m[1]))];

/** Run `argv` (node arguments) with TMPDIR at a fresh private directory. Resolves { code, peak, left, other, tap }; the directory is removed afterwards. */
async function underPrivateTmp(argv, prefixes, { boundMs }) {
  return withOwned(async (own) => {
    const tmp = own.dir('r44u-1672-');
    const env = { ...process.env, TMPDIR: tmp }; delete env.NODE_TEST_CONTEXT;
    let tap = '';
    const child = spawn(process.execPath, argv, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', (d) => { tap += d; });
    own.adopt(async () => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
    const matching = () => entries(tmp).filter((n) => prefixes.some((p) => n.startsWith(p)));
    let peak = 0;
    const timer = setInterval(() => { peak = Math.max(peak, entries(tmp).length); }, 200);
    const code = await Promise.race([new Promise((r) => child.once('exit', (c) => r(c))), sleep(boundMs).then(() => 'TIMEOUT')]);
    clearInterval(timer);
    const left = matching();
    const all = entries(tmp);
    return { code, peak: Math.max(peak, left.length), left, other: all.filter((n) => !left.includes(n)), all, tap };
  });
}
const tally = (tap) => ({ pass: Number((/^# pass (\d+)/m.exec(tap) || [])[1] ?? NaN), fail: Number((/^# fail (\d+)/m.exec(tap) || [])[1] ?? NaN), skipped: Number((/^# skipped (\d+)/m.exec(tap) || [])[1] ?? NaN) });

test('T0 CONTROL: the counter sees a store a script leaves, and sees none when the script removes it', { timeout: 60000 }, async () => {
  const script = (remove) => `import fs from 'node:fs'; import { tmpStore } from ${JSON.stringify(HELPER)}; const d = tmpStore('t0-'); ${remove ? 'fs.rmSync(d, { recursive: true, force: true });' : ''}`;
  const leaks = await underPrivateTmp(['--input-type=module', '-e', script(false)], ['t0-'], { boundMs: 30000 });
  assert.equal(leaks.code, 0, 'the control script ends cleanly');
  assert.equal(leaks.left.length, 1, `the counter sees the one store the script left (saw ${JSON.stringify(leaks.left)})`);
  const removes = await underPrivateTmp(['--input-type=module', '-e', script(true)], ['t0-'], { boundMs: 30000 });
  assert.equal(removes.code, 0);
  assert.deepEqual(removes.left, [], 'the counter sees nothing when the script removed its store');
});

test('T0 CONTROL: a trivial file run through `node --test` leaves nothing in its TMPDIR', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'r44u-1672c-'));
  try {
    const file = path.join(dir, 'trivial.test.mjs');
    fs.writeFileSync(file, "import { test } from 'node:test'; test('t', () => {});\n");
    const r = await underPrivateTmp(['--test', file], ['none-'], { boundMs: 30000 });
    assert.equal(r.code, 0, 'the trivial file passes');
    assert.deepEqual(r.all, [], 'the runner itself leaves nothing in the TMPDIR it was given');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const [tag, file] of [['T1', 'tests/columns-graph-c1.test.mjs'], ['T2', 'tests/executor-meter-1570.test.mjs']]) {
  test(`${tag} ${file}: every store the file makes through tmpStore() is gone when the file has ended`, { timeout: 900000, skip: SKIP }, async () => {
    const prefixes = prefixesOf(file);
    assert.ok(prefixes.length >= 1, `CONTROL: the source of ${file} shows tmpStore('...') calls to count (found ${JSON.stringify(prefixes)})`);
    const r = await underPrivateTmp(['--test', path.join(ROOT, file)], prefixes, { boundMs: 600000 });
    assert.notEqual(r.code, 'TIMEOUT', `${file} ends by itself within 10 minutes`);
    const t = tally(r.tap);
    assert.ok(t.pass >= 1 && t.skipped === 0, `CONTROL: the file really ran its tests (pass ${t.pass}, skipped ${t.skipped}, fail ${t.fail}, exit ${r.code})`);
    assert.ok(r.peak >= 1, `CONTROL: the file made temp entries in the private TMPDIR while it ran (peak ${r.peak}); otherwise "0 left" proves nothing`);
    assert.deepEqual(r.all, [], `${file} left ${r.all.length} temp entr(ies) in its TMPDIR: ${r.left.length} from tmpStore() (prefixes ${JSON.stringify(prefixes)}) and ${r.other.length} not from it: ${JSON.stringify(r.other)}`);
  });
}
