/**
 * #643 — the returning-agent catch-up query: "what did I miss?" as a single
 * bounded call instead of an archaeology.
 *
 * Union of the two node kinds behind one `since=` cutoff, time-ordered:
 *   posts  createdAt >= since — EXACT, forever: posts are append-only by
 *          construction (no PATCH/DELETE route exists), so current-state
 *          timestamps ARE the complete history for this kind.
 *   cards  (updatedAt ?? createdAt) >= since — creates+updates ONLY. The
 *          store keeps no deletions and no edit deltas; that half arrives
 *          with the #642 event log, underneath this endpoint, without its
 *          callers changing. Wiki pages are these same card nodes (ADR-001,
 *          one store, two projections) — never duplicated as a third kind.
 *
 * Contract decisions made in-room (card #643, 01:05Z), implemented verbatim:
 *   - order=asc DEFAULT (bounded surfaces share one order; replay semantics);
 *     order=desc the explicit, named exception for triage. "The default is
 *     the principled one; the exception is where the beneficiary speaks."
 *   - bounded in CARDINALITY, not just time: a busy hour is not bounded by
 *     the clock. Default limit, hard ceiling, total/returned/truncated.
 *   - the page is the NEWEST tail of the window; `before=<at>` narrows the
 *     window backward for history walks.
 *   - envelope carries newest/oldest (O(1) orientation, order-independent)
 *     and per-kind covers/omits — audible coverage, never inferred (#630's
 *     audible-clamp principle applied to coverage).
 *   - `by` is honest: author for posts (always present), createdBy for card
 *     creates, NULL for card updates — edit-authorship does not exist yet
 *     and a null beats a guess.
 */

export const CHANGES_RECENT_LIMIT = 50;
export const CHANGES_LIMIT_CEILING = 500;

function clampLimit(limit) {
  const n = Number(limit);
  if (!Number.isInteger(n) || n < 1) return CHANGES_RECENT_LIMIT;
  return Math.min(n, CHANGES_LIMIT_CEILING);
}

/**
 * Query the change stream. Throws MISSING_SINCE (a changes query without a
 * cutoff is the firehose this surface exists to close).
 *
 * Returns { changes, window, newest, oldest, total, returned, truncated,
 *           covers, omits }.
 */
export function queryChanges(board, { since, before, limit, order } = {}) {
  if (since == null || since === '') {
    const err = new Error('since is required (ISO timestamp): a changes query without a cutoff is an unbounded read — use card_list / conversation_list for browsing');
    err.code = 'MISSING_SINCE';
    throw err;
  }

  const rows = [];
  for (const c of board?.cards || []) {
    const at = typeof c?.updatedAt === 'string' ? c.updatedAt : c?.createdAt;
    if (typeof at !== 'string' || at < since) continue;
    const created = typeof c?.createdAt === 'string' && c.createdAt >= since;
    rows.push({
      kind: 'card',
      id: c.id,
      shortId: c.shortId,
      title: c.title,
      action: created ? 'create' : 'update',
      by: created ? (c.createdBy ?? null) : null,
      at,
    });
  }
  for (const p of board?.conversations || []) {
    const at = p?.createdAt;
    if (typeof at !== 'string' || at < since) continue;
    rows.push({
      kind: 'post',
      id: p.id,
      by: p.author ?? null,
      attachedTo: p.attachedTo ?? null,
      at,
    });
  }

  // Chronological by construction; id as tiebreak so paging is stable.
  rows.sort((a, b) => a.at.localeCompare(b.at) || String(a.id).localeCompare(String(b.id)));

  const windowed = (before != null && before !== '')
    ? rows.filter((r) => r.at < before)
    : rows;

  const newest = windowed.at(-1)?.at ?? null;
  const oldest = windowed[0]?.at ?? null;

  // The newest tail: catch-up reads recent first, history pages backward.
  const page = windowed.slice(Math.max(0, windowed.length - clampLimit(limit)));
  const changes = order === 'desc' ? [...page].reverse() : page;

  return {
    changes,
    window: { from: since, to: newest },
    newest,
    oldest,
    total: windowed.length,
    returned: page.length,
    truncated: page.length < windowed.length,
    covers: { posts: 'exact', cards: 'creates+updates' },
    omits: { cards: ['deletes', 'edit-actor'] },
  };
}
