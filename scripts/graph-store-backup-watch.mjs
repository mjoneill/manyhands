#!/usr/bin/env node
/**
 * #1590 — the INDEPENDENT backup WATCHER (detection half). It watches the two backup jobs
 * from outside and writes ONE local status file. It sends nothing: no network, no messages,
 * no credentials. Delivering what the status says to a human is a separate consumer's job.
 *
 *   node scripts/graph-store-backup-watch.mjs --dest DIR --alert-state FILE --plist-dir DIR
 *        --config FILE --status FILE [--ack-file FILE] [--now ISO]
 *
 * The contract is pinned by tests/graph-store-backup-watch-1590.test.mjs (authored first, by a
 * separate author). In short:
 *
 *   EXIT    0 verdict OK · 3 verdict ALERT (config-invalid included) · 2 usage · 1 the status
 *           file could not be written (never 0).
 *   STATUS  written atomically on EVERY run (complete temp file beside it, fsync, rename):
 *           { schema: 1, checkedAt, verdict: "OK"|"ALERT", observed, causes, episodes, ages,
 *             limits, evidence }. verdict = CURRENT detected health only.
 *   LIMITS  derived from the INSTALLED configuration, never defaulted:
 *             stateMin    = stateStalenessIntervals x monitor StartInterval
 *             copyMin     = tick StartInterval + checkpoint + copy + verify of the LAST SUCCESSFUL
 *                           tick in DEST/backup-schedule-state.json (the monitor's T4 derivation,
 *                           computed here from DEST's own record, not from the deliverer's file)
 *             snapshotMin = freshnessK x this watcher's own StartInterval (what a consumer of the
 *                           status file uses with statusFresh to see that THIS job has died)
 *           The plists are found in --plist-dir by the script named in ProgramArguments; only
 *           files named `*.plist` count (a `.plist.bak-*` copy never does). A missing, unparseable or ambiguous plist, or an invalid --config, is
 *           `config-invalid`: an ALERT, never a permissive default.
 *   CODES   config-invalid · state-unreadable · state-timestamp-invalid · state-verdict-invalid ·
 *           state-stale · deliverer-verdict (the only one with a grace) · dest-unreadable ·
 *           no-verified-copy · timing-missing · copy-stale · future-dated. Comparisons are strict.
 *   CAUSE   "unknown" unless corroborated: state-stale is "corroborated" only when the copies are
 *           themselves stale or absent. Everything else says "unknown" and carries its evidence
 *           in `detail` — the watcher reports WHAT it saw, never a guessed WHY.
 *   SINCE   observed[].since is the watcher's OWN first observation, carried from its previous
 *           status. With no trustworthy previous status it restarts at this run and
 *           earlierDurationUnknown is true: the earlier duration is UNKNOWN, not "new".
 *   EPISODES one continuous run of ALERT verdicts is one episode. OK marks it recovered and keeps
 *           it (an undelivered recovery is still an obligation). An episode is retired only when
 *           BOTH recovered AND acknowledged (--ack-file {"acked": [ids]}; acknowledgment means
 *           RECEIVED, is sticky, and never reopens or closes anything by itself).
 *
 * KNOWN LIMIT: the previous status file is the watcher's only memory. If it is lost or corrupt,
 * open episodes it held are lost with it (the next run says earlierDurationUnknown and, if the
 * condition persists, opens a new episode). A consumer that has already seen an id keeps it.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scanDest, stampOf, STATE_FILE } from './graph-store-backup-schedule.mjs';

const MIN = 60_000, SEC = 1000;
export const SCHEMA = 1;
export const SCRIPTS = Object.freeze({
  'graph-store-backup-schedule.mjs': 'tick',
  'graph-store-backup-monitor.mjs': 'monitor',
  'graph-store-backup-alert.mjs': 'monitor',
  'graph-store-backup-watch.mjs': 'watch',
});
export const CODES = Object.freeze(['config-invalid', 'state-unreadable', 'state-timestamp-invalid', 'state-verdict-invalid',
  'state-stale', 'deliverer-verdict', 'dest-unreadable', 'no-verified-copy', 'timing-missing', 'copy-stale', 'future-dated']);
const CONFIG_KEYS = Object.freeze(['freshnessK', 'maxClockSkewSec', 'graceIntervals', 'stateStalenessIntervals']);

const iso = (ms) => new Date(ms).toISOString();
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/;
/**
 * Pure. Milliseconds for a FULL ISO timestamp whose calendar fields are real, else NaN.
 * Date.parse alone is not enough: V8 normalises 2026-02-31 to 2026-03-03.
 */
export function parseIsoStrict(s) {
  if (typeof s !== 'string') return NaN;
  const m = ISO_RE.exec(s);
  if (!m) return NaN;
  const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number);
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || se > 59) return NaN;
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();      // days in month mo of year y
  if (d > dim) return NaN;
  if (m[8] !== 'Z' && (Number(m[10]) > 23 || Number(m[11]) > 59)) return NaN;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : NaN;
}
const validIso = (s) => Number.isFinite(parseIsoStrict(s));

/**
 * Pure, never throws. The CONSUMER's check that this watcher is still alive: true only when
 * status.checkedAt is a valid ISO time, not in the future, and at most k x watcherIntervalMs old.
 */
export function statusFresh(status, nowMs, watcherIntervalMs, k) {
  try {
    if (!isObj(status)) return false;
    if (!isNum(nowMs) || !isNum(watcherIntervalMs) || watcherIntervalMs <= 0 || !isNum(k) || k <= 0) return false;
    const t = parseIsoStrict(status.checkedAt);
    if (!Number.isFinite(t) || t > nowMs) return false;
    return nowMs - t <= k * watcherIntervalMs;
  } catch { return false; }
}

// ---------------------------------------------------------------- inputs

const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => XML_ENT[e]);

/** Pure. A minimal XML read of a launchd plist: { job, script, interval, error }. */
export function readPlistText(text) {
  const src = String(text).replace(/<!--[\s\S]*?-->/g, '');
  if (!/<plist[\s>]/.test(src) || !/<dict>/.test(src)) return { job: null, error: 'not a plist' };
  const pa = /<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(src);
  const args = pa ? [...pa[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unxml(m[1].trim())) : [];
  const script = args.find((a) => SCRIPTS[path.basename(a)]) ?? null;
  const job = script ? SCRIPTS[path.basename(script)] : null;
  const si = /<key>\s*StartInterval\s*<\/key>\s*<([a-z]+)>([\s\S]*?)<\/\1>/.exec(src);
  let interval = null, error = null;
  if (!si) error = 'no StartInterval';
  else if (si[1] !== 'integer' || !/^\s*-?\d+\s*$/.test(si[2])) error = `StartInterval is not an integer: <${si[1]}>${si[2].trim()}`;
  else {
    interval = Number(si[2].trim());
    if (!Number.isSafeInteger(interval) || interval < 1) { error = `StartInterval ${interval} is not a whole number of seconds >= 1`; interval = null; }
  }
  return { job, script, interval, error };
}

/** Reads --plist-dir. Returns { intervals: {tick, monitor, watch} (seconds or null), problems: [..], evidence: [..] }. */
function readPlists(dir) {
  const found = { tick: [], monitor: [], watch: [] };
  const problems = [], evidence = [];
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return { intervals: { tick: null, monitor: null, watch: null }, problems: [`plist dir ${dir} unreadable (${e.code || e.message})`], evidence }; }
  for (const n of names.sort()) {
    // ONLY `*.plist` is an installed job. A backup or editor copy (`.plist.bak-*`, `.orig`, `~`,
    // `.old`) names the same script with a stale interval; read as a job it would disagree with the
    // live one forever (config-invalid) or lend its limits. A job with ONLY such a copy is missing.
    if (!n.endsWith('.plist')) { if (n.includes('.plist')) evidence.push(`ignored ${n}: not a *.plist name (a backup copy is never a job)`); continue; }
    const p = path.join(dir, n);
    let text;
    try { const st = fs.statSync(p); if (!st.isFile() || st.size > 1_000_000) continue; text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    const r = readPlistText(text);
    if (!r.job) continue;                                    // not one of ours: other jobs share the directory
    found[r.job].push({ file: n, ...r });
  }
  const intervals = {};
  for (const job of ['tick', 'monitor', 'watch']) {
    const list = found[job];
    intervals[job] = null;
    if (!list.length) { problems.push(`no ${job} plist in ${dir} (identified by its script in ProgramArguments)`); continue; }
    const bad = list.filter((x) => x.error);
    if (bad.length) { problems.push(...bad.map((x) => `${job} plist ${x.file}: ${x.error}`)); continue; }
    const distinct = [...new Set(list.map((x) => x.interval))];
    if (distinct.length > 1) { problems.push(`${job}: ${list.length} plists disagree on StartInterval (${list.map((x) => `${x.file}=${x.interval}`).join(', ')})`); continue; }
    intervals[job] = distinct[0];
    evidence.push(`${job} StartInterval ${distinct[0]} s from ${list.map((x) => x.file).join(', ')} (${path.basename(list[0].script)})`);
  }
  return { intervals, problems, evidence };
}

/** Returns { config, problem }. Every key required; no defaults. */
function readConfig(file) {
  let c;
  try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { config: null, problem: `config ${file} unreadable or not JSON (${e.code || e.message})` }; }
  if (!isObj(c)) return { config: null, problem: `config ${file} is not a JSON object` };
  const bad = [];
  for (const k of CONFIG_KEYS) if (!isNum(c[k])) bad.push(`${k} missing or not a finite number`);
  if (isNum(c.freshnessK) && c.freshnessK <= 0) bad.push('freshnessK must be > 0');
  if (isNum(c.stateStalenessIntervals) && c.stateStalenessIntervals <= 0) bad.push('stateStalenessIntervals must be > 0');
  if (isNum(c.maxClockSkewSec) && c.maxClockSkewSec < 0) bad.push('maxClockSkewSec must be >= 0');
  if (isNum(c.graceIntervals) && c.graceIntervals < 0) bad.push('graceIntervals must be >= 0');
  if (bad.length) return { config: null, problem: `config ${file}: ${bad.join('; ')}` };
  return { config: Object.fromEntries(CONFIG_KEYS.map((k) => [k, c[k]])), problem: null };
}

/**
 * Pure. The timings of the LAST SUCCESSFUL tick (the monitor's measuredTimings rule), with every
 * number required finite and >= 0 (checkpointMs may be absent = 0, as in the monitor).
 */
export function lastGoodTimings(state) {
  const ticks = Array.isArray(state?.ticks) ? state.ticks : [];
  const fine = (v) => isNum(v) && v >= 0;
  for (let i = ticks.length - 1; i >= 0; i--) {
    const t = ticks[i];
    if (!isObj(t) || t.ok !== true || !isObj(t.timings)) continue;
    const { checkpointMs = 0, copyMs, verifyMs } = t.timings;
    if (fine(checkpointMs) && fine(copyMs) && fine(verifyMs)) return { at: t.at ?? null, checkpointMs, copyMs, verifyMs };
  }
  return null;
}

function readJson(file) {
  try { return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) { return { ok: false, error: e.code || e.message }; }
}

function readAcks(file) {
  if (!file) return new Set();
  const r = readJson(file);
  if (!r.ok || !isObj(r.value) || !Array.isArray(r.value.acked)) return new Set();
  return new Set(r.value.acked.filter((x) => typeof x === 'string' && x.length > 0));
}

function cleanEpisode(e) {
  if (!isObj(e) || typeof e.id !== 'string' || !e.id || !validIso(e.openedAt) || typeof e.recovered !== 'boolean' || typeof e.acknowledged !== 'boolean') return null;
  if (e.recovered && !validIso(e.recoveredAt)) return null;
  return { id: e.id, openedAt: e.openedAt, recovered: e.recovered, recoveredAt: e.recovered ? e.recoveredAt : null, acknowledged: e.acknowledged };
}
const newEpisodeId = (nowMs) => `ep-${stampOf(nowMs)}-${crypto.randomBytes(4).toString('hex')}`;

// ---------------------------------------------------------------- one run

/**
 * One check. Side effects: reads the inputs. Does NOT write; returns { status, verdict }.
 * `prevStatus` is the previous status file's parse result.
 */
export function evaluate({ dest, alertState, plistDir, configFile, statusFile, ackFile = null, nowMs }) {
  const evidence = [];
  const hits = new Map();                          // code -> [detail]
  const hit = (code, detail) => { if (!hits.has(code)) hits.set(code, []); hits.get(code).push(detail); };

  // -- configuration: plists + config
  const { config, problem: cfgProblem } = readConfig(configFile);
  const pl = readPlists(plistDir);
  evidence.push(...pl.evidence);
  if (cfgProblem) hit('config-invalid', cfgProblem);
  for (const p of pl.problems) hit('config-invalid', p);
  const iv = pl.intervals;
  const skewMs = config ? config.maxClockSkewSec * SEC : null;
  const stateLimitMs = config && iv.monitor ? config.stateStalenessIntervals * iv.monitor * SEC : null;
  const graceMs = config && iv.monitor ? config.graceIntervals * iv.monitor * SEC : null;
  const snapshotLimitMs = config && iv.watch ? config.freshnessK * iv.watch * SEC : null;
  const future = (t) => skewMs != null && t - nowMs > skewMs;

  // -- the previous status: the watcher's own memory
  const prevRead = readJson(statusFile);
  const prev = prevRead.ok && isObj(prevRead.value) ? prevRead.value : null;
  let prevTrusted = false;
  if (prev && prev.schema === SCHEMA && validIso(prev.checkedAt)) {
    const t = parseIsoStrict(prev.checkedAt);
    if (future(t)) hit('future-dated', `previous status checkedAt ${prev.checkedAt} is more than ${config.maxClockSkewSec} s ahead of ${iso(nowMs)}: its bookkeeping is not trusted`);
    else if (skewMs == null && t > nowMs) evidence.push(`previous status checkedAt ${prev.checkedAt} is ahead of now and the skew is unknown: its bookkeeping is not trusted`);
    else prevTrusted = true;
  } else {
    evidence.push(prevRead.ok ? 'previous status not a valid schema-1 snapshot: earlier durations UNKNOWN' : `no readable previous status (${prevRead.error}): earlier durations UNKNOWN`);
  }

  // -- the deliverer's state file
  let stateAgeMin = null;
  let delivererVerdict = null;
  const st = readJson(alertState);
  if (!st.ok || !isObj(st.value)) {
    hit('state-unreadable', st.ok ? `deliverer state ${alertState} is not a JSON object` : `deliverer state ${alertState} unreadable or not JSON (${st.error})`);
  } else {
    const s = st.value;
    const t = parseIsoStrict(s.lastRunAt);
    if (!Number.isFinite(t)) hit('state-timestamp-invalid', `lastRunAt ${JSON.stringify(s.lastRunAt) ?? 'missing'} is not a valid ISO time`);
    else {
      stateAgeMin = (nowMs - t) / MIN;
      if (future(t)) hit('future-dated', `deliverer lastRunAt ${s.lastRunAt} is more than ${config.maxClockSkewSec} s ahead of ${iso(nowMs)}`);
      else if (stateLimitMs != null && nowMs - t > stateLimitMs) hit('state-stale', `deliverer lastRunAt ${s.lastRunAt} is ${stateAgeMin.toFixed(2)} min old > ${stateLimitMs / MIN} min`);
    }
    if (typeof s.lastVerdict !== 'string' || !s.lastVerdict) hit('state-verdict-invalid', `lastVerdict ${JSON.stringify(s.lastVerdict) ?? 'missing'} is not a verdict`);
    else delivererVerdict = s.lastVerdict;
  }

  // -- DEST, read directly (not through the deliverer)
  let newestCopyMin = null, copyLimitMs = null;
  let copies = null;
  try { copies = scanDest(dest); } catch (e) { hit('dest-unreadable', `DEST ${dest} cannot be read (${e.code || e.message})`); }
  if (copies) {
    const verified = [];
    for (const c of copies) {
      if (c.state !== 'verified') continue;
      const stamp = c.name.slice('graph-store-'.length);
      if (stampOf(c.atMs) !== stamp) { evidence.push(`copy ${c.name}: impossible calendar stamp, not counted`); continue; }
      if (future(c.atMs)) { hit('future-dated', `copy ${c.name} is stamped more than ${config.maxClockSkewSec} s ahead of ${iso(nowMs)}; it is not counted`); continue; }
      if (skewMs == null && c.atMs > nowMs) { evidence.push(`copy ${c.name} is ahead of now and the skew is unknown; not counted`); continue; }
      verified.push(c);
    }
    verified.sort((a, b) => a.atMs - b.atMs);
    const newest = verified.length ? verified[verified.length - 1] : null;
    if (!newest) hit('no-verified-copy', `no verified copy in ${dest} (${copies.length} copy entr${copies.length === 1 ? 'y' : 'ies'} of any state)`);
    else newestCopyMin = (nowMs - newest.atMs) / MIN;

    const sched = readJson(path.join(dest, STATE_FILE));
    const m = sched.ok ? lastGoodTimings(sched.value) : null;
    if (!m) hit('timing-missing', sched.ok ? `${STATE_FILE} records no successful tick with finite timings: no copy limit can be derived` : `${STATE_FILE} unreadable (${sched.error}): no copy limit can be derived`);
    else if (iv.tick) {
      copyLimitMs = iv.tick * SEC + m.checkpointMs + m.copyMs + m.verifyMs;
      evidence.push(`copy limit = tick ${iv.tick} s + checkpoint ${m.checkpointMs} + copy ${m.copyMs} + verify ${m.verifyMs} ms (last successful tick ${m.at})`);
      if (newest && nowMs - newest.atMs > copyLimitMs) hit('copy-stale', `newest verified copy ${newest.name} is ${newestCopyMin.toFixed(2)} min old > ${copyLimitMs / MIN} min`);
    }
  }

  // -- observed (every non-OK condition, including inside grace), with the watcher's own since
  const prevObserved = new Map();
  if (prevTrusted && Array.isArray(prev.observed)) for (const o of prev.observed) if (isObj(o) && typeof o.code === 'string') prevObserved.set(o.code, o);
  const sinceFor = (code) => {
    if (!prevTrusted) return { since: nowMs, unknown: true };
    const o = prevObserved.get(code);
    if (!o) return { since: nowMs, unknown: false };
    const t = parseIsoStrict(o.since);
    if (!Number.isFinite(t) || (skewMs != null ? t - nowMs > skewMs : t > nowMs)) return { since: nowMs, unknown: true };
    return { since: t, unknown: false };
  };
  if (delivererVerdict != null && delivererVerdict !== 'OK') {
    const { since } = sinceFor('deliverer-verdict');
    const detail = `deliverer lastVerdict ${delivererVerdict} since this watcher's first sight at ${iso(since)}`;
    if (graceMs != null && nowMs - since > graceMs) hit('deliverer-verdict', `${detail}, beyond the grace of ${graceMs / MIN} min`);
    else hits.set('deliverer-verdict-grace', [detail]);
  }
  const observed = [];
  for (const code of CODES) {
    const inGrace = code === 'deliverer-verdict' && hits.has('deliverer-verdict-grace');
    if (!hits.has(code) && !inGrace) continue;
    const { since, unknown } = sinceFor(code);
    const graceUntil = code === 'deliverer-verdict' && graceMs != null ? since + graceMs : since;
    observed.push({ code, since: iso(since), graceUntil: iso(graceUntil), earlierDurationUnknown: unknown });
  }

  // -- causes
  const copiesBad = hits.has('copy-stale') || hits.has('no-verified-copy');
  const causes = CODES.filter((c) => hits.has(c)).map((code) => ({
    code, detail: hits.get(code).join('; '),
    cause: code === 'state-stale' && copiesBad ? 'corroborated' : 'unknown',
  }));
  const verdict = causes.length ? 'ALERT' : 'OK';

  // -- episodes
  const acks = readAcks(ackFile);
  let episodes = [];
  if (prev && Array.isArray(prev.episodes)) {
    for (const e of prev.episodes) { const c = cleanEpisode(e); if (c) episodes.push(c); else evidence.push(`previous status held a malformed episode, dropped: ${JSON.stringify(e)}`); }
  }
  episodes = episodes.map((e) => ({ ...e, acknowledged: e.acknowledged || acks.has(e.id) }));
  const active = episodes.find((e) => !e.recovered);
  if (verdict === 'ALERT' && !active) episodes.push({ id: newEpisodeId(nowMs), openedAt: iso(nowMs), recovered: false, recoveredAt: null, acknowledged: false });
  if (verdict === 'OK' && active) { active.recovered = true; active.recoveredAt = iso(nowMs); }
  for (const e of episodes) if (e.recovered && e.acknowledged) evidence.push(`episode ${e.id} retired: recovered at ${e.recoveredAt} and acknowledged`);
  episodes = episodes.filter((e) => !(e.recovered && e.acknowledged));

  const sourceParts = [`plists in ${plistDir}: tick ${iv.tick ?? '?'} s, monitor ${iv.monitor ?? '?'} s, watcher ${iv.watch ?? '?'} s`,
    config ? `config ${configFile}: ${CONFIG_KEYS.map((k) => `${k}=${config[k]}`).join(', ')}` : `config ${configFile}: INVALID`,
    `copy timings from ${path.join(dest, STATE_FILE)}`];
  const status = {
    schema: SCHEMA, checkedAt: iso(nowMs), verdict, observed, causes, episodes,
    ages: { stateMin: stateAgeMin, newestCopyMin },
    limits: { stateMin: stateLimitMs != null ? stateLimitMs / MIN : null, copyMin: copyLimitMs != null ? copyLimitMs / MIN : null,
      snapshotMin: snapshotLimitMs != null ? snapshotLimitMs / MIN : null, source: sourceParts.join('; ') },
    evidence,
  };
  return { status, verdict };
}

/** Atomic publish: complete temp file in the SAME directory, fsync, (test barrier), rename. Throws on failure. */
export function writeStatus(file, status, { barrier = process.env.WATCH_TEST_BARRIER } = {}) {
  const dir = path.dirname(path.resolve(file));
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
  const fd = fs.openSync(tmp, 'wx', 0o644);
  try { fs.writeSync(fd, JSON.stringify(status, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (barrier) fs.readFileSync(barrier);           // TEST ONLY: blocks until the test's writer closes the fifo
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
}

const REQUIRED = { '--dest': 'dest', '--alert-state': 'alertState', '--plist-dir': 'plistDir', '--config': 'configFile', '--status': 'statusFile' };
export function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!(k in REQUIRED) && k !== '--ack-file' && k !== '--now') throw new Error(`unknown arg: ${k}`);
    if (v === undefined || v.startsWith('--')) throw new Error(`${k} needs a value`);
    i++;
    if (k === '--ack-file') a.ackFile = v;
    else if (k === '--now') { a.nowMs = parseIsoStrict(v); if (!Number.isFinite(a.nowMs)) throw new Error('--now must be a full ISO timestamp'); }
    else a[REQUIRED[k]] = v;
  }
  for (const [flag, key] of Object.entries(REQUIRED)) if (!a[key]) throw new Error(`${flag} is required`);
  return a;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let a;
  try { a = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  const nowMs = a.nowMs ?? Date.now();
  let r;
  try { r = evaluate({ ...a, nowMs }); }
  catch (e) { console.error(`WATCH ERROR: ${e?.stack ?? e}`); process.exit(1); }
  try { writeStatus(a.statusFile, r.status); }
  catch (e) { console.error(`STATUS-UNWRITABLE ${a.statusFile}: ${e.code || e.message} (verdict was ${r.verdict})`); process.exit(1); }
  process.exit(r.verdict === 'OK' ? 0 : 3);
}
