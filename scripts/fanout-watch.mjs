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
// #713 — `mode` and `pending` are in the object this watch already fetches, and
// it printed neither. Delivery being SLOW and delivery being BROKEN present to a
// seat identically: messages don't arrive. Measured 2026-08-06 — two posts landed
// ~12m17s and ~12m00s late with `mode=hard, pending=22`; nothing was lost, the
// queue was draining under hard mode's serialized 120s lease. With these two
// fields on screen that reads as a queue at a glance. Without them it reads as a
// fault, and the seat escalates — which is the report this watch exists to prevent.
const mode = String(status.mode ?? 'unknown');
const pending = Number(status.pending ?? 0);
// #703 — connection identity: name the bound seats and COUNT the unbound in
// this watch's own output. Fail-open's counterweight is visibility HERE (the
// room-vetted Q1 ruling) — an unbound connection in a log line nobody reads
// is admit-silently, which nobody voted for.
const seatNames = Object.keys(status.seats ?? {}).sort();
const unbound = Number(status.unbound ?? 0);
const seatPart = status.binding === 'active'
  ? ` seats=[${seatNames.join(',')}] unbound=${unbound}`
  : '';
console.log(`${now} receivers=${receivers} sessions=${sessions} floor=${FLOOR} mode=${mode} pending=${pending}${seatPart}`);

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
// #666: the cooldown gate is PER SIGNATURE. The first cut kept a
// single lastSig string, so an intervening signature (6→4) overwrote it and
// RELEASED the previous one's (5→4) gate — and both signatures were live and
// alternating the very morning it shipped. sigTimes maps signature →
// lastWarnAt: "warned about X at T; mute X until T+cooldown." Entries past
// the window are inert, so they're evicted on every run.
const COOLDOWN_MS = Number(process.env.SCRUM_FANOUT_COOLDOWN_MS ?? 6 * 3600 * 1000);
let st = { r: receivers, pendingFrom: null, warned: false, sigTimes: {} };
try { st = { ...st, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch { /* first run */ }
if (st.lastSig && st.lastWarnAt) st.sigTimes = { [st.lastSig]: st.lastWarnAt, ...st.sigTimes };
delete st.lastSig; delete st.lastWarnAt;
st.sigTimes ??= {};
// #690 migration: pair-keyed entries (`7->4`) become destination-keyed
// (`drop:4`). Dropping them instead would re-fire every muted signature the
// instant this ships — the same mid-incident-deploy trap #666 hit.
for (const [sig, at] of Object.entries(st.sigTimes)) {
  const pair = sig.match(/^\d+->(\d+)$/);
  if (!pair) continue;
  const key = `drop:${pair[1]}`;
  st.sigTimes[key] = Math.max(st.sigTimes[key] ?? 0, at);
  delete st.sigTimes[sig];
}
for (const [sig, at] of Object.entries(st.sigTimes)) {
  if (Date.now() - at >= COOLDOWN_MS) delete st.sigTimes[sig];
}

// #690 — THE COOLDOWN'S AXIS IS SEVERITY, NOT IDENTITY.
//
// This file already declared the rule ("the cooldown mutes repetition, never
// escalation") while keying on `${from}->${to}`, which is an IDENTITY. The two
// diverge the moment the destination rises: 7→6 is a different key from 7→4
// and fired, though 6 receivers is strictly better than the 4 already alarmed
// about. Restart churn WALKS the key space rather than repeating a key, so the
// mute was honest per-key and near-useless in aggregate — and every post still
// promised "muted for 6h", so the message and the behaviour disagreed.
//
// Rule: an alarm fires only if its destination is BELOW every destination
// currently muted in its own namespace. Repetition and improvement are silent;
// a worsening state always speaks.
const deepestMuted = (prefix) => {
  const depths = Object.keys(st.sigTimes)
    .filter((k) => k.startsWith(prefix))
    .map((k) => Number(k.slice(prefix.length)))
    .filter(Number.isFinite);
  return depths.length ? Math.min(...depths) : null;
};

let warnBody = null;
if (st.pendingFrom != null && receivers >= st.pendingFrom) {
  st.pendingFrom = null; st.warned = false;            // recovered
} else if (st.pendingFrom != null && receivers < st.pendingFrom) {
  const sig = `drop:${receivers}`;                      // #690: destination, not pair
  const deepest = deepestMuted('drop:');
  const inCooldown = deepest != null && receivers >= deepest;
  if (!st.warned && !inCooldown) {                      // drop persisted a second tick
    warnBody = `⚠️ fanout watch: receivers dropped ${st.pendingFrom} → ${receivers} and stayed there `
      + `across two ticks (${st.pendingFrom - receivers} seat stream(s) gone; ${sessions} sessions live; `
      + `mode=${mode}, pending=${pending}). `
      + `Seats without a stream receive NOTHING — no queue, no replay (#624). If you can read this you're `
      + `fine; a seat quiet since the last restart may be deaf — any single MCP tool call re-registers it. `
      + `changes_since covers whatever was missed. (This signature now mutes for `
      + `${Math.round(COOLDOWN_MS / 3600000)}h; a deeper drop still fires immediately.)`;
    st.warned = true; st.sigTimes[sig] = Date.now();
  } else if (!st.warned) {
    st.warned = true;                                   // suppressed by cooldown — still gate once
  }
} else if (receivers < st.r) {
  // Settle-vs-drop (2026-08-04 17:15Z false positive): a deploy makes seats
  // re-register in a burst, the count spikes above baseline, then settles —
  // and the old logic took the spike as the floor, reporting the return to
  // normal as a fault AT THE EXACT MOMENT the room watches hardest. A drop
  // TO a level held for most of recent history is the spike receding, not
  // seats lost: adopt it silently. A drop below every recently-held level
  // (the real fault) still arms. Fix lives in what counts as a drop, never
  // in floor or cooldown.
  const hist = st.hist || [];
  const heldCount = hist.filter((r) => r === receivers).length;
  if (heldCount >= Math.ceil(hist.length / 2) && hist.length >= 4) {
    st.r = receivers;                                   // settle: new (old) baseline
  } else {
    st.pendingFrom = st.r;                              // first tick of a drop — arm, don't warn
  }
}
// Only HEALTHY readings enter the held-level memory: a level held during an
// armed or warned incident is a fault's plateau, not a baseline — without
// this, a real drop back to a previously-faulted level would settle silently.
if (st.pendingFrom == null && !st.warned) {
  st.hist = [...(st.hist || []), receivers].slice(-12);
}
// #668: the floor path shares the per-signature cooldown. Its old gate was
// st.warned alone, which every recovery resets — so a bouncing collapse
// re-fired on each dip, the #666 fatigue defect relocated to the branch that
// handles the WORSE fault. The warned flag is deliberately NOT a condition
// here: it belongs to the delta incident, and gating on it muted a collapse
// that DEEPENED mid-incident (and a total collapse following an ordinary
// delta warning — escalation silenced by a lesser alarm). Per-depth
// signatures carry the muting; escalation always fires. Only one post per
// tick either way: floor's warnBody overwrites delta's.
if (receivers < FLOOR) {                                // total-collapse floor, secondary
  // #690: floor had the SAME defect in milder form. Keying on destination
  // alone is necessary and NOT sufficient — floor:2 after floor:0 was still a
  // fresh key for a strictly better state. (The #690 card called this path
  // "the right shape to copy"; reading it properly, it was half the shape.)
  const floorSig = `floor:${receivers}`;
  const floorDeepest = deepestMuted('floor:');
  if (floorDeepest == null || receivers < floorDeepest) {
    warnBody = `⚠️ fanout watch: only ${receivers} of ${sessions} live sessions hold an open stream `
      + `(floor: ${FLOOR}). Seats without a stream receive NOTHING — no queue, no replay (#624). `
      + `Any single MCP tool call re-registers a deaf seat; changes_since covers whatever was missed. `
      + `(This signature now mutes for ${Math.round(COOLDOWN_MS / 3600000)}h; a deeper collapse still fires immediately.)`;
    st.sigTimes[floorSig] = Date.now();
  }
  st.warned = true;
}
st.r = receivers;
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
