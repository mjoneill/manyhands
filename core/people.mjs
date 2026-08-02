/**
 * #619 — person/agent entities derived from structured fields.
 *
 * The board already holds who is assigned to what and who said what. This
 * module turns those two facts into a queryable graph WITHOUT storing a second
 * copy of them.
 *
 * Three decisions are load-bearing enough to state here rather than leave in
 * the card:
 *
 * 1. DERIVED, NOT MATERIALISED. Both directions of every edge are computed
 *    from one field by one function. #618 happened because `relatedTo` is
 *    stored at both ends and kept in sync by code that only ran in the browser
 *    — 192 of 217 edges had drifted one-ended and nobody could see it. An edge
 *    computed on read has no second end to drift, so that class of bug is not
 *    merely unlikely here, it is unrepresentable.
 *
 * 2. THE SOURCE LIST IS CLOSED. `assignees` and `author` are written by an
 *    actor choosing an identity. `mentions` looks identical in the JSON — it is
 *    stored, array-typed, and sits right beside `author` — but it is produced
 *    by a regex over prose (server.js extractMentions) and, on the live board,
 *    holds nine real external people's handles scraped from pasted text.
 *    Deriving from it would mint entities for strangers who never touched this
 *    board. `for` is beneficiary prose. Neither is a source, and the test that
 *    pins this list is a consent guard, not a style rule.
 *
 * 3. UNKNOWN IDENTITIES SURFACE. A string with no roster entry becomes a node
 *    marked `resolved: false`, never a guess and never a silent drop. Absent is
 *    honest; guessed is fabricated.
 */

/**
 * The ONLY fields a person may be derived from.
 *
 * Frozen, and asserted by test to be exactly these two with exactly one
 * consumer below — so adding a third is a deliberate, reviewed act rather than
 * a quiet import that nobody re-reads.
 */
export const PERSON_SOURCE_FIELDS = Object.freeze(['assignees', 'author']);

/**
 * Identity strings that are roles, services, or absences — never people.
 *
 * `board` and `wiki` are in the roster (they need entries to get a colour) and
 * are still not actors: server.js stamps them as the author of system posts.
 * `unassigned` is the absence of an assignee. Roster membership alone must not
 * confer personhood, which is why this list is consulted independently.
 */
export const EXCLUDED_IDENTITIES = Object.freeze(['board', 'wiki', 'dc-tripwire', 'unassigned']);

/** Seats keyed by lower-cased alias, so an alternate name resolves to its seat. */
function aliasIndex(seats) {
  const index = new Map();
  for (const [key, seat] of Object.entries(seats)) {
    for (const alias of seat?.aliases || []) {
      index.set(String(alias).toLowerCase(), key);
    }
  }
  return index;
}

/**
 * Map a raw identity string to a canonical seat key.
 *
 * Aliases live on the seat in the roster (`aliases: [...]`) rather than in a
 * sibling table — one file, one source. A roster without the key keeps working.
 */
function canonicalise(raw, seats, aliases) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  // Seat keys are lower-cased on load (identity.mjs sanitizeRoster), so a
  // case-sensitive match here would fail on a capitalised spelling of a
  // seat key and mint a SECOND,
  // unresolved node beside the real seat — a split identity one capitalised
  // write away. Found in review while the live corpus happened to be all
  // lower-case, which is exactly when it is cheap to fix.
  const lower = value.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(seats, lower)) return { key: lower, resolved: true };
  const viaAlias = aliases.get(lower);
  if (viaAlias) return { key: viaAlias, resolved: true };
  // An UNRESOLVED string keeps the case it was written in and is not folded
  // together with other spellings: `Ghost` and `ghost` are two unknowns, and
  // asserting they are one person would be a guess. Absent is honest.
  return { key: value, resolved: false };
}

/**
 * Derive the whole person graph from a board.
 *
 * Returns `{ people: [...] }` sorted by key. Every edge list here is produced
 * in this one pass; nothing downstream recomputes them from the source fields,
 * which is what makes "symmetric by construction" a fact about the code rather
 * than a property some fixture happens to have.
 */
export function deriveGraph(board, roster = {}) {
  const seats = roster?.seats && typeof roster.seats === 'object' ? roster.seats : {};
  const aliases = aliasIndex(seats);
  const excluded = new Set(EXCLUDED_IDENTITIES);
  const people = new Map();

  // The single site that consults the closed source list. Both fields are read
  // here and nowhere else; a second reader would be a second end that can drift.
  const [ASSIGNEE_FIELD, AUTHOR_FIELD] = PERSON_SOURCE_FIELDS;

  const upsert = (raw) => {
    const id = canonicalise(raw, seats, aliases);
    if (!id || excluded.has(id.key)) return null;
    if (!people.has(id.key)) {
      const seat = seats[id.key];
      people.set(id.key, {
        key: id.key,
        name: seat?.name ?? id.key,
        glyph: seat?.glyph ?? null,
        aliases: [...(seat?.aliases || [])],
        resolved: id.resolved,
        assigned: [],
        authored: [],
        claiming: [],
      });
    }
    return people.get(id.key);
  };

  for (const card of board?.cards || []) {
    for (const raw of card?.[ASSIGNEE_FIELD] || []) {
      upsert(raw)?.assigned.push(card.shortId);
    }
  }

  for (const conv of board?.conversations || []) {
    upsert(conv?.[AUTHOR_FIELD])?.authored.push(conv.id);
  }

  // `claimedBy` is the #348 lease: it records custody, cleared on release, and
  // is not a claim of authorship. It may DECORATE a person who already exists
  // for a legitimate reason; it may never bring one into being. Hence a second
  // pass that only looks people up.
  for (const card of board?.cards || []) {
    const holder = card?.claimedBy;
    if (!holder) continue;
    const id = canonicalise(holder, seats, aliases);
    if (id && people.has(id.key)) people.get(id.key).claiming.push(card.shortId);
  }

  return { people: [...people.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}

/** One person by key or alias, or null. A projection of the same derivation. */
export function personByKey(board, roster, key) {
  const wanted = canonicalise(key, roster?.seats || {}, aliasIndex(roster?.seats || {}));
  if (!wanted) return null;
  return deriveGraph(board, roster).people.find((p) => p.key === wanted.key) || null;
}
