#!/usr/bin/env node
/**
 * #1566 T4 — ONE TICK of the graph-store backup schedule: a verified backup into DEST
 * (scripts/graph-store-backup.mjs, unchanged copy + verify), then PRUNE. Run by launchd
 * every 15 minutes (StartInterval 900); each invocation is one tick, there is no daemon.
 *
 *   node scripts/graph-store-backup-schedule.mjs --url URL --dest DIR
 *        [--now ISO] [--checkpoint-dir DIR] [--keep-checkpoints 8] [--store DIR]
 *        [--python PY] [--state FILE] [--log FILE] [--dry-run]
 *   node scripts/graph-store-backup-schedule.mjs --prune-only --dest DIR [--now ISO] [--dry-run]
 *        [--checkpoint-dir DIR] [--keep-checkpoints N]
 *
 * --now ISO   the INJECTED CLOCK: the copy is named and the retention ages are computed
 *             from it (default: real time). Durations (copy, verify) are always measured in
 *             real wall-clock milliseconds and recorded as such; a simulated clock running
 *             at k x real time scales them in the MONITOR (--time-scale k), not here.
 *
 * ── RETENTION RULE (D3 v0.7 / PREREG T4; a copy satisfying several tiers is kept ONCE) ──
 * Only VERIFIED copies count toward coverage. A copy is VERIFIED when it is published under
 * its final name graph-store-<stamp> (graph-store-backup.mjs renames to that name ONLY after
 * verifyBackup passed) AND a cheap completeness check passes (manifest parses, every listed
 * file present at its recorded size). Its time is the <stamp> in its name (UTC, = the
 * tick's clock at the checkpoint). Age = now − stamp.
 *   recent   age < 4 h                                → keep
 *   hourly   the EARLIEST verified copy of each UTC clock hour, kept while ITS age is in [4 h, 24 h)
 *   daily    the EARLIEST verified copy of each UTC day,        kept while its age is in [24 h, 14 d)
 *   weekly   the EARLIEST verified copy of each ISO-8601 week (UTC), kept while its age is in [24 h, 56 d)
 *   newest   the NEWEST verified copy is ALWAYS kept, however old.
 * "Earliest of a bucket" is taken over ALL surviving verified copies of the bucket, then
 * the window is applied to that copy's own age. Pruning every tick under this definition
 * keeps exactly the set the rule names from the full history of copy timestamps (the
 * earliest of a bucket is never pruned while its window holds it; a later copy of the same
 * bucket is pruned when it enters the tier and is never needed again) — except that a copy
 * kept only as newest-verified stays until a newer verified copy exists.
 * NOT VERIFIED is never pruned and never counted:
 *   graph-store-<stamp>-UNVERIFIED   kept for a human (a verification failed)
 *   graph-store-<stamp>  incomplete  kept (manifest missing / a file missing or wrong size)
 *   graph-store-<stamp>.partial      pruned ONLY if older than the newest verified copy
 *                                    (abandoned: a tick that died mid-copy); a newer one may
 *                                    be in progress and is kept; with no verified copy, kept.
 * Anything else in DEST (other names, symlinks, files) is not a copy and is never touched.
 * LOCAL CHECKPOINTS (the executor's --checkpoint-dir, hard links to the live store, NOT a
 * backup): keep the last --keep-checkpoints (default 8) by checkpoint time; 0 = release
 * each tick's checkpoint after the copy (the old one-shot behaviour).
 *
 * ── A FAILED TICK PRUNES NOTHING ──
 * If the backup throws or does not verify, neither DEST nor the checkpoint directory is
 * pruned: the copies that exist are the only coverage there is.
 *
 * ── DELETION: two-phase, logged, confined ──
 * Phase 1 PLAN: every keep/delete decision is logged with its reason. Phase 2: each victim
 * is RENAMED into <root>/.pruning/ (one atomic step takes it out of the copy namespace, so a
 * crash mid-delete never leaves a half-deleted directory that looks like a copy), then
 * deleted, and logged DELETED. removeWithin REFUSES a name with a separator, a dot-name, a
 * symlink, or anything whose realpath's parent is not realpath(root). --dry-run stops after
 * phase 1.
 *
 * Exit: 0 tick ok · 1 backup failed / unverified / a refusal · 2 usage · 7 skipped (another
 * tick holds DEST/.tick.lock).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupStore, DEFAULT_PYTHON, MANIFEST } from './graph-store-backup.mjs';

const MIN = 60_000, H = 60 * MIN, D = 24 * H;
export const DEFAULT_POLICY = Object.freeze({ recentMs: 4 * H, hourlyMaxMs: 24 * H, dailyMaxMs: 14 * D, weeklyMaxMs: 56 * D });
export const DEFAULT_KEEP_CHECKPOINTS = 8;
export const STATE_FILE = 'backup-schedule-state.json';
export const LOG_FILE = 'backup-schedule.log';
const KEEP_TICKS = 200;
const COPY_RE = /^graph-store-(\d{8}T\d{6}Z)(\.partial|-UNVERIFIED)?$/;
const CKPT_RE = /^(\d{8}T\d{6}Z)-(\d+)-(\d{3})$/;

/** ms → the stamp graph-store-backup.mjs puts in a copy's name (UTC, second resolution). */
export function stampOf(ms) { return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); }
export function parseStamp(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}
const hourKey = (ms) => new Date(ms).toISOString().slice(0, 13);
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
/** ISO-8601 week of the UTC date: weeks start Monday; week 1 holds the year's first Thursday. */
export function isoWeekKey(ms) {
  const d = new Date(ms);
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - dow);              // the Thursday of this week
  const y = day.getUTCFullYear();
  const wk = Math.ceil(((day - Date.UTC(y, 0, 1)) / D + 1) / 7);
  return `${y}-W${String(wk).padStart(2, '0')}`;
}

/**
 * Pure. copies: [{ name, atMs, state: 'verified'|'unverified'|'incomplete'|'partial' }].
 * Returns { keep: [{ name, reasons }], delete: [{ name, reason }], newestVerified }.
 */
export function planPrune({ copies, nowMs, policy = DEFAULT_POLICY }) {
  const byTime = (a, b) => a.atMs - b.atMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const verified = copies.filter((c) => c.state === 'verified').sort(byTime);
  const newest = verified.length ? verified[verified.length - 1] : null;
  const reasons = new Map();
  const add = (c, r) => { if (!reasons.has(c.name)) reasons.set(c.name, []); reasons.get(c.name).push(r); };
  if (newest) add(newest, 'newest-verified');
  for (const c of verified) if (nowMs - c.atMs < policy.recentMs) add(c, 'recent<4h');
  const tier = (label, keyOf, lo, hi) => {
    const first = new Map();
    for (const c of verified) { const k = keyOf(c.atMs); if (!first.has(k)) first.set(k, c); }   // sorted: first = earliest
    for (const [k, c] of first) { const age = nowMs - c.atMs; if (age >= lo && age < hi) add(c, `${label}:${k}`); }
  };
  tier('hourly', hourKey, policy.recentMs, policy.hourlyMaxMs);
  tier('daily', dayKey, policy.hourlyMaxMs, policy.dailyMaxMs);
  tier('weekly', isoWeekKey, policy.hourlyMaxMs, policy.weeklyMaxMs);

  const keep = [], del = [];
  for (const c of [...copies].sort(byTime)) {
    if (c.state === 'verified') {
      if (reasons.has(c.name)) keep.push({ name: c.name, reasons: reasons.get(c.name) });
      else del.push({ name: c.name, reason: `verified, age ${((nowMs - c.atMs) / MIN).toFixed(1)} min, held by no tier` });
    } else if (c.state === 'partial') {
      if (newest && c.atMs < newest.atMs) del.push({ name: c.name, reason: `abandoned-partial (older than newest verified ${newest.name})` });
      else keep.push({ name: c.name, reasons: [newest ? 'partial-in-progress (not older than the newest verified copy)' : 'partial-in-progress (no verified copy exists)'] });
    } else {
      keep.push({ name: c.name, reasons: [`not-verified (${c.state}): never pruned, never counted`] });
    }
  }
  return { keep, delete: del, newestVerified: newest ? newest.name : null };
}

/** Pure. Keep the last `keep` checkpoint directories by (stamp, millisecond suffix, name). */
export function planCheckpointPrune({ names, keep = DEFAULT_KEEP_CHECKPOINTS }) {
  const key = (n) => { const m = CKPT_RE.exec(n); return [m[1], m[3], n]; };
  const cmp = (a, b) => { const x = key(a), y = key(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; };
  const sorted = names.filter((n) => CKPT_RE.test(n)).sort(cmp);
  const cut = Math.max(0, sorted.length - keep);
  return { keep: sorted.slice(cut), delete: sorted.slice(0, cut) };
}

/** Cheap completeness: manifest parses and every listed file exists at its recorded size (no hashing). */
export function completeness(dir) {
  let m;
  try { m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')); } catch { return { ok: false, why: 'manifest missing or unparseable' }; }
  if (!Array.isArray(m.files) || m.files.length === 0) return { ok: false, why: 'manifest lists no files' };
  let bytes = 0;
  for (const f of m.files) {
    let st;
    try { st = fs.statSync(path.join(dir, f.name)); } catch { return { ok: false, why: `${f.name} missing` }; }
    if (st.size !== f.size) return { ok: false, why: `${f.name} size ${st.size} != ${f.size}` };
    bytes += st.size;
  }
  return { ok: true, manifest: m, bytes };
}

/** Read DEST. Throws if DEST itself cannot be read (the monitor reports that UNAVAILABLE). */
export function scanDest(dest) {
  const out = [];
  for (const name of fs.readdirSync(dest)) {
    const m = COPY_RE.exec(name);
    if (!m) continue;
    const p = path.join(dest, name);
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (!st.isDirectory()) continue;                 // a symlink or a file is not a copy
    const atMs = parseStamp(m[1]);
    if (!Number.isFinite(atMs)) continue;
    if (m[2] === '.partial') out.push({ name, atMs, state: 'partial' });
    else if (m[2] === '-UNVERIFIED') out.push({ name, atMs, state: 'unverified' });
    else {
      const c = completeness(p);
      out.push(c.ok ? { name, atMs, state: 'verified', bytes: c.bytes } : { name, atMs, state: 'incomplete', why: c.why });
    }
  }
  return out;
}

/** Delete root/name, two-phase, refusing anything not a real direct child of realpath(root). */
export function removeWithin(root, name) {
  if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\') || name.startsWith('.')) {
    throw new Error(`REFUSED: not a plain entry name: ${JSON.stringify(name)}`);
  }
  const rootReal = fs.realpathSync(root);
  const p = path.join(rootReal, name);
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) throw new Error(`REFUSED: ${p} is a symlink`);
  const real = fs.realpathSync(p);
  if (path.dirname(real) !== rootReal) throw new Error(`REFUSED: ${real} is outside ${rootReal}`);
  const staging = path.join(rootReal, '.pruning');
  fs.mkdirSync(staging, { recursive: true });
  const staged = path.join(staging, name);
  fs.renameSync(real, staged);                           // phase 2a: out of the namespace, atomically
  fs.rmSync(staged, { recursive: true, force: true });   // phase 2b: delete
}

function clearStaging(root, log) {
  const staging = path.join(root, '.pruning');
  let left = [];
  try { left = fs.readdirSync(staging); } catch { return; }
  for (const n of left) { fs.rmSync(path.join(staging, n), { recursive: true, force: true }); log(`DELETED leftover staged ${n} (an earlier prune died between its two phases)`); }
}

function execute(root, victims, { dryRun, log, what }) {
  const deleted = [], refused = [];
  for (const v of victims) log(`PLAN delete ${what} ${v.name} — ${v.reason}`);
  if (dryRun) { log(`DRY-RUN: ${victims.length} ${what}(s) would be deleted; nothing deleted`); return { deleted, refused }; }
  clearStaging(root, log);
  for (const v of victims) {
    try { removeWithin(root, v.name); deleted.push(v.name); log(`DELETED ${what} ${v.name}`); }
    catch (e) { refused.push({ name: v.name, error: e.message }); log(/^REFUSED/.test(e.message) ? e.message : `DELETE FAILED: ${e.message}`); }
  }
  return { deleted, refused };
}

export function pruneDest({ dest, nowMs, policy = DEFAULT_POLICY, dryRun = false, log = () => {} }) {
  const plan = planPrune({ copies: scanDest(dest), nowMs, policy });
  for (const k of plan.keep) log(`PLAN keep copy ${k.name} — ${k.reasons.join(', ')}`);
  return { ...plan, ...execute(dest, plan.delete, { dryRun, log, what: 'copy' }) };
}

export function pruneCheckpoints({ dir, keep = DEFAULT_KEEP_CHECKPOINTS, dryRun = false, log = () => {} }) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { log(`checkpoint dir unreadable, not pruned: ${e.message}`); return { keep: [], delete: [], deleted: [], refused: [] }; }
  // only directories that ARE checkpoints: CURRENT present, no LOCK (a live store holds LOCK)
  const isCkpt = (n) => {
    try {
      const p = path.join(dir, n);
      return fs.lstatSync(p).isDirectory() && fs.existsSync(path.join(p, 'CURRENT')) && !fs.existsSync(path.join(p, 'LOCK'));
    } catch { return false; }
  };
  const plan = planCheckpointPrune({ names: names.filter(isCkpt), keep });
  for (const n of plan.keep) log(`PLAN keep checkpoint ${n} — among the last ${keep}`);
  return { ...plan, ...execute(dir, plan.delete.map((name) => ({ name, reason: `older than the last ${keep}` })), { dryRun, log, what: 'checkpoint' }) };
}

/** The retention count the rule settles to, derived by SIMULATING it at a steady interval. */
export function steadyStateCount({ intervalMs = 15 * MIN, policy = DEFAULT_POLICY, days = 70 } = {}) {
  let survivors = [], max = 0;
  const start = Date.UTC(2026, 0, 5);   // a Monday; after the weekly window the count is periodic
  for (let t = start; t <= start + days * D; t += intervalMs) {
    survivors.push({ name: `c${t}`, atMs: t, state: 'verified' });
    const keep = new Set(planPrune({ copies: survivors, nowMs: t, policy }).keep.map((k) => k.name));
    survivors = survivors.filter((c) => keep.has(c.name));
    if (t > start + policy.weeklyMaxMs) max = Math.max(max, survivors.length);
  }
  return max || survivors.length;
}

/** "destination: <path> (same volume as the store: NOT independent)" — or what is known instead. */
export function destinationLine(dest, storeOrCkpt) {
  const devOf = (p) => { let q = path.resolve(p); for (;;) { try { return fs.statSync(q).dev; } catch { const up = path.dirname(q); if (up === q) return null; q = up; } } };
  if (!storeOrCkpt) return `destination: ${dest} (volume relation to the store UNKNOWN: pass --store; same-disk copies do not protect against loss of the volume)`;
  const a = devOf(dest), b = devOf(storeOrCkpt);
  if (a != null && a === b) return `destination: ${dest} (same volume as the store: NOT independent)`;
  return `destination: ${dest} (device id ${a} differs from the store's ${b}; NOT verified as independent storage, not an authorized destination)`;
}

export function readState(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } }
function writeState(file, s) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function takeLock(dest) {
  const f = path.join(dest, '.tick.lock');
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

/** One tick. Returns { ok, skipped, backup, prune, checkpoints, record }. */
export async function tick({ url, dest, nowMs = Date.now(), python = DEFAULT_PYTHON, checkpointDir = null,
  keepCheckpoints = DEFAULT_KEEP_CHECKPOINTS, store = null, stateFile = null, logFile = null, dryRun = false,
  policy = DEFAULT_POLICY, fetchImpl, out = () => {} }) {
  fs.mkdirSync(dest, { recursive: true });
  stateFile ||= path.join(dest, STATE_FILE);
  logFile ||= path.join(dest, LOG_FILE);
  const iso = new Date(nowMs).toISOString();
  const log = (l) => { const line = `${iso} ${l}`; fs.appendFileSync(logFile, line + '\n'); out(line); };
  const release = takeLock(dest);
  if (!release) { log('SKIPPED: another tick holds .tick.lock'); return { ok: false, skipped: true }; }
  try {
    const record = { at: iso, startedAt: new Date().toISOString(), ok: false };
    let backup = null;
    try {
      backup = await backupStore({ url, dest, python, now: () => new Date(nowMs), keepCheckpoint: keepCheckpoints > 0, ...(fetchImpl ? { fetchImpl } : {}) });
      record.ok = backup.ok;
      record.path = backup.path;
      record.timings = backup.timings;
      record.checkpoint = backup.checkpoint;
      if (!backup.ok) record.error = backup.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; ');
    } catch (e) { record.error = e.message; }
    const ckDir = checkpointDir || (backup?.checkpoint?.path ? path.dirname(backup.checkpoint.path) : null);
    record.checkpointDir = ckDir;
    log(record.ok
      ? `BACKUP OK ${path.basename(record.path)} checkpoint ${record.timings.checkpointMs.toFixed(0)} ms, copy ${record.timings.copyMs.toFixed(0)} ms, verify ${record.timings.verifyMs.toFixed(0)} ms`
      : `BACKUP FAILED ${record.path ? path.basename(record.path) + ' ' : ''}${record.error}`);
    log(destinationLine(dest, store || ckDir));

    let prune = null, checkpoints = null;
    if (!record.ok) {
      log('PRUNE SKIPPED: this tick did not produce a verified copy; every existing copy and checkpoint is kept');
    } else {
      prune = pruneDest({ dest, nowMs, policy, dryRun, log });
      if (keepCheckpoints > 0 && ckDir) checkpoints = pruneCheckpoints({ dir: ckDir, keep: keepCheckpoints, dryRun, log });
      record.prune = { kept: prune.keep.length, deleted: prune.deleted.length, refused: prune.refused.length,
        checkpointsKept: checkpoints?.keep.length ?? null, checkpointsDeleted: checkpoints?.deleted.length ?? null, dryRun };
    }
    record.finishedAt = new Date().toISOString();
    const st = readState(stateFile);
    st.ticks = [...(Array.isArray(st.ticks) ? st.ticks : []), record].slice(-KEEP_TICKS);
    writeState(stateFile, st);
    const refused = (prune?.refused.length || 0) + (checkpoints?.refused.length || 0);
    return { ok: record.ok && refused === 0, skipped: false, backup, prune, checkpoints, record };
  } finally { release(); }
}

function parseArgs(argv) {
  const a = { python: DEFAULT_PYTHON, keepCheckpoints: DEFAULT_KEEP_CHECKPOINTS };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--url') a.url = argv[++i];
    else if (k === '--dest') a.dest = argv[++i];
    else if (k === '--now') { a.nowMs = Date.parse(argv[++i]); if (!Number.isFinite(a.nowMs)) throw new Error('--now must be an ISO timestamp'); }
    else if (k === '--python') a.python = argv[++i];
    else if (k === '--checkpoint-dir') a.checkpointDir = argv[++i];
    else if (k === '--keep-checkpoints') { a.keepCheckpoints = Number(argv[++i]); if (!Number.isInteger(a.keepCheckpoints) || a.keepCheckpoints < 0) throw new Error('--keep-checkpoints must be an integer >= 0'); }
    else if (k === '--store') a.store = argv[++i];
    else if (k === '--state') a.stateFile = argv[++i];
    else if (k === '--log') a.logFile = argv[++i];
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--prune-only') a.pruneOnly = true;
    else throw new Error(`unknown arg: ${k}`);
  }
  if (!a.dest) throw new Error('--dest is required');
  if (!a.pruneOnly && !a.url) throw new Error('--url is required (or --prune-only)');
  return a;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let a;
  try { a = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (a.pruneOnly) {
    const nowMs = a.nowMs ?? Date.now();
    const iso = new Date(nowMs).toISOString();
    const log = (l) => console.log(`${iso} ${l}`);
    const p = pruneDest({ dest: a.dest, nowMs, dryRun: a.dryRun, log });
    let c = null;
    if (a.checkpointDir && a.keepCheckpoints > 0) c = pruneCheckpoints({ dir: a.checkpointDir, keep: a.keepCheckpoints, dryRun: a.dryRun, log });
    process.exit(p.refused.length || c?.refused.length ? 1 : 0);
  }
  tick({ ...a, out: (l) => console.log(l) }).then((r) => {
    console.log(JSON.stringify({ ok: r.ok, skipped: r.skipped, path: r.record?.path ?? null, timings: r.record?.timings ?? null, prune: r.record?.prune ?? null, error: r.record?.error ?? null }));
    process.exit(r.skipped ? 7 : r.ok ? 0 : 1);
  }, (e) => { console.error(`TICK ERROR: ${e.message}`); process.exit(1); });
}
