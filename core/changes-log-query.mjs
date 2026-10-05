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

/** #1574 C4 — a log conversation row whose post the graph now holds as a tombstone keeps its place, not its text. */
function withoutRedactedText(row, redacted) {
  if (!redacted || row.kind !== 'conversation' || !redacted.has(row.id)) return row;
  return { ...row, title: null, redacted: true };
}

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
    // #1561 rollback — a row reverse-exported from the graph executor says so and
    // carries its receipt (original actor IRI, original time `at`, commitSeq). Present
    // only on those rows, so every other row is byte-identical to before.
    ...(ev.reverseExport ? { reverseExport: ev.reverseExport } : {}),
    // #1217 — a REFUSED row carries what was refused and why. This is the
    // recovery surface: a seat whose harness dropped the 409 asks
    // changes_since(actor: me, history: true) and gets the body back. Present
    // only on refused rows so every other row is byte-identical to before.
    ...(ev.op === 'refused' ? {
      reason: ev.reason ?? null, status: ev.status ?? null,
      route: ev.route ?? null, request: ev.request ?? null,
      response: ev.response ?? null, rule: ev.rule ?? null,
    } : {}),
  };
}

// ── #1575 — executor cursors carry the EPOCH ─────────────────────────────────
//
// A restore promotion (#1559) bumps the epoch and KEEPS commitSeq where the restore had
// it, so the new epoch hands out commitSeqs the lost store had already used. A cursor
// that holds only a commitSeq resumes past them and silently skips them. So every
// executor cursor names its epoch, and a cursor from another epoch is REFUSED — never
// silently answered, never silently reset (to head or to 0). A cursor with no epoch
// (made before #1575) is epoch 1: the only epoch that existed before promotion support.
//
// The RESYNC baseline (what the refusal offers; the caller must take it explicitly):
//   cursor from the epoch the store was promoted FROM (epoch − 1), and the store records
//   where the promotion happened (`ex:epochBase`, executor.py --promote-epoch):
//       min(cursor commitSeq, epochBase)            baseline 'promotion' / 'cursor'
//     every row ≤ epochBase is common to the lost store and this one (the restore is a
//     copy up to there), every row above it was written on THIS epoch — so the resync
//     serves each new-epoch row exactly once and replays nothing restored.
//   anything else (an older epoch, a newer one, a promotion with no recorded base):
//       0                                            baseline 'replay-all'
//     every live row of this store again; dedup by graph.opId.
// What NO resync can give back: rows the cursor was served on the lost store above
// epochBase. They are gone with that store; the refusal says so.
export const LEGACY_EPOCH = 1;
export const EPOCH_CHANGED = 'CURSOR_EPOCH_CHANGED';

// ── #1577 — and the store's INCARNATION ──────────────────────────────────────
//
// `--promote-epoch` sets epoch = restored epoch + 1, so two DIFFERENT restores of backups from
// one epoch both become epoch 2 with different histories, and an epoch-only compare answers a
// cursor from one with the other's reused commitSeqs. So the marker carries `ex:incarnation`
// (a random UUID minted at --create, RE-minted at every --promote-epoch, kept across ordinary
// restarts; executor.py) and `ex:incarnationFrom` (the incarnation promoted from), and every
// executor cursor carries the WHOLE UUID (32 hex digits, dashes dropped). a reviewer (15:59Z): a
// prefix weakens the identity guarantee for nothing, and a per-presentation odds figure is not
// the collision probability across many incarnations. With the full uuid4 (122 random bits) two
// incarnations of one dataset coincide with probability ~n²/2^123, negligible for any real n.
//
// THE COMPARE (storeIdentityMismatch; the store's identity comes from the same snapshot as the rows):
//   cursor WITH an incarnation      answered iff incarnation AND epoch both equal the store's.
//   cursor WITHOUT one (chg1, chg2, a lane with no graph_incarnation — made before #1577)
//                                   answered iff the store was NEVER promoted (epoch 1, no
//                                   epochBase): the only store such a cursor can have come from
//                                   without a promotion in between. Otherwise refused.
//   refusal                         CURSOR_EPOCH_CHANGED (the same code and remedy as #1575: a
//                                   client already handles it), `reason` epoch | incarnation | legacy.
// THE BASELINE: exact (#1575's min(cursor, epochBase)) ONLY when the cursor's incarnation is the
// one this store was promoted FROM (and its epoch is epoch − 1). A sibling restore, a legacy
// cursor (it cannot prove its lineage), anything else: replay-all from 0. Never "now".
// A caller that passes NO store incarnation (a pure caller of the #1575 shape) gets #1575's
// epoch-only rule; the server never does — logborn-feed refuses a marker without one.
export const INCARNATION_TAG = /^[0-9a-f]{32}$/;   // a reviewer 15:59Z: the FULL uuid4, never a prefix
export const incarnationTag = (u) => (u == null ? null : String(u).replace(/-/g, '').toLowerCase());
const knowsIncarnation = (incarnation) => typeof incarnation === 'string';

/** null when the cursor may be answered by this store; else why not ('epoch' | 'incarnation' | 'legacy'). */
export function storeIdentityMismatch({ cursorEpoch, cursorIncarnation = null, epoch, epochBase = null, incarnation }) {
  if (!knowsIncarnation(incarnation)) return cursorEpoch !== epoch ? 'epoch' : null;
  if (cursorIncarnation == null) {
    const neverPromoted = epoch === LEGACY_EPOCH && !Number.isSafeInteger(epochBase);
    return neverPromoted && cursorEpoch === epoch ? null : 'legacy';
  }
  if (cursorIncarnation !== incarnation) return 'incarnation';
  return cursorEpoch !== epoch ? 'epoch' : null;
}

export function epochResyncBaseline({ cursorEpoch, cursorIncarnation = null, cursorCommitSeq, epoch, epochBase, incarnation, incarnationFrom = null }) {
  const lineage = !knowsIncarnation(incarnation) || (cursorIncarnation != null && cursorIncarnation === incarnationFrom);
  if (lineage && cursorEpoch === epoch - 1 && Number.isSafeInteger(epochBase) && Number.isSafeInteger(cursorCommitSeq)) {
    return cursorCommitSeq < epochBase
      ? { commit_seq: cursorCommitSeq, baseline: 'cursor' }
      : { commit_seq: epochBase, baseline: 'promotion' };
  }
  return { commit_seq: 0, baseline: 'replay-all' };
}

/** The visible refusal (CURSOR_TOO_OLD's shape: a code, resync: true, and what to do). */
export function epochChangedError({ cursorEpoch, cursorIncarnation = null, cursorCommitSeq, epoch, epochBase, incarnation, incarnationFrom = null, what, reason = null }) {
  const baseline = epochResyncBaseline({ cursorEpoch, cursorIncarnation, cursorCommitSeq, epoch, epochBase, incarnation, incarnationFrom });
  const why = reason ?? storeIdentityMismatch({ cursorEpoch, cursorIncarnation, epoch, epochBase, incarnation }) ?? 'epoch';
  const read = why === 'epoch'
    ? `${what} was read in executor epoch ${cursorEpoch}; the executor is now in epoch ${epoch} (a restore was promoted). `
    : why === 'incarnation'
      ? `${what} was read from executor incarnation ${cursorIncarnation} (epoch ${cursorEpoch}); this store is incarnation ${incarnation} (epoch ${epoch}) — a different restore or promotion of the same dataset. `
      : `${what} names no executor incarnation (made before #1577) and this store has been promoted (epoch ${epoch}), so it cannot be shown to come from this store. `;
  const err = new Error(read
    + 'commitSeqs are reused across promotions, so resuming this cursor would silently skip '
    + `new writes. Resync from executor commitSeq ${baseline.commit_seq} of epoch ${epoch} (${baseline.baseline}): `
    + 'every row written on this store is then served. Rows you were served on the lost store '
    + `${baseline.baseline === 'replay-all' ? '' : `past commitSeq ${baseline.commit_seq} `}may no longer exist — `
    + 're-read memories / decisions / seat state from the live store.');
  err.code = EPOCH_CHANGED;
  err.resync = true;
  err.reason = why;
  err.epoch = epoch;
  err.cursor_epoch = cursorEpoch;
  if (knowsIncarnation(incarnation)) { err.incarnation = incarnation; err.cursor_incarnation = cursorIncarnation; }
  err.baseline = baseline;
  return err;
}

// ── #1561 — two sources, two cursors ─────────────────────────────────────────
//
// With SCRUM_GRAPH_UNIT_LOGBORN=1 memory / decision / seat-state writes live in the
// graph executor, not the event log (core/logborn-feed.mjs turns its APPLIED receipts
// into rows). The log's `seq` and the executor's `commitSeq` are two independent
// sequences and their timestamps come from two clocks, so:
//
//   ORDER   is PRESENTATION only: each source keeps its own sequence order exactly,
//           and the two are merged by timestamp (tie → the log row first). A merge of
//           two ordered lists never reorders either list, and a prefix of the merge is
//           the merge of the prefixes — which is what makes the page cursor exact.
//   CURSORS track each source SEPARATELY, never by time:
//     forward   `cursor` = chg1.<log seq>.<commitSeq>: the high-water of BOTH sources
//               at read time. Passed back as `since`, it returns log rows with a higher
//               seq and receipts with a higher commitSeq — so a receipt stamped EARLIER
//               than a log row the client already saw, but committed after the read,
//               is still delivered. An ISO `since` keeps its meaning (a time window).
//     backward  `nextBefore` = chgb1.<cards-log seq>.<posts-log seq>.<commitSeq>: one
//               bound per (quota bucket, source), each "strictly older than the oldest
//               row this page showed from it". Passed as `before`. A numeric `before`
//               keeps its meaning: everything presented before that log row.
//   Both tokens are OPAQUE to callers; their spelling is not a contract.
//   #1575 — both carry the executor EPOCH their commitSeq belongs to: chg2.<log>.<epoch>.<commitSeq>
//   and chgb2.<cards>.<posts>.<epoch>.<commitSeq>. A v1 token (no epoch) is epoch 1.
//   #1577 — and the store's INCARNATION tag: chg3.<log>.<inc>.<epoch>.<commitSeq> and
//   chgb3.<cards>.<posts>.<inc>.<epoch>.<commitSeq>. v1 / v2 tokens carry none (the legacy rule).
//   A token is minted v2 only when no incarnation is known (no executor source was read).

const FWD1 = /^chg1\.(\d+)\.(\d+)$/;
const FWD2 = /^chg2\.(\d+)\.(\d+)\.(\d+)$/;
const BACK1 = /^chgb1\.(\d+)\.(\d+)\.(\d+)$/;
const BACK2 = /^chgb2\.(\d+)\.(\d+)\.(\d+)\.(\d+)$/;
const FWD3 = /^chg3\.(\d+)\.([0-9a-f]{32})\.(\d+)\.(\d+)$/;
const BACK3 = /^chgb3\.(\d+)\.(\d+)\.([0-9a-f]{32})\.(\d+)\.(\d+)$/;
// #1574 — graph posts page in the posts bucket, so a backward token needs a graph position PER BUCKET
const BACK4 = /^chgb4\.(\d+)\.(\d+)\.([0-9a-f]{32})\.(\d+)\.(\d+)\.(\d+)$/;
/** `since` → a time window, or the forward cursor's positions (log seq; executor epoch + commitSeq). */
export function parseSince(since) {
  const s = String(since ?? '');
  let m = FWD3.exec(s);
  if (m) return { cursor: true, log: Number(m[1]), incarnation: m[2], epoch: Number(m[3]), graph: Number(m[4]) };
  m = FWD2.exec(s);
  if (m) return { cursor: true, log: Number(m[1]), incarnation: null, epoch: Number(m[2]), graph: Number(m[3]) };
  m = FWD1.exec(s);
  if (m) return { cursor: true, log: Number(m[1]), incarnation: null, epoch: LEGACY_EPOCH, graph: Number(m[2]) };
  if (TOKEN_SHAPED.test(s)) throw unknownCursor(s);   // never read a broken token as an ISO window
  return { cursor: false, since };
}
// #1577 — a value that LOOKS like one of our tokens but parses as none of them (a truncated
// incarnation, a typo, an unknown version) is REFUSED with the existing UNKNOWN_CURSOR (400).
// Falling through to "an ISO time" answered it silently with whatever that comparison happened to give.
const TOKEN_SHAPED = /^chgb?\d/;
function unknownCursor(s) {
  return Object.assign(new Error(`unknown cursor ${JSON.stringify(String(s).slice(0, 80))}: not a cursor this board issued (chg1/chg2/chg3 forward, chgb1/chgb2/chgb3/chgb4 backward)`), { code: 'UNKNOWN_CURSOR' });
}
function parseBefore(before) {
  const s = String(before);
  let m = BACK4.exec(s);
  if (m) return { cardsLog: Number(m[1]), postsLog: Number(m[2]), incarnation: m[3], epoch: Number(m[4]), graph: Number(m[5]), graphPosts: Number(m[6]) };
  m = BACK3.exec(s);
  if (m) return { cardsLog: Number(m[1]), postsLog: Number(m[2]), incarnation: m[3], epoch: Number(m[4]), graph: Number(m[5]) };
  m = BACK2.exec(s);
  if (m) return { cardsLog: Number(m[1]), postsLog: Number(m[2]), incarnation: null, epoch: Number(m[3]), graph: Number(m[4]) };
  m = BACK1.exec(s);
  if (m) return { cardsLog: Number(m[1]), postsLog: Number(m[2]), incarnation: null, epoch: LEGACY_EPOCH, graph: Number(m[3]) };
  if (TOKEN_SHAPED.test(s)) throw unknownCursor(s);
  return null;
}
export const forwardCursor = (log, epoch, graph, incarnation = null) => (incarnation
  ? `chg3.${log}.${incarnation}.${epoch}.${graph}` : `chg2.${log}.${epoch}.${graph}`);
const backCursor = (b) => (b.incarnation && b.graphPosts != null && b.graphPosts !== b.graph
  ? `chgb4.${b.cardsLog}.${b.postsLog}.${b.incarnation}.${b.epoch}.${b.graph}.${b.graphPosts}`
  : b.incarnation
    ? `chgb3.${b.cardsLog}.${b.postsLog}.${b.incarnation}.${b.epoch}.${b.graph}` : `chgb2.${b.cardsLog}.${b.postsLog}.${b.epoch}.${b.graph}`);

const itemBucket = (it) => (it.src === 'graph' ? (it.row.kind === 'conversation' ? 'posts' : 'cards') : bucketOf(it.ev));   // #1574 — a graph post is a post
const itemAt = (it) => (it.src === 'graph' ? it.row.at : it.ev.recorded_at);
const itemPos = (it) => (it.src === 'graph' ? it.row.graph.commitSeq : it.ev.seq);

/** Two lists, each in its own sequence order → one presentation order. Never reorders either list. */
export function mergeSources(logItems, graphItems) {
  const out = [];
  let i = 0, j = 0;
  while (i < logItems.length || j < graphItems.length) {
    if (j >= graphItems.length) out.push(logItems[i++]);
    else if (i >= logItems.length) out.push(graphItems[j++]);
    else if (itemAt(graphItems[j]) < itemAt(logItems[i])) out.push(graphItems[j++]);
    else out.push(logItems[i++]);   // tie → the log row first
  }
  return out;
}

/**
 * @param {Array} events  parsed log events, seq-ascending (readEvents order)
 * @param {object} opts   { since (ISO, or a forward cursor), oldestRetained, limit:{cards,posts},
 *                          history, entity (shortId), actor, before (seq, or a page token),
 *                          graphRows (core/logborn-feed.mjs rows; null = no graph source),
 *                          logThrough / graphThrough (each source's high-water at read time),
 *                          oldestRetainedSeq }
 */
export function queryChangesFromLog(events, {
  since, oldestRetained, limit, history = false, entity, actor, before,
  graphRows = null, logThrough = null, graphThrough = null, oldestRetainedSeq = null,
  graphEpoch = null, graphEpochBase = null, graphIncarnation = null, graphIncarnationFrom = null,
  redactedPostIds = null,   // #1574 C4 — posts the graph holds as tombstones: a LOG row naming one is served without its text
} = {}) {
  if (since == null || since === '') {
    const err = new Error('since is required (ISO timestamp, or the `cursor` of a previous reply): a changes query without a cutoff is an unbounded read');
    err.code = 'MISSING_SINCE';
    throw err;
  }
  const from = parseSince(since);
  if (!from.cursor && typeof oldestRetained === 'string' && since < oldestRetained) {
    const err = new Error(`since ${since} predates the log's retention (oldest: ${oldestRetained}) — `
      + 'a reply from here would be silently partial. Resync from the live store '
      + `(card_list / conversation_list), then ask since(${oldestRetained}) or later.`);
    err.code = 'CURSOR_TOO_OLD';
    err.oldest_retained = oldestRetained;
    err.resync = true;
    throw err;
  }
  if (from.cursor && Number.isInteger(oldestRetainedSeq) && oldestRetainedSeq > from.log + 1) {
    const err = new Error(`cursor is older than the log's retention (events after seq ${from.log} are no longer held) — `
      + 'a reply from here would be silently partial. Resync from the live store, then ask again.');
    err.code = 'CURSOR_TOO_OLD';
    err.oldest_retained = oldestRetained ?? null;
    err.resync = true;
    throw err;
  }

  // #1575 — a cursor from another executor epoch is REFUSED (only when the executor is
  // actually read: with no graph source its commitSeq is never compared). The refusal
  // carries a resync cursor: the log half UNCHANGED (the event log was not restored) and
  // the executor half at the stated baseline of the CURRENT epoch. Never applied silently.
  const epoch = graphRows != null && Number.isSafeInteger(graphEpoch) ? graphEpoch : null;
  // #1577 — the store's identity: epoch + incarnation (+ where and from what it was promoted)
  const store = { epoch, epochBase: graphEpochBase, incarnation: epoch != null ? graphIncarnation : null, incarnationFrom: graphIncarnationFrom };
  const refuse = (tok, what) => {
    const reason = storeIdentityMismatch({ cursorEpoch: tok.epoch, cursorIncarnation: tok.incarnation, ...store });
    return reason && epochChangedError({ cursorEpoch: tok.epoch, cursorIncarnation: tok.incarnation, cursorCommitSeq: tok.graph, ...store, what, reason });
  };
  if (epoch != null && from.cursor) {
    const err = refuse(from, 'this cursor');
    if (err) {
      err.resync_cursor = forwardCursor(from.log, epoch, err.baseline.commit_seq, store.incarnation);
      throw err;
    }
  }
  const backTok = before != null && before !== '' ? parseBefore(before) : null;
  if (epoch != null && backTok) {
    const err = refuse(backTok, 'this page token');
    if (err) {
      err.resync_cursor = null;   // a page of an old window: start the window again (no `before`)
      throw err;
    }
  }

  const quota = {
    cards: Math.min(Number(limit?.cards ?? DEFAULT_QUOTA.cards), QUOTA_CEILING),
    posts: Math.min(Number(limit?.posts ?? DEFAULT_QUOTA.posts), QUOTA_CEILING),
  };

  let logEvs = from.cursor
    ? events.filter((ev) => ev.seq > from.log)
    : events.filter((ev) => typeof ev.recorded_at === 'string' && ev.recorded_at >= since);
  // #1561 ROLLBACK — a forward cursor minted while the unit was ON says the caller has
  // seen every executor receipt up to `from.graph`. With the graph source gone (flag
  // OFF), those writes now live in the log as reverse-exported events carrying their
  // commitSeq: the ones at or below the cursor's graph half were already delivered, so
  // they are skipped — the cursor is TRANSLATED, never a row served twice.
  if (from.cursor && graphRows == null && from.graph > 0) {
    // (integration: only a row exported from the SAME executor epoch the cursor was read in is covered by it;
    // a reverse-export that predates epoch recording counts as the legacy epoch, like an unversioned token)
    // #1561 lanes (a reviewer's pin) — and when the cursor carries an INCARNATION (chg3), only an
    // export recording that SAME incarnation is covered: two promoted restores share an epoch. An
    // export without one (a rollback made before the marker carried it) is NOT skipped — served
    // again, marked `reverseExport`: duplicates possible, never a skip. A cursor WITHOUT an
    // incarnation (chg1 / chg2, made before #1577) translates NOTHING (a reviewer 16:38Z): epoch alone
    // cannot identify a store across restores, so every export is served again, marked.
    logEvs = logEvs.filter((ev) => !(ev.reverseExport && from.incarnation != null
      && ev.reverseExport.commitSeq <= from.graph
      && Number(ev.reverseExport.epoch ?? LEGACY_EPOCH) === from.epoch
      && ev.reverseExport.incarnation === from.incarnation));
  }
  // #1574 — does the graph source carry posts at all (the conversations unit)? Decided on the WHOLE source, never on one
  // page's leftovers, so a backward walk keeps one meaning for its token from the first page to the last.
  const graphHasPosts = (graphRows || []).some((r) => r.kind === 'conversation');
  let gRows = (graphRows || []).filter((r) => (from.cursor ? r.graph.commitSeq > from.graph : r.at >= since));
  if (entity != null) { logEvs = logEvs.filter((ev) => ev.entity?.shortId === Number(entity)); gRows = gRows.filter((r) => r.shortId === Number(entity)); }
  if (actor != null) { logEvs = logEvs.filter((ev) => ev.actor === actor); gRows = gRows.filter((r) => r.by === actor); }
  gRows = [...gRows].sort((a, b) => a.graph.commitSeq - b.graph.commitSeq);

  let rows = mergeSources(logEvs.map((ev) => ({ src: 'log', ev })), gRows.map((row) => ({ src: 'graph', row })));

  // each (bucket, source) bound this page started from: the next page's default
  const maxOf = (xs) => xs.reduce((m, x) => (x > m ? x : m), 0);   // not Math.max(...xs): a long log overflows the call stack
  const lt = Number.isInteger(logThrough) ? logThrough : maxOf(events.map((e) => e.seq));
  const gt = Number.isInteger(graphThrough) ? graphThrough : maxOf(gRows.map((r) => r.graph.commitSeq));
  // the epoch the tokens below name: the executor's when it was read, else the caller's
  const outEpoch = epoch ?? backTok?.epoch ?? (from.cursor ? from.epoch : LEGACY_EPOCH);
  const outInc = epoch != null ? store.incarnation : (backTok ? backTok.incarnation : (from.cursor ? from.incarnation : null));   // #1577
  let bound = { cardsLog: lt + 1, postsLog: lt + 1, graph: gt + 1, graphPosts: gt + 1, epoch: outEpoch, incarnation: outInc };
  if (before != null && before !== '') {
    const tok = backTok;
    if (tok) {
      bound = { cardsLog: tok.cardsLog, postsLog: tok.postsLog, graph: tok.graph, graphPosts: tok.graphPosts ?? tok.graph, epoch: outEpoch, incarnation: outInc };
      // #1561 ROLLBACK — a page token whose graph half is past 1 was minted with the
      // executor as a source (a flag-OFF reply always mints graph 1). With that source
      // gone, the rows it bounded now sit in the log at seqs NEWER than the token's log
      // bounds, so paging on would silently skip them. Refused, visibly: start over.
      if (graphRows == null && bound.graph > 1) {
        const err = new Error('this page token was minted while memory / decision / seat-state writes were read from the graph executor; '
          + 'that source has been rolled back into the event log, so the token can no longer bound this page. Ask again without `before` (resync).');
        err.code = 'CURSOR_RESET';
        err.resync = true;
        throw err;
      }
      rows = rows.filter((it) => itemPos(it) < (it.src === 'graph' ? (itemBucket(it) === 'posts' ? bound.graphPosts : bound.graph) : itemBucket(it) === 'posts' ? bound.postsLog : bound.cardsLog));
    } else {
      const cursor = Number(before);
      const at = rows.findIndex((it) => it.src === 'log' && it.ev.seq === cursor);
      if (at < 0) {
        const err = new Error(`unknown cursor seq ${before}: refusing to silently serve page one`);
        err.code = 'UNKNOWN_CURSOR';
        throw err;
      }
      rows = rows.slice(0, at);   // with no graph rows this is exactly `seq < cursor`
    }
  }

  // R3 — latest-event-per-entity default, applied to card-side kinds only
  // (posts are one event each by construction). The log keeps everything;
  // this is purely about what the default projection hands back.
  if (!history) {
    const latest = new Map();
    const kept = new Set();
    for (const it of rows) {
      if (itemBucket(it) !== 'cards') { kept.add(it); continue; }
      // #1217 — a refusal is NOT a state of the entity, so it must neither
      // become "the latest thing that happened to card N" (hiding the real last
      // write) nor be hidden by it (the refusal is the row the seat is looking
      // for). It rides along as its own row, outside the last-write-wins map.
      if (it.src === 'log' && it.ev.op === 'refused') { kept.add(it); continue; }
      const key = it.src === 'log' ? `${it.ev.entity?.kind}|${it.ev.entity?.id}` : `${it.row.kind}|${it.row.id}`;
      latest.set(key, it); // rows are in presentation order: last write wins
    }
    const latestSet = new Set(latest.values());
    rows = rows.filter((it) => kept.has(it) || latestSet.has(it));
  }

  const buckets = { cards: [], posts: [] };
  for (const it of rows) buckets[itemBucket(it)].push(it);
  const totals = { cards: buckets.cards.length, posts: buckets.posts.length };

  // Newest tail per kind (the page a returning seat wants), re-merged into
  // one ordered list — the interleaving IS the deliverable (R1).
  const cut = {
    cards: buckets.cards.slice(-quota.cards),
    posts: buckets.posts.slice(-quota.posts),
  };
  const truncated = {
    cards: totals.cards > cut.cards.length,
    posts: totals.posts > cut.posts.length,
  };
  const inPage = new Set([...cut.cards, ...cut.posts]);
  const merged = rows.filter((it) => inPage.has(it));

  const minPos = (list, src, dflt) => list.filter((it) => it.src === src).map(itemPos).reduce((m, x) => (x < m ? x : m), dflt);
  const nextBefore = (truncated.cards || truncated.posts) ? backCursor({
    cardsLog: minPos(cut.cards, 'log', bound.cardsLog),
    postsLog: minPos(cut.posts, 'log', bound.postsLog),
    graph: minPos(cut.cards, 'graph', bound.graph),
    // #1574 — each bucket's graph prefix advances on its own, but only when graph POSTS are in this window at all; with
    // none, the posts bucket has no graph prefix to keep and the token stays the chgb3 every older caller expects.
    graphPosts: graphHasPosts ? minPos(cut.posts, 'graph', bound.graphPosts) : minPos(cut.cards, 'graph', bound.graph),
    epoch: outEpoch,
    incarnation: outInc,
  }) : null;

  return {
    changes: merged.map((it) => (it.src === 'graph' ? it.row : withoutRedactedText(toRow(it.ev), redactedPostIds))),
    window: { since },
    newest: merged.length ? itemAt(merged.at(-1)) : null,
    oldest: merged.length ? itemAt(merged[0]) : null,
    totals,
    returned: merged.length,
    truncated,
    history,
    covers: { posts: 'exact', cards: 'creates+updates+deletes' },
    // #675 CLOSED: PATCH/DELETE now carry a declared `by` — the capability
    // exists, so the omission ledger is empty. Historical nulls (and silent
    // callers) are DATA — "unsaid" — not an omission of the surface.
    omits: { cards: [] },
    // #1561 — resume here (as `since`) to get every row committed after this read,
    // from both sources; page older rows of THIS window with `before: nextBefore`.
    cursor: forwardCursor(lt, outEpoch, from.cursor && graphRows == null ? from.graph : gt, outInc),
    nextBefore,
  };
}
