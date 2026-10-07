#!/usr/bin/env node
/**
 * scripts/guest-once.mjs — #1201 slice 1, the runnable form.
 *
 *   node scripts/guest-once.mjs --agent agents/gizmo.json [--dry-run] [--once-id <messageId>]
 *
 * Wakes a GUEST agent exactly once: scans the board-level commons for new
 * @-mentions of its seat key (since the last one it answered, kept in a state
 * file), hands it bounded context, makes ONE model call through the adapter,
 * posts the reply as the agent, and appends a pre-ledger row. No daemon: run it
 * from a schedule or by hand. That is the restart-to-invite constraint this
 * slice proves the loop under; P4 (roster as a query) removes it.
 *
 * The agent file:
 *   { "seatKey": "gizmo", "name": "Gizmo", "systemPrompt": "…", "contextPolicy": "thread",
 *     "model": { "model": "gemma4:26b", "protocol": "ollama-native", "baseUrl": "http://localhost:11434" } }
 *
 * ⛔ Never a key in the file: `model.apiKeyRef` names an env var; the value is
 * read at call time and never written anywhere (#1197's rule).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { callModel } from '../core/model-adapter.mjs';
import { deliveryStaleMs, isStaleDelivery } from '../core/delivery.mjs';   // #1346
import { rowToBoard, refusalsSince } from '../core/model-call-row.mjs';
import { handBackFromState, defaultWithheldStatePath } from '../core/withheld-state.mjs';   // #1428 — private per-seat withheld recovery
import { annotateTalks } from '../core/guest-loop.mjs';   // #1446
import { findMentions, findWakes, pairCapSuppressed, DEFAULT_PAIR_CAP_PER_HOUR, guestOnce, fetchBoundedChanges, shouldMarkAnswered, mentionScanPath, fetchMentionWindow, advanceScan, settlePending, sweepDue, sweepSince, captureSweep, withSweepAttempt, acquireLock, releaseLock, effectiveWakeOn, budgetCheck, deliveryOutcome, bindingRulings } from '../core/guest-loop.mjs';
import { makeExecutor } from '../core/board-tools.mjs';
import { makeHandedCapture } from '../core/handed-dump.mjs';   // #1567 PC5
const handedCapture = process.env.SCRUM_HANDED_DUMP
  ? makeHandedCapture({ file: process.env.SCRUM_HANDED_DUMP, wakeId: process.env.SCRUM_HANDED_WAKE_ID || null })
  : (fn) => fn;

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const has = (k) => args.includes(k);
const BOARD = process.env.SCRUM_BOARD_URL || 'http://127.0.0.1:3141';
// #1561 launch — this seat's own board key, read from SCRUM_SEAT_TOKEN_FILE (the MCP
// server's convention). The unit's write routes (memories, decisions, seat state) refuse a
// keyless write. It is sent ONLY to BOARD: this module-local fetch shadows the global one for
// the board calls below; core/model-adapter.mjs calls the model provider with the GLOBAL
// fetch, so the key never leaves for it.
const SEAT_BEARER = (() => {
  const f = process.env.SCRUM_SEAT_TOKEN_FILE;
  if (!f) return null;
  try { return fs.readFileSync(f, 'utf8').trim() || null; } catch (e) { console.error(`[#1561] SCRUM_SEAT_TOKEN_FILE unreadable (${e.code || e.message}) — memory, decision and seat writes will be refused`); return null; }
})();
const fetch = (url, opts = {}) => {
  const u = String(url);
  if (!SEAT_BEARER || !(u === BOARD || u.startsWith(`${BOARD}/`))) return globalThis.fetch(url, opts);
  return globalThis.fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${SEAT_BEARER}` } });
};
const agentFile = opt('--agent');
const seatArg = opt('--seat');
if (!agentFile && !seatArg) { console.error('usage: guest-once.mjs (--agent <file.json> | --seat <seatKey>) [--dry-run] [--once-id <messageId>]'); process.exit(2); }
const dry = has('--dry-run');
// #1199 — the agent can be a BOARD ENTITY rather than a file: `--seat gizmo`
// reads /api/agents?seat=gizmo and runs its CURRENT prompt version, whose id
// goes into the model-call ledger row so "which prompt wrote that post" holds.
let agent;
if (seatArg) {
  const r = await fetch(`${BOARD}/api/agents?seat=${encodeURIComponent(seatArg)}`);
  const list = r.ok ? await r.json() : [];
  if (!list.length) { console.error(`no agent with seatKey "${seatArg}" on ${BOARD} — agent_create it, or pass --agent <file>`); process.exit(2); }
  const a = list[0];
  if (a.state === 'retired') { console.error(`${seatArg} is retired; not waking it`); process.exit(2); }
  agent = { seatKey: a.seatKey, name: a.name, systemPrompt: a.prompt?.body ?? '', promptVersion: a.prompt?.id ?? null,
    contextPolicy: a.contextPolicy, residency: a.residency, budgetPerDay: a.budgetPerDay ?? undefined,
    toolGrants: a.toolGrants ?? [], wakeOn: a.wakeOn ?? ['mention'], everyMinutes: a.everyMinutes ?? undefined,
    deliveryMode: a.deliveryMode ?? 'wake',   // #1346 — the wire carries it; a runner that drops it runs the seat in wake mode whatever the board says
    // #1473 — the memory budget. A runner that drops it wakes the seat on the
    // newest-ten slice whatever the board says (found by the seam test: this
    // hand-picked list is where a new agent field silently goes missing).
    ...(a.memoryBudgetBytes ? { memoryBudgetBytes: a.memoryBudgetBytes } : {}),
    // #1196 — the seat's own hop ceiling. Carried from the board or left off
    // entirely: `undefined` lets the loop keep its default, where a `null` would
    // read as "a ceiling of nothing" one layer down.
    ...(a.maxHops == null ? {} : { maxHops: a.maxHops }),
    // #1196 — the role's reasoning setting rides to the adapter on the MODEL
    // spec, because that is the object callModel is handed. Left off entirely
    // when the board says nothing, so a model with no such flag is sent none.
    model: a.thinking == null ? a.model : { ...a.model, thinking: a.thinking } };   // #1226
} else {
  agent = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
}
// #1376 — the ROLE this seat holds on the board rides into the prompt as
// state, read at wake from the live declaration; '' when none. A dead
// endpoint is logged and the wake proceeds without a section (never a guess).
try {
  const rs = await fetch(`${BOARD}/api/seats/${encodeURIComponent(agent.seatKey)}/role-section`);
  const rj = rs.ok ? await rs.json() : null;
  agent.roleSection = rj && typeof rj.section === 'string' ? rj.section : '';
  agent.roleKey = rj?.role?.key ?? null;   // #1436 — the held role's key, for the rulings match
  console.log(`[#1376] role: ${rj?.role?.key ?? 'none'}${rj?.role?.key ? ` — section ${agent.roleSection.split('\n')[0].slice(0, 80)}` : ''}`);
} catch (e) { agent.roleSection = ''; console.error(`[#1376] role section unreadable (${e?.message ?? e}) — waking without one`); }
// #1631 — the state file now carries the pending mentions, so it is replaced whole (temp file + rename), never truncated
// and rewritten in place: a run killed mid-write must not leave a half file that reads as "no state" and forgets them.
function writeStateAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
const stateFile = process.env.SCRUM_GUEST_STATE_FILE || (agentFile ? path.join(path.dirname(agentFile), `.${agent.seatKey}.guest-state.json`) : path.join(process.cwd(), `.${agent.seatKey}.guest-state.json`));

const get = async (p) => { const r = await fetch(`${BOARD}${p}`); if (!r.ok) throw new Error(`GET ${p} → ${r.status}`); return r.json(); };
const post = async (body) => {
  if (dry) { console.log(`[dry-run] would post as ${body.author}:\n${body.body}`); return { id: null }; }
  const r = await fetch(`${BOARD}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`POST /api/conversations → ${r.status}`);
  return r.json();
};

let state = {};
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first wake */ }
// #1237 — one run at a time per seat: the launchd tick and a hand run must not
// both answer one mention. The lock sits beside the state file.
const lockPath = `${stateFile}.lock`;
const lock = dry ? { acquired: true } : acquireLock(lockPath);
if (!lock.acquired) { console.log(`${new Date().toISOString()} ${agent.seatKey}: lock held by another run (pid ${lock.holder?.pid ?? '?'} since ${lock.holder?.at ?? '?'}) — doing nothing`); process.exit(0); }
if (lock.broke) console.error(`[#1237] ${agent.seatKey}: broke a STALE lock (pid ${lock.broke.pid}, held ${Math.round(lock.heldMs / 1000)}s) — a run died mid-wake; check the log above this line`);
if (!dry) { const done = () => releaseLock(lockPath); process.on('exit', done); for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { done(); process.exit(1); }); }
// #1237 — scan by SINCE cursor, not the newest 60: a mention buried under a busy
// night was invisible for good. mentionScanPath is tested.
// #1274 — and the scan's OWN ceiling: the server clamps that limit to 200 and
// returns the NEWEST 200, silently. On a busy stretch the rows nearest the
// cursor — the unanswered ones — were the rows dropped. fetchMentionWindow
// pages backward with `before` until the window is whole; a quiet tick still
// costs exactly one request.
const getPage = async (p) => {
  const r = await fetch(`${BOARD}${p}`);
  if (!r.ok) throw new Error(`GET ${p} → ${r.status}`);
  const body = await r.json();
  const rows = Array.isArray(body) ? body : (body?.conversations ?? []);
  const total = r.headers.get('x-total-count');   // #1010's count, taken BEFORE the limit
  return { rows, total: total == null ? null : Number(total) };
};
// #1608 — A SEAT THAT CANNOT BE WOKEN BY A MENTION DOES NOT SCAN FOR MENTIONS. In channel mode effectiveWakeOn drops
// `mention` (#1346): every post addressed to the seat arrives as a DELIVERY, a durable per-post record whose outcome
// (published / declined / failed, claimable again) is the obligation ledger. The scan's rows were read and discarded:
// measured 2026-10-06, one channel-mode seat's cursor (advanced only by mention wakes it can never take) had frozen at
// 09-13 and it read 25 pages × 200 posts every minute, 5,996 incomplete scans in its log. `--once-id` still scans.
const scansMentions = effectiveWakeOn(agent).includes('mention') || Boolean(opt('--once-id'));
// #1631 — the time every scan decision is made at. SCRUM_GUEST_NOW (an ISO instant) is the test seam for the clock: it
// moves the runner's own time decisions (window, rewind, sweep due, sweep window), never the board's stamps.
const NOW = (() => { const v = process.env.SCRUM_GUEST_NOW; if (v && Number.isFinite(Date.parse(v))) return new Date(Date.parse(v)).toISOString(); return new Date().toISOString(); })();
const window_ = scansMentions
  ? await fetchMentionWindow(getPage, state, NOW)
  : { messages: [], complete: true, pages: 0, truncated: null };
if (!scansMentions) console.log(`[#1608] ${agent.seatKey}: no mention scan (wakeOn has no mention in ${agent.deliveryMode ?? 'wake'} mode; deliveries carry the obligations)`);
const messages = window_.messages;
if (!window_.complete) {
  // ⛔ Reported, never absorbed: the seat cannot see this and nobody else is looking.
  console.error(`[#1274] ${agent.seatKey}: SCAN INCOMPLETE — read ${window_.truncated.seen} of ${window_.truncated.total} posts since ${window_.truncated.since} in ${window_.truncated.pages} pages. Mentions older than the oldest row read were NOT scanned.`);
  // …and kept, because a line in a launchd log is not somewhere the seat can
  // look. The state file is the one artifact the seat carries between wakes.
  state.lastScanIncomplete = { at: new Date().toISOString(), ...window_.truncated };
  // Written NOW, not at the end: the run that finds nothing to wake for exits
  // before the state write, and that is exactly the run whose silence needs
  // explaining.
  if (!dry) { try { writeStateAtomic(stateFile, state); } catch (e) { console.error(`[#1274] could not record the incomplete scan: ${e.message}`); } }   // #1631 — whole-file replace: it holds owed mentions
} else if (state.lastScanIncomplete) {
  state.lastScanIncomplete = null;
}
// #1631 — capture every unsettled mention the scan found into `pending`, and move `scannedThrough` to the newest post
// read, in ONE atomic state write BEFORE anything else this wake does: the next wake then reads only what is new, and a
// mention this wake fails to answer (a refused reply post, a killed run) is still owed from `pending`.
if (scansMentions && window_.complete && !opt('--once-id')) {
  const before = { n: (state.pending || []).length, through: state.scannedThrough ?? null };
  state = advanceScan(state, window_, agent.seatKey, { now: NOW });
  if (state.pendingOverflow) console.error(`[#1631] ${agent.seatKey}: PENDING FULL — ${state.pendingOverflow.owed} owed mentions over the ${state.pendingOverflow.max} cap; the scan cursor is NOT moved (no mention is dropped; the window stays wide until some are settled)`);
  if (!dry && ((state.pending || []).length !== before.n || (state.scannedThrough ?? null) !== before.through)) writeStateAtomic(stateFile, state);
}
// #1631 — THE RECOVERY SWEEP (contract item 2): at most hourly, or now with --sweep-now. Its progress moves only on a
// complete sweep whose captures were written; anything else leaves the interval to grow for the next one.
if (scansMentions && !opt('--once-id') && sweepDue(state, NOW, { force: args.includes('--sweep-now') })) {
  const sweepStart = NOW;
  // BEFORE attempting: pin the first sweep's lower bound (a failed first sweep cannot let it slide) and record the attempt
  // (a failed sweep is retried no sooner than SWEEP_RETRY_MS), in one atomic write.
  state = withSweepAttempt(state, NOW);
  if (!dry) writeStateAtomic(stateFile, state);
  const sweepFrom = sweepSince(state, NOW);
  let swept = null;
  try { swept = await fetchMentionWindow(getPage, { lastAnsweredAt: sweepFrom }, NOW, { maxPages: 100 }); }
  catch (e) { console.error(`[#1631] ${agent.seatKey}: recovery sweep failed (${e.message}) — progress NOT moved; the next sweep covers this interval too`); }
  if (swept && !swept.complete) console.error(`[#1631] ${agent.seatKey}: recovery sweep INCOMPLETE (${swept.truncated?.seen ?? '?'} of ${swept.truncated?.total ?? '?'} posts) — progress NOT moved`);
  if (swept && swept.complete) {
    const n0 = (state.pending || []).length;
    const next = captureSweep(state, swept, agent.seatKey, { sweepStart });
    if (next.pendingOverflow) console.error(`[#1631] ${agent.seatKey}: recovery sweep found more owed mentions than pending can hold — progress NOT moved`);
    else {
      state = next;
      if (!dry) writeStateAtomic(stateFile, state);
      console.log(`[#1631] ${agent.seatKey}: recovery sweep complete (${swept.pages} page(s), ${swept.messages.length} posts since ${sweepFrom}, ${state.pending.length - n0} newly captured)`);
    }
  }
}
// #1226 — wake sources are the agent's data. Cards are fetched only when a
// kind needs them; a mention-only agent costs what slice 1 cost.
let cards = [];
if ((agent.wakeOn || []).includes('assignment')) {
  try { const c = await get('/api/cards?limit=500&fields=id,shortId,title,assignees,claimedBy,updatedAt,createdAt'); cards = Array.isArray(c) ? c : (c?.cards ?? []); }
  catch (e) { console.error(`[#1226] cards unreadable — no assignment wakes this run: ${e.message}`); }
}
// The board's REST blocks for tens of seconds during a graph sync under load
// (measured 20–66 s on 2026-09-05). A budget read that gives up at the first
// stall halts the loop for a reason that has nothing to do with the budget, so:
// a bounded wait, and one retry, before "unreadable" is allowed to mean halt.
const spentToday = async (seat) => {
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);
  const url = `${BOARD}/api/model-calls?agent=${encodeURIComponent(seat)}&since=${since.toISOString()}`;
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(90_000) });
      if (!r.ok) throw new Error(`GET /api/model-calls → ${r.status}`);
      return r.json();
    } catch (e) { last = e; if (attempt === 0) await new Promise((res) => setTimeout(res, 5_000)); }
  }
  throw last;
};

// #1411 — the seats with a runner, so a resident's reply naming only residents
// is reply-to-reply and does not wake this one. Read from the board's agent
// records (every seat a runner serves is one); unreadable ⇒ the rule is off and
// the run says so, rather than a silent stricter or looser scan.
let residents = null;
try {
  const ar = await fetch(`${BOARD}/api/agents`);
  if (ar.ok) residents = new Set((await ar.json()).filter((a) => a && a.seatKey && a.state !== 'retired').map((a) => String(a.seatKey).toLowerCase()));
  else console.error(`[#1411] ${agent.seatKey}: could not read /api/agents (${ar.status}) — resident-echo rule OFF this run`);
} catch (e) { console.error(`[#1411] ${agent.seatKey}: could not read /api/agents (${e.message}) — resident-echo rule OFF this run`); }
// #1411 slice 2 — the PAIR CAP: reply-wakes a pair of residents may spend on
// each other per hour, a Settings-page number (channel config
// `residents.replyWakesPerPairPerHour`, default 3; 0 = residents never wake
// residents). Read live so an owner's edit applies at the next tick.
let perHour = DEFAULT_PAIR_CAP_PER_HOUR;
try { const cfg = await get('/api/config'); if (Number.isFinite(Number(cfg?.residents?.replyWakesPerPairPerHour))) perHour = Number(cfg.residents.replyWakesPerPairPerHour); }
catch (e) { console.error(`[#1411] ${agent.seatKey}: could not read /api/config (${e.message}) — pair cap at the default ${perHour}`); }
// The spend is counted over the LAST HOUR of the commons, not the scan window
// (which starts at this seat's last answer and so forgets the pair's earlier
// posts). Same pager, a fixed one-hour cursor.
let history = messages;
if (residents && scansMentions) {   // #1608 — the pair cap only governs mention wakes
  try { history = (await fetchMentionWindow(getPage, { lastAnsweredAt: new Date(Date.now() - 3600_000).toISOString() })).messages; }
  catch (e) { console.error(`[#1411] ${agent.seatKey}: could not read the last hour for the pair cap (${e.message}) — counting over the scan window`); }
}
let wakes = findWakes({ agent, messages, cards, state, residents, perHour, history, pending: scansMentions && !opt('--once-id') ? (state.pending || []) : [] });   // #1631 — window ∪ pending
// A capped mention is SAID ONCE, not silently dropped: one line from this seat
// per hour, naming nobody (so it wakes nobody), so a reader of the commons can
// see why a resident went quiet on another. The cap re-arms when the hour
// slides or when a human or terminal seat names her.
if (residents && !opt('--once-id')) {
  const held = pairCapSuppressed(messages, agent.seatKey, { residents, perHour, sinceId: state.lastAnsweredId ?? null, history });
  if (held.length) {
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const saidAlready = history.some((m) => String(m.author || '').toLowerCase() === agent.seatKey.toLowerCase() && /reply cap reached/.test(m.body || '') && m.createdAt > hourAgo);
    const others = [...new Set(held.map((m) => m.author))].join(', ');
    if (saidAlready) console.log(`[#1411] ${agent.seatKey}: ${held.length} mention(s) from ${others} held by the pair cap (${perHour}/h); already said this hour`);
    else if (dry) console.log(`[dry-run] would post the pair-cap line (${others})`);
    else {
      try {
        await fetch(`${BOARD}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ author: agent.seatKey, body: `⏸ ${agent.name || agent.seatKey}: reply cap reached with ${others} (${perHour} reply-wakes per pair per hour) — quiet on that thread until the hour passes or a human or terminal seat names me.` }) });
        console.log(`[#1411] ${agent.seatKey}: pair cap (${perHour}/h) held ${held.length} mention(s) from ${others}; said so once`);
      } catch (e) { console.error(`[#1411] ${agent.seatKey}: pair-cap line failed to post: ${e.message}`); }
    }
  }
}
if (opt('--once-id')) wakes = messages.filter((m) => m.id === opt('--once-id')).map((m) => ({ kind: 'mention', ...m }));

// #1346 slice 3 — CHANNEL MODE: the room reaches this seat as delivery records
// (offered by the fanout, one per post). Drain "offered to me, not yet
// claimed" into ONE digest turn. Assignment wakes (above) come first — an
// obligation before the room — so a busy room cannot starve an assigned card.
// #1617 — every delivery step of one loop in ONE request: the batch route applies them in order under one lock with one
// document write (one per step was 3N full-document writes per digest turn). The answer is per entry, in order, each the
// single route's own status and body. A server without the route (404/405) gets the per-id requests, as before.
async function deliverySteps(entries) {
  if (!entries.length) return [];
  // #1582 — every step carries its own requestId: a board with deliveries in the graph requires one (and a resend of the
  // same step must reuse it, which this loop never does: one request per step); a board without the unit ignores it.
  const full = entries.map((e) => ({ source: 'guest-runner', by: agent.seatKey, requestId: crypto.randomUUID(), ...e }));
  if (dry) { for (const e of full) console.log(`[dry-run] would mark delivery ${e.id} ${e.state}`); return full.map((e) => ({ id: e.id, status: 201, body: null })); }
  try {
    const r = await fetch(`${BOARD}/api/deliveries/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(full) });
    if (r.status !== 404 && r.status !== 405) {
      const b = await r.json().catch(() => null);
      if (r.ok && b && Array.isArray(b.results)) return b.results;
      return full.map((e) => ({ id: e.id, status: r.status, body: b }));
    }
  } catch (e) { return full.map((x) => ({ id: x.id, status: 0, body: { error: e.message } })); }
  const out = [];
  for (const { id, ...body } of full) {
    try {
      const r = await fetch(`${BOARD}/api/deliveries/${encodeURIComponent(id)}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      out.push({ id, status: r.status, body: await r.json().catch(() => null) });
    } catch (e) { out.push({ id, status: 0, body: { error: e.message } }); }
  }
  return out;
}
const channelMode = agent.deliveryMode === 'channel' && !opt('--once-id');
let claimed = [];
if (channelMode && !wakes.length) {
  let openList = [];
  try {
    const mine = (await get(`/api/deliveries?to=${encodeURIComponent(agent.seatKey)}`)).deliveries ?? [];
    // THE STALE SWEEP (slice 3 review): a runner that claimed, started its
    // turn and died leaves a record no producer can move. Older than the
    // window ⇒ failed (reason: stale), which makes it claimable again below
    // at attempt +1. Inside the window it is somebody's turn — untouched.
    const staleMs = deliveryStaleMs();
    const stale = mine.filter((x) => isStaleDelivery(x, { staleMs }));
    const staleResults = await deliverySteps(stale.map((d) => ({ id: d.id, state: 'failed', reason: 'stale', note: `no outcome ${Math.round(staleMs / 1000)}s after ${d.state}` })));
    for (const [i, d] of stale.entries()) console.log(`[#1346] ${agent.seatKey}: delivery ${d.id} was ${d.state} past the stale window — marked failed (${staleResults[i]?.status}); reclaimable`);
    openList = (await get(`/api/deliveries?to=${encodeURIComponent(agent.seatKey)}&open=1`)).deliveries ?? [];
  }
  catch (e) { console.error(`[#1346] ${agent.seatKey}: deliveries unreadable — nothing drained this run: ${e.message}`); }
  if (openList.length) {
    // The budget is read BEFORE any claim. A breached budget must leave the
    // deliveries open and unclaimed — a claim-then-halt every tick would burn
    // an attempt a minute and turn the record into noise.
    const budget = await budgetCheck({ agent, spentToday });
    if (!budget.allowed) {
      console.log(`[#1346] ${agent.seatKey}: ${openList.length} deliver${openList.length === 1 ? 'y' : 'ies'} open, left unclaimed — ${budget.reason}${budget.spent != null ? ` (spent ${budget.spent} of ${budget.budget})` : ''}`);
      process.exit(0);
    }
    const claims = await deliverySteps(openList.map((d) => ({ id: d.id, state: 'runner-claimed' })));
    for (const [i, d] of openList.entries()) {
      const r = claims[i] || { status: 0 };
      if (r.status === 201) claimed.push(d);
      else console.log(`[#1346] ${agent.seatKey}: delivery ${d.id} not claimed (${r.status}${r.body?.state ? ` — ${r.body.state}` : ''})`);
    }
    if (claimed.length) {
      const posts = [];
      for (const d of claimed) {
        try {
          const m = await get(`/api/conversations/${encodeURIComponent(d.conversation)}`);
          // #1600 — a post redacted before this read answers as a tombstone ({id, postSeq, redacted: true, body: null}). It is
          // handed over as what it is, a redaction marker, never as `undefined: null` and never with anything it said.
          if (m && m.redacted === true) posts.push({ id: m.id, author: 'redacted', body: 'This post was redacted.', createdAt: null, attachedTo: null, conversation: null });
          else posts.push({ id: m.id, author: m.author, body: m.body, createdAt: m.createdAt, attachedTo: m.attachedTo || null, conversation: m.conversation || null });   // #1368 — a card thread's post carries its thread; #1401 — and its talk tag
        }
        catch (e) { console.error(`[#1346] ${agent.seatKey}: message ${d.conversation} unreadable, delivered as such: ${e.message}`); posts.push({ id: d.conversation, author: '?', body: '(message unreadable)', createdAt: d.offeredAt }); }
      }
      posts.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
      const newest = posts.at(-1);
      // #1368 — REPLY WHERE ASKED. A digest whose posts all sit in ONE card
      // thread (a grooming ask) is answered IN that thread, not on the commons:
      // "the owner's questions and the PO's answers are on the record" means
      // on the card's record. Mixed or board-level posts answer board-level.
      const threads = new Set(posts.map((m) => m.attachedTo || null));
      const attachedTo = threads.size === 1 ? [...threads][0] : null;
      // #1401 — same rule for the talk tag: a digest whose posts all carry ONE
      // tag is answered into that talk; mixed or untagged answers untagged.
      const talks = new Set(posts.map((m) => m.conversation || null));
      const conversation = talks.size === 1 ? [...talks][0] : null;
      wakes = [{ kind: 'channel', id: `channel:${newest?.id ?? new Date().toISOString()}`, createdAt: newest?.createdAt ?? new Date().toISOString(), author: null, body: '', posts, messageIds: posts.map((m) => m.id), deliveries: claimed.map((d) => d.id), attachedTo, conversation }];
      await deliverySteps(claimed.map((d) => ({ id: d.id, state: 'turn-started' })));
    }
  }
}
if (!wakes.length) { console.log(`${new Date().toISOString()} ${agent.seatKey}: nothing to wake for (${channelMode ? 'channel' : effectiveWakeOn(agent).join(', ')})`); process.exit(0); }

const wake = wakes[0];   // ONE wake per run — guest-once means once
// #1446 — whose talk is it? Stamp the wake (and each post) with the seat the
// talk is WITH, so the reply is filed into a talk only when it is this seat's
// own, and the wake shows which posts belong to someone else's talk. If the
// lookup fails, answer in the ROOM (the contract's safe side), never a guess.
if ((typeof wake.conversation === 'string' && wake.conversation) || (Array.isArray(wake.posts) && wake.posts.some((m) => m.conversation))) {
  try {
    const t = await get('/api/talks');
    annotateTalks(wake, Array.isArray(t) ? t : (t?.talks ?? []));
  } catch (e) {
    console.error(`[#1446] ${agent.seatKey}: talks unreadable (${e.message}) — answering in the room`);
    annotateTalks(wake, []);
  }
}
const sinceIso = new Date(Date.parse(wake.createdAt || Date.now()) - 60 * 60 * 1000).toISOString();
const getRaw = async (p) => { const r = await fetch(`${BOARD}${p}`); let body = null; try { body = await r.json(); } catch { /* none */ } return { status: r.status, body }; };
// #1561 — an unreadable list is rethrown through changes() so the wake says "could not be read", never shows it empty
let rows = []; let changesError = null;
try { rows = await fetchBoundedChanges(getRaw, sinceIso); }
catch (e) { changesError = e; console.error(`[#1201] changes unreadable — answering from the mention alone: ${e.message}`); }
// #1202 — the ledger row goes to the board as a scrum:ModelCall node; the JSONL
// file is the fallback if the board refuses, and the row says which happened.
// #1441 — the builder lives in core/model-call-row.mjs so tests exercise the real one.

const ledgerSink = dry ? null : async (row) => {
  // #1582 — one requestId per ledger row, so a board with model calls in the graph records it once.
  const r = await fetch(`${BOARD}/api/model-calls`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...rowToBoard(row, agent), requestId: crypto.randomUUID() }) });
  if (!r.ok) throw new Error(`POST /api/model-calls → ${r.status}`);
  return r.json();
};
// #1226 — the resident's memory: read by OWNER (its seat), written as a memory
// row under that owner. The mentioning human hands nothing.
// #1441 — refused REMEMBER lines since the seat last wrote memory, read from
// its recent board rows (newest first); the rule lives in core/model-call-row.mjs.
// #1428 PRIVACY — WITHHELD-REPLY HAND-BACK reads the resident's PRIVATE per-seat
// file (core/withheld-state.mjs). The recoverable body never reaches the board,
// so the runner does not fetch /api/model-calls for the text — it walks the file
// next to the state file.
const priorRefusals = async (seat) => {
  const j = await get(`/api/model-calls?agent=${encodeURIComponent(seat)}&limit=10`);
  return refusalsSince(j?.calls);
};
const priorWithheld = async (seat) => {
  // The default file path mirrors the guest-state file convention.
  const file = `${stateFile}.withheld-state.json`;
  return handBackFromState(file, { cap: 5 });
};
const withheldStateFile = defaultWithheldStatePath(stateFile);
const memories = async (seat) => {
  // #1473 — a declared budget means the wake reads the ASSEMBLY: her
  // `agent-memory` memories, priority first then newest, inside the budget,
  // with what did not fit named. Unset keeps the newest-ten slice below.
  if (agent?.memoryBudgetBytes) {
    const a = await get(`/api/memories/assemble?owner=${encodeURIComponent(seat)}&budget=${encodeURIComponent(agent.memoryBudgetBytes)}&tag=agent-memory`);
    return { assembled: true, ...a };
  }
  const j = await get(`/api/memories?owner=${encodeURIComponent(seat)}&limit=50`);
  const list = Array.isArray(j) ? j : (j?.memories ?? []);
  return list.filter((m) => (m.tags || []).includes('agent-memory')).sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || ''))).slice(-10);
};
const writeMemory = dry ? async (m) => { console.log(`[dry-run] would remember as ${m.owner}: ${m.body}`); return { id: null }; } : async (m) => {
  const r = await fetch(`${BOARD}/api/memories`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: m.body.slice(0, 80), body: m.body, owner: m.owner, by: m.owner, tags: ['agent-memory', m.owner] }) });
  if (!r.ok) throw new Error(`POST /api/memories → ${r.status}`);
  return r.json();
};
const claimCard = dry ? async (n, seat) => console.log(`[dry-run] would claim #${n} as ${seat}`) : async (n, seat) => {
  const r = await fetch(`${BOARD}/api/cards/${n}/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ by: seat }) });
  if (!r.ok) throw new Error(`claim #${n} → ${r.status}`);
};

const r = await guestOnce({
  agent, wake, changes: () => { if (changesError) throw changesError; return rows; }, ledgerSink, spentToday, memories, priorRefusals, priorWithheld, withheldStateFile, writeMemory, claimCard,
  // #1436 — the live decisions that name this seat, its held role, or its display name
  rulings: async (seatKey) => {
    const all = (await get('/api/decisions?live=1'));
    const list = Array.isArray(all) ? all : (all?.decisions ?? all?.rows ?? []);
    return bindingRulings(list, { seatKey, roleKey: agent.roleKey ?? null, displayName: agent.name ?? null });
  },
  // #1237 — the file ledger (dry runs; the fallback when the board sink refuses)
  // lives BESIDE THE STATE FILE, which is always writable. The default is next
  // to the module, and the serve copy is read-only: a refused sink there threw
  // EACCES and lost the row.
  ledgerFile: process.env.SCRUM_MODEL_LEDGER_FILE || `${stateFile}.ledger.jsonl`,
  // #1567 PC5 — harness-only: SCRUM_HANDED_DUMP records every dispatch's exact
  // messages and tools BEFORE the key is added (core/handed-dump.mjs). Off by default.
  callModel: handedCapture((a, m, o) => callModel(a, m, { ...o, apiKey: a.apiKeyRef ? process.env[a.apiKeyRef] : undefined })),
  // #1196 — the executor, bound to THIS board and acting AS this seat. Without
  // it the loop has tools it cannot run, which is indistinguishable from having
  // no tools at all: guestOnce takes the single-call path and a grant on the
  // agent quietly means nothing. What it may reach is still decided by the
  // agent's grants, not by this wiring.
  execute: makeExecutor({
    get: async (p) => {
      const r = await fetch(`${BOARD}${p}`, { signal: AbortSignal.timeout(90_000) });
      if (!r.ok) throw new Error(`GET ${p} → ${r.status}`);
      return r.json();
    },
    post: async (p, body) => {
      const r = await fetch(`${BOARD}${p}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(90_000),
      });
      if (!r.ok) throw new Error(`POST ${p} → ${r.status}`);
      return r.json();
    },
    // #1383 - the seat's own declaration; the route's refusal text is worth
    // handing back to the model (an expiry too far out, a role not minted).
    put: async (p, body) => {
      const r = await fetch(`${BOARD}${p}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(`PUT ${p} -> ${r.status}${j && j.error ? `: ${j.error}` : ''}`);
      return j;
    },
    del: async (p) => {
      const r = await fetch(`${BOARD}${p}`, { method: 'DELETE', signal: AbortSignal.timeout(90_000) });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(`DELETE ${p} -> ${r.status}${j && j.error ? `: ${j.error}` : ''}`);
      return j ?? { cleared: true };
    },
    // #1470 - revise one of the seat's OWN memories (the executor checks the
    // owner before calling this). The route's refusal text goes back to the
    // model, e.g. a stale ifVersion.
    patch: async (p, body) => {
      const r = await fetch(`${BOARD}${p}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(`PATCH ${p} -> ${r.status}${j && j.error ? `: ${j.error}` : ''}`);
      return j;
    },
    by: agent.seatKey,
  }),
  post,
  log: (l) => console.log(l), onError: (l) => console.error(l),
});
// #1346 — the outcome goes on EVERY delivery this turn drained. published |
// declined (the seat's own NO, reason: explicit) | failed (claimable again next
// tick, attempt +1). A halt after the claim is a failure too — recorded, not
// silently left as a claim that never resolves.
if (wake.kind === 'channel' && !dry) {
  const outcome = deliveryOutcome(r, wake.deliveries);   // #1372 — batch-ambiguous + modelCall
  const recorded = await deliverySteps(wake.deliveries.map((id) => ({ id, ...outcome })));
  for (const x of recorded) {
    if (!(x.status >= 200 && x.status < 300)) console.error(`[#1346] ${agent.seatKey}: delivery ${x.id} outcome ${outcome.state} NOT recorded → ${x.status}${x.body?.error ? ` (${x.body.error})` : ''}`);
  }
}
// Advance the cursor only on an outcome that settles the mention; a halt leaves
// it owed, so the next run finds it again (shouldMarkAnswered, tested).
if (!dry && shouldMarkAnswered(r)) {
  const next = { ...state, at: new Date().toISOString(), posted: r.posted, reason: r.reason ?? null };
  if (wake.kind === 'mention') { next.lastAnsweredId = wake.id; next.lastAnsweredAt = wake.createdAt ?? next.lastAnsweredAt ?? null; }   // #1237 the cursor
  if (wake.kind === 'assignment') next.assignmentsSeen = [...new Set([...(state.assignmentsSeen || []), wake.cardId])].slice(-200);
  if (wake.kind === 'schedule') next.lastScheduledAt = wake.createdAt;
  if (wake.kind === 'channel') next.lastChannelDrainAt = new Date().toISOString();   // #1346
  writeStateAtomic(stateFile, wake.kind === 'mention' ? settlePending(next, wake.id, { at: wake.createdAt ?? null }) : next);   // #1631 — settled leaves pending
}
else if (!dry) console.log(`[#1201] ${agent.seatKey}: mention ${wake.id} still owed (${r.reason ?? 'halted'}) — cursor not advanced`);
console.log(JSON.stringify({ posted: r.posted, reason: r.reason ?? 'delivered', postId: r.postId ?? null, wake: wake.id }));
