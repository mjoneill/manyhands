#!/usr/bin/env node
/**
 * #1762 S4 — move the lanes' cursor state out of the event-log directory and into the data folder (S4 CONTRACT v1 §5).
 *
 *   node scripts/cursors-relocate-1762.mjs --from <event-log dir> --to <SCRUM_DATA_DIR> [--apply]
 *
 * The event-log directory is archived at S6, and `cursors.json` (the delivery lanes' acked / served positions) must not
 * go with it. This is an EXPLICIT step, run with every cursor writer stopped; nothing does it at boot.
 *
 * Without --apply it is a DRY RUN that touches nothing. With --apply, each step leaves a state a re-run finishes from:
 *   1  write <to>/cursors.json.tmp with the old file's exact bytes and mode, fsync
 *   2  rename it to <to>/cursors.json, fsync the directory
 *   3  verify every lane in the new file equals the old file's
 *   4  rename the old file to cursors.json.migrated (an archive: never deleted, never rewritten)
 * A different file already at the destination is REFUSED and left alone: it may hold newer progress.
 *
 * stdout: one JSON object. Exit 0 done or nothing to do · 2 usage or unreadable input · 3 refused (a different
 * destination) · 70 the test-only crash seam (SCRUM_CURSORS_RELOCATE_CRASH_AT = after-temp | after-rename | after-verify).
 */
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const out = (code, report) => { console.log(JSON.stringify(report)); process.exit(code); };
const fail = (code, msg) => { console.error(`cursors-relocate-1762: ${msg}`); process.exit(code); };

const argv = process.argv.slice(2);
const args = { apply: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--apply') { args.apply = true; continue; }
  if (a === '--from' || a === '--to') {
    const v = argv[i + 1];
    if (v == null || v.startsWith('--')) fail(2, `${a} needs a value`);
    args[a.slice(2)] = v; i++; continue;
  }
  fail(2, `unknown argument ${a}`);
}
for (const k of ['from', 'to']) if (!args[k]) fail(2, `missing --${k} (no defaults: every input is passed explicitly)`);

const CRASH_AT = process.env.SCRUM_CURSORS_RELOCATE_CRASH_AT || null;
const crash = (step) => { if (CRASH_AT === step) { console.error(`cursors-relocate-1762: crash seam at ${step}`); process.exit(70); } };

const oldFile = path.join(args.from, 'cursors.json');
const archive = `${oldFile}.migrated`;
const newFile = path.join(args.to, 'cursors.json');
const tmpFile = `${newFile}.tmp`;
const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
/** the lanes of a cursor file, or a reason it cannot be read as one */
const lanesOf = (p) => {
  let j;
  try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return { error: `${p} is not readable cursor state (${e.code || e.message})` }; }
  if (!j || typeof j !== 'object' || !j.seats || typeof j.seats !== 'object' || Array.isArray(j.seats)) return { error: `${p} has no seats object` };
  return { seats: j.seats };
};
const fsyncPath = (p, flags = 'r') => { const fd = fs.openSync(p, flags); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };

for (const d of [args.from, args.to]) {
  let st = null; try { st = fs.statSync(d); } catch { /* below */ }
  if (!st || !st.isDirectory()) fail(2, `${d} is not a directory — nothing changed`);
}
const base = { dryRun: !args.apply, from: oldFile, to: newFile };

// ── where is the state now? ──
if (!exists(oldFile)) {
  if (exists(newFile) && exists(archive)) {
    const n = lanesOf(newFile);
    if (n.error) fail(2, n.error);
    out(0, { ...base, state: 'done', lanes: Object.keys(n.seats).length, action: 'none' });
  }
  if (exists(newFile)) fail(2, `${newFile} exists but there is no ${oldFile} or archive beside it: not a relocation this script can account for — nothing changed`);
  fail(2, `${oldFile} does not exist: there is no cursor state to relocate — nothing changed`);
}
const old = lanesOf(oldFile);
if (old.error) fail(2, `${old.error} — nothing changed`);
const lanes = Object.keys(old.seats).length;

let state;
if (exists(newFile)) {
  const n = lanesOf(newFile);
  if (n.error || !isDeepStrictEqual(n.seats, old.seats)) {
    out(3, { ...base, state: 'refused', reason: n.error ?? `${newFile} already holds DIFFERENT lane state; it may be newer progress, so it is never overwritten`, action: 'none' });
  }
  state = 'placed';      // a crash after the rename (or after the verify): only the archive step is left
} else {
  state = 'pending';
}
if (!args.apply) out(0, { ...base, state, lanes, action: state === 'pending' ? 'would move, verify and archive' : 'would verify and archive' });

// ── APPLY ──
if (state === 'pending') {
  const bytes = fs.readFileSync(oldFile);
  const mode = fs.statSync(oldFile).mode & 0o777;
  fs.writeFileSync(tmpFile, bytes, { mode });
  fs.chmodSync(tmpFile, mode);                  // writeFileSync's mode is masked by the umask; the state's mode is kept exactly
  fsyncPath(tmpFile, 'r+');
  crash('after-temp');
  fs.renameSync(tmpFile, newFile);
  fsyncPath(args.to);
  crash('after-rename');
}
const placed = lanesOf(newFile);
if (placed.error || !isDeepStrictEqual(placed.seats, old.seats)) {
  fail(2, `verification failed: ${newFile} does not hold every lane of ${oldFile} — the old file is left in place, not archived`);
}
crash('after-verify');
fs.renameSync(oldFile, archive);
fsyncPath(args.from);
if (exists(tmpFile)) fs.rmSync(tmpFile);         // a temp file left by an earlier crash is a copy of what is now in place
out(0, { ...base, state: 'done', lanes, action: state === 'pending' ? 'moved, verified, archived' : 'verified, archived' });
