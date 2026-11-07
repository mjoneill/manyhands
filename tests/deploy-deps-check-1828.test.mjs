/**
 * #1828 — a deploy must not serve a dependency tree its lockfile does not
 * describe. deploy.sh symlinks the served tree's node_modules to the clone's and
 * installs nothing, so a new package-lock.json used to ship with the OLD packages
 * running under it — and `npm audit` reported clean, because it reads the lockfile.
 *
 * Rows: the pure check (match · behind · absent · dev skipped · optional-absent
 * skipped · nested · unreadable lockfile is an ERROR, never "no mismatches"),
 * the CLI's three exit codes, and THE SEAM — deploy.sh itself on a fixture clone,
 * refusing before the swap and serving when in step.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkInstalled } from '../scripts/deploy-deps-check.mjs';

const CHECK = fileURLToPath(new URL('../scripts/deploy-deps-check.mjs', import.meta.url));
const DEPLOY = fileURLToPath(new URL('../scripts/deploy.sh', import.meta.url));

/** A repo dir with a lockfile and an installed tree. `installed` maps lockfile path → version (null = absent). */
function fixture(lockPackages, installed) {
  const dir = mkdtempSync(join(tmpdir(), 'deps-1828-'));
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'fx' }, ...lockPackages } }));
  for (const [rel, version] of Object.entries(installed)) {
    if (version === null) continue;
    mkdirSync(join(dir, rel), { recursive: true });
    writeFileSync(join(dir, rel, 'package.json'), JSON.stringify({ name: rel.split('node_modules/').pop(), version }));
  }
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  return dir;
}
const LOCK = {
  'node_modules/a': { version: '2.1.6' },
  'node_modules/a/node_modules/b': { version: '1.0.0' },
  'node_modules/devonly': { version: '9.9.9', dev: true },
  'node_modules/fsevents': { version: '2.3.3', optional: true },
};
const IN_STEP = { 'node_modules/a': '2.1.6', 'node_modules/a/node_modules/b': '1.0.0', 'node_modules/devonly': '1.0.0', 'node_modules/fsevents': null };

test('#1828 in step: every production entry matches; a dev entry at another version and an absent OPTIONAL entry are not mismatches', () => {
  const r = checkInstalled(fixture(LOCK, IN_STEP));
  assert.deepEqual(r.mismatches, []);
  assert.equal(r.checked, 2, 'a and the nested b were checked — and only they');
});

test('#1828 THE MEASURED CASE: lockfile 2.1.6, installed 2.0.12 → a mismatch naming the package and both versions', () => {
  const r = checkInstalled(fixture(LOCK, { ...IN_STEP, 'node_modules/a': '2.0.12' }));
  assert.deepEqual(r.mismatches, [{ name: 'a', path: 'node_modules/a', want: '2.1.6', have: '2.0.12' }]);
});

test('#1828 a NESTED package behind its lockfile is caught, and an absent non-optional package reads as absent (null), not as a match', () => {
  const r = checkInstalled(fixture(LOCK, { ...IN_STEP, 'node_modules/a/node_modules/b': null }));
  assert.deepEqual(r.mismatches, [{ name: 'b', path: 'node_modules/a/node_modules/b', want: '1.0.0', have: null }]);
});

test('#1828 ⛔ NEGATIVE CONTROL — an unreadable lockfile, or one with no packages map (v1), THROWS: "could not look" must not read as "no mismatches"', () => {
  const dir = fixture(LOCK, IN_STEP);
  writeFileSync(join(dir, 'package-lock.json'), '{ not json');
  assert.throws(() => checkInstalled(dir), /cannot read/);
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 1, dependencies: {} }));
  assert.throws(() => checkInstalled(dir), /no "packages" map/);
});

test('#1828 CLI: exit 0 names the installed version of each package asked for; exit 1 prints MISMATCH lines; exit 2 on a lockfile it cannot read', () => {
  const ok = spawnSync('node', [CHECK, fixture(LOCK, IN_STEP), 'a'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /deps: 2 packages match the lockfile/);
  assert.match(ok.stdout, /installed a@2\.1\.6/);
  const bad = spawnSync('node', [CHECK, fixture(LOCK, { ...IN_STEP, 'node_modules/a': '2.0.12' })], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /MISMATCH a: lockfile 2\.1\.6, installed 2\.0\.12/);
  const dir = fixture(LOCK, IN_STEP); writeFileSync(join(dir, 'package-lock.json'), 'nope');
  const cant = spawnSync('node', [CHECK, dir], { encoding: 'utf8' });
  assert.equal(cant.status, 2);
  assert.match(cant.stderr, /CANNOT CHECK/);
});

// ── THE SEAM: deploy.sh itself ──────────────────────────────────────────────
// A fixture clone whose own tools/ci-verdict.mjs answers green, so `deploy.sh
// export` reaches export_tree and the check runs where production would.
function fixtureClone(installedA) {
  const dir = mkdtempSync(join(tmpdir(), 'deps-1828-seam-'));
  const clone = join(dir, 'clone'); const serve = join(dir, 'serve');
  mkdirSync(join(clone, 'tools'), { recursive: true }); mkdirSync(join(clone, 'scripts'), { recursive: true });
  writeFileSync(join(clone, 'tools', 'ci-verdict.mjs'), 'process.exit(0);\n');
  copyFileSync(CHECK, join(clone, 'scripts', 'deploy-deps-check.mjs'));
  writeFileSync(join(clone, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/a': { version: '2.1.6' } } }));
  writeFileSync(join(clone, '.gitignore'), 'node_modules/\n');
  mkdirSync(join(clone, 'node_modules', 'a'), { recursive: true });
  writeFileSync(join(clone, 'node_modules', 'a', 'package.json'), JSON.stringify({ name: 'a', version: installedA }));
  const g = (...a) => spawnSync('git', ['-C', clone, ...a], { encoding: 'utf8' });
  g('init', '-q'); g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'fixture');
  return { clone, serve };
}
const exportRun = ({ clone, serve }) => spawnSync('sh', [DEPLOY, 'export'],
  { env: { PATH: process.env.PATH, DEPLOY_CLONE: clone, DEPLOY_SERVE: serve }, encoding: 'utf8', timeout: 20000 });

test('#1828 SEAM — deploy.sh REFUSES when the installed tree is behind its lockfile, names the package, and leaves production untouched', () => {
  const fx = fixtureClone('2.0.12');
  const r = exportRun(fx);
  assert.notEqual(r.status, 0, 'a green deploy here is the bug');
  assert.match(r.stderr, /MISMATCH a: lockfile 2\.1\.6, installed 2\.0\.12/);
  assert.match(r.stderr, /npm ci/, 'the refusal says what to run');
  assert.match(r.stderr, /stop the services/, 'and says to stop the services first: npm ci under live services broke REST for ~1 min on 2026-11-07');
  assert.ok(!existsSync(join(fx.serve, 'DEPLOYED-SHA')), 'nothing was swapped in');
});

test('#1828 SEAM — in step, deploy.sh exports, and its output names the installed version (not an audit count)', () => {
  const fx = fixtureClone('2.1.6');
  const r = exportRun(fx);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /deps: 1 packages match the lockfile/);
  assert.ok(existsSync(join(fx.serve, 'DEPLOYED-SHA')));
  assert.equal(readFileSync(join(fx.serve, 'DEPLOYED-SHA'), 'utf8').trim().length, 40);
});

test('#1828 SEAM — ⛔ a check that exits 0 WITHOUT its verdict line is refused: silence is not "the tree matches"', () => {
  const fx = fixtureClone('2.1.6');
  writeFileSync(join(fx.clone, 'scripts', 'deploy-deps-check.mjs'), 'process.exit(0);\n');
  spawnSync('git', ['-C', fx.clone, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'silent check'], { encoding: 'utf8' });
  const r = exportRun(fx);
  assert.notEqual(r.status, 0, 'a silent check must not let the deploy through');
  assert.match(r.stderr, /printed no verdict/);
  assert.ok(!existsSync(join(fx.serve, 'DEPLOYED-SHA')));
});

test('#1828 SEAM — ⛔ REVIEW REGRESSION: an UNCOMMITTED lockfile that matches node_modules does not hide a COMMITTED one that does not — the check reads the lockfile being exported', () => {
  const fx = fixtureClone('2.0.12');                         // HEAD locks 2.1.6; installed 2.0.12
  writeFileSync(join(fx.clone, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/a': { version: '2.0.12' } } }));
  const r = exportRun(fx);                                   // `export` mode has no dirty-clone refusal
  assert.notEqual(r.status, 0, 'exporting the 2.1.6 lockfile over 2.0.12 packages is the bug');
  assert.match(r.stderr, /MISMATCH a: lockfile 2\.1\.6, installed 2\.0\.12/);
  assert.ok(!existsSync(join(fx.serve, 'DEPLOYED-SHA')));
});
