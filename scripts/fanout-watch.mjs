#!/usr/bin/env node
/**
 * #664 — the durable fanout watch: a smoke detector for silent deafness.
 *
 * The 2026-08-04 finding (corrected #624): an MCP service restart invalidates
 * every session; broadcastFanout skips closed streams with NO queue, NO
 * replay, NO error — so an idle seat goes deaf indefinitely and cannot know
 * it. A working seat self-heals on its next call; the fault selects for
 * exactly the seats that won't notice.
 *
 * This script is the mechanical half of the watch, deliberately dumb: read
 * receivers vs sessions from /channel/status; if receivers fall below the
 * configured floor, post ONE plain warning to the commons (as `board`) naming
 * the numbers. Deaf seats can't hear the post — but hearing seats and any
 * human reading the room can, and the one-call cure (any MCP tool call)
 * re-registers the deaf. No diagnosis, no recovery attempts, no LLM.
 *
 * Designed to run under launchd on an interval (see the plist note on the
 * card). State-change gated so a persistent gap warns once, not every tick.
 *
 * Env:
 *   SCRUM_STATUS_URL   default http://127.0.0.1:3001/channel/status
 *   SCRUM_POST_URL     default http://127.0.0.1:3141/api/conversations
 *   SCRUM_FANOUT_FLOOR default 3 (the number of seats that should be listening)
 *   SCRUM_FANOUT_STATE default /tmp/scrum-fanout-watch.state
 *   SCRUM_FANOUT_DRYRUN=1  print the would-be post instead of posting
 */

import fs from 'node:fs';

const STATUS_URL = process.env.SCRUM_STATUS_URL || 'http://127.0.0.1:3001/channel/status';
const POST_URL = process.env.SCRUM_POST_URL || 'http://127.0.0.1:3141/api/conversations';
const FLOOR = Number(process.env.SCRUM_FANOUT_FLOOR || 3);
const STATE_FILE = process.env.SCRUM_FANOUT_STATE || '/tmp/scrum-fanout-watch.state';
const DRYRUN = process.env.SCRUM_FANOUT_DRYRUN === '1';

const now = new Date().toISOString();

let status;
try {
  const r = await fetch(STATUS_URL, { signal: AbortSignal.timeout(5000) });
  status = await r.json();
} catch (e) {
  // The MCP server being down is a louder failure with its own healthcheck;
  // this watch only reports on fanout. Log and exit clean.
  console.log(`${now} status unreachable: ${e.message}`);
  process.exit(0);
}

const receivers = Number(status.receivers ?? NaN);
const sessions = Number(status.sessions ?? NaN);
console.log(`${now} receivers=${receivers} sessions=${sessions} floor=${FLOOR}`);

const prev = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, 'utf8').trim() : '';
const state = `${receivers < FLOOR ? 'LOW' : 'OK'}:${receivers}`;
fs.writeFileSync(STATE_FILE, state);

// Warn on entering-or-changing a LOW state only — a persistent gap is one
// warning, not one per tick; recovery quietly resets the gate.
if (receivers >= FLOOR || state === prev) process.exit(0);

const body = `⚠️ fanout watch: only ${receivers} of ${sessions} live sessions hold an open stream `
  + `(floor: ${FLOOR}). Seats without a stream receive NOTHING — no queue, no replay (#624). `
  + `If you can read this, you're fine; if a seat has been quiet since the last restart, it may be `
  + `deaf — any single MCP tool call re-registers it (the one-call cure). `
  + `changes_since covers whatever was missed.`;

if (DRYRUN) {
  console.log(`${now} DRYRUN would post: ${body}`);
  process.exit(0);
}

try {
  const r = await fetch(POST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body, author: 'board' }),
    signal: AbortSignal.timeout(5000),
  });
  console.log(`${now} warning posted: HTTP ${r.status}`);
} catch (e) {
  console.log(`${now} post failed: ${e.message}`);
}
