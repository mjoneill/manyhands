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
  `SELECT ?card ?id ?title ?type ?col ?prio ?claimed ?parkedBy ?parkedUntil WHERE { ` +
  `?card a schema:CreativeWork ; schema:identifier ?id ; schema:name ?title . ` +
  `OPTIONAL { ?card scrum:cardType ?type } ` +
  `OPTIONAL { ?card scrum:column ?col } ` +
  `OPTIONAL { ?card scrum:priority ?prio } ` +
  `OPTIONAL { ?card scrum:claimedBy ?claimed } ` +
  `OPTIONAL { ?card scrum:parkedBy ?parkedBy } ` +
  `OPTIONAL { ?card scrum:parkedUntil ?parkedUntil } }`;

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
 * #1041 — blockers scoped to ONE ACCEPTANCE CONDITION rather than to the card.
 *
 * ⛔ THE DEFECT THIS ANSWERS: a constraint on one condition could only be
 * expressed as a card-level `blockedBy`, so the queue reported a card as parked
 * behind an epic when most of it was deliverable. #125 sat four days that way —
 * five of six conditions approved by the owner and gate-discharged, one
 * correctly blocked, and the verdict read `open-blocker:310`.
 *
 * ⭐ It is the SAME predicate with a different SUBJECT: a condition-scoped block
 * is a `scrum:blockedBy` whose subject is a ReleaseCondition. No second
 * vocabulary, so no query has to know which subsystem it is standing in.
 */
export const readyConditionBlockersQuery = () =>
  `SELECT ?id ?tid WHERE { ` +
  `?rc a scrum:ReleaseCondition ; scrum:ofCard ?card ; scrum:blockedBy ?target . ` +
  `?card schema:identifier ?id . ` +
  `OPTIONAL { ?target schema:identifier ?tid } }`;

/**
 * #965 — HUMAN blockers: `scrum:Blocker` nodes carrying `blockedByPerson` or
 * (#966) `blockedByAnyHuman`. These are a DIFFERENT SHAPE from the card→card
 * `scrum:blockedBy` edges above — a separate node with its own status — which
 * is exactly why the original ruleset never saw them: #881 shipped after
 * `core/ready-query.mjs` pre-registered its five rules.
 *
 * ⚠️ The FILTER is what keeps card-blockers out of this result. A card-blocker
 * is also a `scrum:Blocker` node, so without it this query would re-report
 * every card→card edge under a person reason and relabel a rule that already
 * works.
 *
 * ⚠️ `status` is OPTIONAL and absence means OPEN. A blocker written without a
 * status is not a cleared one, and defaulting the other way would let the
 * commonest hand-written shape silently stop gating.
 */
export const readyHumanBlockersQuery = () =>
  `SELECT ?id ?person ?anyHuman ?status WHERE { ` +
  `?card a schema:CreativeWork ; schema:identifier ?id . ` +
  `?b a scrum:Blocker ; scrum:blocks ?card . ` +
  `OPTIONAL { ?b scrum:blockedByPerson ?person } ` +
  `OPTIONAL { ?b scrum:blockedByAnyHuman ?anyHuman } ` +
  `OPTIONAL { ?b scrum:status ?status } ` +
  `FILTER(BOUND(?person) || BOUND(?anyHuman)) }`;

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

export function computeReady(factRows, blockerRows, supersededRows, contextRows, humanBlockerRows, conditionBlockerRows) {
  // #965 — card shortId → sorted keys of its OPEN human blockers.
  // `cleared` is the only status that does not gate: #881 built the field so
  // the queue CONVERGES, and a rule ignoring it would hide a card forever once
  // anyone had ever blocked it.
  const humanBlockersByCard = new Map();
  for (const r of humanBlockerRows || []) {
    if (tail(r.status) === 'cleared') continue;
    const id = Number(r.id);
    if (!Number.isFinite(id)) continue;
    // The any-human case gets a readable key rather than a fabricated person
    // name — "who" is genuinely nobody, and inventing one would recreate the
    // misattribution #966 exists to remove.
    const key = r.person ? tail(r.person) : 'any-human';
    const list = humanBlockersByCard.get(id) || [];
    list.push(key);
    humanBlockersByCard.set(id, list);
  }
  const blockersByCard = new Map();
  for (const r of blockerRows || []) {
    const id = Number(r.id);
    if (!blockersByCard.has(id)) blockersByCard.set(id, []);
    blockersByCard.get(id).push(r);
  }

  // #1041 — card shortId → the set of blocker targets CLAIMED by one of its
  // acceptance conditions. A target in this set is not a card-level block; it
  // is a declared limit on one deliverable.
  const scopedByCard = new Map();
  for (const r of conditionBlockerRows || []) {
    if (r?.tid == null) continue;   // an unresolvable target claims nothing
    const id = Number(r.id);
    if (!scopedByCard.has(id)) scopedByCard.set(id, new Set());
    scopedByCard.get(id).add(Number(r.tid));
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
    // An authored, EXPIRING "not yet". The expiry is why this is safe to
    // honour: a park with no end date becomes permanent by forgetting, which
    // is how a card carrying a human's "do not work on this" sat at queue
    // position 1 for a month. A lapsed park returns the card on its own.
    const parkedUntil = r.parkedUntil;
    if (r.parkedBy && parkedUntil && parkedUntil > new Date().toISOString()) {
      verdicts.push({ ...base, ready: false, reason: `parked-by:${tail(r.parkedBy)}-until:${parkedUntil}` });
      continue;
    }
    // #817 — a REPLACED card is not available work. Flat rule: the superseder's
    // own state is never consulted. "Unless the superseder was abandoned, in
    // which case the original may be live again" is inference no edge asserts
    // and nothing can test — a guess with a query attached.
    const sup = supersededBy.get(shortId);
    if (sup != null) { verdicts.push({ ...base, ready: false, reason: `superseded-by:${sup}` }); continue; }

    // #910 — A DOCUMENT IS NOT WORK. A `reference` card is an artifact that
    // already exists: an ADR, a plan, a runbook, a retro observation, a
    // research read. There is no unit of work in it, so it can never be the
    // answer to "what do I pull next" — and this queue exists to answer
    // exactly that question.
    //
    // Measured 2026-08-23: 48 `reference` cards sat in the ready pool, ~9% of
    // it. The seat actually pulling scanned 530 ready cards and could not
    // identify one worth taking. "Nothing clearly pullable" is what a queue
    // full of documents feels like from the pulling seat.
    //
    // ⚠️ EXCLUDED, NOT HIDDEN. The card appears in `excluded` with this reason,
    // so a reader can see WHY it is absent. A silent filter would trade one
    // unanswerable question ("why is there nothing to pull?") for another
    // ("where did my card go?").
    //
    // ⛔ `goal` is DELIBERATELY NOT HERE. An epic is a legitimate queue member —
    // someone can pull an epic and decompose it. Excluding goals was proposed
    // and refused: it would drop #857 and #495 out of the queue, and demoting
    // an apex is the room's call, not a filter's.
    //
    // ⭐ Placed AFTER the state guards (done/claimed/parked/superseded) so a
    // finished reference card still reports `column:done` — the more specific
    // and more actionable fact. Placed BEFORE the blocker guards because a
    // document's blockers are irrelevant to a queue that will never offer it.
    if (base.type === 'reference') {
      verdicts.push({ ...base, ready: false, reason: 'context:reference' });
      continue;
    }

    const edges = blockersByCard.get(shortId) || [];
    const open = edges.filter((e) => e.tid != null && tail(e.tcol) !== 'done')
      .map((e) => Number(e.tid)).sort((a, b) => a - b);

    // #1041 — RULED 2026-08-24, recorded on the card before this was written:
    // OFFER THE CARD, AND NAME THE BLOCKED CONDITION. Neither hide it nor offer
    // it silently.
    //
    // ⛔ PARTIAL ACCOUNTING IS NOT ENOUGH. Only blockers that a condition has
    // CLAIMED are set aside; any blocker nobody claimed still removes the card,
    // and the reason names the UNACCOUNTED one. A rule that offered a card as
    // soon as ANY of its blockers was scoped would quietly offer genuinely
    // blocked work — the failure direction this must not have.
    const scoped = scopedByCard.get(shortId) || new Set();
    const unaccounted = open.filter((t) => !scoped.has(t));
    if (unaccounted.length) {
      verdicts.push({ ...base, ready: false, reason: `open-blocker:${unaccounted[0]}` });
      continue;
    }
    // ⇒ Every open blocker is condition-scoped. The card is offered, and the
    // reason RIDES THE READY ENTRY rather than living only in the excluded list:
    // a caller reading only the queue must still see it, or this trades an
    // invisible block for an unread one.
    const conditionScoped = open.length ? `blocked-condition:${open.join(',')}` : null;
    const dangling = edges.filter((e) => e.tid == null).map((e) => tail(e.target)).sort();
    if (dangling.length) { verdicts.push({ ...base, ready: false, reason: `dangling-blocker:${dangling[0]}` }); continue; }

    // #965 — an open HUMAN blocker removes the card. PO decision 2026-08-20,
    // GATING rather than advisory, after the owner declined to rule on queue
    // semantics that were never his.
    //
    // ⛔ FLAT RULE, inherited from #817 and binding: present and open ⇒
    // exclude, and do NOT look at WHO is named. "Unless the named person is
    // the seat asking" is inference no edge asserts.
    //
    // ⭐ Covers `blockedByPerson` AND `blockedByAnyHuman` (#966) deliberately.
    // Adding a blocker predicate without extending this is a regression: a
    // card waiting on any human would become ready again, which is this rule's
    // own defect arriving through its sibling, with a `reasons` array that
    // reads correct.
    const human = (humanBlockersByCard.get(shortId) || []).sort();
    if (human.length) { verdicts.push({ ...base, ready: false, reason: `person-blocker:${human[0]}` }); continue; }

    // ⛔ NEVER BOTH. Claiming `no-open-blockers` beside a scoped block would be
    // the false reason #965 was filed for, in a `reasons` array that reads correct.
    verdicts.push({
      ...base,
      ready: true,
      reasons: [`column:${column}`, 'unclaimed', conditionScoped || 'no-open-blockers'],
    });
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
 *
 * ⚠️ The refusal now fires only on a RUNAWAY (a query that never shrinks past
 * 200k rows), not on ordinary board growth — every sub-query is read in full
 * by `pagedRows`. #1121: the old note here said "today's board is ~a third of
 * [LIMIT_CEILING]", which stayed true about that ceiling while five per-query
 * `limit: 1000` caps quietly became the binding ones. A reassuring, accurate
 * sentence about the NEIGHBOURING limit is what kept anyone from checking the
 * one that mattered.
 */
const PAGE = 1000;

/**
 * Read EVERY row of a sub-query, a page at a time.
 *
 * ⚠️ #1121 — WHY NONE OF THESE MAY BE A SINGLE CAPPED CALL. A `{ limit: N }`
 * call sets `truncated` the moment the result reaches N, and the refusal
 * below then takes the WHOLE queue down. That is not hypothetical: on
 * 2026-09-01 the board grew past 1000 cards, `readyFactsQuery` hit its 1000
 * cap, and every call to /api/ready — including `explain` for one card —
 * refused. The cap was reachable by the single most common action on the
 * system (filing a card), it could not self-heal, and there was no signal on
 * the way up: the bound could say `ok` or `REFUSED` and nothing in between.
 *
 * ⭐ Paged rather than ceiling-raised, which is what #816 already chose for
 * the context query and is now simply applied to all of them: raising a
 * number buys headroom until the board grows into it again, and picks a new
 * number nobody can justify. graph-replica's LIMIT_CEILING still protects
 * every other caller; these are the queries that legitimately outgrow it.
 *
 * ⚠️ `readyFactsQuery` has NO column filter — done cards count toward the
 * bound too, so archiving work does not relieve it. Measured same-moment on
 * the live board: 1005 solutions = COUNT(DISTINCT ?card) = /api/cards, one
 * row per card. Reason about SOLUTIONS regardless: a future OPTIONAL that
 * matches twice would multiply rows without changing the card count.
 *
 * The runaway guard survives: a query that never shrinks refuses rather than
 * looping forever.
 */
function pagedRows(store, query) {
  const out = { rows: [], truncated: false };
  for (let offset = 0; ; offset += PAGE) {
    const page = queryGraph(store, `${query} LIMIT ${PAGE} OFFSET ${offset}`, { limit: PAGE });
    out.rows.push(...page.rows);
    if (page.rows.length < PAGE) break;
    // A board large enough to need more pages than this is a different problem;
    // refusing beats looping forever on a query that never shrinks.
    if (offset > 200_000) { out.truncated = true; break; }
  }
  return out;
}

export function readyFromStore(store) {
  const facts = pagedRows(store, readyFactsQuery());
  const blockers = pagedRows(store, readyBlockersQuery());
  const superseded = pagedRows(store, readySupersededQuery());
  // #965 — one row per human blocker. Read in full and refused only on a
  // runaway, for the same reason as the others: a queue computed from part of
  // the blocker set would silently offer gated work.
  const humanBlockers = pagedRows(store, readyHumanBlockersQuery());
  // ⚠️ #816 — this query returns ONE ROW PER EDGE, not per card. The board
  // carries ~1,545 relationship members against graph-replica's LIMIT_CEILING
  // of 1,000, so a single capped call truncates. Found by running against the
  // live board; a fixture with ten edges cannot reach it.
  const context = pagedRows(store, readyContextQuery());
  // #1041 — fetched BEFORE the truncation refusal so it can be included in it.
  // A queue computed from PART of the condition-blocker set would mistake an
  // UNREAD scoping for an ABSENT one, and offer a card it should have withheld —
  // the false-PASS direction, which is the one that costs.
  const conditionBlockers = pagedRows(store, readyConditionBlockersQuery());
  if (facts.truncated || blockers.truncated || superseded.truncated
      || humanBlockers.truncated || context.truncated || conditionBlockers.truncated) {
    const err = new Error('board exceeds the ready computation bound; refusing a partial queue');
    err.code = 'READY_TRUNCATED';
    throw err;
  }
  return computeReady(
    facts.rows, blockers.rows, superseded.rows, context.rows,
    humanBlockers.rows, conditionBlockers.rows,
  );
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
