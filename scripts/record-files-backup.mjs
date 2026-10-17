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
 *   7. PRUNE           only with --keep-hourly and --keep-daily, and only after a run that published and is ok.
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
 * notCovered, ok, error }. Exit 0 exactly when ok · 1 not ok · 2 refusal · 7 skipped (another run holds DEST/.records.lock).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
export function planRetention({ sets, keepHourly, keepDaily }) {
  const sorted = [...sets].sort((a, b) => b.atMs - a.atMs || (a.name < b.name ? 1 : -1));
  const reasons = new Map(); const add = (s, r) => { if (!reasons.has(s.name)) reasons.set(s.name, []); reasons.get(s.name).push(r); };
  if (sorted.length) add(sorted[0], 'newest');
  const tier = (label, keyOf, n) => {
    const seen = new Set();
    for (const s of sorted) { const k = keyOf(s.atMs); if (seen.has(k)) continue; if (seen.size >= n) break; seen.add(k); add(s, `${label}:${k}`); }
  };
  tier('hourly', (ms) => new Date(ms).toISOString().slice(0, 13), keepHourly);
  tier('daily', (ms) => new Date(ms).toISOString().slice(0, 10), keepDaily);
  const keep = []; const del = [];
  for (const s of sorted) reasons.has(s.name) ? keep.push({ name: s.name, reasons: reasons.get(s.name) }) : del.push({ name: s.name, reason: 'held by no tier' });
  return { keep, delete: del };
}

function prune(dest, { keepHourly, keepDaily }) {
  const sets = fs.readdirSync(dest).map((name) => ({ name, m: PUBLISHED_RE.exec(name) }))
    .filter((x) => x.m && fs.lstatSync(path.join(dest, x.name)).isDirectory()).map((x) => ({ name: x.name, atMs: parseStamp(x.m[1]) }));
  const plan = planRetention({ sets, keepHourly, keepDaily });
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
  return { kept: plan.keep, deleted, refused };
}

function takeLock(dest) {
  const f = path.join(dest, LOCK);
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(f, String(process.pid), { flag: 'wx' }); return () => { try { fs.unlinkSync(f); } catch { /* gone */ } }; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(f, 'utf8'));
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch (k) { alive = k.code === 'EPERM'; }
      if (alive) return null;
      fs.unlinkSync(f);   // the holder is dead: a stale lock
    }
  }
  return null;
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
    pruned: o.retention ? null : 'not requested', findings: [], notCovered: [], ok: false, error: null };
  const finding = (code, name, detail) => report.findings.push({ code, name, detail });

  let stamp = stampOf(Date.now());
  for (let i = 0; i < 3 && fs.readdirSync(o.dest).some((n) => n.startsWith(`records-${stamp}`)); i++) { sleepSync(1000 - (Date.now() % 1000) + 5); stamp = stampOf(Date.now()); }
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

  const manifest = { schema: 1, kind: 'records-set', stamp, takenAt: new Date().toISOString(), cursorsCapturedAt: null,
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
  if (!v.ok) {
    for (const f of v.failures) finding('verify-failed', f.file, `${f.check}: ${f.file}: ${f.why}`);
    report.setDir = `${final}-UNVERIFIED`;
    fs.renameSync(partial, report.setDir);
    fsyncDir(o.dest);
    report.error = `the set did not verify: ${v.failures.map((f) => `${f.file}: ${f.why}`).join('; ')}`;
    report.budget.freeAfter = freeBytes(o.dest);
    return report;
  }

  // 6. publish: read-only, then the verified name
  report.stage = 'publish';
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
  const clean = report.findings.length === 0;

  // 7. prune
  if (o.retention) {
    report.stage = 'prune';
    report.pruned = clean ? prune(o.dest, o.retention) : { skipped: 'this run is not ok: every existing set is kept' };
    if (clean && report.pruned.refused.length) finding('prune-refused', null, report.pruned.refused.map((r) => `${r.name}: ${r.error}`).join('; '));
  }
  report.stage = 'done';
  report.budget.freeAfter = freeBytes(o.dest);
  report.ok = report.findings.length === 0;
  return report;
}

export async function main(argv) {
  const refuse = (msg) => { console.error(`${USAGE}\nREFUSED: ${msg}`); console.log(JSON.stringify({ stage: 'refused', published: false, setDir: null, ok: false, error: msg })); return 2; };
  let o; let pre;
  try { o = parseArgs(argv); pre = await preflight(o); } catch (e) { if (e instanceof Refusal) return refuse(e.message); throw e; }
  const release = takeLock(o.dest);
  if (!release) { console.log(JSON.stringify({ stage: 'skipped', published: false, setDir: null, ok: false, error: `another run holds ${path.join(o.dest, LOCK)}` })); return 7; }
  try {
    const report = await runBackup(o, pre);
    console.log(JSON.stringify(report));
    return report.ok ? 0 : 1;
  } finally { release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
