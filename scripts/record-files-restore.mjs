#!/usr/bin/env node
/**
 * #1648 — RESTORE A RECORD-FILES SET INTO AN INDEPENDENT, WRITABLE COPY.
 *
 *   node scripts/record-files-restore.mjs --set DIR --to EMPTY_DIR [--python PY] [--port N]
 *
 * --set and --to are required: no default, no environment fallback. Every REFUSAL exits 2 and writes nothing: a missing
 * flag; a --to that is not an existing EMPTY directory (left exactly as it is); a set that is not published (its name is
 * -UNVERIFIED or .partial, or it is not records-<stamp>); a set holding more than one executor snapshot; a set that holds
 * an executor snapshot when no --python is given (its read-only open cannot run); and any set that fails
 * scripts/record-files-verify.mjs's verifySet (a flipped byte, an unlisted file, ...), named by file. The set is only
 * read, never modified.
 *
 * Past the refusals every payload file is COPIED byte for byte (read, write, fsync; never a link or a clone), hashing the
 * bytes written, into a fixed layout under --to, chosen by the file's role in the set's manifest:
 *   executor-store/      the executor snapshot's store files (its backup-manifest.json stays in the set)
 *   attachments/         the paired capture's attachment files (its manifest.json, refs.json, COMPLETE stay in the set)
 *   board-data-events/   the event-log segments and cursors.json
 *   work-store/          the work ledger
 *   config/              each config, by its name
 * Restored files are writable (0644) and directories 0755. Then every restored file is checked against the set's manifest
 * (size and sha256), and against the INODES of every file under the set's backup root (all retained sets): a restored
 * file may share none. A set's files may be hard links shared with other sets, so no executor may ever run on them; the
 * restore is the independent copy an executor runs on.
 *
 * ONE JSON object on stdout: { ok, set, to, files:[{name, role, bytes, sha256}], layout:{executorStore, attachments,
 * eventLog, workStore, config}, snapshotEpoch, notRestored, failures, next, nextTemplate, nextNote, notCovered }. With
 * --port N (an integer 1024-65535; anything else is a refusal), `next` is the executor start command on
 * layout.executorStore with --promote-epoch, runnable VERBATIM (no placeholder, no comment). Without --port, `next` is null
 * and nextTemplate holds the PORT-placeholder form, which is never presented as a command (notCovered says to pass
 * --port). nextNote says that the promoted store refuses a write that does not carry its
 * NEW epoch (x-epoch, read back with Q_POSITION). This command never starts an executor. Exit 0 exactly when ok, 1 when the
 * copy or its checks failed, 2 on a refusal.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifySet, SET_MANIFEST, PUBLISHED_RE } from './record-files-verify.mjs';
import { MANIFEST as BACKUP_MANIFEST } from './graph-store-backup.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'usage: node scripts/record-files-restore.mjs --set DIR --to EMPTY_DIR [--python PY] [--port N]';
export const LAYOUT = Object.freeze({ executorStore: 'executor-store', attachments: 'attachments', eventLog: 'board-data-events', workStore: 'work-store', config: 'config' });

class Refusal extends Error {}

/** Where a manifest entry goes under --to, or null for set evidence that stays in the set. */
export function destinationOf(f, snapshotDir) {
  const base = path.basename(f.name);
  switch (f.role) {
    case 'segment': case 'cursors': return path.join(LAYOUT.eventLog, base);
    case 'work-store': return path.join(LAYOUT.workStore, base);
    case 'config': return path.join(LAYOUT.config, base);
    case 'executor-snapshot':
      if (!snapshotDir || path.dirname(f.name) !== snapshotDir) throw new Refusal(`${f.name} is outside the set's executor snapshot ${snapshotDir}`);
      return base === BACKUP_MANIFEST ? null : path.join(LAYOUT.executorStore, base);
    case 'attachment-capture': {
      const m = /^([^/]+)\/attachments\/([^/]+)$/.exec(f.name);
      return m ? path.join(LAYOUT.attachments, m[2]) : null;
    }
    default: throw new Refusal(`${f.name} has role ${JSON.stringify(f.role)}, which has no place in the restore layout`);
  }
}

function copyBytes(src, dst) {
  const h = crypto.createHash('sha256'); const buf = Buffer.allocUnsafe(1 << 20);
  const fi = fs.openSync(src, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const fo = fs.openSync(dst, 'wx', 0o644);
  let n0 = 0;
  try {
    for (;;) {
      const n = fs.readSync(fi, buf, 0, buf.length, null);
      if (n === 0) break;
      let w = 0; while (w < n) w += fs.writeSync(fo, buf, w, n - w);
      h.update(buf.subarray(0, n)); n0 += n;
    }
    fs.fsyncSync(fo);
  } finally { fs.closeSync(fi); fs.closeSync(fo); }
  fs.chmodSync(dst, 0o644);   // writable whatever the umask
  return { bytes: n0, sha256: h.digest('hex') };
}

function inodesUnder(root) {
  const out = new Map();
  for (const n of fs.readdirSync(root, { recursive: true })) {
    const p = path.join(root, n);
    let st; try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isFile()) out.set(`${st.dev}:${st.ino}`, p);
  }
  return out;
}

const q = (s) => (/^[A-Za-z0-9_./:=-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

/** Every refusal check; nothing is written. Returns what the copy needs. */
export function plan({ set, to, python = null }) {
  const dir = path.resolve(set);
  const name = path.basename(dir);
  if (/-UNVERIFIED$/.test(name)) throw new Refusal(`--set ${dir} is an -UNVERIFIED set: it failed verification when it was made, and is never restored`);
  if (/\.partial$/.test(name)) throw new Refusal(`--set ${dir} is a .partial set: an unfinished capture, never restored`);
  if (!PUBLISHED_RE.test(name)) throw new Refusal(`--set ${dir} is not a published set (records-<stamp>)`);
  let isDir = false; try { isDir = fs.statSync(dir).isDirectory(); } catch { /* below */ }
  if (!isDir) throw new Refusal(`--set ${dir} is not a directory`);
  const target = path.resolve(to);
  let toDir = false; try { toDir = fs.statSync(target).isDirectory(); } catch { /* below */ }
  if (!toDir) throw new Refusal(`--to ${target} is not an existing directory: give an existing EMPTY directory`);
  if (fs.readdirSync(target).length) throw new Refusal(`--to ${target} is not empty: the restore writes only into an empty directory, and this one is left as it is`);
  const backupRoot = path.dirname(dir);
  const rt = fs.realpathSync(target); const rs = fs.realpathSync(dir); const rb = fs.realpathSync(backupRoot);
  if (rt === rb || rt.startsWith(`${rb}${path.sep}`) || rs.startsWith(`${rt}${path.sep}`)) throw new Refusal(`--to ${target} is inside the set's backup root ${backupRoot} (or contains the set): a restore is an independent copy`);
  let m;
  try { m = JSON.parse(fs.readFileSync(path.join(dir, SET_MANIFEST), 'utf8')); } catch (e) { throw new Refusal(`--set ${dir}: ${SET_MANIFEST} unreadable (${e.message})`); }
  if (m?.kind !== 'records-set' || !Array.isArray(m.files)) throw new Refusal(`--set ${dir}: ${SET_MANIFEST} is not a records-set manifest`);
  const snaps = m.snapshots || [];
  if (snaps.length > 1) throw new Refusal(`--set ${dir} holds ${snaps.length} executor snapshots: the layout has one executor-store`);
  if (snaps.length && !python) throw new Refusal(`--set ${dir} holds an executor snapshot (${snaps[0].dir}): give --python so its read-only open can verify it before it is restored`);
  // the set verifies as it stands (no live roots: the inode rule this command adds is against the backup root, below)
  const v = verifySet({ set: dir, python });
  if (!v.ok) throw new Refusal(`--set ${dir} does not verify, so it is not restored: ${v.failures.map((f) => `${f.file}: ${f.check}: ${f.why}`).join('; ')}`);
  const snapshotDir = snaps[0]?.dir ?? null;
  const copies = []; const notRestored = [];
  const taken = new Set();
  for (const f of m.files) {
    const rel = destinationOf(f, snapshotDir);
    if (!rel) { notRestored.push(f.name); continue; }
    if (taken.has(rel)) throw new Refusal(`two files of the set would both restore to ${rel}`);
    taken.add(rel); copies.push({ f, rel });
  }
  let datasetId = null; let epoch = null;
  if (snapshotDir) { try { const bm = JSON.parse(fs.readFileSync(path.join(dir, snapshotDir, BACKUP_MANIFEST), 'utf8')); datasetId = bm.datasetId ?? null; epoch = bm.epoch ?? null; } catch { /* verified above; left null */ } }
  return { dir, target, backupRoot, copies, notRestored, datasetId, epoch, hasSnapshot: Boolean(snapshotDir) };
}

export function restore(p, { python = null, port = null } = {}) {
  const layout = Object.fromEntries(Object.entries(LAYOUT).map(([k, rel]) => [k, path.join(p.target, rel)]));
  for (const d of Object.values(layout)) fs.mkdirSync(d, { recursive: true, mode: 0o755 });
  const files = []; const failures = [];
  for (const { f, rel } of p.copies) {
    const dst = path.join(p.target, rel);
    try {
      const got = copyBytes(path.join(p.dir, f.name), dst);
      files.push({ name: rel, role: f.role, bytes: got.bytes, sha256: got.sha256, from: f.name });
      if (got.bytes !== f.bytes || got.sha256 !== f.sha256) failures.push({ file: rel, why: `copied ${got.bytes} bytes, sha256 ${got.sha256}; the manifest says ${f.bytes}, ${f.sha256}` });
    } catch (e) { failures.push({ file: rel, why: `copy failed: ${e.message}` }); }
  }
  // after the copy: each restored file re-read against the manifest, and no inode shared with any retained set
  const setInodes = inodesUnder(p.backupRoot);
  for (const r of files) {
    const dst = path.join(p.target, r.name);
    let st; try { st = fs.lstatSync(dst); } catch { failures.push({ file: r.name, why: 'missing after the copy' }); continue; }
    const want = p.copies.find((c) => c.rel === r.name).f;
    if (!st.isFile() || st.size !== want.bytes) failures.push({ file: r.name, why: `size ${st.size} != the manifest's ${want.bytes}` });
    else if (crypto.createHash('sha256').update(fs.readFileSync(dst)).digest('hex') !== want.sha256) failures.push({ file: r.name, why: 'restored bytes differ from the manifest' });
    const hit = setInodes.get(`${st.dev}:${st.ino}`);
    if (hit) failures.push({ file: r.name, why: `shares an inode with ${hit} in the backup root` });
    if (!(st.mode & 0o200)) failures.push({ file: r.name, why: 'not writable' });
  }
  // `next` is runnable VERBATIM (sh -c 'exec …', or split to argv): one command, no placeholder, no comment, no `&&`. It
  // exists only with --port; without it `next` is null and nextTemplate is the PORT-placeholder form, which is never a
  // command. A snapshot is only restored with --python (plan refuses otherwise), so the interpreter is always known.
  let next = null; let nextTemplate = null; let nextNote = null; const notCovered = [];
  if (p.hasSnapshot) {
    const cmd = (portArg) => `${q(python)} ${q(path.join(ROOT, 'graph-executor', 'executor.py'))} --store ${q(layout.executorStore)} --dataset-id ${q(p.datasetId ?? 'DATASET_ID')} --port ${portArg} --promote-epoch`;
    nextTemplate = cmd('PORT');
    if (port && p.datasetId) next = cmd(port);
    else notCovered.push(p.datasetId
      ? 'next: no --port was given, so there is no runnable start line; nextTemplate holds PORT and is not a command: pass --port N for a runnable next'
      : 'next: the snapshot\'s datasetId could not be read from its backup-manifest.json, so there is no runnable start line');
    nextNote = `promotion moves the epoch past the snapshot's ${p.epoch ?? '?'}: read the new one back (Q_POSITION, core/logborn-unit.mjs) and send it as x-epoch on every write; a write without it is refused "reconcile required"`;
  }
  return { ok: failures.length === 0, set: p.dir, to: p.target, files, layout, snapshotEpoch: p.epoch, notRestored: p.notRestored, failures, next, nextTemplate, nextNote, notCovered };
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && typeof argv[i + 1] === 'string' && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}

export function main(argv) {
  const known = new Set(['--set', '--to', '--python', '--port']);
  const refuse = (msg) => { console.error(`${USAGE}\nREFUSED: ${msg}`); console.log(JSON.stringify({ ok: false, refused: true, error: msg })); return 2; };
  for (let i = 0; i < argv.length; i += 2) if (!known.has(argv[i])) return refuse(`unknown argument: ${argv[i]}`);
  const missing = ['--set', '--to'].filter((f) => !flag(argv, f));
  if (missing.length) return refuse(`missing required flag${missing.length > 1 ? 's' : ''}: ${missing.join(', ')} (no default, no environment fallback)`);
  const python = flag(argv, '--python');
  let port = null;
  if (argv.includes('--port')) {
    const v = flag(argv, '--port');
    if (!v || !/^\d+$/.test(v) || Number(v) < 1024 || Number(v) > 65535) return refuse(`--port must be an integer from 1024 to 65535 (got ${JSON.stringify(v)})`);
    port = Number(v);
  }
  let p;
  try { p = plan({ set: flag(argv, '--set'), to: flag(argv, '--to'), python }); } catch (e) { if (e instanceof Refusal) return refuse(e.message); throw e; }
  const r = restore(p, { python, port });
  for (const f of r.failures) console.error(`RESTORE FAILED: ${f.file}: ${f.why}`);
  console.log(JSON.stringify(r));
  return r.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
