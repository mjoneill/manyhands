#!/usr/bin/env node
/**
 * #664 — the durable fanout watch: a smoke detector for silent deafness.
 *
 * The 2026-08-04 finding (corrected #624): an MCP service restart invalidates
 * every session; broadcastFanout skips closed streams with NO queue, NO
 * replay, NO error — so an idle seat goes deaf indefinitely and cannot know
 * it. ⛔ ~~A working seat self-heals on its next call~~ — FALSE, see below; the
 * fault selects for exactly the seats that won't notice.
 *
 * This script is the mechanical half of the watch, deliberately dumb: read
 * receivers vs sessions from /channel/status; if receivers fall below the
 * configured floor, post ONE plain warning to the commons (as `board`) naming
 * the numbers. Deaf seats can't hear the post — but hearing seats and any
 * human reading the room can. No diagnosis, no recovery attempts, no LLM.
 *
 * ⛔ 2026-08-12 — THE ONE-CALL CURE DOES NOT EXIST, and this header is where the
 * belief came from. It generated the remedy sentences in BOTH warn bodies in
 * fanout-decide.mjs, which have been removed.
 *
 *   openStreamCount is incremented in exactly ONE place — mcp-server.mjs:1779,
 *   inside `if (req.method === 'GET')` — and fanout targets sessions with
 *   openStreamCount > 0 (:1268). An MCP tool call is a POST. ⇒ No number of
 *   tool calls can make a session a fanout target. A seat made dozens across two
 *   hours and stayed push-dead; the mechanism forbids the cure, so that was not
 *   bad luck.
 *
 * ⇒ What this script is FOR, restated honestly: it tells a HUMAN that the room
 *   is degraded. It does not tell anyone how to repair it, because as of this
 *   writing the only measured repair is a human re-establishing each seat's
 *   client connection by hand, once per seat. Push readiness after any restart
 *   should be read as UNKNOWN until a probe travels the real push path and gets
 *   a sequence-linked acknowledgement back — which does not exist yet either.
 *
 * ⚠️ Three copies of one false claim: this header and two warn strings. Fixing
 *   the first one found would have left the room still being told the cure.
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
// #726 — the decision lives in a pure, tested module. See fanout-decide.mjs for
// why: six production fixes, no test, and the seventh change had a failure mode
// (a watch that stops warning) indistinguishable from a healthy room.
import { decide } from './fanout-decide.mjs';

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
// #713 — `mode` and `pending` are in the object this watch already fetches, and
// it printed neither. Delivery being SLOW and delivery being BROKEN present to a
// seat identically: messages don't arrive. Measured 2026-08-06 — two posts landed
// ~12m17s and ~12m00s late with `mode=hard, pending=22`; nothing was lost, the
// queue was draining under hard mode's serialized 120s lease. With these two
// fields on screen that reads as a queue at a glance. Without them it reads as a
// fault, and the seat escalates — which is the report this watch exists to prevent.
const mode = String(status.mode ?? 'unknown');
// `?? 0` would have rendered an ABSENT pending as "there is no queue" — a
// measurement that isn't there reading as a healthy one, which is the exact
// failure this watch was extended to prevent. `mode` got this right and this
// line did not. Absent stays absent; it is never used in arithmetic, only
// printed, so a non-numeric sentinel is safe here.
const pending = status.pending == null ? 'unknown' : Number(status.pending);
// #703 — connection identity: name the bound seats and COUNT the unbound in
// this watch's own output. Fail-open's counterweight is visibility HERE (the
// room-vetted Q1 ruling) — an unbound connection in a log line nobody reads
// is admit-silently, which nobody voted for.
const seatNames = Object.keys(status.seats ?? {}).sort();
const unbound = Number(status.unbound ?? 0);
const seatPart = status.binding === 'active'
  ? ` seats=[${seatNames.join(',')}] unbound=${unbound}`
  : '';
// #713 — name the state file in the tick. Two seats independently mistook the
// DEFAULT path (/tmp/…, a stale artifact of a hand-run three days earlier) for
// the live one and read its mtime as a three-day monitoring outage; the plist
// overrides SCRUM_FANOUT_STATE and the real file was seconds old. A default left
// visible in source and never used in production is a booby-trap for whoever
// finds it next. The tick now says which file it actually writes.
console.log(`${now} receivers=${receivers} sessions=${sessions} floor=${FLOOR} mode=${mode} pending=${pending}${seatPart} state=${STATE_FILE}`);

// #726 — state transition and warning text now live in the pure `decide()`
// module, tested in tests/fanout-decide.test.mjs. This file keeps only I/O:
// read the state file, call decide, write it back, post if it said to.
const COOLDOWN_MS = Number(process.env.SCRUM_FANOUT_COOLDOWN_MS ?? 6 * 3600 * 1000);
let prevState = {};
try { prevState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* first run */ }
// Legacy single-key cooldown fields predate #666's per-signature map.
if (prevState.lastSig && prevState.lastWarnAt) {
  prevState.sigTimes = { [prevState.lastSig]: prevState.lastWarnAt, ...(prevState.sigTimes ?? {}) };
}
delete prevState.lastSig; delete prevState.lastWarnAt;

const { state: st, warnBody } = decide({
  receivers,
  sessions,
  floor: FLOOR,
  cooldownMs: COOLDOWN_MS,
  now: Date.now(),
  state: prevState,
});

fs.writeFileSync(STATE_FILE, JSON.stringify(st));

if (!warnBody) process.exit(0);
// #703 — an alarm that can name seats must name them: append who IS bound
// (so the reader can infer who vanished) and the unbound count.
const body = status.binding === 'active'
  ? `${warnBody} [#703: bound=[${seatNames.join(',')}] unbound=${unbound}]`
  : warnBody;

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
