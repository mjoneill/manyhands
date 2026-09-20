/**
 * #1417 — the nightly suite-watch exited 1 every night for two reasons of its
 * own: cleanup died EACCES inside the deploy fixture's read-only serve/ dir
 * (after the verdict), and the launchd PATH had no /usr/sbin so #884's tests
 * could not find `lsof` and read false-red for four nights.
 *
 * Sabotage: rmTreeForce without the chmod walk ⇒ the read-only fixture test
 * throws EACCES (the control proves the fixture really is undeletable by a
 * plain rmSync); the PATH prepend removed ⇒ the served run's suite cannot
 * see /usr/sbin and its probe test fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rmTreeForce, withSystemBins, SYSTEM_BIN_DIRS } from '../scripts/watch-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WATCH = path.join(ROOT, 'scripts', 'suite-watch.mjs');

// The shape scripts/deploy.sh leaves behind: a read-only directory holding read-only files.
function readOnlyFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-1417-'));
  const serve = path.join(dir, 'tree', '.scratch-tests', 'deploy-x', 'serve');
  fs.mkdirSync(serve, { recursive: true });
  fs.writeFileSync(path.join(serve, 'DEPLOYED-SHA'), 'abc\n');
  fs.writeFileSync(path.join(serve, 'DO-NOT-EDIT-HERE.md'), 'prod\n');
  fs.chmodSync(path.join(serve, 'DEPLOYED-SHA'), 0o444);
  fs.chmodSync(path.join(serve, 'DO-NOT-EDIT-HERE.md'), 0o444);
  fs.chmodSync(serve, 0o555);
  return { dir, serve };
}

test('#1417 CONTROL — a plain rmSync cannot remove the read-only deploy fixture (EACCES), which is the nightly crash', () => {
  const { dir } = readOnlyFixture();
  try {
    assert.throws(() => fs.rmSync(dir, { recursive: true, force: true }), (e) => e.code === 'EACCES' || e.code === 'EPERM', 'the fixture is genuinely undeletable the old way');
  } finally { try { rmTreeForce(dir); } catch { /* the feature test below covers it */ } }
});

test('#1417 rmTreeForce removes the read-only deploy fixture whole, and is a no-op on a path that does not exist', () => {
  const { dir } = readOnlyFixture();
  rmTreeForce(dir);
  assert.equal(fs.existsSync(dir), false, 'the tree is gone');
  rmTreeForce(dir);   // idempotent
  rmTreeForce(null);
});

test('#1417 withSystemBins puts /usr/sbin and /sbin on a PATH that lacks them, once, and leaves a PATH that has them alone', () => {
  const plist = '/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/bin:/bin';   // the launchd plist's PATH, verbatim
  const fixed = withSystemBins(plist);
  for (const d of SYSTEM_BIN_DIRS) assert.ok(fixed.split(':').includes(d), `${d} on the PATH`);
  assert.ok(fixed.startsWith(plist), 'the launcher\'s order is kept; the system dirs are appended');
  assert.equal(withSystemBins(fixed), fixed, 'idempotent');
  assert.equal(withSystemBins(''), SYSTEM_BIN_DIRS.join(':'), 'an empty PATH still finds them');
});

// Served: the WATCHER itself, over a fixture universe whose one test asserts the
// thing #884's tests needed — that `lsof` is findable. Run with the plist's PATH.
test('#1417 the suite the watcher spawns can find lsof — the plist PATH without /usr/sbin is repaired in the watcher, not the plist', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw1417-'));
  fs.mkdirSync(path.join(dir, 'tests')); fs.mkdirSync(path.join(dir, 'scripts'));
  for (const f of ['run-tests.sh', 'run-test-files.mjs', 'verdict-ledger.mjs']) {
    const src = path.join(ROOT, 'scripts', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, 'scripts', f));
  }
  fs.chmodSync(path.join(dir, 'scripts', 'run-tests.sh'), 0o755);
  fs.writeFileSync(path.join(dir, 'tests', 'lsof.test.mjs'),
    'import { test } from "node:test"; import a from "node:assert/strict"; import { execSync } from "node:child_process";\n'
    + 'test("lsof resolves on this PATH", () => { a.doesNotThrow(() => execSync("lsof -v", { stdio: "pipe" }), "lsof must be findable"); a.ok(process.env.PATH.split(":").includes("/usr/sbin"), process.env.PATH); });\n');
  const state = path.join(dir, 'watch.state');
  const env = { ...process.env, PATH: [path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/bin', '/bin'].join(':'),   // the RUNNING node's dir, not a mac-only path: the runner has no /opt/homebrew
    SUITE_WATCH_REPO: dir, SUITE_WATCH_STATE: state, SUITE_WATCH_DRYRUN: '1', SUITE_WATCH_NO_CLONE: '1',
    SUITE_WATCH_ARTIFACTS: fs.mkdtempSync(path.join(os.tmpdir(), 'art1417-')), SCRUM_VERDICT_LEDGER: path.join(dir, 'ledger.jsonl') };
  for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST')) delete env[k];
  delete env.NODE_OPTIONS;
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [WATCH], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = ''; p.stdout.on('data', (c) => { o += c; }); p.stderr.on('data', (c) => { o += c; });
    p.on('close', (code) => resolve({ code, o }));
  });
  assert.equal(out.code, 0, out.o);
  assert.doesNotMatch(out.o, /DRYRUN would post/, `a green universe posts nothing — the lsof probe passed:\n${out.o.slice(-1500)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});
