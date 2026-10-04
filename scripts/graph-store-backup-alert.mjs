/**
 * #1578 — DELIVERY for the graph-store backup monitor's alerts. The monitor
 * (graph-store-backup-monitor.mjs) decides OK / STALE / NO-COPY / UNAVAILABLE /
 * UNVERIFIED-NEWEST and prints one line; under launchd that line lands in a log
 * nobody reads. The owner's ruling: alerts print to the board (a commons post);
 * a second seat may relay them further. This script runs the same monitor and
 * posts to the commons as `board`:
 *
 *   - once when an alert EPISODE opens (the first alert, or a different verdict);
 *   - at most once per --remind-min (default 60) while that episode stays open;
 *   - once when it closes (the next OK after an alert).
 *
 * State lives in --state, by default OUTSIDE the monitored destination
 * (~/.claude/graph-store-backup-alert-state.json): a missing or unreadable DEST is
 * one of the failures being reported, so it must not also erase the dedupe.
 *
 * A post is written to `pending` BEFORE it is sent (write-ahead) and removed after the
 * board accepts it, so neither a failed post nor a process killed mid-request loses it. Every run delivers `pending` FIRST, before
 * deciding anything new, so "alert, post fails, backups recover" still reaches the
 * commons as the alert followed by the recovery. A crash between a successful post
 * and the state write can repeat that one post; nothing undelivered is forgotten.
 *
 * FRESHNESS: every run stamps `lastRunAt` and `lastVerdict` into the state file, so an
 * independent watcher (the text fallback) can tell this job has stopped. That watcher is
 * NOT this script: a dead job cannot report its own death.
 *
 *   node scripts/graph-store-backup-alert.mjs --dest DIR --board http://127.0.0.1:PORT --key-file FILE
 *        [--store DIR] [--state FILE] [--remind-min 60] [--limit-min M] [--now ISO]
 *
 * --key-file: the `board` seat's own credential (0600), sent as a bearer on every post,
 * so the post is the board's authenticated act and not an unauthenticated claim of the
 * `board` author. Never printed.
 *
 * Exit: the monitor's verdict code (OK 0 · UNAVAILABLE 3 · STALE 4 · NO-COPY 5 ·
 * UNVERIFIED-NEWEST 6), so launchd's record matches the monitor's; 7 when the verdict is OK but
 * the alert state file is unwritable; 8 when an alert was NOT sent because its state could not
 * be written first (fail-closed); 2 usage. A failed
 * post does not change the exit code; it is printed as `ALERT-DELIVERY FAILED`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitor, DEFAULT_INTERVAL_MS } from './graph-store-backup-monitor.mjs';

const MIN = 60_000;
export const DEFAULT_ALERT_STATE = () => path.join(os.homedir(), '.claude', 'graph-store-backup-alert-state.json');
const EXIT = { OK: 0, UNAVAILABLE: 3, STALE: 4, 'NO-COPY': 5, 'UNVERIFIED-NEWEST': 6 };

/**
 * Pure. Given the monitor's result and the previous episode state, what to post and
 * what to record. `prev` is { episode: { verdict, openedAt, lastPostedAt } | null }.
 */
export function decide({ result, prev, nowMs, remindMs = 60 * MIN }) {
  const ep = prev?.episode ?? null;
  const at = new Date(nowMs).toISOString();
  if (result.alert) {
    if (!ep || ep.verdict !== result.verdict) {
      return {
        post: `⚠️ BACKUP ALERT ${result.verdict} — graph-store backups need attention. ${result.line}`,
        next: { episode: { verdict: result.verdict, openedAt: at, lastPostedAt: at } },
      };
    }
    if (nowMs - Date.parse(ep.lastPostedAt) >= remindMs) {
      return {
        post: `⚠️ BACKUP ALERT ${result.verdict} still open since ${ep.openedAt}. ${result.line}`,
        next: { episode: { ...ep, lastPostedAt: at } },
      };
    }
    return { post: null, next: { episode: ep } };
  }
  if (ep) {
    return { post: `✅ backups recovered (${ep.verdict} since ${ep.openedAt} closed). ${result.line}`, next: { episode: null } };
  }
  return { post: null, next: { episode: null } };
}

function readAlertState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    const pending = (s.pending ?? []).map((p) => (typeof p === 'string' ? { kind: 'open', body: p } : p));
    return { episode: s.episode ?? null, pending };
  }
  catch { return { episode: null, pending: [] }; }
}
function writeAlertState(file, s, run = null) {
  if (run) s = { ...s, lastRunAt: new Date(run.nowMs).toISOString(), lastVerdict: run.verdict };
  fs.mkdirSync(path.dirname(file), { recursive: true });   // a fresh home has no ~/.claude yet
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** A state write that cannot fail the run: returns the error (or null). */
function trySave(file, st, run) { try { writeAlertState(file, st, run); return null; } catch (e) { return `${file}: ${e?.message ?? e}`; } }

/**
 * Pure. Add one undelivered post to the queue. A long board outage must not flood the
 * commons on recovery: only the LATEST reminder is kept (an older one is stale the
 * moment a newer exists); an opening alert and a recovery are always kept, in order.
 */
export function queue(pending, body) {
  const kind = body.startsWith('✅') ? 'recover' : /still open since/.test(body) ? 'remind' : 'open';
  const kept = kind === 'remind' ? pending.filter((p) => p.kind !== 'remind') : pending;
  return [...kept, { kind, body }];
}

async function deliver({ board, body, key, fetchImpl }) {
  const r = await fetchImpl(`${board}/api/conversations`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ author: 'board', body }), signal: AbortSignal.timeout(30_000),
  });
  if (r.status !== 201 && r.status !== 200) throw new Error(`HTTP ${r.status}`);
}

/**
 * One run: deliver anything still pending, then monitor, decide, post, record.
 * Returns { result, posted (count delivered this run), deliveryError }.
 */
export async function alertOnce({ dest, board, key = null, store = null, stateFile = null, remindMs = 60 * MIN, limitMs = null,
  nowMs = Date.now(), fetchImpl = fetch }) {
  const file = stateFile || DEFAULT_ALERT_STATE();
  const st = readAlertState(file);
  let posted = 0;
  // 1. Undelivered posts from earlier runs go first, in order. Stop at the first failure.
  let stateError = null;
  while (st.pending.length) {
    try { await deliver({ board, body: st.pending[0].body, key, fetchImpl }); } catch (e) {
      const result = monitor({ dest, store, nowMs, intervalMs: DEFAULT_INTERVAL_MS, limitMs });
      const { post, next } = decide({ result, prev: st, nowMs, remindMs });
      stateError = trySave(file, { episode: next.episode, pending: post ? queue(st.pending, post) : st.pending }, { nowMs, verdict: result.verdict });
      return { result, posted, deliveryError: `pending delivery failed: ${e?.message ?? e}`, stateError };
    }
    st.pending.shift(); posted += 1;
    stateError = trySave(file, st) ?? stateError;
  }
  // 2. This run's verdict.
  const result = monitor({ dest, store, nowMs, intervalMs: DEFAULT_INTERVAL_MS, limitMs });
  const { post, next } = decide({ result, prev: st, nowMs, remindMs });
  if (!post) { stateError = trySave(file, { episode: next.episode, pending: [] }, { nowMs, verdict: result.verdict }) ?? stateError; return { result, posted, deliveryError: null, stateError }; }
  // WRITE-AHEAD: the text is persisted as pending BEFORE it is sent, so a process killed
  // mid-request leaves it to be delivered by the next run (even if the backups have
  // recovered by then). It is removed only after the board accepted it.
  // FAIL-CLOSED: if the state CANNOT be written, nothing is sent (an untracked post would
  // repeat every run). The run reports STATE-UNWRITABLE and exits non-zero (8); the
  // independent watcher must catch that. Until it exists this is a stated delivery limit.
  const aheadError = trySave(file, { episode: next.episode, pending: queue([], post) }, { nowMs, verdict: result.verdict });
  if (aheadError) return { result, posted, deliveryError: null, stateError: aheadError, notSent: true };
  try { await deliver({ board, body: post, key, fetchImpl }); } catch (e) {
    return { result, posted, deliveryError: e?.message ?? String(e), stateError };   // pending holds it, unless the state is unwritable
  }
  stateError = trySave(file, { episode: next.episode, pending: [] }, { nowMs, verdict: result.verdict }) ?? stateError;
  return { result, posted: posted + 1, deliveryError: null, stateError };
}

function parseArgs(argv) {
  const a = { remindMs: 60 * MIN, limitMs: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dest') a.dest = argv[++i];
    else if (k === '--board') a.board = argv[++i];
    else if (k === '--store') a.store = argv[++i];
    else if (k === '--key-file') a.keyFile = argv[++i];
    else if (k === '--state') a.stateFile = argv[++i];
    else if (k === '--remind-min') a.remindMs = Number(argv[++i]) * MIN;
    else if (k === '--limit-min') a.limitMs = Number(argv[++i]) * MIN;
    else if (k === '--now') a.nowMs = Date.parse(argv[++i]);
    else throw new Error(`unknown arg: ${k}`);
  }
  if (!a.dest) throw new Error('--dest is required');
  if (!a.board || !/^http:\/\/127\.0\.0\.1:\d+$/.test(a.board)) throw new Error('--board http://127.0.0.1:PORT is required');
  if (!Number.isFinite(a.remindMs) || a.remindMs < 0) throw new Error('--remind-min must be a number >= 0');
  if (a.limitMs !== null && (!Number.isFinite(a.limitMs) || a.limitMs < 0)) throw new Error('--limit-min must be a number >= 0');
  if (a.nowMs !== undefined && !Number.isFinite(a.nowMs)) throw new Error('--now must be an ISO timestamp');
  if (!a.keyFile) throw new Error('--key-file FILE (the board seat\'s credential) is required');
  a.key = fs.readFileSync(a.keyFile, 'utf8').trim();
  if (!a.key) throw new Error('--key-file is empty');
  return a;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let a;
  try { a = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  const r = await alertOnce(a);
  console.log(r.result.line);
  if (r.posted) console.log(`ALERT-DELIVERED ${r.posted} post(s) to ${a.board} (commons, author board)`);
  if (r.deliveryError) console.log(`ALERT-DELIVERY FAILED: ${r.deliveryError} (kept as pending; delivered first next run)`);
  if (r.stateError) console.log(`STATE-UNWRITABLE: ${r.stateError} (alerts will repeat until fixed)`);
  if (r.notSent) console.log('ALERT-NOT-SENT: state unwritable, fail-closed (an untracked post would repeat every run)');
  // A broken state file must not look healthy: an unsent alert exits 8; OK + unwritable state exits 7.
  process.exit(r.notSent ? 8 : r.stateError && r.result.verdict === 'OK' ? 7 : EXIT[r.result.verdict]);
}
