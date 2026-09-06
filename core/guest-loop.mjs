/**
 * core/guest-loop.mjs — #1201 THE LOOP, slice 1: GUEST-ONCE.
 *
 * "The API is the easy part; something must WAKE the agent, hand it context,
 * call the model, and post the reply — THE WORK." (#650). Every existing seat's
 * harness is a private copy of this loop. This is the shared one, in its
 * smallest honest form: no daemon, no session.
 *
 *   wake      an @-mention of the agent's seat key in the commons
 *   context   BOUNDED — the mention itself plus a short window of what changed
 *             (#643's changes_since), never board_status's unbounded payload
 *             (#644). `contextPolicy: "artifact-only"` hands NO thread at all.
 *   call      ONE model call through #1198's adapter — the only function in
 *             manyhands that talks to a model.
 *   post      one commons post, attributed to the agent's seat key.
 *   ledger    one row per call: agent, model, provider, tokens, stop reason,
 *             latency, what context was handed, the wake it answered, the post
 *             it produced. ⚠️ PRE-LEDGER: #1202's scrum:ModelCall node is not
 *             built; this row is a JSONL line beside the board's other state
 *             files, marked as such, the first migration candidate when P6
 *             lands — never retroactively claimed as graph-native.
 *
 * Rails:
 *   - the agent never answers ITSELF: its own posts are not wakes.
 *   - a model failure produces NO post and one ledger row saying why. Half a
 *     reply attributed to a seat is worse than silence.
 *   - every write carries the agent's seat key as author/by (#1193: omit it
 *     and the event is actor:null forever).
 *   - mentions are found by the agent's own scan of the body text, because the
 *     board's `mentions` field only recognises ROSTER seats and a guest is not
 *     on the roster until P4 exists (restart-to-invite is the constraint this
 *     slice proves the loop under).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runToolLoop } from './tool-loop.mjs';
import { toolsFor, BOARD_TOOLS } from './board-tools.mjs';
import { unbackedLookupClaims, lookupClaimNote, announcedLookup, performOrDeclineNudge } from './lookup-claim.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function ledgerFilePath() {
  return process.env.SCRUM_MODEL_LEDGER_FILE || path.join(__dirname, '..', 'model-calls.jsonl');
}

/** Pure. Commons messages that @-mention the seat and were not written by it. */
export const SYSTEM_AUTHOR = 'board';
export function findMentions(messages = [], seatKey, { sinceId = null, since = null } = {}) {
  if (!seatKey) return [];
  const re = new RegExp(`(^|[^A-Za-z0-9_])@${seatKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'i');
  const rows = (messages || []).filter((m) => m && typeof m.body === 'string'
    && String(m.author || '').toLowerCase() !== seatKey.toLowerCase()
    // #1237 — the board's own notices (claim/release/done lines carrying a card
    // title, tending whispers) are not someone talking to the seat, however
    // many handles the quoted title holds. Seen live: a release notice for a
    // card whose title named the seat woke it and it echoed the notice back.
    && String(m.author || '').toLowerCase() !== SYSTEM_AUTHOR
    && re.test(m.body)
    && (!since || (typeof m.createdAt === 'string' && m.createdAt > since)));
  if (!sinceId) return rows;
  const i = rows.findIndex((m) => m.id === sinceId);
  return i >= 0 ? rows.slice(i + 1) : rows;
}

/** Pure. The messages handed to the model for one wake. */
/**
 * #1226 — THE RESIDENT'S MEMORY PROTOCOL, in the prompt rather than in a tool
 * call: the adapter's protocols (ollama-native, mlx) have no tool channel, so
 * the agent's only way to write is in its reply. A trailing `REMEMBER: …`
 * line is stripped from the post and stored under the seat's own key in the
 * shared memory store; on the next wake the loop READS that store by owner
 * and hands it back. Nobody else hands it: not the mentioning human, not the
 * prompt author. That is the done-when's "without being handed it".
 *
 * `CLAIM: #N` is the same shape for standing in claims, honoured only when
 * `card_claim` is in the agent's tool grants (P3's data, not this loop's code).
 */
/**
 * #1240 — A CARD NUMBER MAY NOT BE REMEMBERED UNLESS A TOOL RETURNED THAT CARD.
 *
 * The chain this closes, from the rows: a seat with no tool channel answered
 * "card 73" to a question it could not look up, wrote that claim to memory, and
 * twenty seconds later a DIFFERENT wake with working tools was handed the line,
 * believed it, and used card_get to CONFIRM the number instead of to find the
 * answer. The tool was never wrong. Our own store supplied the false premise.
 *
 * So the narrow rule: a remembered line that names a card is a claim ABOUT THE
 * BOARD, and a claim about the board needs a row behind it from THIS wake.
 * Everything else — a time, an intention, a preference — is unaffected, because
 * this guard is about referents, not about truth in general.
 *
 * @returns {string|null} the reason to refuse, or null to allow
 */
export function provenanceRefusal(line, hops = []) {
  const claimed = new Set();
  for (const m of String(line).matchAll(/#(\d{1,5})\b/g)) claimed.add(Number(m[1]));
  for (const m of String(line).matchAll(/\bcards?\s+#?(\d{1,5})\b/gi)) claimed.add(Number(m[1]));
  if (!claimed.size) return null;

  const fetched = new Set();
  for (const h of hops) {
    if (!h || h.ok === false) continue;           // a refused or failed hop proves nothing
    const n = Number(h?.arguments?.shortId);
    if (Number.isFinite(n)) fetched.add(n);
    for (const id of (Array.isArray(h.returnedIds) ? h.returnedIds : [])) {
      const r = Number(id);
      if (Number.isFinite(r)) fetched.add(r);
    }
  }
  const unbacked = [...claimed].filter((n) => !fetched.has(n));
  if (!unbacked.length) return null;
  return `refused: this line claims card ${unbacked.map((n) => `#${n}`).join(', ')} and no tool returned ${unbacked.length === 1 ? 'that card' : 'those cards'} on this wake. `
    + 'A remembered card number is a claim about the board, and a claim about the board with nothing behind it becomes a fact for every later wake. '
    + (fetched.size ? `Fetched this wake: ${[...fetched].map((n) => `#${n}`).join(', ')}.` : 'Nothing was fetched this wake.');
}

export const REMEMBER_RE = /^\s*REMEMBER:\s*(.+?)\s*$/;   // uppercase on purpose: prose "remember:" stays prose
export const CLAIM_RE = /^\s*CLAIM:\s*#?(\d+)\s*$/;
export function splitDirectives(text) {
  const remember = []; const claims = []; const keep = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = line.match(REMEMBER_RE); const c = line.match(CLAIM_RE);
    if (m) remember.push(m[1]);
    else if (c) claims.push(Number(c[1]));
    else keep.push(line);
  }
  return { post: keep.join('\n').trim(), remember, claims };
}

/** How a wake introduces itself to the model, by kind. */
function wakeIntro(wake) {
  switch (wake?.kind) {
    case 'assignment': return `A card on the board was assigned to you and nobody holds it:\n#${wake.shortId ?? '?'} ${wake.title ?? ''}${wake.body ? `\n${String(wake.body).slice(0, 600)}` : ''}`;
    case 'schedule': return `Your scheduled wake (${wake.createdAt || 'now'}). Nobody asked you anything; look at your memory and what changed, and say what, if anything, you want to do or note.`;
    default: return `A message on the commons mentioned you:\n[${wake.createdAt || 'unknown time'}] ${wake.author}: ${wake.body}`;
  }
}

/**
 * #1226 — WAKE SOURCES BEYOND @-MENTION, chosen by the agent's `wakeOn` list
 * (data on the node; default `['mention']`).
 *   mention     — an @seat on the commons (slice 1)
 *   assignment  — a card assigned to the seat that nobody holds and that this
 *                 agent has not been woken for (state.assignmentsSeen)
 *   schedule    — `everyMinutes` since state.lastScheduledAt (or never)
 * Returns wakes in priority order: mention, assignment, schedule. ONE is taken
 * per run; the rest wait for the next.
 */
export function findWakes({ agent, messages = [], cards = [], state = {}, now = new Date().toISOString() }) {
  const on = Array.isArray(agent.wakeOn) && agent.wakeOn.length ? agent.wakeOn : ['mention'];
  const out = [];
  if (on.includes('mention')) {
    for (const m of findMentions(messages, agent.seatKey, { sinceId: state.lastAnsweredId ?? null })) out.push({ kind: 'mention', ...m });
  }
  if (on.includes('assignment')) {
    const seen = new Set(state.assignmentsSeen || []);
    for (const c of cards) {
      if (!Array.isArray(c.assignees) || !c.assignees.includes(agent.seatKey) || c.claimedBy || seen.has(c.id)) continue;
      out.push({ kind: 'assignment', id: `assignment:${c.id}`, cardId: c.id, shortId: c.shortId, title: c.title, body: c.description ?? '', createdAt: c.updatedAt || c.createdAt, author: null });
    }
  }
  if (on.includes('schedule')) {
    const every = Number(agent.everyMinutes ?? 60) * 60_000;
    const last = state.lastScheduledAt ? Date.parse(state.lastScheduledAt) : null;
    if (last == null || Date.parse(now) - last >= every) out.push({ kind: 'schedule', id: `schedule:${now}`, createdAt: now, author: null, body: '' });
  }
  return out;
}

export function buildMessages({ agent, wake, changes = [], memories = [] }) {
  const policy = agent.contextPolicy || 'thread';
  const lines = [];
  lines.push(`You are ${agent.name || agent.seatKey}, a ${agent.residency === 'resident' ? 'resident' : 'guest'} seat on the manyhands board. Your seat key is "${agent.seatKey}".`);
  // #1199 — DISCLOSURE, mechanical rather than validated: a guest is told it
  // will not persist; a resident is told it persists and where its memory
  // lives. A truthfulness claim about the arrangement, not a welfare claim.
  lines.push(agent.residency === 'resident'
    ? 'You persist across wakes. Your memory lives in the shared memory store on this board (memory_create / memory_list); what you do not write there, you will not have next time.'
    : 'You are invited for this question only and will not persist: nothing you say now will be handed back to you later unless someone writes it to the board.');
  if (agent.systemPrompt) lines.push(agent.systemPrompt);
  // #1196 — A SEAT MUST BE TOLD IT CAN LOOK. Found live: a seat granted search
  // and card-read was offered both on the wire, called NEITHER, and then wrote
  // "I searched the board and found no matching cards" — while the row said one
  // model call and zero hops, and the search endpoint was healthy and returns
  // results for that exact query. It did not fail to search; it never tried,
  // and then described a search it had not run. A confabulation about its OWN
  // ACTIONS, which no honesty instruction catches, because the sentence sounds
  // like diligence.
  //
  // The cause was this prompt: it said "reply with one post" and never said
  // looking things up was possible. An ungranted seat is still told nothing —
  // naming a tool it cannot reach is an invitation to invent one.
  const granted = toolsFor(agent).map((t) => t.function.name);
  if (granted.length) {
    lines.push(`You can look things up before you answer. Available to you: ${granted.join(', ')}. `
      + 'Use them whenever the answer depends on what is written on this board rather than on what you already know — a card number, what a card says, whether the board covers something at all. '
      + '⛔ NEVER say you searched, looked, checked or found anything unless you ACTUALLY CALLED a tool on this turn. If you did not call one, say what you would need to look up instead. '
      + 'If a tool returns nothing, say plainly that nothing matched: that is a real answer and it is better than a guess.');
  }
  lines.push('Reply with the text of ONE commons post, plainly, no preamble. If you cannot answer from what you were handed, say what you would need.');
  if (agent.residency === 'resident') {
    lines.push('To keep something for your next wake, add a final line `REMEMBER: <one line>`. It is stored under your seat in the memory store and handed back to you next time; it is removed from the post. Only write what you will want later.');
    if ((agent.toolGrants || []).includes('card_claim')) lines.push('To take a card, add a line `CLAIM: #<number>`; it is claimed as you and removed from the post.');
  }
  const system = lines.join('\n\n');
  const ctx = [];
  if (agent.residency === 'resident') {
    // #1240 — HOW THE STORE IS INTRODUCED IS PART OF THE DEFECT. Handed as a
    // list of lines, a seat reads its own past guesses as established fact and
    // repeats them; that is exactly how one no-tool answer became a card number
    // the whole room saw twice. So the store is named for what it IS: sentences
    // this seat wrote on earlier wakes, unverified, and possibly wrong.
    ctx.push(memories.length
      ? 'What YOU SAID on earlier wakes (newest last). ⚠️ These are your own past sentences, NOT facts about the board and NOT verified by anyone. '
        + 'You may have been guessing when you wrote them. If one names a card, a person or a date and it matters to your answer, CHECK IT before repeating it; '
        + 'if you cannot check it, say where it came from rather than stating it:\n'
        + memories.slice(-10).map((m) => `- [${m.updatedAt || m.createdAt || ''}] you wrote: "${m.body}"`).join('\n')
      : 'You have written nothing on earlier wakes: this is your first, or you kept nothing.');
  }
  ctx.push(wakeIntro(wake));
  if (policy !== 'artifact-only' && changes.length) {
    ctx.push('What changed on the board recently (bounded, newest last):\n' + changes.slice(-20).map((c) =>
      `- ${c.at || ''} ${c.kind || ''} ${c.op || ''} ${c.shortId != null ? `#${c.shortId}` : (c.id || '')}${c.title ? `: ${String(c.title).slice(0, 120)}` : ''}${c.by ? ` (by ${c.by})` : ''}`).join('\n'));
  }
  return [{ role: 'system', content: system }, { role: 'user', content: ctx.join('\n\n') }];
}

/**
 * Bounded context through the front door, with the one refusal a young board
 * always produces handled the way the refusal itself prescribes.
 *
 * `/api/changes` refuses a `since` older than its retention floor with
 * CURSOR_TOO_OLD and names the floor (`oldest_retained`). On a FRESH board the
 * floor is the first event, and a card's createdAt lands a few milliseconds
 * before its own create event, so "the last hour" is refused on a board that
 * is ten seconds old (#1223 — measured on a fresh test board 2026-09-05, not
 * only on boards whose cards predate their log). A guest asking what changed
 * must not be told to resync by a board it just joined: retry ONCE from the
 * floor the refusal named, which is exactly the message's own instruction.
 *
 * @param {(path: string) => Promise<{status:number, body:any}>} get
 * @returns {Promise<Array>} rows, possibly empty; never throws on a refusal it can honour
 */
export async function fetchBoundedChanges(get, since, { limit = 20 } = {}) {
  const ask = (s) => get(`/api/changes?since=${encodeURIComponent(s)}&limitCards=${limit}&limitPosts=${limit}`);
  let r = await ask(since);
  if (r.status === 400 && r.body?.code === 'CURSOR_TOO_OLD' && typeof r.body.oldest_retained === 'string') {
    r = await ask(r.body.oldest_retained);
  }
  if (r.status !== 200) throw new Error(`changes ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  return Array.isArray(r.body?.changes) ? r.body.changes : [];
}

/**
 * #1201 — which outcomes ADVANCE the wake cursor. A wake is "answered" when the
 * agent posted, or when the model definitively failed on it (retrying the same
 * prompt would fail the same way). A HALT is neither: the budget could not be
 * read, or was breached — the mention is still owed, and the next run must
 * find it again. Measured 2026-09-05 on prod: a halt on an unreadable ledger
 * advanced the cursor and the guest never returned to the mention.
 */
export function shouldMarkAnswered(result) {
  if (!result) return false;
  if (result.halted) return false;
  return result.posted === true || result.reason === 'model-failed' || result.reason === 'empty-reply' || result.reason === 'memory-only';
}

function appendLedger(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
}

/**
 * #1202 — the ledger row as a NODE, not a log line. `sink` is a function that
 * takes the row and records it on the board (POST /api/model-calls); the JSONL
 * file stays as the fallback so a row is never lost when the board refuses or
 * is down — and the row says which happened. Returns {recorded:'board'|'file', id}.
 */
export async function recordLedger({ sink = null, file, row, onError = () => {} }) {
  if (typeof sink === 'function') {
    try { const r = await sink(row); return { recorded: 'board', id: r?.id ?? null }; }
    catch (e) { onError(`[#1202] ledger sink refused (${e?.message ?? e}) — row kept in ${file}`); appendLedger(file, { ...row, sinkError: String(e?.message ?? e) }); return { recorded: 'file', id: null }; }
  }
  appendLedger(file, row);
  return { recorded: 'file', id: null };
}

/**
 * #1202 / #987 — THE BUDGET HALT. Before a call: what has this agent spent
 * today, against its budget? `spentToday` is injected (a GET on the ledger);
 * if it cannot be read the loop FAILS CLOSED — a budget that cannot be checked
 * is not a budget. On breach the loop STOPS and posts once; it does not
 * warn-and-continue. A budget is breached when spent >= budget AND at least
 * one call has been recorded, so a $0.00 budget allows exactly one run and
 * halts the second — the card's own acceptance.
 */
export async function budgetCheck({ agent, spentToday }) {
  const budget = agent?.budgetPerDay;
  if (budget == null) return { allowed: true, reason: 'no-budget' };
  let s;
  try { s = await spentToday(agent.seatKey); } catch (e) { return { allowed: false, reason: `budget-unreadable: ${e?.message ?? e}`, spent: null, budget }; }
  const spent = Number(s?.spent ?? 0); const calls = Number(s?.count ?? 0);
  if (calls >= 1 && spent >= Number(budget)) return { allowed: false, reason: 'budget-breached', spent, budget, calls };
  return { allowed: true, reason: 'within-budget', spent, budget, calls };
}

/**
 * One wake. Everything injected.
 *
 *   agent      {seatKey, name?, systemPrompt?, contextPolicy?, model: {model, protocol, baseUrl, sampling?}}
 *   wake       the mentioning message {id, author, body, createdAt}
 *   changes    () => rows from /api/changes (bounded context), may throw → treated as none
 *   callModel  #1198's callModel (injected so a test can stub the transport)
 *   post       ({author, body}) => Promise<{id?}>
 *   ledgerFile where the pre-ledger row goes
 */
export async function guestOnce({ agent, wake, changes = () => [], memories = null, writeMemory = null, claimCard = null, callModel, execute = null, maxHops = undefined, post, ledgerFile = ledgerFilePath(), ledgerSink = null, spentToday = null, now = () => new Date().toISOString(), log = () => {}, onError = () => {} }) {
  if (!agent?.seatKey) throw new Error('guestOnce: agent.seatKey is required — a post with no seat is actor:null forever (#1193)');
  if (!agent?.model?.model || !agent?.model?.protocol) throw new Error('guestOnce: agent.model {model, protocol} is required');
  // #1202 — the budget gate, BEFORE any context is fetched or any call is made.
  if (agent.budgetPerDay != null) {
    const b = await budgetCheck({ agent, spentToday: spentToday || (async () => { throw new Error('no ledger reader'); }) });
    if (!b.allowed) {
      const body = b.reason === 'budget-breached'
        ? `⛔ ${agent.seatKey} HALTED (#987): daily budget ${b.budget} reached (spent ${b.spent} over ${b.calls} call${b.calls === 1 ? '' : 's'} today). Not answering; a human raises the budget or waits for tomorrow.`
        : `⛔ ${agent.seatKey} HALTED: ${b.reason}. A budget that cannot be checked is not a budget.`;
      try { await post({ author: agent.seatKey, body }); } catch (e) { onError(`[#1202] halt post failed: ${e?.message ?? e}`); }
      return { posted: false, halted: true, reason: b.reason, budget: b };
    }
  }
  let rows = [];
  try { rows = changes() || []; } catch (e) { onError(`[#1201] bounded context unreadable — answering from the mention alone: ${e?.message ?? e}`); }
  // #1226 — a resident reads its OWN memory (owner = seat) before it thinks.
  // Unreadable is not empty: the row says which, and the agent is told nothing
  // rather than told "your memory is empty" — a false empty would teach it
  // that writing is pointless.
  let mem = []; let memState = 'none';
  if (agent.residency === 'resident' && typeof memories === 'function') {
    try { mem = (await memories(agent.seatKey)) || []; memState = 'read'; }
    catch (e) { memState = 'unreadable'; onError(`[#1226] memory unreadable for ${agent.seatKey}; waking without it: ${e?.message ?? e}`); }
  }
  const messages = buildMessages({ agent, wake, changes: rows, memories: memState === 'unreadable' ? [{ body: '(your memory could not be read this wake — do not conclude it is empty)' }] : mem });
  const started = Date.now();
  const base = {
    ledger: 'pre-P6', agent: agent.seatKey, model: agent.model.model, protocol: agent.model.protocol,
    provider: agent.model.baseUrl || null, promptVersion: agent.promptVersion ?? null,
    wake: { kind: wake.kind || 'mention', messageId: wake.id ?? null, author: wake.author ?? null },
    memory: { handed: mem.length, state: memState },
    contextHanded: { policy: agent.contextPolicy || 'thread', changesRows: (agent.contextPolicy === 'artifact-only') ? 0 : rows.length },
    contextHandedTo: [wake.id, ...((agent.contextPolicy === 'artifact-only') ? [] : rows.slice(-20).map((c) => c.id))].filter(Boolean),
    // #1196 — what this seat MAY reach, recorded whether it reached or not: an
    // empty answer from a seat with no grants and one from a seat that looked
    // and found nothing are different facts.
    toolsGranted: toolsFor(agent).map((t) => t.function.name),
    at: now(),
  };
  // #1196 slice C — THE COLLEAGUE LOOKS THINGS UP. A grant is real: `toolsFor`
  // resolves what this seat may reach, and an ungranted seat takes the original
  // single-call path unchanged, offered no tools at all. Every hop is recorded
  // on the ledger row beside what was said, because the whole argument for this
  // channel is that a claim becomes checkable, not that it becomes correct.
  const tools = toolsFor(agent);
  // ⚠️ THE HOP CEILING IS DEPLOYMENT DATA, NOT A CONSTANT. Every hop is a full
  // model call, so this number multiplies whatever the slowest thing on THIS
  // machine is. On the box that built it — a 12B model sharing 24 GB with two
  // other local workloads — four hops is minutes. On a host with room, or
  // pointed at a hosted frontier model, the same four hops may be seconds.
  // Neither number is a property of this loop, and hard-coding a ceiling low
  // enough for the cramped case would spend everyone's capability to buy our
  // latency. It rides on the agent, beside its model and sampling, so an
  // operator sets it against their own hardware; the row records what was
  // actually spent, so a deployment can learn its own number rather than
  // inherit ours.
  const hopCeiling = maxHops ?? agent.maxHops ?? agent.model?.maxHops;
  const useTools = tools.length > 0 && typeof execute === 'function';
  let result; let hops = []; let modelCalls = 1; let stoppedBecause = null;
  try {
    if (useTools) {
      const loop = await runToolLoop({
        agent: agent.model, messages, tools, execute, callModel,
        ...(hopCeiling === undefined ? {} : { maxHops: hopCeiling }),
        opts: { ...(agent.model.sampling || {}) },
      });
      result = { text: loop.text, stopReason: 'stop', usage: null };
      hops = loop.hops; modelCalls = loop.modelCalls; stoppedBecause = loop.stoppedBecause;
    } else {
      result = await callModel(agent.model, messages, { ...(agent.model.sampling || {}) });
    }
  } catch (e) {
    const row = { ...base, ok: false, error: e?.message ?? String(e), latencyMs: Date.now() - started };
    await recordLedger({ sink: ledgerSink, file: ledgerFile, row, onError });
    onError(`[#1201] model call failed for ${agent.seatKey}; NO post made: ${row.error}`);
    return { posted: false, reason: 'model-failed', ledger: row };
  }
  // #1246b — A NARRATED LOOKUP GETS ONE CHANCE TO BECOME A REAL ONE.
  //
  // Measured on this board 2026-09-06: of seven genuine asks to look something
  // up, six produced NO tool call, and several announced the lookup instead —
  // "I will search for the genesis prompt and read it." The wake then ends.
  // There is no later turn, so that promise cannot be kept by construction,
  // and the person is left waiting for a reply that will never come.
  //
  // ⛔ THE PROMPT ALREADY FORBIDS THIS IN THREE CONSECUTIVE CLAUSES and lost
  // every time. So the answer is not a fourth clause. It is a MOVE the loop
  // makes: hand the seat its own sentence back, with the tools still open and
  // BOTH roads named — look now, or decline and end it honestly. #1251's whole
  // finding is that an exit has to be something a seat can DO under pressure,
  // not something it is told it may do.
  //
  // Bounded to ONE extra call. A retry that can retry is a budget with no floor.
  let narrationRetry = null;
  if (useTools && hops.length === 0) {
    const announced = announcedLookup(result?.text ?? '');
    if (announced) {
      narrationRetry = { phrase: announced.phrase, outcome: 'no-change' };
      try {
        const again = await runToolLoop({
          agent: agent.model, tools, execute, callModel,
          messages: [...messages,
            { role: 'assistant', content: String(result?.text ?? '') },
            { role: 'user', content: performOrDeclineNudge(announced.phrase) }],
          ...(hopCeiling === undefined ? {} : { maxHops: hopCeiling }),
          opts: { ...(agent.model.sampling || {}) },
        });
        modelCalls += again.modelCalls;
        if (again.hops.length) {
          hops = again.hops; stoppedBecause = again.stoppedBecause;
          result = { text: again.text, stopReason: 'stop', usage: result?.usage ?? null };
          narrationRetry.outcome = 'looked';
        } else if (String(again.text || '').trim()) {
          result = { text: again.text, stopReason: 'stop', usage: result?.usage ?? null };
          narrationRetry.outcome = 'answered-without-looking';
        }
      } catch (e) {
        // ⚠️ A FAILED NUDGE MUST NOT COST THE ANSWER. The first reply is still
        // the seat's reply; losing it to a retry would make this fix worse
        // than the defect. Recorded, not raised.
        narrationRetry.outcome = 'retry-failed';
        narrationRetry.error = e?.message ?? String(e);
        onError(`[#1246b] nudge failed for ${agent.seatKey}: ${narrationRetry.error}`);
      }
      onError(`[#1246b] ${agent.seatKey} announced a lookup it had not made ("${announced.phrase}") — nudged; outcome: ${narrationRetry.outcome}`);
    }
  }
  // #1196 — THE TOOL RECORD BELONGS ON EVERY ROW, not only the happy one. A
  // wake that spent four model calls and produced nothing is precisely the one
  // an operator needs the hops for; a row that drops them reads as a wake that
  // never looked, which is the same lie as a dropped tool call one layer up.
  const toolRecord = { toolHops: hops, modelCalls, ...(stoppedBecause ? { stoppedBecause } : {}) };
  const raw = String(result?.text ?? '').trim();
  // #1226 — directives come OUT of the post before it is made.
  const { post: text, remember, claims } = agent.residency === 'resident' ? splitDirectives(raw) : { post: raw, remember: [], claims: [] };
  if (!text && !remember.length) {
    const row = { ...base, ...toolRecord, ok: false, error: 'empty reply', stopReason: result?.stopReason ?? null, usage: result?.usage ?? null, latencyMs: Date.now() - started };
    await recordLedger({ sink: ledgerSink, file: ledgerFile, row, onError });
    return { posted: false, reason: 'empty-reply', ledger: row };
  }
  let posted = null;
  try { if (text) posted = await post({ author: agent.seatKey, body: text }); }
  catch (e) {
    const row = { ...base, ...toolRecord, ok: false, error: `post failed: ${e?.message ?? e}`, stopReason: result.stopReason, usage: result.usage, latencyMs: Date.now() - started };
    await recordLedger({ sink: ledgerSink, file: ledgerFile, row, onError });
    return { posted: false, reason: 'post-failed', ledger: row };
  }
  // #1226 — the write to memory, AFTER the post: a memory failure must not
  // suppress the answer, and it is recorded on the row either way.
  const memoryWritten = [];
  const memoryRefused = [];
  for (const line of remember) {
    // #1240 — THE GUARD, before the sink. A remembered card number with no
    // fetched row behind it is how one wake's guess becomes every later wake's
    // premise. The refusal is recorded on the row: a guard that works silently
    // is indistinguishable from one that never fired.
    const refusal = provenanceRefusal(line, hops);
    if (refusal) {
      memoryRefused.push({ line, reason: refusal });
      onError(`[#1240] ${agent.seatKey} not remembered — ${refusal} Line: "${line.slice(0, 120)}"`);
      continue;
    }
    if (typeof writeMemory !== 'function') { onError(`[#1226] ${agent.seatKey} asked to remember but no memory sink is wired: "${line.slice(0, 80)}"`); continue; }
    // #1240 — PROVENANCE: the memory names the call that produced it, so any
    // claim in the store can be traced to the wake and the row that made it.
    try { const w = await writeMemory({ owner: agent.seatKey, body: line, wake: wake.id ?? null, fromCall: base.at ?? null, hops: hops.length }); memoryWritten.push(w?.id ?? true); }
    catch (e) { onError(`[#1226] memory write failed for ${agent.seatKey}: ${e?.message ?? e}`); memoryWritten.push({ error: e?.message ?? String(e) }); }
  }
  // Standing in claims: honoured only under the grant; a refused one is on the row.
  const claimed = [];
  for (const n of claims) {
    if (!(agent.toolGrants || []).includes('card_claim')) { claimed.push({ card: n, ok: false, reason: 'no card_claim grant' }); continue; }
    if (typeof claimCard !== 'function') { claimed.push({ card: n, ok: false, reason: 'no claim sink wired' }); continue; }
    try { await claimCard(n, agent.seatKey); claimed.push({ card: n, ok: true }); }
    catch (e) { claimed.push({ card: n, ok: false, reason: e?.message ?? String(e) }); }
  }
  // #1196 — THE CHECKABLE PAIR. `toolHops` says what was fetched and how many
  // rows came back; `postedText` says what was claimed on the strength of it.
  // Side by side in one row, a reader can finally ask whether the rows support
  // the sentence — including the case that defeated every rule we tried
  // tonight: zero rows and a confident answer.
  // #1246 — THE CONTRADICTION, RECORDED. A post claiming a completed lookup
  // from a wake that called no tool is checkable without judging the content,
  // because both halves are facts about this row. Recorded and logged; the
  // post is NOT blocked. Deciding to intervene is a separate argument, and a
  // false accusation of fabrication is worse than the fabrication.
  //
  // ⚠️ ALWAYS SET, including the empty case — the same reason toolHops is
  // emitted at zero. A field present only when it fired makes "which wakes
  // were clean" a query by absence, and a reader would have to know to ask
  // for a missing field.
  const lookupClaims = unbackedLookupClaims(text, hops);
  if (lookupClaims.length) onError(`[#1246] ${agent.seatKey} — ${lookupClaimNote(lookupClaims)}`);
  const row = { ...base, ok: true, stopReason: result.stopReason ?? null, usage: result.usage ?? null, attempts: result.attempts ?? null, latencyMs: Date.now() - started, postId: posted?.id ?? null,
    ...toolRecord, postedText: text || null, unbackedLookupClaims: lookupClaims,
    ...(narrationRetry ? { narrationRetry } : {}),
    memoryWritten, ...(memoryRefused.length ? { memoryRefused } : {}), claims: claimed, ...(text ? {} : { reason: 'memory-only' }) };
  const recorded = await recordLedger({ sink: ledgerSink, file: ledgerFile, row, onError });
  row.recorded = recorded.recorded; row.ledgerId = recorded.id;
  log(`[#1201] ${agent.seatKey} answered ${wake.id ?? 'a mention'} via ${agent.model.model} (${row.usage?.completionTokens ?? '?'} tokens, ${row.stopReason})`);
  return { posted: Boolean(posted), ...(text ? {} : { reason: 'memory-only' }), postId: row.postId, ledger: row, text, remember, claims: claimed };
}

// ---------------------------------------------------------------------------
// #1237 — IN USE. The runner is started by a launchd tick every minute, so:
//
// The mention scan is a SINCE cursor, not the newest-60 window. On a busy night
// a mention slid past 60 newer posts and was invisible for good — a human asked
// the seat a question at 02:22Z and a dry run at 10:02Z found "nothing to wake
// for". The cursor is the createdAt of the last mention answered; the first run
// ever reaches back a few minutes only, because a first tick that replays a
// night of old mentions one per minute is a flood, not a colleague.
export const FIRST_RUN_WINDOW_MS = 10 * 60_000;
export const SCAN_LIMIT = 500;
export function mentionScanPath(state = {}, now = new Date().toISOString()) {
  const since = typeof state.lastAnsweredAt === 'string' && state.lastAnsweredAt
    ? state.lastAnsweredAt
    : new Date(Date.parse(now) - FIRST_RUN_WINDOW_MS).toISOString();
  return `/api/conversations?attachedTo=null&since=${encodeURIComponent(since)}&limit=${SCAN_LIMIT}`;
}

// A lock beside the state file, so the tick and a hand run cannot both answer
// one mention. mkdir is atomic on every filesystem we run on; the holder's pid
// and start time live inside so a refusal can NAME the holder and a stale lock
// (a run that died mid-model-call) is broken rather than wedging the seat
// forever — and the break is reported, not silent.
export function acquireLock(lockPath, { pid = process.pid, now = Date.now(), staleMs = 10 * 60_000 } = {}) {
  const infoFile = `${lockPath}/holder.json`;
  const readHolder = () => { try { return JSON.parse(fs.readFileSync(infoFile, 'utf8')); } catch { return null; } };
  // Build the lock COMPLETE in a sibling temp dir, then rename it into place:
  // rename onto a non-empty directory fails, so a lock is never visible half-
  // written, and a second run can never mistake a fresh lock for a stale one.
  const take = () => {
    const tmp = fs.mkdtempSync(`${lockPath}.tmp-`);
    fs.writeFileSync(`${tmp}/holder.json`, JSON.stringify({ pid, at: new Date(now).toISOString() }));
    try { fs.renameSync(tmp, lockPath); return true; }
    catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); if (e?.code === 'ENOTEMPTY' || e?.code === 'EEXIST' || e?.code === 'EPERM') return false; throw e; }
  };
  if (take()) return { acquired: true };
  const holder = readHolder();
  let heldMs;
  if (holder?.at) heldMs = now - Date.parse(holder.at);
  else { try { heldMs = now - fs.statSync(lockPath).mtimeMs; } catch { heldMs = 0; } }
  if (!(heldMs >= staleMs)) return { acquired: false, holder, heldMs };
  // stale: break it and say so
  fs.rmSync(lockPath, { recursive: true, force: true });
  if (!take()) { const h = readHolder(); return { acquired: false, holder: h, heldMs: h?.at ? now - Date.parse(h.at) : 0 }; }
  return { acquired: true, broke: holder ?? { pid: null, at: null }, heldMs };
}
export function releaseLock(lockPath) { fs.rmSync(lockPath, { recursive: true, force: true }); }
