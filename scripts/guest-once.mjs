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
import { findMentions, guestOnce, fetchBoundedChanges } from '../core/guest-loop.mjs';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const has = (k) => args.includes(k);
const BOARD = process.env.SCRUM_BOARD_URL || 'http://127.0.0.1:3141';
const agentFile = opt('--agent');
if (!agentFile) { console.error('usage: guest-once.mjs --agent <file.json> [--dry-run] [--once-id <messageId>]'); process.exit(2); }
const agent = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
const stateFile = process.env.SCRUM_GUEST_STATE_FILE || path.join(path.dirname(agentFile), `.${agent.seatKey}.guest-state.json`);
const dry = has('--dry-run');

const get = async (p) => { const r = await fetch(`${BOARD}${p}`); if (!r.ok) throw new Error(`GET ${p} → ${r.status}`); return r.json(); };
const post = async (body) => {
  if (dry) { console.log(`[dry-run] would post as ${body.author}:\n${body.body}`); return { id: null }; }
  const r = await fetch(`${BOARD}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`POST /api/conversations → ${r.status}`);
  return r.json();
};

let state = {};
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first wake */ }
const recent = await get('/api/conversations?attachedTo=null&limit=60');
const messages = Array.isArray(recent) ? recent : (recent?.conversations ?? []);
let wakes = findMentions(messages, agent.seatKey, { sinceId: state.lastAnsweredId ?? null });
if (opt('--once-id')) wakes = messages.filter((m) => m.id === opt('--once-id'));
if (!wakes.length) { console.log(`${new Date().toISOString()} ${agent.seatKey}: no new mention`); process.exit(0); }

const wake = wakes[0];   // ONE wake per run — guest-once means once
const sinceIso = new Date(Date.parse(wake.createdAt || Date.now()) - 60 * 60 * 1000).toISOString();
const getRaw = async (p) => { const r = await fetch(`${BOARD}${p}`); let body = null; try { body = await r.json(); } catch { /* none */ } return { status: r.status, body }; };
let rows = [];
try { rows = await fetchBoundedChanges(getRaw, sinceIso); }
catch (e) { console.error(`[#1201] changes unreadable — answering from the mention alone: ${e.message}`); }
const r = await guestOnce({
  agent, wake, changes: () => rows,
  callModel: (a, m, o) => callModel(a, m, { ...o, apiKey: a.apiKeyRef ? process.env[a.apiKeyRef] : undefined }),
  post,
  log: (l) => console.log(l), onError: (l) => console.error(l),
});
if (!dry) fs.writeFileSync(stateFile, JSON.stringify({ lastAnsweredId: wake.id, at: new Date().toISOString(), posted: r.posted, reason: r.reason ?? null }, null, 2));
console.log(JSON.stringify({ posted: r.posted, reason: r.reason ?? 'delivered', postId: r.postId ?? null, wake: wake.id }));
