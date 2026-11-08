/**
 * #1835: a stale node_modules must fail LOUDLY before any test runs, not as a code red.
 *
 * Measured 2026-11-08: the shared dev tree that most worktrees symlink dated from 08-04 and held no @langchain/*,
 * so the LangGraph saver files failed to load on every one of them, and the red read as a code failure.
 * scripts/run-tests.sh now compares the installed tree with the checkout's lockfile, dev packages included, and
 * refuses on drift. These rows cross that seam: a fixture repo with its own lockfile and node_modules, run
 * through the real run-tests.sh, with a marker file that proves whether the test file ran at all.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkInstalled } from '../scripts/deploy-deps-check.mjs';

const run = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// One temp root for the whole file, removed in after(): the suite's tmp-leak guard counts anything left behind.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deps1835-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const SCRATCH_LEDGER = path.join(TMP, 'ledger.jsonl');

// The inner `node --test` must not inherit the outer runner's context (see run-tests-helper.test.mjs).
function cleanEnv() {
  const env = { ...process.env, SCRUM_VERDICT_LEDGER: SCRATCH_LEDGER };
  for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST')) delete env[k];
  delete env.NODE_OPTIONS;
  return env;
}

const LOCK = {
  name: 'fx', lockfileVersion: 3, requires: true,
  packages: {
    '': { name: 'fx' },
    'node_modules/prodpkg': { version: '1.0.0' },
    'node_modules/devpkg': { version: '2.0.0', dev: true },
  },
};

function fixture(name, { lock = LOCK, installed = { prodpkg: '1.0.0', devpkg: '2.0.0' } } = {}) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  // the same runner universe run-tests-helper.test.mjs copies, plus the checker this card wires in
  for (const f of ['run-tests.sh', 'run-test-files.mjs', 'verdict-ledger.mjs', 'suite-tmp.mjs', 'proc-env-owned.py',
    'host-guard.mjs', 'deploy-deps-check.mjs']) {
    const src = path.join(ROOT, 'scripts', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, 'scripts', f));
  }
  if (lock) fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock));
  for (const [pkg, version] of Object.entries(installed)) {
    if (version === null) continue;
    fs.mkdirSync(path.join(dir, 'node_modules', pkg), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', pkg, 'package.json'), JSON.stringify({ name: pkg, version }));
  }
  const marker = path.join(dir, 'RAN');
  fs.writeFileSync(path.join(dir, 'tests', 'only.test.mjs'), `
    import { test } from 'node:test';
    import fs from 'node:fs';
    test('green', () => { fs.writeFileSync(${JSON.stringify(marker)}, 'yes'); });
  `);
  return { dir, marker };
}

async function runTests(dir) {
  try {
    const { stdout } = await run('sh', [path.join(dir, 'scripts', 'run-tests.sh')], { env: cleanEnv() });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.code, out: String(e.stdout) + String(e.stderr) };
  }
}

test('checkInstalled: a dev-only drift is ignored by default (the deploy contract) and caught with includeDev', () => {
  const { dir } = fixture('unit', { installed: { prodpkg: '1.0.0', devpkg: '1.9.0' } });
  const prod = checkInstalled(dir);
  assert.deepEqual(prod.mismatches, [], 'production never loads dev packages, so the deploy check stays as it was');
  assert.equal(prod.checked, 1);
  const all = checkInstalled(dir, undefined, { includeDev: true });
  assert.equal(all.checked, 2);
  assert.deepEqual(all.mismatches.map((m) => [m.name, m.want, m.have]), [['devpkg', '2.0.0', '1.9.0']]);
});

test('run-tests.sh REFUSES on drift, names the package, and runs no test', async () => {
  const { dir, marker } = fixture('drift', { installed: { prodpkg: '1.0.0', devpkg: '1.9.0' } });
  const r = await runTests(dir);
  assert.equal(r.code, 2, `a drifted tree must refuse, not run: ${r.out.slice(0, 400)}`);
  assert.match(r.out, /REFUSED: node_modules does not match package-lock\.json/);
  assert.match(r.out, /MISMATCH devpkg: lockfile 2\.0\.0, installed 1\.9\.0/, 'the drift is named');
  assert.equal(fs.existsSync(marker), false, 'no test file ran against the stale tree');
});

test('run-tests.sh REFUSES when a locked package is absent (the 11-08 specimen: no @langchain at all)', async () => {
  const { dir, marker } = fixture('absent', { installed: { prodpkg: null, devpkg: '2.0.0' } });
  const r = await runTests(dir);
  assert.equal(r.code, 2);
  assert.match(r.out, /MISMATCH prodpkg: lockfile 1\.0\.0, installed absent/);
  assert.equal(fs.existsSync(marker), false);
});

test('run-tests.sh runs as before when the tree matches the lockfile', async () => {
  const { dir, marker } = fixture('instep');
  const r = await runTests(dir);
  assert.equal(r.code, 0, r.out.slice(0, 400));
  assert.doesNotMatch(r.out, /REFUSED/);
  assert.equal(fs.existsSync(marker), true, 'the test file ran');
});

test('a tree with no lockfile is not checked, says so, and still runs (the harness fixtures copy run-tests.sh alone)', async () => {
  const { dir, marker } = fixture('nolock', { lock: null });
  const r = await runTests(dir);
  assert.equal(r.code, 0, r.out.slice(0, 400));
  assert.match(r.out, /deps: not checked/);
  assert.equal(fs.existsSync(marker), true);
});
