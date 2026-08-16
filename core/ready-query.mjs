/**
 * core/ready-query.mjs — #815: the computed work queue.
 *
 * `board_ready` answers the one question every seat asks at wake — "what can
 * I usefully do next?" — from GRAPH STATE, not from a seat's private reading
 * of card_list plus commons archaeology. The graph stays authoritative; this
 * is a derived projection (the room's one-coordination-truth rule), and every
 * inclusion AND exclusion carries a machine-readable reason traceable to the
 * triples it was computed from (steward disqualifier, commons 85e0d299: if a
 * fact isn't queryable from graph state, stop — never silently consult
 * another authority).
 *
 * THE RULESET (pre-registered on the card before implementation):
 *   excluded  column:done            the card is finished
 *   excluded  claimed-by:<seat>      someone holds the mutex
 *   excluded  open-blocker:<n>       a blockedBy target is not in done
 *                                    (ANY open blocker excludes — a closed
 *                                    sibling does not clear the card)
 *   excluded  dangling-blocker:<id>  a blockedBy target that doesn't resolve.
 *                                    CONSERVATIVE by decision, not accident:
 *                                    both answers are defensible, so the
 *                                    choice is written down and tested. A
 *                                    dangling edge is EXPOSED as the reason —
 *                                    never erased (the cardEdgesResolved
 *                                    lesson).
 *   ready     otherwise              reasons: column, unclaimed, no open
 *                                    blockers — inclusion is explained too.
 *
 * ORDER: priority p0 < p1 < p2 < p3 < unprioritized, then shortId ascending
 * (shortIds mint monotonically, so ties resolve oldest-first by construction).
 *
 * Exclusion precedence when several apply: done > claimed > open-blocker >
 * dangling-blocker. Deterministic so explanations are stable across calls.
 */

import { queryGraph } from './graph-replica.mjs';

/**
 * Per-card facts. Witness partner for its absence claims: anyCardWitness in
 * graph-queries.mjs (same class/identifier/name predicates). ⚠️ identifier is
 * a STRING literal; column and claimedBy arrive as prefixed IRIs.
 */
export const readyFactsQuery = () =>
  `SELECT ?card ?id ?title ?type ?col ?prio ?claimed WHERE { ` +
  `?card a schema:CreativeWork ; schema:identifier ?id ; schema:name ?title . ` +
  `OPTIONAL { ?card scrum:cardType ?type } ` +
  `OPTIONAL { ?card scrum:column ?col } ` +
  `OPTIONAL { ?card scrum:priority ?prio } ` +
  `OPTIONAL { ?card scrum:claimedBy ?claimed } }`;

/**
 * Every blockedBy edge, target resolved via OPTIONAL so a dangling edge
 * arrives as a row with ?tid unbound instead of vanishing (the inner-join
 * trap, measured on cardEdgesResolved's first cut).
 */
export const readyBlockersQuery = () =>
  `SELECT ?id ?target ?tid ?tcol WHERE { ` +
  `?card a schema:CreativeWork ; schema:identifier ?id ; scrum:blockedBy ?target . ` +
  `OPTIONAL { ?target schema:identifier ?tid } ` +
  `OPTIONAL { ?target scrum:column ?tcol } }`;

/**
 * #817 — supersession edges, target resolved via OPTIONAL so a dangling
 * superseder still excludes rather than vanishing.
 *
 * ⚠️ `supersededBy` is SERVER-MAINTAINED from `supersedes` (server.js:807),
 * which is why it can be trusted as a one-sided read: all four live edges were
 * verified symmetric in both directions before this rule was accepted. That
 * matters because 79% of `relatedTo` is one-ended — had supersession been
 * maintained as loosely, this exclusion would fire on one side and miss the
 * other, and the queue would answer differently depending on which card you
 * asked about.
 */
export const readySupersededQuery = () =>
  `SELECT ?id ?target ?tid WHERE { ` +
  `?card a schema:CreativeWork ; schema:identifier ?id ; scrum:supersededBy ?target . ` +
  `OPTIONAL { ?target schema:identifier ?tid } }`;

/**
 * Witness partner for readyBlockersQuery: same predicates, any card. If this
 * returns a row, a 0-edge answer for a specific card is a measurement; if it
 * returns none on a board known to have blockers, the predicates are wrong
 * and every "no open blockers" verdict is void.
 */
export const anyBlockedCardWitness = () =>
  `SELECT ?id ?target WHERE { ?card a schema:CreativeWork ; ` +
  `schema:identifier ?id ; scrum:blockedBy ?target } LIMIT 1`;

/**
 * #816 — every coordination edge a card carries, target resolved via OPTIONAL
 * so an unresolved reference (#818) arrives with no title rather than
 * vanishing. `?sid` is the STORED identifier — the target's own shortId when
 * it resolves, the UnresolvedReference's identifier when it doesn't — so
 * ordering never depends on resolution.
 */
export const readyContextQuery = () =>
  `SELECT ?id ?p ?sid ?title WHERE { ` +
  `?card a schema:CreativeWork ; schema:identifier ?id ; ?p ?o . ` +
  `FILTER(?p IN (scrum:relatedTo, scrum:derivedFrom, scrum:supersedes, scrum:supersededBy)) ` +
  `OPTIONAL { ?o schema:identifier ?sid } ` +
  `OPTIONAL { ?o a schema:CreativeWork ; schema:name ?title } }`;

/**
 * ⚠️ UNIFORM across all four types on purpose. `derivedFrom` holds 26 edges
 * board-wide today and `relatedTo` 1,498 — but a census is not a cardinality,
 * and nothing forbids a card carrying forty of either. Capping only the
 * currently-large type would re-import census-as-guarantee in smaller print.
 */
export const CONTEXT_K = 5;
const CONTEXT_TYPES = ['relatedTo', 'derivedFrom', 'supersedes', 'supersededBy'];

/** 'column:done' → 'done'; 'person:ada' → 'ada'; full IRIs → last segment. */
const tail = (v) => {
  if (v == null) return null;
  const s = String(v);
  const cut = Math.max(s.lastIndexOf('#'), s.lastIndexOf('/'), s.indexOf(':'));
  return cut >= 0 ? s.slice(cut + 1) : s;
};

const PRIORITY_RANK = { p0: 0, p1: 1, p2: 2, p3: 3 };
const rank = (p) => (p in PRIORITY_RANK ? PRIORITY_RANK[p] : PRIORITY_RANK.p3 + 1);

export const READY_DEFAULT_LIMIT = 20;
/**
 * A caller-supplied limit REFUSES when unparseable or non-positive instead of
 * silently serving the default — `limit=abc` answered with 20 rows is the
 * fail-silent substitution shape #809 just retired one file over. Absent
 * means default; present means valid or 400.
 */
const clampLimit = (limit) => {
  if (limit == null || limit === '') return READY_DEFAULT_LIMIT;
  const n = Number(limit);
  if (!Number.isInteger(n) || n < 1) {
    const err = new Error(`invalid limit: ${String(limit)} (a positive integer, or omit for ${READY_DEFAULT_LIMIT})`);
    err.code = 'READY_BAD_LIMIT';
    throw err;
  }
  return n;
};

/**
 * Pure fold: fact rows + blocker rows → the verdict for EVERY card, unpaged.
 * All facts arrive from the two queries above; nothing here reads any other
 * authority. Exported separately so the ruleset is testable against
 * hand-built rows without a store.
 *
 * Returns { included, excluded } — both COMPLETE and ordered. Paging is
 * presentation and lives in pageReady; verdicts and pages are different
 * objects because conflating them made 95.6% of the live queue's ready cards
 * 404 on explain (verifier finding, card thread bb2ccee6: explain searched
 * the paged list, so ready-but-past-the-page read as does-not-exist).
 */
/**
 * #816 — fold context rows into a per-card, per-type bounded summary.
 *
 * ORDER: stored identifier, numeric DESC, then non-numeric ASC. Arbitrary but
 * total and stable — NOT recency (relationship edges carry no timestamp) and
 * NOT relevance (nothing in the graph ranks a relation). ⚠️ Keyed on the
 * STORED identifier so a target's deletion changes only metadata, never rank:
 * "resolved first, dangling last" would reshuffle a list because something
 * happened to a different card.
 */
function foldContext(contextRows) {
  const byCard = new Map();
  for (const r of contextRows || []) {
    const id = Number(r.id);
    const type = tail(r.p);
    if (!CONTEXT_TYPES.includes(type)) continue;
    if (!byCard.has(id)) byCard.set(id, new Map(CONTEXT_TYPES.map((t) => [t, []])));
    byCard.get(id).get(type).push({
      shortId: /^\d+$/.test(String(r.sid)) ? Number(r.sid) : r.sid,
      title: r.title ?? null,
    });
  }
  const out = new Map();
  for (const [id, types] of byCard) {
    const ctx = {};
    for (const t of CONTEXT_TYPES) {
      const all = (types.get(t) || []).sort((a, b) => {
        const an = typeof a.shortId === 'number', bn = typeof b.shortId === 'number';
        if (an && bn) return b.shortId - a.shortId;                 // numeric DESC
        if (an !== bn) return an ? -1 : 1;                          // numerics first
        return String(a.shortId).localeCompare(String(b.shortId));  // then ASC
      });
      ctx[t] = { members: all.slice(0, CONTEXT_K), total: all.length, truncated: all.length > CONTEXT_K };
    }
    out.set(id, ctx);
  }
  return out;
}

const emptyContext = () =>
  Object.fromEntries(CONTEXT_TYPES.map((t) => [t, { members: [], total: 0, truncated: false }]));

export function computeReady(factRows, blockerRows, supersededRows, contextRows) {
  const blockersByCard = new Map();
  for (const r of blockerRows || []) {
    const id = Number(r.id);
    if (!blockersByCard.has(id)) blockersByCard.set(id, []);
    blockersByCard.get(id).push(r);
  }
  // #817 — first superseder wins, ordered so the reason is deterministic.
  const supersededBy = new Map();
  for (const r of supersededRows || []) {
    const id = Number(r.id);
    const label = r.tid != null ? String(r.tid) : tail(r.target);
    const prev = supersededBy.get(id);
    if (prev == null || label < prev) supersededBy.set(id, label);
  }
  const contextByCard = foldContext(contextRows);   // #816

  const verdicts = [];
  for (const r of factRows || []) {
    const shortId = Number(r.id);
    const column = tail(r.col);
    const claimed = tail(r.claimed);
    const base = {
      shortId, title: r.title, type: r.type ?? null,
      priority: r.prio ?? null, column,
      // #816 — present on EVERY verdict, ready or excluded. pageReady strips it
      // from the paged excluded[] list (294 rows nobody chooses work from);
      // READY_EXPLAIN keeps it, which is the live failure this card closed.
      context: contextByCard.get(shortId) ?? emptyContext(),
    };

    if (column === 'done') { verdicts.push({ ...base, ready: false, reason: 'column:done' }); continue; }
    if (claimed) { verdicts.push({ ...base, ready: false, reason: `claimed-by:${claimed}` }); continue; }
    // #817 — a REPLACED card is not available work. Flat rule: the superseder's
    // own state is never consulted. "Unless the superseder was abandoned, in
    // which case the original may be live again" is inference no edge asserts
    // and nothing can test — a guess with a query attached.
    const sup = supersededBy.get(shortId);
    if (sup != null) { verdicts.push({ ...base, ready: false, reason: `superseded-by:${sup}` }); continue; }

    const edges = blockersByCard.get(shortId) || [];
    const open = edges.filter((e) => e.tid != null && tail(e.tcol) !== 'done')
      .map((e) => Number(e.tid)).sort((a, b) => a - b);
    if (open.length) { verdicts.push({ ...base, ready: false, reason: `open-blocker:${open[0]}` }); continue; }
    const dangling = edges.filter((e) => e.tid == null).map((e) => tail(e.target)).sort();
    if (dangling.length) { verdicts.push({ ...base, ready: false, reason: `dangling-blocker:${dangling[0]}` }); continue; }

    verdicts.push({ ...base, ready: true, reasons: [`column:${column}`, 'unclaimed', 'no-open-blockers'] });
  }

  const included = verdicts.filter((v) => v.ready)
    .sort((a, b) => (rank(a.priority) - rank(b.priority)) || (a.shortId - b.shortId))
    .map(({ ready: _r, ...c }) => c);
  const excluded = verdicts.filter((v) => !v.ready)
    .map(({ shortId, title, reason, context }) => ({ shortId, title, reason, context }))
    .sort((a, b) => a.shortId - b.shortId);

  return { included, excluded };
}

/**
 * Verdicts → the wire page. BOTH lists are bounded by the same limit
 * (verifier note: an unpaged excluded beside a paged ready returned 292
 * exclusion rows per call on the live board); the totals always count the
 * whole board, and per-card answers past either page are explain's job.
 * Throws READY_BAD_LIMIT — refusal over silent defaulting.
 */
export function pageReady(verdicts, { limit } = {}) {
  const n = clampLimit(limit);
  return {
    ready: verdicts.included.slice(0, n),
    readyTotal: verdicts.included.length,
    // #816 — the paged excluded list stays exactly #815's shape: 294 rows
    // nobody chooses work from. A seat wanting an excluded card's context
    // asks explain, which carries it.
    excluded: verdicts.excluded.slice(0, n).map(({ shortId, title, reason }) => ({ shortId, title, reason })),
    excludedTotal: verdicts.excluded.length,
  };
}

/**
 * Run the queries against the replica and fold to COMPLETE verdicts.
 * Truncation REFUSES rather than verdicts on a partial board: a queue
 * computed from 1000 of 1200 cards is a wrong answer delivered fluently.
 * (Ceiling is graph-replica's LIMIT_CEILING; today's board is ~a third of it.)
 */
export function readyFromStore(store) {
  const facts = queryGraph(store, readyFactsQuery(), { limit: 1000 });
  const blockers = queryGraph(store, readyBlockersQuery(), { limit: 1000 });
  const superseded = queryGraph(store, readySupersededQuery(), { limit: 1000 });
  // ⚠️ #816 — this query returns ONE ROW PER EDGE, not per card. The board
  // carries ~1,545 relationship members against graph-replica's LIMIT_CEILING
  // of 1,000, so a single call truncates and the refusal below would take the
  // whole queue down. Found by running against the live board; a fixture with
  // ten edges cannot reach it. Paged rather than ceiling-raised: the ceiling
  // protects every other caller and this is the one query that legitimately
  // outgrows it.
  const context = { rows: [], truncated: false };
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const page = queryGraph(store, `${readyContextQuery()} LIMIT ${PAGE} OFFSET ${offset}`, { limit: PAGE });
    context.rows.push(...page.rows);
    if (page.rows.length < PAGE) break;
    // A board large enough to need more pages than this is a different problem;
    // refusing beats looping forever on a query that never shrinks.
    if (offset > 200_000) { context.truncated = true; break; }
  }
  if (facts.truncated || blockers.truncated || superseded.truncated || context.truncated) {
    const err = new Error('board exceeds the ready computation bound; refusing a partial queue');
    err.code = 'READY_TRUNCATED';
    throw err;
  }
  return computeReady(facts.rows, blockers.rows, superseded.rows, context.rows);
}

/**
 * The verdict for ONE card, included or excluded, from COMPLETE verdicts —
 * never from a page, so a ready card past the window still answers ready
 * (the bb2ccee6 regression). Unknown shortIds refuse (UNKNOWN_CARD): "not in
 * the queue" and "no such card" are different answers and conflating them is
 * how a typo reads as an empty board.
 */
export function READY_EXPLAIN(verdicts, shortId) {
  const n = Number(shortId);
  const hit = verdicts.included.find((c) => c.shortId === n);
  if (hit) return { shortId: n, ready: true, reasons: hit.reasons, context: hit.context };
  const miss = verdicts.excluded.find((c) => c.shortId === n);
  if (miss) return { shortId: n, ready: false, reason: miss.reason, context: miss.context };
  const err = new Error(`no such card in graph state: ${String(shortId)}`);
  err.code = 'UNKNOWN_CARD';
  throw err;
}
