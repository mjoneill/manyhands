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
 * A post that fails is NOT dropped: the episode is recorded as open and the
 * undelivered text is kept as `pending`. Every run delivers `pending` FIRST, before
 * deciding anything new, so "alert, post fails, backups recover" still reaches the
 * commons as the alert followed by the recovery. A crash between a successful post
 * and the state write can repeat that one post; nothing undelivered is forgotten.
 *
 *   node scripts/graph-store-backup-alert.mjs --dest DIR --board http://127.0.0.1:PORT
 *        [--store DIR] [--state FILE] [--remind-min 60] [--limit-min M] [--now ISO]
 *
 * Exit: the monitor's verdict code (OK 0 · UNAVAILABLE 3 · STALE 4 · NO-COPY 5 ·
 * UNVERIFIED-NEWEST 6), so launchd's record matches the monitor's; 2 usage. A failed
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
  try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return { episode: s.episode ?? null, pending: s.pending ?? [] }; }
  catch { return { episode: null, pending: [] }; }
}
function writeAlertState(file, s) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

async function deliver({ board, body, fetchImpl }) {
  const r = await fetchImpl(`${board}/api/conversations`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ author: 'board', body }), signal: AbortSignal.timeout(30_000),
  });
  if (r.status !== 201 && r.status !== 200) throw new Error(`HTTP ${r.status}`);
}

/**
 * One run: deliver anything still pending, then monitor, decide, post, record.
 * Returns { result, posted (count delivered this run), deliveryError }.
 */
export async function alertOnce({ dest, board, store = null, stateFile = null, remindMs = 60 * MIN, limitMs = null,
  nowMs = Date.now(), fetchImpl = fetch }) {
  const file = stateFile || DEFAULT_ALERT_STATE();
  const st = readAlertState(file);
  let posted = 0;
  // 1. Undelivered posts from earlier runs go first, in order. Stop at the first failure.
  while (st.pending.length) {
    try { await deliver({ board, body: st.pending[0], fetchImpl }); } catch (e) {
      const result = monitor({ dest, store, nowMs, intervalMs: DEFAULT_INTERVAL_MS, limitMs });
      const { post, next } = decide({ result, prev: st, nowMs, remindMs });
      writeAlertState(file, { episode: next.episode, pending: post ? [...st.pending, post] : st.pending });
      return { result, posted, deliveryError: `pending delivery failed: ${e?.message ?? e}` };
    }
    st.pending.shift(); posted += 1;
    writeAlertState(file, st);
  }
  // 2. This run's verdict.
  const result = monitor({ dest, store, nowMs, intervalMs: DEFAULT_INTERVAL_MS, limitMs });
  const { post, next } = decide({ result, prev: st, nowMs, remindMs });
  if (!post) { writeAlertState(file, { episode: next.episode, pending: [] }); return { result, posted, deliveryError: null }; }
  try { await deliver({ board, body: post, fetchImpl }); } catch (e) {
    // The episode is recorded (so the next run does not re-open it) and the text is kept.
    writeAlertState(file, { episode: next.episode, pending: [post] });
    return { result, posted, deliveryError: e?.message ?? String(e) };
  }
  writeAlertState(file, { episode: next.episode, pending: [] });
  return { result, posted: posted + 1, deliveryError: null };
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
  if (r.posted) console.log(`ALERT-DELIVERED ${r.posted} post(s) to ${a.board} (commons, author board)`);
  if (r.deliveryError) console.log(`ALERT-DELIVERY FAILED: ${r.deliveryError} (kept as pending; delivered first next run)`);
  process.exit(EXIT[r.result.verdict]);
}
