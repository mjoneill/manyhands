/**
 * #657 — the bounded, projected card list: slice 1 of projection-first.
 *
 * The board API was complete for changing cards and empty for asking about
 * them: GET /api/cards returned all 587 cards, 2.2MB, 84% of which is the
 * `description` field — and the MCP tool is a thin wrapper, so every agent
 * paid that context cost on every list (#656's measured diagnosis).
 *
 * This module is the pure half: given the card array and a query, return the
 * page. It lives in core/ because REST and MCP are both projections of the
 * same domain — bounding either adapter alone would leave the other carrying
 * the defect (the #628 lesson, verbatim).
 *
 * Contract (same shape as core/people.mjs):
 *   - summary projection by DEFAULT: the card minus its body. Projection is
 *     the feature — it carries 98% of the byte win; bounds alone ship 2%.
 *   - bounded by default; `<list>Total` rides alongside; callers page
 *     backward with `before` (a shortId from a previous page).
 *   - refusal over guessing: an unknown cursor or field name throws a coded
 *     error (UNKNOWN_CURSOR / UNKNOWN_FIELD) for the adapter to turn into a
 *     400. Silently serving page one — or silently dropping a typo'd field —
 *     is a wrong answer delivered fluently (#655).
 */

/**
 * What the summary projection omits — exactly the measured 84%. Widening this
 * list changes the meaning of "summary" for every caller; re-measure first.
 */
export const CARD_SUMMARY_OMIT = ['description'];

/** Default page size. Same value as people.mjs EDGE_RECENT_LIMIT — one habit. */
export const CARD_RECENT_LIMIT = 50;

/**
 * The most a caller may raise the limit to. An override stays a BOUND:
 * nothing any caller sends may reopen the firehose this card exists to close.
 */
export const CARD_LIMIT_CEILING = 500;

/** A caller-supplied limit, clamped to [1, CARD_LIMIT_CEILING]; default otherwise. */
function clampLimit(limit) {
  const n = Number(limit);
  if (!Number.isInteger(n) || n < 1) return CARD_RECENT_LIMIT;
  return Math.min(n, CARD_LIMIT_CEILING);
}

/**
 * The field names a `fields=` list may name — every key a card can carry.
 * Closed set so a typo refuses instead of returning a card that looks like it
 * lacks the field. `id` and `shortId` always ship regardless of the list:
 * a page whose entries can't be addressed can't be paged or followed up.
 */
const CARD_FIELDS = new Set([
  'id', 'shortId', 'title', 'description', 'type', 'assignees', 'labels',
  'for', 'priority', 'column', 'order', 'createdAt', 'updatedAt', 'createdBy',
  'relationships', 'claimedBy', 'claimedAt',
]);

function summarize(card) {
  const out = { ...card };
  for (const k of CARD_SUMMARY_OMIT) delete out[k];
  return out;
}

/** Build the projector for a `fields` request: undefined → summary, 'all' → identity, list → named fields. */
function makeProjector(fields) {
  if (fields == null || fields === '' || fields === 'summary') return summarize;
  if (fields === 'all') return (card) => card;
  const wanted = String(fields).split(',').map((f) => f.trim()).filter(Boolean);
  const unknown = wanted.filter((f) => !CARD_FIELDS.has(f));
  if (unknown.length) {
    const err = new Error(`unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
    err.code = 'UNKNOWN_FIELD';
    throw err;
  }
  const keep = new Set(['id', 'shortId', ...wanted]);
  return (card) => {
    const out = {};
    for (const k of keep) {
      if (k in card) out[k] = card[k];
    }
    return out;
  };
}

/**
 * #659 — the card types a `type=` filter may name. Mirrors the create/update
 * validation enum; closed set, so a typo refuses instead of silently returning
 * an empty page that reads as "no such cards exist".
 */
const CARD_TYPES = new Set(['task', 'idea', 'goal', 'reference', 'feature', 'bug']);

function unknownValue(param, value, valid) {
  const err = new Error(
    `unknown ${param}: ${String(value)} (valid: ${[...valid].join(', ')})`);
  err.code = 'UNKNOWN_FILTER_VALUE';
  return err;
}

/**
 * #659 — exact-match filters, applied BEFORE bounding so a filtered ask
 * reaches the whole board, not just the newest page. Two refusal policies:
 *   - `column` / `type` are CLOSED vocabularies — an unknown value throws
 *     (an empty page for a typo'd column reads as "no cards there", which is
 *     a wrong answer delivered fluently).
 *   - `label` / `assignee` are OPEN vocabularies — any string is a legitimate
 *     ask and an empty result is the honest answer.
 * `since` is a createdAt >= cutoff, same semantics as the conversation list.
 *
 * #643 — `updatedSince` is the RETURNING-AGENT cutoff: updatedAt >= T, falling
 * back to createdAt when a card has never been edited (a never-edited card was
 * "last changed" at creation; treating missing updatedAt as never-changed
 * would silently hide legacy cards). It answers "THAT a card changed", not
 * "WHAT changed" — the latter needs the #642 event log. `since=` keeps its
 * created-only semantics: the two questions are different and conflating them
 * is how the gap went unnoticed (audit #661, finding 2).
 */
function applyFilters(cards, { column, label, assignee, type, since, updatedSince, q }, { validColumns } = {}) {
  let out = cards;
  if (column != null && column !== '') {
    if (Array.isArray(validColumns) && !validColumns.includes(column)) {
      throw unknownValue('column', column, validColumns);
    }
    out = out.filter((c) => c?.column === column);
  }
  if (type != null && type !== '') {
    if (!CARD_TYPES.has(type)) throw unknownValue('type', type, CARD_TYPES);
    out = out.filter((c) => c?.type === type);
  }
  if (label != null && label !== '') {
    out = out.filter((c) => Array.isArray(c?.labels) && c.labels.includes(label));
  }
  if (assignee != null && assignee !== '') {
    out = out.filter((c) => Array.isArray(c?.assignees) && c.assignees.includes(assignee));
  }
  if (since != null && since !== '') {
    out = out.filter((c) => typeof c?.createdAt === 'string' && c.createdAt >= since);
  }
  // #656 — free-text search. The warrant is the board's own miss log: `q` was
  // the top unmet request, recorded at the moment seats wanted it and went
  // elsewhere, and the refusal string said "free-text q not yet" out loud.
  //
  // ⚠️ DELIBERATE LIMITS, pinned by tests rather than described in prose:
  // SUBSTRING and case-insensitive, over TITLE, DESCRIPTION and LABELS. Not
  // tokenised, not stemmed, no ranking — "build" matches "rebuilding" and
  // "built" matches neither. A richer search is a different slice with a
  // different cost; quietly doing less than a caller assumes is the failure
  // mode worth avoiding, so the limits are asserted where they can go red.
  if (q != null && q !== '') {
    const needle = String(q).toLowerCase();
    out = out.filter((c) => {
      const title = typeof c?.title === 'string' ? c.title.toLowerCase() : '';
      const desc = typeof c?.description === 'string' ? c.description.toLowerCase() : '';
      // #656 WIDENED 2026-08-30: labels join the haystack. @michael's design —
      // curated taxonomy terms on an entity so a seat can find it by a word the
      // author chose deliberately, rather than one that happens to appear in
      // the prose. 189 of the first 200 cards carry labels and NONE of that was
      // reachable by search before this line.
      //
      // ⚠️ THIS IS A CONTRACT CHANGE, made deliberately and asserted below —
      // the header's stated limits and the "not labels" test moved in the same
      // commit, which is what this file's own preamble demands.
      const labs = Array.isArray(c?.labels)
        ? c.labels.filter((l) => typeof l === 'string').join(' ').toLowerCase()
        : '';
      return title.includes(needle) || desc.includes(needle) || labs.includes(needle);
    });
  }
  if (updatedSince != null && updatedSince !== '') {
    out = out.filter((c) => {
      const t = typeof c?.updatedAt === 'string' ? c.updatedAt : c?.createdAt;
      return typeof t === 'string' && t >= updatedSince;
    });
  }
  return out;
}

/**
 * Query the card list: filter → sort → window → project.
 *
 * Sorted by shortId ascending — shortIds mint monotonically, so ascending is
 * chronological BY CONSTRUCTION and "most recent" doesn't depend on the
 * accident of storage order (nothing sorts on write; a restored backup owes
 * us nothing).
 *
 * Returns { cards, cardsTotal } where cardsTotal is the FILTERED count — the
 * total answers the question that was asked, not the size of the board.
 * Throws UNKNOWN_CURSOR / UNKNOWN_FIELD / UNKNOWN_FILTER_VALUE.
 */
/**
 * #629's first thin slice — count → facet → refine.
 *
 * The card is an idea dump and says so, but it names this twice as the one
 * capability the surface lacks: "query a Count that would return the number of
 * objects and then choose to filter by a second dimension."
 *
 * ⇒ Today the only way to learn the SHAPE of a result set is to fetch it. An
 *   agent asking "which columns hold my work" pays the full payload to learn a
 *   distribution — on a board where one unpaged call measured 3.9 MB.
 *
 * ⚠️ MULTIVALUED FACETS ARE DECLARED, NOT ASSUMED. A card carries many labels
 * and many assignees, so those counts sum to SLOTS rather than cards. A
 * distribution whose parts silently fail to add up to the whole is the shape of
 * every quietly-narrowed number this board has found, so the response carries
 * `multivalued`, `cardsWithValue` and `unset` and a reader can always reconcile.
 */
export const FACETS = Object.freeze({
  column:   { multivalued: false, of: (c) => (c?.column ? [c.column] : []) },
  type:     { multivalued: false, of: (c) => (c?.type ? [c.type] : []) },
  priority: { multivalued: false, of: (c) => (c?.priority ? [c.priority] : []) },
  label:    { multivalued: true,  of: (c) => (Array.isArray(c?.labels) ? c.labels : []) },
  assignee: { multivalued: true,
    of: (c) => (Array.isArray(c?.assignees) ? c.assignees.filter((a) => a && a !== 'unassigned') : []) },
});

export function facetCards(cards, query = {}, opts = {}) {
  const name = query.facet;
  const spec = FACETS[name];
  if (!spec) {
    const err = new Error(`unknown facet: ${String(name)} (valid: ${Object.keys(FACETS).join(', ')})`);
    err.code = 'UNKNOWN_FACET';
    throw err;
  }
  // Computed over the FILTERED set — a facet that ignored filters would answer a
  // different question than the one the caller is narrowing toward.
  const filtered = applyFilters(cards || [], query, opts);
  const counts = new Map();
  let cardsWithValue = 0;
  for (const c of filtered) {
    const values = spec.of(c);
    if (!values.length) continue;
    cardsWithValue += 1;
    for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  }
  return {
    facet: name,
    multivalued: spec.multivalued,
    total: filtered.length,
    cardsWithValue,
    unset: filtered.length - cardsWithValue,
    counts: [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value))),
  };
}

/**
 * #209 — THE TILE'S PREVIEW, AND WHY IT IS NOT `description`.
 *
 * The board renders about four lines of body into each tile and caps what it
 * builds at 600 characters. Shipping the whole body to draw that is 85% of a
 * 6.9 MB payload; shipping nothing at all leaves every tile blank, which the
 * #209(d) render-cap tests catch.
 *
 * ⛔ SO THE EXCERPT GETS ITS OWN KEY, AND `description` STAYS ABSENT. If a cap
 * arrived AS `description`, the browser's card editor would see a string,
 * believe the body was loaded, fill its textarea with the truncation and write
 * that back on save — a silent 600-character amputation of every card anyone
 * edits. The absent key is load-bearing: it is what tells the editor to fetch
 * before it opens, and what makes #1039's "an omitted key means no opinion"
 * protect a projection-hydrated save.
 *
 * ⚠️ Trailing surrogate trimmed: slicing mid-pair yields U+FFFD in the tile and
 * nothing errors — the edge found in review of 077cfd1.
 */
function excerptOf(description, cap) {
  if (typeof description !== 'string') return '';
  if (description.length <= cap) return description;
  return description.slice(0, cap).replace(/[\uD800-\uDBFF]$/, '') + '…';
}

/** Clamp an `excerpt=` request to something a tile could plausibly show. */
const EXCERPT_CEILING = 2000;

export function queryCards(cards, query = {}, opts = {}) {
  const { limit, before, fields, excerpt, legacyIndex } = query;
  const project = makeProjector(fields);
  const excerptCap = (() => {
    if (excerpt == null || excerpt === '') return 0;
    const n = Number(excerpt);
    if (!Number.isInteger(n) || n < 1) return 0;
    return Math.min(n, EXCERPT_CEILING);
  })();
  // #209 / #923 slice 0 — POSITION IN THE STORE'S ARRAY, captured BEFORE any
  // filter or sort, because that is what it means.
  //
  // ⚠️ NAMED FOR WHAT IT IS. The board's visible order is `order` ASC with ties
  // broken by array position, and 909 of 1,018 live cards sit in one tie group
  // per column — so a principled `(order, shortId)` tie-break is not a tidy-up,
  // it reorders 89% of the board. That is #923 slice 0's decision to make, with
  // that number in front of it. Until then a projection-fed board needs the
  // accident preserved, and a shim that says "legacy" is better than a coupling
  // nobody can grep for. RETIREMENT: #923 slice 0.
  const wantLegacyIndex = legacyIndex === '1' || legacyIndex === 'true' || legacyIndex === true;
  // ⚠️ Indexed against the STORE, not against `cards` — a filtered pool
  // (`under=`, `column=`) would otherwise hand back positions within the
  // filter, which read as store positions and are not.
  const legacyIndexById = wantLegacyIndex
    ? new Map((opts.storeCards || cards || []).map((c, i) => [c?.id, i]))
    : null;
  const decorate = (excerptCap || wantLegacyIndex)
    ? (card) => {
      const out = project(card);
      if (excerptCap) out.descriptionExcerpt = excerptOf(card?.description, excerptCap);
      if (wantLegacyIndex) out.legacyArrayIndex = legacyIndexById.get(card?.id) ?? -1;
      return out;
    }
    : project;
  const filtered = applyFilters(cards || [], query, opts);
  const sorted = [...filtered].sort((a, b) => (a?.shortId ?? 0) - (b?.shortId ?? 0));

  let end = sorted.length;
  if (before != null && before !== '') {
    const at = sorted.findIndex((c) => String(c?.shortId) === String(before));
    if (at < 0) {
      // Refusing beats guessing: an agent paging until it sees a short page
      // would loop forever on a silently-served page one, every iteration
      // looking like success.
      const err = new Error(`unknown before cursor: ${String(before)}`);
      err.code = 'UNKNOWN_CURSOR';
      throw err;
    }
    end = at;
  }

  const page = sorted.slice(Math.max(0, end - clampLimit(limit)), end);
  return { cards: page.map(decorate), cardsTotal: sorted.length };
}
