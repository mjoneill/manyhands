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
 * The episode lives in --state (default DEST/backup-alert-state.json). The post is
 * made FIRST and the state written AFTER it succeeds, so a failed post is retried
 * on the next run, and a crash between the two can repeat one post (never lose one).
 *
 *   node scripts/graph-store-backup-alert.mjs --dest DIR --board http://127.0.0.1:PORT
 *        [--store DIR] [--state FILE] [--remind-min 60] [--limit-min M] [--now ISO]
 *
 * Exit: the monitor's verdict code (OK 0 · UNAVAILABLE 3 · STALE 4 · NO-COPY 5 ·
 * UNVERIFIED-NEWEST 6), so launchd's record matches the monitor's; 2 usage. A failed
 * post does not change the exit code; it is printed as `ALERT-DELIVERY FAILED`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitor, DEFAULT_INTERVAL_MS } from './graph-store-backup-monitor.mjs';

const MIN = 60_000;
export const ALERT_STATE_FILE = 'backup-alert-state.json';
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
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { episode: null }; }
}
function writeAlertState(file, s) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** One run: monitor, decide, post, record. Returns { result, posted, deliveryError }. */
export async function alertOnce({ dest, board, store = null, stateFile = null, remindMs = 60 * MIN, limitMs = null,
  nowMs = Date.now(), fetchImpl = fetch }) {
  const result = monitor({ dest, store, nowMs, intervalMs: DEFAULT_INTERVAL_MS, limitMs });
  const file = stateFile || path.join(dest, ALERT_STATE_FILE);
  const { post, next } = decide({ result, prev: readAlertState(file), nowMs, remindMs });
  if (!post) {
    if (!result.alert) { try { writeAlertState(file, next); } catch { /* DEST unreadable is already the verdict */ } }
    return { result, posted: false, deliveryError: null };
  }
  try {
    const r = await fetchImpl(`${board}/api/conversations`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: 'board', body: post }), signal: AbortSignal.timeout(30_000),
    });
    if (r.status !== 201 && r.status !== 200) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    return { result, posted: false, deliveryError: e?.message ?? String(e) };   // state NOT advanced: retried next run
  }
  try { writeAlertState(file, next); } catch (e) { return { result, posted: true, deliveryError: `posted, but state not recorded: ${e.message}` }; }
  return { result, posted: true, deliveryError: null };
}

function parseArgs(argv) {
  const a = { remindMs: 60 * MIN, limitMs: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dest') a.dest = argv[++i];
    else if (k === '--board') a.board = argv[++i];
    else if (k === '--store') a.store = argv[++i];
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
  return a;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let a;
  try { a = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  const r = await alertOnce(a);
  console.log(r.result.line);
  if (r.posted) console.log(`ALERT-DELIVERED to ${a.board} (commons, author board)`);
  if (r.deliveryError) console.log(`ALERT-DELIVERY FAILED: ${r.deliveryError} (will retry next run)`);
  process.exit(EXIT[r.result.verdict]);
}
