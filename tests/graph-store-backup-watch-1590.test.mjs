/**
 * #1590 — the independent backup WATCHER (detection half). Pre-registered tests, authored by
 * the separate test author BEFORE the implementation exists. The builder implements
 * scripts/graph-store-backup-watch.mjs against THIS file; if the contract below needs a change,
 * the test changes first and the change is announced on #1590.
 *
 * CONTRACT PINNED HERE (every line below is asserted somewhere)
 *
 *   node scripts/graph-store-backup-watch.mjs --dest DIR --alert-state FILE --plist-dir DIR
 *        --config FILE --status FILE [--ack-file FILE] [--now ISO]
 *   Importing the module runs nothing. It exports statusFresh(status, nowMs, watcherIntervalMs, k).
 *
 *   EXIT  0 = verdict OK · 3 = verdict ALERT (config-invalid included) · 2 = usage (a required flag
 *         missing, an unknown flag, a --now that is not an ISO time). A status that cannot be written
 *         is never exit 0.
 *   STATUS written atomically on EVERY run, healthy or not (temp file in the SAME directory, then
 *         rename): { schema: 1, checkedAt: ISO of --now, verdict: "OK"|"ALERT",
 *           observed: [{code, since, graceUntil}],         every non-OK condition seen, including inside grace
 *           causes:   [{code, detail, cause: "unknown"|"corroborated"}],
 *           episodes: [{id, openedAt, recovered, recoveredAt|null, acknowledged}],
 *           ages: {stateMin, newestCopyMin}, limits: {stateMin, copyMin, snapshotMin, source}, evidence: [...] }
 *         verdict = CURRENT detected health only. A recovered episode that is not retired is a
 *         delivery obligation and stays in `episodes` while verdict is OK.
 *   PLISTS in --plist-dir, any file name; the job is told by the script in ProgramArguments:
 *         graph-store-backup-schedule.mjs = tick · graph-store-backup-monitor.mjs or
 *         graph-store-backup-alert.mjs = monitor · graph-store-backup-watch.mjs = the watcher itself.
 *         Every interval is the plist's StartInterval (seconds). All three must be present and valid.
 *   CONFIG --config JSON { freshnessK, maxClockSkewSec, graceIntervals, stateStalenessIntervals }:
 *         all four required, finite numbers; freshnessK and stateStalenessIntervals > 0,
 *         maxClockSkewSec and graceIntervals >= 0. Anything else is ALERT `config-invalid`, never a default.
 *   LIMITS stateMin = stateStalenessIntervals x monitor interval (min)
 *          copyMin  = tick interval (min) + (checkpointMs + copyMs + verifyMs) / 60000 of the LAST
 *                     SUCCESSFUL tick in DEST/backup-schedule-state.json (the T4 derivation)
 *          snapshotMin = freshnessK x watcher interval (min)
 *          Every comparison is strict (>): a value exactly AT its limit is OK.
 *   CODES  config-invalid · state-unreadable · state-timestamp-invalid · state-verdict-invalid ·
 *          state-stale · deliverer-verdict (only this one has a grace: lastVerdict != "OK" beyond
 *          graceIntervals x monitor interval) · dest-unreadable · no-verified-copy · timing-missing ·
 *          copy-stale · future-dated (a timestamp more than maxClockSkewSec ahead of --now; a
 *          future-dated copy never masks a stale real one)
 *   CAUSE  "unknown" unless corroborated. state-stale is "corroborated" only when the copies are
 *          themselves stale or absent; with fresh verified copies it is "unknown".
 *   EPISODES  one continuous run of ALERT verdicts is ONE episode (new causes join it; it is never
 *          reopened per run). An OK run marks it recovered (recoveredAt = that run's checkedAt) and
 *          keeps it. A later ALERT after recovery is a NEW episode with a new id; the older one stays.
 *          Acknowledgment: --ack-file JSON {"acked": [ids]} read each run; it means RECEIVED, not
 *          healthy: an acknowledged episode whose condition persists stays active, not reopened and
 *          not re-opened. An episode is retired only when it is BOTH recovered AND acknowledged (in the
 *          run that observes both). Acknowledgment is sticky (an id that later leaves the ack file
 *          stays acknowledged); unknown ids and a missing/corrupt ack file are ignored.
 *   NON-OK SINCE  observed[].since is the watcher's OWN first observation, carried from its previous
 *          --status; with no readable previous status it restarts at this run's --now. Never earlier
 *          than the first run that saw it, never taken from the deliverer's lastRunAt.
 *          observed[].earlierDurationUnknown is a boolean on every entry: true exactly when this run had
 *          NO readable previous status (so how long the condition already lasted is explicitly UNKNOWN,
 *          not "newly healthy"), false when since was carried from a readable previous status.
 *   TIMESTAMPS  a timestamp is valid only if it is a string in full ISO form (YYYY-MM-DDTHH:MM:SS with
 *          optional fraction, then Z or a +-HH:MM offset) whose CALENDAR fields are real: 2026-02-31,
 *          2026-13-01, 2025-02-29 are INVALID although V8's Date.parse normalises some of them.
 *          This applies to lastRunAt, to status.checkedAt in statusFresh and to carried bookkeeping.
 *   ATOMICITY  env WATCH_TEST_BARRIER=<fifo path>: after the complete new snapshot is written to a
 *          temp file in the status directory and BEFORE the rename, the watcher opens and reads the
 *          fifo (blocking). Nothing else is gated by it.
 *   INDEPENDENCE  the watcher makes no net/http/https/dns/fetch call, whatever env it is given.
 *
 * statusFresh(status, nowMs, watcherIntervalMs, k): true only when status.checkedAt is a valid ISO time
 *   that is not in the future and is at most k x watcherIntervalMs old (exactly at the limit is fresh).
 *   A missing/non-object status, a missing, invalid or future checkedAt, or a non-positive or
 *   non-finite interval or k is NOT fresh. It never throws.
 *
 * LIMITS OF THESE TESTS (they stay attached to any result): they test detection LOGIC and the status
 * file, with an injected clock, on fabricated fixtures. They do not test launchd, a real consumer's
 * cadence, text delivery, or power-loss survival.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.WATCH_SCRIPT || path.join(HERE, '..', 'scripts', 'graph-store-backup-watch.mjs');
const PLIST_MOD = process.env.WATCH_PLIST_MODULE || path.join(HERE, '..', 'scripts', 'graph-store-backup-plist.mjs');
const { renderPlist } = await import(pathToFileURL(PLIST_MOD).href);
let mod = null, modErr = null;
try { mod = await import(pathToFileURL(SCRIPT).href); } catch (e) { modErr = e; }

const MIN = 60_000, SEC = 1000;
const NOW = Date.parse('2026-10-04T20:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const stampOf = (ms) => iso(ms).replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const CFG = { freshnessK: 3, maxClockSkewSec: 60, graceIntervals: 1, stateStalenessIntervals: 3 };
// tick 900 s, monitor 300 s, watcher 300 s; one successful tick recorded 600+1800+600 ms
//   => stateMin 15, copyMin 15 + 3000/60000 = 15.05 (= 903 s), snapshotMin 15
const STATE_LIMIT_S = 900, COPY_LIMIT_S = 903;

function writeCopy(dest, stamp, kind = 'verified') {
  const name = kind === 'partial' ? `graph-store-${stamp}.partial` : kind === 'unverified' ? `graph-store-${stamp}-UNVERIFIED` : `graph-store-${stamp}`;
  const d = path.join(dest, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'CURRENT'), 'MANIFEST-000001\n');
  const files = [{ name: 'CURRENT', size: 16 }];
  if (kind === 'incomplete') files.push({ name: 'MISSING-FILE', size: 5 });
  fs.writeFileSync(path.join(d, 'backup-manifest.json'), JSON.stringify({ files }));
}
function plistFor(job, interval, dir, file) {
  const base = { dest: '/tmp/dest', url: 'http://127.0.0.1:9', code: '/tmp/code', node: '/usr/bin/node', home: '/tmp/home', interval };
  if (job === 'watch') {
    fs.writeFileSync(path.join(dir, file), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>com.scrumboard.graph-store-backup-watch</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/node</string>
    <string>/tmp/code/scripts/graph-store-backup-watch.mjs</string>
    <string>--dest</string>
    <string>/tmp/dest</string>
  </array>
  <key>StartInterval</key>
  <integer>${interval}</integer>
</dict>
</plist>
`);
  } else fs.writeFileSync(path.join(dir, file), renderPlist({ job, ...base }));
}

/** A complete fixture. Every field can be overridden; the defaults are the HEALTHY twin at NOW. */
function fx(o = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch1590-'));
  const f = { root, dest: path.join(root, 'dest'), plists: path.join(root, 'plists'), alertState: path.join(root, 'alert-state.json'),
    config: path.join(root, 'config.json'), statusDir: path.join(root, 'status'), ack: path.join(root, 'ack.json') };
  f.status = path.join(f.statusDir, 'status.json');
  fs.mkdirSync(f.dest); fs.mkdirSync(f.plists); fs.mkdirSync(f.statusDir);
  const iv = { tick: 900, monitor: 300, watch: 300, ...(o.intervals || {}) };
  // a nonsensical interval is patched into the file by the test that wants it; the renderer refuses to write one
  for (const j of ['tick', 'monitor', 'watch']) if (iv[j] !== null) plistFor(j, iv[j] >= 1 ? iv[j] : 900, f.plists, `${j}.plist`);
  if (o.config !== null) fs.writeFileSync(f.config, JSON.stringify({ ...CFG, ...(o.config || {}) }));
  for (const c of (o.copies ?? [NOW - 2 * MIN])) writeCopy(f.dest, stampOf(c));
  if (o.schedule !== null) {
    fs.writeFileSync(path.join(f.dest, 'backup-schedule-state.json'), JSON.stringify(o.schedule ?? { ticks: [
      { at: iso(NOW - 2 * MIN), ok: true, timings: { checkpointMs: 600, copyMs: 1800, verifyMs: 600 } }] }));
  }
  if (o.alertState !== null) {
    fs.writeFileSync(f.alertState, typeof o.alertState === 'string' ? o.alertState
      : JSON.stringify({ episode: null, pending: [], lastRunAt: iso(NOW - MIN), lastVerdict: 'OK', ...(o.alertState || {}) }));
  }
  return f;
}
const setState = (f, s) => fs.writeFileSync(f.alertState, JSON.stringify({ episode: null, pending: [], lastRunAt: iso(NOW - MIN), lastVerdict: 'OK', ...s }));
function setCopies(f, stamps) {
  for (const n of fs.readdirSync(f.dest)) if (n.startsWith('graph-store-')) fs.rmSync(path.join(f.dest, n), { recursive: true, force: true });
  for (const s of stamps) writeCopy(f.dest, stampOf(s));
}
const setAck = (f, ids) => fs.writeFileSync(f.ack, JSON.stringify({ acked: ids }));
const readStatus = (f) => { try { return JSON.parse(fs.readFileSync(f.status, 'utf8')); } catch { return null; } };

function argv(f, nowMs, { omit = [], extra = [] } = {}) {
  const pairs = { '--dest': f.dest, '--alert-state': f.alertState, '--plist-dir': f.plists, '--config': f.config, '--status': f.status, '--ack-file': f.ack };
  const a = [];
  for (const [k, v] of Object.entries(pairs)) if (!omit.includes(k)) a.push(k, v);
  if (nowMs !== null && !omit.includes('--now')) a.push('--now', iso(nowMs));
  return [...a, ...extra];
}
function run(f, nowMs, { env = {}, omit = [], extra = [], timeout = 8000 } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...argv(f, nowMs, { omit, extra })], { encoding: 'utf8', timeout, env: { ...process.env, ...env } });
  return { code: r.status, signal: r.signal, out: r.stdout, err: r.stderr, status: readStatus(f) };
}
const codes = (st) => (st?.causes ?? []).map((c) => c.code).sort();
function ok(r, why = '') {
  assert.equal(r.code, 0, `exit 0 expected${why}; got ${r.code} ${r.err}${JSON.stringify(r.status?.causes)}`);
  assert.equal(r.status?.verdict, 'OK', why);
  assert.deepEqual(codes(r.status), [], why);
}
function alert(r, code, why = '') {
  assert.equal(r.code, 3, `exit 3 expected${why}; got ${r.code} ${r.err}`);
  assert.equal(r.status?.verdict, 'ALERT', why);
  assert.ok(codes(r.status).includes(code), `cause ${code} expected${why}; got ${JSON.stringify(codes(r.status))}`);
}
const causeOf = (st, code) => st.causes.find((c) => c.code === code)?.cause;

test('module: importing the watcher runs nothing and exports statusFresh', () => {
  assert.equal(modErr, null, `the module must import cleanly: ${modErr}`);
  assert.equal(typeof mod.statusFresh, 'function');
});

// ---------------------------------------------------------------- 1. the healthy twin
test('C1 healthy twin: exit 0, OK, the full snapshot shape, limits derived from the plists and the last tick', () => {
  const f = fx();
  const r = run(f, NOW);
  ok(r);
  const s = r.status;
  assert.equal(s.schema, 1);
  assert.equal(s.checkedAt, iso(NOW));
  assert.deepEqual(s.observed, []);
  assert.deepEqual(s.episodes, []);
  assert.ok(Array.isArray(s.evidence));
  assert.ok(Math.abs(s.ages.stateMin - 1) < 1e-9, `stateMin ${s.ages.stateMin}`);
  assert.ok(Math.abs(s.ages.newestCopyMin - 2) < 1e-9, `newestCopyMin ${s.ages.newestCopyMin}`);
  assert.equal(s.limits.stateMin, 15);
  assert.ok(Math.abs(s.limits.copyMin - 15.05) < 1e-9, `copyMin ${s.limits.copyMin}`);
  assert.equal(s.limits.snapshotMin, 15);
  assert.equal(typeof s.limits.source, 'string');
});

test('C1b the snapshot is written on EVERY run: a second healthy run replaces checkedAt', () => {
  const f = fx();
  ok(run(f, NOW));
  setState(f, { lastRunAt: iso(NOW + 4 * MIN) });
  setCopies(f, [NOW + 3 * MIN]);
  const r = run(f, NOW + 5 * MIN);
  ok(r);
  assert.equal(r.status.checkedAt, iso(NOW + 5 * MIN));
});

test('C1c without --now the watcher reads the real clock', () => {
  const real = Date.now();
  const f = fx({ copies: [real - 2 * MIN], schedule: { ticks: [{ at: iso(real), ok: true, timings: { checkpointMs: 600, copyMs: 1800, verifyMs: 600 } }] },
    alertState: { lastRunAt: iso(real - MIN) } });
  const r = run(f, null);
  ok(r, ' (real clock)');
  assert.ok(Math.abs(Date.parse(r.status.checkedAt) - real) < 20 * SEC, r.status.checkedAt);
});

// ---------------------------------------------------------------- 2. stale or malformed deliverer state
for (const [label, content] of [['missing', null], ['unparseable', '{not json'], ['empty', ''], ['a JSON array', '[]'], ['JSON null', 'null'], ['a JSON string', '"x"']]) {
  test(`C2 deliverer state ${label}: ALERT state-unreadable (twin: the same fixture with a good state is OK)`, () => {
    ok(run(fx(), NOW), ' twin');
    const f = fx({ alertState: null });
    if (content !== null) fs.writeFileSync(f.alertState, content);
    alert(run(f, NOW), 'state-unreadable');
  });
}

// ---------------------------------------------------------------- 3. lastRunAt age, the boundary, and the cause
test('C3 lastRunAt exactly at k x monitor interval is OK; one second beyond is ALERT state-stale, cause UNKNOWN while the copies are fresh', () => {
  const f = fx({ alertState: { lastRunAt: iso(NOW - STATE_LIMIT_S * SEC) } });
  ok(run(f, NOW), ' at the limit');
  setState(f, { lastRunAt: iso(NOW - (STATE_LIMIT_S + 1) * SEC) });
  const r = run(f, NOW);
  alert(r, 'state-stale');
  assert.equal(causeOf(r.status, 'state-stale'), 'unknown');
  assert.deepEqual(codes(r.status), ['state-stale'], 'nothing else is wrong in this fixture');
});

test('C3b state-stale becomes CORROBORATED only when the copies are stale too', () => {
  const f = fx({ copies: [NOW - 60 * MIN], alertState: { lastRunAt: iso(NOW - 30 * MIN) } });
  const r = run(f, NOW);
  alert(r, 'state-stale');
  alert(r, 'copy-stale');
  assert.equal(causeOf(r.status, 'state-stale'), 'corroborated');
});

// ---------------------------------------------------------------- 4. an invalid timestamp is NOT OK
for (const [label, v] of [['missing', undefined], ['null', null], ['an empty string', ''], ['garbage', 'yesterday-ish'], ['a number', 1759608000000], ['an object', {}],
  ['an impossible day (Feb 31)', '2026-02-31T10:00:00Z'], ['an impossible month', '2026-13-01T00:00:00Z'], ['Apr 31', '2026-04-31T00:00:00Z'],
  ['Feb 29 in a non-leap year', '2025-02-29T00:00:00Z'], ['an hour of 25', '2026-10-04T25:00:00Z'], ['date only', '2026-10-04']]) {
  test(`C4 invalid lastRunAt (${label}) is ALERT state-timestamp-invalid`, () => {
    const f = fx();
    const s = { episode: null, pending: [], lastVerdict: 'OK' };
    if (v !== undefined) s.lastRunAt = v;
    fs.writeFileSync(f.alertState, JSON.stringify(s));
    const r = run(f, NOW);
    alert(r, 'state-timestamp-invalid');
    assert.equal(r.status.ages.stateMin, null, 'no age is invented for an unreadable timestamp');
  });
}
test('C4a twin: a calendar-VALID leap day and an offset form are accepted (the rows above are not rejected for being unusual)', () => {
  const f = fx({ alertState: { lastRunAt: '2026-10-04T14:59:00-05:00' } });     // = 19:59:00Z, one minute old at NOW
  ok(run(f, NOW));
  const g = fx();
  const leap = Date.parse('2024-02-29T12:00:00Z');
  const r = run(fx({ alertState: { lastRunAt: '2024-02-29T11:59:00.000Z' }, copies: [leap - 2 * MIN],
    schedule: { ticks: [{ at: '2024-02-29T11:00:00Z', ok: true, timings: { checkpointMs: 600, copyMs: 1800, verifyMs: 600 } }] } }), leap);
  ok(r, ' (Feb 29 2024 exists)');
  assert.ok(g);
});
for (const [label, v] of [['missing', undefined], ['null', null], ['a number', 0], ['an empty string', '']]) {
  test(`C4b invalid lastVerdict (${label}) is ALERT state-verdict-invalid`, () => {
    const f = fx();
    const s = { episode: null, pending: [], lastRunAt: iso(NOW - MIN) };
    if (v !== undefined) s.lastVerdict = v;
    fs.writeFileSync(f.alertState, JSON.stringify(s));
    alert(run(f, NOW), 'state-verdict-invalid');
  });
}

// ---------------------------------------------------------------- 5. copies: stale, boundary, which copies count
test('C5 newest verified copy exactly at copyMin is OK; one second beyond is ALERT copy-stale (strict >)', () => {
  ok(run(fx({ copies: [NOW - COPY_LIMIT_S * SEC] }), NOW), ' at the limit');
  const r = run(fx({ copies: [NOW - (COPY_LIMIT_S + 1) * SEC] }), NOW);
  alert(r, 'copy-stale');
  assert.deepEqual(codes(r.status), ['copy-stale']);
});

test('C5b a newer copy that is .partial, -UNVERIFIED or incomplete never counts as the newest verified copy', () => {
  for (const kind of ['partial', 'unverified', 'incomplete']) {
    const f = fx({ copies: [NOW - 60 * MIN] });
    writeCopy(f.dest, stampOf(NOW - MIN), kind);
    alert(run(f, NOW), 'copy-stale', ` (${kind} must not refresh the age)`);
  }
  const f = fx({ copies: [NOW - 2 * MIN] });          // twin: a fresh verified copy beside an unverified one is OK
  writeCopy(f.dest, stampOf(NOW - MIN), 'unverified');
  ok(run(f, NOW), ' twin');
});

test('C5c the newest of several verified copies decides, not the first listed', () => {
  const f = fx({ copies: [NOW - 90 * MIN, NOW - 2 * MIN, NOW - 45 * MIN] });
  ok(run(f, NOW));
  const g = fx({ copies: [NOW - 90 * MIN, NOW - 40 * MIN, NOW - 45 * MIN] });
  const r = run(g, NOW);
  alert(r, 'copy-stale');
  assert.ok(Math.abs(r.status.ages.newestCopyMin - 40) < 1e-9);
});

// ---------------------------------------------------------------- 6. no copy, no timing evidence, DEST unreadable
test('C6 no verified copy at all is ALERT no-verified-copy, never a guessed limit', () => {
  const r = run(fx({ copies: [] }), NOW);
  alert(r, 'no-verified-copy');
  assert.equal(r.status.ages.newestCopyMin, null);
});

test('C6b no successful tick with timings is ALERT timing-missing even when a copy is fresh', () => {
  const noTicks = [['no state file', null], ['empty ticks', { ticks: [] }], ['only a failed tick', { ticks: [{ at: iso(NOW), ok: false, timings: { checkpointMs: 1, copyMs: 1, verifyMs: 1 } }] }],
    ['timings not finite', { ticks: [{ at: iso(NOW), ok: true, timings: { checkpointMs: 1, copyMs: 'x', verifyMs: 1 } }] }],
    ['timings absent', { ticks: [{ at: iso(NOW), ok: true }] }]];
  for (const [label, schedule] of noTicks) {
    const f = fx({ schedule });
    if (schedule === null) fs.rmSync(path.join(f.dest, 'backup-schedule-state.json'), { force: true });
    const r = run(f, NOW);
    alert(r, 'timing-missing', ` (${label})`);
    assert.equal(r.status.limits.copyMin, null, `${label}: no copy limit is invented`);
  }
});

test('C6c the limit comes from the LAST SUCCESSFUL tick; a later failed tick (huge timings) and an earlier one do not move it', () => {
  const t = (at, ok, cp, cy, v) => ({ at: iso(at), ok, timings: { checkpointMs: cp, copyMs: cy, verifyMs: v } });
  const f = fx({ copies: [NOW - 20 * MIN], schedule: { ticks: [t(NOW - 90 * MIN, true, 0, 0, 0), t(NOW - 60 * MIN, true, 120000, 480000, 300000), t(NOW - 30 * MIN, false, 900000, 900000, 900000)] } });
  const r = run(f, NOW);
  ok(r, ' (limit 30 from the middle tick: 15 + 15)');
  assert.ok(Math.abs(r.status.limits.copyMin - 30) < 1e-9, `copyMin ${r.status.limits.copyMin}`);
});

test('C6d DEST missing or not a directory is ALERT dest-unreadable (not healthy, not a crash)', () => {
  const f = fx();
  fs.rmSync(f.dest, { recursive: true });
  alert(run(f, NOW), 'dest-unreadable');
  fs.writeFileSync(f.dest, 'a file, not a directory');
  alert(run(f, NOW), 'dest-unreadable');
});

// ---------------------------------------------------------------- 7. the copy limit, derived independently of the implementation (T4)
test('C7 copy limit = tick interval + checkpoint + copy + verify of the last good tick, recomputed here from the same inputs and checked at both sides', () => {
  for (const [tickS, cp, cy, v] of [[900, 600, 1800, 600], [900, 120000, 480000, 300000], [1800, 0, 0, 0], [600, 90000, 90000, 90000], [900, 1000, 2000, 3000]]) {
    const limitS = tickS + (cp + cy + v) / 1000;           // seconds, exact in these cases
    const sched = { ticks: [{ at: iso(NOW - MIN), ok: true, timings: { checkpointMs: cp, copyMs: cy, verifyMs: v } }] };
    const at = Math.floor(limitS);
    if (at !== limitS) continue;                            // keep every boundary on a whole second
    ok(run(fx({ intervals: { tick: tickS }, schedule: sched, copies: [NOW - limitS * SEC] }), NOW), ` at ${limitS}s`);
    alert(run(fx({ intervals: { tick: tickS }, schedule: sched, copies: [NOW - (limitS + 1) * SEC] }), NOW), 'copy-stale', ` at ${limitS + 1}s`);
  }
});

test('C7b the copy limit is NOT widened by missed ticks or an old copy: only the plist and the last good tick feed it', () => {
  const f = fx({ copies: [NOW - 16 * MIN] });            // 16 min > 15.05: stale, however many ticks "should" have run
  const r = run(f, NOW);
  alert(r, 'copy-stale');
  assert.ok(Math.abs(r.status.limits.copyMin - 15.05) < 1e-9);
});

// ---------------------------------------------------------------- 8. lastVerdict beyond a grace, and the watcher's own since
test('C8 (control 6) a non-OK lastVerdict is VISIBLE at first sight, inside the grace it is not an ALERT, beyond it is, and since is never re-based', () => {
  const f = fx({ alertState: { lastVerdict: 'STALE' } });
  const T = [NOW, NOW + 300 * SEC, NOW + 301 * SEC];
  const stamp = (t) => setState(f, { lastVerdict: 'STALE', lastRunAt: iso(t - MIN) });
  stamp(T[0]);
  const a = run(f, T[0]);
  ok(a, ' (first observation, inside grace)');
  assert.equal(a.status.observed.length, 1);
  assert.equal(a.status.observed[0].code, 'deliverer-verdict');
  assert.equal(a.status.observed[0].since, iso(T[0]));
  assert.equal(a.status.observed[0].graceUntil, iso(T[0] + 300 * SEC));
  assert.equal(a.status.observed[0].earlierDurationUnknown, true, 'no previous status: how long it already lasted is unknown');
  stamp(T[1]);
  const b = run(f, T[1]);
  ok(b, ' (exactly one monitor interval: strict >)');
  assert.equal(b.status.observed[0].since, iso(T[0]), 'carried, not re-based');
  assert.equal(b.status.observed[0].earlierDurationUnknown, false, 'carried from a readable previous status');
  stamp(T[2]);
  const c = run(f, T[2]);
  alert(c, 'deliverer-verdict');
  assert.equal(c.status.observed[0].since, iso(T[0]), 'the alert reports the watcher\'s first observation');
});

test('C8b a verdict that returns to OK clears observed, and a later recurrence starts a FRESH grace', () => {
  const f = fx({ alertState: { lastVerdict: 'NO-COPY' } });
  run(f, NOW);
  setState(f, { lastVerdict: 'OK', lastRunAt: iso(NOW + 29 * SEC) });
  const b = run(f, NOW + 30 * SEC);
  ok(b);
  assert.deepEqual(b.status.observed, []);
  setState(f, { lastVerdict: 'NO-COPY', lastRunAt: iso(NOW + 399 * SEC) });
  const c = run(f, NOW + 400 * SEC);
  ok(c, ' (a fresh grace, however long ago the first sighting was)');
  assert.equal(c.status.observed[0].since, iso(NOW + 400 * SEC));
  assert.equal(c.status.observed[0].earlierDurationUnknown, false, 'the previous status was readable and showed OK: this IS the first sight');
});

test('C8c (no invented duration) with no readable previous status, since restarts at THIS run; it is never taken from the deliverer\'s lastRunAt or earlier', () => {
  for (const wreck of ['absent', 'corrupt', 'empty']) {
    const f = fx({ alertState: { lastVerdict: 'STALE', lastRunAt: iso(NOW - 14 * MIN) } });   // the deliverer's own stamp is 14 min old
    if (wreck === 'corrupt') fs.writeFileSync(f.status, '{"schema":1,"checkedAt"');
    if (wreck === 'empty') fs.writeFileSync(f.status, '');
    const r = run(f, NOW);
    assert.equal(r.status.observed[0].since, iso(NOW), `${wreck}: since must be this run, got ${r.status.observed[0].since}`);
    assert.equal(r.status.observed[0].earlierDurationUnknown, true, `${wreck}: the earlier duration must be reported UNKNOWN, not silently healthy`);
    assert.equal(r.status.verdict, 'OK');
    ok(r, ` (${wreck}: the grace restarts, no duration is invented)`);
  }
});

test('C8d carried bookkeeping with an impossible-date since is not trusted: since restarts at this run and the earlier duration is UNKNOWN', () => {
  const f = fx({ alertState: { lastVerdict: 'STALE' } });
  fs.writeFileSync(f.status, JSON.stringify({ schema: 1, checkedAt: iso(NOW - MIN), verdict: 'OK', observed: [{ code: 'deliverer-verdict', since: '2026-02-31T10:00:00Z', graceUntil: '2026-02-31T10:05:00Z' }], causes: [], episodes: [] }));
  const r = run(f, NOW);
  assert.equal(r.status.observed[0].since, iso(NOW));
  assert.equal(r.status.observed[0].earlierDurationUnknown, true);
});

// ---------------------------------------------------------------- 9. episodes, acknowledgment, recovery, recurrence
const ep = (st) => st.episodes;
test('C9 (control 9) one continuous alert is ONE episode; recovery keeps it; a recurrence is a NEW episode and never overwrites it', () => {
  const f = fx({ copies: [NOW - 60 * MIN] });
  const a = run(f, NOW);
  alert(a, 'copy-stale');
  assert.equal(ep(a.status).length, 1);
  const e1 = ep(a.status)[0];
  assert.equal(typeof e1.id, 'string'); assert.ok(e1.id.length > 0);
  assert.equal(e1.openedAt, iso(NOW));
  assert.equal(e1.recovered, false); assert.equal(e1.recoveredAt, null); assert.equal(e1.acknowledged, false);

  const b = run(f, NOW + MIN);                                     // same condition later: same episode, not reopened
  assert.equal(ep(b.status).length, 1);
  assert.equal(ep(b.status)[0].id, e1.id);
  assert.equal(ep(b.status)[0].openedAt, iso(NOW));

  setState(f, { lastRunAt: iso(NOW - 30 * MIN) });                 // a new cause during the open episode joins it
  const b2 = run(f, NOW + 2 * MIN);
  alert(b2, 'state-stale');
  assert.equal(ep(b2.status).length, 1, 'a new cause joins the open episode');
  assert.equal(ep(b2.status)[0].id, e1.id);

  setState(f, { lastRunAt: iso(NOW + 2 * MIN) }); setCopies(f, [NOW + 3 * MIN]);
  const c = run(f, NOW + 4 * MIN);                                 // recovery BEFORE acknowledgment
  ok(c, ' (verdict describes current health)');
  assert.equal(ep(c.status).length, 1, 'the recovered, unacknowledged episode is still an obligation');
  assert.equal(ep(c.status)[0].id, e1.id);
  assert.equal(ep(c.status)[0].recovered, true);
  assert.equal(ep(c.status)[0].recoveredAt, iso(NOW + 4 * MIN));
  assert.equal(ep(c.status)[0].acknowledged, false);

  setCopies(f, [NOW - 60 * MIN]);                                  // a distinct incident: new id, the old one untouched
  const d = run(f, NOW + 5 * MIN);
  alert(d, 'copy-stale');
  assert.equal(ep(d.status).length, 2);
  const old = ep(d.status).find((e) => e.id === e1.id);
  const fresh = ep(d.status).find((e) => e.id !== e1.id);
  assert.equal(old.recovered, true); assert.equal(old.recoveredAt, iso(NOW + 4 * MIN)); assert.equal(old.acknowledged, false);
  assert.equal(fresh.recovered, false); assert.equal(fresh.openedAt, iso(NOW + 5 * MIN));
});

test('C9b acknowledgment names an exact id: it closes only that episode, and only when it is also recovered', () => {
  const f = fx({ copies: [NOW - 60 * MIN] });
  const e1 = ep(run(f, NOW).status)[0];
  setCopies(f, [NOW + MIN]); setState(f, { lastRunAt: iso(NOW + MIN) });
  run(f, NOW + 2 * MIN);                                           // e1 recovered
  setCopies(f, [NOW - 60 * MIN]);
  const e2 = ep(run(f, NOW + 3 * MIN).status).find((e) => e.id !== e1.id);

  setAck(f, ['not-an-episode-id']);                                // an unknown id changes nothing
  const x = run(f, NOW + 4 * MIN);
  assert.equal(ep(x.status).length, 2);
  assert.ok(ep(x.status).every((e) => e.acknowledged === false));

  setAck(f, [e1.id]);
  const y = run(f, NOW + 5 * MIN);
  assert.deepEqual(ep(y.status).map((e) => e.id), [e2.id], 'e1 was recovered AND acknowledged: retired; e2 untouched');
  assert.equal(ep(y.status)[0].acknowledged, false);
});

test('C9c an ACKNOWLEDGED episode whose condition persists stays active: not retired, not reopened, not duplicated, acknowledged is sticky', () => {
  const f = fx({ copies: [NOW - 60 * MIN] });
  const e = ep(run(f, NOW).status)[0];
  setAck(f, [e.id]);
  for (let i = 1; i <= 3; i++) {
    if (i === 3) setAck(f, []);                                    // the consumer later empties its file: still acknowledged
    const r = run(f, NOW + i * MIN);
    alert(r, 'copy-stale');
    assert.equal(ep(r.status).length, 1, `run ${i}: one episode`);
    assert.equal(ep(r.status)[0].id, e.id, `run ${i}: the same id`);
    assert.equal(ep(r.status)[0].acknowledged, true, `run ${i}: acknowledged stays true`);
    assert.equal(ep(r.status)[0].recovered, false);
  }
});

test('C9d an acknowledged episode is retired when it recovers; a recurrence after that is a NEW id', () => {
  const f = fx({ copies: [NOW - 60 * MIN] });
  const e = ep(run(f, NOW).status)[0];
  setAck(f, [e.id]);
  run(f, NOW + MIN);
  setCopies(f, [NOW + 2 * MIN]); setState(f, { lastRunAt: iso(NOW + 2 * MIN) });
  const r = run(f, NOW + 3 * MIN);
  ok(r);
  assert.deepEqual(ep(r.status), [], 'recovered AND acknowledged: retired');
  setCopies(f, [NOW - 60 * MIN]);
  const again = run(f, NOW + 4 * MIN);
  alert(again, 'copy-stale');
  assert.equal(ep(again.status).length, 1);
  assert.notEqual(ep(again.status)[0].id, e.id, 'a recurrence never reuses the retired id');
});

test('C9e an ack file that is missing, corrupt, the wrong shape or full of non-strings acknowledges nothing and does not crash the watcher', () => {
  const f = fx({ copies: [NOW - 60 * MIN] });
  const e = ep(run(f, NOW).status)[0];
  for (const [label, content] of [['missing', null], ['corrupt', '{"acked":['], ['an array', `["${e.id}"]`], ['acked not a list', `{"acked":"${e.id}"}`], ['non-string ids', '{"acked":[1,null,{}]}']]) {
    fs.rmSync(f.ack, { force: true });
    if (content !== null) fs.writeFileSync(f.ack, content);
    const r = run(f, NOW + MIN);
    alert(r, 'copy-stale', ` (${label})`);
    assert.equal(ep(r.status)[0].acknowledged, false, label);
  }
  const g = fx({ copies: [NOW - 60 * MIN] });
  const eg = ep(run(g, NOW).status)[0];
  const r = run(g, NOW + MIN, { omit: ['--ack-file'] });          // the flag itself is optional
  assert.equal(r.code, 3);
  assert.equal(ep(r.status)[0].id, eg.id);
});

// ---------------------------------------------------------------- 10. watcher death is visible (statusFresh)
test('C10 (control 10) statusFresh: fresh up to k x the watcher interval inclusive, stale one millisecond later', () => {
  const st = { schema: 1, checkedAt: iso(NOW), verdict: 'OK' };
  assert.equal(mod.statusFresh(st, NOW, 300_000, 3), true);
  assert.equal(mod.statusFresh(st, NOW + 15 * MIN, 300_000, 3), true, 'exactly at the limit');
  assert.equal(mod.statusFresh(st, NOW + 15 * MIN + 1, 300_000, 3), false);
  assert.equal(mod.statusFresh(st, NOW + 10 * MIN, 300_000, 2), true, 'k = 2: exactly 10 min is fresh');
  assert.equal(mod.statusFresh(st, NOW + 10 * MIN + 1, 300_000, 2), false, 'k is respected');
});

test('C10b statusFresh fails CLOSED on a missing, non-object, invalid or future checkedAt and on a bad interval or k, and never throws', () => {
  const good = { checkedAt: iso(NOW) };
  for (const bad of [undefined, null, 'x', 7, [], {}, { checkedAt: null }, { checkedAt: '' }, { checkedAt: 'soon' }, { checkedAt: NOW }, { checkedAt: '2026-02-31T10:00:00Z' }, { checkedAt: '2026-13-01T00:00:00Z' }, { checkedAt: '2025-02-29T00:00:00Z' },
    { checkedAt: iso(NOW + 1) } /* in the future */, { checkedAt: iso(NOW + 3600_000) }]) {
    assert.equal(mod.statusFresh(bad, NOW, 300_000, 3), false, JSON.stringify(bad));
  }
  for (const [iv, k] of [[0, 3], [-1, 3], [NaN, 3], [Infinity, 3], ['300000', 3], [300_000, 0], [300_000, -2], [300_000, NaN], [300_000, Infinity], [300_000, undefined]]) {
    assert.equal(mod.statusFresh(good, NOW, iv, k), false, `interval ${iv} k ${k}`);
  }
  assert.equal(mod.statusFresh(good, NaN, 300_000, 3), false, 'an invalid "now" is not fresh');
});

test('C10b2 statusFresh rejects an impossible calendar date even when a lenient parser would call it FRESH (twin: the real date at the same clock is fresh)', () => {
  const now = Date.parse('2026-03-03T10:01:00Z');
  assert.equal(mod.statusFresh({ checkedAt: '2026-03-03T10:00:00Z' }, now, 300_000, 3), true, 'twin');
  for (const bad of ['2026-02-31T10:00:00Z', '2026-02-30T10:00:00Z']) {          // V8 normalises both to 2026-03-03 / 03-02: one minute before now
    assert.equal(mod.statusFresh({ checkedAt: bad }, now, 300_000, 3), false, bad);
  }
  const now2 = Date.parse('2025-03-01T10:01:00Z');                                  // 2025-02-29 normalises to 2025-03-01
  assert.equal(mod.statusFresh({ checkedAt: '2025-03-01T10:00:00Z' }, now2, 300_000, 3), true, 'twin');
  assert.equal(mod.statusFresh({ checkedAt: '2025-02-29T10:00:00Z' }, now2, 300_000, 3), false);
});

test('C10c WATCHER DEATH: the last status says OK and nothing alerts, yet the consumer\'s freshness check turns false within the documented limit', () => {
  const f = fx();
  const r = run(f, NOW);
  ok(r);
  const st = readStatus(f);
  assert.equal(st.verdict, 'OK', 'a dead watcher\'s last words are healthy: only freshness can reveal it');
  const limitMs = st.limits.snapshotMin * MIN;
  assert.equal(limitMs, 15 * MIN);
  assert.equal(mod.statusFresh(st, NOW + limitMs, 300_000, 3), true, 'still alive at the limit');
  assert.equal(mod.statusFresh(st, NOW + limitMs + SEC, 300_000, 3), false, 'the watcher has stopped: nothing else changed, the status is stale');
  // and the documented limit follows the watcher's OWN plist and the configured k, not a constant
  const g = fx({ intervals: { watch: 600 }, config: { freshnessK: 5 } });
  assert.equal(run(g, NOW).status.limits.snapshotMin, 50);
});

// ---------------------------------------------------------------- 11. atomic write: a REAL SIGKILL at a deterministic barrier
async function atBarrier(f, nowMs, fifo) {
  spawnSync('mkfifo', [fifo]);
  const child = spawn(process.execPath, [SCRIPT, ...argv(f, nowMs)], { env: { ...process.env, WATCH_TEST_BARRIER: fifo }, stdio: 'ignore' });
  const exited = new Promise((res) => child.on('exit', (code, signal) => res({ code, signal })));
  let timer, fh = null, reached = false;
  const timeout = new Promise((res) => { timer = setTimeout(() => res('timeout'), 8000); });
  const opened = fsp.open(fifo, 'w').then((h) => { fh = h; return 'open'; });
  const first = await Promise.race([opened, timeout, exited.then(() => 'exited')]);
  clearTimeout(timer);
  reached = first === 'open';
  return { child, exited, fh, reached, first, release: () => { try { fs.closeSync(fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)); } catch { /* nothing waits */ } } };
}

test('C11 (control 11) SIGKILL at the barrier: the PREVIOUS snapshot is byte-identical and parseable, the new one was complete in a temp file in the same directory, and the next run recovers', async () => {
  const f = fx();
  ok(run(f, NOW));
  const before = fs.readFileSync(f.status);
  const T2 = NOW + 5 * MIN;
  setState(f, { lastRunAt: iso(T2 - MIN) }); setCopies(f, [T2 - MIN]);
  const b = await atBarrier(f, T2, path.join(f.root, 'barrier.fifo'));
  try {
    assert.equal(b.reached, true, `the watcher never reached the barrier (${b.first})`);
    assert.deepEqual(fs.readFileSync(f.status), before, 'while the writer is blocked, the published snapshot is untouched');
    const temps = fs.readdirSync(f.statusDir).filter((n) => n !== 'status.json');
    const complete = temps.filter((n) => { try { const j = JSON.parse(fs.readFileSync(path.join(f.statusDir, n), 'utf8')); return j.schema === 1 && j.checkedAt === iso(T2); } catch { return false; } });
    assert.equal(complete.length, 1, `the new snapshot must be fully written to ONE temp file beside the status file before the rename; found ${JSON.stringify(temps)}`);
    b.child.kill('SIGKILL');
    const ex = await b.exited;
    assert.equal(ex.signal, 'SIGKILL', 'a real kill, not an exit');
  } finally { try { await b.fh?.close(); } catch { /* ignore */ } b.release(); try { b.child.kill('SIGKILL'); } catch { /* gone */ } }
  assert.deepEqual(fs.readFileSync(f.status), before, 'after the kill: the previous snapshot is byte-identical');
  assert.equal(JSON.parse(fs.readFileSync(f.status, 'utf8')).checkedAt, iso(NOW));
  const again = run(f, T2 + MIN);                                  // leftover temp file must not poison the next run
  setCopies(f, [T2]);
  const r = run(f, T2 + 2 * MIN);
  ok(r);
  assert.equal(r.status.checkedAt, iso(T2 + 2 * MIN));
  assert.ok(again.status, 'the run after the kill produced a valid snapshot');
});

test('C11b SIGKILL at the barrier on the FIRST run: no status file appears, never a partial one', async () => {
  const f = fx();
  const b = await atBarrier(f, NOW, path.join(f.root, 'barrier.fifo'));
  try {
    assert.equal(b.reached, true, `the watcher never reached the barrier (${b.first})`);
    assert.equal(fs.existsSync(f.status), false, 'nothing is published before the rename');
    b.child.kill('SIGKILL');
    assert.equal((await b.exited).signal, 'SIGKILL');
  } finally { try { await b.fh?.close(); } catch { /* ignore */ } b.release(); try { b.child.kill('SIGKILL'); } catch { /* gone */ } }
  assert.equal(fs.existsSync(f.status), false);
  ok(run(f, NOW + MIN));
});

test('C11c a status that cannot be written is never exit 0', () => {
  const f = fx();
  const blocked = path.join(f.root, 'a-file');
  fs.writeFileSync(blocked, 'x');
  const r = spawnSync(process.execPath, [SCRIPT, ...argv(f, NOW).map((v) => (v === f.status ? path.join(blocked, 'status.json') : v))], { encoding: 'utf8', timeout: 8000 });
  assert.notEqual(r.status, 0);
});

// ---------------------------------------------------------------- 12. nothing hardcoded; config and plists must be valid
test('C12 (control 12) every limit follows the plist intervals and the config: changing an input moves the boundary, a hardcoded number cannot pass', () => {
  // monitor 600 s x 2 intervals => stateMin 20 (1200 s)
  const f = fx({ intervals: { monitor: 600 }, config: { stateStalenessIntervals: 2 }, alertState: { lastRunAt: iso(NOW - 1200 * SEC) } });
  const a = run(f, NOW); ok(a);
  assert.equal(a.status.limits.stateMin, 20);
  setState(f, { lastRunAt: iso(NOW - 1201 * SEC) });
  alert(run(f, NOW), 'state-stale');
  // the default fixture (900 s) must have flagged the same 1200 s age: the two boundaries differ
  alert(run(fx({ alertState: { lastRunAt: iso(NOW - 1200 * SEC) } }), NOW), 'state-stale');
  // tick 1800 s moves copyMin to 30.05 (1803 s)
  ok(run(fx({ intervals: { tick: 1800 }, copies: [NOW - 1803 * SEC] }), NOW));
  alert(run(fx({ intervals: { tick: 1800 }, copies: [NOW - 1804 * SEC] }), NOW), 'copy-stale');
  // grace follows graceIntervals x monitor interval
  const g = fx({ intervals: { monitor: 600 }, config: { graceIntervals: 2 }, alertState: { lastVerdict: 'STALE' } });
  run(g, NOW);
  const fresh = (t) => { setState(g, { lastVerdict: 'STALE', lastRunAt: iso(t - SEC) }); setCopies(g, [t - SEC]); };
  fresh(NOW + 1200 * SEC);
  ok(run(g, NOW + 1200 * SEC), ' (grace 2 x 600 s)');
  fresh(NOW + 1201 * SEC);
  alert(run(g, NOW + 1201 * SEC), 'deliverer-verdict');
});

test('C12b the plist is read as XML, not by one line shape: a multi-line StartInterval and a different file name work', () => {
  const f = fx({ intervals: { monitor: null } });
  fs.writeFileSync(path.join(f.plists, 'whatever-name.plist'), `<?xml version="1.0"?>
<plist version="1.0"><dict>
<key>ProgramArguments</key><array><string>/usr/bin/node</string><string>/x/scripts/graph-store-backup-alert.mjs</string><string>--dest</string><string>/d</string></array>
<key>StartInterval</key>

   <integer>600</integer>
</dict></plist>`);
  const r = run(f, NOW);
  ok(r);
  assert.equal(r.status.limits.stateMin, 30, '3 x 600 s');
});

const BAD_CONFIGS = [
  ['missing file', null], ['malformed JSON', '{"freshnessK":'], ['not an object', '[]'], ['empty', ''],
  ['freshnessK missing', { maxClockSkewSec: 60, graceIntervals: 1, stateStalenessIntervals: 3 }],
  ['maxClockSkewSec missing', { freshnessK: 3, graceIntervals: 1, stateStalenessIntervals: 3 }],
  ['graceIntervals missing', { freshnessK: 3, maxClockSkewSec: 60, stateStalenessIntervals: 3 }],
  ['stateStalenessIntervals missing', { freshnessK: 3, maxClockSkewSec: 60, graceIntervals: 1 }],
  ['freshnessK zero', { ...CFG, freshnessK: 0 }], ['freshnessK negative', { ...CFG, freshnessK: -1 }], ['freshnessK a string', { ...CFG, freshnessK: '3' }],
  ['freshnessK null', { ...CFG, freshnessK: null }], ['stateStalenessIntervals zero', { ...CFG, stateStalenessIntervals: 0 }],
  ['maxClockSkewSec negative', { ...CFG, maxClockSkewSec: -1 }], ['graceIntervals negative', { ...CFG, graceIntervals: -0.5 }],
  ['freshnessK infinite', '{"freshnessK":1e999,"maxClockSkewSec":60,"graceIntervals":1,"stateStalenessIntervals":3}'],
];
for (const [label, cfg] of BAD_CONFIGS) {
  test(`C12c config ${label}: ALERT config-invalid, exit 3, status still written, never a permissive default (twin: valid config is OK)`, () => {
    ok(run(fx(), NOW), ' twin');
    const f = fx({ config: null });
    if (cfg !== null) fs.writeFileSync(f.config, typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
    const r = run(f, NOW);
    alert(r, 'config-invalid');
    assert.equal(r.status.schema, 1);
    assert.equal(r.status.checkedAt, iso(NOW));
  });
}
test('C12d zero is a VALID skew and a VALID grace (twin of the invalid-config rows)', () => {
  const f = fx({ config: { maxClockSkewSec: 0, graceIntervals: 0 } });
  ok(run(f, NOW));
});

const BAD_PLISTS = [
  ['tick plist missing', { tick: null }], ['monitor plist missing', { monitor: null }], ['watcher plist missing', { watch: null }],
  ['tick interval zero', { tick: 0 }], ['monitor interval negative', { monitor: -5 }], ['watcher interval zero', { watch: 0 }],
];
for (const [label, intervals] of BAD_PLISTS) {
  test(`C12e plist problem (${label}): ALERT config-invalid, never OK`, () => {
    const f = fx({ intervals });
    for (const [j, v] of Object.entries(intervals)) if (v !== null) fs.writeFileSync(path.join(f.plists, `${j}.plist`), fs.readFileSync(path.join(f.plists, `${j}.plist`), 'utf8').replace(/<integer>\d+<\/integer>/, `<integer>${v}</integer>`));
    alert(run(f, NOW), 'config-invalid');
  });
}
test('C12f plist unreadable or not a plist: ALERT config-invalid', () => {
  for (const content of ['not xml at all', '<plist><dict><key>StartInterval</key><integer>abc</integer></dict></plist>', '']) {
    const f = fx();
    fs.writeFileSync(path.join(f.plists, 'monitor.plist'), content);
    alert(run(f, NOW), 'config-invalid', ` (${JSON.stringify(content.slice(0, 20))})`);
  }
});

test('C12g usage: a missing required flag, an unknown flag or a bad --now is exit 2; --ack-file alone is optional', () => {
  const f = fx();
  for (const flag of ['--dest', '--alert-state', '--plist-dir', '--config', '--status']) assert.equal(run(f, NOW, { omit: [flag] }).code, 2, flag);
  assert.equal(run(f, NOW, { extra: ['--frobnicate'] }).code, 2);
  const bad = spawnSync(process.execPath, [SCRIPT, ...argv(f, null), '--now', 'not-a-time'], { encoding: 'utf8', timeout: 8000 });
  assert.equal(bad.status, 2);
  assert.equal(run(f, NOW, { omit: ['--ack-file'] }).code, 0);
});

// ---------------------------------------------------------------- 13. clock skew, both sides of the boundary
test('C13 (control 13) lastRunAt in the future: within maxClockSkewSec is OK, one second beyond is ALERT future-dated', () => {
  ok(run(fx({ alertState: { lastRunAt: iso(NOW + 60 * SEC) } }), NOW), ' (exactly the allowed skew)');
  const r = run(fx({ alertState: { lastRunAt: iso(NOW + 61 * SEC) } }), NOW);
  alert(r, 'future-dated');
  ok(run(fx({ config: { maxClockSkewSec: 0 }, alertState: { lastRunAt: iso(NOW) } }), NOW), ' (skew 0, not future)');
  alert(run(fx({ config: { maxClockSkewSec: 0 }, alertState: { lastRunAt: iso(NOW + SEC) } }), NOW), 'future-dated');
  alert(run(fx({ alertState: { lastRunAt: iso(NOW + 2 * 3600_000) } }), NOW), 'future-dated', ' (a far-future stamp is not "very fresh")');
});

test('C13b a copy stamp in the future: within the skew is OK, beyond it is ALERT future-dated', () => {
  ok(run(fx({ copies: [NOW + 60 * SEC] }), NOW));
  alert(run(fx({ copies: [NOW + 61 * SEC] }), NOW), 'future-dated');
});

test('C13c a future-dated copy NEVER masks a stale real one: both causes are reported', () => {
  const r = run(fx({ copies: [NOW - 60 * MIN, NOW + 10 * MIN] }), NOW);
  alert(r, 'future-dated');
  alert(r, 'copy-stale');
});

test('C13d the watcher\'s own previous status dated in the future: within the skew it is carried, beyond it is ALERT future-dated and the bookkeeping restarts at this run', () => {
  const f = fx({ alertState: { lastVerdict: 'STALE' } });
  fs.writeFileSync(f.status, JSON.stringify({ schema: 1, checkedAt: iso(NOW + 60 * SEC), verdict: 'OK', observed: [{ code: 'deliverer-verdict', since: iso(NOW + 60 * SEC), graceUntil: iso(NOW + 360 * SEC) }], causes: [], episodes: [] }));
  const a = run(f, NOW);
  assert.equal(a.status.observed[0].since, iso(NOW + 60 * SEC), 'within the skew: carried as is');
  fs.writeFileSync(f.status, JSON.stringify({ schema: 1, checkedAt: iso(NOW + 61 * SEC), verdict: 'OK', observed: [{ code: 'deliverer-verdict', since: iso(NOW + 61 * SEC), graceUntil: iso(NOW + 361 * SEC) }], causes: [], episodes: [] }));
  const b = run(f, NOW);
  alert(b, 'future-dated');
  assert.equal(b.status.observed[0].since, iso(NOW), 'a future since is not trusted');
});

// ---------------------------------------------------------------- 14. independence: no network, whatever the environment offers
const DENY = `import net from 'node:net'; import dns from 'node:dns'; import http from 'node:http'; import https from 'node:https'; import fs from 'node:fs';
const rec = (w) => { fs.appendFileSync(process.env.DENY_LOG, w + '\\n'); throw new Error('network call refused: ' + w); };
net.Socket.prototype.connect = function () { rec('net.Socket.connect'); };
net.connect = net.createConnection = () => rec('net.connect');
dns.lookup = dns.resolve = () => rec('dns');
http.request = http.get = https.request = https.get = () => rec('http');
globalThis.fetch = () => rec('fetch');
`;
test('C14 (control 14) no network attempt of any kind: a throwing preload sees none and a listening "board" sees no connection, in OK, ALERT and config-invalid runs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch1590-net-'));
  const preload = path.join(dir, 'deny-net.mjs'), log = path.join(dir, 'attempts.log');
  fs.writeFileSync(preload, DENY);
  let conns = 0;
  const srv = net.createServer((s) => { conns++; s.destroy(); });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  const keyFile = path.join(dir, 'board.key'); fs.writeFileSync(keyFile, 'sk-test-not-a-secret', { mode: 0o600 });
  const env = { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, DENY_LOG: log, SCRUM_BOARD_URL: `http://127.0.0.1:${port}`, BOARD_URL: `http://127.0.0.1:${port}`,
    MANYHANDS_URL: `http://127.0.0.1:${port}`, SCRUM_SEAT_TOKEN_FILE: keyFile };
  try {
    // the instrument is live: a process under the same preload that DOES try is recorded and refused
    const probe = spawnSync(process.execPath, ['-e', "require('node:net').connect(1,'127.0.0.1')"], { env: { ...process.env, ...env }, encoding: 'utf8' });
    assert.notEqual(probe.status, 0);
    assert.match(fs.readFileSync(log, 'utf8'), /net\./, 'the preload must record an attempt that is made');
    fs.rmSync(log, { force: true });

    const healthy = run(fx(), NOW, { env }); ok(healthy, ' (OK run under the preload)');
    const bad = run(fx({ copies: [NOW - 60 * MIN] }), NOW, { env }); alert(bad, 'copy-stale');
    const cfgBad = fx({ config: null }); const cb = run(cfgBad, NOW, { env }); alert(cb, 'config-invalid');
    // same verdicts as without the preload and the board vars: the watcher does not depend on them
    assert.deepEqual(codes(run(fx({ copies: [NOW - 60 * MIN] }), NOW).status), codes(bad.status));
    assert.equal(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', '', 'no net/http/dns/fetch call was attempted');
    assert.equal(conns, 0, 'nothing connected to the board stand-in');
  } finally { await new Promise((res) => srv.close(res)); }
});
