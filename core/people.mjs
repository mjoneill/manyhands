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
 * Frozen, and asserted by test with exactly one consumer below — so adding
 * another is a deliberate, reviewed act rather than a quiet import that
 * nobody re-reads. `createdBy` joined 2026-08-04 (#653): #631 put the writer
 * on every new card and the graph was blind to all of them — the audit's
 * step-function finding, 100% of new cards, zero backfill.
 */
import { domainToBoard } from './mapping.mjs';
import { PERSON_IRI_BASE } from './jsonld.mjs';

/**
 * #699 — extract @mentions, VALIDATED against the roster and CANONICALISED.
 *
 * The naive `@(\w+)` scan this replaces recorded 86 distinct "people" for a
 * six-person room: JSON-LD terms (`@context`, `@id`), email domains
 * (`@gmail`), npm tags (`@latest`), handles, and years (`@2026`).
 *
 * ⚠️ The harm is NOT phantom Person nodes — the frozen person-source list
 * below deliberately excludes mentions, and a test pins it (#619's consent
 * guard). Naming that constant here would trip its own one-copy guard, which
 * is the guard working. The harm is smaller and live: `?mentions_me=<key>` MISSES posts that
 * used a seat's display name, because one seat can be written two ways.
 *
 * The roster already knows `key → display name`, so canonicalisation needs no
 * new config: match EITHER form, always record the KEY. An `@token` matching
 * neither is not a mention — it stays in the prose and is simply not recorded
 * as a person.
 *
 * @param {string} text   the message body
 * @param {object} seats  roster map: key → { name, … }
 */
export function extractMentions(text, seats = {}) {
  if (typeof text !== 'string') return [];
  // key → key, and lowercased display name → key. Built per call because the
  // roster is small and a cached index is one more thing to invalidate.
  const canon = new Map();
  for (const [key, v] of Object.entries(seats || {})) {
    const k = String(key).toLowerCase();
    canon.set(k, k);
    const name = v && typeof v.name === 'string' ? v.name.toLowerCase() : null;
    if (name) canon.set(name, k);
  }
  const found = new Set();
  for (const m of text.matchAll(/@(\w+)/g)) {
    const hit = canon.get(m[1].toLowerCase());
    if (hit) found.add(hit);
  }
  return [...found];
}

export const PERSON_SOURCE_FIELDS = Object.freeze(['assignees', 'author', 'createdBy']);

/**
 * Identity strings that are roles, services, or absences — never people.
 *
 * `board` and `wiki` are in the roster (they need entries to get a colour) and
 * are still not actors: server.js stamps them as the author of system posts.
 * `unassigned` is the absence of an assignee. Roster membership alone must not
 * confer personhood, which is why this list is consulted independently.
 */
export const EXCLUDED_IDENTITIES = Object.freeze(['board', 'wiki', 'dc-tripwire', 'unassigned']);

/**
 * #628 — the bounded default for EVERY edge list.
 *
 * The unbounded `authored` list shipped correct, tested and reviewed, and was
 * unusable by the surface's primary beneficiary: 54KB for one person, over
 * every agent tool-result limit. The bound lives HERE because REST and MCP are
 * both projections of this module — capping either adapter alone would leave
 * the other carrying the defect (the two-surface failure again).
 *
 * ONE limit, all three lists. The first fix bounded only `authored` because
 * "assigned is naturally small" — which was a property of OUR corpus, not of
 * the data (a triage board has thousands assigned to one owner on day one),
 * and exactly the fixture-scale reasoning that shipped the bug. Every list
 * returns its most recent tail; every `<list>Total` carries the true count;
 * callers page backward with `<list>Before` (an id from a previous page).
 */
export const EDGE_RECENT_LIMIT = 50;

/**
 * The most a caller may raise the limit to. The customer's stated shape is a
 * DEFAULT with an override, not a fixed cap — but the override stays a BOUND:
 * nothing any caller sends may reopen the firehose this card exists to close.
 */
export const EDGE_LIMIT_CEILING = 500;

/** A caller-supplied limit, clamped to [1, EDGE_LIMIT_CEILING]; default otherwise. */
function clampLimit(limit) {
  const n = Number(limit);
  if (!Number.isInteger(n) || n < 1) return EDGE_RECENT_LIMIT;
  return Math.min(n, EDGE_LIMIT_CEILING);
}

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
 * Derive every person with FULL edge lists — internal only.
 *
 * Every edge list is produced in this one pass; nothing downstream recomputes
 * them from the source fields, which is what makes "symmetric by construction"
 * a fact about the code rather than a property some fixture happens to have.
 * The public surfaces below apply the #628 bounding projection; nothing
 * unbounded leaves this module.
 */
function deriveFullPeople(board, roster = {}) {
  const seats = roster?.seats && typeof roster.seats === 'object' ? roster.seats : {};
  const aliases = aliasIndex(seats);
  const excluded = new Set(EXCLUDED_IDENTITIES);
  const people = new Map();

  // The single site that consults the closed source list. Both fields are read
  // here and nowhere else; a second reader would be a second end that can drift.
  const [ASSIGNEE_FIELD, AUTHOR_FIELD, CREATOR_FIELD] = PERSON_SOURCE_FIELDS;

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
        created: [],
      });
    }
    return people.get(id.key);
  };

  // Cards sorted by shortId — ascending is chronological by construction
  // (shortIds are minted monotonically), so every list's tail is its newest.
  const cards = [...(board?.cards || [])].sort(
    (a, b) => (a?.shortId ?? 0) - (b?.shortId ?? 0));

  for (const card of cards) {
    for (const raw of card?.[ASSIGNEE_FIELD] || []) {
      upsert(raw)?.assigned.push(card.shortId);
    }
    // #653 — creator is AUTHORSHIP (like a post's author, unlike claimedBy's
    // custody), so it may bring a person into being. Cards from before #631
    // carry no creator and appear in nobody's list: absent is honest.
    if (card?.[CREATOR_FIELD]) {
      upsert(card[CREATOR_FIELD])?.created.push(card.shortId);
    }
  }

  // Sorted by createdAt (id as tiebreak) so "most recent" is true BY
  // CONSTRUCTION. The live file happens to be appended in chronological
  // order, but that is an observed accident, not a guarantee — nothing
  // sorts on write, and a restored backup or future migration owes us
  // nothing. A recency claim, and cursor paging, need a stable order the
  // CODE establishes.
  const convs = [...(board?.conversations || [])].sort((a, b) =>
    String(a?.createdAt ?? '').localeCompare(String(b?.createdAt ?? ''))
    || String(a?.id ?? '').localeCompare(String(b?.id ?? '')));
  for (const conv of convs) {
    upsert(conv?.[AUTHOR_FIELD])?.authored.push(conv.id);
  }

  // `claimedBy` is the #348 lease: it records custody, cleared on release, and
  // is not a claim of authorship. It may DECORATE a person who already exists
  // for a legitimate reason; it may never bring one into being. Hence a second
  // pass that only looks people up.
  for (const card of cards) {
    const holder = card?.claimedBy;
    if (!holder) continue;
    const id = canonicalise(holder, seats, aliases);
    if (id && people.has(id.key)) people.get(id.key).claiming.push(card.shortId);
  }

  return [...people.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * #628 — bound one list for the wire: the most recent EDGE_RECENT_LIMIT
 * entries, optionally the window strictly BEFORE a cursor id from a previous
 * page. Bounding never loses information — the total rides alongside, and the
 * rest is one explicit call away.
 */
function boundList(full, before, limit, cursorName) {
  let end = full.length;
  if (before != null) {
    const at = full.findIndex((x) => String(x) === String(before));
    if (at < 0) {
      // An unknown cursor must REFUSE, never silently serve page one: an
      // agent paging until it sees a short page would loop forever, every
      // iteration looking like success — and a cursor goes stale the moment
      // an entry is deleted mid-walk. Refusing beats guessing.
      const err = new Error(`unknown ${cursorName} cursor: ${String(before)}`);
      err.code = 'UNKNOWN_CURSOR';
      throw err;
    }
    end = at;
  }
  return full.slice(Math.max(0, end - clampLimit(limit)), end);
}

/**
 * #628 — one mechanism, every list. Cursors: assignedBefore / authoredBefore /
 * claimingBefore; `limit` overrides the default page size up to the ceiling.
 * Throws code UNKNOWN_CURSOR when a supplied cursor matches nothing.
 */
function boundPerson(person, { assignedBefore, authoredBefore, claimingBefore, createdBefore, limit } = {}) {
  return {
    // #686 — the person's graph identity: this IRI is the @id of the Person
    // node in the store document, and what @id-typed reference strings
    // (creator/author/assignees/claimedBy) resolve to. One key, one IRI.
    '@id': PERSON_IRI_BASE + person.key,
    ...person,
    assigned: boundList(person.assigned, assignedBefore, limit, 'assignedBefore'),
    assignedTotal: person.assigned.length,
    authored: boundList(person.authored, authoredBefore, limit, 'authoredBefore'),
    authoredTotal: person.authored.length,
    claiming: boundList(person.claiming, claimingBefore, limit, 'claimingBefore'),
    claimingTotal: person.claiming.length,
    created: boundList(person.created, createdBefore, limit, 'createdBefore'),
    createdTotal: person.created.length,
  };
}

/**
 * Derive the whole person graph, bounded for the wire.
 *
 * Returns `{ people: [...] }` sorted by key, every person passed through the
 * same bounding projection the single-person surface uses — the room list was
 * 435KB unbounded, which no agent tool-result budget carries.
 */
export function deriveGraph(board, roster = {}) {
  return { people: deriveFullPeople(board, roster).map((p) => boundPerson(p)) };
}

/**
 * One person by key or alias, or null — bounded, with backward paging via
 * `opts.authoredBefore` (a conversation id from a previous page's `authored`).
 * A projection of the same derivation; no second reader of the source fields.
 */
export function personByKey(board, roster, key, opts = {}) {
  const wanted = canonicalise(key, roster?.seats || {}, aliasIndex(roster?.seats || {}));
  if (!wanted) return null;
  const found = deriveFullPeople(board, roster).find((p) => p.key === wanted.key);
  return found ? boundPerson(found, opts) : null;
}

/**
 * #686 — materialize Person NODES into the domain, from the same single
 * derivation the read surfaces use. The #686 reframe (principal-ruled, on the
 * card): #619's derive-on-read was an interim step; the event log makes the
 * store a rebuildable projection,
 * and a node materialized here — one function, one authority, regenerated on
 * every rostered write — is rebuilt, never synced. #618's drift class stays
 * unrepresentable; the node becomes real.
 *
 * Prior people on the domain are DROPPED and re-derived, which is what makes
 * this idempotent and rebuild-deterministic (sorted by key; no clock, no
 * randomness). The #619 consent guard is inherited whole: identities come only
 * from the closed source-field list via deriveFullPeople (its single consumer)
 * — mentions can never mint a person, excluded identities never appear.
 *
 * Pure — no I/O. The caller supplies the roster (saveDomain's opts.roster).
 */
export function ensurePeople(domain, roster = {}) {
  const { people: _prior, ...rest } = domain;
  const derived = deriveFullPeople(domainToBoard(rest), roster);
  const people = [...derived]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((p) => ({
      '@type': 'Person',
      '@id': PERSON_IRI_BASE + p.key,
      identifier: p.key,
      name: p.name,
      'scrum:glyph': p.glyph,
      'scrum:resolved': p.resolved,
      'scrum:aliases': p.aliases,
    }));
  return { ...rest, people };
}
