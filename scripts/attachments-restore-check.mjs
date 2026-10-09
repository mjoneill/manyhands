#!/usr/bin/env node
/**
 * #1648 — THE ATTACHMENT SLICE OF THE RESTORE DRILL: does a restored attachments directory hold exactly what the backup's
 * MANIFEST says it held, and does every graph reference resolve to it?
 *
 *   node scripts/attachments-restore-check.mjs --manifest FILE --restored DIR --refs-json FILE
 *
 * The drill's set (named on #1648): the executor snapshot + the ENTIRE attachments directory + a SHA-256/size manifest
 * captured from the source during that backup, with attachment writes and deletions fenced across the pair. Restored bytes
 * are compared against the MANIFEST, never the live files: the source may have changed since, and a recovery must stay
 * verifiable after losing it. So this reads ONLY the restored directory and its arguments — never the live directory, never
 * the network.
 *
 *   manifest = { schema: 1, capturedAt, files: [{name, size, sha256}], fence: { before: {count, newestMtimeMs}, after: {…} } }
 *   refs     = [{ id, size }]   (size = the reference's contentSize; 0 = UNKNOWN: two live references record 0 for real bytes)
 *
 * Every manifest entry is verified, referenced or not (an orphan is reported, never skipped); every file in the restored
 * directory that the manifest does not list is a failure (a dirty restore target is not a restore). Size is checked before
 * the hash and as its own step, so a same-size byte flip is a hash-mismatch, never a size-mismatch. All defects are reported,
 * not the first one. Bad input is a failure, never a throw.
 *
 * CLI: exit 0 = ok · 1 = failures · 2 = usage. The LAST stdout line is the result as one JSON object.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isFence = (f) => isObj(f) && Number.isFinite(f.count) && Number.isFinite(f.newestMtimeMs);

/** The manifest's problem as a sentence, or null when it has the pinned shape. */
function manifestProblem(m) {
  if (!isObj(m)) return 'the manifest is not a JSON object';
  if (m.schema !== 1) return `schema ${JSON.stringify(m.schema)} is not 1`;
  if (!Array.isArray(m.files)) return 'files is not an array';
  for (const [i, f] of m.files.entries()) {
    if (!isObj(f) || typeof f.name !== 'string' || !f.name || !Number.isSafeInteger(f.size) || f.size < 0 || typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) {
      return `files[${i}] is not {name, size, sha256}`;
    }
    if (f.name.includes('/') || f.name === '.' || f.name === '..') return `files[${i}] names a path, not a file: ${f.name}`;
  }
  return null;
}

/**
 * Read a REGULAR file without following a symlink at any moment: open with O_NOFOLLOW (a symlink fails to open, ELOOP)
 * and O_NONBLOCK (a FIFO with no writer would otherwise block the open forever),
 * check the OPENED descriptor with fstat (a directory or device fails), then read through that same descriptor. No
 * check-then-read gap: an entry swapped for a link after the listing is refused, never read through.
 */
function readRegularNoFollow(p) {
  // O_NONBLOCK: a FIFO (or device) under a manifest name must not hang the open; fstat below then refuses it before any read
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) throw Object.assign(new Error('not a regular file'), { code: 'ENOTFILE' });
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

/** Pure apart from reading `restoredDir`. Returns { ok, failures: [{code, id, detail}], orphans, counts }. */
export function checkRestore({ manifest, restoredDir, refs } = {}) {
  const failures = [];
  const fail = (code, id, detail) => failures.push({ code, id: id ?? null, detail });
  const counts = { references: 0, manifestFiles: 0, restoredFiles: 0, sizeUnknown: 0, orphans: 0 };
  const done = (orphans = []) => ({ ok: failures.length === 0, failures, orphans, counts: { ...counts, orphans: orphans.length } });

  const problem = manifestProblem(manifest);
  if (problem) { fail('manifest-invalid', null, problem); return done(); }
  const refList = Array.isArray(refs) ? refs.filter((r) => isObj(r) && typeof r.id === 'string' && r.id) : [];
  counts.references = refList.length;
  counts.manifestFiles = manifest.files.length;

  // the fence: evidence that no attachment was written or deleted while the manifest was captured
  const fence = manifest.fence;
  if (!isObj(fence) || !isFence(fence.before) || !isFence(fence.after)) fail('manifest-fence-missing', null, 'the manifest carries no before/after fence reading');
  else if (fence.before.count !== fence.after.count || fence.before.newestMtimeMs !== fence.after.newestMtimeMs) {
    fail('manifest-fence-moved', null, `the attachments directory changed during capture: before ${JSON.stringify(fence.before)}, after ${JSON.stringify(fence.after)}`);
  }

  // vacuity: a pass over nothing is not a restore
  if (!refList.length) fail('no-references', null, 'no references to resolve');
  if (!manifest.files.length) fail('manifest-empty', null, 'the manifest lists no files');

  // the restored directory as it is. Entry types come from readdir, which does NOT follow symlinks: a restore holds
  // REGULAR files only, so a symlink or a directory is never a restored file and is never read through.
  let present, notRegular;
  try {
    const entries = fs.readdirSync(restoredDir, { withFileTypes: true });
    present = new Set(entries.filter((d) => d.isFile()).map((d) => d.name));
    notRegular = new Map(entries.filter((d) => !d.isFile()).map((d) => [d.name, d.isSymbolicLink() ? 'a symlink' : d.isDirectory() ? 'a directory' : 'not a regular file']));
  } catch (e) { fail('file-missing', null, `the restored directory ${restoredDir} cannot be read (${e.code || e.message})`); present = new Set(); notRegular = new Map(); }
  counts.restoredFiles = present.size;

  // every manifest entry, referenced or not: present, then size, then (only on an equal size) hash
  const byName = new Map(manifest.files.map((f) => [f.name, f]));
  for (const f of manifest.files) {
    if (notRegular.has(f.name)) { fail('file-missing', f.name, `listed in the manifest, but the restore holds ${notRegular.get(f.name)} under that name (not a regular file; never followed)`); continue; }
    if (!present.has(f.name)) { fail('file-missing', f.name, 'listed in the manifest, absent from the restore'); continue; }
    let bytes;
    try { bytes = readRegularNoFollow(path.join(restoredDir, f.name)); }
    catch (e) { fail('file-missing', f.name, `unreadable (${e.code || e.message})`); continue; }
    if (bytes.length !== f.size) { fail('size-mismatch', f.name, `restored ${bytes.length} bytes, the manifest says ${f.size}`); continue; }
    const got = crypto.createHash('sha256').update(bytes).digest('hex');
    if (got !== f.sha256) fail('hash-mismatch', f.name, `restored sha-256 ${got}, the manifest says ${f.sha256}`);
  }
  // a file the manifest does not list: a dirty restore target
  for (const name of present) if (!byName.has(name)) fail('unexpected-file', name, 'in the restore, not in the manifest');
  for (const [name, kind] of notRegular) if (!byName.has(name)) fail('unexpected-file', name, `${kind} in the restore, not in the manifest`);

  // references: each resolves to a manifest entry; a nonzero contentSize must agree with it (0 = unknown, counted)
  const referenced = new Set();
  for (const r of refList) {
    referenced.add(r.id);
    const f = byName.get(r.id);
    if (!f) { fail('ref-unresolved', r.id, 'referenced by the graph, not in the manifest'); continue; }
    if (!Number.isFinite(r.size) || r.size === 0) counts.sizeUnknown++;
    else if (r.size !== f.size) fail('ref-size-mismatch', r.id, `the reference records ${r.size} bytes, the manifest ${f.size}`);
  }
  const orphans = manifest.files.map((f) => f.name).filter((n) => !referenced.has(n)).sort();
  return done(orphans);
}

function main(argv) {
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 && typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
  const mf = opt('--manifest'); const restored = opt('--restored'); const rf = opt('--refs-json');
  if (!mf || !restored || !rf) {
    console.error('usage: node scripts/attachments-restore-check.mjs --manifest FILE --restored DIR --refs-json FILE');
    return 2;
  }
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; } };
  const r = checkRestore({ manifest: readJson(mf), restoredDir: restored, refs: readJson(rf) });
  for (const f of r.failures) console.error(`${f.code}${f.id ? ` ${f.id}` : ''}: ${f.detail}`);
  console.log(JSON.stringify(r));
  return r.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
