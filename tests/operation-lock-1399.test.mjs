/**
 * #1399 — the operation lock lives in a FILE beside the board, not on the REST
 * it guards. On 2026-09-15 two operators restarted the same service 28 minutes
 * apart: the lock was a card claim on a wedged server, and deploy.sh never read
 * it anyway (grep 1282 scripts/deploy.sh → 0 hits). This is the first check in
 * the path, not a second home for one.
 *
 * Shell-level on purpose: the thing under test is the script an operator runs,
 * and the race is between PROCESSES. A pure module would test the wrong seam.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/operation-lock.sh', import.meta.url));
const DEPLOY = fileURLToPath(new URL('../scripts/deploy.sh', import.meta.url));

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'op-lock-'));
  return { dir, lock: join(dir, 'operation-lock.json') };
};
const run = (lock, ...args) =>
  spawnSync('sh', [SCRIPT, ...args], { env: { ...process.env, DEPLOY_LOCK: lock }, encoding: 'utf8' });
const parse = (lock) => JSON.parse(readFileSync(lock, 'utf8'));

test('#1399 acquire writes holder · op · note · claimedAt; status reads them back', () => {
  const { lock } = fresh();
  const r = run(lock, 'acquire', 'deploy', 'alpha', 'shipping abc123');
  assert.equal(r.status, 0, r.stderr);
  const j = parse(lock);
  assert.equal(j.holder, 'alpha');
  assert.equal(j.op, 'deploy');
  assert.equal(j.note, 'shipping abc123');
  assert.match(j.claimedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  const s = run(lock, 'status');
  assert.equal(s.status, 0);
  assert.match(s.stdout, /alpha/);
  assert.match(s.stdout, /shipping abc123/);
});

test('#1399 a second acquire by another holder is REFUSED and names the holder and note', () => {
  const { lock } = fresh();
  assert.equal(run(lock, 'acquire', 'deploy', 'alpha', 'first').status, 0);
  const r = run(lock, 'acquire', 'restart', 'bravo', 'second');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /alpha/, 'the refusal must name who holds it');
  assert.match(r.stderr, /first/, 'the refusal must carry the holder\'s note — intent that could not be posted');
  assert.equal(parse(lock).holder, 'alpha', 'the file is untouched by the loser');
});

test('#1399 THE RACE — eight concurrent acquires, exactly one wins', async () => {
  const { lock } = fresh();
  const N = 8;
  const results = await Promise.all(Array.from({ length: N }, (_, i) => new Promise((resolve) => {
    const p = spawn('sh', [SCRIPT, 'acquire', 'deploy', `seat${i}`, `race ${i}`], { env: { ...process.env, DEPLOY_LOCK: lock } });
    p.on('exit', (code) => resolve(code));
  })));
  const winners = results.filter((c) => c === 0).length;
  assert.equal(winners, 1, `expected exactly one winner, got ${winners} of ${N}: ${results.join(',')}`);
  const j = parse(lock);
  assert.match(j.holder, /^seat\d$/);
});

test('#1399 release by the holder removes the file; release by anyone else is refused', () => {
  const { lock } = fresh();
  assert.equal(run(lock, 'acquire', 'deploy', 'alpha', 'x').status, 0);
  const wrong = run(lock, 'release', 'deploy', 'bravo');
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /alpha/);
  assert.ok(existsSync(lock), 'a refused release leaves the lock in place');
  const right = run(lock, 'release', 'deploy', 'alpha');
  assert.equal(right.status, 0, right.stderr);
  assert.ok(!existsSync(lock));
  // releasing an absent lock is a no-op, not an error — the EXIT trap runs on every path
  assert.equal(run(lock, 'release', 'deploy', 'alpha').status, 0);
});

test('#1399 a STALE lock (> 30 min) is NAMED, never overridden', () => {
  const { lock } = fresh();
  const old = new Date(Date.now() - 31 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  writeFileSync(lock, JSON.stringify({ holder: 'ghost', op: 'restart', note: 'kickstart mid-wedge', claimedAt: old, pid: 1 }));
  const r = run(lock, 'acquire', 'deploy', 'alpha', 'later');
  assert.notEqual(r.status, 0, 'stale is reported, not silently taken');
  assert.match(r.stderr, /stale/i);
  assert.match(r.stderr, /ghost/);
  assert.match(r.stderr, /kickstart mid-wedge/);
  assert.match(r.stderr, /release restart ghost/, 'the refusal says how a human clears it, by name');
  assert.equal(parse(lock).holder, 'ghost', 'the stale file survives — a human decides, not the script');
  const s = run(lock, 'status');
  assert.match(s.stdout, /stale/i);
});

test('#1399 a holder or note carrying a double quote or backslash is REFUSED at acquire (the one-line JSON reader does not un-escape, so such a holder could never release its own lock)', () => {
  const { lock } = fresh();
  for (const [holder, note] of [['x"y', 'ok'], ['ok', 'say "hi"'], ['back\\slash', 'ok']]) {
    const r = run(lock, 'acquire', 'deploy', holder, note);
    assert.notEqual(r.status, 0, `${holder} / ${note} must be refused`);
    assert.match(r.stderr, /quote|backslash/i);
    assert.ok(!existsSync(lock), 'nothing written');
  }
});

test('#1399 no lock path configured → says UNAVAILABLE, exits non-zero (fail-open is not fail-invisible)', () => {
  const r = spawnSync('sh', [SCRIPT, 'acquire', 'deploy', 'alpha'], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /DEPLOY_LOCK|DEPLOY_SHA_STAMP/);
});

test('#1399 the lock path derives from DEPLOY_SHA_STAMP\'s directory when DEPLOY_LOCK is unset', () => {
  const { dir } = fresh();
  const stamp = join(dir, 'sha-integrity.json');
  const r = spawnSync('sh', [SCRIPT, 'acquire', 'deploy', 'alpha', 'derived'],
    { env: { PATH: process.env.PATH, DEPLOY_SHA_STAMP: stamp }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(dir, 'operation-lock.json')));
});

// ── THE SEAM: deploy.sh itself ──────────────────────────────────────────────
// A fixture clone that passes deploy.sh's preconditions (a git repo, distinct
// serve dir) so the run reaches the lock and dies THERE, before any pull.
const fixtureClone = () => {
  const { dir, lock } = fresh();
  const clone = join(dir, 'clone'); const serve = join(dir, 'serve');
  mkdirSync(clone); mkdirSync(serve);
  const g = (...a) => spawnSync('git', ['-C', clone, ...a], { encoding: 'utf8' });
  g('init', '-q'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'fixture');
  return { dir, lock, clone, serve, g };
};
const deploy = (env, ...args) => spawnSync('sh', [DEPLOY, ...args],
  { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 20000 });

test('#1399 SEAM — deploy.sh refuses to run while another holder has the lock, naming them, before touching anything', () => {
  const { lock, clone, serve } = fixtureClone();
  assert.equal(run(lock, 'acquire', 'restart', 'bravo', 'kickstarting rest by hand').status, 0);
  const r = deploy({ DEPLOY_CLONE: clone, DEPLOY_SERVE: serve, DEPLOY_LOCK: lock });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /bravo/);
  assert.match(r.stderr + r.stdout, /kickstarting rest by hand/);
  assert.ok(!existsSync(join(serve, 'DEPLOYED-SHA')), 'nothing was exported');
  assert.equal(parse(lock).holder, 'bravo', 'the loser did not disturb the file');
});

test('#1399 SEAM — deploy.sh releases the lock on EVERY exit path (a dirty clone aborts after acquire; the lock must be gone)', () => {
  const { lock, clone, serve } = fixtureClone();
  writeFileSync(join(clone, 'stray.txt'), 'uncommitted');           // trips the dirty-clone refusal
  const r = deploy({ DEPLOY_CLONE: clone, DEPLOY_SERVE: serve, DEPLOY_LOCK: lock });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /🔒 operation lock: deploy held by /, 'it ACQUIRED first — without this line the next assertion is vacuous');
  assert.match(r.stdout + r.stderr, /uncommitted changes/, 'it got past the lock and died at the dirty check');
  assert.ok(!existsSync(lock), 'the EXIT trap released the lock');
  assert.match(r.stdout, /🔓 operation lock released: deploy by /, 'and SAID so — a deploy record can quote both ends');
});

test('#1399 SEAM — `deploy.sh status` reports the lock holder without taking it', () => {
  const { lock, clone, serve } = fixtureClone();
  assert.equal(run(lock, 'acquire', 'deploy', 'charlie', 'mid-deploy').status, 0);
  const r = deploy({ DEPLOY_CLONE: clone, DEPLOY_SERVE: serve, DEPLOY_LOCK: lock }, 'status');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /charlie/);
  assert.equal(parse(lock).holder, 'charlie');
});
