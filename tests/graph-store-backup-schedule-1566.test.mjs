/**
 * #1566 T4 — the backup SCHEDULER (one tick = verified backup, then prune), the PRUNER
 * (the frozen retention rule), and the FRESHNESS MONITOR (age of the newest VERIFIED copy
 * against the NOMINAL limit 15 min + measured copy + verify).
 *
 * These are the builder's own unit tests. They are NOT a reviewer's frozen T4 harness and say nothing
 * about whether it passes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createGraphClient } from '../core/graph-client.mjs';
import {
  planPrune, planCheckpointPrune, scanDest, removeWithin, pruneDest, stampOf, isoWeekKey,
  steadyStateCount, DEFAULT_POLICY,
} from '../scripts/graph-store-backup-schedule.mjs';
import { assess, monitor } from '../scripts/graph-store-backup-monitor.mjs';
import { renderPlist } from '../scripts/graph-store-backup-plist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXEC = path.join(ROOT, 'graph-executor', 'executor.py');
const TICK = path.join(ROOT, 'scripts', 'graph-store-backup-schedule.mjs');
const MON = path.join(ROOT, 'scripts', 'graph-store-backup-monitor.mjs');
const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(ROOT, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = !HAVE_PY ? `UNAVAILABLE: no python with pyoxigraph at ${PY}` : false;

const MIN = 60_000, H = 60 * MIN, D = 24 * H;
const T0 = Date.parse('2026-10-04T00:00:00Z');
const at = (ms) => ({ name: `graph-store-${stampOf(ms)}`, atMs: ms, state: 'verified' });
const names = (xs) => xs.map((x) => x.name).sort();
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bks-'));

/** A copy directory that LOOKS complete to the cheap check (manifest + listed files at their sizes). */
function fakeCopy(dest, ms, suffix = '', { manifest = true } = {}) {
  const d = path.join(dest, `graph-store-${stampOf(ms)}${suffix}`);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, '000001.sst'), 'abcdefghij');
  if (manifest) {
    fs.writeFileSync(path.join(d, 'backup-manifest.json'), JSON.stringify({
      takenAt: new Date(ms).toISOString(), files: [{ name: '000001.sst', size: 10, sha256: crypto.createHash('sha256').update('abcdefghij').digest('hex') }],
    }));
  }
  return d;
}
function fakeCheckpoint(dir, name) {
  const d = path.join(dir, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'CURRENT'), 'MANIFEST-000001\n');
  return d;
}

// ───────────────────────── PRUNE: the frozen rule, pure ─────────────────────────

test('#1566 prune: every verified copy YOUNGER than 4 h is kept; at exactly 4 h a copy is in the hourly tier', () => {
  const now = T0 + 12 * H;
  const copies = [];
  for (let m = 0; m <= 12 * 60; m += 15) copies.push(at(T0 + m * MIN));
  const p = planPrune({ copies, nowMs: now });
  const kept = new Set(p.keep.map((k) => k.name));
  for (const c of copies) if (now - c.atMs < 4 * H) assert.ok(kept.has(c.name), `${c.name} age ${(now - c.atMs) / MIN} min must be kept`);
  // 08:15 is age 3h45 → recent; 08:00 is age exactly 4 h → hourly (earliest of hour 08) → kept
  assert.ok(kept.has(`graph-store-${stampOf(T0 + 8 * H)}`));
});

test('#1566 prune: ages 4–24 h keep ONLY the earliest copy of each clock hour (UTC)', () => {
  const now = T0 + 12 * H;
  const copies = [];
  for (let m = 0; m <= 12 * 60; m += 15) copies.push(at(T0 + m * MIN));
  const p = planPrune({ copies, nowMs: now });
  const want = new Set();
  for (const c of copies) {
    const age = now - c.atMs;
    if (age < 4 * H) want.add(c.name);
    else if (age < 24 * H && (c.atMs % H) === 0) want.add(c.name);   // :00 is the earliest of its hour here
  }
  assert.deepEqual(names(p.keep), [...want].sort());
  assert.deepEqual(names(p.delete), names(copies.filter((c) => !want.has(c.name))));
  // independently: hours 00..07 keep one copy each, 08:00 kept (age exactly 4h), 08:15+ all kept
  assert.equal(p.keep.length, 8 /* 00..07 */ + 1 /* 08:00 */ + 16 /* 08:15..12:00 */);
});

test('#1566 prune: the earliest copy of an hour is kept even when that hour is irregular (missed slots)', () => {
  const now = T0 + 10 * H;
  // hour 02: copies at 02:20, 02:35, 02:50 (the :00 attempt was missed)
  const copies = [at(T0 + 2 * H + 20 * MIN), at(T0 + 2 * H + 35 * MIN), at(T0 + 2 * H + 50 * MIN), at(T0 + 9 * H + 30 * MIN)];
  const p = planPrune({ copies, nowMs: now });
  assert.deepEqual(names(p.keep), names([copies[0], copies[3]]));
});

test('#1566 prune: older than 24 h — earliest per UTC day for 14 days, earliest per ISO week for 8 weeks; a copy in several tiers is counted ONCE', () => {
  const now = T0 + 70 * D;
  const copies = [];
  // copies at day d, 03:00 and 15:00, for d = 0..69 (now = day 70 00:00)
  for (let d = 0; d < 70; d++) for (const h of [3, 15]) copies.push(at(T0 + d * D + h * H));
  const p = planPrune({ copies: copies.filter((c) => c.atMs <= now), nowMs: now });
  const kept = new Map(p.keep.map((k) => [k.name, k.reasons]));
  const want = new Set();
  const byDay = new Map(), byWeek = new Map();
  for (const c of copies.filter((x) => x.atMs <= now)) {
    const age = now - c.atMs;
    const day = new Date(c.atMs).toISOString().slice(0, 10);
    if (!byDay.has(day) || byDay.get(day).atMs > c.atMs) byDay.set(day, c);
    const wk = isoWeekKey(c.atMs);
    if (!byWeek.has(wk) || byWeek.get(wk).atMs > c.atMs) byWeek.set(wk, c);
    if (age < 4 * H) want.add(c.name);
  }
  for (const c of byDay.values()) { const a = now - c.atMs; if (a >= 24 * H && a < 14 * D) want.add(c.name); }
  for (const c of byWeek.values()) { const a = now - c.atMs; if (a >= 24 * H && a < 56 * D) want.add(c.name); }
  // hourly tier: earliest of each hour in [4h, 24h) — here only the day-69 copies
  for (const c of copies) { const a = now - c.atMs; if (a >= 4 * H && a < 24 * H) want.add(c.name); }
  assert.deepEqual(names(p.keep), [...want].sort());
  // counted once: no duplicate names, and a copy kept by both daily and weekly carries both reasons
  assert.equal(new Set(p.keep.map((k) => k.name)).size, p.keep.length);
  assert.ok([...kept.values()].some((r) => r.join(',').includes('daily:') && r.join(',').includes('weekly:')), 'some copy is in both tiers, listed once');
  assert.equal(p.keep.length + p.delete.length, copies.filter((c) => c.atMs <= now).length);
});

test('#1566 isoWeekKey follows ISO-8601 (2026-01-01 is a Thursday → 2026-W01; 2027-01-01 is a Friday → 2026-W53)', () => {
  assert.equal(isoWeekKey(Date.parse('2026-01-01T12:00:00Z')), '2026-W01');
  assert.equal(isoWeekKey(Date.parse('2025-12-29T00:00:00Z')), '2026-W01');
  assert.equal(isoWeekKey(Date.parse('2027-01-01T00:00:00Z')), '2026-W53');
  assert.equal(isoWeekKey(Date.parse('2026-10-04T23:59:59Z')), '2026-W40');   // a Sunday
  assert.equal(isoWeekKey(Date.parse('2026-10-05T00:00:00Z')), '2026-W41');   // the Monday after
});

test('#1566 prune: the NEWEST VERIFIED copy is NEVER pruned, however old (no tier holds it)', () => {
  const now = T0 + 200 * D;
  const old = at(T0);                       // 200 days old: outside every tier
  const older = at(T0 - 3 * D);
  const p = planPrune({ copies: [older, old], nowMs: now });
  assert.deepEqual(names(p.keep), [old.name]);
  assert.match(p.keep[0].reasons.join(','), /newest-verified/);
  assert.deepEqual(names(p.delete), [older.name]);
  assert.equal(p.newestVerified, old.name);
});

test('#1566 prune: unverified / incomplete / partial copies are NEVER counted toward coverage — not newest-verified, not in any tier', () => {
  const now = T0 + 12 * H;
  // hour 05: an UNVERIFIED copy at 05:00 is EARLIER than the verified 05:10 — it must not take the hour's slot
  const good = at(T0 + 5 * H + 10 * MIN);
  const unv = { name: `graph-store-${stampOf(T0 + 5 * H)}-UNVERIFIED`, atMs: T0 + 5 * H, state: 'unverified' };
  // hour 06: an UNVERIFIED 06:00 and an incomplete 06:15 must not displace the verified 06:30
  const earlierUnv = { name: `graph-store-${stampOf(T0 + 6 * H)}-UNVERIFIED`, atMs: T0 + 6 * H, state: 'unverified' };
  const inc = { name: `graph-store-${stampOf(T0 + 6 * H + 15 * MIN)}`, atMs: T0 + 6 * H + 15 * MIN, state: 'incomplete' };
  const sameHourGood = at(T0 + 6 * H + 30 * MIN);
  const newestGood = at(T0 + 11 * H + 30 * MIN);
  const newerPartial = { name: `graph-store-${stampOf(T0 + 11 * H + 45 * MIN)}.partial`, atMs: T0 + 11 * H + 45 * MIN, state: 'partial' };
  const newerUnv = { name: `graph-store-${stampOf(T0 + 11 * H + 50 * MIN)}-UNVERIFIED`, atMs: T0 + 11 * H + 50 * MIN, state: 'unverified' };
  const p = planPrune({ copies: [good, unv, earlierUnv, inc, sameHourGood, newestGood, newerPartial, newerUnv], nowMs: now });
  assert.equal(p.newestVerified, newestGood.name, 'a newer partial/unverified copy is not the newest VERIFIED');
  const kept = new Map(p.keep.map((k) => [k.name, k.reasons.join(',')]));
  assert.match(kept.get(sameHourGood.name) || 'PRUNED', /hourly:/, 'the verified 06:30 holds hour 06 (no unverified/incomplete copy counts)');
  assert.match(kept.get(good.name) || 'PRUNED', /hourly:/, 'the verified 05:10 holds hour 05');
  // the non-verified ones are KEPT (never pruned), but by the not-verified rule, never by a tier
  for (const x of [unv, earlierUnv, inc, newerUnv]) assert.match(kept.get(x.name), /^not-verified/, x.name);
  assert.match(kept.get(newerPartial.name), /^partial-in-progress/);
  assert.deepEqual(p.delete, []);
});

test('#1566 prune: an abandoned .partial OLDER than the newest verified copy is pruned; a newer one is kept; with no verified copy none is', () => {
  const now = T0 + 2 * H;
  const oldPartial = { name: `graph-store-${stampOf(T0)}.partial`, atMs: T0, state: 'partial' };
  const good = at(T0 + H);
  const newPartial = { name: `graph-store-${stampOf(T0 + 90 * MIN)}.partial`, atMs: T0 + 90 * MIN, state: 'partial' };
  const p = planPrune({ copies: [oldPartial, good, newPartial], nowMs: now });
  assert.deepEqual(names(p.delete), [oldPartial.name]);
  assert.match(p.delete[0].reason, /abandoned-partial/);
  const p2 = planPrune({ copies: [oldPartial, newPartial], nowMs: now });
  assert.deepEqual(p2.delete, [], 'no verified copy exists: nothing is provably abandoned');
});

test('#1566 checkpoints: keep the LAST 8 (by checkpoint time), delete the rest; fewer than 8 → nothing deleted', () => {
  const ns = [];
  for (let i = 0; i < 12; i++) ns.push(`20261004T${String(i).padStart(2, '0')}0000Z-${100 + i}-00${i % 10}`);
  const shuffled = [...ns].reverse();
  const p = planCheckpointPrune({ names: shuffled, keep: 8 });
  assert.equal(p.keep.length, 8);
  assert.deepEqual([...p.keep].sort(), ns.slice(-8).sort());
  assert.deepEqual([...p.delete].sort(), ns.slice(0, 4).sort());
  assert.deepEqual(planCheckpointPrune({ names: ns.slice(0, 5), keep: 8 }).delete, []);
  assert.equal(planCheckpointPrune({ names: ns.slice(0, 8), keep: 8 }).keep.length, 8);
  assert.equal(planCheckpointPrune({ names: ns.slice(0, 9), keep: 8 }).keep.length, 8);
  // within one second, the millisecond suffix orders them (not the pid)
  const same = ['20261004T000000Z-999-001', '20261004T000000Z-100-900'];
  assert.deepEqual(planCheckpointPrune({ names: [...same, ...ns.slice(-8)], keep: 9 }).keep.includes('20261004T000000Z-100-900'), true);
  assert.deepEqual(planCheckpointPrune({ names: [...same, ...ns.slice(-8)], keep: 9 }).delete, ['20261004T000000Z-999-001']);
});

// ───────────────────────── PRUNE: on disk ─────────────────────────

test('#1566 removeWithin REFUSES anything outside its root: a symlink, a path with a separator, ".."', () => {
  const tmp = tmpdir();
  const dest = path.join(tmp, 'dest'); fs.mkdirSync(dest);
  const outside = path.join(tmp, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'precious'), 'x');
  fs.symlinkSync(outside, path.join(dest, 'graph-store-20200101T000000Z'));
  assert.throws(() => removeWithin(dest, 'graph-store-20200101T000000Z'), /REFUSED/);
  assert.throws(() => removeWithin(dest, '../outside'), /REFUSED/);
  assert.throws(() => removeWithin(dest, 'a/b'), /REFUSED/);
  assert.ok(fs.existsSync(path.join(outside, 'precious')), 'the target outside DEST survives');
  // and a real child is removed (two-phase: staged, then deleted)
  fs.mkdirSync(path.join(dest, 'graph-store-20200101T001500Z'));
  removeWithin(dest, 'graph-store-20200101T001500Z');
  assert.ok(!fs.existsSync(path.join(dest, 'graph-store-20200101T001500Z')));
  assert.deepEqual(fs.readdirSync(path.join(dest, '.pruning')), [], 'the staging area is emptied');
});

test('#1566 pruneDest: scans DEST (symlinks and foreign names ignored), DRY-RUN deletes nothing, a real run deletes exactly the plan and logs each line', () => {
  const tmp = tmpdir();
  const dest = path.join(tmp, 'dest'); fs.mkdirSync(dest);
  const now = T0 + 10 * H;
  for (let m = 0; m <= 10 * 60; m += 15) fakeCopy(dest, T0 + m * MIN);
  fakeCopy(dest, T0 + 30 * MIN, '-UNVERIFIED');
  fakeCopy(dest, T0 + 50 * MIN, '', { manifest: false });     // looks published but has no manifest → incomplete
  fs.writeFileSync(path.join(dest, 'notes.txt'), 'not a copy');
  const outside = path.join(tmp, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(dest, `graph-store-${stampOf(T0 + 5 * MIN)}`));
  const scanned = scanDest(dest);
  assert.ok(!scanned.some((c) => c.atMs === T0 + 5 * MIN), 'a symlink is not a copy');
  assert.equal(scanned.find((c) => c.name.endsWith('-UNVERIFIED')).state, 'unverified');
  const before = fs.readdirSync(dest).sort();
  const lines = [];
  const dry = pruneDest({ dest, nowMs: now, dryRun: true, log: (l) => lines.push(l) });
  assert.deepEqual(fs.readdirSync(dest).sort(), before, 'dry run changes nothing');
  assert.ok(dry.delete.length > 0);
  assert.ok(lines.some((l) => /DRY-RUN/.test(l)));
  const lines2 = [];
  const real = pruneDest({ dest, nowMs: now, dryRun: false, log: (l) => lines2.push(l) });
  assert.deepEqual(real.delete.map((d) => d.name).sort(), dry.delete.map((d) => d.name).sort());
  for (const d of real.delete) assert.ok(!fs.existsSync(path.join(dest, d.name)), d.name);
  for (const k of real.keep) assert.ok(fs.existsSync(path.join(dest, k.name)), k.name);
  assert.ok(fs.existsSync(outside) && fs.existsSync(path.join(dest, 'notes.txt')));
  assert.ok(fs.existsSync(path.join(dest, `graph-store-${stampOf(T0 + 50 * MIN)}`)), 'an incomplete copy is never pruned');
  assert.ok(fs.existsSync(path.join(dest, `graph-store-${stampOf(T0 + 30 * MIN)}-UNVERIFIED`)), 'an UNVERIFIED copy is never pruned');
  assert.equal(lines2.filter((l) => /\bDELETED\b/.test(l)).length, real.delete.length);
  assert.ok(lines2.some((l) => /\bPLAN\b/.test(l)), 'phase 1 is logged before phase 2');
});

test('#1566 steady-state retention count is DERIVED from the rule by simulation (15-min interval)', () => {
  const n = steadyStateCount({ intervalMs: 15 * MIN, policy: DEFAULT_POLICY });
  // 16 copies < 4 h + 20 hourly (4..24 h) + ~13 daily + a few weekly beyond 14 days — a range, not a pinned number
  assert.ok(n >= 16 + 20 + 12 && n <= 16 + 21 + 14 + 8, `steady-state count ${n}`);
});

// ───────────────────────── MONITOR ─────────────────────────

const STATE = (copyMs, verifyMs, checkpointMs = 0) => ({ ticks: [{ at: new Date(T0).toISOString(), ok: true, timings: { checkpointMs, copyMs, verifyMs } }] });

test('#1566 monitor (pure): fresh → OK; age beyond the NOMINAL limit (15 + c + v) → STALE alert; the limit and its c, v are in the line', () => {
  const copies = [at(T0)];
  const st = STATE(60_000, 30_000);   // c = 1 min, v = 0.5 min → limit 16.5 min
  const ok = assess({ copies, state: st, nowMs: T0 + 16 * MIN });
  assert.equal(ok.verdict, 'OK'); assert.equal(ok.alert, false);
  assert.equal(ok.limitMs, 16.5 * MIN);
  assert.match(ok.line, /nominal limit 16\.5 min = 15\.0 min interval \+ copy 1\.0 min \+ verify 0\.5 min/);
  assert.match(ok.line, /measured by the tick at 2026-10-04T00:00:00\.000Z/);
  const edge = assess({ copies, state: st, nowMs: T0 + 16.5 * MIN });
  assert.equal(edge.alert, false, 'age == limit is not beyond it');
  const stale = assess({ copies, state: st, nowMs: T0 + 16.5 * MIN + 1000 });
  assert.equal(stale.verdict, 'STALE'); assert.equal(stale.alert, true);
  assert.match(stale.line, /^ALERT STALE/);
  // one missed tick (age 15 + 15 + c + v) is caught at the NOMINAL limit — never widened by misses
  const missed = assess({ copies, state: { ...st, ticks: [...st.ticks, { at: 'x', ok: false, error: 'missed' }, { at: 'y', ok: false }] }, nowMs: T0 + 20 * MIN });
  assert.equal(missed.alert, true);
  assert.equal(missed.limitMs, 16.5 * MIN, 'failed/missed ticks do not widen the threshold');
});

test('#1566 monitor (pure): the alert must fire inside the FIRST miss — threshold + 20 min would be a false negative', () => {
  const copies = [at(T0)];
  const st = STATE(6_000, 6_000);     // c + v = 0.2 min
  for (const m of [15.3, 20, 25, 30, 35]) assert.equal(assess({ copies, state: st, nowMs: T0 + m * MIN }).alert, true, `age ${m} min`);
  for (const m of [0, 5, 15.1, 15.2]) assert.equal(assess({ copies, state: st, nowMs: T0 + m * MIN }).alert, false, `age ${m} min`);
});

test('#1566 monitor (pure): no verified copy → NO-COPY alert; only unverified/partial/incomplete copies still → NO-COPY', () => {
  const r = assess({ copies: [], state: {}, nowMs: T0 });
  assert.equal(r.verdict, 'NO-COPY'); assert.equal(r.alert, true); assert.match(r.line, /^ALERT NO-COPY/);
  const r2 = assess({ copies: [{ name: 'graph-store-x-UNVERIFIED', atMs: T0, state: 'unverified' }, { name: 'p', atMs: T0, state: 'partial' }, { name: 'i', atMs: T0, state: 'incomplete' }], state: {}, nowMs: T0 });
  assert.equal(r2.verdict, 'NO-COPY');
});

test('#1566 monitor (pure): a NEWER unverified copy does not refresh the age — it is measured from the newest VERIFIED one', () => {
  const st = STATE(0, 0);
  const r = assess({ copies: [at(T0), { name: 'u', atMs: T0 + 40 * MIN, state: 'unverified' }, { name: 'p', atMs: T0 + 41 * MIN, state: 'partial' }], state: st, nowMs: T0 + 45 * MIN });
  assert.equal(r.ageMs, 45 * MIN); assert.equal(r.alert, true);
});

test('#1566 monitor (pure): no recorded timings → limit is the interval alone, said as UNMEASURED; --time-scale multiplies measured durations', () => {
  const r = assess({ copies: [at(T0)], state: {}, nowMs: T0 });
  assert.equal(r.limitMs, 15 * MIN);
  assert.match(r.line, /UNMEASURED/);
  const s = assess({ copies: [at(T0)], state: STATE(1000, 1000), nowMs: T0, timeScale: 60 });
  assert.equal(s.limitMs, 15 * MIN + 2 * MIN);
});

test('#1566 monitor (on disk): fresh DEST → exit 0; stale → exit 4; empty → exit 5; unreadable / missing DEST → UNAVAILABLE exit 3, never healthy', () => {
  const tmp = tmpdir();
  const dest = path.join(tmp, 'dest'); fs.mkdirSync(dest);
  fakeCopy(dest, T0);
  const run = (...args) => spawnSync(process.execPath, [MON, '--dest', dest, ...args], { encoding: 'utf8' });
  let r = run('--now', new Date(T0 + 5 * MIN).toISOString());
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /^OK /m);
  r = run('--now', new Date(T0 + 16 * MIN).toISOString());
  assert.equal(r.status, 4, r.stdout + r.stderr); assert.match(r.stdout, /^ALERT STALE/m);
  const empty = path.join(tmp, 'empty'); fs.mkdirSync(empty);
  r = spawnSync(process.execPath, [MON, '--dest', empty, '--now', new Date(T0).toISOString()], { encoding: 'utf8' });
  assert.equal(r.status, 5); assert.match(r.stdout, /^ALERT NO-COPY/m);
  r = spawnSync(process.execPath, [MON, '--dest', path.join(tmp, 'nope'), '--now', new Date(T0).toISOString()], { encoding: 'utf8' });
  assert.equal(r.status, 3); assert.match(r.stdout, /^ALERT UNAVAILABLE/m);
  const locked = path.join(tmp, 'locked'); fs.mkdirSync(locked); fakeCopy(locked, T0); fs.chmodSync(locked, 0o000);
  try {
    if (process.getuid() !== 0) {
      const m = monitor({ dest: locked, nowMs: T0 });
      assert.equal(m.verdict, 'UNAVAILABLE'); assert.equal(m.alert, true);
    }
  } finally { fs.chmodSync(locked, 0o700); }
});

test('#1566 monitor capacity line: retained bytes, newest size, projection at measured size and at an ASSUMED 2x, against measured free space; destination volume stated', () => {
  const tmp = tmpdir();
  const dest = path.join(tmp, 'dest'); fs.mkdirSync(dest);
  fakeCopy(dest, T0); fakeCopy(dest, T0 + 15 * MIN);
  const store = path.join(tmp, 'store'); fs.mkdirSync(store);
  const m = monitor({ dest, nowMs: T0 + 16 * MIN, store });
  const c = m.capacity;
  assert.ok(c.retainedBytes >= 20, JSON.stringify(c));
  assert.ok(c.newestBytes >= 10);
  assert.equal(c.projectedBytes, c.retentionCount * c.newestBytes);
  assert.equal(c.projected2xBytes, 2 * c.projectedBytes);
  assert.ok(c.freeBytes > 0);
  assert.match(m.capacityLine, /ASSUMPTION/);
  assert.match(m.capacityLine, /not a bound on growth/);
  assert.match(m.destinationLine, /destination: .*dest \(same volume as the store: NOT independent\)/);
});

// ───────────────────────── PLIST (dry run) ─────────────────────────

test('#1566 plist renderer: tick every 900 s and the monitor; prints only; the destination line says NOT independent when same-volume', () => {
  const tmp = tmpdir();
  const dest = path.join(tmp, 'dest'), store = path.join(tmp, 'store'); fs.mkdirSync(store);
  const tick = renderPlist({ job: 'tick', dest, url: 'http://127.0.0.1:59199', store, code: ROOT, node: '/usr/bin/node' });
  assert.match(tick, /<key>StartInterval<\/key><integer>900<\/integer>/);
  assert.match(tick, /graph-store-backup-schedule\.mjs/);
  assert.match(tick, /<!-- destination: .*dest \(same volume as the store: NOT independent\) -->/);
  assert.match(tick, /<string>--url<\/string>\s*<string>http:\/\/127\.0\.0\.1:59199<\/string>/);
  const mon = renderPlist({ job: 'monitor', dest, url: 'http://127.0.0.1:59199', store, code: ROOT, node: '/usr/bin/node' });
  assert.match(mon, /graph-store-backup-monitor\.mjs/);
  assert.match(mon, /NOT independent/);
  assert.throws(() => renderPlist({ job: 'tick', dest: 'relative/path', url: 'http://127.0.0.1:1', store, code: ROOT }), /absolute/);
  assert.throws(() => renderPlist({ job: 'tick', dest: '/a/b<c', url: 'http://127.0.0.1:1', store, code: ROOT }), /characters/);
});

// ───────────────────────── one REAL tick, real executor ─────────────────────────

function start(store, ckpt) {
  return new Promise((resolve, reject) => {
    const p = spawn(PY, [EXEC, '--store', store, '--port', '0', '--dataset-id', 'bks', '--create', '--checkpoint-dir', ckpt], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; if (out.includes('\n')) resolve({ p, base: `http://127.0.0.1:${JSON.parse(out.split('\n')[0]).port}` }); });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => reject(new Error(`exited ${code}: ${err}`)));
  });
}
const rule = (n) => ({ kind: 'rule', opId: `urn:ex:op/bks-${n}`, actor: 'urn:ex:admin', rule: { iri: `urn:ex:R/bks-${n}` } });

let real;
async function realExecutor() {
  if (real) return real;
  const tmp = tmpdir();
  const store = path.join(tmp, 'store'); fs.mkdirSync(store);
  const ckpt = path.join(tmp, 'ckpt');
  const e = await start(store, ckpt);
  const c = createGraphClient({ baseUrl: e.base });
  for (let i = 0; i < 20; i++) assert.equal((await c.update(rule(i))).outcome, 'APPLIED');
  real = { tmp, store, ckpt, e };
  return real;
}
test.after(() => { if (real) real.e.p.kill('SIGKILL'); });

const runTick = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [TICK, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  p.on('exit', (status) => resolve({ status, stdout: out, stderr: err }));
});

test('#1566 one REAL tick: verified copy + manifest + recorded timings; prune ran (old same-hour copy deleted); checkpoints pruned to the last 8', { skip: SKIP }, async () => {
  const { tmp, store, ckpt, e } = await realExecutor();
  const dest = path.join(tmp, 'dest'); fs.mkdirSync(dest);
  const now = Date.parse('2026-10-04T12:00:00Z');
  const keepOld = fakeCopy(dest, now - 5 * H);                // earliest of hour 07 → kept
  const dropOld = fakeCopy(dest, now - 5 * H + 15 * MIN);     // same hour, later → pruned
  fs.mkdirSync(ckpt, { recursive: true });
  for (let i = 0; i < 10; i++) fakeCheckpoint(ckpt, `20200101T0000${String(i).padStart(2, '0')}Z-1-000`);
  const r = await runTick(['--url', e.base, '--dest', dest, '--now', new Date(now).toISOString(), '--python', PY, '--checkpoint-dir', ckpt, '--store', store]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const copy = path.join(dest, `graph-store-${stampOf(now)}`);
  assert.ok(fs.existsSync(path.join(copy, 'backup-manifest.json')), 'published under its final (verified) name with a manifest');
  const v = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'graph-store-backup.mjs'), '--verify', copy, '--python', PY], { encoding: 'utf8' });
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.ok(fs.existsSync(keepOld)); assert.ok(!fs.existsSync(dropOld), 'prune ran after the verified copy');
  const cps = fs.readdirSync(ckpt).filter((n) => !n.startsWith('.'));
  assert.equal(cps.length, 8, cps.join(','));
  assert.ok(cps.some((n) => n.startsWith('2026')), 'this tick\'s own checkpoint is among the kept 8');
  const state = JSON.parse(fs.readFileSync(path.join(dest, 'backup-schedule-state.json'), 'utf8'));
  const last = state.ticks.at(-1);
  assert.equal(last.ok, true); assert.equal(last.at, new Date(now).toISOString());
  for (const k of ['checkpointMs', 'copyMs', 'verifyMs']) assert.ok(last.timings[k] > 0, k);
  assert.match(r.stdout, /destination: .* \(same volume as the store: NOT independent\)/);
  const log = fs.readFileSync(path.join(dest, 'backup-schedule.log'), 'utf8');
  assert.match(log, /PLAN/); assert.match(log, /DELETED/);
  // the monitor reads that tick: fresh now, limit from its measured timings
  const m = monitor({ dest, nowMs: now + 5 * MIN, store });
  assert.equal(m.verdict, 'OK', m.line);
  assert.ok(m.limitMs > 15 * MIN);
});

test('#1566 a FAILED tick (verification fails) prunes NOTHING: every retained copy and checkpoint survives, and the monitor age keeps growing from the last good copy', { skip: SKIP }, async () => {
  const { tmp, ckpt, store, e } = await realExecutor();
  const dest = path.join(tmp, 'dest-fail'); fs.mkdirSync(dest);
  const now = Date.parse('2026-10-04T12:00:00Z');
  const a = fakeCopy(dest, now - 5 * H), b = fakeCopy(dest, now - 5 * H + 15 * MIN), good = fakeCopy(dest, now - 15 * MIN);
  const oldPartial = fakeCopy(dest, now - 6 * H, '.partial');
  fs.mkdirSync(ckpt, { recursive: true });
  for (let i = 0; i < 10; i++) fakeCheckpoint(ckpt, `20190101T0000${String(i).padStart(2, '0')}Z-1-000`);
  const ckBefore = fs.readdirSync(ckpt).sort();
  const failPy = path.join(tmp, 'fail-python.sh');
  fs.writeFileSync(failPy, '#!/bin/sh\necho "injected verifier failure" >&2\nexit 7\n', { mode: 0o755 });
  const r = await runTick(['--url', e.base, '--dest', dest, '--now', new Date(now).toISOString(), '--python', failPy, '--checkpoint-dir', ckpt, '--store', store]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /PRUNE SKIPPED/);
  for (const p of [a, b, good, oldPartial]) assert.ok(fs.existsSync(p), `${p} must survive a failed tick`);
  assert.ok(fs.existsSync(path.join(dest, `graph-store-${stampOf(now)}-UNVERIFIED`)));
  for (const n of ckBefore) assert.ok(fs.existsSync(path.join(ckpt, n)), `checkpoint ${n} must survive a failed tick`);
  const m1 = monitor({ dest, nowMs: now + 1 * MIN });
  const m2 = monitor({ dest, nowMs: now + 10 * MIN });
  assert.equal(m1.newest, path.basename(good)); assert.equal(m2.newest, path.basename(good));
  assert.equal(m1.ageMs, 16 * MIN); assert.equal(m2.ageMs, 25 * MIN);
  assert.equal(m2.alert, true);
  const state = JSON.parse(fs.readFileSync(path.join(dest, 'backup-schedule-state.json'), 'utf8'));
  assert.equal(state.ticks.at(-1).ok, false);
});
