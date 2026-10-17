#!/usr/bin/env node
/**
 * #1648 — VERIFY A RECORD-FILES SET (made by scripts/record-files-backup.mjs).
 *
 *   node scripts/record-files-verify.mjs --set DIR --live-root R [--live-root R ...] [--python PY]
 *
 * Knows nothing the backup told it except the set directory and its records-manifest.json. Every check runs and every
 * failure is reported by file name; the result is one JSON object on stdout: { ok, set, checks, failures:[{file, why}] }.
 * Exit 0 exactly when ok, 1 on a failure, 2 on usage.
 *
 * The checks:
 *   manifest     records-manifest.json parses and lists files
 *   bytes        every listed file is a regular file (never a symlink) at its recorded size and sha256
 *   complete     no file in the set tree is unlisted (a dirty set is not a set)
 *   live-inode   no file in the set shares an inode with any file under a --live-root (walked recursively, symlinks not
 *                followed, the backup tree that holds this set skipped). This REPLACES graph-store-backup's nlink rule:
 *                a dedupe link to another set in the same backup tree is allowed; a link to a live file never is
 *   read-only    a PUBLISHED set (named records-<stamp>) has no write bit on any file or directory
 *   cursors      every event-log seq in cursors.json (acked, served, last_inbound_seq) is an integer within
 *                [0, the highest seq of the captured segments]: a restored cursor must not point past restored history
 *   snapshot     for each executor snapshot in the set (the paired capture): its backup-manifest.json lists exactly its
 *                files at their sizes and hashes, and a SEPARATE python process opens it READ-ONLY (graph-store-backup's
 *                PY_READ) and must see the checkpoint's quads, datasetId, epoch and commitSeq. That is a read-only open,
 *                not an executor: no executor is ever started on the files of a set
 *   attachments  the paired capture's own manifest agrees with the set manifest on every attachment's size and hash
 *   attachment-refs  scripts/attachments-restore-check.mjs's checkRestore over the set's attachment copy with the set's own
 *                refs.json: any failure (ref-size-mismatch among them: two references that disagree on a file's size cannot
 *                both be right) fails, named. A reference that was ALREADY dangling at capture, and a set with no
 *                attachments at all, are coverage, not failures: they are returned under `coverage`, never counted as failures
 *
 * Every requested --live-root must be readable all the way down: a missing root, an unreadable one, or a directory that
 * fails part-way through the scan fails live-inode with the root named. A readable, empty root is valid.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PY_READ, MANIFEST as BACKUP_MANIFEST } from './graph-store-backup.mjs';
import { checkRestore } from './attachments-restore-check.mjs';

export const SET_MANIFEST = 'records-manifest.json';
export const PUBLISHED_RE = /^records-(\d{8}T\d{6}Z)$/;
export const SEGMENT_RE = /^events-\d{4}-\d{2}-\d{2}\.jsonl$/;
export const CURSOR_SEQ_FIELDS = Object.freeze(['acked', 'served', 'last_inbound_seq']);

export function sha256File(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const buf = Buffer.allocUnsafe(1 << 20);
  try { for (;;) { const n = fs.readSync(fd, buf, 0, buf.length, null); if (n === 0) break; h.update(buf.subarray(0, n)); } }
  finally { fs.closeSync(fd); }
  return h.digest('hex');
}

/**
 * Every entry under dir, relative names, symlinks reported as such and never followed. A directory that cannot be read
 * (the root itself included) is reported through onError and never silently skipped: an inventory with a hole in it
 * is not an inventory.
 */
function walk(dir, { skip = () => false, onError = () => {} } = {}) {
  const out = [];
  const go = (abs, rel) => {
    let ents; try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { onError(abs, e); return; }
    for (const e of ents) {
      const a = path.join(abs, e.name); const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) { out.push({ abs: a, rel: r, kind: 'symlink' }); continue; }
      if (e.isDirectory()) { if (skip(a)) continue; out.push({ abs: a, rel: r, kind: 'dir' }); go(a, r); continue; }
      out.push({ abs: a, rel: r, kind: e.isFile() ? 'file' : 'other' });
    }
  };
  go(dir, '');
  return out;
}

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/** The highest seq in the captured segments: each segment's last complete line (seq is global and increasing). */
export function maxCapturedSeq(segmentPaths) {
  let max = 0;
  for (const p of segmentPaths) {
    const text = fs.readFileSync(p, 'utf8');
    const lines = text.split('\n').filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      let e; try { e = JSON.parse(lines[i]); } catch { continue; }
      if (Number.isFinite(e?.seq)) { max = Math.max(max, e.seq); break; }
    }
  }
  return max;
}

/** Pure of the files: the cursors' problems against a max seq, as sentences. */
export function cursorProblems(cursors, maxSeq) {
  const out = [];
  if (!cursors || typeof cursors !== 'object' || !cursors.seats || typeof cursors.seats !== 'object') return ['cursors.json has no seats object'];
  for (const [seat, s] of Object.entries(cursors.seats)) {
    for (const k of CURSOR_SEQ_FIELDS) {
      const v = s?.[k];
      if (v === null || v === undefined) continue;
      if (!Number.isSafeInteger(v) || v < 0) out.push(`cursors.json: seat ${seat} ${k} ${JSON.stringify(v)} is not a seq`);
      else if (v > maxSeq) out.push(`cursors.json: seat ${seat} ${k} ${v} is beyond the captured log (its highest seq is ${maxSeq})`);
    }
  }
  return out;
}

// What the restore checker reports that is COVERAGE, not a defect of the copy: a reference whose file was already gone
// at capture (the capture's `dangling`, its DEGRADED status) and a set with nothing to resolve (no attachments at all).
const VACUOUS = new Set(['no-references', 'manifest-empty']);

/**
 * scripts/attachments-restore-check.mjs's checkRestore over SET/<captureDir>/attachments with the capture's manifest and
 * refs.json, all read from the set. Returns { failures, coverage: { dangling, vacuous, sizeUnknown, orphans } }: every
 * checker failure is a failure (ref-size-mismatch, hash-mismatch, unexpected-file, ...) except the coverage cases above,
 * which are returned separately so a degraded capture is never mistaken for a damaged one, nor the other way round.
 */
export function attachmentCheck(set, captureDir) {
  const base = path.join(set, captureDir);
  const readJson = (n) => { try { return JSON.parse(fs.readFileSync(path.join(base, n), 'utf8')); } catch { return undefined; } };
  const manifest = readJson('manifest.json'); const refs = readJson('refs.json');
  const r = checkRestore({ manifest, restoredDir: path.join(base, 'attachments'), refs });
  const dangling = new Set(Array.isArray(manifest?.dangling) ? manifest.dangling : []);
  const failures = []; const vacuous = [];
  for (const f of r.failures) {
    if (VACUOUS.has(f.code)) vacuous.push(f.code);
    else if (f.code === 'ref-unresolved' && dangling.has(f.id)) continue;
    else failures.push(f);
  }
  if (refs === undefined) failures.push({ code: 'refs-missing', id: null, detail: 'refs.json missing or unreadable' });
  return { failures, coverage: { dangling: [...dangling].sort(), vacuous, sizeUnknown: r.counts.sizeUnknown, orphans: r.orphans } };
}

/**
 * Verify a set. liveRoots are walked recursively; liveFiles are exact live paths (the backup job passes its sources).
 * Returns { ok, checks, failures }.
 */
export function verifySet({ set, liveRoots = [], liveFiles = [], python = null, published = null }) {
  const checks = []; const failures = [];
  const failed = (check, file, why) => failures.push({ check, file, why });
  const dir = path.resolve(set);
  let m;
  try {
    m = JSON.parse(fs.readFileSync(path.join(dir, SET_MANIFEST), 'utf8'));
    if (!Array.isArray(m.files)) throw new Error('files is not an array');
  } catch (e) {
    failed('manifest', SET_MANIFEST, `${SET_MANIFEST} missing or unreadable: ${e.message}`);
    return { ok: false, checks: [{ name: 'manifest', ok: false }], failures };
  }
  checks.push({ name: 'manifest', ok: true, detail: `${m.files.length} files` });

  // bytes
  const listed = new Map(m.files.map((f) => [f.name, f]));
  const stats = new Map();
  let n0 = failures.length;
  for (const f of m.files) {
    const p = path.join(dir, f.name);
    let st; try { st = fs.lstatSync(p); } catch { failed('bytes', f.name, 'missing'); continue; }
    if (!st.isFile()) { failed('bytes', f.name, st.isSymbolicLink() ? 'is a symlink' : 'is not a regular file'); continue; }
    stats.set(f.name, st);
    if (st.size !== f.bytes) { failed('bytes', f.name, `size ${st.size} != recorded ${f.bytes}`); continue; }
    if (sha256File(p) !== f.sha256) failed('bytes', f.name, 'sha256 differs from the manifest');
  }
  checks.push({ name: 'bytes', ok: failures.length === n0 });

  // complete
  n0 = failures.length;
  const tree = walk(dir, { onError: (a, e) => failed('complete', path.relative(dir, a) || path.basename(dir), `cannot be read (${e.code || e.message})`) });
  for (const e of tree) {
    if (e.kind === 'dir') continue;
    if (e.rel === SET_MANIFEST) continue;
    if (e.kind !== 'file') failed('complete', e.rel, `a ${e.kind} in the set`);
    else if (!listed.has(e.rel)) failed('complete', e.rel, 'in the set but not in the manifest');
  }
  checks.push({ name: 'complete', ok: failures.length === n0 });

  // live-inode
  n0 = failures.length;
  const tiers = real(path.dirname(dir));
  const live = new Map();
  // A file that vanished between the listing and its stat is a live tree moving (ENOENT, ignored); any other stat error
  // is a hole in the inventory and fails, named.
  const addLive = (p, root) => {
    try { const st = fs.lstatSync(p); if (st.isFile()) live.set(`${st.dev}:${st.ino}`, p); }
    catch (e) { if (e.code !== 'ENOENT') failed('live-inode', root, `live file ${p} cannot be examined (${e.code || e.message}): the live inventory is incomplete`); }
  };
  for (const r of liveRoots) {
    const root = path.resolve(r);
    let st;
    try { st = fs.statSync(root); } catch (e) { failed('live-inode', root, `live root ${root} is ${e.code === 'ENOENT' ? 'missing' : `unreadable (${e.code || e.message})`}: no inode can be compared against it`); continue; }
    if (st.isFile()) { addLive(root, root); continue; }
    if (!st.isDirectory()) { failed('live-inode', root, `live root ${root} is neither a directory nor a file`); continue; }
    const entries = walk(root, { skip: (a) => real(a) === tiers || real(a) === real(dir),
      onError: (a, e) => failed('live-inode', root, `live root ${root}: ${a} cannot be read (${e.code || e.message}): the live inventory is incomplete`) });
    for (const e of entries) if (e.kind === 'file') addLive(e.abs, root);
  }
  for (const p of liveFiles) addLive(p, p);
  for (const [name, st] of stats) {
    const hit = live.get(`${st.dev}:${st.ino}`);
    if (hit) failed('live-inode', name, `shares an inode with the live file ${hit}`);
  }
  checks.push({ name: 'live-inode', ok: failures.length === n0, detail: `${live.size} live files compared` });

  // read-only
  n0 = failures.length;
  const isPublished = published ?? PUBLISHED_RE.test(path.basename(dir));
  if (isPublished) {
    const all = [{ abs: dir, rel: '.', kind: 'dir' }, ...tree];
    for (const e of all) {
      if (e.kind !== 'dir' && e.kind !== 'file') continue;
      try { if (fs.lstatSync(e.abs).mode & 0o222) failed('read-only', e.rel === '.' ? path.basename(dir) : e.rel, 'writable in a published set'); } catch { /* reported by bytes */ }
    }
  }
  checks.push({ name: 'read-only', ok: failures.length === n0, detail: isPublished ? 'published' : 'not a published name: not checked' });

  // cursors
  n0 = failures.length;
  const cur = m.files.find((f) => f.role === 'cursors');
  if (!cur) failed('cursors', 'cursors.json', 'the set holds no cursors.json');
  else {
    try {
      const segs = m.files.filter((f) => f.role === 'segment').map((f) => path.join(dir, f.name));
      const maxSeq = maxCapturedSeq(segs);
      for (const why of cursorProblems(JSON.parse(fs.readFileSync(path.join(dir, cur.name), 'utf8')), maxSeq)) failed('cursors', cur.name, why);
    } catch (e) { failed('cursors', cur.name, `unreadable: ${e.message}`); }
  }
  checks.push({ name: 'cursors', ok: failures.length === n0 });

  // snapshot
  n0 = failures.length;
  for (const snap of m.snapshots || []) {
    const sdir = path.join(dir, snap.dir);
    let bm;
    try { bm = JSON.parse(fs.readFileSync(path.join(sdir, BACKUP_MANIFEST), 'utf8')); } catch (e) { failed('snapshot', snap.dir, `${BACKUP_MANIFEST} unreadable: ${e.message}`); continue; }
    const want = new Set(bm.files.map((f) => f.name));
    for (const f of bm.files) {
      const lf = listed.get(`${snap.dir}/${f.name}`);
      if (!lf) failed('snapshot', `${snap.dir}/${f.name}`, 'in the checkpoint manifest but not in the set');
      else if (lf.bytes !== f.size || lf.sha256 !== f.sha256) failed('snapshot', lf.name, 'differs from the checkpoint manifest');
    }
    for (const n of fs.readdirSync(sdir)) if (n !== BACKUP_MANIFEST && !want.has(n)) failed('snapshot', `${snap.dir}/${n}`, 'not in the checkpoint manifest');
    if (!python) { failed('snapshot', snap.dir, 'no --python given: the read-only open cannot run'); continue; }
    const r = spawnSync(python, ['-c', PY_READ, sdir], { encoding: 'utf8', timeout: 120_000 });
    if (r.status !== 0) { failed('snapshot', snap.dir, `read-only open in a separate process failed (rc ${r.status}): ${String(r.stderr || r.stdout || '').trim().split('\n').pop()}`); continue; }
    const got = JSON.parse(r.stdout.trim().split('\n').pop());
    for (const k of ['quads', 'datasetId', 'epoch', 'commitSeq']) {
      if (String(got[k]) !== String(bm[k])) failed('snapshot', snap.dir, `${k} ${got[k]} != the checkpoint's ${bm[k]}`);
    }
  }
  checks.push({ name: 'snapshot', ok: failures.length === n0, detail: `${(m.snapshots || []).length} snapshot(s)` });

  // attachments
  n0 = failures.length;
  if (m.attachments?.captureDir) {
    try {
      const cm = JSON.parse(fs.readFileSync(path.join(dir, m.attachments.captureDir, 'manifest.json'), 'utf8'));
      for (const f of cm.files) {
        const lf = listed.get(`${m.attachments.captureDir}/attachments/${f.name}`);
        if (!lf) failed('attachments', `${m.attachments.captureDir}/attachments/${f.name}`, 'in the capture manifest but not in the set');
        else if (lf.bytes !== f.size || lf.sha256 !== f.sha256) failed('attachments', lf.name, 'differs from the capture manifest');
      }
    } catch (e) { failed('attachments', m.attachments.captureDir, `capture manifest unreadable: ${e.message}`); }
  }
  checks.push({ name: 'attachments', ok: failures.length === n0 });

  // attachment-refs: the restore checker over the set's own attachment copy, with the set's own refs.json
  n0 = failures.length;
  let coverage = null;
  if (m.attachments?.captureDir) {
    const a = attachmentCheck(dir, m.attachments.captureDir);
    coverage = a.coverage;
    for (const f of a.failures) failed('attachment-refs', f.id ? `${m.attachments.captureDir}/attachments/${f.id}` : m.attachments.captureDir, `${f.code}: ${f.detail}`);
  }
  checks.push({ name: 'attachment-refs', ok: failures.length === n0, detail: m.attachments?.captureDir ? 'checkRestore over the set\'s copy' : 'no paired capture in this set' });

  return { ok: failures.length === 0, checks, failures, coverage };
}

function parseArgs(argv) {
  const a = { liveRoots: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]; const v = argv[i + 1];
    if (!['--set', '--live-root', '--python'].includes(k)) throw new Error(`unknown arg: ${k}`);
    if (typeof v !== 'string' || !v || v.startsWith('--')) throw new Error(`${k} needs a value`);
    i++;
    if (k === '--set') a.set = v; else if (k === '--live-root') a.liveRoots.push(v); else a.python = v;
  }
  if (!a.set) throw new Error('missing required flag: --set');
  if (!a.liveRoots.length) throw new Error('missing required flag: --live-root (at least one; no default)');
  return a;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let a;
  try { a = parseArgs(process.argv.slice(2)); } catch (e) {
    console.error(`usage: node scripts/record-files-verify.mjs --set DIR --live-root R [--live-root R ...] [--python PY]\n${e.message}`);
    process.exit(2);
  }
  const v = verifySet(a);
  console.log(JSON.stringify({ ok: v.ok, set: path.resolve(a.set), checks: v.checks, failures: v.failures, coverage: v.coverage }));
  process.exit(v.ok ? 0 : 1);
}
