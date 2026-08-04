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

// State across ticks. THE FAULT IS A DELTA, NOT A LEVEL (review's correction,
// 02:33Z, pre-first-exam): the 48-minute deafening that motivated this watch
// showed up as receivers 5 → 4 — a floor of 3 would never have fired, and a
// restart taking 7 → 4 is three seats deafened while "4 > 3" reads healthy.
// So the primary trigger is a DROP that persists two consecutive ticks
// (one-tick dips are re-registration churn); the floor stays as the second
// condition, catching total collapse. Warn once per incident; recovery to
// the pre-drop level clears the gate.
// Overnight 2026-08-04 lesson: a ~20-minute PERIODIC process (a cron-driven
// session holding a stream for half its cycle) produced 5,5,4,4 forever —
// each dip passed the two-tick gate, each rise reset the warned flag, and
// the watch posted ~17 identical warnings in one night. Alert fatigue is
// the death of a panel (the room's own finding). So: a warning SIGNATURE
// (from→to) may fire at most once per cooldown window. A DEEPER drop is a
// new signature and fires immediately — the cooldown mutes repetition,
// never escalation.
const COOLDOWN_MS = Number(process.env.SCRUM_FANOUT_COOLDOWN_MS ?? 6 * 3600 * 1000);
let st = { r: receivers, pendingFrom: null, warned: false, lastSig: null, lastWarnAt: 0 };
try { st = { ...st, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch { /* first run */ }

let warnBody = null;
if (st.pendingFrom != null && receivers >= st.pendingFrom) {
  st.pendingFrom = null; st.warned = false;            // recovered
} else if (st.pendingFrom != null && receivers < st.pendingFrom) {
  const sig = `${st.pendingFrom}->${receivers}`;
  const inCooldown = st.lastSig === sig && (Date.now() - st.lastWarnAt) < COOLDOWN_MS;
  if (!st.warned && !inCooldown) {                      // drop persisted a second tick
    warnBody = `⚠️ fanout watch: receivers dropped ${st.pendingFrom} → ${receivers} and stayed there `
      + `across two ticks (${st.pendingFrom - receivers} seat stream(s) gone; ${sessions} sessions live). `
      + `Seats without a stream receive NOTHING — no queue, no replay (#624). If you can read this you're `
      + `fine; a seat quiet since the last restart may be deaf — any single MCP tool call re-registers it. `
      + `changes_since covers whatever was missed. (This signature now mutes for `
      + `${Math.round(COOLDOWN_MS / 3600000)}h; a deeper drop still fires immediately.)`;
    st.warned = true; st.lastSig = sig; st.lastWarnAt = Date.now();
  } else if (!st.warned) {
    st.warned = true;                                   // suppressed by cooldown — still gate once
  }
} else if (receivers < st.r) {
  st.pendingFrom = st.r;                                // first tick of a drop — arm, don't warn
}
if (receivers < FLOOR && !st.warned) {                  // total-collapse floor, secondary
  warnBody = `⚠️ fanout watch: only ${receivers} of ${sessions} live sessions hold an open stream `
    + `(floor: ${FLOOR}). Seats without a stream receive NOTHING — no queue, no replay (#624). `
    + `Any single MCP tool call re-registers a deaf seat; changes_since covers whatever was missed.`;
  st.warned = true;
}
st.r = receivers;
fs.writeFileSync(STATE_FILE, JSON.stringify(st));

if (!warnBody) process.exit(0);
const body = warnBody;

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
