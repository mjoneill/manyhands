/**
 * FIXTURE PROVENANCE — the guard at the AUTHORING moment.
 *
 * The publication gate scans what a push ADDS, which makes it the last line of
 * defence and a good one. It has nothing to say about the moment a fixture is
 * created. `tests/fixtures/work-objects-2026-08-12.jsonl` is a real board export
 * committed as a test fixture; it was sanitised to synthetic actors BY HAND, and
 * nothing enforced that. The next person capturing live board state as a fixture
 * gets no signal until the push gate refuses them — if it recognises the shape.
 *
 * ⛔ THIS FILE MUST NOT CONTAIN A REAL SEAT NAME, AND DOES NOT.
 *
 * That is a hard design constraint, not a preference: a guard that lists the
 * names it protects publishes them, which is the failure it exists to prevent.
 * So the check is INVERTED — it allowlists SYNTHETIC actors and fails on
 * anything else. A real name trips it without ever appearing here, and so does
 * a name nobody has thought of yet. The push gate makes the opposite trade
 * (a forbidden-list, held privately) on purpose; the two disagree by design.
 *
 * ⚠️ THE `replyBy` TRAP, found by measuring the one fixture that exists rather
 * than by imagining the key set. A naive "any key containing 'by'" heuristic
 * matches `replyBy`, whose value is an ISO-8601 TIMESTAMP. Shipping that would
 * have flagged 13 timestamps as unsanitised actors on the only fixture in the
 * tree — an always-fires rule, on day one, in the guard built to prevent
 * always-fires rules. Actor keys are therefore an explicit list, and every
 * candidate value is additionally required to be actor-SHAPED.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Keys whose value names an actor. Explicit, because the heuristic version of
 * this list matched a timestamp field (see the header).
 */
export const ACTOR_KEYS = new Set([
  'by', 'author', 'createdBy', 'declaredBy', 'claimedBy', 'parkedBy',
  'releasedBy', 'grantedBy', 'bidder', 'holder', 'assignee', 'actor', 'seat',
]);

/**
 * Actors a fixture may legitimately name: the project's synthetic cast.
 *
 * `unassigned`, `board` and `wiki` are system actors, not people. Everything
 * else here is a placeholder seat that exists only in examples and tests.
 */
export const SYNTHETIC_ACTORS = new Set([
  'ada', 'bo', 'grace', 'alex', 'robin', 'sage', 'nova', 'kit',
  'unassigned', 'board', 'wiki', 'system', 'anon', 'someone', 'seat',
]);

/** ISO-8601-ish. A timestamp is never an actor, whatever key it arrived under. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/;

/** A UUID is an id, not a name — it leaks nothing on its own. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this value shaped like something that could name a person?
 *
 * Deliberately narrow. A value that is not actor-shaped cannot be an
 * unsanitised actor, and treating it as one is how a guard starts crying wolf.
 */
function isActorShaped(v) {
  if (typeof v !== 'string' || v.length === 0 || v.length > 64) return false;
  if (TIMESTAMP.test(v)) return false;
  if (UUID.test(v)) return false;
  return true;
}

/** Every (key, value) pair under an actor key, at any depth. */
function collectActors(node, out) {
  if (Array.isArray(node)) {
    for (const v of node) collectActors(v, out);
    return out;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (ACTOR_KEYS.has(k)) {
        if (typeof v === 'string' && isActorShaped(v)) out.push({ key: k, value: v });
        else if (Array.isArray(v)) {
          for (const item of v) if (isActorShaped(item)) out.push({ key: k, value: item });
        }
      }
      collectActors(v, out);
    }
  }
  return out;
}

/** Parse a fixture as JSON, or as JSONL, or give up quietly. */
function parseRecords(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try { return [JSON.parse(trimmed)]; } catch { /* try JSONL */ }
  const out = [];
  for (const line of trimmed.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    try { out.push(JSON.parse(l)); } catch { /* not a record; skip */ }
  }
  return out;
}

/**
 * Scan a fixtures directory. Returns findings; empty means clean.
 *
 * A finding is `{file, key, value}` — the caller decides how loudly to fail.
 * The offending VALUE is returned because a fixture author needs to know which
 * string to replace; this runs against a local tree, not into a published log.
 */
export function scanFixtures(dir) {
  const findings = [];
  if (!fs.existsSync(dir)) return findings;

  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      let text;
      try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
      for (const rec of parseRecords(text)) {
        for (const { key, value } of collectActors(rec, [])) {
          if (!SYNTHETIC_ACTORS.has(value.toLowerCase())) {
            findings.push({ file: path.relative(dir, p), key, value });
          }
        }
      }
    }
  };
  walk(dir);
  return findings;
}
