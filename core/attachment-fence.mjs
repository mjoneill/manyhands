/**
 * core/attachment-fence.mjs — #1648: the ATTACHMENT FENCE, a process-shared, cooperative, exclusive lock around every
 * attachment byte write made through this app's code and around the paired capture (core/attachment-capture.mjs).
 *
 *   withAttachmentFence(fn, { attachmentsDir, waitMs, owner }) -> fn()'s result
 *
 * THE LOCK is a directory named `<attachmentsDir>.fence`, beside the attachments directory (never inside it: a capture
 * copies that directory, and a write failure there must not be a lock failure). It holds `owner.json`:
 * { owner, pid, startedAt, nonce, acquiredAt }. It is taken ATOMICALLY WITH its owner record: the record is written into
 * a private temp directory first, which is then renamed onto the lock path. A rename onto a lock that exists (it is never
 * empty) fails, so there is no moment at which the lock exists without saying whose it is.
 *
 * WHILE ANOTHER OWNER HOLDS IT a caller polls for up to waitMs, then rejects with an Error whose `code` is
 * 'ATTACHMENT_FENCE_BUSY', `retryable` is true, and whose message names the holder.
 *
 * STALE-LOCK RECOVERY FAILS CLOSED. A lock is recovered only when its owner is PROVEN gone:
 *   - its pid is not a running process (kill(pid, 0) answers ESRCH), or
 *   - its pid is running but that process started at a different time than the one recorded (pid reuse).
 * Anything else holds: a live owner, a record that cannot be read or parsed, a start time `ps` cannot report. AGE ALONE
 * NEVER STEALS THE LOCK: nothing here reads an mtime. Start times come from `ps -o lstart=`, which has one-second
 * resolution, so a pid reused inside the same second as the dead owner's start would read as the owner and stay held
 * (the safe side).
 *
 * ONE RECOVERER. Recovery runs under a second lock, the recovery guard `<attachmentsDir>.fence.recover`, taken the same
 * atomic way. Inside it the recoverer reads the record AT THE LOCK PATH and moves the lock aside only if that record
 * still carries the observed nonce and its owner is proven gone; it never renames first and checks after. A normal
 * release likewise reads its own nonce at the path before it moves anything. The guard itself is NEVER reaped: a guard
 * whose owner is gone fails the fence closed, with a retryable error naming the guard, until an operator clears it.
 *
 * COOPERATIVE: it fences writers that call it. A direct filesystem write by an operator, a script or another process is
 * not fenced (scripts/attachments-drill.mjs reports that under "not covered").
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const FENCE_BUSY = 'ATTACHMENT_FENCE_BUSY';
export const DEFAULT_WAIT_MS = 3000;
const POLL_MS = 50;
const LIVENESS_EVERY_MS = 200;   // a `ps` per poll would be a process per 50 ms for every waiter
const RECORD = 'owner.json';

/** The lock path for an attachments directory. Exported for diagnostics and tests; writers go through withAttachmentFence. */
export const fenceLockPath = (dir) => `${path.resolve(dir)}.fence`;

/** The start time of a running pid as `ps` reports it, or null when it cannot be read. */
function startTimeOf(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim();
    return out || null;
  } catch { return null; }
}
let ownStart;
const ownStartTime = () => (ownStart ??= startTimeOf(process.pid));

/** 'alive' | 'dead' | 'unknown' for an owner record. Only 'dead' permits recovery. */
function ownerState(rec) {
  if (!rec || !Number.isSafeInteger(rec.pid) || rec.pid <= 0 || typeof rec.startedAt !== 'string' || !rec.startedAt) return 'unknown';
  try { process.kill(rec.pid, 0); } catch (e) {
    if (e.code === 'ESRCH') return 'dead';
    if (e.code !== 'EPERM') return 'unknown';   // EPERM: it exists, under another user
  }
  const now = startTimeOf(rec.pid);
  if (now === null) return 'unknown';
  return now === rec.startedAt ? 'alive' : 'dead';
}

function readRecord(lock) {
  try { return JSON.parse(fs.readFileSync(path.join(lock, RECORD), 'utf8')); } catch { return null; }
}

/** Take `lock` with a fresh owner record, atomically. Returns the record, or null if someone else holds it. */
function tryTake(lock, owner) {
  const rec = { owner: String(owner || 'unnamed'), pid: process.pid, startedAt: ownStartTime(), nonce: crypto.randomUUID(), acquiredAt: new Date().toISOString() };
  const tmp = `${lock}.${process.pid}.${rec.nonce}.tmp`;
  fs.mkdirSync(tmp);
  try {
    fs.writeFileSync(path.join(tmp, RECORD), JSON.stringify(rec));
    try { fs.renameSync(tmp, lock); } catch (e) {
      if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST' || e.code === 'ENOTDIR' || e.code === 'EISDIR') return null;
      throw e;
    }
    return rec;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

export const FENCE_INVARIANT = 'ATTACHMENT_FENCE_INVARIANT';

/**
 * Move `lock` aside and remove it. The CALLER has already read the record AT THE LOCK PATH and decided on that
 * record: this never decides. The re-read of the moved record is an INVARIANT check: a different record means the
 * lock changed hands between the read and the rename, which the rules below make impossible; it is put back if it
 * can be, and the error is thrown whatever happened, so the breach is loud and never quietly treated as "not ours".
 */
function moveAsideAndRemove(lock, nonce) {
  const aside = `${lock}.${process.pid}.${crypto.randomUUID()}.reaped`;
  try { fs.renameSync(lock, aside); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  const rec = readRecord(aside);
  if (rec?.nonce === nonce) { fs.rmSync(aside, { recursive: true, force: true }); return true; }
  let restored = false;
  try { fs.renameSync(aside, lock); restored = true; } catch { /* reported below */ }
  throw Object.assign(new Error(`attachment fence invariant broken: ${lock} changed between reading its owner record (nonce ${nonce}) and moving it aside `
    + `(it held ${rec ? `${rec.owner}, nonce ${rec.nonce}` : 'no readable record'}); ${restored ? 'it was put back' : `it could NOT be put back and is at ${aside}`}. Operator action needed.`),
  { code: FENCE_INVARIANT, lock, aside: restored ? null : aside });
}

/** A normal release: read OUR nonce at the path before touching it. A lock that is not ours is never moved. */
function releaseLock(lock, nonce) {
  const rec = readRecord(lock);
  if (rec?.nonce !== nonce) {
    throw Object.assign(new Error(`attachment fence invariant broken: on release, ${lock} does not carry this holder's record (nonce ${nonce}; found ${rec ? `${rec.owner}, nonce ${rec.nonce}` : 'none'}). It was left as it is. Operator action needed.`),
      { code: FENCE_INVARIANT, lock });
  }
  return moveAsideAndRemove(lock, nonce);
}

/**
 * Under the recovery guard: remove `lock` only if the record AT THE PATH still carries `observedNonce` AND its owner is
 * proven gone. Anything else (another nonce, a live owner, an unreadable record) leaves it exactly as it is.
 * Safe between the read and the rename because nothing else may remove a lock whose owner is gone except a holder of
 * the guard, a lock that exists cannot be taken, and a dead owner cannot release.
 */
function reapIfDead(lock, observedNonce) {
  const rec = readRecord(lock);
  if (!rec || rec.nonce !== observedNonce || ownerState(rec) !== 'dead') return false;
  return moveAsideAndRemove(lock, observedNonce);
}

/**
 * One attempt at recovering a lock whose owner looked gone. Synchronous: no other caller in this process interleaves.
 * The recovery guard is NEVER cleared automatically: a guard whose owner is gone means a recoverer died mid-recovery,
 * and the fence then fails closed (the retryable busy error, naming the guard) until an operator clears it.
 */
function tryRecover(lock, staleNonce) {
  const guard = `${lock}.recover`;
  const mine = tryTake(guard, 'attachment fence recovery');
  if (!mine) {
    const g = readRecord(guard);
    if (g && ownerState(g) === 'dead') {
      throw Object.assign(new Error(`the attachment fence cannot be recovered: its recovery guard ${guard} belongs to ${g.owner} (pid ${g.pid}), which is gone. `
        + `The guard is never cleared automatically; an operator must check that nothing is recovering and remove ${guard}`), { code: FENCE_BUSY, retryable: true, guard });
    }
    return false;   // another recoverer is at work, or its record cannot be read yet: wait
  }
  try { return reapIfDead(lock, staleNonce); } finally { releaseLock(guard, mine.nonce); }
}

/** For the race rows only: the guarded reaping step and the guard's path. Nothing in the app calls these. */
export const _fenceInternalsForTests = Object.freeze({ reapIfDead, recoveryGuardPath: (dir) => `${fenceLockPath(dir)}.recover` });

function busyError(rec, waitMs) {
  const who = rec ? `${rec.owner} (pid ${rec.pid}, since ${rec.acquiredAt})` : 'an owner whose record cannot be read';
  return Object.assign(new Error(`the attachment fence is held by ${who}; gave up after ${waitMs} ms`), { code: FENCE_BUSY, retryable: true, holder: rec });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run fn while holding the fence; release it however fn ends. */
export async function withAttachmentFence(fn, { attachmentsDir, waitMs = DEFAULT_WAIT_MS, owner } = {}) {
  if (typeof attachmentsDir !== 'string' || !attachmentsDir) throw new TypeError('withAttachmentFence needs an attachmentsDir');
  const lock = fenceLockPath(attachmentsDir);
  const wait = Number.isFinite(waitMs) && waitMs >= 0 ? waitMs : DEFAULT_WAIT_MS;
  const t0 = Date.now();
  let lastLiveness = -Infinity; let held = null; let rec;
  for (;;) {
    held = tryTake(lock, owner);
    if (held) break;
    rec = readRecord(lock);
    if (rec && Date.now() - lastLiveness >= LIVENESS_EVERY_MS) {
      lastLiveness = Date.now();
      if (ownerState(rec) === 'dead' && tryRecover(lock, rec.nonce)) continue;
    }
    if (Date.now() - t0 >= wait) throw busyError(rec, wait);
    await sleep(Math.min(POLL_MS, Math.max(1, wait - (Date.now() - t0))));
  }
  try { return await fn(); } finally { releaseLock(lock, held.nonce); }
}
