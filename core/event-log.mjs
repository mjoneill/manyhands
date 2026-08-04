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
 * Slice 1 deliberately omits `redact` — it waits on the bytes ruling and does
 * not gate anything here.
 */

import { readFileSync, writeFileSync, appendFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Closed vocabulary. An unknown op is a rejected write, not a logged curiosity. */
export const EVENT_OPS = new Set(['create', 'update', 'delete', 'post']);
export const ENTITY_KINDS = new Set(['card', 'conversation', 'column', 'wiki']);

/** Which board collection a given entity kind projects into. */
const COLLECTION = { card: 'cards', conversation: 'conversations', column: 'columns' };

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
  // `state` may legitimately be null only for ops that carry no body. In slice 1
  // every op carries one (delete's is the tombstone), so require it.
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
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, segmentFor(recorded_at)), JSON.stringify(stored) + '\n', 'utf8');
  return stored;
}

/** Read events in seq order. `sinceSeq` is exclusive; `limit` bounds the count. */
export function readEvents(dir, { sinceSeq = 0, limit = Infinity, sinceDate = null } = {}) {
  const all = [];
  // #679 (additive): segments are day-named (YYYY-MM-DD.jsonl), so a
  // since-window read can skip whole files older than the window's day —
  // the cheap half of bounding, ahead of real indexing.
  const cutoff = typeof sinceDate === 'string' ? sinceDate.slice(0, 10) : null;
  for (const f of segments(dir)) {
    if (cutoff && f.slice(0, 10) < cutoff) continue;
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
    const key = COLLECTION[ev.entity?.kind];
    if (!key) continue;                       // wiki has no board collection yet
    if (!Array.isArray(board[key])) board[key] = [];
    const list = board[key];
    const i = list.findIndex((x) => x?.id === ev.entity.id);
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
