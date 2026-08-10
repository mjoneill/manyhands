/**
 * core/work-store.mjs — #755 slice 2d: where work objects live.
 *
 * This is the critical path. The gate (2b) is wired and tested, and until now
 * `openWorkObjects()` returned an empty list — so arming the flag refused
 * nobody, and the review instrument reported signal 2 as a STRUCTURAL ZERO: a
 * cell that looks like "no bypasses" and means "no instrument."
 *
 * ── APPEND-ONLY JSONL, ONE LINE PER TRANSITION ──────────────────────────────
 * Not a mutable document. The transition log IS the state — `stateAt` already
 * derives everything from it — so persistence is "append the transition, then
 * re-read", with no snapshot that can fall out of sync with its own log.
 *
 * ⇒ DESIGN B survives a restart BY CONSTRUCTION: nothing lives in memory that
 *   isn't on disk, and re-reading yields the identical derived state. There is
 *   no timer to miss, no pending window to drop.
 *
 * ⇒ Chosen over storing inside board-data.json, which is 27MB and rewritten
 *   whole under the write lock — a poor home for objects with a twenty-minute
 *   life and a write per transition.
 *
 * ── NO DISCRIMINATOR, DELIBERATELY ──────────────────────────────────────────
 * A work object points at a card and nothing more. A scope discriminator was
 * designed tonight (referent-validated rather than shape-validated, because a
 * length limit and a charset both admit `call-with-<name>-re-<topic>`) and was
 * NOT shipped: `one card per grantable unit` forbids the collision it solves.
 *
 * ⇒ If a real bid turns out to be inexpressible without one, that is a
 *   MEASURED requirement rather than a designed one — the same way the room's
 *   own five-bid corpus killed the pointer-only proposal in a single post.
 *
 * ── PII ─────────────────────────────────────────────────────────────────────
 * The guard is upstream and structural: work-auction's writers refuse unknown
 * fields, so there is no free-text field for a description to arrive in. This
 * file adds none. A test asserts the property survives all the way to the
 * bytes on disk, which is where "we'll scrub it later" stops being available.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { stateAt, STATES } from './work-auction.mjs';

const FILE = 'work-objects.jsonl';

/** States in which a work object still constrains its bidders. */
const IN_PLAY = [STATES.OPEN, STATES.BIDDING, STATES.ARBITRATION_DUE];

/**
 * Fold JSONL text into work objects. PURE — no filesystem, so it is testable
 * against a string and cannot be confused by where the bytes came from.
 *
 * Returns `{ objects, malformed }`. The malformed COUNT is returned rather
 * than swallowed: a store that silently skips lines is a store that lies about
 * its own reach, which is the defect class this card is a catalogue of.
 */
export function foldLines(text) {
  const byId = new Map();
  let malformed = 0;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (!rec || typeof rec.id !== 'string' || !rec.transition) {
      malformed += 1;
      continue;
    }

    if (!byId.has(rec.id)) {
      byId.set(rec.id, {
        id: rec.id,
        sourceMessageId: rec.sourceMessageId ?? null,
        declaredBy: rec.declaredBy ?? null,
        replyBy: rec.replyBy,
        required: rec.required ?? [],
        transitions: [],
      });
    }
    const obj = byId.get(rec.id);

    // ⚠️ Idempotent by (id, seq). A retry, a double-write, or a crash mid-append
    // must not inflate the log — a duplicated `bid` would change who the
    // auction believes bid, which is a wrong answer rather than a noisy one.
    if (obj.transitions.length === rec.seq) obj.transitions.push(rec.transition);
  }

  return { objects: [...byId.values()], malformed };
}

/**
 * Append every transition of `wo` that is not already on disk.
 *
 * Writes one line per transition, each carrying its own `seq`, so a partial
 * write loses only the tail and never corrupts what came before.
 */
export function appendTransitions(dir, wo) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, FILE);
  const existing = existsSync(path) ? foldLines(readFileSync(path, 'utf8')) : { objects: [] };
  const already = existing.objects.find((o) => o.id === wo.id)?.transitions.length ?? 0;

  const lines = [];
  for (let seq = already; seq < wo.transitions.length; seq += 1) {
    lines.push(JSON.stringify({
      id: wo.id,
      seq,
      transition: wo.transitions[seq],
      replyBy: wo.replyBy,
      required: wo.required,
      declaredBy: wo.declaredBy ?? null,
      sourceMessageId: wo.sourceMessageId ?? null,
    }));
  }
  if (!lines.length) return 0;

  if (!existsSync(path)) writeFileSync(path, '');
  appendFileSync(path, lines.join('\n') + '\n');
  return lines.length;
}

/**
 * Every work object in the store.
 *
 * ⚠️ An ABSENT store is EMPTY, not an error. If this threw, a missing
 * directory would take `card_create` down with it — a rail whose failure mode
 * is "the board stops working" is worse than the problem it solves.
 */
export function readWorkObjects(dir) {
  const path = join(dir, FILE);
  if (!existsSync(path)) return [];
  return foldLines(readFileSync(path, 'utf8')).objects;
}

/**
 * The work objects still in play at `now` — what the gate asks for.
 *
 * `now` is required, never defaulted, for the same reason `stateAt` requires
 * it: a defaulted clock is how design B decays back into design A.
 */
export function openWorkObjectsAt(dir, now) {
  if (!now) throw new Error('openWorkObjectsAt: now is required — this store never reads the wall clock');
  return readWorkObjects(dir).filter((wo) => IN_PLAY.includes(stateAt(wo, now).state));
}
