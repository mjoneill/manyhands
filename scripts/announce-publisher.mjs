#!/usr/bin/env node
/**
 * #1574 C3b — the announcement PUBLISHER: a clock, not a decider.
 *
 *   node scripts/announce-publisher.mjs --board URL --key-file FILE --status FILE [--once] [--batch N]
 *        [--scan-every-ms N] [--audit-every-ms N] [--now ISO-8601]
 *
 * A scan reads the board's pending obligations (GET /api/outbox?status=pending) and makes at most N publish
 * ATTEMPTS (POST /api/outbox/:id/publish), one at a time. Every decision — verify a legacy proof, write a post,
 * block — is the SERVER's, under its lock; this process only says "now". An audit reads the whole outbox and
 * counts integrity failures (auditOutbox).
 *
 * Fairness and backoff (#1574 gate 12):
 *   - An attempt FAILS when /publish answers >= 500, cannot be reached or parsed, or answers 200 {status:'pending'}.
 *     A failure never aborts the scan; the entry enters BACKOFF and is attempted at most once per scan.
 *   - An entry in backoff is skipped (no call, not counted against --batch) until now >= its nextAttemptAt. The
 *     window is 60 s after the first failure, doubling per consecutive failure, never more than 24 h.
 *   - Candidates are ordered by the scan in which this publisher FIRST SAW them pending, then oldest first by the
 *     frozen payload's occurredAt. With nothing failing that is plain oldest-first; under a stream of fresh
 *     failures, an entry that has been waiting longer outranks every newcomer, so newcomers cannot starve it.
 *   - An entry leaves backoff when it is published, blocked, or no longer pending in the outbox.
 *   - --now replaces the wall clock for backoff decisions (requires --once). It must be a full, calendar-valid
 *     ISO-8601 timestamp with a zone, or the arguments are rejected.
 *
 * --once   one scan then one audit; exit 0 when both completed. A per-entry failure (a BLOCKED entry, a 5xx on one
 *          /publish, an unreachable or unparseable answer) is data, not an exit status. Exit 1 only when the
 *          outbox listing could not be obtained; exit 2 when the arguments are rejected.
 * default  loop forever on the nextActions() schedule (scan every 5 s, audit every 60 s).
 *
 * The status file is rewritten on every run/tick:
 *   {checkedAt, lastScanCompletedAt, pendingCount, oldestPendingAt, blockedCount, lastError, auditIntegrityFailures,
 *    attempted, deferred, publishErrors, backoff, firstSeenScan, scanCount}
 * attempted/deferred/publishErrors describe the last scan (null when its listing failed). backoff, firstSeenScan
 * and scanCount are the publisher's only state: they are read back from this same file at start, so they persist
 * between --once runs. It ENABLES detection of a dead publisher (a stale checkedAt); nothing consumes it yet.
 *
 * The key file holds the board bearer token. It is sent as `Authorization: Bearer …` and never printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { auditOutbox } from '../core/announce-outbox.mjs';

/**
 * PURE schedule. A side that has never run is due; otherwise it is due when now - last >= every.
 * The two sides are independent.
 */
export function nextActions({ nowMs, lastScanAt, lastAuditAt, scanEveryMs, auditEveryMs }) {
  const due = (last, every) => last == null || nowMs - last >= every;
  return { scan: due(lastScanAt, scanEveryMs), audit: due(lastAuditAt, auditEveryMs) };
}

const occurredAtOf = (e) => {
  const t = Date.parse(e?.payload?.occurredAt);
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
};
/** Oldest first; ties broken by obligationId so the order is total. */
export const oldestFirst = (entries) => [...entries].sort((a, b) => (occurredAtOf(a) - occurredAtOf(b))
  || String(a.obligationId).localeCompare(String(b.obligationId)));

/** Backoff schedule: 60 s after the first failure, doubling, capped at 24 h. */
export const BACKOFF_FLOOR_MS = 60_000;
export const BACKOFF_CEILING_MS = 24 * 3_600_000;
export const backoffWindowMs = (failures) =>
  Math.min(BACKOFF_CEILING_MS, BACKOFF_FLOOR_MS * 2 ** Math.min(Math.max(0, failures - 1), 30));

/**
 * The same rule as parseIsoStrict in scripts/graph-store-backup-watch.mjs (kept local so the publisher does not
 * load the backup modules): a full date and time, Z or ±hh:mm, and a real day of a real month. NaN otherwise.
 */
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/;
export function parseIsoStrict(s) {
  if (typeof s !== 'string') return NaN;
  const m = ISO_RE.exec(s);
  if (!m) return NaN;
  const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number);
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || se > 59) return NaN;
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d > dim) return NaN;
  if (m[8] !== 'Z' && (Number(m[10]) > 23 || Number(m[11]) > 59)) return NaN;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : NaN;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The persisted state, read from a previous status file. Anything malformed is dropped, never trusted. */
export function stateFromStatus(prev) {
  const state = { backoff: {}, firstSeenScan: {}, scanCount: 0 };
  if (!isPlainObject(prev)) return state;
  if (Number.isSafeInteger(prev.scanCount) && prev.scanCount >= 0) state.scanCount = prev.scanCount;
  if (isPlainObject(prev.backoff)) {
    for (const [id, b] of Object.entries(prev.backoff)) {
      if (!isPlainObject(b) || !Number.isFinite(Date.parse(b.nextAttemptAt))) continue;
      const failures = Number.isSafeInteger(b.failures) && b.failures >= 1 ? b.failures : 1;
      state.backoff[id] = { ...b, failures };
    }
  }
  if (isPlainObject(prev.firstSeenScan)) {
    for (const [id, n] of Object.entries(prev.firstSeenScan)) {
      if (Number.isSafeInteger(n) && n >= 0 && n <= state.scanCount) state.firstSeenScan[id] = n;
    }
  }
  return state;
}

function readPrevStatus(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function parseArgs(argv) {
  const out = { once: false, batch: 50, scanEveryMs: 5000, auditEveryMs: 60000, nowMs: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === '--board') out.board = val().replace(/\/$/, '');
    else if (a === '--key-file') out.keyFile = val();
    else if (a === '--status') out.status = val();
    else if (a === '--once') out.once = true;
    else if (a === '--batch') out.batch = Number(val());
    else if (a === '--scan-every-ms') out.scanEveryMs = Number(val());
    else if (a === '--audit-every-ms') out.auditEveryMs = Number(val());
    else if (a === '--now') {
      const v = val();
      out.nowMs = parseIsoStrict(v);
      if (!Number.isFinite(out.nowMs)) throw new Error(`--now must be a full, calendar-valid ISO-8601 timestamp with a zone: ${JSON.stringify(v)}`);
    }
    else throw new Error(`unknown argument ${a}`);
  }
  if (out.nowMs !== null && !out.once) throw new Error('--now requires --once (a fixed instant would freeze every backoff in the loop)');
  if (!out.board || !out.keyFile || !out.status) throw new Error('--board, --key-file and --status are required');
  if (!Number.isInteger(out.batch) || out.batch < 1) throw new Error('--batch must be a positive integer');
  return out;
}

function makeClient(board, key) {
  return async function call(method, route) {
    let res;
    try {
      res = await fetch(`${board}${route}`, {
        method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        ...(method === 'POST' ? { body: '{}' } : {}), signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      throw new Error(`board unreachable: ${method} ${route}: ${e?.cause?.code || e?.name || e?.message || e}`);
    }
    const text = await res.text();
    let body = null; try { body = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: res.status, body };
  };
}

async function readOutbox(call, query = '') {
  const r = await call('GET', `/api/outbox${query}`);
  if (r.status !== 200 || !r.body || !Array.isArray(r.body.entries) || !Array.isArray(r.body.origins)) {
    throw new Error(`GET /api/outbox${query}: HTTP ${r.status}`);
  }
  return r.body;
}

/**
 * One scan. Throws ONLY when the pending listing can't be obtained; every per-entry failure is recorded in the
 * returned counts and in `state` (mutated), and the scan goes on to the next entry.
 */
export async function scan(call, batch, state, nowMs) {
  const { entries } = await readOutbox(call, '?status=pending');
  const pending = entries.filter((e) => e && typeof e.obligationId === 'string');
  const pendingIds = new Set(pending.map((e) => e.obligationId));
  // An entry that is no longer pending (published, blocked, gone) leaves the state.
  for (const id of Object.keys(state.backoff)) if (!pendingIds.has(id)) delete state.backoff[id];
  for (const id of Object.keys(state.firstSeenScan)) if (!pendingIds.has(id)) delete state.firstSeenScan[id];
  state.scanCount += 1;
  for (const id of pendingIds) if (!(id in state.firstSeenScan)) state.firstSeenScan[id] = state.scanCount;

  const byAge = oldestFirst(pending);
  const rank = new Map(byAge.map((e, i) => [e.obligationId, i]));
  const ordered = byAge.sort((a, b) => (state.firstSeenScan[a.obligationId] - state.firstSeenScan[b.obligationId])
    || (rank.get(a.obligationId) - rank.get(b.obligationId)));

  const counts = { attempted: 0, deferred: 0, publishErrors: 0, lastError: null };
  const settle = (id) => { delete state.backoff[id]; delete state.firstSeenScan[id]; };
  const fail = (id, reason, isError) => {
    const failures = (state.backoff[id]?.failures ?? 0) + 1;
    state.backoff[id] = {
      nextAttemptAt: new Date(nowMs + backoffWindowMs(failures)).toISOString(),
      failures, lastFailedAt: new Date(nowMs).toISOString(), reason,
    };
    if (isError) { counts.publishErrors += 1; counts.lastError = `publish ${id}: ${reason}`; }
  };

  for (const e of ordered) {
    const id = e.obligationId;
    const b = state.backoff[id];
    if (b && nowMs < Date.parse(b.nextAttemptAt)) { counts.deferred += 1; continue; }
    if (counts.attempted >= batch) continue;
    counts.attempted += 1;
    let r;
    try { r = await call('POST', `/api/outbox/${encodeURIComponent(id)}/publish`); } catch (err) {
      fail(id, String(err?.message || err), true); continue;
    }
    if (r.status === 404) { settle(id); continue; }   // gone since the read: nothing to do
    if (r.status >= 500) { fail(id, `HTTP ${r.status}`, true); continue; }
    const outcome = r.body && typeof r.body.status === 'string' ? r.body.status : null;
    if (outcome === 'published' || outcome === 'blocked') { settle(id); continue; }
    if (outcome === 'pending') { fail(id, `pending${r.body.reason ? `: ${r.body.reason}` : ''}`, false); continue; }
    fail(id, `HTTP ${r.status}: unparseable answer`, true);
  }
  return counts;
}

/** The audit and the counts, from ONE read of the whole outbox. */
async function survey(call) {
  const ob = await readOutbox(call);
  const doc = { announcementOutbox: {
    origins: Object.fromEntries(ob.origins.map((o) => [o.mutationId, o])),
    entries: Object.fromEntries(ob.entries.map((e) => [e.obligationId, e])),
  } };
  const pending = oldestFirst(ob.entries.filter((e) => e.status === 'pending'));
  return {
    pendingCount: pending.length,
    oldestPendingAt: pending.length ? (pending[0].payload?.occurredAt ?? null) : null,
    blockedCount: ob.entries.filter((e) => e.status === 'blocked').length,
    auditIntegrityFailures: auditOutbox(doc).failures.length,
  };
}

function writeStatus(file, status) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(status, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

async function tick(opts, call, mem, { doScan, doAudit }) {
  let fatal = null;
  let scanCounts = mem.scanCounts;
  try {
    if (doScan) {
      scanCounts = null;
      const nowMs = opts.nowMs ?? Date.now();
      scanCounts = await scan(call, opts.batch, mem.state, nowMs);
      mem.lastScanCompletedAt = new Date().toISOString(); mem.lastScanAt = Date.now();
    }
    if (doAudit || doScan) {
      const s = await survey(call);
      Object.assign(mem.counts, s);
      if (doAudit) mem.lastAuditAt = Date.now();
    }
  } catch (e) {
    fatal = String(e?.message || e);
  }
  mem.scanCounts = scanCounts;
  const lastError = fatal ?? scanCounts?.lastError ?? null;
  writeStatus(opts.status, {
    checkedAt: new Date().toISOString(),
    lastScanCompletedAt: mem.lastScanCompletedAt,
    pendingCount: mem.counts.pendingCount,
    oldestPendingAt: mem.counts.oldestPendingAt,
    blockedCount: mem.counts.blockedCount,
    lastError,
    auditIntegrityFailures: mem.counts.auditIntegrityFailures,
    attempted: scanCounts?.attempted ?? null,
    deferred: scanCounts?.deferred ?? null,
    publishErrors: scanCounts?.publishErrors ?? null,
    backoff: mem.state.backoff,
    firstSeenScan: mem.state.firstSeenScan,
    scanCount: mem.state.scanCount,
  });
  return { fatal, lastError };
}

async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error(`announce-publisher: ${e.message}`); return 2; }
  const mem = { lastScanAt: null, lastAuditAt: null, lastScanCompletedAt: null,
    counts: { pendingCount: null, oldestPendingAt: null, blockedCount: null, auditIntegrityFailures: null },
    scanCounts: null, state: stateFromStatus(readPrevStatus(opts.status)) };
  let key;
  try { key = fs.readFileSync(opts.keyFile, 'utf8').trim(); } catch (e) {
    const msg = `key file unreadable: ${e.code || e.message}`;
    try { writeStatus(opts.status, { checkedAt: new Date().toISOString(), lastScanCompletedAt: null, pendingCount: null, oldestPendingAt: null, blockedCount: null, lastError: msg, auditIntegrityFailures: null,
      attempted: null, deferred: null, publishErrors: null, backoff: mem.state.backoff, firstSeenScan: mem.state.firstSeenScan, scanCount: mem.state.scanCount }); } catch { /* nowhere to say it */ }
    console.error(`announce-publisher: ${msg}`);
    return 2;
  }
  const call = makeClient(opts.board, key);
  if (opts.once) {
    const { fatal, lastError } = await tick(opts, call, mem, { doScan: true, doAudit: true });
    if (lastError) console.error(`announce-publisher: ${lastError}`);
    return fatal ? 1 : 0;
  }
  for (;;) {
    const due = nextActions({ nowMs: Date.now(), lastScanAt: mem.lastScanAt, lastAuditAt: mem.lastAuditAt, scanEveryMs: opts.scanEveryMs, auditEveryMs: opts.auditEveryMs });
    if (due.scan || due.audit) {
      const { fatal, lastError } = await tick(opts, call, mem, { doScan: due.scan, doAudit: due.audit });
      if (lastError) console.error(`${new Date().toISOString()} announce-publisher: ${lastError}`);
      if (fatal) mem.lastScanAt = Date.now();
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(`announce-publisher: ${e?.stack || e}`); process.exit(1); });
}
