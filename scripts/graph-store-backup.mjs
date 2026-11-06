#!/usr/bin/env node
/**
 * #1559 — an INDEPENDENT, VERIFIED copy of the embedded Oxigraph store.
 *
 *   node scripts/graph-store-backup.mjs --url http://127.0.0.1:PORT --dest DIR [--python PY]
 *   node scripts/graph-store-backup.mjs --verify BACKUP_DIR [--python PY]
 *
 * Why not just Store.backup(): observed on pyoxigraph 0.5.11 (2026-10-04), a backup on
 * the same filesystem HARD-LINKS the SST and OPTIONS files (same inode as the live store,
 * nlink 2); only CURRENT, MANIFEST and the WAL are new files. That is one copy of the
 * data with two names. A fault that damages the live SSTs damages the "backup" too.
 *
 * So, in order:
 *   1. CHECKPOINT  POST /checkpoint on the running executor. It calls Store.backup()
 *                  INSIDE its write lock and reports, from the same instant, the quad
 *                  count and the commit marker (<urn:ex:dataset> <urn:ex:commitSeq>, read from the bookkeeping graph, #1638).
 *   2. COPY        every file of the checkpoint is copied BYTE BY BYTE (read + write +
 *                  fsync, never a link) into DEST/graph-store-<stamp>.partial,
 *                  with a sha256 per file recorded in backup-manifest.json.
 *                  #1634: EXCEPT a file whose name and sha256 match the most recent
 *                  published copy from the SAME UTC DAY, which is an APFS CLONE of that
 *                  copy's file (a separate inode sharing its blocks; `clonedFrom` in the
 *                  manifest). The source is re-read against its own manifest first; one
 *                  bad file rejects it (`suspectSources`) and the tick byte-copies. The
 *                  first copy of each UTC day clones nothing, so every chain has a full
 *                  byte copy at its root. Never cloned from the checkpoint (hard links to
 *                  the live store) or from an -UNVERIFIED / .partial copy.
 *   3. RELEASE     the checkpoint directory (hard links) is removed.
 *   4. VERIFY      (a) every file matches its recorded size + sha256; (b) every file has
 *                  ONE link (shares no inode with the live store); (c) a SEPARATE python
 *                  process opens the copy READ-ONLY and its quad count, datasetId, epoch
 *                  and commitSeq must equal the checkpoint's. Read-only open was observed
 *                  to leave the directory byte-identical (sha256 before = after).
 *   5. PUBLISH     only a verified copy is renamed to DEST/graph-store-<stamp>. A copy
 *                  that fails stays as ...-UNVERIFIED and the exit code is 1.
 *
 * DEST is a local path argument; there is no network destination. Nothing is pruned here:
 * #1566's scripts/graph-store-backup-schedule.mjs runs this as one tick and then prunes.
 *
 * ADDITIVE to the JSON backup, never a replacement. supervision/backup.sh
 * (com.scrumboard.backup, hourly) copies board-data.json ONLY, and every unit not yet cut
 * over still lives there. This script reads nothing of the JSON and writes nothing of its
 * paths; the two run side by side, each with its own destination, until each unit's own
 * cutover says otherwise.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BK } from '../core/graph-vocab.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PYTHON = process.env.GRAPH_EXECUTOR_PYTHON || path.join(ROOT, 'graph-executor', '.venv', 'bin', 'python');
export const MANIFEST = 'backup-manifest.json';

// The verifier runs in its own process and knows nothing the backup told it except the
// directory. It prints the observed numbers; the comparison happens in verifyBackup.
export const PY_READ = `
import json, sys, pyoxigraph as px
s = px.Store.read_only(sys.argv[1])
rows = list(s.query('SELECT ?id ?e ?s WHERE { GRAPH ${BK} { <urn:ex:dataset> <urn:ex:datasetId> ?id ; <urn:ex:epoch> ?e ; <urn:ex:commitSeq> ?s } }'))
if not rows and bool(s.query('ASK { <urn:ex:dataset> ?p ?o }')):
    # #1638 B12b — a backup taken BEFORE the cutover keeps its marker in the default graph. This build does not verify
    # that layout; it says so by name and points at the tool that does, rather than reporting a missing marker.
    print(json.dumps({'error': 'PRE_1638_LAYOUT: this backup is in the pre-#1638 layout (marker in the default graph); '
        'verify it with scripts/graph-store-backup.mjs from a pre-#1638 build (e.g. git show af51a5d:scripts/graph-store-backup.mjs), '
        'or migrate a COPY with graph-executor/migrate_bookkeeping.py --forward'})); sys.exit(4)
if len(rows) != 1:
    print(json.dumps({'error': f'{len(rows)} marker rows'})); sys.exit(3)
r = rows[0]
print(json.dumps({'quads': len(s), 'datasetId': r['id'].value, 'epoch': r['e'].value, 'commitSeq': r['s'].value}))
`;

function copyFileBytes(src, dst) {
  const h = crypto.createHash('sha256');
  const buf = Buffer.allocUnsafe(1 << 20);
  const fi = fs.openSync(src, 'r');
  const fo = fs.openSync(dst, 'wx', 0o600);
  let size = 0;
  try {
    for (;;) {
      const n = fs.readSync(fi, buf, 0, buf.length, null);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
      let w = 0;
      while (w < n) w += fs.writeSync(fo, buf, w, n - w);
      size += n;
    }
    fs.fsyncSync(fo);
  } finally { fs.closeSync(fi); fs.closeSync(fo); }
  return { size, sha256: h.digest('hex') };
}

function sha256File(f) {
  return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
}

const PUBLISHED = /^graph-store-(\d{8})T\d{6}Z$/;

/**
 * #1634 C1/C2/C3: the clone source for a copy stamped `stamp`, or none.
 * Only the most recent PUBLISHED copy (graph-store-<stamp>, never -UNVERIFIED / .partial) from the
 * SAME UTC DAY qualifies; the first copy of a day therefore has no source and is a full byte copy
 * (the chain reset). The candidate is re-read against its own manifest (every listed file present,
 * size and sha256 equal) BEFORE anything is cloned from it. One bad file rejects the whole copy:
 * it is returned as `suspect` and nothing is cloned from it.
 */
function cloneSource(dest, stamp) {
  const day = stamp.slice(0, 8);
  const candidates = fs.readdirSync(dest).filter((n) => { const m = PUBLISHED.exec(n); return m && m[1] === day && n < `graph-store-${stamp}`; }).sort();
  const name = candidates.at(-1);
  if (!name) return { source: null, suspect: null };
  const dir = path.join(dest, name);
  let m;
  try { m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')); } catch { return { source: null, suspect: name }; }
  const byName = new Map();
  for (const f of m.files ?? []) {
    const p = path.join(dir, f.name);
    let st;
    try { st = fs.statSync(p); } catch { return { source: null, suspect: name }; }
    if (!st.isFile() || st.size !== f.size || sha256File(p) !== f.sha256) return { source: null, suspect: name };
    byName.set(f.name, f);
  }
  return { source: { name, dir, byName }, suspect: null };
}

/**
 * An APFS clone of `src` at `dst` (a separate inode sharing blocks), or false when the volume cannot clone.
 * `cp -c` (clonefile(2)), because Node's COPYFILE_FICLONE_FORCE is ENOSYS on macOS (measured on v24.22.1,
 * 2026-11-06) and plain COPYFILE_FICLONE may silently fall back to a byte copy, which would make
 * `clonedFrom` a false label.
 */
function cloneFile(src, dst) {
  if (fs.existsSync(dst)) return false;
  const r = spawnSync('/bin/cp', ['-c', src, dst], { stdio: 'ignore' });
  if (r.status === 0) return true;
  try { fs.rmSync(dst, { force: true }); } catch { /* nothing written */ }
  return false;
}

function fsyncDir(d) {
  try { const fd = fs.openSync(d, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch { /* best effort: not every fs allows it */ }
}

/** Verify a backup directory. Pure of side effects on `dir`. Returns { ok, checks, observed }. */
export function verifyBackup(dir, { python = DEFAULT_PYTHON } = {}) {
  const checks = [];
  const fail = (name, detail) => { checks.push({ name, ok: false, detail }); };
  const pass = (name, detail) => { checks.push({ name, ok: true, detail }); };
  let m;
  try { m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')); }
  catch (e) { fail('manifest', String(e.message)); return { ok: false, checks, observed: null }; }
  pass('manifest', `${m.files.length} files`);

  const bad = [];
  const linked = [];
  for (const f of m.files) {
    const p = path.join(dir, f.name);
    let st;
    try { st = fs.statSync(p); } catch { bad.push(`${f.name}: missing`); continue; }
    if (st.size !== f.size) { bad.push(`${f.name}: size ${st.size} != ${f.size}`); continue; }
    if (sha256File(p) !== f.sha256) bad.push(`${f.name}: sha256 differs`);
    if (st.nlink !== 1) linked.push(`${f.name}: nlink ${st.nlink}`);
  }
  bad.length ? fail('bytes', bad.join('; ')) : pass('bytes', 'every file matches its recorded size and sha256');
  linked.length ? fail('independent', `hard-linked: ${linked.join('; ')}`) : pass('independent', 'every file has exactly one link');

  const r = spawnSync(python, ['-c', PY_READ, dir], { encoding: 'utf8', timeout: 120_000 });
  let observed = null;
  if (r.status !== 0) {
    fail('open', `read-only open in a separate process failed (rc ${r.status}): ${(r.stderr || r.stdout || '').trim().split('\n').slice(-1)[0]}`);
  } else {
    observed = JSON.parse(r.stdout.trim().split('\n').pop());
    const want = { quads: m.quads, datasetId: m.datasetId, epoch: m.epoch, commitSeq: m.commitSeq };
    const diff = Object.keys(want).filter((k) => String(want[k]) !== String(observed[k]));
    diff.length ? fail('open', `content differs from the checkpoint: ${diff.map((k) => `${k} ${observed[k]} != ${want[k]}`).join(', ')}`)
      : pass('open', `separate read-only process: ${observed.quads} quads, commitSeq ${observed.commitSeq}`);
  }
  return { ok: checks.every((c) => c.ok), checks, observed };
}

/** Take a checkpoint from the executor at `url`, copy it to an independent dir under `dest`, verify. */
export async function backupStore({ url, dest, python = DEFAULT_PYTHON, fetchImpl = fetch, now = () => new Date(), keepCheckpoint = false }) {
  if (!dest) throw new Error('dest required');
  // #1566 T4: wall-clock timings of each phase, so a scheduler can record them and a monitor
  // can derive its freshness limit (interval + copy + verify) from MEASURED numbers.
  const t0 = performance.now();
  const res = await fetchImpl(`${url}/checkpoint`, { method: 'POST', signal: AbortSignal.timeout(300_000) });
  const cp = await res.json();
  if (res.status !== 200) throw new Error(`checkpoint refused (${res.status}): ${cp.error}`);
  // Refuse to treat anything that looks like a LIVE store as a checkpoint (a live store holds LOCK).
  if (!fs.existsSync(path.join(cp.path, 'CURRENT')) || fs.existsSync(path.join(cp.path, 'LOCK'))) {
    throw new Error(`not a checkpoint directory: ${cp.path}`);
  }
  const tCheckpoint = performance.now();
  const stamp = now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  fs.mkdirSync(dest, { recursive: true });
  const final = path.join(path.resolve(dest), `graph-store-${stamp}`);
  const partial = `${final}.partial`;
  fs.mkdirSync(partial);
  const files = [];
  const { source, suspect } = cloneSource(path.resolve(dest), stamp);
  let clones = 0;
  try {
    for (const name of fs.readdirSync(cp.path).sort()) {
      const st = fs.lstatSync(path.join(cp.path, name));
      if (!st.isFile()) throw new Error(`unexpected non-file in checkpoint: ${name}`);
      // #1634 C1: clone only when the verified same-day source holds this NAME with this checkpoint file's SHA256.
      // The clone is taken from the SOURCE COPY, never from the checkpoint (its SSTs are hard links to the live store).
      const prev = source?.byName.get(name);
      if (prev && prev.size === st.size) {
        const want = sha256File(path.join(cp.path, name));
        if (want === prev.sha256 && cloneFile(path.join(source.dir, name), path.join(partial, name))) {
          files.push({ name, size: prev.size, sha256: prev.sha256, clonedFrom: source.name });
          clones++;
          continue;
        }
      }
      files.push({ name, ...copyFileBytes(path.join(cp.path, name), path.join(partial, name)) });
    }
    const manifest = { takenAt: now().toISOString(), source: url, checkpoint: cp.path,
      datasetId: cp.datasetId, epoch: cp.epoch, commitSeq: cp.commitSeq, quads: cp.quads, files };
    fs.writeFileSync(path.join(partial, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
    fsyncDir(partial);
  } finally {
    // the checkpoint is hard links; the copy is ours. #1566: a scheduler that RETAINS local
    // checkpoints (keep the last N) passes keepCheckpoint and prunes the directory itself.
    if (!keepCheckpoint) fs.rmSync(cp.path, { recursive: true, force: true });
  }
  const tCopy = performance.now();
  const v = verifyBackup(partial, { python });
  const tVerify = performance.now();
  const target = v.ok ? final : `${final}-UNVERIFIED`;
  fs.renameSync(partial, target);
  fsyncDir(path.dirname(target));
  return { ok: v.ok, path: target, clones, suspectSources: suspect ? [suspect] : [], checkpoint: { quads: cp.quads, commitSeq: cp.commitSeq, datasetId: cp.datasetId, path: cp.path, kept: keepCheckpoint },
    checks: v.checks,
    timings: { checkpointMs: tCheckpoint - t0, copyMs: tCopy - tCheckpoint, verifyMs: tVerify - tCopy } };
}

function parseArgs(argv) {
  const a = { python: DEFAULT_PYTHON };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--url') a.url = argv[++i];
    else if (k === '--dest') a.dest = argv[++i];
    else if (k === '--verify') a.verify = argv[++i];
    else if (k === '--python') a.python = argv[++i];
    else throw new Error(`unknown arg: ${k}`);
  }
  return a;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let a;
  try { a = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (a.verify) {
    const v = verifyBackup(a.verify, { python: a.python });
    console.log(JSON.stringify({ verified: v.ok, path: a.verify, checks: v.checks }));
    process.exit(v.ok ? 0 : 1);
  }
  if (!a.url || !a.dest) { console.error('usage: graph-store-backup.mjs --url URL --dest DIR | --verify DIR'); process.exit(2); }
  backupStore(a).then((r) => { console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1); },
    (e) => { console.error(`BACKUP FAILED: ${e.message}`); process.exit(1); });
}
