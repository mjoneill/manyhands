/**
 * #1648 — the attachment fence's RELEASE and RECOVERY under interleaving. Builder rows, written for the review of 798a26b.
 *
 * The finding: the old reaper renamed the lock aside BEFORE it checked the nonce. On a mismatch the lock path was already
 * vacant, so a contender could take it while the original live holder was still inside, and the recovery guard reaped its
 * own stale lock with the same primitive. The rows reproduce that deterministically by intercepting fs.renameSync (the
 * fence module calls it through the shared `fs` object): a contender is admitted at the exact rename boundary.
 *
 *   R1  a reaper holding an OLD observed nonce, while a live holder is inside, moves nothing; a contender is refused.
 *   R1b a reaper holding the live holder's OWN nonce moves nothing: the owner is alive.
 *   R2  a release reads its own nonce AT THE PATH first: a lock that is not its own is left in place, loudly.
 *   R3  a recovery guard whose owner is gone is NEVER reaped: recovery fails closed, retryably, naming the guard.
 *   R3b CONTROL: a dead owner with no guard in the way is recovered.
 *   R4  the post-rename nonce check is an INVARIANT: a record changed under the reaper is put back and the error is thrown.
 *   R5  a start time that cannot be read (no `ps`) keeps a lock held; with `ps` the same record is proven stale.
 *   R6  a live owner's lock is never stolen by age (an ancient acquiredAt), and the busy message names owner and pid.
 *   R7  the default wait is 3000 ms.
 *   R8  the lock never exists without its owner record: it is never mkdir'd in place, only renamed in already holding one.
 *   R9  the upload route's 503 names the holder (its owner label and pid) and says a capture is the reason.
 *
 * NOT covered: a real cross-process race (the interleaving is simulated at the rename boundary); NFS or any filesystem
 * whose rename is not atomic; pid reuse within one second of the dead owner's start (ps lstart's resolution).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startRestServer } from './helpers/harness.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FENCE = path.join(REPO, 'core', 'attachment-fence.mjs');
const { withAttachmentFence, fenceLockPath, _fenceInternalsForTests: T } = await import(pathToFileURL(FENCE).href);

const temps = [];
after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });
function attDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fr1648-')); temps.push(root);
  const dir = path.join(root, 'attachments'); fs.mkdirSync(dir); return dir;
}
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
const recordAt = (lock) => { try { return JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')); } catch { return null; } };
const startOf = (pid) => execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
function plant(lock, rec) {
  const full = { owner: 'planted', pid: process.pid, startedAt: 'never', nonce: crypto.randomUUID(), acquiredAt: new Date().toISOString(), ...rec };
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(full)); return full;
}
/** a pid that WAS a process and is now gone */
function deadPid() { const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }); return Number(r.stdout); }

/** Run body with fs.renameSync intercepted: hook(from, to, phase) is called 'before' and 'after' each real rename. */
async function withRenameHook(hook, body) {
  const real = fs.renameSync;
  fs.renameSync = function (from, to) { hook(String(from), String(to), 'before'); const out = real.apply(this, arguments); hook(String(from), String(to), 'after'); return out; };
  try { return await body(); } finally { fs.renameSync = real; }
}

/** A live holder that stays inside until released; `inside` reads true only while it is. */
async function liveHolder(dir, owner = 'live-holder') {
  const out = gate(); const entered = gate(); const state = { inside: false };
  const running = withAttachmentFence(async () => { state.inside = true; entered.open(); await out.p; state.inside = false; }, { attachmentsDir: dir, waitMs: 2000, owner });
  running.catch(() => {});
  await entered.p;
  return { state, running, release: out.open };
}
/** A contender that tries once (it takes the lock synchronously if the path is vacant) and records whether it got in. */
function contender(dir, state, overlap) {
  const p = withAttachmentFence(async () => { state.inside = true; if (overlap()) state.overlapped = true; await new Promise((r) => setTimeout(r, 50)); state.inside = false; },
    { attachmentsDir: dir, waitMs: 200, owner: 'contender' });
  p.catch(() => {});
  return p;
}

test('#1648 (R1) a reaper with an OLD observed nonce, while a live holder is inside, moves nothing; a contender at the rename boundary is refused', { timeout: 30000 }, async () => {
  const dir = attDir(); const lock = fenceLockPath(dir);
  const A = await liveHolder(dir);
  const mine = recordAt(lock);
  const C = { inside: false, overlapped: false }; let cRun = null;
  let reaped;
  await withRenameHook((from, to, phase) => {
    if (phase === 'after' && from === lock && to.endsWith('.reaped') && !cRun) cRun = contender(dir, C, () => A.state.inside);
  }, async () => {
    try { reaped = T.reapIfDead(lock, 'stale-observed-nonce'); } catch (e) { reaped = e; }
  });
  if (!cRun) cRun = contender(dir, C, () => A.state.inside);   // a contender comes either way: the path must still be held
  await cRun.then(() => {}, () => {});
  assert.equal(C.overlapped, false, 'never two holders: the contender never ran while the live holder was inside');
  assert.equal(reaped, false, `the stale reap removed nothing (${reaped})`);
  assert.equal(recordAt(lock)?.nonce, mine.nonce, 'the live holder\'s record is still at the lock path');
  A.release(); await A.running;
});

test('#1648 (R1b) a reaper holding the live holder\'s OWN nonce moves nothing: its owner is alive', { timeout: 30000 }, async () => {
  const dir = attDir(); const lock = fenceLockPath(dir);
  const A = await liveHolder(dir);
  const mine = recordAt(lock);
  let r; try { r = T.reapIfDead(lock, mine.nonce); } catch (e) { r = e; }
  assert.equal(r, false, `nothing reaped (${r})`);
  assert.equal(recordAt(lock)?.nonce, mine.nonce, 'and the record is where it was');
  A.release(); await A.running;
});

test('#1648 (R2) a release reads its own nonce at the path first: a lock that is not its own is left in place, loudly, and no contender gets in', { timeout: 30000 }, async () => {
  const dir = attDir(); const lock = fenceLockPath(dir);
  let other = null;
  const C = { inside: false, overlapped: false }; let cRun = null;
  const run = withRenameHook((from, to, phase) => {
    if (phase === 'after' && from === lock && to.endsWith('.reaped') && !cRun) cRun = contender(dir, C, () => true);
  }, () => withAttachmentFence(async () => {
    // while inside, the lock path comes to hold ANOTHER holder's record (how it got there is not this holder's business)
    fs.rmSync(lock, { recursive: true }); other = plant(lock, { owner: 'someone-else', startedAt: startOf(process.pid) });
  }, { attachmentsDir: dir, waitMs: 2000, owner: 'first' }));
  await assert.rejects(run, (e) => e.code === 'ATTACHMENT_FENCE_INVARIANT', 'the release says the lock is not its own');
  if (cRun) await cRun.then(() => {}, () => {});
  assert.equal(C.overlapped, false, 'no contender was admitted at the release\'s rename boundary');
  assert.equal(recordAt(lock)?.nonce, other.nonce, 'the other holder\'s record is still at the lock path');
});

test('#1648 (R3) a recovery guard whose owner is gone is NEVER reaped: recovery fails closed, retryably, naming the guard', { timeout: 30000 }, async () => {
  const dir = attDir(); const lock = fenceLockPath(dir); const guard = T.recoveryGuardPath(dir);
  const stale = plant(lock, { owner: 'dead-capture', pid: deadPid() });
  const g = plant(guard, { owner: 'dead-recoverer', pid: deadPid() });
  await assert.rejects(() => withAttachmentFence(async () => 'got', { attachmentsDir: dir, waitMs: 1000, owner: 'upload' }),
    (e) => e.code === 'ATTACHMENT_FENCE_BUSY' && e.retryable === true && e.message.includes(guard), 'refused, retryably, with the guard path named');
  assert.equal(recordAt(guard)?.nonce, g.nonce, 'the guard was not reaped');
  assert.equal(recordAt(lock)?.nonce, stale.nonce, 'and the stale lock was not touched without it');
});

test('#1648 (R3b) CONTROL: a dead owner with no guard in the way is recovered', { timeout: 30000 }, async () => {
  const dir = attDir(); const lock = fenceLockPath(dir);
  plant(lock, { owner: 'dead-capture', pid: deadPid() });
  assert.equal(await withAttachmentFence(async () => 'got', { attachmentsDir: dir, waitMs: 2000, owner: 'upload' }), 'got');
  assert.equal(fs.existsSync(lock), false, 'and released');
  assert.equal(fs.existsSync(T.recoveryGuardPath(dir)), false, 'the guard is gone too');
});

test('#1648 (R4) the post-rename nonce check is an INVARIANT: a record changed under the reaper is put back and the error is thrown', { timeout: 30000 }, async () => {
  const dir = attDir(); const lock = fenceLockPath(dir);
  const stale = plant(lock, { owner: 'dead-capture', pid: deadPid() });
  let swapped = null;
  let r;
  await withRenameHook((from, to, phase) => {
    if (phase === 'before' && from === lock && to.endsWith('.reaped') && !swapped) {
      // an actor that breaks the rules rewrites the record between the reaper's read and its rename
      swapped = { ...stale, owner: 'rule-breaker', nonce: crypto.randomUUID() };
      fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(swapped));
    }
  }, async () => { try { r = T.reapIfDead(lock, stale.nonce); } catch (e) { r = e; } });
  assert.ok(swapped, 'PRECONDITION: the reaper reached its rename');
  assert.equal(r?.code, 'ATTACHMENT_FENCE_INVARIANT', `the breach is thrown, not returned as "not ours" (${r})`);
  assert.equal(recordAt(lock)?.nonce, swapped.nonce, 'and the record it moved was put back');
});

test('#1648 (R5) a start time that cannot be read keeps a lock held (fail closed); with ps the same record is proven stale', { timeout: 30000 }, async () => {
  const dir = attDir(); const lock = fenceLockPath(dir);
  plant(lock, { owner: 'live-pid-wrong-start', pid: process.pid, startedAt: 'Thu Jan  1 00:00:00 1970' });
  const code = `import(${JSON.stringify(pathToFileURL(FENCE).href)}).then((m) => m.withAttachmentFence(async () => 'ACQUIRED', { attachmentsDir: ${JSON.stringify(dir)}, waitMs: 700, owner: 'no-ps' }))`
    + `.then((v) => console.log(v), (e) => console.log(e.code))`;
  const child = await new Promise((resolve) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { PATH: path.join(os.tmpdir(), 'no-such-bin-1648') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('exit', () => resolve(out.trim()));
  });
  assert.equal(child, 'ATTACHMENT_FENCE_BUSY', 'without ps the start time is unknown, so the lock stays held');
  assert.ok(fs.existsSync(lock), 'and was not touched');
  assert.equal(await withAttachmentFence(async () => 'got', { attachmentsDir: dir, waitMs: 2000, owner: 'with-ps' }), 'got', 'CONTROL: with ps the wrong start time proves the owner gone');
});

test('#1648 (R6) a live owner\'s lock is never stolen by AGE (an ancient acquiredAt, old mtimes), and the busy message names owner and pid', { timeout: 30000 }, async () => {
  const dir = attDir(); const lock = fenceLockPath(dir);
  plant(lock, { owner: 'ancient-but-alive', pid: process.pid, startedAt: startOf(process.pid), acquiredAt: '2000-01-01T00:00:00.000Z' });
  const old = new Date('2000-01-01T00:00:00Z');
  fs.utimesSync(path.join(lock, 'owner.json'), old, old); fs.utimesSync(lock, old, old);
  await assert.rejects(() => withAttachmentFence(async () => 'stolen', { attachmentsDir: dir, waitMs: 600, owner: 'impatient' }),
    (e) => e.code === 'ATTACHMENT_FENCE_BUSY' && e.message.includes('ancient-but-alive') && e.message.includes(`pid ${process.pid}`), 'held, and the message names who holds it');
  assert.equal(recordAt(lock)?.owner, 'ancient-but-alive');
});

test('#1648 (R7) the default wait is 3000 ms', { timeout: 30000 }, async () => {
  const dir = attDir(); const lock = fenceLockPath(dir);
  plant(lock, { owner: 'alive', pid: process.pid, startedAt: startOf(process.pid) });
  const t0 = Date.now();
  await assert.rejects(() => withAttachmentFence(async () => 'x', { attachmentsDir: dir, owner: 'default-wait' }), (e) => e.code === 'ATTACHMENT_FENCE_BUSY');
  const ms = Date.now() - t0;
  assert.ok(ms >= 2900 && ms < 4500, `waited about 3000 ms (${ms})`);
});

test('#1648 (R8) the lock never exists without its owner record: it is never created in place, only renamed in holding one', { timeout: 30000 }, async () => {
  const dir = attDir(); const lock = fenceLockPath(dir);
  const seen = [];
  const realMkdir = fs.mkdirSync;
  fs.mkdirSync = function (p) { if (path.resolve(String(p)) === lock) seen.push('mkdir at the lock path'); return realMkdir.apply(this, arguments); };
  try {
    await withRenameHook((from, to, phase) => {
      if (phase === 'before' && to === lock && !fs.existsSync(path.join(from, 'owner.json'))) seen.push(`renamed in without a record: ${from}`);
      if (phase === 'after' && to === lock && !recordAt(lock)) seen.push('the lock exists with no readable record');
    }, () => withAttachmentFence(async () => { if (!recordAt(lock)) seen.push('inside, with no record at the lock'); }, { attachmentsDir: dir, waitMs: 1000, owner: 'r8' }));
  } finally { fs.mkdirSync = realMkdir; }
  assert.deepEqual(seen, []);
});

test('#1648 (R9) the upload route\'s 503 names the holder (owner and pid) and the capture as the reason', { timeout: 60000 }, async () => {
  const rest = await startRestServer({ env: { SCRUM_ATTACHMENT_FENCE_WAIT_MS: '300' } });
  try {
    const lock = fenceLockPath(rest.attachmentsDir);
    plant(lock, { owner: 'r9-capture', pid: process.pid, startedAt: startOf(process.pid) });
    const r = await fetch(`${rest.baseUrl}/api/attachments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'a.txt', mime: 'text/plain', data: Buffer.from('x').toString('base64') }) });
    const body = await r.json();
    assert.equal(r.status, 503);
    assert.match(body.error, /capture/i);
    assert.ok(body.error.includes('r9-capture') && body.error.includes(`pid ${process.pid}`), `the holder is named: ${body.error}`);
    fs.rmSync(lock, { recursive: true, force: true });
  } finally { await rest.stop(); }
});
