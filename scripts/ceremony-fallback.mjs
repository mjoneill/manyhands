#!/usr/bin/env node
/**
 * #1858 — the ceremony bell's fallback, as a job that runs OUTSIDE the MCP server.
 *
 * Run it from launchd at minute 6 of every hour (StartCalendarInterval { Minute: 6 }). Every
 * timezone this host could be in is offset from UTC by whole hours here, so local :06 is UTC :06,
 * and the schedule file (UTC) decides whether this hour holds a slot. A schedule edit needs no
 * reinstall, and neither does a daylight-saving change.
 *
 * Reads the room (board-authored posts since the earliest slot, a filtered read, never the
 * unfiltered list) and posts what core/ceremony-fallback.mjs decides. It does nothing else.
 *
 * Env:
 *   CEREMONY_FALLBACK_SEATS        comma-separated seat keys to name, in order (none = "whoever is here")
 *   SCRUM_CEREMONY_SCHEDULE_FILE   default: ceremony-schedule.json beside this script's parent dir
 *   SCRUM_REST_URL                 default http://127.0.0.1:3141
 *   CEREMONY_FALLBACK_DRYRUN=1     print the decisions and the would-be post, post nothing
 *   CEREMONY_FALLBACK_NOW          an ISO time to decide as of (dry runs only)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSchedule, latestSlot } from '../core/ceremony-bell.mjs';
import { fallbackDecide, FALLBACK_DELAY_MS, FALLBACK_WINDOW_MS } from '../core/ceremony-fallback.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEDULE = process.env.SCRUM_CEREMONY_SCHEDULE_FILE || path.join(here, '..', 'ceremony-schedule.json');
const REST = (process.env.SCRUM_REST_URL || 'http://127.0.0.1:3141').replace(/\/$/, '');
const SEATS = (process.env.CEREMONY_FALLBACK_SEATS || '').split(',').map((s) => s.trim()).filter(Boolean);
const DRYRUN = process.env.CEREMONY_FALLBACK_DRYRUN === '1';
const nowIso = (DRYRUN && process.env.CEREMONY_FALLBACK_NOW) || new Date().toISOString();
const nowMs = Date.parse(nowIso);
const log = (m) => console.log(`${new Date().toISOString()} [#1858] ${m}`);

let sched;
try { sched = validateSchedule(JSON.parse(fs.readFileSync(SCHEDULE, 'utf8'))); } catch (e) { sched = { ok: false, error: e.message }; }
if (!sched.ok) { log(`schedule refused (${SCHEDULE}): ${sched.error}`); process.exit(1); }
if (!sched.enabled) { log('schedule disabled: the bell is off on purpose, so no fallback either'); process.exit(0); }

// Only entries inside their fallback window matter; with none, there is nothing to read.
const live = sched.entries.filter((e) => {
  const due = latestSlot(e, nowMs) + FALLBACK_DELAY_MS;
  return nowMs >= due && nowMs < due + FALLBACK_WINDOW_MS;
});
if (!live.length) { log(`no ceremony in its fallback window at ${nowIso}`); process.exit(0); }

const since = new Date(Math.min(...live.map((e) => latestSlot(e, nowMs)))).toISOString();
let posts;
try {
  const r = await fetch(`${REST}/api/conversations?author=board&since=${encodeURIComponent(since)}&limit=200`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  posts = await r.json();
  if (!Array.isArray(posts)) throw new Error('not a list');
} catch (e) {
  // Without the read there is no way to know whether the bell or an earlier fallback already posted.
  log(`room read failed, nothing posted: ${e.message}`);
  process.exit(1);
}

let failed = 0;
for (const d of fallbackDecide({ now: nowMs, entries: live, posts, seats: SEATS })) {
  if (d.action !== 'post') { log(`${d.key}: ${d.action}`); continue; }
  if (DRYRUN) { log(`${d.key}: DRY RUN, would post: ${d.body}`); continue; }
  try {
    const r = await fetch(`${REST}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'board', body: d.body }), signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    log(`${d.key}: posted ${(await r.json()).id}`);
  } catch (e) {
    failed++;
    log(`${d.key}: POST FAILED: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
