/**
 * #1831 — a deploy must not delete the folder a running service lives in.
 *
 * deploy.sh renames the live tree to `<serve>.previous` and the NEXT deploy
 * `rm -rf`s it. A service the deploy did not restart keeps its working directory
 * (and every path it resolved) inside that folder, so the second deploy deleted
 * it out from under the process. Measured 2026-11-07: three live services had
 * their cwd in `.previous` after a deploy that restarted only one of them.
 *
 * THE SEAM, on a fixture clone: deploy, start a process inside the served tree,
 * deploy again (the tree becomes `.previous` with the process still in it), then
 * deploy a third time — which must STOP, name the process, and leave `.previous`
 * and production as they were. Plus: an open file counts, not only a cwd; the
 * negative control (nothing holds it → it is removed as before); and an `lsof`
 * that cannot run refuses rather than reading as "nothing there".
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, copyFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEPLOY = fileURLToPath(new URL('../scripts/deploy.sh', import.meta.url));
const CHECK = fileURLToPath(new URL('../scripts/deploy-deps-check.mjs', import.meta.url));

// #1672: one temp root, made writable (deploy.sh locks the served tree read-only) and removed after.
const ROOT_TMP = mkdtempSync(join(tmpdir(), 'prev-1831-'));
const children = [];
after(() => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch {} }
  spawnSync('chmod', ['-R', 'u+w', ROOT_TMP]);
  rmSync(ROOT_TMP, { recursive: true, force: true });
});

function fixtureClone() {
  const dir = mkdtempSync(join(ROOT_TMP, 'seam-'));
  const clone = join(dir, 'clone'); const serve = join(dir, 'serve');
  mkdirSync(join(clone, 'tools'), { recursive: true }); mkdirSync(join(clone, 'scripts'), { recursive: true });
  writeFileSync(join(clone, 'tools', 'ci-verdict.mjs'), 'process.exit(0);\n');
  copyFileSync(CHECK, join(clone, 'scripts', 'deploy-deps-check.mjs'));
  writeFileSync(join(clone, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/a': { version: '1.0.0' } } }));
  writeFileSync(join(clone, '.gitignore'), 'node_modules/\n');
  mkdirSync(join(clone, 'node_modules', 'a'), { recursive: true });
  writeFileSync(join(clone, 'node_modules', 'a', 'package.json'), JSON.stringify({ name: 'a', version: '1.0.0' }));
  writeFileSync(join(clone, 'release.txt'), '0\n');
  git(clone, 'init', '-q'); git(clone, 'add', '-A'); commit(clone, 'fixture');
  return { clone, serve, previous: `${serve}.previous`, dir };
}
function git(clone, ...a) { return spawnSync('git', ['-C', clone, ...a], { encoding: 'utf8' }); }
function commit(clone, msg) { git(clone, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', msg); }
function head(clone) { return git(clone, 'rev-parse', 'HEAD').stdout.trim(); }

/** A new commit, then `deploy.sh export`. `pathPrefix` puts a fake tool first on PATH. */
function deploy(fx, n, pathPrefix) {
  writeFileSync(join(fx.clone, 'release.txt'), `${n}\n`); commit(fx.clone, `release ${n}`);
  const PATH = pathPrefix ? `${pathPrefix}:${process.env.PATH}` : process.env.PATH;
  return spawnSync('sh', [DEPLOY, 'export'], { env: { PATH, DEPLOY_CLONE: fx.clone, DEPLOY_SERVE: fx.serve }, encoding: 'utf8', timeout: 30000 });
}
const servedSha = (dir) => readFileSync(join(dir, 'DEPLOYED-SHA'), 'utf8').trim();

/** Start a long-lived process and wait until lsof can see it holding `inside`. */
async function hold(command, args, cwd, inside) {
  const c = spawn(command, args, { cwd, stdio: 'ignore' });
  children.push(c);
  for (let i = 0; i < 50; i++) {
    const r = spawnSync('lsof', ['-nP', '-p', String(c.pid), '-F', 'n'], { encoding: 'utf8' });
    if (r.stdout.includes(inside)) return c;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`fixture: pid ${c.pid} never showed as holding ${inside}`);
}

/** Deploys 1 and 2; returns the fixture with deploy 2 served and deploy 1 in `.previous`. */
function twoDeploys() {
  const fx = fixtureClone();
  const r1 = deploy(fx, 1); assert.equal(r1.status, 0, r1.stderr);
  return fx;
}

test('#1831 SEAM — a process whose WORKING DIRECTORY is in `.previous` stops the next deploy, which names it and deletes nothing', async () => {
  const fx = twoDeploys();
  const c = await hold('sleep', ['300'], fx.serve, fx.serve);  // a service running from the served tree
  const r2 = deploy(fx, 2); assert.equal(r2.status, 0, r2.stderr); // rest-only style deploy: the tree becomes .previous, the process stays in it
  const sha2 = servedSha(fx.serve);
  const r3 = deploy(fx, 3);
  assert.notEqual(r3.status, 0, 'deleting the folder a live process runs from is the bug');
  assert.match(r3.stderr, /still in use/);
  assert.match(r3.stderr, new RegExp(`pid ${c.pid}\\s+sleep`), 'the refusal names the process');
  assert.match(r3.stderr, /does NOT restart them/, 'it says it will not restart anything to clear the check');
  assert.ok(existsSync(join(fx.previous, 'DEPLOYED-SHA')), '.previous was not deleted');
  assert.equal(servedSha(fx.serve), sha2, 'production is still deploy 2');
  assert.ok(!readFileSync(join(fx.serve, 'release.txt'), 'utf8').startsWith('3'));
});

test('#1831 SEAM — an OPEN FILE in `.previous` counts too, not only a working directory', async () => {
  const fx = twoDeploys();
  const c = await hold('tail', ['-f', join(fx.serve, 'release.txt')], fx.dir, join(fx.serve, 'release.txt'));
  const r2 = deploy(fx, 2); assert.equal(r2.status, 0, r2.stderr);
  const r3 = deploy(fx, 3);
  assert.notEqual(r3.status, 0);
  assert.match(r3.stderr, new RegExp(`pid ${c.pid}\\s+tail`));
  assert.ok(existsSync(join(fx.previous, 'DEPLOYED-SHA')));
});

test('#1831 NEGATIVE CONTROL — nothing references `.previous`: it is replaced as before, and the deploy succeeds', () => {
  const fx = twoDeploys();
  const r2 = deploy(fx, 2); assert.equal(r2.status, 0, r2.stderr);
  const sha2 = servedSha(fx.serve);
  const r3 = deploy(fx, 3);
  assert.equal(r3.status, 0, r3.stderr + r3.stdout);
  assert.equal(servedSha(fx.previous), sha2, '.previous is now deploy 2');
  assert.equal(servedSha(fx.serve), head(fx.clone), 'production is deploy 3');
});

test('#1831 ⛔ an `lsof` that cannot run REFUSES: "could not look" must not read as "nothing there"', () => {
  const fx = twoDeploys();
  const r2 = deploy(fx, 2); assert.equal(r2.status, 0, r2.stderr);
  const bin = join(fx.dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'lsof'), '#!/bin/sh\necho "lsof: broken" >&2\nexit 3\n'); chmodSync(join(bin, 'lsof'), 0o755);
  const r3 = deploy(fx, 3, bin);
  assert.notEqual(r3.status, 0);
  assert.match(r3.stderr, /could NOT check whether any process is running/);
  assert.doesNotMatch(r3.stderr, /still in use/, 'a check that could not run is not reported as a holder');
  assert.ok(existsSync(join(fx.previous, 'DEPLOYED-SHA')));
});
