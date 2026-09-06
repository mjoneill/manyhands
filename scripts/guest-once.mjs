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
import { callModel } from '../core/model-adapter.mjs';
import { findMentions, findWakes, guestOnce, fetchBoundedChanges, shouldMarkAnswered, mentionScanPath, acquireLock, releaseLock } from '../core/guest-loop.mjs';
import { makeExecutor } from '../core/board-tools.mjs';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const has = (k) => args.includes(k);
const BOARD = process.env.SCRUM_BOARD_URL || 'http://127.0.0.1:3141';
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
    // #1196 — the role's reasoning setting rides to the adapter on the MODEL
    // spec, because that is the object callModel is handed. Left off entirely
    // when the board says nothing, so a model with no such flag is sent none.
    model: a.thinking == null ? a.model : { ...a.model, thinking: a.thinking } };   // #1226
} else {
  agent = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
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
const recent = await get(mentionScanPath(state));
const messages = Array.isArray(recent) ? recent : (recent?.conversations ?? []);
// #1226 — wake sources are the agent's data. Cards are fetched only when a
// kind needs them; a mention-only agent costs what slice 1 cost.
let cards = [];
if ((agent.wakeOn || []).includes('assignment')) {
  try { const c = await get('/api/cards?limit=500&fields=id,shortId,title,assignees,claimedBy,updatedAt,createdAt'); cards = Array.isArray(c) ? c : (c?.cards ?? []); }
  catch (e) { console.error(`[#1226] cards unreadable — no assignment wakes this run: ${e.message}`); }
}
let wakes = findWakes({ agent, messages, cards, state });
if (opt('--once-id')) wakes = messages.filter((m) => m.id === opt('--once-id')).map((m) => ({ kind: 'mention', ...m }));
if (!wakes.length) { console.log(`${new Date().toISOString()} ${agent.seatKey}: nothing to wake for (${(agent.wakeOn || ['mention']).join(', ')})`); process.exit(0); }

const wake = wakes[0];   // ONE wake per run — guest-once means once
const sinceIso = new Date(Date.parse(wake.createdAt || Date.now()) - 60 * 60 * 1000).toISOString();
const getRaw = async (p) => { const r = await fetch(`${BOARD}${p}`); let body = null; try { body = await r.json(); } catch { /* none */ } return { status: r.status, body }; };
let rows = [];
try { rows = await fetchBoundedChanges(getRaw, sinceIso); }
catch (e) { console.error(`[#1201] changes unreadable — answering from the mention alone: ${e.message}`); }
// #1202 — the ledger row goes to the board as a scrum:ModelCall node; the JSONL
// file is the fallback if the board refuses, and the row says which happened.
const rowToBoard = (row) => ({
  by: row.agent, agent: row.agent, model: row.model, provider: row.provider, protocol: row.protocol,
  promptVersion: row.promptVersion, tokensIn: row.usage?.promptTokens ?? row.usage?.prompt_eval_count ?? null,
  tokensOut: row.usage?.completionTokens ?? row.usage?.eval_count ?? null,
  cost: (agent.model?.costIn != null || agent.model?.costOut != null)
    ? ((row.usage?.promptTokens ?? 0) * (agent.model.costIn ?? 0) + (row.usage?.completionTokens ?? 0) * (agent.model.costOut ?? 0)) : 0,
  stopReason: row.stopReason ?? null, latencyMs: row.latencyMs, ok: row.ok, error: row.error ?? null,
  contextHandedTo: row.contextHandedTo ?? [], producedPost: row.postId ?? null, at: row.at,
  // #1203 finding — the knobs that reproduce the call, and the resident's fields (#1226), ride the board row too.
  sampling: agent.model?.sampling ?? null, wake: row.wake ?? null, memory: row.memory ?? null, memoryWritten: row.memoryWritten ?? [], claims: row.claims ?? [],
  // #1196 — the tool record travels to the BOARD, not just to the file beside
  // this runner. A field that stops here is invisible to every reader who was
  // not standing at this process, which is the same as not recording it.
  toolsGranted: row.toolsGranted ?? [], toolHops: row.toolHops ?? [], modelCalls: row.modelCalls ?? null,
  stoppedBecause: row.stoppedBecause ?? null, postedText: row.postedText ?? null,
});
const ledgerSink = dry ? null : async (row) => {
  const r = await fetch(`${BOARD}/api/model-calls`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rowToBoard(row)) });
  if (!r.ok) throw new Error(`POST /api/model-calls → ${r.status}`);
  return r.json();
};
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

// #1226 — the resident's memory: read by OWNER (its seat), written as a memory
// row under that owner. The mentioning human hands nothing.
const memories = async (seat) => {
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
  agent, wake, changes: () => rows, ledgerSink, spentToday, memories, writeMemory, claimCard,
  // #1237 — the file ledger (dry runs; the fallback when the board sink refuses)
  // lives BESIDE THE STATE FILE, which is always writable. The default is next
  // to the module, and the serve copy is read-only: a refused sink there threw
  // EACCES and lost the row.
  ledgerFile: process.env.SCRUM_MODEL_LEDGER_FILE || `${stateFile}.ledger.jsonl`,
  callModel: (a, m, o) => callModel(a, m, { ...o, apiKey: a.apiKeyRef ? process.env[a.apiKeyRef] : undefined }),
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
    by: agent.seatKey,
  }),
  post,
  log: (l) => console.log(l), onError: (l) => console.error(l),
});
// Advance the cursor only on an outcome that settles the mention; a halt leaves
// it owed, so the next run finds it again (shouldMarkAnswered, tested).
if (!dry && shouldMarkAnswered(r)) {
  const next = { ...state, at: new Date().toISOString(), posted: r.posted, reason: r.reason ?? null };
  if (wake.kind === 'mention') { next.lastAnsweredId = wake.id; next.lastAnsweredAt = wake.createdAt ?? next.lastAnsweredAt ?? null; }   // #1237 the cursor
  if (wake.kind === 'assignment') next.assignmentsSeen = [...new Set([...(state.assignmentsSeen || []), wake.cardId])].slice(-200);
  if (wake.kind === 'schedule') next.lastScheduledAt = wake.createdAt;
  fs.writeFileSync(stateFile, JSON.stringify(next, null, 2));
}
else if (!dry) console.log(`[#1201] ${agent.seatKey}: mention ${wake.id} still owed (${r.reason ?? 'halted'}) — cursor not advanced`);
console.log(JSON.stringify({ posted: r.posted, reason: r.reason ?? 'delivered', postId: r.postId ?? null, wake: wake.id }));
