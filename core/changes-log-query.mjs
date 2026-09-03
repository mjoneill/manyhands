/**
 * changes-log-query.mjs — #679: what_changed_since as a PURE function of the
 * event log. Supersedes the field-read union in changes-query.mjs: fields
 * could say only "something changed most recently"; the log says what, in
 * order, including deletions, which fields structurally could not carry.
 *
 * Contract ruled on #642 before a line of this existed:
 *   R5  pure-from-log — the envelope never consults the live store
 *   R2  per-kind quotas DEFAULT (posts outnumber card events ~15:1; a flat
 *       limit is a correct bounded answer that reliably hides the scarce kind)
 *   R3  latest-event-per-entity DEFAULT ("these 12 cards changed", not
 *       "50 versions of one card"); history: true returns every event
 *   R4  per-kind totals + truncated flags — the cut is confessed, per kind
 *   R6  a since older than retention REFUSES with oldest_retained — never a
 *       silent partial; a partial that looks whole is the failure class this
 *       whole design exists to kill
 */

const DEFAULT_QUOTA = Object.freeze({ cards: 50, posts: 50 });
const QUOTA_CEILING = 500;

const bucketOf = (ev) => (ev.entity?.kind === 'conversation' ? 'posts' : 'cards');

function toRow(ev) {
  const s = ev.state || {};
  return {
    kind: ev.entity?.kind ?? null,
    op: ev.op,
    seq: ev.seq,
    id: ev.entity?.id ?? null,
    shortId: ev.entity?.shortId ?? s.shortId ?? null,
    title: s.title ?? (typeof s.body === 'string' ? s.body.slice(0, 120) : null),
    // #1027 — the column the entity was in AFTER this event, for cards. The one
    // field a flow reader needs to see a card ENTER done: without it "changed"
    // and "finished" are the same row, and the flow report had to count a
    // done card that was merely edited as a completion. null for posts and for
    // events whose state carries no column (tombstones keep their last one).
    column: ev.entity?.kind === 'card' ? (s.column ?? null) : null,
    by: ev.actor ?? null,
    at: ev.recorded_at,
  };
}

/**
 * @param {Array} events  parsed log events, seq-ascending (readEvents order)
 * @param {object} opts   { since, oldestRetained, limit:{cards,posts}, history,
 *                          entity (shortId), actor, before (seq cursor) }
 */
export function queryChangesFromLog(events, {
  since, oldestRetained, limit, history = false, entity, actor, before,
} = {}) {
  if (since == null || since === '') {
    const err = new Error('since is required (ISO timestamp): a changes query without a cutoff is an unbounded read');
    err.code = 'MISSING_SINCE';
    throw err;
  }
  if (typeof oldestRetained === 'string' && since < oldestRetained) {
    const err = new Error(`since ${since} predates the log's retention (oldest: ${oldestRetained}) — `
      + 'a reply from here would be silently partial. Resync from the live store '
      + `(card_list / conversation_list), then ask since(${oldestRetained}) or later.`);
    err.code = 'CURSOR_TOO_OLD';
    err.oldest_retained = oldestRetained;
    err.resync = true;
    throw err;
  }

  const quota = {
    cards: Math.min(Number(limit?.cards ?? DEFAULT_QUOTA.cards), QUOTA_CEILING),
    posts: Math.min(Number(limit?.posts ?? DEFAULT_QUOTA.posts), QUOTA_CEILING),
  };

  let rows = events.filter((ev) => typeof ev.recorded_at === 'string' && ev.recorded_at >= since);
  if (entity != null) rows = rows.filter((ev) => ev.entity?.shortId === Number(entity));
  if (actor != null) rows = rows.filter((ev) => ev.actor === actor);

  if (before != null) {
    const cursor = Number(before);
    if (!rows.some((ev) => ev.seq === cursor)) {
      const err = new Error(`unknown cursor seq ${before}: refusing to silently serve page one`);
      err.code = 'UNKNOWN_CURSOR';
      throw err;
    }
    rows = rows.filter((ev) => ev.seq < cursor);
  }

  // R3 — latest-event-per-entity default, applied to card-side kinds only
  // (posts are one event each by construction). The log keeps everything;
  // this is purely about what the default projection hands back.
  if (!history) {
    const latest = new Map();
    const kept = [];
    for (const ev of rows) {
      if (bucketOf(ev) !== 'cards') { kept.push(ev); continue; }
      const key = `${ev.entity?.kind}|${ev.entity?.id}`;
      latest.set(key, ev); // rows are seq-ascending: last write wins
    }
    const latestSet = new Set(latest.values());
    rows = rows.filter((ev) => bucketOf(ev) !== 'cards' ? true : latestSet.has(ev));
  }

  const buckets = { cards: [], posts: [] };
  for (const ev of rows) buckets[bucketOf(ev)].push(ev);
  const totals = { cards: buckets.cards.length, posts: buckets.posts.length };

  // Newest tail per kind (the page a returning seat wants), re-merged into
  // one seq-ordered list — the interleaving IS the deliverable (R1).
  const cut = {
    cards: buckets.cards.slice(-quota.cards),
    posts: buckets.posts.slice(-quota.posts),
  };
  const truncated = {
    cards: totals.cards > cut.cards.length,
    posts: totals.posts > cut.posts.length,
  };
  const merged = [...cut.cards, ...cut.posts].sort((a, b) => a.seq - b.seq);

  return {
    changes: merged.map(toRow),
    window: { since },
    newest: merged.at(-1)?.recorded_at ?? null,
    oldest: merged[0]?.recorded_at ?? null,
    totals,
    returned: merged.length,
    truncated,
    history,
    covers: { posts: 'exact', cards: 'creates+updates+deletes' },
    // #675 CLOSED: PATCH/DELETE now carry a declared `by` — the capability
    // exists, so the omission ledger is empty. Historical nulls (and silent
    // callers) are DATA — "unsaid" — not an omission of the surface.
    omits: { cards: [] },
  };
}
