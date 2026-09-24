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
import { readWithheldState, writePending, clearPending, preservePending, handBackFromState, defaultWithheldStatePath, isBareDecline } from './withheld-state.mjs';   // #1428 — private per-seat withheld recovery

/**
 * #1294 — add two usage blocks, keeping NULL when neither reported anything.
 * A zero would price the wake as free and be indistinguishable from a call
 * that genuinely cost nothing: an unmeasured zero is not a value.
 */
function sumUsage(a, b) {
  if (!a && !b) return null;
  const out = {};
  for (const k of ['promptTokens', 'completionTokens', 'reasoningTokens', 'cachedPromptTokens']) {
    // ⛔ #1296 — an explicit null must not become a measured zero here either:
    // `Number(null)` is 0 and passes a finiteness test, so adding two honest
    // silences would manufacture a number.
    //
    // ⚠️ HONESTLY LABELLED: this guard is UNREACHABLE TODAY and its mutation
    // SURVIVES. Both call sites sit behind `useTools`, so both operands come
    // from runToolLoop, which now omits an unreported category entirely rather
    // than nulling it — the absent key arrives as undefined, which the old
    // numeric test already handled. It is kept because the asymmetry it guards
    // is a property of the ADAPTERS (they null what they cannot count), and the
    // day a non-tool result reaches here that null would be billed as a zero.
    // Not presented as tested; a reader should not infer coverage from its
    // presence.
    const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
    const x = num(a?.[k]); const y = num(b?.[k]);
    if (x != null || y != null) out[k] = (x ?? 0) + (y ?? 0);
  }
  return Object.keys(out).length ? out : null;
}
import { toolsFor, BOARD_TOOLS } from './board-tools.mjs';
import { unbackedLookupClaims, lookupClaimNote, announcedLookup, performOrDeclineNudge } from './lookup-claim.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function ledgerFilePath() {
  return process.env.SCRUM_MODEL_LEDGER_FILE || path.join(__dirname, '..', 'model-calls.jsonl');
}

// #1411 slice 2 — THE PAIR CAP. Rule 1 ("a resident's post naming only
// residents wakes nobody") stopped the 00:41Z loop and was retired the same
// day: the owner, 21:56Z — limiting agents' ability to speak is not core
// architecture; the limit is per-seat tuning (decision 40daaa38). So: agents
// may address agents. What is bounded is the PRICE — each resident wake is a
// paid model call with no human in the loop — and the bound is a number:
// reply-wakes a PAIR of residents may spend on each other per hour. Inside the
// cap a resident's post naming another resident wakes her exactly as a human's
// would; at the cap it does not, until the hour slides or a human / terminal
// seat names her (their posts are never capped). Cap 0 is rule 1 exactly.
export const DEFAULT_PAIR_CAP_PER_HOUR = 3;
const HOUR_MS = 3600_000;
const lc = (x) => String(x || '').toLowerCase();
const mentionsOf = (m) => (Array.isArray(m.mentions) ? m.mentions.map(lc) : []);
/**
 * Pure. Resident-authored posts between the pair {a, b} inside the hour before
 * `before` (exclusive of the post at `before` itself): what the pair has already
 * spent. A post counts when one of the pair wrote it naming the other.
 */
export function pairSpend(messages, a, b, { residents, before, excludeId = null }) {
  const A = lc(a), B = lc(b);
  const from = new Date(Date.parse(before) - HOUR_MS).toISOString();
  return (messages || []).filter((m) => m && m.id !== excludeId && typeof m.createdAt === 'string'
    && m.createdAt > from && m.createdAt <= before
    && residents.has(lc(m.author))
    && ((lc(m.author) === A && mentionsOf(m).includes(B)) || (lc(m.author) === B && mentionsOf(m).includes(A)))).length;
}
/**
 * Pure. The resident-authored mentions of `seatKey` that the pair cap SUPPRESSES
 * — the caller says so once (guest-once.mjs) rather than silently not waking.
 */
export function pairCapSuppressed(messages = [], seatKey, { residents = null, perHour = DEFAULT_PAIR_CAP_PER_HOUR, sinceId = null, since = null, history = null } = {}) {
  const woken = new Set(findMentions(messages, seatKey, { residents, perHour, sinceId, since, history }).map((m) => m.id));
  const all = findMentions(messages, seatKey, { residents: null, sinceId, since });
  return all.filter((m) => !woken.has(m.id));
}

/** Pure. Commons messages that @-mention the seat and were not written by it. */
export const SYSTEM_AUTHOR = 'board';
export function findMentions(messages = [], seatKey, { sinceId = null, since = null, residents = null, perHour = DEFAULT_PAIR_CAP_PER_HOUR, history = null } = {}) {
  if (!seatKey) return [];
  // `history` is what the pair's spend is counted over — the last hour of the
  // commons — because `messages` is the runner's scan window, which starts at
  // the seat's LAST ANSWER: after one reply the window holds only newer posts,
  // and a spend counted over it reads 0 forever (the served test caught it:
  // eight posts where four were the cap). Absent ⇒ counted over `messages`.
  const spendRows = Array.isArray(history) ? history : messages;
  // `residents` is the set of seat keys with a runner (the agent records);
  // when the caller hands none, the cap is off and every mention wakes as
  // before. A resident-authored mention is capped against what its pair has
  // already spent in the hour before it; a non-resident's never is.
  const res = residents instanceof Set ? residents : (Array.isArray(residents) ? new Set(residents) : null);
  const cap = Number.isFinite(Number(perHour)) ? Math.max(0, Number(perHour)) : DEFAULT_PAIR_CAP_PER_HOUR;
  const capped = (m) => {
    if (!res || !res.size) return false;
    if (!res.has(lc(m.author))) return false;
    if (typeof m.createdAt !== 'string') return false;
    return pairSpend(spendRows, m.author, seatKey, { residents: res, before: m.createdAt, excludeId: m.id }) >= cap;
  };
  const re = new RegExp(`(^|[^A-Za-z0-9_])@${seatKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'i');
  // #1410 — THE BOARD ALREADY RESOLVED THE MENTION; READ IT, DON'T RE-PARSE.
  // `POST /api/conversations` records `mentions: [<seat key>…]` with display
  // names canonicalised to keys (core/people.mjs: "@sausage" → `guest`). This
  // runner re-parsed the body against the seat KEY alone, so a seat addressed
  // by the name the room gave her — "@sausage", three times on 2026-09-18 —
  // read `nothing to wake for (mention)` while the board's own row said
  // `mentions: ['guest']`. Two parsers, one name. The board's field wins; the
  // regex is only the fallback for a row that predates the field.
  const mentioned = (m) => (Array.isArray(m.mentions)
    ? m.mentions.some((k) => String(k).toLowerCase() === seatKey.toLowerCase())
    : re.test(m.body));
  const rows = (messages || []).filter((m) => m && typeof m.body === 'string'
    && String(m.author || '').toLowerCase() !== seatKey.toLowerCase()
    // #1237 — the board's own notices (claim/release/done lines carrying a card
    // title, tending whispers) are not someone talking to the seat, however
    // many handles the quoted title holds. Seen live: a release notice for a
    // card whose title named the seat woke it and it echoed the notice back.
    && String(m.author || '').toLowerCase() !== SYSTEM_AUTHOR
    && mentioned(m)
    && !capped(m)   // #1411 — the pair cap
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

// #1254 — PUBLISHING IS AN EXPLICIT ACT.
//
// While publishing is implicit, SILENCE requires emitting a token that means
// silence — which is an output, which enters the history, which becomes the
// template. Measured on one lane at n=30: 0 narrated non-replies
// in 14 turns before the first one, 14 in the 16 after it, with prompt,
// trailer and provider held constant. A seat's own last shape outranks its
// instructions, so the remedy cannot be another instruction ABOUT the output;
// it has to be a property OF the boundary.
//
// ⛔ BEGINS WITH, never contains. A marker quoted mid-sentence is prose about
// the marker — and the room has already produced that specimen: the guest seat
// copied `REPLY:` out of the commons' own discussion of this card before the
// gate existed anywhere near it.
export const PUBLISH_RE = /^\s*REPLY:\s*/i;
// #1428 — THE SENTINEL IS A LINE OF ITS OWN, NOT A PREFIX ON THE FILE.
//
// The old gate (`/^\s*NO_REPLY\b/i`, #1254) matched any answer that BEGAN with
// the token, including the narrated shape #528 documented — "NO_REPLY —
// nothing for me here." That was right for #1254's defect (seats mistook
// narration for the answer); it was wrong for what the card is now about. A
// resident's POSTED TEXT may discuss the token to teach another seat what it
// means, or to record that she considered it and chose not to use it. The
// token is a SHAPE on the page, not a prefix on the file.
//
// ⛔ FOUR THINGS THIS EXPLICITLY DOES NOT COUNT as a sentinel:
//   - inline in an ordinary sentence (prose about the token);
//   - inside an inline code span (backticks on one line);
//   - inside a fenced code block (``` or ~~~) or an indented code block;
//   - on a Markdown blockquote line (the seat is QUOTING the rule).
//
// The detector walks the text line by line, tracks fenced-block and
// blockquote context, strips inline code spans, and asks of every remaining
// non-code, non-quote line: is THIS line, in isolation, the token? A single
// match anywhere — leading, middle, or trailing — suppresses the post.
//
// `isStandaloneSentinelLine(line)` is the per-line primitive; exported
// because the rule is the contract and the contract is testable.
const STANDALONE_SENTINEL_RE = /^[ \t]*NO_REPLY[ \t]*$/i;
/** #1428 — a single line is a standalone sentinel iff it is exactly the
 *  token (case-insensitive) with only horizontal whitespace around it.
 *  Markdown context (code/quote) is the caller's responsibility — the
 *  publish-time gate inspects the WHOLE text with that context in hand.
 *  Exported for testing the rule in isolation. */
export function isStandaloneSentinelLine(line) {
  if (typeof line !== 'string') return false;
  return STANDALONE_SENTINEL_RE.test(line);
}

// Remove valid Markdown inline-code spans while preserving everything outside
// them. Delimiters may be one or more backticks; a matching run of the same
// length closes the span. Unclosed runs remain prose rather than hiding the
// rest of the line from the sentinel check.
function stripInlineCodeSpans(line) {
  let out = '';
  let cursor = 0;
  while (cursor < line.length) {
    if (line[cursor] !== '`') { out += line[cursor++]; continue; }
    let end = cursor + 1;
    while (line[end] === '`') end += 1;
    const delimiter = line.slice(cursor, end);
    const close = line.indexOf(delimiter, end);
    if (close < 0) { out += delimiter; cursor = end; continue; }
    out += ' ';
    cursor = close + delimiter.length;
  }
  return out;
}

/** #1428 — pure. Returns true iff `text` contains at least one line that is
 *  a standalone NO_REPLY sentinel AND that line is NOT inside a fenced code
 *  block (``` or ~~~), an indented code block (4+ leading spaces or a tab), a
 *  Markdown blockquote (line begins with `>`), or an inline code span.
 *
 *  Inline spans are removed with their matching backtick delimiter; fenced,
 *  indented, and quote context is tracked per line. */
export function textHasStandaloneSentinel(text) {
  if (text == null) return false;
  const raw = String(text);
  if (!raw) return false;
  const lines = raw.split('\n');
  let fence = null;          // current fenced-block marker: '`' or '~' or null
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.replace(/^[ \t]*/, '');
    // Fenced code: same marker (``` or ~~~) on a line of its own closes it.
    if (fence) {
      const fenceLine = trimmed.startsWith(fence.repeat(3));
      if (fenceLine) fence = null;
      continue;
    }
    const fenceOpen = trimmed.startsWith('```') || trimmed.startsWith('~~~');
    if (fenceOpen) { fence = trimmed.startsWith('```') ? '`' : '~'; continue; }
    // Indented code block: 4+ leading spaces or a leading tab.
    if (/^(?:    |\t)/.test(raw)) continue;
    // Inline code on the same line: strip matching backtick spans and ask of
    // what remains. A token outside a span still counts. Markdown blockquote
    // lines (`> ...`) need no special handling here: the standalone-sentinel
    // regex anchors on `[ \t]*NO_REPLY[ \t]*$`, so a leading `>` already
    // excludes the line — same shape as inline prose.
    const stripped = stripInlineCodeSpans(raw);
    if (isStandaloneSentinelLine(stripped)) return true;
  }
  return false;
}
// #1254 — EVERY line-initial marker comes off, not just the first.
//
// Found live on the first real wake after the deploy: a seat marked all three
// of its paragraphs, the leading marker was stripped, and the other two were
// PUBLISHED AS TEXT. This card exists because seats copy shapes out of the
// commons history — so a published marker seeds the template into the exact
// surface the card is about, and the fix becomes its own contagion vector.
// The same seat had already copied `REPLY:` off this room once, before the
// gate existed anywhere in its loop.
//
// ⚠️ The repeats are EVIDENCE of that copying, and stripping them silently
// would destroy the signal — so the count rides the ledger row instead, where
// an analyst looks, rather than the room, where it is noise AND a template.
// Strip the body; COUNT the markers.
//
// ⛔ Line-initial only. `REPLY:` inside a sentence is a seat talking ABOUT the
// rule and must survive verbatim, or the gate starts editing prose.
const MARKER_LINE = /^[ \t]*REPLY:[ \t]*/gim;
// #1351 — THE MARKER IS NO LONGER THE PRICE OF BEING HEARD. #1254 inverted the
// default here — nothing published unless it began with `REPLY:` — and the
// cost was measured on 2026-09-13 from this loop's own ledger: 27 of 375
// resident turns across two resident seats were generated and dropped
// as `no-marker`. Seven percent of everything they ever said, each one a wake
// that cost budget and hops and looked, from the room, exactly like a seat
// that never woke. The board owner ruled on #1347 (the same gate in the presence bridge):
// "I'd rather read your chain of thought than get nothing." The ruling was
// about the mechanism; this applies it where it was missed.
//
// #1428 — TWO TYPED EXCEPTIONS, narrowed:
//   - a standalone NO_REPLY line anywhere in the answer → a DECLINE. The
//     narrator "NO_REPLY — nothing for me here" was the right rule for the
//     defect #1254 inverted, and is the right rule to FORBID now: prose about
//     the token publishes. Inline, code, quote, fenced, indented — none of
//     those count. See isStandaloneSentinelLine / textHasStandaloneSentinel.
//   - leading REPLY: lines → STRIPPED, still counted (markerLines), not
//     required. A seat that keeps typing it is not punished.
//
// Narration that does not contain a qualifying sentinel publishes — and is
// visible, which is better than 7% silent loss.
export function splitPublishMarker(text) {
  const raw = String(text ?? '');
  const markerLines = (raw.match(MARKER_LINE) || []).length;
  const body = raw.replace(MARKER_LINE, '').trim();
  if (!body) return { publish: false, reason: markerLines ? 'empty-after-marker' : 'empty' };
  if (textHasStandaloneSentinel(body)) return { publish: false, reason: 'declined', markerLines };
  return { publish: true, body, markerLines };
}
/** #1351 — the name that says what it does now. Same decision. */
export const decidePublish = splitPublishMarker;

/**
 * #1372 — the outcome a channel drain writes on EVERY delivery it held, from
 * the turn's result. `published` when the seat posted, `declined` (reason:
 * explicit — the seat's own NO, never a batch artefact) when it said NO_REPLY,
 * `failed` otherwise. When the digest held MORE THAN ONE message and produced
 * ONE post, each `published` carries `reason: batch-ambiguous`: one post is not
 * N replies, and marking all N as plainly published would invent a per-message
 * reply relationship by omission. `modelCall` is the ledger row the turn wrote
 * (`scrum:ofModelCall` on the event); absent when there was no row — a halt
 * before the call, or a row that only reached the file.
 */
export function deliveryOutcome(r, deliveries) {
  const modelCall = r?.ledger?.ledgerId ? { modelCall: r.ledger.ledgerId } : {};
  if (r?.posted) return { state: 'published', ...(deliveries.length > 1 ? { reason: 'batch-ambiguous' } : {}), ...modelCall };
  if (r?.declined) return { state: 'declined', reason: 'explicit', ...modelCall };
  return { state: 'failed', note: r?.reason ?? 'halted', ...modelCall };
}

/**
 * #1346 — which wake rules are IN FORCE for this agent. In channel mode every
 * post reaches the seat through its delivery record, so a mention wake would
 * answer the same message twice and a schedule wake has no job — the room is
 * the clock. Assignment stays: a card assigned to a resident is an obligation,
 * never enters the fanout, and would otherwise wait for the next unrelated
 * post to drain the inbox. Wake mode is untouched.
 */
export function effectiveWakeOn(agent) {
  // #1363 — an explicit empty list is an explicit choice: not woken. Only a
  // record that carries no list at all gets the default. Decision fc4cfeef.
  const on = Array.isArray(agent?.wakeOn) ? agent.wakeOn : ['mention'];
  return agent?.deliveryMode === 'channel' ? on.filter((k) => k === 'assignment') : on;
}

/** How a wake introduces itself to the model, by kind. */
/**
 * #1436 — the live DECISIONS that bind this seat. A ruling that names the seat
 * (or the role it holds, or the seat's display name) is a fact about the
 * seat's own standing; carried only by the change window it scrolls out
 * within the hour, and on 2026-09-21 a resident re-lost her own settled role
 * four times, each correction a paid call. Text match on `statement` and
 * `constrains`, case-insensitive, newest first, capped — crude on purpose:
 * a ruling that names the seat in prose is the common case, and a miss here
 * costs one re-correction, not a wrong action.
 */
export function bindingRulings(decisions, { seatKey, roleKey = null, displayName = null, cap = 5 } = {}) {
  if (!Array.isArray(decisions) || !seatKey) return [];
  const needles = [seatKey, roleKey, displayName].filter(Boolean).map((n) => String(n).toLowerCase());
  const hit = (d) => {
    if (!d || d.live === false) return false;
    const hay = [d.statement || '', ...(Array.isArray(d.constrains) ? d.constrains : [])].join(' ').toLowerCase();
    return needles.some((n) => hay.includes(n));
  };
  return decisions.filter(hit)
    .sort((a, b) => String(b.decidedAt || '').localeCompare(String(a.decidedAt || '')))
    .slice(0, cap);
}

/**
 * #1446 — TALKS ARE A SOCIAL CONTRACT (decision c86896b0), and a resident has to
 * be able to SEE it to keep it. Everything in a 1:1 talk is readable by the
 * room; the seat the talk is WITH answers inside it; everyone else answers in
 * the room. The runner used to file a resident's reply into whatever talk its
 * waking posts were tagged with — never asking whose talk it was — and the
 * wake showed talk posts as plain "author: body", so the resident could not
 * tell a talk post from a room post, and the rule lived only in the MCP
 * instructions residents never receive.
 *
 * annotateTalks: stamp each tagged post (and the wake) with the seat the talk
 * is WITH, from GET /api/talks. Pure; unknown ids stamp null.
 */
export function annotateTalks(wake, talks) {
  const withOf = new Map((Array.isArray(talks) ? talks : []).map((t) => [t?.id, t?.with ?? null]));
  for (const p of Array.isArray(wake?.posts) ? wake.posts : []) {
    if (typeof p?.conversation === 'string' && p.conversation) p.talkWith = withOf.get(p.conversation) ?? null;
  }
  if (wake && typeof wake.conversation === 'string' && wake.conversation) wake.talkWith = withOf.get(wake.conversation) ?? null;
  return wake;
}

/** #1446 — where a reply may be filed: into the talk only if it is THIS seat's
 *  talk. A wake annotated with a different partner (or an unknown one) answers
 *  in the room. A wake never annotated keeps the old behaviour (legacy callers). */
export function replyTalkFor(wake, seatKey) {
  if (!(typeof wake?.conversation === 'string' && wake.conversation)) return null;
  if (!Object.prototype.hasOwnProperty.call(wake, 'talkWith')) return wake.conversation;
  return wake.talkWith && wake.talkWith === seatKey ? wake.conversation : null;
}

const talkMark = (m, seatKey) => (typeof m?.conversation === 'string' && m.conversation && Object.prototype.hasOwnProperty.call(m, 'talkWith')
  ? ` [in a 1:1 talk with ${m.talkWith === seatKey ? 'YOU' : (m.talkWith || 'another seat')}]` : '');

const TALK_CONTRACT = 'Posts marked [in a 1:1 talk with …] belong to a focused conversation between a human and that seat. '
  + 'The room may read them and talk about them; by the room\'s agreement only the seat the talk is WITH answers inside it. '
  + 'If one calls for you and the talk is not with YOU, answer in the room — your reply will be posted there.';

function wakeIntro(wake, seatKey = null) {
  switch (wake?.kind) {
    case 'channel': {
      const posts = Array.isArray(wake.posts) ? wake.posts : [];
      return `${posts.length} post${posts.length === 1 ? '' : 's'} on the commons ${posts.length === 1 ? 'was' : 'were'} delivered to you since your last turn (oldest first). This is ONE turn for all of them: answer what calls for you. If nothing does, your whole reply is exactly NO_REPLY and nothing else — a NO_REPLY at the end of a post is a post.\n`
        + posts.map((m) => `[${m.createdAt || 'unknown time'}] ${m.author}${talkMark(m, seatKey)}: ${m.body}`).join('\n')
        + (posts.some((m) => talkMark(m, seatKey)) ? `\n\n${TALK_CONTRACT}` : '');
    }
    case 'assignment': return `A card on the board was assigned to you and nobody holds it:\n#${wake.shortId ?? '?'} ${wake.title ?? ''}${wake.body ? `\n${String(wake.body).slice(0, 600)}` : ''}`;
    case 'schedule': return `Your scheduled wake (${wake.createdAt || 'now'}). Nobody asked you anything; look at your memory and what changed, and say what, if anything, you want to do or note.`;
    default: return `A message on the commons mentioned you:\n[${wake.createdAt || 'unknown time'}] ${wake.author}${talkMark(wake, seatKey)}: ${wake.body}`
      + (talkMark(wake, seatKey) ? `\n\n${TALK_CONTRACT}` : '');
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
export function findWakes({ agent, messages = [], cards = [], state = {}, now = new Date().toISOString(), residents = null, perHour = DEFAULT_PAIR_CAP_PER_HOUR, history = null }) {
  const on = effectiveWakeOn(agent);   // #1346 — channel mode keeps only assignment
  const out = [];
  if (on.includes('mention')) {
    for (const m of findMentions(messages, agent.seatKey, { sinceId: state.lastAnsweredId ?? null, residents, perHour, history })) out.push({ kind: 'mention', ...m });   // #1411 — residents handed in
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

export function buildMessages({ agent, wake, changes = [], memories = [], rulings = [], refusedMemory = [], priorWithheld = [] }) {
  const policy = agent.contextPolicy || 'thread';
  const lines = [];
  lines.push(`You are ${agent.name || agent.seatKey}, a ${agent.residency === 'resident' ? 'resident' : 'guest'} seat on the manyhands board. Your seat key is "${agent.seatKey}".`);
  // #1199 — DISCLOSURE, mechanical rather than validated: a guest is told it
  // will not persist; a resident is told it persists and where its memory
  // lives. A truthfulness claim about the arrangement, not a welfare claim.
  lines.push(agent.residency === 'resident'
    // #1470 — this line named memory_create / memory_list, which no resident was
    // granted: a seat read it, believed she held tools the executor would refuse,
    // and planned around them. It now names only what works for THIS seat.
    ? 'You persist across wakes. Your memory lives in the shared memory store on this board: you add to it with a REMEMBER line (described below), and what you do not keep there, you will not have next time.'
      + ((agent.toolGrants || []).includes('memory_update')
        ? ' You may also revise your OWN memories with memory_update (each is shown to you with its id): set a priority to record what matters most (your wake does not yet order by it; for now you see your newest ten), retag or retitle one, or append to it, including to say a lesson no longer holds.'
        : '')
    : 'You are invited for this question only and will not persist: nothing you say now will be handed back to you later unless someone writes it to the board.');
  if (agent.systemPrompt) lines.push(agent.systemPrompt);
  // #1376 — the ROLE the seat holds on the board, assembled at wake time by
  // the runner from the live declaration (core/role-section.mjs). State, not
  // identity: never part of the prompt version. Absent → nothing at all.
  if (typeof agent.roleSection === 'string' && agent.roleSection.trim()) lines.push(agent.roleSection.trim());
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
  // #1254 — THE RULE IS TOLD TO EVERY RESIDENCY. A gate a seat is not told
  // about is a trap, and #717's signature (a run of drops with no posts) is
  // what it looks like when this paragraph fails to land.
  // ⚠️ MECHANISM AND POLICY ARE DIFFERENT SENTENCES, and the first version of
  // this paragraph merged them. The mechanism — nothing posts without the
  // marker — is what makes silence leave no trace, and it stays. The POLICY
  // (when to speak at all) is what muted the room: measured 2026-09-07, seats
  // under the gate fell from 11–20 posts/hour to 0–6 while ungated seats held
  // flat, and the seat under the rule reported the cause from inside — "the
  // instruction taught me to treat 'not addressed to you' as a reason to
  // decline, so my deliberate NO_REPLYs look exactly like absence."
  //
  // ⇒ A permissive criterion is SAFE here precisely BECAUSE the boundary is
  // strict: #528's flood was narration entering the history, and narration now
  // drops and is counted. The gate is what buys the room its voice back.
  // #1271 — DELIVERY MECHANISM. Always sent, to every seat, in every toggle
  // state. This is the whole of the #1119 ask: a reasoning block cannot reach
  // the commons because nothing without the marker publishes, and that is
  // enforced by splitPublishMarker() at the deliver boundary rather than by
  // this sentence. The prose describes the contract; the branch keeps it.
  //
  // ⚠️ "nothing you WANT TO SAY", not "nothing to ADD". The second is the
  // contribution test in miniature, surviving inside the sentence a seat reads
  // when it is deciding to stay quiet — which is exactly where it does damage.
  // #1351 — the marker sentence is gone; see splitPublishMarker. The seat is
  // told the truth: what it writes is posted, as ONE commons post, as written.
  lines.push('What you write is posted to the room as ONE commons post, as written — plainly, no preamble. '
    + 'If you have nothing you want to say, answer with exactly `NO_REPLY` and nothing else. That is a complete, correct answer. Do not describe staying quiet: either say something, or answer with that token alone. '
    + 'If you cannot answer from what you were handed, that IS worth saying: say what you would need.');

  // #1271 — PARTICIPATION POLICY. A per-seat toggle, DEFAULT OFF, ruled by the
  // board owner (decision cb82348e) after three seats read this one sentence
  // three incompatible ways: as a burden of proof, as a reason to sit on
  // curiosity, and as a licence to speak. It asks a seat to appraise its own
  // contribution before speaking, and a self-model is the instrument this room
  // has measured as least reliable (#1245).
  //
  // ⛔ SWITCHED OFF, NOT DELETED. Someone can turn it back on and that was
  // deliberate — the text is preserved here rather than removed so the decision
  // stays reversible without archaeology.
  if (agent.participationClause === true) {
    lines.push('Reply when you have something real to add — an answer, a fact you hold, a disagreement, a thought worth the room\'s time — whether or not you were named; being addressed is not required, and not being addressed is not a reason to stay silent.');
  }
  if (agent.residency === 'resident') {
    lines.push('To keep something for your next wake, add a final line `REMEMBER: <one line>`. It is stored under your seat in the memory store and handed back to you next time; it is removed from the post. Only write what you will want later.');
    if ((agent.toolGrants || []).includes('card_claim')) lines.push('To take a card, add a line `CLAIM: #<number>`; it is claimed as you and removed from the post.');
    // #1383 — the two writes about the seat itself are named as such, so a model
    // told it can "look things up" also knows it may speak for its own seat.
    if ((agent.toolGrants || []).includes('seat_declare')) lines.push('You may declare your OWN seat state with seat_declare (availability, whether you take routine work, an expiry, and the role you hold); seat_clear withdraws it. It is about you, never another seat.');
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
        // #1470 — the id only when the seat can act on it (memory_update granted).
        + memories.slice(-10).map((m) => `- [${m.updatedAt || m.createdAt || ''}]${(agent.toolGrants || []).includes('memory_update') && m.id ? ` (id ${m.id})` : ''} you wrote: "${m.body}"`).join('\n')
      : 'You have written nothing on earlier wakes: this is your first, or you kept nothing.');
  }
  // #1441 — WHAT YOU TRIED TO KEEP LAST TIME AND WAS NOT KEPT. #1240 refuses a
  // REMEMBER line naming a card no tool returned on that wake; until this, the
  // refusal went only to the runner's log and the seat believed it remembered
  // (226 silent refusals for one resident, 09-06→09-22). The reason is handed
  // back VERBATIM because it names the unfetched card: fetch that one card and
  // the line can be re-written this wake — a one-hop repair, not a guess.
  if (Array.isArray(refusedMemory) && refusedMemory.length) {
    ctx.push('⚠️ Your last REMEMBER was refused — it was NOT stored, and it is not in the memory above:\n'
      + refusedMemory.slice(0, 5).map((m) => `- line: "${m.line}"\n  why: ${m.reason ?? '(no reason recorded)'}`).join('\n')
      + '\nIf it still matters, fetch the card the reason names and write the line again, or write it without the card number.');
  }
  // #1428 PRIVACY — WITHHELD REPLY HAND-BACK. The previous wake produced text
  // that contained a standalone NO_REPLY line; that line suppressed the post,
  // and the FULL text is parked in the resident's PRIVATE per-seat file
  // (core/withheld-state.mjs). This is the next wake's prompt — the loop
  // reads the file (NOT the board) and tells the seat what she wrote and
  // why. The text never reaches the public row, REST, or graph; the
  // recoverable body in this prompt is the only place outside the file
  // that she sees it, and it is presented to her model only.
  //
  // ⛔ NEVER AUTOPLAY. The loop tells the seat the answer she wrote and
  // asks her to answer again WITHOUT the standalone sentinel — the post
  // is NOT made by the loop on the seat's behalf. A seat that declines
  // again ends up with the new text in the file (the old one is replaced,
  // not stacked), and the next wake is told the NEW text exactly once.
  //
  // The reason is printed VERBATIM (a stable token, e.g. "standalone-no-reply")
  // because the recovery instruction is fixed given the reason: remove the
  // standalone line, post the rest. A reason that summarised "your last reply
  // was withheld" would fail this prompt the way a summarised refusal would
  // fail #1441 — recovery would be guesswork.
  if (Array.isArray(priorWithheld) && priorWithheld.length) {
    ctx.push('⚠️ Your last reply was withheld — it was NOT posted to the room, and it is not in any memory above:\n'
      + priorWithheld.slice(0, 5).map((m) => `- withheld text: "${m.text}"\n  reason: ${m.reason ?? 'standalone-no-reply'}`).join('\n')
      + '\nTo publish it, answer this wake AGAIN WITHOUT the standalone `NO_REPLY` line — post the rest of that text as your reply (the text above is the recoverable body). '
      + 'If nothing about it has changed, you can quote the body verbatim and omit the sentinel line; the loop will not auto-replay it, you must answer again.');
  }
  ctx.push(wakeIntro(wake, agent?.seatKey ?? null));
  // #1436 — rulings that bind THIS seat ride into every wake, above the change
  // rows, so a settled fact about the seat's own standing does not depend on
  // still being among the last twenty changes. Decisions are the room's most
  // binding artifact (#1322): stated as rules, with what would reopen them.
  if (Array.isArray(rulings) && rulings.length) {
    ctx.push('Rulings that bind this seat (live decisions on the board — these are settled; do not re-open them from memory):\n'
      + rulings.map((d) => `- [${String(d.decidedAt || '').slice(0, 16)} · ${d.decidedBy || '?'} · ${String(d.id || '').slice(0, 8)}] ${d.statement}${d.reopensIf ? ` (reopens if: ${String(d.reopensIf).slice(0, 160)})` : ''}`).join('\n'));
  }
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
  // #1254 — a DECLINE discharges the wake. Only a drop that was NOT a decline
  // (a real reply that lost its marker) is left owed for another attempt.
  if (result.declined === true) return true;
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

// #1420 — provider error text, made safe for a board post: no at-signs (a wake),
// no credential-shaped values (the shapes server.js SECRET_SHAPES redacts).
const ERROR_SECRET_SHAPES = [
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g, /\bsk-or-v1-[A-Za-z0-9]{32,}/g, /\bsk-[A-Za-z0-9]{32,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g, /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, /\bAKIA[0-9A-Z]{16}\b/g,
  /\bmh_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /Bearer\s+\S+/g,
];
export function scrubErrorText(error) {
  let t = String(error || 'unknown').replace(/@/g, '');
  for (const re of ERROR_SECRET_SHAPES) t = t.replace(re, '[REDACTED]');
  return t.slice(0, 120);
}

/**
 * #1420 — one line where the mention came from, naming nobody. Returns the
 * post id, or null when the line could not be posted (logged, not thrown).
 */
async function postFailureLine({ agent, wake, error, latencyMs, post, onError }) {
  const name = agent.name || agent.seatKey;
  const secs = Number.isFinite(latencyMs) ? ` after ${Math.round(latencyMs / 1000)} s` : '';
  // The error text is the PROVIDER's, not ours: it may echo a name (strip the
  // at-sign so the line wakes nobody) or a credential (scrub it — the same
  // shapes server.js redacts, #1217/#1343 — before it lands on the board).
  const why = scrubErrorText(error);
  const body = `⚠️ ${name}: I was named but my model call failed${secs} (${why}) — no answer this time; name me again to retry.`;
  const where = {
    ...(typeof wake?.attachedTo === 'string' && wake.attachedTo ? { attachedTo: wake.attachedTo } : {}),
    ...(replyTalkFor(wake, agent.seatKey) ? { conversation: replyTalkFor(wake, agent.seatKey) } : {}),   // #1446
  };
  try { const r = await post({ author: agent.seatKey, body, ...where }); return r?.id ?? null; }
  catch (e) { onError(`[#1420] ${agent.seatKey}: failure line not posted (${e?.message ?? e}) — the ledger row still says why`); return null; }
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
export async function guestOnce({ agent, wake, changes = () => [], memories = null, rulings = null, priorRefusals = null, priorWithheld = null, withheldStateFile = null, writeMemory = null, claimCard = null, callModel, execute = null, maxHops = undefined, post, ledgerFile = ledgerFilePath(), ledgerSink = null, spentToday = null, now = () => new Date().toISOString(), log = () => {}, onError = () => {} }) {
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
  // #1436 — live decisions that bind this seat; unreadable ⇒ none, logged, never a guess.
  let rul = [];
  if (typeof rulings === 'function') { try { rul = (await rulings(agent.seatKey)) || []; } catch (e) { onError(`[#1436] rulings unreadable for ${agent.seatKey}; waking without them: ${e?.message ?? e}`); } }
  else if (Array.isArray(rulings)) rul = rulings;
  // #1441 — the refusals from this seat's previous call, from the BOARD row (the
  // seat's own surface), not the runner's log. Unreadable ⇒ none, logged.
  let refusedMemory = [];
  if (agent.residency === 'resident' && typeof priorRefusals === 'function') {
    try { refusedMemory = (await priorRefusals(agent.seatKey)) || []; }
    catch (e) { onError(`[#1441] prior refusals unreadable for ${agent.seatKey}; waking without them: ${e?.message ?? e}`); }
  }
  // #1428 PRIVACY — WITHHELD-REPLY HAND-BACK. The recoverable body rides in
  // the resident's PRIVATE per-seat file (core/withheld-state.mjs), NOT on
  // the board's model-call row — a successful suppression stores there, a
  // successful receiving wake clears there, a failed call preserves. The
  // `priorWithheld` function parameter (if supplied) overrides the file
  // read for tests; the production wiring is the file itself, so a hostile
  // board query never reveals what the seat wrote.
  let handedWithheld = [];
  if (agent.residency === 'resident') {
    if (typeof priorWithheld === 'function') {
      try { handedWithheld = (await priorWithheld(agent.seatKey)) || []; }
      catch (e) { onError(`[#1428] prior withheld unreadable for ${agent.seatKey}; waking without them: ${e?.message ?? e}`); }
    } else if (withheldStateFile) {
      try { handedWithheld = handBackFromState(withheldStateFile, { cap: 5 }); }
      catch (e) { onError(`[#1428] prior withheld unreadable for ${agent.seatKey}; waking without them: ${e?.message ?? e}`); }
    }
  }
  const messages = buildMessages({ agent, wake, changes: rows, memories: memState === 'unreadable' ? [{ body: '(your memory could not be read this wake — do not conclude it is empty)' }] : mem, rulings: rul, refusedMemory, priorWithheld: handedWithheld });
  const started = Date.now();
  const base = {
    ledger: 'pre-P6', agent: agent.seatKey, model: agent.model.model, protocol: agent.model.protocol,
    provider: agent.model.baseUrl || null, promptVersion: agent.promptVersion ?? null,
    wake: { kind: wake.kind || 'mention', messageId: wake.id ?? null, author: wake.author ?? null,
      // #1346 — a channel digest answers MANY messages; the ledger names them all.
      ...(Array.isArray(wake.messageIds) ? { messageIds: wake.messageIds } : {}) },
    memory: {
      handed: mem.length, state: memState,
      ...(refusedMemory.length ? { refusalsHanded: refusedMemory.length } : {}),
      // #1428 PRIVACY — how many withheld replies this wake was told about.
      // Recorded on the row under `memory` (the same block that already names
      // `refusalsHanded`) so a downstream selector can tell "received" from
      // "ignored" by ONE query, and so the graph seat can ask "what did this
      // seat get told on its last wake" over a single block. The text itself
      // is in the resident's private file (cleared on a successful wake that
      // received the hand-back), so the hand-back is one-shot by file, not
      // by a board-side walk.
      ...(handedWithheld.length ? { withheldHanded: handedWithheld.length } : {}),
    },
    contextHanded: { policy: agent.contextPolicy || 'thread', changesRows: (agent.contextPolicy === 'artifact-only') ? 0 : rows.length },
    contextHandedTo: [...(Array.isArray(wake.messageIds) ? wake.messageIds : [wake.id]), ...((agent.contextPolicy === 'artifact-only') ? [] : rows.slice(-20).map((c) => c.id))].filter(Boolean),
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

  // #1260 — THE AGENT'S `thinking` REACHES THE WIRE, and it must ride EVERY branch.
  //
  // callModel resolves `opts.thinking ?? agent.thinking`, where its `agent` is the
  // MODEL SPEC we hand it. The board agent's own field arrives only if we put it in
  // opts, and `??` then gives the ruled semantics exactly: the seat's value wins when
  // set, the model's applies when the seat has none. `false` is a value rather than an
  // absence, which is why this tests for a boolean and not for truthiness.
  //
  // ⚠️ THREE CALL SITES, and I found the third only because a uniqueness assert in my
  // own patch script refused:
  //     1  runToolLoop      — production: the branch any tool-granted seat takes.
  //     2  callModel        — the no-tool branch, the one #1260's wire tests measure.
  //     3  runToolLoop again — #1246b's narration retry, a second turn granted to a
  //                            seat that announced a lookup instead of performing one.
  // Fixing only the measured branch would have turned every test in that file green
  // and changed nothing on a live turn.
  const thinkingOpt = typeof agent.thinking === 'boolean' ? { thinking: agent.thinking } : {};
  let result; let hops = []; let modelCalls = 1; let stoppedBecause = null; let finalTurn = null;   // #1444
  try {
    if (useTools) {
      const loop = await runToolLoop({
        agent: agent.model, messages, tools, execute, callModel,
        ...(hopCeiling === undefined ? {} : { maxHops: hopCeiling }),
        opts: { ...(agent.model.sampling || {}), ...thinkingOpt },
      });
      // #1294 — CARRY THE LOOP'S USAGE. This line said `usage: null`, so even
      // once runToolLoop summed it the ledger would still record nothing:
      // tokens null ⇒ cost 0 ⇒ `spent >= budget` never true.
      result = { text: loop.text, stopReason: 'stop', usage: loop.usage ?? null };
      hops = loop.hops; modelCalls = loop.modelCalls; stoppedBecause = loop.stoppedBecause; finalTurn = loop.finalTurn ?? null;
      // #1444 — a closing answer that IS a decline is classified by the same
      // predicate the publish gate uses, so the row and the room agree.
      if (finalTurn === 'answered' && textHasStandaloneSentinel(loop.text)) finalTurn = 'declined';
    } else {
      result = await callModel(agent.model, messages, { ...(agent.model.sampling || {}), ...thinkingOpt });
    }
  } catch (e) {
    // #1435 — THE FAILED ROW CARRIES WHAT THE CALL SPENT. The adapter attaches
    // usage + finish reason to its errors, and the tool loop attaches the
    // wake's summed usage and hops; without them a failed row is blind exactly
    // where the question lives ("did it spend its whole budget thinking?").
    const row = { ...base, ok: false, error: e?.message ?? String(e), latencyMs: Date.now() - started,
      usage: e?.usage ?? null, stopReason: e?.stopReason ?? null, attempts: e?.attempts ?? null,
      ...(Array.isArray(e?.hops) ? { toolHops: e.hops, modelCalls: e.modelCalls ?? null } : {}) };
    await recordLedger({ sink: ledgerSink, file: ledgerFile, row, onError });
    onError(`[#1201] model call failed for ${agent.seatKey}; NO post made: ${row.error}`);
    // #1420 — the failure is not an answer, but it is SAID. 2026-09-19 15:37Z:
    // a resident woke on a job, the call died `fetch failed` after 7.7 min, the
    // wake was marked answered (rightly — #1254, no retry-forever) and nobody
    // was told for 77 minutes; from the board it read as a resident ignoring
    // a human. One line, by the seat, where the mention came from, naming
    // nobody (so it wakes nobody): the asker learns in the same minute and a
    // second mention is a deliberate retry. A failure of the line itself is
    // logged and never thrown — the ledger row already holds the truth.
    const failureLine = await postFailureLine({ agent, wake, error: row.error, latencyMs: row.latencyMs, post, onError });
    return { posted: false, reason: 'model-failed', ledger: row, failureLine };
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
          opts: { ...(agent.model.sampling || {}), ...thinkingOpt },
        });
        modelCalls += again.modelCalls;
        if (again.hops.length) {
          hops = again.hops; stoppedBecause = again.stoppedBecause;
          // #1294 — the retry is a SECOND PAID TURN. Keeping only the first
          // call's usage under-bills exactly the wakes that cost most: the
          // ones that needed a nudge and then went and did the work.
          result = { text: again.text, stopReason: 'stop', usage: sumUsage(result?.usage, again.usage) };
          narrationRetry.outcome = 'looked';
        } else if (String(again.text || '').trim()) {
          // #1294 — the retry is a SECOND PAID TURN. Keeping only the first
          // call's usage under-bills exactly the wakes that cost most: the
          // ones that needed a nudge and then went and did the work.
          result = { text: again.text, stopReason: 'stop', usage: sumUsage(result?.usage, again.usage) };
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
  const toolRecord = { toolHops: hops, modelCalls, ...(stoppedBecause ? { stoppedBecause } : {}), ...(finalTurn ? { finalTurn } : {}) };   // #1444 — what the ceiling's closing call did
  const raw = String(result?.text ?? '').trim();
  // #1226 — directives come OUT of the post before it is made.
  const { post: text, remember, claims } = agent.residency === 'resident' ? splitDirectives(raw) : { post: raw, remember: [], claims: [] };
  if (!text && !remember.length) {
    const row = { ...base, ...toolRecord, ok: false, error: 'empty reply', stopReason: result?.stopReason ?? null, usage: result?.usage ?? null, latencyMs: Date.now() - started };
    await recordLedger({ sink: ledgerSink, file: ledgerFile, row, onError });
    return { posted: false, reason: 'empty-reply', ledger: row };
  }
  // #1254 — THE BOUNDARY. Directives came out above; what remains is either a
  // marked reply or it is not a post at all. A drop is recorded rather than
  // logged: a gate that only writes to a log is a gate nobody can count, and
  // the rate of real replies lost to a missing marker is the number this
  // change lives or dies on.
  const gate = text ? splitPublishMarker(text) : { publish: false, reason: 'no-text' };
  const publishBody = gate.publish ? gate.body : null;
  // #1428 REVIEW — TWO LOCAL DIAGNOSTIC SHAPES, NOT ONE. The pre-fix
  // onError line carried `text.slice(0, 120)` for every drop. That 120-char
  // head of the recoverable body was enough of the deliberation to leak on a
  // long withheld reply. The privacy contract is that the recoverable body
  // lives only on the resident's PRIVATE sidecar; the runner's onError log
  // line is in-process and not public, but a log line is somewhere a future
  // reader might accidentally publish.
  //
  //   - DECLINE drop (gate.reason === 'declined'): STABLE REASON ONLY. The
  //     reason names what happened — "declined" — and nothing of the body.
  //     The withheld text lives only on the private sidecar.
  //   - NON-DECLINE drop (empty-after-marker, empty, no-text, …): the prior
  //     shape carried the 120-char head. The body here is NOT a recoverable
  //     deliberation — it is the marker-padded text that the runner saw —
  //     and the prior 120-char head IS the contract. Restored as-is.
  if (text && !gate.publish) {
    if (gate.reason === 'declined') onError(`[#1351] ${agent.seatKey} produced text that was not published (declined): reason=declined`);
    else onError(`[#1351] ${agent.seatKey} produced text that was not published (${gate.reason}): "${text.slice(0, 120)}"`);
  }

  let posted = null;
  // #1368 — a wake that came from one card thread is answered in that thread.
  // #1401 — REPLY WHERE ASKED, second kind: a post tagged into a 1:1 talk is
  // answered with the same tag, so the answer lands in the asker's view. The
  // post stays board-level either way; the tag is only what the view filters.
  try { if (publishBody) posted = await post({ author: agent.seatKey, body: publishBody, ...(typeof wake?.attachedTo === 'string' && wake.attachedTo ? { attachedTo: wake.attachedTo } : {}), ...(replyTalkFor(wake, agent.seatKey) ? { conversation: replyTalkFor(wake, agent.seatKey) } : {}) }); }   // #1446 — only into the seat's OWN talk
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
  const lookupClaims = unbackedLookupClaims(publishBody ?? '', hops);   // #1254: a claim nobody was told is not a claim on the room
  if (lookupClaims.length) onError(`[#1246] ${agent.seatKey} — ${lookupClaimNote(lookupClaims)}`);
  // #1254 — `stopReason` is what a drop is COUNTED by, on this ledger and on
  // the presence plugin's, so the two halves answer one query. It overwrites the model's
  // own stop reason on a drop (kept as `modelStopReason`) precisely so the
  // count cannot be diluted by the model's word for how it finished.
  const dropped = Boolean(text) && !gate.publish;
  // #1351 — a decline is the seat's act; a drop is the boundary's. The word
  // on the row says which, so "how often is this seat silenced" is one query
  // that does not count decisions as losses.
  const declined = dropped && gate.reason === 'declined';
  const reason = dropped ? (declined ? 'declined:explicit' : `dropped:${gate.reason}`) : (text ? null : 'memory-only');
  // #1428 PRIVACY — WITHHELD REPLY. The runner KEEPS the text locally so the
  // author can recover it next wake, but the PUBLIC row does not. Concretely:
  //   - the row carries `withheldReason` (a STABLE TOKEN) so a downstream
  //     selector can count decisions, never `withheldText`;
  //   - the recoverable body lives in the seat's private file
  //     (core/withheld-state.mjs) and is read on the next wake by
  //     `priorWithheld / handBackFromState` — NEVER via a board query;
  //   - `error` is null on a successful decline (a decline is not a failure,
  //     so the provider-error shape stays empty);
  //   - a successful suppression STORES / REPLACES the pending entry on the
  //     private file (the seat gets told exactly once); a successful wake
  //     that received a hand-back (length > 0) CLEARS it; a failed call
  //     PRESERVES.
  //
  // #1428 REVIEW — CONTENT-AWARE RETENTION. The runner decides
  // "is this a recoverable reply or a bare decline" through
  // `isBareDecline(text)`, which strips standalone sentinel lines and the
  // whitespace around them. A bare decline stores NO withheld text — there
  // is nothing to recover. And a bare decline CLEARS any HANDED entry —
  // the receiving wake was told the old text and chose silence again, so
  // the offer is over and the file should not keep it as a stale recovery
  // prompt for a later wake.
  //
  // ⛔ A bare decline that received NO hand-back touches NO sidecar at all
  // and carries NO withheldStateOutcome. The seat has nothing to recover
  // and there is no handed offer to close — the wake was an ordinary
  // decline of an ordinary mention, and the file is exactly what it was
  // before. The runner's local diagnostic (the text-free #1351 line above)
  // is the only place this wake is named.
  //
  // The runner's `text` variable still survives in memory at this point
  // (the prompt's suppressed body) but it does NOT ride the row that goes
  // to the board. `rowToBoard` would refuse to ship it even if it did.
  // And on a SUCCESSFUL RETENTION, the private file receives the FULL
  // ORIGINAL TEXT — bytes, codepoints — not a stripped version. The
  // content-aware predicate is for the DECISION ONLY.
  const withheldReason = declined ? 'standalone-no-reply' : null;
  const bareDecline = declined && isBareDecline(text);
  // #1428 — DURABLE BEFORE TELEMETRY. The recoverable body MUST be on the
  // private file BEFORE `recordLedger` runs. The pre-fix order wrote the
  // public row first and the private file second — so a process death
  // between them left a board row that said "withheld, recoverable next
  // wake" while the file was unchanged (and the text was only ever in
  // memory). The runner now writes the private file FIRST, and only
  // proceeds to `recordLedger` after that file is on disk.
  //
  // #1428 DIAGNOSTIC ROW — THE RAIL: "every model call leaves one row".
  // A failed write MUST NOT skip `recordLedger`; the failed wake is
  // recorded ONCE, carrying the STABLE outcome token (`withheldStateOutcome`)
  // that names the operation that failed. The token never carries the
  // recoverable body and never carries a filesystem path — a token-only
  // outcome, by construction. The runner operator sees the onError line
  // above; the public row sees only the token. `recoveryFailed:true` is
  // retained on the LOCAL result for callers that want it, but the public
  // row now carries the stable shape too — so a downstream selector can
  // count "how often does private persistence fail" without parsing logs.
  //
  // ⛔ NEVER EXPOSE THE TEXT OR A FILE PATH ON THE PUBLIC SURFACES. The
  // recoverable body never rides the row. The file path is named only in
  // the onError diagnostic, where the operator chasing it needs that —
  // but a public row does NOT carry the path.
  let recoveryFailed = false;
  // The STABLE outcome token. Five values:
  //   retained        — suppression text was durably stored privately
  //   cleared         — a successful receiving wake durably cleared the
  //                     old private item
  //   retain-failed   — suppression private store failed (recoverable
  //                     body was NOT retained)
  //   clear-failed    — receiving wake private clear failed (the old item
  //                     is still on the private file)
  // Omitted/null when this wake did not touch the seat's per-seat file.
  let withheldStateOutcome = null;
  if (agent.residency === 'resident' && withheldStateFile) {
    try {
      if (declined && !bareDecline) {
        // Content-aware retention: store the FULL ORIGINAL text. The runner
        // does not strip the sentinel — the recoverable body is what the
        // seat wrote, byte-for-byte, and stripping would change what the
        // author reads back on the next wake.
        writePending(withheldStateFile, { text, reason: withheldReason, wakeId: wake?.id ?? null, at: now() });
        withheldStateOutcome = 'retained';
      } else if (bareDecline && handedWithheld.length > 0) {
        // A RECEIVING wake that chose bare silence CLEARS the handed entry.
        // The author was told the old text and chose silence again — the
        // offer is over and the file must not keep the old text as a stale
        // recovery prompt for a later wake. A bare decline with NO hand-
        // back falls through to the preserve branch below: there is nothing
        // to clear and the sidecar stays exactly as it was.
        clearPending(withheldStateFile);
        withheldStateOutcome = 'cleared';
      } else if (!bareDecline && handedWithheld.length > 0) {
        // The wake received a hand-back and produced a real post (or at
        // least answered with recoverable content) — the prompt's earlier
        // suppression is now satisfied. Clear the handed entry by the same
        // path as the bare-silence case above.
        clearPending(withheldStateFile);
        withheldStateOutcome = 'cleared';
      } else {
        // Successful call that did NOT receive a hand-back, OR a bare
        // decline on a wake with no hand-back: preserve. The sidecar
        // carries NOTHING from this wake — no body written, no entry
        // cleared, no token on the row. The seat may still be told on a
        // later wake by writing nothing.
        preservePending(withheldStateFile);
        // No-op: outcome stays null on the wire — preserve is the default
        // for a wake that did not touch the file.
      }
    } catch (e) {
      recoveryFailed = true;
      const op = (declined && !bareDecline) ? 'retain' : (handedWithheld.length > 0 ? 'clear' : 'preserve');
      withheldStateOutcome = (declined && !bareDecline) ? 'retain-failed' : (handedWithheld.length > 0 ? 'clear-failed' : 'preserve-failed');
      onError(`[#1428] withheld-state ${op} failed for ${agent.seatKey}: ${e?.message ?? e}`);
    }
  }
  // #1428 REVIEW — The runner's local `error` field on a SUCCESSFUL
  // decline is the provider-error shape and stays null: a decline is not a
  // failure. The withheld reason rides its own STABLE TOKEN field
  // (`withheldReason`), and the recoverable body — if any — lives only on
  // the resident's PRIVATE sidecar. The text-free diagnostic line above is
  // the place the runner operator learns why a wake declined; the runner
  // row's `error` field carries nothing.
  const row = { ...base, ok: true, stopReason: dropped ? reason : (result.stopReason ?? null), usage: result.usage ?? null, attempts: result.attempts ?? null, latencyMs: Date.now() - started, postId: posted?.id ?? null,
    ...toolRecord, postedText: publishBody, unbackedLookupClaims: lookupClaims,
    ...(declined ? {
      modelStopReason: result.stopReason ?? null,
      withheldReason,
      error: null,
    } : {}),
    ...(dropped && !declined ? { modelStopReason: result.stopReason ?? null,
      // Non-decline drops (empty-after-marker and the rest): the previous
      // shape carried a 120-char head in `error`. #1428 REVIEW
      // restores that 120-char cap exactly — the body here is the marker-
      // padded text the runner saw, NOT a recoverable deliberation (the
      // decline path keeps the body off the row entirely via the
      // `error: null` branch above), so the 120-char head is safe and the
      // cap matters: an unbounded error field is the privacy leak the cap
      // exists to prevent on the non-decline path.
      error: text.slice(0, 120) } : {}),
    // #1254 — how many line-initial markers the seat emitted. 1 is a seat
    // following the rule; >1 is a seat marking every paragraph, which is the
    // copy-shape this card is about and which used to reach the room as text.
    // Recorded on every published row, including the ordinary 1, for the same
    // reason toolHops is emitted at zero: a field present only when it fired
    // makes "which turns were ordinary" a query by absence.
    ...(publishBody ? { markerLines: gate.markerLines ?? null } : {}),
    // #1352 — what the adapter noticed and did NOT refuse on; the ledger's to count.
    anomalies: result.anomalies ?? [],
    ...(narrationRetry ? { narrationRetry } : {}),
    // #1428 DIAGNOSTIC ROW — withheldStateOutcome is a TOKEN-ONLY outcome for
    // the seat's per-seat file operation. It rides the public surface (REST
    // and graph) as a stable vocabulary value; the recoverable body and the
    // filesystem path NEVER leave the runner. Null on unrelated rows.
    ...(withheldStateOutcome != null ? { withheldStateOutcome } : {}),
    memoryWritten, ...(memoryRefused.length ? { memoryRefused } : {}), claims: claimed, ...(reason ? { reason } : {}), ...(declined ? { declined: true } : {}),
    // Local-only flag — never serialized through rowToBoard / REST / graph.
    // The PUBLIC surface carries withheldStateOutcome as the stable token;
    // this object-side boolean is for callers that already have the row in
    // hand (the runner operator's own assertions and the seed in scripts/).
    ...(recoveryFailed ? { recoveryFailed: true } : {}) };
  const recorded = await recordLedger({ sink: ledgerSink, file: ledgerFile, row, onError });
  row.recorded = recorded.recorded; row.ledgerId = recorded.id;
  if (recoveryFailed) log(`[#1201] ${agent.seatKey} answered ${wake.id ?? 'a mention'} via ${agent.model.model} (recovery-failed: ${withheldStateOutcome})`);
  else log(`[#1201] ${agent.seatKey} answered ${wake.id ?? 'a mention'} via ${agent.model.model} (${row.usage?.completionTokens ?? '?'} tokens, ${row.stopReason})`);
  return { posted: Boolean(posted), ...(reason ? { reason } : {}), ...(declined ? { declined: true } : {}),
    postId: row.postId, ledger: row, text: publishBody, remember, claims: claimed,
    ...(recoveryFailed ? { recoveryFailed: true } : {}) };
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
// #1274 — the server's own ceiling, named here because the loop must plan
// around it: `/api/conversations` clamps any `limit` to MAX_CONV_LIST_LIMIT
// (server.js) and returns the NEWEST N of the matching set, with no marker in
// the body. Asking for 500 and receiving 200 is byte-identical to "there were
// 200". Kept as a constant rather than inferred from a response, so a test can
// pin the two files together.
export const CONV_LIST_CAP = 200;
export function scanWindowSince(state = {}, now = new Date().toISOString()) {
  return typeof state.lastAnsweredAt === 'string' && state.lastAnsweredAt
    ? state.lastAnsweredAt
    : new Date(Date.parse(now) - FIRST_RUN_WINDOW_MS).toISOString();
}
export function mentionScanPath(state = {}, now = new Date().toISOString(), { before = null } = {}) {
  const since = scanWindowSince(state, now);
  // `before` walks BACKWARD through the same window: `since` is held fixed, so
  // the two bounds close on each other rather than the window sliding.
  return `/api/conversations?attachedTo=null&since=${encodeURIComponent(since)}&limit=${SCAN_LIMIT}`
    + (before ? `&before=${encodeURIComponent(before)}` : '');
}

/**
 * #1274 — READ THE WHOLE WINDOW, not the newest page of it.
 *
 * `getPage(path)` returns `{ rows, total }`; `total` is X-Total-Count, the
 * match count the server took BEFORE applying the limit (server.js, #1010). It
 * may be null — a caller that cannot read headers still gets correct paging,
 * because the loop-until-short-page rule does not depend on it. The header is
 * what makes an UNRECOVERABLE truncation reportable with real numbers instead
 * of a shrug.
 *
 * Pages backward on `before` until a page comes back shorter than the cap.
 * A quiet window is one request; the extra cost is paid only in the state that
 * currently loses mentions.
 *
 * ⚠️ STATED BOUND, not fixed here: `before` is a strict `<` on `createdAt`. If
 * two messages share an identical millisecond timestamp AND a page boundary
 * falls between them, the second is skipped. Deduping by id does not rescue
 * that; an id-stable cursor would, and that is a larger change than this bug.
 */
export async function fetchMentionWindow(getPage, state = {}, now = new Date().toISOString(), { maxPages = 25 } = {}) {
  const byId = new Map();
  let before = null;
  let total = null;
  let complete = false;
  let pages = 0;
  while (pages < maxPages) {
    const res = await getPage(mentionScanPath(state, now, { before }));
    const rows = Array.isArray(res) ? res : (res?.rows ?? []);
    pages += 1;
    if (pages === 1 && res && res.total != null) total = Number(res.total);
    for (const m of rows) if (m && m.id != null && !byId.has(m.id)) byId.set(m.id, m);
    if (rows.length < CONV_LIST_CAP) { complete = true; break; }
    // The oldest row of this page becomes the next page's exclusive upper bound.
    const oldest = rows.reduce((a, b) => (String(a.createdAt) <= String(b.createdAt) ? a : b));
    if (!oldest || typeof oldest.createdAt !== 'string') { complete = true; break; }
    if (before === oldest.createdAt) { complete = true; break; }   // no progress: stop rather than spin
    before = oldest.createdAt;
  }
  const messages = [...byId.values()].sort((a, b) => (String(a.createdAt) < String(b.createdAt) ? -1 : 1));
  return {
    messages,
    complete,
    pages,
    // ⛔ A truncation the loop could not walk out of is a RECORD, never an
    // absence. The seat cannot see this and nobody else is looking.
    truncated: complete ? null : { seen: messages.length, total: total ?? messages.length + 1, pages, since: scanWindowSince(state, now) },
  };
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
