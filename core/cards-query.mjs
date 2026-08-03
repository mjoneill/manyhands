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
const CARD_TYPES = new Set(['task', 'idea', 'goal', 'reference', 'feature']);

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
 */
function applyFilters(cards, { column, label, assignee, type, since }, { validColumns } = {}) {
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
export function queryCards(cards, query = {}, opts = {}) {
  const { limit, before, fields } = query;
  const project = makeProjector(fields);
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
  return { cards: page.map(project), cardsTotal: sorted.length };
}
