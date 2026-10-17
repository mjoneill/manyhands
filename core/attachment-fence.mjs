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
 * ONE RECOVERER. Recovery runs under a second lock, `<attachmentsDir>.fence.recover`, taken the same atomic way. Inside
 * it the recoverer re-reads the record and removes the lock only if it still carries the dead owner's nonce, so two
 * recoverers can never both act, and no recoverer can remove a lock a live owner took after the dead one. A recover
 * lock whose own owner is proven gone is cleared by renaming it aside and checking the renamed record's nonce.
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

/** Remove `lock` only if it still carries `nonce`. Rename aside first, so the check and the removal see the same record. */
function removeIfNonce(lock, nonce) {
  const aside = `${lock}.${process.pid}.${crypto.randomUUID()}.reaped`;
  try { fs.renameSync(lock, aside); } catch { return false; }
  const rec = readRecord(aside);
  if (rec?.nonce === nonce) { fs.rmSync(aside, { recursive: true, force: true }); return true; }
  // not the record we meant: put it back (the lock path is empty again unless a third party took it in this instant)
  try { fs.renameSync(aside, lock); } catch { /* left aside: its owner's release finds nothing and its holder is told nothing */ }
  return false;
}

/** One attempt at recovering a lock whose owner is proven gone. Synchronous: no other caller in this process interleaves. */
function tryRecover(lock, staleNonce) {
  const recover = `${lock}.recover`;
  let mine = tryTake(recover, 'attachment fence recovery');
  if (!mine) {
    const r = readRecord(recover);
    if (r && ownerState(r) === 'dead') removeIfNonce(recover, r.nonce);
    mine = tryTake(recover, 'attachment fence recovery');
    if (!mine) return false;
  }
  try {
    const rec = readRecord(lock);
    if (rec?.nonce !== staleNonce || ownerState(rec) !== 'dead') return false;
    return removeIfNonce(lock, staleNonce);
  } finally { removeIfNonce(recover, mine.nonce); }
}

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
  try { return await fn(); } finally { removeIfNonce(lock, held.nonce); }
}
