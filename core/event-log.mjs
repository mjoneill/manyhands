/**
 * core/event-log.mjs — the append-only event log (#669, slice 1 of #642).
 *
 * THE LOG IS THE AUTHORITY; the store is a rebuildable projection of it. That
 * ruling (#642 R2) is what makes the write path simple: there is no second
 * authority left to disagree with, so there is no phantom-event case and no
 * rollback. The ordering is `validate → append → project`:
 *
 *   - a write can fail ONLY at validation, before a byte is written;
 *   - once appended, the event is TRUE by definition;
 *   - a projection (store) failure is repaired by REBUILD, never by rollback —
 *     a rollback would mint a second permitted rewrite beside redaction's, and
 *     the spec can hold exactly one.
 *
 * Versions, not diffs: `state` is the FULL entity after the write. Diffs are
 * derived on read and therefore cannot drift from what actually happened. The
 * measured cost of that choice is ~105 KB/day mean (P90 476 KB) against the
 * 16 GB/day the store already rewrites — bytes are a dead axis here.
 *
 * Day-segmented (`events-YYYY-MM-DD.jsonl`) so retention can drop whole files
 * once no live cursor precedes them. `seq` is GLOBAL and continuous across
 * segments: the total order is the deliverable — "did the card change before or
 * after the post discussing it" is the returning seat's actual question, and a
 * per-segment or per-kind counter cannot answer it.
 *
 * REDACTION (#681) is the log's SINGLE permitted rewrite, ruled on
 * #642 R8: "if we have to respond to an emergency, let's have the tools we need.
 * we will always be uneasy if we're just relying on a refusal." It replaces named
 * fields of one event's `state` IN PLACE with a marker, and appends a `redact`
 * event recording what/when/who — never the content. See `redactEvent`.
 */

import { readFileSync, writeFileSync, appendFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Closed vocabulary. An unknown op is a rejected write, not a logged curiosity. */
export const EVENT_OPS = new Set(['create', 'update', 'delete', 'post', 'redact']);

/**
 * What replaces removed content. A MARKER, not a deletion — the redacted event
 * must still project a body, or replay has nothing to write and falls back to
 * the predecessor, resurrecting exactly what was removed (see `redactEvent`).
 */
export const REDACTION_MARKER = '[redacted]';

/**
 * What a redacted field must START with for `recordRedaction` to believe a
 * removal actually happened. Deliberately a PREFIX rather than the exact
 * marker: #680 was hand-redacted with a longer marker naming the direction and
 * the date, and that text is strictly more informative than `[redacted]`.
 */
export const REDACTION_MARKER_PREFIX = '[redacted';
// #805 — `tending` joins the vocabulary so the board-owned tending system's
// writes are declarable at the same chokepoint as everything else. Without it
// `appendEvent` throws, and the only ways past that are to smuggle tending
// changes through card/column diffing (which loses what actually happened) or
// to bypass the log entirely (which loses that anything happened at all).
//
// The KNOWN GAP once named here — no COLLECTION mapping, replay dropping
// tending — was #805 blocker 6, and is CLOSED by the mapping directly below
// (same commit as this correction: a comment asserting a runtime property
// must not outlive the property). `wiki` retains that gap, deliberately.
// #918 — `decision` joins the set. ⚠️ An unmapped kind silently DROPS at
// replay, so a decision whose history could not be rebuilt from the log would
// be less durable than the cards beside it — which is the opposite of the point.
// #613 — `seat-state` joins the set, and is MAPPED below in the same commit,
// per the warning that follows: a declaration that could not be rebuilt from
// the log would be less durable than the cards beside it, and the scheduler
// reads it — so a dropped replay would silently restore a seat to eligible.
export const ENTITY_KINDS = new Set(['card', 'conversation', 'column', 'wiki', 'tending', 'memory', 'label', 'decision', 'seat-state', 'predicate', 'obligation']);

/** Which board collection a given entity kind projects into. */
// #805 blocker 6: tending rides the SAME door as every family — the ruling was
// "fix at collection/replay, no tending-specific bypass", and the fix is one
// map entry precisely because the door is shared. A kind absent from this map
// silently drops at replay (`if (!key) continue`), which for an emitted family
// falsifies this file's first sentence: the store would NOT be rebuildable
// from the log. Emit a new kind ⇒ map it here, same commit.
const COLLECTION = {
  card: 'cards', conversation: 'conversations', column: 'columns',
  tending: 'tending',
  // #651 — mapped in the SAME commit that emits the kind, per the warning above.
  // A memory that could not be rebuilt from the log would be a memory store whose
  // history is less durable than the cards it sits beside.
  memory: 'memories',
  // #857 §IV — a declared label synonym. Mapped in the SAME commit that emits
  // the kind: replay upserts into an ARRAY, which is why aliases are rows with
  // ids rather than a bare {alias: canonical} map. A map could not be rebuilt
  // from the log, and a vocabulary decision that cannot be replayed is a
  // decision the store would silently forget.
  label: 'labelAliases',
  // #613 — one row per seat, replaced on re-declaration; replay upserts by
  // the row's id, which is the seat key. ⚠️ Mapped HERE and not only added
  // to the set above: the comment two blocks up says an unmapped kind
  // silently drops at replay, and it was right — this mapping is the
  // difference between a stored 'no' surviving a rebuild and a rested seat
  // quietly becoming eligible again.
  'seat-state': 'seatStates',
  // #1118 — obligations: what a seat PROMISED, as a node. Mapped in the same
  // commit that emits the kind, per the warning above — a promise that could
  // not be rebuilt from the log would be less durable than the desk-stamp
  // prose it replaces.
  obligation: 'obligations',
};

const SEGMENT_RE = /^events-\d{4}-\d{2}-\d{2}\.jsonl$/;
const segmentFor = (iso) => `events-${iso.slice(0, 10)}.jsonl`;

const segments = (dir) =>
  (existsSync(dir) ? readdirSync(dir) : []).filter((f) => SEGMENT_RE.test(f)).sort();

/**
 * Parse one segment, skipping unparseable lines. A torn tail (a crash mid-write)
 * costs that one line and nothing before it — which is the whole reason the log
 * is line-oriented rather than one big JSON array.
 */
function parseSegment(dir, file) {
  const out = [];
  for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (Number.isInteger(ev?.seq)) out.push(ev);
    } catch { /* torn line — skip it, keep the prefix */ }
  }
  return out;
}

/**
 * The next seq to assign. Scans the NEWEST segment holding a readable event and
 * takes its max + 1 — correct because seq is monotonic and segments are
 * date-ordered, and bounded because it never reads the whole history.
 */
export function nextSeq(dir) {
  const files = segments(dir);
  for (let i = files.length - 1; i >= 0; i--) {
    const evs = parseSegment(dir, files[i]);
    if (evs.length) return Math.max(...evs.map((e) => e.seq)) + 1;
  }
  return 1;
}

/**
 * ⛔ #949 — `headSeq` IS NOT DEFINED HERE, AND I WROTE IT HERE FIRST.
 *
 * It already exists in `core/cursor-service.mjs:91`, byte-identical
 * (`nextSeq(dir) - 1`), and has since #683. I added a second copy without
 * looking — the same failure this card's own watermark is meant to make
 * unnecessary, committed while building it. The collision was caught by the
 * parser, not by me: `Identifier 'headSeq' has already been declared`.
 *
 * ⚠️ Left as a note rather than moved. Its home is arguably this file — the head
 * is a property of the LOG, not of cursors — but relocating an export that
 * #683's surface depends on is a different card than "report two integers".
 *
 * ⇒ Import it from `cursor-service.mjs`.
 */

/**
 * #949 — THE NEWEST SEQ RECORDED AT OR BEFORE `stamp`, or 0 if none is.
 *
 * ⭐ WHY THIS IS THE HONEST ANCHOR FOR THE REPLICA'S DOCUMENT HALF.
 * `writeBoard` stamps the board and its events with the SAME instant, so a
 * document's `lastUpdated` maps exactly onto a position in this log. The
 * replica projects from those document bytes — so "which store state does this
 * answer represent" is answerable without the replica recording anything new.
 *
 * ⛔ IT MUST NOT BE THE ACTIVITY CURSOR. The sync reads the document, awaits a
 * yielding projection, and only then reads events — so the activity position
 * can be NEWER than the bytes actually projected. Using it would overstate
 * currency in precisely the window #931 lives in.
 *
 * ⚠️ INCLUSIVE of `stamp` on purpose: an exclusive comparison would report the
 * replica one write behind on every sync forever — permanently, quietly, and in
 * the reassuring direction, which is the failure mode this whole card exists to
 * remove.
 *
 * Bounded the same way `nextSeq` is: newest segment first, walking back only
 * while every event in a segment is newer than the anchor. A current document —
 * the normal case — stops at the first file.
 *
 * ⚠️ Comparison is lexicographic over ISO-8601 UTC, which is chronological only
 * while every writer stamps in that one format. `appendEvent` does; a caller
 * passing some other `opts.now` shape would break the ordering silently.
 *
 * ⛔ AND THE INVARIANT UNDERNEATH THAT ONE, WHICH NOTHING ENFORCES (a colleague, on
 * review): correctness rests on `recorded_at` being MONOTONIC WITH `seq`, not
 * merely well-formatted. `opts.now` is caller-supplied and unvalidated —
 * `redactEvent`, `recordRedaction` and `redactSubstring` all accept one — so a
 * stepped clock or a backdated `now` can put a HIGHER seq on an EARLIER stamp.
 * Within one segment that makes `best` pick it up and this function returns a
 * seq the document does not reflect: it OVERSTATES currency, reporting current
 * while behind, which is the exact failure #949 exists to remove.
 *
 * ⭐ Bounded, and in the safe direction across files: `segmentFor(recorded_at)`
 * files a backdated event into an OLDER segment, which this newest-first walk
 * stops before reaching — so cross-segment skew UNDERSTATES (reports more
 * behind) and only within-segment skew bites.
 *
 * ⚠️ Left as a named invariant rather than a guard, deliberately. Enforcing
 * monotonicity is a change to the log's write contract and belongs to whoever
 * owns that, not to a card that reports two integers.
 */
export function seqAsOf(dir, stamp) {
  if (typeof stamp !== 'string' || !stamp) return 0;
  const files = segments(dir);
  for (let i = files.length - 1; i >= 0; i--) {
    let best = 0;
    for (const e of parseSegment(dir, files[i])) {
      if (typeof e.recorded_at === 'string' && e.recorded_at <= stamp && e.seq > best) best = e.seq;
    }
    if (best) return best;
  }
  return 0;
}

/**
 * #782 — the seq of ONE entity event, looked up by what it was ABOUT. A push
 * delivery knows the conversation id it wrote and nothing else; this turns that
 * into the log position `served` is recorded against. Newest segment first,
 * newest event first, bounded to the two most recent segments: a pushed message
 * is seconds old, and a miss past that boundary answers null rather than
 * walking months of history for a seq that would not be served anyway.
 */
export function seqOfEntityEvent(dir, { kind, id, op = null } = {}) {
  if (!kind || !id) return null;
  const files = segments(dir);
  for (let i = files.length - 1, seen = 0; i >= 0 && seen < 2; i--, seen++) {
    const evs = parseSegment(dir, files[i]);
    for (let j = evs.length - 1; j >= 0; j--) {
      const e = evs[j];
      if (e?.entity?.kind === kind && e?.entity?.id === id && (op == null || e.op === op)) return e.seq;
    }
  }
  return null;
}

/**
 * Reject anything that would put a lie in the record. Runs BEFORE the append, so
 * a rejected event burns no seq and leaves the log byte-identical.
 */
export function validateEvent(ev) {
  if (!ev || typeof ev !== 'object') throw new Error('event must be an object');
  if (!EVENT_OPS.has(ev.op)) {
    throw new Error(`unknown op "${ev.op}" — vocabulary is ${[...EVENT_OPS].join('|')}`);
  }
  const ent = ev.entity;
  if (!ent || typeof ent !== 'object') throw new Error('event.entity is required');
  if (!ENTITY_KINDS.has(ent.kind)) {
    throw new Error(`unknown entity.kind "${ent.kind}" — vocabulary is ${[...ENTITY_KINDS].join('|')}`);
  }
  if (ent.id === undefined || ent.id === null || ent.id === '') {
    throw new Error('event.entity.id is required');
  }
  // `redact` is the one op that carries NO body — that is its whole point. It
  // must instead name its target, or the audit trail records a removal without
  // saying what was removed.
  if (ev.op === 'redact') {
    if (!Number.isInteger(ev.redacts)) throw new Error('redact events must name a target seq (redacts)');
    if (ev.state !== null) throw new Error('redact events must carry state:null — they describe a removal, not content');
    return true;
  }
  // `state` may legitimately be null only for ops that carry no body. Every other
  // op carries one (delete's is the tombstone), so require it.
  if (ev.state === undefined) throw new Error('event.state is required (full entity, not a diff)');
  return true;
}

/**
 * Validate, assign `seq`, append one line. Callers MUST hold the board write
 * lock — `seq` is only total because the lock serialises assignment.
 *
 * Returns the stored event (with seq/recorded_at/occurred_at filled in).
 */
export function appendEvent(dir, event, opts = {}) {
  validateEvent(event);                      // ← throws before anything is written
  const recorded_at = opts.now || new Date().toISOString();
  const stored = {
    seq: nextSeq(dir),
    recorded_at,
    occurred_at: event.occurred_at || recorded_at,
    actor: event.actor ?? null,
    op: event.op,
    entity: event.entity,
    state: event.state,
  };
  // Redaction's audit fields. Carried only on redact events so every other line
  // stays byte-identical to what slice 1 wrote.
  if (event.op === 'redact') {
    stored.redacts = event.redacts;
    stored.authority = event.authority;
    stored.reason = event.reason ?? null;
    stored.fields = event.fields;
  }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, segmentFor(recorded_at)), JSON.stringify(stored) + '\n', 'utf8');
  return stored;
}

/**
 * #681 — THE LOG'S SINGLE PERMITTED REWRITE. Replace the named fields of event
 * `targetSeq` with `REDACTION_MARKER`, in place, and append a `redact` event
 * recording what/when/who. Ruled on #642 R8 (option b): a real tool,
 * because "we will always be uneasy if we're just relying on a refusal."
 *
 * ⚠️ WHY A MARKER AND NOT `state: null`. The obvious reading of "null it out"
 * breaks replay. A nulled event projects no body, so the entity falls back to
 * its predecessor — which for a still-current entity is EXACTLY the content the
 * redaction removed. The marker keeps the event projectable, which is what makes
 * the invariant below true. `tests/…-redact.test.mjs` case 3 holds this shut.
 *
 * THE INVARIANT: genesis + replay reproduces the **POST**-redaction store. The
 * pre-redaction board is not a reference — it is a state that no longer exists,
 * and comparing against it manufactures a corruption finding out of nothing.
 *
 * ⚠️ ATOMICITY IS THE CALLER'S JOB. This function moves the LOG surface only.
 * The store holds its own copy of the same content, and replay diverges from the
 * store precisely when the two are updated separately — so the caller must move
 * both under compare-and-swap. `redactEntity` (server) is that coordinator.
 *
 * Callers MUST hold the board write lock, as with any append.
 */
export function redactEvent(dir, targetSeq, { actor, authority, fields, reason = null, now = null } = {}) {
  // Everywhere else in this system trust is DECLARED and never authenticated.
  // This is the one op where declaration alone must not suffice: the invocation
  // has to cite whose order it is carrying out, and that citation lands in the
  // permanent record next to the removal.
  if (typeof authority !== 'string' || !authority.trim()) {
    throw new Error('redaction requires an explicit authority citation (who ordered it) — #642 R8');
  }
  if (typeof actor !== 'string' || !actor.trim()) throw new Error('redaction requires an actor');
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error('redaction must name the fields it removes — a redaction that does not say what it took is not auditable');
  }

  // Locate the target's segment. Scanned rather than indexed: redaction is a
  // rare, human-ordered act, and a correct linear scan beats an index that can
  // silently point at the wrong line.
  let file = null; let lines = null; let idx = -1; let target = null;
  for (const f of segments(dir)) {
    const raw = readFileSync(join(dir, f), 'utf8').split('\n');
    const at = raw.findIndex((l) => {
      if (!l.trim()) return false;
      try { return JSON.parse(l)?.seq === targetSeq; } catch { return false; }
    });
    if (at >= 0) { file = f; lines = raw; idx = at; target = JSON.parse(raw[at]); break; }
  }
  if (!target) throw new Error(`cannot redact: no event with seq ${targetSeq}`);
  if (target.op === 'redact') {
    throw new Error(`cannot redact seq ${targetSeq}: it is already a redact event — it carries no content, and rewriting it would put the audit trail itself under the rewrite`);
  }

  // Surgery: only the named fields, only if present. Everything else — seq,
  // actor, op, entity, timestamps, unnamed fields — survives byte-for-byte,
  // because the event still HAPPENED and the record of that is not the secret.
  const removed = [];
  if (target.state && typeof target.state === 'object') {
    for (const k of fields) {
      if (Object.prototype.hasOwnProperty.call(target.state, k)) {
        target.state[k] = REDACTION_MARKER;
        removed.push(k);
      }
    }
  }
  lines[idx] = JSON.stringify(target);
  writeFileSync(join(dir, file), lines.join('\n'), 'utf8');

  return appendEvent(dir, {
    op: 'redact',
    entity: target.entity,
    state: null,
    actor,
    redacts: targetSeq,
    authority,
    reason,
    fields: removed,
  }, now ? { now } : {});
}

/**
 * #691 — SUBSTRING redaction. The op #681's first real request actually needed.
 *
 * #681 removes whole FIELDS. Its first live use was *"change the name"* — three
 * characters inside a 4,326-character body. `redactEvent` would have destroyed
 * the entire post to remove them, and `recordRedaction` refuses because a name
 * swap leaves ordinary prose behind. So it was done BY HAND under CAS, which is
 * the thing #681 existed to abolish.
 *
 * ⚠️ THE FIELD OP'S BLAST RADIUS RUNS BACKWARDS: the more surgical the request,
 * the more collateral damage. That inversion is the defect this closes.
 *
 * ⚠️ THE RECEIPT ASSERTS THE SWAP COUNT, NEVER ABSENCE. A field redaction can
 * honestly claim "the field no longer holds it" — the field is a marker. A
 * substitution leaves prose, so absence is not establishable at this
 * granularity, and claiming it would be the #681 vacuous-assertion failure one
 * level down. The op returns what it did: N swaps, in this field, to this
 * replacement.
 *
 * ⚠️ AND THE AUDIT EVENT NAMES WHAT IT PUT, NEVER WHAT IT TOOK. The design note
 * for this card proposed recording `old→new` at character granularity. That
 * would preserve the removed text inside the redact event — the precise thing
 * the op exists to remove. `replacement` is recorded; the original never is.
 */
export function redactSubstring(dir, targetSeq, {
  field, find, replace, actor, authority, reason = null, now = null,
} = {}) {
  if (typeof authority !== 'string' || !authority.trim()) {
    throw new Error('substring redaction requires an explicit authority citation (who ordered it) — #642 R8');
  }
  if (typeof actor !== 'string' || !actor.trim()) throw new Error('substring redaction requires an actor');
  if (typeof field !== 'string' || !field) throw new Error('substring redaction must name a field');
  if (typeof replace !== 'string') throw new Error('substring redaction must name a replacement string');
  // A non-global regex would silently replace only the first occurrence — a
  // partial redaction reporting success, which is the failure this op is for.
  const re = find instanceof RegExp
    ? (find.flags.includes('g') ? find : new RegExp(find.source, `${find.flags}g`))
    : new RegExp(String(find).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');

  let file = null; let lines = null; let idx = -1; let target = null;
  for (const f of segments(dir)) {
    const raw = readFileSync(join(dir, f), 'utf8').split('\n');
    const at = raw.findIndex((l) => {
      if (!l.trim()) return false;
      try { return JSON.parse(l)?.seq === targetSeq; } catch { return false; }
    });
    if (at >= 0) { file = f; lines = raw; idx = at; target = JSON.parse(raw[at]); break; }
  }
  if (!target) throw new Error(`cannot redact: no event with seq ${targetSeq}`);
  if (target.op === 'redact') {
    throw new Error(`cannot redact seq ${targetSeq}: it is already a redact event — it carries no content to substitute`);
  }

  const before = target.state?.[field];
  if (typeof before !== 'string') {
    throw new Error(`cannot substitute in seq ${targetSeq}.${field}: it is not a string (${typeof before})`);
  }

  // COUNT FIRST, REFUSE ON ZERO. A substitution that matched nothing changed
  // nothing — and reporting success would close an incident that is still open.
  const swaps = (before.match(re) || []).length;
  if (swaps === 0) {
    throw new Error(`refusing to record a redaction of seq ${targetSeq}.${field}: the pattern matched nothing, so nothing was removed`);
  }

  target.state[field] = before.replace(re, replace);
  lines[idx] = JSON.stringify(target);
  writeFileSync(join(dir, file), lines.join('\n'), 'utf8');

  const ev = appendEvent(dir, {
    op: 'redact',
    entity: target.entity,
    state: null,
    actor,
    redacts: targetSeq,
    authority,
    reason,
    fields: [field],
  }, now ? { now } : {});
  // Carried on the stored event by appendEvent's redact branch would require a
  // wider contract; these two are the receipt's own assertions and belong with
  // the returned value the caller reports from.
  ev.swaps = swaps;
  ev.replacement = replace;
  return ev;
}

/**
 * #681 — redact an ENTITY's content across the whole log, not one event.
 *
 * ⚠️ THIS IS THE ONE THAT ACTUALLY REMOVES THE CONTENT, and the spec's
 * per-seq `redactEvent` alone does NOT. Versions-not-diffs means every event
 * carries the FULL entity state, so a card edited three times after a name
 * landed in its title holds that name in THREE events. Redacting the latest
 * reports success and leaves two copies on disk — a redaction that looks
 * complete and is not, which for this op is the worst available failure.
 * Measured on a fixture before it was written, not reasoned about.
 *
 * Returns { markers, seqs, scanned, removedValues } — `removedValues` being the
 * distinct strings actually overwritten, so the caller can go looking for them
 * ELSEWHERE. See `findCarriers`: this function is entity-scoped by design, and
 * entity-scoped is narrower than "the string is gone".
 */
export function redactEntityEvents(dir, { kind, id, fields, actor, authority, reason = null }) {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error('redaction must name the fields it removes');
  }
  // Snapshot the targets FIRST: each redaction appends a marker, so scanning
  // and rewriting in one pass would walk over a growing log.
  const targets = readEvents(dir)
    .filter((e) => e.op !== 'redact'
      && e.entity?.kind === kind && String(e.entity?.id) === String(id)
      && e.state && typeof e.state === 'object'
      // "still CARRIES content", not "has the key". An already-redacted field
      // keeps its key holding the marker, so a hasOwnProperty test re-targets
      // events it has already cleaned — burning a seq and appending a marker
      // per run. This predicate is what makes the sweep idempotent.
      && fields.some((f) => Object.prototype.hasOwnProperty.call(e.state, f)
        && e.state[f] !== REDACTION_MARKER))
    .map((e) => e.seq);

  // Capture what we are about to destroy, so the caller can hunt for copies of
  // it in entities this sweep will never touch.
  const removedValues = new Set();
  const pre = readEvents(dir);
  for (const seq of targets) {
    const ev = pre.find((e) => e.seq === seq);
    for (const f of fields) {
      const v = ev?.state?.[f];
      if (typeof v === 'string' && v && v !== REDACTION_MARKER) removedValues.add(v);
    }
  }

  const markers = targets.map((seq) => redactEvent(dir, seq, { actor, authority, fields, reason }));
  return {
    markers, seqs: targets, scanned: readEvents(dir).length, removedValues: [...removedValues],
  };
}

/**
 * #681 (verification finding) — where ELSE do these strings live?
 *
 * ⚠️ THE SWEEP IS ENTITY-SCOPED AND "THE STRING IS GONE" IS NOT. In this room
 * posts quote cards constantly, so a name in a card's title is very likely also
 * in a commons post about that card. Redacting the card cleans the card, the
 * entity-scoped verify reports CLEAN, and the string survives in the post. An
 * emergency operator's actual goal is the second thing, not the first.
 *
 * This was caught in verification and not by the tests, because the sweep test
 * asserts absence from the whole log but its fixture only ever plants the
 * content in ONE entity — the assertion was true and vacuous. A plant measures
 * recall of what you planted; it is blind to the carrier class you didn't.
 *
 * REPORTS ONLY — never redacts. A different entity is a different decision and
 * a different invocation, so scoping stays explicit. Returns LOCATIONS ONLY and
 * never the matched text: re-emitting the secret to announce the secret is the
 * one thing this whole card exists to prevent.
 */
export function findCarriers(dir, values, { excludeSeqs = [] } = {}) {
  const skip = new Set(excludeSeqs);
  const needles = (values || []).filter((v) => typeof v === 'string' && v);
  if (!needles.length) return [];
  const out = [];
  for (const ev of readEvents(dir)) {
    if (skip.has(ev.seq) || ev.op === 'redact' || !ev.state) continue;
    for (const [field, v] of Object.entries(ev.state)) {
      if (typeof v === 'string' && needles.some((n) => v.includes(n))) {
        out.push({ seq: ev.seq, kind: ev.entity?.kind, id: ev.entity?.id, field });
      }
    }
  }
  return out;
}

/**
 * #681 item 5 — RECORD a redaction that was performed by other means, without
 * rewriting anything. For #680: the removal was done by hand under principal
 * direction before this tool existed, so the content is already gone and only
 * the audit event is missing. Running the rewrite path over it would replace a
 * hand-written marker naming the direction and date with a bare `[redacted]` —
 * losing information in the name of recording it.
 *
 * ⚠️ THE REFUSAL IS THE WHOLE POINT. A mode that appends "content was removed"
 * without checking is a way to put a LIE in the append-only record — and a
 * confident one, since a redact event is exactly what a reader would trust. So
 * this refuses unless the target's named fields already hold a redaction
 * marker. You cannot use it to claim a removal that did not happen.
 *
 * That guard is why this is a separate function and not a flag on redactEvent:
 * the two have OPPOSITE preconditions. The rewrite path requires the content to
 * be PRESENT; this requires it to be GONE.
 */
export function recordRedaction(dir, targetSeq, { actor, authority, fields, reason = null, now = null } = {}) {
  if (typeof authority !== 'string' || !authority.trim()) {
    throw new Error('recording a redaction requires an explicit authority citation — #642 R8');
  }
  if (typeof actor !== 'string' || !actor.trim()) throw new Error('recording a redaction requires an actor');
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error('recording a redaction must name the fields that were removed');
  }

  const target = readEvents(dir).find((e) => e.seq === targetSeq);
  if (!target) throw new Error(`cannot record: no event with seq ${targetSeq}`);
  if (target.op === 'redact') throw new Error(`cannot record against seq ${targetSeq}: it is already a redact event`);

  for (const f of fields) {
    const v = target.state?.[f];
    if (typeof v !== 'string' || !v.startsWith(REDACTION_MARKER_PREFIX)) {
      throw new Error(
        `refusing to record a redaction of seq ${targetSeq}.${f}: that field does not hold a `
        + 'redaction marker, so the content was NOT removed. Recording it would put a false '
        + 'removal in the permanent record. Use redactEvent/redactEntityEvents to actually remove it.',
      );
    }
  }

  return appendEvent(dir, {
    op: 'redact',
    entity: target.entity,
    state: null,
    actor,
    redacts: targetSeq,
    authority,
    reason,
    fields,
  }, now ? { now } : {});
}

/** Read events in seq order. `sinceSeq` is exclusive; `limit` bounds the count. */
export function readEvents(dir, { sinceSeq = 0, limit = Infinity, sinceDate = null } = {}) {
  const all = [];
  // #679 (additive): segments are day-named (YYYY-MM-DD.jsonl), so a
  // since-window read can skip whole files older than the window's day —
  // the cheap half of bounding, ahead of real indexing.
  // #679-fix: filenames are `events-YYYY-MM-DD.jsonl` — the first cut sliced
  // (0,10) and compared "events-202" to a date, so the skip never fired: a
  // no-op invisible to every correctness test, because its only failure mode
  // was "does nothing". Date extracted by pattern, not offset; the positive
  // control lives in the tests (a segment whose CONTENT lies about its date
  // is visible exactly when the skip does not fire).
  const cutoff = typeof sinceDate === 'string' ? sinceDate.slice(0, 10) : null;
  for (const f of segments(dir)) {
    const day = f.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
    if (cutoff && day && day < cutoff) continue;
    all.push(...parseSegment(dir, f));
  }
  all.sort((a, b) => a.seq - b.seq);
  const from = all.filter((e) => e.seq > sinceSeq);
  return Number.isFinite(limit) ? from.slice(0, limit) : from;
}

/**
 * #679 (additive) — the log's retention boundary: the recorded_at of the
 * earliest surviving event, or null for an empty/absent log. A since older
 * than this must refuse (CURSOR_TOO_OLD), never answer partially.
 */
export function oldestRetainedAt(dir) {
  for (const f of segments(dir)) {
    const first = parseSegment(dir, f)[0];
    if (first) return first.recorded_at ?? null;
  }
  return null;
}

/**
 * Rebuild the projection: genesis snapshot + every event since, in seq order.
 * PURE — the genesis snapshot is never mutated, so a failed rebuild can simply
 * be run again. This is the function that makes "store is a cache" true rather
 * than aspirational.
 */
export function replay(genesis, events) {
  const board = structuredClone(genesis);
  for (const ev of events) {
    // #681: the redact MARKER is administrative — it describes a removal that
    // has already been applied to the target event in place, and carries no body
    // of its own. Projecting it would append a null-bodied phantom.
    //
    // ⚠️ This is NOT the forbidden "skip-based replay". That hazard is skipping
    // the REDACTED TARGET (which resurrects its predecessor); this skips the
    // MARKER. Two different events, and conflating them is how the resurrection
    // bug gets reintroduced as a cleanup.
    if (ev.op === 'redact') continue;
    const key = COLLECTION[ev.entity?.kind];
    if (!key) continue;                       // wiki has no board collection yet
    if (!Array.isArray(board[key])) board[key] = [];
    const list = board[key];
    // Identity lives at `id` for board rows and at `@id` for JSON-LD entities
    // (tending). Matching `id` alone never finds a JSON-LD node, so an
    // idempotent re-emit would APPEND instead of upsert — a duplicate the
    // emitter cannot see and the store cannot explain.
    const i = list.findIndex((x) => (x?.id ?? x?.['@id']) === ev.entity.id);
    if (ev.op === 'delete') {
      if (i >= 0) list.splice(i, 1);
    } else if (i >= 0) {
      list[i] = structuredClone(ev.state);
    } else {
      list.push(structuredClone(ev.state));
    }
  }
  return board;
}
