#!/usr/bin/env node
/**
 * #1648 — THE RECORD AND CONFIG FILES BACKUP: one verified, read-only, deduplicated set of the board's record files.
 *
 *   node scripts/record-files-backup.mjs --dest DIR --event-log-dir D --work-store F --config F [--config F ...]
 *        --min-free-bytes N [--keep-hourly N --keep-daily D] [--source-attachments DIR --source-executor URL --python PY]
 *
 * Every path is an explicit flag: no default, no environment fallback. A REFUSAL (exit 2) writes nothing into --dest:
 * a missing or malformed flag, a source that is not there, two sources with the same file name (the set is flat), only
 * some of the attachment flags, an executor that does not answer, or free space on --dest below --min-free-bytes.
 *
 * In order, into DEST/records-<UTC stamp>.partial:
 *   1. CURSORS FIRST   cursors.json (inside --event-log-dir) is read and written BEFORE any segment's cutoff is measured,
 *                      so every cursor it holds points at history the cut segments contain (the log only grows). The
 *                      verifier checks that bound against the captured segments.
 *   2. SEGMENTS        events-YYYY-MM-DD.jsonl and the work-store ledger are append-only: each is opened once, its length
 *                      measured (cutoff.measuredAt), and exactly the bytes up to the last newline at or before that length
 *                      are kept (cutoff.bytes); a half-written last line is not in the set. A segment's bytes before the
 *                      previous set's cutoff must equal that set's copy; when they do not (a redaction, or damage), it is
 *                      copied again, never linked, and named in findings as `closed-history-changed`: the set is still
 *                      verified and published, and the run is ok:false (exit 1). The next run dedupes from this set.
 *   3. CONFIGS         whole-file JSON: read, parsed (one retry), and the bytes that parsed are written. A config that
 *                      does not parse fails the capture by name, and no set is published.
 *   4. ATTACHMENTS     only with all three of --source-attachments, --source-executor, --python: the attachment drill's
 *                      paired capture (an executor checkpoint taken INSIDE the attachment fence, references in both shapes)
 *                      into attachment-capture/ and executor-snapshot/. Without them, notCovered says so.
 *   5. VERIFY          scripts/record-files-verify.mjs's verifySet on the partial set (sources passed as live files).
 *   6. PUBLISH         a verified set is made read-only (a-w on every file and directory) and renamed records-<stamp>; a
 *                      set that fails verification is renamed records-<stamp>-UNVERIFIED and is never a dedupe source.
 *                      A capture that FAILED leaves no set (its partial is removed): it is not a recovery point.
 *   7. PRUNE           only with --keep-hourly and --keep-daily, and only after a run that published and whose findings
 *                      are none or only attachment-check-failed (that one repeats every run until the board's
 *                      references are fixed; withholding pruning for it would fill DEST). Never the newest set, and
 *                      never the newest set whose own manifest records setOk (`last-clean`, keptLastClean), nor the
 *                      newest with setOk AND setPaired (`last-clean-paired`, keptLastCleanPaired: a records-only clean
 *                      set is no attachment recovery point). FAIL CLOSED: a set whose manifest cannot be read is never
 *                      pruned and is named in a set-manifest-unreadable finding. Every other kept set is then
 *                      byte-checked against its manifest (kept-set-damaged otherwise).
 *
 * Every report carries redRuns (consecutive red runs) and redSince (the ISO start time of the streak's first run, or
 * null when green), kept in DEST/.records-state.json, which pruning never touches; when that file is missing or corrupt
 * the streak is rebuilt from the sets' own manifests and the report says streakRebuilt:true.
 *
 * DEDUPE: a file whose size and sha256 equal its counterpart in the most recent PUBLISHED set (the name records-<stamp>
 * is given only after verification, and a cheap completeness check must pass) is hard-linked FROM THAT SET, after the
 * counterpart's own bytes are re-hashed; never from a live file and never from an -UNVERIFIED or .partial set. Every
 * hash in the manifest is of the bytes written to the backup (or of the linked backup file), never a re-read of a source.
 * The paired capture's files are deduped the same way AFTER the capture wrote them (the drill's capture is reused as is):
 * an attachment against the same path, a snapshot file against the same file name in the previous set's snapshot, so
 * immutable SSTs are linked and CURRENT, MANIFEST, OPTIONS and the WAL are copied. The capture's full size is therefore
 * written once per run and counted in budget.peakPartialBytes; only the files that differ stay. The manifest lists the
 * linked files under snapshots[].linked and attachments.linked.
 *
 * RESTORE: a set's files may be hard links shared with other sets. An executor is never run on them: copy the snapshot
 * to an independent writable directory first (the manifest's `restore` field says so on every set).
 *
 * One JSON report on stdout: { stage, published, setDir, files, cursorsCapturedAt, budget, pruned, findings,
 * notCovered, ok, error }. Exit 0 exactly when ok · 1 not ok · 2 refusal · 7 skipped (DEST/.records.lock is held: by
 * another run, or by a dead one, which is never reaped and needs an operator).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { stampOf, parseStamp, removeWithin } from './graph-store-backup-schedule.mjs';
import { NOT_COVERED as DRILL_NOT_COVERED, resolveSource, sourceExecutor } from './attachments-drill.mjs';
import { capture } from '../core/attachment-capture.mjs';
import { verifySet, sha256File, SET_MANIFEST, PUBLISHED_RE, SEGMENT_RE } from './record-files-verify.mjs';

export const LOCK = '.records.lock';
const CURSORS = 'cursors.json';
const CHUNK = 1 << 20;
const RESTORE_NOTE = 'files may be hard links shared with other sets: never start an executor on them; copy to an independent writable directory first';

class Refusal extends Error {}
class CaptureError extends Error { constructor(name, msg) { super(msg); this.file = name; } }

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const freeBytes = (p) => { const s = fs.statfsSync(p); return Number(s.bavail) * Number(s.bsize); };
function fsyncDir(d) { try { const fd = fs.openSync(d, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch { /* best effort */ } }

/** The offset just past the last newline at or before `len` (0 when there is none), read backwards from the end. */
function lastNewlineCut(fd, len) {
  const buf = Buffer.allocUnsafe(64 * 1024);
  let end = len;
  while (end > 0) {
    const start = Math.max(0, end - buf.length);
    const n = fs.readSync(fd, buf, 0, end - start, start);
    const i = buf.subarray(0, n).lastIndexOf(0x0a);
    if (i >= 0) return start + i + 1;
    end = start;
  }
  return 0;
}

/** sha256 of fd[0, end), plus the digest at `mark` (the previous set's cutoff) when 0 < mark <= end. */
function hashRange(fd, end, mark = -1) {
  const h = crypto.createHash('sha256'); const buf = Buffer.allocUnsafe(CHUNK);
  let pos = 0; let atMark = mark === 0 ? h.copy().digest('hex') : null;
  while (pos < end) {
    const want = Math.min(buf.length, end - pos, mark > pos ? mark - pos : Infinity);
    const n = fs.readSync(fd, buf, 0, want, pos);
    if (n === 0) throw new Error(`short read at ${pos} of ${end}`);
    h.update(buf.subarray(0, n)); pos += n;
    if (pos === mark) atMark = h.copy().digest('hex');
  }
  return { sha256: h.digest('hex'), atMark };
}

/** Copy fd[0, end) to dst (new file), hashing the bytes as they are written; fsync. */
function copyRange(fd, end, dst) {
  const h = crypto.createHash('sha256'); const buf = Buffer.allocUnsafe(CHUNK);
  const fo = fs.openSync(dst, 'wx', 0o600);
  let pos = 0;
  try {
    while (pos < end) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, end - pos), pos);
      if (n === 0) throw new Error(`short read at ${pos} of ${end}`);
      let w = 0; while (w < n) w += fs.writeSync(fo, buf, w, n - w);
      h.update(buf.subarray(0, n)); pos += n;
    }
    fs.fsyncSync(fo);
  } finally { fs.closeSync(fo); }
  return { bytes: pos, sha256: h.digest('hex') };
}

function writeBytes(dst, bytes) {
  const fo = fs.openSync(dst, 'wx', 0o600);
  try { let w = 0; while (w < bytes.length) w += fs.writeSync(fo, bytes, w, bytes.length - w); fs.fsyncSync(fo); } finally { fs.closeSync(fo); }
  return { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

/** The most recent PUBLISHED set under dest whose manifest parses and whose listed files are present at their sizes. */
export function dedupeSource(dest) {
  const named = fs.readdirSync(dest).map((n) => ({ n, m: PUBLISHED_RE.exec(n) })).filter((x) => x.m)
    .sort((a, b) => (a.m[1] < b.m[1] ? 1 : -1));
  for (const { n } of named) {
    const dir = path.join(dest, n);
    try {
      if (!fs.lstatSync(dir).isDirectory()) continue;
      const m = JSON.parse(fs.readFileSync(path.join(dir, SET_MANIFEST), 'utf8'));
      if (m.kind !== 'records-set' || !Array.isArray(m.files)) continue;
      if (!m.files.every((f) => { try { const st = fs.lstatSync(path.join(dir, f.name)); return st.isFile() && st.size === f.bytes; } catch { return false; } })) continue;
      return { dir, files: new Map(m.files.map((f) => [f.name, f])) };
    } catch { /* not a usable source */ }
  }
  return null;
}

/** The key a captured file is matched on across sets: an attachment by its path, a snapshot file by its name in the snapshot. */
const captureKey = (f) => (f.role === 'executor-snapshot' ? `snapshot:${path.basename(f.name)}` : f.role === 'attachment-capture' ? `capture:${f.name}` : null);

/**
 * Replace each captured file that has an identical counterpart (size + sha256, the counterpart RE-HASHED now) in the previous
 * published set with a hard link to that counterpart. Never links to anything outside that set. Returns the linked entries.
 */
export function dedupeCaptured(entries, prev, partial, finding = () => {}) {
  if (!prev) return [];
  const byKey = new Map();
  for (const f of prev.files.values()) { const k = captureKey(f); if (k) byKey.set(k, f); }
  const out = [];
  for (const e of entries) {
    const p = byKey.get(captureKey(e));
    if (!p || p.bytes !== e.bytes || p.sha256 !== e.sha256) continue;
    const from = path.join(prev.dir, p.name);
    try {
      const st = fs.lstatSync(from);
      if (!st.isFile() || sha256File(from) !== e.sha256) { finding('dedupe-source-damaged', e.name, `${from} no longer matches its manifest; kept the copy`); continue; }
      const dst = path.join(partial, e.name); const tmp = `${dst}.link-${process.pid}`;
      fs.linkSync(from, tmp); fs.renameSync(tmp, dst);
      e.linkedFrom = from; out.push(e);
    } catch (err) { finding('dedupe-link-failed', e.name, `${from}: ${err.message}; kept the copy`); }
  }
  return out;
}

/** Pure. sets: [{name, atMs}] (published only). Keeps the newest; the newest of each of the last N hours and D days with a set. */
export function planRetention({ sets, keepHourly, keepDaily, lastClean = null, lastCleanPaired = null }) {
  const sorted = [...sets].sort((a, b) => b.atMs - a.atMs || (a.name < b.name ? 1 : -1));
  const reasons = new Map(); const add = (s, r) => { if (!reasons.has(s.name)) reasons.set(s.name, []); reasons.get(s.name).push(r); };
  if (sorted.length) add(sorted[0], 'newest');
  // the newest set whose own run was ok:true: the last clean recovery point is kept through any red streak
  const clean = lastClean && sorted.find((s) => s.name === lastClean);
  if (clean) add(clean, 'last-clean');
  // and the newest clean PAIRED set: a records-only clean run is no attachment recovery point
  const cleanPaired = lastCleanPaired && sorted.find((s) => s.name === lastCleanPaired);
  if (cleanPaired) add(cleanPaired, 'last-clean-paired');
  const tier = (label, keyOf, n) => {
    const seen = new Set();
    for (const s of sorted) { const k = keyOf(s.atMs); if (seen.has(k)) continue; if (seen.size >= n) break; seen.add(k); add(s, `${label} ${k}`); }
  };
  tier('hourly', (ms) => new Date(ms).toISOString().slice(0, 13), keepHourly);
  tier('daily', (ms) => new Date(ms).toISOString().slice(0, 10), keepDaily);
  const keep = []; const del = [];
  for (const s of sorted) reasons.has(s.name) ? keep.push({ name: s.name, reasons: reasons.get(s.name), reason: reasons.get(s.name).join(', ') }) : del.push({ name: s.name, reason: 'held by no tier' });
  return { keep, delete: del, lastClean: clean ? clean.name : null, lastCleanPaired: cleanPaired ? cleanPaired.name : null };
}

/**
 * Every published set under dest with what its OWN manifest says of its run: { name, atMs, manifest|null, why }. A set
 * whose manifest is missing, unreadable or not a records-set manifest has manifest null and the reason in `why`.
 */
export function publishedSets(dest) {
  return fs.readdirSync(dest).map((name) => ({ name, m: PUBLISHED_RE.exec(name) }))
    .filter((x) => { try { return x.m && fs.lstatSync(path.join(dest, x.name)).isDirectory(); } catch { return false; } })
    .map((x) => {
      const s = { name: x.name, atMs: parseStamp(x.m[1]), manifest: null, why: null };
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dest, x.name, SET_MANIFEST), 'utf8'));
        if (m?.kind !== 'records-set' || !Array.isArray(m.files)) s.why = `${SET_MANIFEST} is not a records-set manifest`;
        else s.manifest = m;
      } catch (e) { s.why = `${SET_MANIFEST} ${e.code === 'ENOENT' ? 'is missing' : `cannot be read (${e.code || e.message})`}`; }
      return s;
    })
    .sort((a, b) => b.atMs - a.atMs || (a.name < b.name ? 1 : -1));
}

/**
 * Retention from the sets' OWN manifests. last-clean is the newest set whose manifest records setOk:true;
 * last-clean-paired the newest whose manifest records setOk:true AND setPaired:true. A set from before these flags
 * existed has neither and is never last-clean. FAIL CLOSED: a set whose manifest cannot be read is never
 * deleted (it could be the last clean one, and nothing else can say), and each is returned in `unreadable` for a finding.
 */
function prune(dest, { keepHourly, keepDaily }) {
  const all = publishedSets(dest);
  const unreadable = all.filter((s) => !s.manifest);
  const readable = all.filter((s) => s.manifest);
  const lastClean = readable.find((s) => s.manifest.setOk === true)?.name ?? null;
  const lastCleanPaired = readable.find((s) => s.manifest.setOk === true && s.manifest.setPaired === true)?.name ?? null;
  const plan = planRetention({ sets: readable.map((s) => ({ name: s.name, atMs: s.atMs })), keepHourly, keepDaily, lastClean, lastCleanPaired });
  for (const s of unreadable) plan.keep.push({ name: s.name, reasons: ['manifest-unreadable: never pruned'], reason: 'manifest-unreadable: never pruned' });
  const deleted = []; const refused = [];
  for (const v of plan.delete) {
    try {
      // Only DIRECTORIES are made writable: a file may be a hard link shared with a newer set, and its mode is shared too.
      const dirs = [path.join(dest, v.name)];
      for (let i = 0; i < dirs.length; i++) {
        fs.chmodSync(dirs[i], 0o755);
        for (const e of fs.readdirSync(dirs[i], { withFileTypes: true })) if (e.isDirectory()) dirs.push(path.join(dirs[i], e.name));
      }
      removeWithin(dest, v.name); deleted.push(v.name);
    } catch (e) { refused.push({ name: v.name, error: e.message }); }
  }
  try { fs.rmdirSync(path.join(dest, '.pruning')); } catch { /* absent, or holds a leftover: kept for a human */ }
  return { kept: plan.keep, deleted, refused, lastClean: plan.lastClean, lastCleanPaired: plan.lastCleanPaired,
    unreadable: unreadable.map((s) => ({ name: s.name, why: s.why })) };
}

/**
 * After a prune, every KEPT set is checked against its own manifest: each file present at its size and sha256. Kept sets
 * share inodes through dedupe links, so each inode is hashed once. Returns [{set, file, why}] (empty when all match).
 */
export function keptSetsByteCheck(dest, names) {
  const out = []; const byInode = new Map();
  for (const name of names) {
    const dir = path.join(dest, name);
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(dir, SET_MANIFEST), 'utf8')); } catch (e) { out.push({ set: name, file: SET_MANIFEST, why: `unreadable (${e.message})` }); continue; }
    for (const f of m.files) {
      const p = path.join(dir, f.name);
      let st; try { st = fs.lstatSync(p); } catch { out.push({ set: name, file: f.name, why: 'missing' }); continue; }
      if (!st.isFile() || st.size !== f.bytes) { out.push({ set: name, file: f.name, why: `size ${st.size} != recorded ${f.bytes}` }); continue; }
      const k = `${st.dev}:${st.ino}`;
      if (!byInode.has(k)) byInode.set(k, sha256File(p));
      if (byInode.get(k) !== f.sha256) out.push({ set: name, file: f.name, why: 'sha256 differs from the manifest' });
    }
  }
  return out;
}

/**
 * The red streak, kept in DEST/.records-state.json (a dot name: never a set, never pruned, so it survives pruning). It holds
 * the streak ONLY: a missing or CORRUPT file is treated the same way, the streak rebuilt from the sets' manifests and the
 * report saying streakRebuilt:true. Every
 * run that held the lock records itself: a green run resets the streak to 0 and null; a red run (ok:false, whether it
 * published or not) adds one, and the first red run's start time (ISO-8601) is redSince until the next green run.
 */
export const STATE = '.records-state.json';

/** The streak from the state file, or null when it is missing or unreadable. */
function readStateFile(dest) {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(dest, STATE), 'utf8'));
    if (Number.isSafeInteger(st.redRuns) && st.redRuns >= 0) return { redRuns: st.redRuns, redSince: st.redRuns ? (st.redSince ?? null) : null };
  } catch { /* missing or unreadable */ }
  return null;
}

/**
 * The streak WITHOUT the state file, from the published sets' own manifests: the consecutive newest sets whose manifest
 * records setOk:false, redSince the oldest of them's startedAt. A lower bound: a red run that published nothing, or a red set
 * already pruned, is not there to count.
 */
export function rebuildStreak(dest, { exclude = null } = {}) {
  let redRuns = 0; let redSince = null;
  for (const s of publishedSets(dest)) {
    if (s.name === exclude) continue;
    if (!s.manifest || typeof s.manifest.setOk !== 'boolean') break;
    if (s.manifest.setOk) break;
    redRuns += 1; redSince = s.manifest.startedAt ?? s.manifest.takenAt ?? null;
  }
  return { redRuns, redSince: redRuns ? redSince : null };
}

/**
 * The streak as it stands before this run: the state file, or (missing/unreadable) rebuilt from the sets. streakRebuilt
 * is true when a rebuild was needed and there was something to rebuild from (a fresh DEST with no state and no set is a
 * fresh streak, not a rebuilt one).
 */
export function readRedState(dest, { exclude = null } = {}) {
  const st = readStateFile(dest);
  if (st) return { ...st, streakRebuilt: false };
  const hadFile = fs.existsSync(path.join(dest, STATE));
  const hadSets = publishedSets(dest).some((s) => s.name !== exclude);
  return { ...rebuildStreak(dest, { exclude }), streakRebuilt: hadFile || hadSets };
}

/** Record this run in the streak. Only redRuns/redSince are kept in the state file: last-clean lives in the sets. */
export function recordRun(dest, { ok, at, stamp, setName = null }) {
  const prev = readRedState(dest, { exclude: setName });
  const next = ok ? { redRuns: 0, redSince: null } : { redRuns: prev.redRuns + 1, redSince: prev.redRuns ? prev.redSince : at };
  const tmp = path.join(dest, `${STATE}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify({ ...next, lastStamp: stamp, lastOk: ok, updatedAt: new Date().toISOString() })}\n`);
  fs.renameSync(tmp, path.join(dest, STATE));
  return { ...next, streakRebuilt: prev.streakRebuilt };
}

/**
 * The destination lock. FAIL CLOSED: acquiring is one atomic step, a hard link of a temp file that ALREADY holds the
 * owner record ({pid, nonce, host, startedAt}) to DEST/.records.lock. link(2) fails with EEXIST when the lock exists, so
 * two contenders can never both acquire, and the lock never exists without its owner. A lock whose owner is dead is
 * NEVER reaped here: reading the owner, judging it dead and removing it is a check-then-act race between two
 * contenders, so a stale lock stops every run until an operator removes it. Release removes the lock only while it
 * still holds THIS run's nonce, and leaves anyone else's in place.
 * Returns { release } or { held: sentence }.
 */
export function takeLock(dest) {
  const f = path.join(dest, LOCK);
  const owner = { pid: process.pid, nonce: crypto.randomBytes(16).toString('hex'), host: os.hostname(), startedAt: new Date().toISOString() };
  const tmp = `${f}.${process.pid}.${owner.nonce}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(owner)}\n`, { flag: 'wx' });
  try { fs.linkSync(tmp, f); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let held = null;
    try {
      const text = fs.readFileSync(f, 'utf8').trim();
      // a legacy lock holds a bare pid (graph-store-backup-schedule's .tick.lock shape): still a lock, judged the same way
      held = /^\d+$/.test(text) ? { pid: Number(text) } : JSON.parse(text);
      if (!held || typeof held !== 'object') held = null;
    } catch { /* unreadable: reported as such */ }
    let alive = null;
    if (Number.isSafeInteger(held?.pid) && held.pid > 0) {
      try { process.kill(held.pid, 0); alive = true; } catch (k) { alive = k.code === 'EPERM'; }
    }
    const who = held ? `pid ${held.pid} on ${held.host ?? '?'} since ${held.startedAt ?? '?'}` : 'an owner record that cannot be read';
    return { held: alive
      ? `another run holds ${f} (${who})`
      : `${f} is held by ${who}, which is ${alive === false ? 'not running' : 'unknown'}: a lock is never removed automatically, so an operator must check that no run is in progress and remove ${f}` };
  } finally { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
  return {
    release() {
      let cur = null;
      try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return false; }
      if (cur?.nonce !== owner.nonce) return false;   // not ours any more: left exactly as it is
      try { fs.unlinkSync(f); return true; } catch { return false; }
    },
  };
}

const REQUIRED = ['--dest', '--event-log-dir', '--work-store', '--config', '--min-free-bytes'];
const ATTACH = ['--source-attachments', '--source-executor', '--python'];
const USAGE = 'usage: node scripts/record-files-backup.mjs --dest DIR --event-log-dir D --work-store F --config F [--config F ...] --min-free-bytes N [--keep-hourly N --keep-daily D] [--source-attachments DIR --source-executor URL --python PY]';

export function parseArgs(argv) {
  const known = new Set([...REQUIRED, ...ATTACH, '--keep-hourly', '--keep-daily']);
  const a = { config: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]; const v = argv[i + 1];
    if (!known.has(k)) throw new Refusal(`unknown argument: ${k}`);
    if (typeof v !== 'string' || !v || v.startsWith('--')) throw new Refusal(`${k} needs a value`);
    i++;
    if (k === '--config') a.config.push(path.resolve(v));
    else if (a[k] !== undefined) throw new Refusal(`${k} given twice`);
    else a[k] = v;
  }
  const missing = REQUIRED.filter((f) => (f === '--config' ? !a.config.length : a[f] === undefined));
  if (missing.length) throw new Refusal(`missing required flag${missing.length > 1 ? 's' : ''}: ${missing.join(', ')} (no default, no environment fallback)`);
  const int = (f) => { const n = Number(a[f]); if (!Number.isSafeInteger(n) || n < 0) throw new Refusal(`${f} must be an integer >= 0 (got ${a[f]})`); return n; };
  const o = { dest: path.resolve(a['--dest']), eventLogDir: path.resolve(a['--event-log-dir']), workStore: path.resolve(a['--work-store']),
    configs: a.config, minFree: int('--min-free-bytes'), retention: null, attachments: null };
  const kh = a['--keep-hourly'] !== undefined; const kd = a['--keep-daily'] !== undefined;
  if (kh !== kd) throw new Refusal(`retention needs both --keep-hourly and --keep-daily (missing ${kh ? '--keep-daily' : '--keep-hourly'})`);
  if (kh) o.retention = { keepHourly: int('--keep-hourly'), keepDaily: int('--keep-daily') };
  const given = ATTACH.filter((f) => a[f] !== undefined);
  if (given.length && given.length < ATTACH.length) throw new Refusal(`the attachment capture needs all of ${ATTACH.join(', ')} (missing ${ATTACH.filter((f) => a[f] === undefined).join(', ')})`);
  if (given.length) o.attachments = { dir: path.resolve(a['--source-attachments']), executor: a['--source-executor'], python: a['--python'] };
  return o;
}

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** Every refusal check that reads; nothing is written. */
async function preflight(o) {
  if (!isDir(o.dest)) throw new Refusal(`--dest ${o.dest} is not an existing directory`);
  if (!isDir(o.eventLogDir)) throw new Refusal(`--event-log-dir ${o.eventLogDir} is not a directory`);
  if (!isFile(path.join(o.eventLogDir, CURSORS))) throw new Refusal(`--event-log-dir ${o.eventLogDir} holds no ${CURSORS}`);
  if (!isFile(o.workStore)) throw new Refusal(`--work-store ${o.workStore} is not a file`);
  for (const c of o.configs) if (!isFile(c)) throw new Refusal(`--config ${c} is not a file`);
  const names = [CURSORS, path.basename(o.workStore), ...o.configs.map((c) => path.basename(c)), SET_MANIFEST];
  const segs = fs.readdirSync(o.eventLogDir).filter((n) => SEGMENT_RE.test(n));
  const all = [...names, ...segs];
  const dup = all.find((n, i) => all.indexOf(n) !== i);
  if (dup) throw new Refusal(`two sources share the file name ${dup}: the set is flat, so each source needs its own name`);
  let source = null;
  if (o.attachments) {
    if (!isDir(o.attachments.dir)) throw new Refusal(`--source-attachments ${o.attachments.dir} is not a directory`);
    if (!/^https?:\/\//i.test(o.attachments.executor)) throw new Refusal(`--source-executor must be an executor URL: a paired capture is taken from a live checkpoint`);
    try { source = await resolveSource(o.attachments.executor, { python: o.attachments.python }); } catch (e) { throw new Refusal(e.message); }
  }
  const free = freeBytes(o.dest);
  if (free < o.minFree) throw new Refusal(`free space on --dest is ${free} bytes, below the --min-free-bytes floor of ${o.minFree}`);
  return { source, free };
}

export async function runBackup(o, { source, free }) {
  const report = { stage: 'capture', published: false, setDir: null, files: [], cursorsCapturedAt: null,
    budget: { copiedBytes: 0, linkedBytes: 0, setBytes: 0, peakPartialBytes: 0, freeBefore: free, freeAfter: null },
    pruned: o.retention ? null : 'not requested', keptLastClean: null, keptLastCleanPaired: null, findings: [], notCovered: [], ok: false, error: null };
  const finding = (code, name, detail) => report.findings.push({ code, name, detail });

  let stamp = stampOf(Date.now());
  for (let i = 0; i < 3 && fs.readdirSync(o.dest).some((n) => n.startsWith(`records-${stamp}`)); i++) { sleepSync(1000 - (Date.now() % 1000) + 5); stamp = stampOf(Date.now()); }
  report.stamp = stamp;
  report.startedAt = new Date().toISOString();
  const final = path.join(o.dest, `records-${stamp}`);
  const partial = `${final}.partial`;
  fs.mkdirSync(partial);
  const prev = dedupeSource(o.dest);
  const liveFiles = [];
  const room = (n) => { if (freeBytes(o.dest) - n < o.minFree) throw new CaptureError(null, `free space would fall below the --min-free-bytes floor of ${o.minFree} writing ${n} more bytes`); };

  /** Link from the previous published set when its counterpart has these exact bytes; else null. */
  const tryLink = (name, bytes, sha256, entry) => {
    const p = prev?.files.get(name);
    if (!p || p.bytes !== bytes || p.sha256 !== sha256) return false;
    const from = path.join(prev.dir, name);
    if (sha256File(from) !== sha256) { finding('dedupe-source-damaged', name, `${from} no longer matches its manifest; copied instead`); return false; }
    fs.linkSync(from, path.join(partial, name));
    Object.assign(entry, { bytes, sha256, linkedFrom: from });
    report.budget.linkedBytes += bytes;
    return true;
  };
  const counted = (entry) => { report.budget.copiedBytes += entry.bytes; report.budget.peakPartialBytes += entry.bytes; };

  const wholeJson = (src, role, extra = {}) => {
    const name = path.basename(src);
    let bytes; let err;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) sleepSync(200);
      try { bytes = fs.readFileSync(src); JSON.parse(bytes.toString('utf8')); err = null; break; } catch (e) { err = e; }
    }
    if (err) throw new CaptureError(name, `${name} does not parse as JSON after one retry (${err.message}): the capture fails`);
    liveFiles.push(src);
    const entry = { name, role, bytes: 0, sha256: null, linkedFrom: null, source: src, ...extra };
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (!tryLink(name, bytes.length, sha256, entry)) { room(bytes.length); Object.assign(entry, writeBytes(path.join(partial, name), bytes)); counted(entry); }
    report.files.push(entry);
    return entry;
  };

  const appendOnly = (src, role) => {
    const name = path.basename(src);
    const fd = fs.openSync(src, 'r');
    try {
      const len = fs.fstatSync(fd).size;
      const measuredAt = new Date().toISOString();
      const cut = lastNewlineCut(fd, len);
      liveFiles.push(src);
      const entry = { name, role, bytes: 0, sha256: null, linkedFrom: null, source: src, cutoff: { bytes: cut, measuredLength: len, measuredAt } };
      const p = prev?.files.get(name);
      let changed = false;
      const hr = p && p.bytes <= cut ? hashRange(fd, cut, p.bytes) : null;   // one pass: the whole range, and its prefix at the previous cutoff
      if (p && role === 'segment') {
        if (!hr) changed = `it now holds ${cut} complete bytes, fewer than the ${p.bytes} the previous set kept`;
        else if (hr.atMark !== p.sha256) changed = `its first ${p.bytes} bytes differ from the previous set's copy (${path.basename(prev.dir)})`;
        if (changed) finding('closed-history-changed', name, `${name}: ${changed}; copied again, never linked`);
      }
      const linked = !changed && hr && p.bytes === cut && tryLink(name, cut, hr.sha256, entry);
      if (!linked) { room(cut); Object.assign(entry, copyRange(fd, cut, path.join(partial, name))); counted(entry); }
      report.files.push(entry);
      return entry;
    } finally { fs.closeSync(fd); }
  };

  const manifest = { schema: 1, kind: 'records-set', stamp, startedAt: report.startedAt, takenAt: new Date().toISOString(), cursorsCapturedAt: null,
    files: report.files, snapshots: [], attachments: null, restore: RESTORE_NOTE };
  try {
    // 1. cursors FIRST
    wholeJson(path.join(o.eventLogDir, CURSORS), 'cursors', { capturedBeforeCutoffs: true });
    report.cursorsCapturedAt = manifest.cursorsCapturedAt = new Date().toISOString();
    // 2. segments, then the ledger
    const listed = fs.readdirSync(o.eventLogDir).sort();
    for (const n of listed) {
      if (SEGMENT_RE.test(n)) appendOnly(path.join(o.eventLogDir, n), 'segment');
      else if (n !== CURSORS) report.notCovered.push(`event-log-dir: ${n} not captured (neither a segment nor ${CURSORS})`);
    }
    appendOnly(o.workStore, 'work-store');
    // 3. configs
    for (const c of o.configs) wholeJson(c, 'config');
    // 4. the paired attachment capture
    if (o.attachments) {
      const state = { paired: false, pairing: null, references: null };
      const captureDir = 'attachment-capture';
      let got;
      try {
        got = await capture({ attachmentsDir: o.attachments.dir, outDir: path.join(partial, captureDir),
          executor: sourceExecutor(source, { scratch: partial, python: o.attachments.python, state }), waitMs: 3000 });
      } catch (e) { throw new CaptureError(captureDir, `the paired attachment capture failed: ${e.message}`); }
      for (const n of fs.readdirSync(o.attachments.dir)) liveFiles.push(path.join(o.attachments.dir, n));
      const snapDir = state.pairing?.backupDir ? path.relative(partial, state.pairing.backupDir) : null;
      if (snapDir) manifest.snapshots.push({ dir: snapDir });
      manifest.attachments = { captureDir, status: got.status, paired: state.paired, pairing: state.pairing && { ...state.pairing, backupDir: snapDir },
        references: state.references, dangling: got.manifest.dangling, unknownMetadata: got.manifest.unknownMetadata };
      report.attachments = manifest.attachments;
      if (got.status !== 'COMPLETE') finding('attachments-degraded', captureDir, `dangling references: ${got.manifest.dangling.join(', ')}`);
      for (const s of DRILL_NOT_COVERED) report.notCovered.push(`attachments: ${s}`);
      // every file the capture wrote joins the set manifest, hashed from the backup's own bytes; then each one whose size and
      // sha256 equal its counterpart in the previous published set is REPLACED by a hard link to that counterpart (re-hashed
      // first). An attachment's counterpart has the same name; a snapshot file's has the same name inside the previous set's
      // snapshot (immutable SSTs are shared by consecutive checkpoints; CURRENT, MANIFEST, OPTIONS and the WAL differ).
      const captured = [];
      const add = (rel) => {
        const abs = path.join(partial, rel);
        for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
          const r = `${rel}/${e.name}`;
          if (e.isDirectory()) add(r);
          else { const st = fs.lstatSync(path.join(partial, r)); const entry = { name: r, role: rel.startsWith('executor-snapshot') ? 'executor-snapshot' : 'attachment-capture', bytes: st.size, sha256: sha256File(path.join(partial, r)), linkedFrom: null }; counted(entry); report.files.push(entry); captured.push(entry); }
        }
      };
      add(captureDir);
      if (fs.existsSync(path.join(partial, 'executor-snapshot'))) add('executor-snapshot');
      const linked = dedupeCaptured(captured, prev, partial, finding);
      for (const e of linked) { report.budget.copiedBytes -= e.bytes; report.budget.linkedBytes += e.bytes; }
      manifest.attachments.linked = linked.filter((e) => e.role === 'attachment-capture').map((e) => e.name);
      for (const snap of manifest.snapshots) snap.linked = linked.filter((e) => e.name.startsWith(`${snap.dir}/`)).map((e) => path.basename(e.name));
    } else {
      report.notCovered.push('attachments: not captured (no --source-attachments, --source-executor and --python): the paired attachment and executor capture did not run');
    }
    report.notCovered.push('cursors.json graph_acked / graph_served (executor commitSeq) are not bounds-checked; only event-log seqs are');
    fs.writeFileSync(path.join(partial, SET_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    fsyncDir(partial);
  } catch (e) {
    report.error = e.message;
    finding('capture-failed', e.file ?? null, e.message);
    fs.rmSync(partial, { recursive: true, force: true });
    report.budget.freeAfter = freeBytes(o.dest);
    return report;
  }
  report.budget.setBytes = report.budget.copiedBytes + report.budget.linkedBytes;

  // 5. verify
  report.stage = 'verify';
  const v = verifySet({ set: partial, liveFiles, python: o.attachments?.python ?? null, published: false });
  report.verify = { ok: v.ok, checks: v.checks };
  // The attachment-refs check judges the SOURCE's references against the copy: a contradiction there (two references
  // disagreeing on a file's size, a reference to no file) is a true copy of a contradictory board. It makes the run
  // RED (ok:false, a named finding per failure) without withholding the set, like closed-history-changed. Every other
  // verification failure means the copy itself is not trustworthy, and the set is not published.
  const refFailures = v.failures.filter((f) => f.check === 'attachment-refs');
  const copyFailures = v.failures.filter((f) => f.check !== 'attachment-refs');
  for (const f of refFailures) finding('attachment-check-failed', f.file, `${f.file}: ${f.why}`);
  if (report.attachments && v.coverage) {
    report.attachments.coverage = v.coverage;
    if (v.coverage.vacuous.length) report.notCovered.push(`attachments: nothing to check (${v.coverage.vacuous.join(', ')}): the capture holds no attachments or no references`);
  }
  if (copyFailures.length) {
    for (const f of copyFailures) finding('verify-failed', f.file, `${f.check}: ${f.file}: ${f.why}`);
    report.setDir = `${final}-UNVERIFIED`;
    fs.renameSync(partial, report.setDir);
    fsyncDir(o.dest);
    report.error = `the set did not verify: ${copyFailures.map((f) => `${f.file}: ${f.why}`).join('; ')}`;
    report.budget.freeAfter = freeBytes(o.dest);
    return report;
  }

  // 6. publish: the set's own verdict into its manifest, then read-only, then the verified name. setOk: this set's own
  // capture and verification were clean (no finding at publish); setPaired: it holds a paired attachment capture. The
  // RUN's report ok can still turn red later (prune-refused, kept-set-damaged, set-manifest-unreadable concern OTHER
  // sets), so the names differ. Retention reads these flags from the sets themselves, never from a file outside them.
  report.stage = 'publish';
  Object.assign(manifest, { setOk: report.findings.length === 0, setPaired: report.attachments?.paired === true });
  const mtmp = path.join(partial, `${SET_MANIFEST}.${process.pid}.tmp`);
  fs.writeFileSync(mtmp, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(mtmp, path.join(partial, SET_MANIFEST));
  fsyncDir(partial);
  const dirs = [partial];
  for (let i = 0; i < dirs.length; i++) {
    for (const e of fs.readdirSync(dirs[i], { withFileTypes: true })) {
      const p = path.join(dirs[i], e.name);
      if (e.isDirectory()) dirs.push(p); else fs.chmodSync(p, fs.lstatSync(p).mode & 0o555);
    }
  }
  for (const d of dirs.reverse()) fs.chmodSync(d, 0o555);
  fs.renameSync(partial, final);
  fsyncDir(o.dest);
  report.published = true; report.setDir = final;
  // A run whose only red is attachment-check-failed still prunes: that finding repeats on EVERY run until the board's
  // references are corrected, and withholding pruning for it would fill DEST to the free-space floor. The set itself
  // verified on every other check. Any other finding keeps every existing set.
  const prunable = report.findings.every((f) => f.code === 'attachment-check-failed');

  // 7. prune
  if (o.retention) {
    report.stage = 'prune';
    // this run's own set is the last clean one when it has no finding so far; otherwise the newest set a clean run published
    report.pruned = prunable ? prune(o.dest, o.retention) : { skipped: 'this run has a finding other than attachment-check-failed: every existing set is kept' };
    report.keptLastClean = prunable && report.pruned.lastClean ? PUBLISHED_RE.exec(report.pruned.lastClean)[1] : null;
    report.keptLastCleanPaired = prunable && report.pruned.lastCleanPaired ? PUBLISHED_RE.exec(report.pruned.lastCleanPaired)[1] : null;
    if (prunable && report.pruned.refused.length) finding('prune-refused', null, report.pruned.refused.map((r) => `${r.name}: ${r.error}`).join('; '));
    if (prunable) {
      for (const u of report.pruned.unreadable) finding('set-manifest-unreadable', u.name, `${u.name}: ${u.why}; never pruned (it may be the last clean recovery point)`);
      const unreadableNames = new Set(report.pruned.unreadable.map((u) => u.name));
      const damaged = keptSetsByteCheck(o.dest, report.pruned.kept.map((k) => k.name).filter((n) => !unreadableNames.has(n)));
      report.pruned.keptByteCheck = damaged.length ? damaged : 'every kept set matches its manifest';
      for (const d of damaged) finding('kept-set-damaged', d.file, `${d.set}/${d.file}: ${d.why}`);
    }
  }
  report.stage = 'done';
  report.budget.freeAfter = freeBytes(o.dest);
  report.ok = report.findings.length === 0;
  return report;
}

const streakForRefusal = (dest) => { try { return dest ? readRedState(dest) : { redRuns: null, redSince: null }; } catch { return { redRuns: null, redSince: null }; } };

export async function main(argv) {
  let o; let pre;
  // a refusal writes nothing; it reports the streak as it stands (read only) when --dest can be read
  const refuse = (msg) => { console.error(`${USAGE}\nREFUSED: ${msg}`); console.log(JSON.stringify({ stage: 'refused', published: false, setDir: null, ok: false, error: msg, ...streakForRefusal(o?.dest) })); return 2; };
  try { o = parseArgs(argv); pre = await preflight(o); } catch (e) { if (e instanceof Refusal) return refuse(e.message); throw e; }
  const lock = takeLock(o.dest);
  if (lock.held) { console.error(`SKIPPED: ${lock.held}`); console.log(JSON.stringify({ stage: 'skipped', published: false, setDir: null, ok: false, error: lock.held, ...streakForRefusal(o.dest) })); return 7; }
  try {
    const report = await runBackup(o, pre);
    Object.assign(report, recordRun(o.dest, { ok: report.ok, at: report.startedAt, stamp: report.stamp, setName: report.published ? path.basename(report.setDir) : null }));
    console.log(JSON.stringify(report));
    return report.ok ? 0 : 1;
  } finally { lock.release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
