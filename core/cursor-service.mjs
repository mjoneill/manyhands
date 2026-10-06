/**
 * core/cursor-service.mjs — #683 slice 3b: binding the cursors to the log.
 *
 * Slice 3a shipped `core/cursors.mjs` — correct, tested, and imported by
 * NOTHING for six days, while the room spent an evening diagnosing the exact
 * deafness it cures. This module is the wiring, and it is deliberately the only
 * place that knows both the event log and a seat's delivery identity.
 *
 * ── WHAT A CURSOR IS KEYED ON, and why it took three seats to settle ───────
 *
 * The board has TWO identity maps and they are DISJOINT — measured, not assumed:
 *
 *     #410 registry (scrum/session/register)   #703 binding (bearer token)
 *       92  minimo.sb                            7151  healthcheck
 *       89  minimo.cs                              15  wren
 *        1  probe-timing                           10  indigo
 *
 * Keying on the bearer seat gives @minimo — the seat this whole slice exists
 * for — nothing, because her client cannot send a token until #779. Keying on
 * the registry id gives @wren and @indigo nothing, because neither has ever
 * registered. Either choice alone silently covers half a room.
 *
 * So a cursor is keyed on the DELIVERY LANE, which names itself in precedence
 * order: a declared registry id first, a proven bearer seat second, and nothing
 * third — an anonymous stream gets no cursor, because there is nothing durable
 * to resume it by and inventing a key would pin retention forever.
 *
 * ⚠️ REGISTRY FIRST IS THE LOAD-BEARING HALF, and it is not an ordering
 * preference. When #779 gives @minimo's client a bearer token, her lane names
 * do not change — so her cursors survive. The other precedence would re-key
 * every cursor she owns on the day we make her visible: an outage caused by
 * fixing observability.
 *
 * ⚠️ AND THE COST, stated because it is real: the registry id is CLIENT-SUPPLIED
 * and unauthenticated (`core/seat-registry.mjs`: "author is client-supplied;
 * auth is deferred"). We are keying durable state on a declaration. The fence
 * below is what makes that acceptable rather than merely tolerated, and the
 * #779 upgrade path is to cross-check a declared id against the token that may
 * claim it — which makes #779 an upgrade to this slice rather than a
 * prerequisite for it.
 *
 * ── THE FENCE: why `serveFor` returns a `commit` you have to call ──────────
 *
 * Two sessions can hold one lane name. The registry's own log cannot tell a
 * reconnect from a duplicate config — it says so out loud: "(reconnect or
 * DUPLICATE config?)". Under one shared cursor, session A acking would mark
 * events delivered that session B never received: #624 exactly, arriving
 * through the key of the thing built to cure it, and silent, because a cursor's
 * whole job is to assert delivery.
 *
 * So a serve records WHO it was served to (`served_via`), and an ack from
 * anyone else does not advance the cursor — it is refused (ACK_FENCED) and the
 * range is served again. At-least-once holds, which is the contract.
 *
 * ── #1576: THE ACK IS EXPLICIT ────────────────────────────────────────────
 *
 * ONLY an explicit client ack advances `acked` / `graph_acked`: `ackFor`, reached
 * by POST /api/cursors/ack with the `ack_token` a pull returned. A pull records
 * `served` (what it put on the wire) and nothing else; neither the response's
 * `res.end` callback (Node 22 fires it for a socket the client destroyed
 * mid-body) nor the lane's next inbound call is delivery evidence. An ack is
 * clamped: never backward, never past what was served to that lane, never from
 * another lane, session, executor epoch or incarnation — each refused visibly.
 * A lane that never acks is re-served the same page (at-least-once).
 *
 * `via` is whatever uniquely names the serving connection: the registry epoch
 * for a registered lane, the MCP session id for a bearer lane. A bearer seat
 * with two live sessions has the same hazard and gets the same protection.
 */

import { readEvents, nextSeq, oldestEvent } from './event-log.mjs';
import { mergeSources, epochChangedError, storeIdentityMismatch, incarnationTag, EPOCH_CHANGED, LEGACY_EPOCH } from './changes-log-query.mjs';
import {
  loadCursors, saveCursors, registerSeat, recordServed, recordInbound,
  reachability, REACHABLE,
} from './cursors.mjs';

/** How many events one pull may carry. Bounded: a replay is not a history dump. */
export const PULL_LIMIT = 200;

const KINDS = Object.freeze({ registry: 'registry', bearer: 'bearer' });

const clean = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * The cursor key for a connection, or null if it has no durable identity.
 *
 * Namespaced on purpose: the two identity spaces have no authority keeping
 * their vocabularies apart, and the registry already accepts arbitrary strings
 * from client config (`probe-timing` registered on 2026-08-11). Unprefixed, a
 * registered endpoint named `wren` would silently share one cursor with the
 * bearer seat `wren` — two lanes robbing each other with no error anywhere.
 */
export function deliveryIdentity({ registrySeatId = null, bearerSeat = null } = {}) {
  const reg = clean(registrySeatId);
  if (reg) return { key: `${KINDS.registry}:${reg}`, kind: KINDS.registry, id: reg };
  const bearer = clean(bearerSeat);
  if (bearer) return { key: `${KINDS.bearer}:${bearer}`, kind: KINDS.bearer, id: bearer };
  return null;
}

/** The highest seq the log has assigned. `nextSeq` is the NEXT one to hand out. */
export function headSeq(eventDir) {
  return nextSeq(eventDir) - 1;
}

/**
 * What this lane is owed, computed server-side so the client compares nothing.
 *
 * The room's ruling on the card's open staleness question: the asymmetry is not
 * "who decides", it is "who computes". A client acting on these fields is
 * following an instruction, not holding policy — so the no-smart-clients
 * contract survives. `oldest_unserved_at` is the AGE signal, and it is the one
 * a future enforcement card keys on: age catches a three-day-stale harness,
 * while divergence (`served != head`) fires constantly on a healthy room.
 */
export function envelopeFor(eventDir, key, { state = null, head = null, graph = null } = {}) {
  const st = state || loadCursors(eventDir);
  const h = head == null ? headSeq(eventDir) : head;
  const s = st.seats[key];
  const base = {
    delivery_identity: key,
    head_seq: h,
    dedup: graph
      ? 'by seq for log events, by graph.opId for executor rows (seq null) — delivery is at-least-once; '
        + 'a seat may see an event twice, never zero times'
      : 'by seq — delivery is at-least-once; a seat may see an event twice, never zero times',
  };
  // ⚠️ An unknown lane reports UNKNOWN, not zero. A confident zero for a
  // question we cannot answer is the defect class this board catalogued on
  // 2026-08-10 (#776/#777/#778) — an endpoint answering what it did not
  // understand, in the shape of success.
  if (!s) {
    return {
      ...base, known: false, last_acked_seq: null, last_served_seq: null,
      lag: null, oldest_unserved_at: null,
    };
  }
  const logLag = Math.max(0, h - s.acked);
  const gap = retentionGap(eventDir, s.acked);
  // #1571 — with the log-born unit ON the lane is also owed the executor rows past its
  // executor cursor. `graph.rows` is exactly that set (the server read it past
  // graph_acked), so the executor half of `lag` is a ROW count — not `through −
  // graph_acked`, which would count PRECONDITION_FAILED / migration receipts that are
  // never rows and leave a lane permanently "behind".
  const pending = graph ? graphPending(s, graph) : null;
  const lag = logLag + (pending ? pending.length : 0);
  const logOldest = logLag > 0 && !gap
    ? (readEvents(eventDir, { sinceSeq: s.acked, limit: 1 })[0]?.recorded_at ?? null)
    : null;
  const graphOldest = pending && pending.length
    ? pending.map((r) => r.at).reduce((m, x) => (x < m ? x : m))
    : null;
  return {
    ...base,
    known: true,
    last_acked_seq: s.acked,
    last_served_seq: s.served,
    lag,
    ...(graph ? {
      log_lag: logLag,
      graph: {
        head_commit_seq: graph.through,
        ...(Number.isSafeInteger(graph.epoch) ? { epoch: graph.epoch, last_acked_epoch: graphEpochOf(s) } : {}),   // #1575
        ...(typeof graph.incarnation === 'string' ? { incarnation: graph.incarnation, last_acked_incarnation: graphIncarnationOf(s) } : {}),   // #1577
        last_acked_commit_seq: s.graph_acked ?? 0,
        last_served_commit_seq: s.graph_served ?? null,
        lag: pending.length,
      },
    } : {}),
    // ⚠️ THREE STATES, not two, and the third is the reason this is not a bare
    // timestamp. `readEvents(sinceSeq: acked)` returns the oldest SURVIVING
    // event — which, once retention has trimmed the range, is NEWER than the
    // oldest genuinely-unserved one. A badly-stale lane would report as fresher
    // than it is, and this is the field a future age-based staleness guard keys
    // on: it would clear exactly the three-day-stale harness it exists to catch.
    // Failing toward "unknown" is the only safe direction for a freshness
    // signal. (@wren, verifying slice 3b.)
    oldest_unserved_state: lag === 0 ? 'none' : (gap ? 'trimmed' : 'known'),
    oldest_unserved_at: lag > 0 && !gap
      ? ([logOldest, graphOldest].filter(Boolean).reduce((m, x) => (m == null || x < m ? x : m), null))
      : null,
    ...(gap ? { oldest_retained_seq: gap.oldestSeq, oldest_retained_at: gap.oldestAt } : {}),
  };
}

/**
 * Has retention eaten events this lane still needed? Returns the gap or null.
 *
 * The log's earliest surviving seq should be at most `acked + 1`. If it is
 * higher, everything between is gone — and a pull that quietly served "whatever
 * survives" would let the lane ack past events it can never receive. Permanent,
 * silent, and `lag` would read 0 afterwards: #624 exactly, arriving through its
 * own cure. `/api/changes` has refused this since #679; the card says to reuse
 * that shape here and this is where it gets reused.
 */
export function retentionGap(eventDir, acked) {
  const first = oldestEvent(eventDir);   // the same answer, without parsing every segment (see event-log.mjs)
  if (!first || first.seq <= acked + 1) return null;
  return { oldestSeq: first.seq, oldestAt: first.recorded_at ?? null, missingFrom: acked + 1, missingTo: first.seq - 1 };
}

// ── #1571 — the executor half of a lane's cursor ────────────────────────────
//
// With SCRUM_GRAPH_UNIT_LOGBORN=1 memory / decision / seat-state writes live in the
// graph executor and never reach the event log. A lane's cursor therefore holds TWO
// positions, tracked separately and never by time (the #1561 change-feed rule):
//
//   acked / served               the event log's seq           (unchanged)
//   graph_acked / graph_served   the executor's commitSeq      (absent with the flag OFF)
//
// The executor rows are core/logborn-feed.mjs's rows — APPLIED live receipts only —
// read by the SERVER (it owns the executor client) and passed in as `graph:
// { rows, through }`. This module never interprets a receipt.
//
// ⚠️ An ABSENT graph_acked means 0: every live log-born write is owed. That is the
// right answer for a lane that predates the flag — those writes are exactly the ones
// its log cursor can no longer see — and the reason a known lane is never moved to
// the executor head on re-registration.

// #1575 — the executor cursor also names its EPOCH (`graph_epoch`). A restore promotion
// reuses commitSeqs, so a cursor from another epoch is REFUSED by serveFor (CURSOR_EPOCH_CHANGED,
// nothing served, nothing committed, the old cursor PRESERVED) until the lane resyncs
// EXPLICITLY: registerFor(..., { resync: 'epoch' }) — POST /api/cursors/register with
// `resync: "epoch"`. The resync moves the executor cursor to the stated baseline of the
// current epoch (changes-log-query epochResyncBaseline: min(its commitSeq, the store's
// commitSeq at promotion) — never the head, never silently 0), so every row written on the
// new epoch, before or after the resync, is served exactly once. The old position is kept
// in `graph_resynced` (audit). An ABSENT graph_epoch is epoch 1 — the only one before #1559.
export const graphEpochOf = (s) => (Number.isSafeInteger(s?.graph_epoch) ? s.graph_epoch : LEGACY_EPOCH);
// #1577 — and the store INCARNATION tag (`graph_incarnation`): two promoted restores of one backup
// share an epoch. ABSENT (a lane made before #1577) = no incarnation: such a lane is answered only
// by a never-promoted store (changes-log-query storeIdentityMismatch, the legacy rule).
export const graphIncarnationOf = (s) => (typeof s?.graph_incarnation === 'string' ? s.graph_incarnation : null);
/** The lane's executor identity against the store's: null when it may be served, else the refusal. */
function laneIdentityError(s, store, what) {
  const lane = { cursorEpoch: graphEpochOf(s), cursorIncarnation: graphIncarnationOf(s), cursorCommitSeq: s.graph_acked ?? 0 };
  const st = { epoch: store.epoch, epochBase: store.epochBase ?? null, incarnation: store.incarnation, incarnationFrom: store.incarnationFrom ?? null };
  const reason = storeIdentityMismatch({ ...lane, ...st });
  return reason ? epochChangedError({ ...lane, ...st, what, reason }) : null;
}

/** The lane's executor cursor (0 when absent), or null for an unknown lane. */
export function graphAckedOf(eventDir, key) {
  const s = loadCursors(eventDir).seats[key];
  return s ? (s.graph_acked ?? 0) : null;
}

// ── #1561 ROLLBACK — a lane's graph half after the unit is rolled back ──────────────
//
// rollback-logborn-1561 appends every executor-born unit write to the log as a reverse-
// exported event ({reverseExport: {opId, commitSeq, epoch, incarnation, …}}), at seqs
// above every lane's `acked`. With the flag OFF (no graph source) a lane that still holds
// a graph half is TRANSLATED when that can be PROVEN, refused visibly otherwise:
//
//   PROVEN    every reverse-exported event the lane is owed (seq > acked) names the SAME
//             executor incarnation AND epoch as the lane's graph half. Then an export with
//             commitSeq ≤ graph_ACKED was delivered and acked through the graph half and is
//             skipped (counted: envelope.translated_skipped); every other export — served
//             but never acked, or never served — is served. Never translated from
//             graph_served: a serve is not delivery evidence (#1576).
//   UNPROVEN  another epoch or incarnation, an export with no recorded incarnation (a
//             rollback made before the marker carried it), or a lane with no incarnation
//             (made before #1577): CURSOR_ROLLED_BACK, nothing served, lane unchanged.
//             Recovery is explicit: registerFor(..., { resync: 'rollback' }) sets the graph
//             half aside (`graph_rolled_back`) and the log half resumes from its CURRENT
//             `acked` — every export above it is delivered; duplicates possible, never a skip;
//             deduplication by reverseExport.opId is the consumer's (no consumer in this
//             tree performs it).
//   CLEARED   a translating pull records the highest export seq it covered
//             (`graph_rollback_through`); once an explicit ack moves `acked` past it, the
//             graph half is cleared (`graph_reconciled` kept for audit) and later pulls are
//             plain log pulls.
export const CURSOR_ROLLED_BACK = 'CURSOR_ROLLED_BACK';
const GRAPH_HALF = ['graph_acked', 'graph_served', 'graph_epoch', 'graph_incarnation', 'graph_rollback_through'];
const hasGraphHalf = (s) => !!s && GRAPH_HALF.some((k) => s[k] != null);
const graphHalfOf = (s) => Object.fromEntries(GRAPH_HALF.map((k) => [k, s[k] ?? null]));
const clearGraphHalf = (s) => { for (const k of GRAPH_HALF) delete s[k]; };
/** null when this export provably comes from the store the lane's graph half was read in; else why not. */
function exportProvenanceError(s, re) {
  const inc = typeof re?.incarnation === 'string' ? incarnationTag(re.incarnation) : null;
  const ep = Number(re?.epoch ?? LEGACY_EPOCH);   // the marker records the epoch as a string
  if (inc == null) return 'unrecorded-incarnation';
  if (graphIncarnationOf(s) == null) return 'lane-without-incarnation';
  if (inc !== graphIncarnationOf(s)) return 'incarnation';
  if (!Number.isSafeInteger(ep) || ep !== graphEpochOf(s)) return 'epoch';
  return null;
}
const PROVENANCE_WHY = {
  'unrecorded-incarnation': 'the reverse-exported events do not record the executor incarnation they came from (a rollback made before the marker carried it)',
  'lane-without-incarnation': 'this lane\'s executor cursor names no incarnation (made before #1577)',
  incarnation: 'the reverse-exported events come from another executor incarnation than this lane\'s executor cursor',
  epoch: 'the reverse-exported events come from another executor epoch than this lane\'s executor cursor',
};

/** The feed rows this lane is owed, in commit order. */
function graphPending(s, graph) {
  const from = s.graph_acked ?? 0;
  return (graph.rows || []).filter((r) => r.graph.commitSeq > from)
    .sort((a, b) => a.graph.commitSeq - b.graph.commitSeq);
}

/**
 * A feed row in the shape of a log event, so a replay consumer reads ONE list.
 * `seq` is null (a receipt has no log seq; inventing one would collide), `state` is
 * null (the receipt does not carry the record — read it from the store), and `graph`
 * says where it came from: { opId, commitSeq, version }. Dedup such rows by opId.
 */
export function eventOfGraphRow(row) {
  return {
    seq: null, recorded_at: row.at, occurred_at: row.at, actor: row.by ?? null, op: row.op,
    entity: { kind: row.kind, id: row.id, shortId: row.shortId ?? null }, state: null, graph: row.graph,
  };
}

/**
 * Register a lane. A lane we already know KEEPS its cursor — that is the cure.
 * `graphHead` (flag ON) starts a FRESH lane's executor cursor at the executor's head,
 * as its log cursor starts at the log's; a known lane's executor cursor is never moved.
 */
export function registerFor(eventDir, key, { now = new Date().toISOString(), graphHead = null, graphEpoch = null, graphEpochBase = null, graphIncarnation = null, graphIncarnationFrom = null, resync = null } = {}) {
  const state = loadCursors(eventDir);
  const head = headSeq(eventDir);
  const { cursor, fresh } = registerSeat(state, key, head, { now });
  const s = state.seats[key];
  if (fresh && Number.isSafeInteger(graphHead)) {
    s.graph_acked = graphHead;
    if (Number.isSafeInteger(graphEpoch)) s.graph_epoch = graphEpoch;   // #1575
    if (Number.isSafeInteger(graphEpoch) && typeof graphIncarnation === 'string') s.graph_incarnation = graphIncarnation;   // #1577
  }
  // #1575 / #1577 — a KNOWN lane from another epoch or incarnation: reported, moved only on an explicit resync.
  let epochMismatch = null, resynced = null;
  const err = !fresh && Number.isSafeInteger(graphEpoch)
    ? laneIdentityError(s, { epoch: graphEpoch, epochBase: graphEpochBase, incarnation: graphIncarnation, incarnationFrom: graphIncarnationFrom }, 'this lane\'s executor cursor')
    : null;
  if (err) {
    if (resync === 'epoch') {
      resynced = { from_epoch: graphEpochOf(s), from_commit_seq: s.graph_acked ?? 0, to_epoch: graphEpoch,
        baseline_commit_seq: err.baseline.commit_seq, baseline: err.baseline.baseline };
      s.graph_resynced = { ...resynced, from_incarnation: graphIncarnationOf(s), to_incarnation: graphIncarnation ?? null, reason: err.reason, at: now };
      s.graph_acked = err.baseline.commit_seq;
      s.graph_epoch = graphEpoch;
      if (typeof graphIncarnation === 'string') s.graph_incarnation = graphIncarnation; else delete s.graph_incarnation;
      s.graph_served = null;   // a serve from the old epoch is not a serve of this one
    } else {
      epochMismatch = { code: EPOCH_CHANGED, error: err.message, reason: err.reason, epoch: graphEpoch, cursor_epoch: err.cursor_epoch,
        ...(err.incarnation ? { incarnation: err.incarnation, cursor_incarnation: err.cursor_incarnation } : {}),
        baseline: err.baseline, resync: 'POST /api/cursors/register with resync: "epoch"' };
    }
  }
  // #1561 ROLLBACK — the explicit recovery from CURSOR_ROLLED_BACK. Only with no graph source
  // (flag OFF): the graph half is set aside for audit and the log half resumes from its current
  // `acked`, so every reverse-exported event above it is delivered (duplicates possible, never a skip).
  let rollbackResync = null;
  if (resync === 'rollback' && !fresh) {
    if (Number.isSafeInteger(graphHead) || Number.isSafeInteger(graphEpoch)) {
      rollbackResync = { refused: 'the log-born unit is ON (the executor is a live source): a rollback resync applies only after rollback, with the flag OFF' };
    } else {
      const had = hasGraphHalf(s);
      if (had) {
        s.graph_rolled_back = { ...graphHalfOf(s), resume_from_seq: s.acked, at: now };
        clearGraphHalf(s);
      }
      resynced = { kind: 'rollback', resume_from_seq: s.acked, graph_half_set_aside: had,
        dedup: 'duplicates possible; deduplication by reverseExport.opId (the consumer\'s responsibility)' };
    }
  }
  // #1577 — a pre-#1577 lane (no incarnation) that the legacy rule just ACCEPTED (this store was never
  // promoted) is stamped with this store's incarnation, so after a later promotion it can resync exactly.
  if (!fresh && !err && Number.isSafeInteger(graphEpoch) && typeof graphIncarnation === 'string' && graphIncarnationOf(s) == null) {
    s.graph_epoch = graphEpoch;
    s.graph_incarnation = graphIncarnation;
  }
  saveCursors(eventDir, state);
  return { cursor, fresh, ...(epochMismatch ? { epoch_mismatch: epochMismatch } : {}), ...(resynced ? { resynced } : {}),
    ...(rollbackResync?.refused ? { resync_refused: rollbackResync.refused } : {}),
    envelope: envelopeFor(eventDir, key, { state, head }) };
}

/**
 * Read what this lane is owed. WRITES NOTHING.
 *
 * ⚠️ The returned `commit()` is not a convenience — it is the #624 guard. A
 * single-call API would record the serve at the moment of DECIDING what to
 * send, so a response that died in flight would still advance the cursor: the
 * original bug, reimplemented inside its own cure, and invisible to any test
 * that only checks "the right events came back". Call `commit()` after the
 * response is fully written, and never before.
 */
export function serveFor(eventDir, key, { limit = PULL_LIMIT, via = null, graph = null } = {}) {
  const state = loadCursors(eventDir);
  const head = headSeq(eventDir);
  const s = state.seats[key];
  // ⛔ REFUSE rather than answer partially. If retention has trimmed events this
  // lane still needed, serving "whatever survives" lets it ack past events it
  // can never receive — permanent, silent, and `lag` reads 0 afterwards. That is
  // the #624 loss class arriving through the cure. Same contract as
  // /api/changes' CURSOR_TOO_OLD, which the card told us to reuse.
  // (#1571: the LOG side only — the executor has no retention trim today.)
  const gap = s ? retentionGap(eventDir, s.acked) : null;
  if (gap) {
    return {
      events: [], known: true, refused: 'CURSOR_TOO_OLD', gap,
      envelope: envelopeFor(eventDir, key, { state, head, graph }),
      resync: 'Events this lane was owed are past the log\'s retention. Resync from the '
        + 'live store (card_list / conversation_list), then call again — this cursor cannot '
        + 'be advanced without skipping events it never received.',
      commit() { return null; },
    };
  }
  // #1575 — the executor cursor names another epoch: REFUSE. Serving would compare a
  // commitSeq from the lost store against the new one's reused numbers (a silent skip).
  // Nothing is served, nothing committed; the cursor stays as it is until an explicit resync.
  const idErr = s && graph && Number.isSafeInteger(graph.epoch) ? laneIdentityError(s, graph, 'this lane\'s executor cursor') : null;   // #1577: + incarnation
  if (idErr) {
    const err = idErr;
    return {
      events: [], known: true, refused: EPOCH_CHANGED, epochError: err,
      envelope: envelopeFor(eventDir, key, { state, head, graph: null }),
      resync: 'POST /api/cursors/register with resync: "epoch" — the executor cursor then moves to the baseline '
        + 'named here (in the current epoch) and every row written on this epoch is served.',
      commit() { return null; },
    };
  }
  // #1561 ROLLBACK — no graph source and a lane that still holds a graph half: translate the
  // reverse-exported events it is owed when their provenance is proven, refuse visibly otherwise.
  let translation = null;
  if (s && !graph && hasGraphHalf(s)) {
    const owed = readEvents(eventDir, { sinceSeq: s.acked }).filter((ev) => ev.reverseExport);
    if (owed.length) {
      const bad = owed.map((ev) => ({ ev, why: exportProvenanceError(s, ev.reverseExport) })).find((x) => x.why);
      if (bad) {
        const re = bad.ev.reverseExport;
        const rollbackError = {
          code: CURSOR_ROLLED_BACK, reason: bad.why, resync: true,
          message: `${PROVENANCE_WHY[bad.why]}, so which of them this lane already received cannot be proven. Nothing was served and the lane is unchanged.`,
          lane: { graph_acked: s.graph_acked ?? 0, graph_epoch: graphEpochOf(s), graph_incarnation: graphIncarnationOf(s) },
          export: { seq: bad.ev.seq, opId: re.opId, commitSeq: re.commitSeq, epoch: re.epoch ?? null, incarnation: re.incarnation ?? null },
          exports_owed: owed.length,
          resume_from_seq: s.acked,
          baseline: `log seq ${s.acked} (this lane's acked): after the resync every event above it is served, including all ${owed.length} reverse-exported event(s) — duplicates possible; deduplication by reverseExport.opId`,
        };
        return {
          events: [], known: true, refused: CURSOR_ROLLED_BACK, rollbackError,
          envelope: envelopeFor(eventDir, key, { state, head }),
          resync: 'POST /api/cursors/register with resync: "rollback" — the executor half is set aside and replay resumes '
            + `from log seq ${s.acked}; every reverse-exported event is delivered at least once (duplicates possible, none skipped).`,
          commit() { return null; },
        };
      }
      translation = { graph_acked: s.graph_acked ?? 0, through: owed.reduce((m, ev) => Math.max(m, ev.seq), 0) };
    }
  }
  const covered = (ev) => !!translation && !!ev.reverseExport && ev.reverseExport.commitSeq <= translation.graph_acked;
  // #1580 (a reviewer's second read) — the page is REFILLED past skipped exports: read forward in
  // chunks of `limit` until the page holds `limit` rows that are NOT covered, or the log ends.
  // Reading stops right after the last row included, so every skipped export counted below lies
  // inside the page's log high-water and nothing beyond it is passed over. Before this, `limit`
  // was applied BEFORE the skip, and a page could come back EMPTY while rows were still owed.
  // Contract (a reviewer): an empty page means the log was exhausted for this lane AT THE READ SNAPSHOT,
  // not that no further changes can arrive.
  let logRead = [];
  let logEvents = [];
  if (s && !translation) {
    logRead = readEvents(eventDir, { sinceSeq: s.acked, limit });
    logEvents = logRead;
  } else if (s) {
    let from = s.acked;
    for (;;) {
      const chunk = readEvents(eventDir, { sinceSeq: from, limit });
      if (!chunk.length) break;
      for (const ev of chunk) {
        logRead.push(ev);
        if (!covered(ev)) logEvents.push(ev);
        if (logEvents.length >= limit) break;
      }
      if (logEvents.length >= limit || chunk.length < limit) break;
      from = logRead[logRead.length - 1].seq;
    }
  }
  const skipped = logRead.length - logEvents.length;
  // #1571 — one page across both sources. mergeSources never reorders either list and
  // a prefix of the merge is the merge of the prefixes, so cutting the merge at
  // `limit` serves each source a gap-free prefix of what it is owed: the two
  // high-waters below are exact, and the next page resumes from each.
  const pending = s && graph ? graphPending(s, graph) : [];
  const page = mergeSources(
    logEvents.map((ev) => ({ src: 'log', ev })),
    pending.map((row) => ({ src: 'graph', row })),
  ).slice(0, limit);
  const events = page.map((it) => (it.src === 'graph' ? eventOfGraphRow(it.row) : it.ev));
  const maxOf = (src, pos) => page.filter((it) => it.src === src).reduce((m, it) => Math.max(m ?? 0, pos(it)), null);
  // a skipped export counts toward the page's log high-water: a page of ONLY skipped exports
  // still returns an ack token, or the lane would be re-served the same empty page forever
  const maxSeq = !graph && skipped ? logRead.reduce((m, ev) => Math.max(m, ev.seq), maxOf('log', (it) => it.ev.seq) ?? 0) : maxOf('log', (it) => it.ev.seq);
  const maxCommit = maxOf('graph', (it) => it.row.graph.commitSeq);
  return {
    events,
    envelope: { ...envelopeFor(eventDir, key, { state, head, graph }),
      ...(translation ? { translated_skipped: skipped, rollback_translation: { graph_acked: translation.graph_acked,
        graph_epoch: graphEpochOf(s), graph_incarnation: graphIncarnationOf(s), through_seq: translation.through } } : {}) },
    known: !!s,
    // #1576 — what the client sends back to SAY it received this page. Null when there is nothing to ack.
    ack_token: s && (maxSeq != null || maxCommit != null) ? encodeAckToken({
      v: 1, lane: key, via: via ?? null, log: maxSeq,
      graph: maxCommit == null ? null : {
        commitSeq: maxCommit,
        // the store this page was read from, and the lane's executor identity when it was served
        epoch: Number.isSafeInteger(graph?.epoch) ? graph.epoch : null,
        epochBase: Number.isSafeInteger(graph?.epochBase) ? graph.epochBase : null,
        incarnation: typeof graph?.incarnation === 'string' ? graph.incarnation : null,
        lane_epoch: s.graph_epoch ?? null, lane_incarnation: s.graph_incarnation ?? null,
      },
    }) : null,
    /**
     * Record the SERVE (never the ack). #1576: the server calls this BEFORE writing the
     * response — recording a serve asserts nothing about delivery, and it must be in place
     * before the client can possibly ack, or a fast ack would be clamped to an older serve.
     */
    commit() {
      if (!s || (maxSeq == null && maxCommit == null)) return null;
      const fresh = loadCursors(eventDir);          // re-read: another process may have moved
      if (maxSeq != null) recordServed(fresh, key, maxSeq);
      const seat = fresh.seats[key];
      if (seat && maxCommit != null && maxCommit > (seat.graph_acked ?? 0)) {
        seat.graph_served = Math.max(seat.graph_served ?? 0, maxCommit);
      }
      if (seat) seat.served_via = via;
      // #1561 — the exports this translation covers; an ack past this seq clears the graph half
      if (seat && translation) seat.graph_rollback_through = Math.max(seat.graph_rollback_through ?? 0, translation.through);
      saveCursors(eventDir, fresh);
      return graph ? { log: maxSeq, graph: maxCommit } : maxSeq;
    },
  };
}

/**
 * #782 / Decision 5b43edcd — a PUSH was actually written to this lane's session.
 *
 * Records `push_served`: the scheduler's deliver() completed `transport.send()` of a
 * conversation to a session holding an open stream. An UNKNOWN lane is not created
 * by a push: a lane exists once the seat has spoken to us.
 *
 * ⛔ #1576 — NOT an ack, and NOT a pull serve. A resolved stream write is a
 * server-side "sent" event — the same class as `res.end`'s callback, which Node 22
 * fires for a socket the client destroyed. It used to raise `served`, and the lane's
 * next inbound call then acked it. Now it is reported only (`push_served`): it does
 * not move `acked`, and it does not raise the `served` ceiling an explicit ack is
 * clamped to — a push of seq 100 says nothing about seqs 51–99. The pushed event
 * stays owed to the lane's pull until a pull serves it and the client acks.
 *
 * ⚠️ Call this after the write RESOLVES, never at enqueue (unchanged).
 */
export function markServed(eventDir, key, { seq, via = null } = {}) {
  const state = loadCursors(eventDir);
  const s = state.seats[key];
  if (!s) return { known: false };
  const n = Number(seq);
  const before = s.push_served ?? null;
  if (Number.isFinite(n) && n > s.acked) s.push_served = Math.max(before ?? 0, n);
  if ((s.push_served ?? null) !== before) saveCursors(eventDir, state);
  return { known: true, pushed: s.push_served ?? null, served: s.served ?? null, acked: s.acked };
}

/**
 * An inbound call from the lane — LIVENESS only (`last_inbound_at`, for reachability).
 *
 * ⛔ #1576 — this was the implicit ack ("the seat was alive AFTER the last response,
 * so we believe it arrived"), fenced by `via`. It is no longer an ack of any kind:
 * a response that died mid-body still reached `served`, and the next inbound acked
 * it. `acked` moves only in `ackFor`. Returns `{acked: false, fenced: false}` so a
 * caller reading the old shape is told, truthfully, that nothing was acked.
 */
export function noteInbound(eventDir, key, { via = null, now = new Date().toISOString(), graphHead = null, graphEpoch = null, graphIncarnation = null } = {}) {
  const state = loadCursors(eventDir);
  // A lane we have never seen ADOPTS a cursor at head on its first inbound call.
  // Deliberate, and it is what makes the bearer half of the room work at all:
  // @wren and @indigo never call scrum/session/register, so they would
  // otherwise have no cursor and no replay. Head, not zero — earlier history is
  // a store query, not a replay (the card is explicit), and a lane cannot be
  // owed events from before we knew it existed.
  if (!state.seats[key]) {
    registerSeat(state, key, headSeq(eventDir), { now });
    if (Number.isSafeInteger(graphHead)) state.seats[key].graph_acked = graphHead;   // #1571
    if (Number.isSafeInteger(graphHead) && Number.isSafeInteger(graphEpoch)) state.seats[key].graph_epoch = graphEpoch;   // #1575
    if (Number.isSafeInteger(graphHead) && Number.isSafeInteger(graphEpoch) && typeof graphIncarnation === 'string') state.seats[key].graph_incarnation = graphIncarnation;   // #1577
    saveCursors(eventDir, state);
    return { acked: false, fenced: false, adopted: true, envelope: envelopeFor(eventDir, key, { state }) };
  }
  recordInbound(state, key, headSeq(eventDir), { now });
  saveCursors(eventDir, state);
  return { acked: false, fenced: false, envelope: envelopeFor(eventDir, key, { state }) };
}

// ── #1576 — the explicit ack ─────────────────────────────────────────────────

export const ACK_TOKEN_INVALID = 'ACK_TOKEN_INVALID';
export const ACK_FOREIGN_LANE = 'ACK_FOREIGN_LANE';
export const ACK_BEYOND_SERVED = 'ACK_BEYOND_SERVED';
export const ACK_FENCED = 'ACK_FENCED';
export const ACK_EPOCH_STALE = 'ACK_EPOCH_STALE';
export const ACK_UNKNOWN_LANE = 'LANE_NOT_REGISTERED';

/** Opaque to clients (base64url JSON); every field is re-checked against the lane's state on ack. */
function encodeAckToken(t) {
  return Buffer.from(JSON.stringify(t), 'utf8').toString('base64url');
}
const posInt = (v) => Number.isSafeInteger(v) && v >= 0;
const strOrNull = (v) => v === null || typeof v === 'string';
const intOrNull = (v) => v === null || Number.isSafeInteger(v);
/** The token, or null if it is not one this server could have issued. */
export function parseAckToken(token) {
  if (typeof token !== 'string' || !token) return null;
  let t;
  try { t = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')); } catch { return null; }
  if (!t || typeof t !== 'object' || Array.isArray(t) || t.v !== 1) return null;
  if (typeof t.lane !== 'string' || !t.lane || !strOrNull(t.via ?? null)) return null;
  if (!(t.log === null || posInt(t.log))) return null;
  if (t.graph !== null) {
    const g = t.graph;
    if (!g || typeof g !== 'object' || !posInt(g.commitSeq)) return null;
    if (![g.epoch, g.epochBase, g.lane_epoch].every((x) => intOrNull(x ?? null))) return null;
    if (![g.incarnation, g.lane_incarnation].every((x) => strOrNull(x ?? null))) return null;
  }
  if (t.log === null && t.graph === null) return null;
  return t;
}

/**
 * The executor half of a token is from the store this lane is in NOW: the lane has not
 * been resynced or re-stamped since the serve, the token's store identity is one this
 * lane may be served by (the same rule serveFor applies), and — when the server read
 * the live store — that store is still the one the page came from. Null, or the reason.
 */
function graphTokenStale(s, g, store) {
  if ((s.graph_epoch ?? null) !== (g.lane_epoch ?? null) || (s.graph_incarnation ?? null) !== (g.lane_incarnation ?? null)) {
    return 'the lane\'s executor cursor was resynced or re-stamped since this page was served';
  }
  if (Number.isSafeInteger(g.epoch)) {
    const why = storeIdentityMismatch({ cursorEpoch: graphEpochOf(s), cursorIncarnation: graphIncarnationOf(s),
      epoch: g.epoch, epochBase: g.epochBase ?? null, incarnation: g.incarnation ?? undefined });
    if (why) return `the token names a store this lane is not in (${why})`;
  }
  if (store && ((store.epoch ?? null) !== (g.epoch ?? null) || (store.incarnation ?? null) !== (g.incarnation ?? null))) {
    return `the executor is now epoch ${store.epoch} / incarnation ${store.incarnation ?? 'none'}; `
      + `this page was read in epoch ${g.epoch ?? 'none'} / incarnation ${g.incarnation ?? 'none'}`;
  }
  return null;
}

/**
 * #1576 — THE ONLY THING THAT ADVANCES A LANE'S DURABLE CURSOR.
 *
 * `token` is a pull's `ack_token`; `store` is the executor's live { epoch, incarnation }
 * (the server reads it when the token has an executor half; null = not checked). Each
 * half advances to the token's high-water, which must be ≤ what was SERVED to this lane
 * (`served` / `graph_served`): never past it, never backward. A half already at or past
 * the token is a no-op, so a repeated ack answers `ALREADY_ACKED` and changes nothing.
 * Refusals change nothing and name themselves:
 *   ACK_TOKEN_INVALID  not a token this server issued
 *   ACK_FOREIGN_LANE   another lane's token
 *   ACK_EPOCH_STALE    another executor epoch / incarnation, or the lane resynced since
 *   ACK_BEYOND_SERVED  past what was served (a forged token, or a serve dropped at boot)
 *   ACK_FENCED         the range was since served to ANOTHER session of this lane
 */
export function ackFor(eventDir, key, token, { store = null } = {}) {
  const refuse = (code, error, extra = {}) => ({ ok: false, advanced: false, code, error, identity: key, ...extra });
  const t = parseAckToken(token);
  if (!t) return refuse(ACK_TOKEN_INVALID, 'not an ack_token from GET /api/cursors/pull');
  if (t.lane !== key) return refuse(ACK_FOREIGN_LANE, `this token acks lane ${t.lane}, not ${key}`);
  const state = loadCursors(eventDir);
  const s = state.seats[key];
  if (!s) return refuse(ACK_UNKNOWN_LANE, `no cursor for ${key} — register the lane first`);
  if (t.graph) {
    const stale = graphTokenStale(s, t.graph, store);
    if (stale) return refuse(ACK_EPOCH_STALE, `${stale} — pull again`);
  }
  // Per half: 'covered' (already acked — a no-op), 'advance', or 'beyond' (refused).
  const half = (to, acked, served) => (to == null || to <= acked ? 'covered'
    : served != null && to <= served ? 'advance' : 'beyond');
  const logH = half(t.log, s.acked, s.served ?? null);
  const graphH = t.graph ? half(t.graph.commitSeq, s.graph_acked ?? 0, s.graph_served ?? null) : 'covered';
  const cursorOut = () => ({ last_acked_seq: s.acked, ...(t.graph || 'graph_acked' in s ? { last_acked_commit_seq: s.graph_acked ?? 0 } : {}) });
  if (logH === 'beyond' || graphH === 'beyond') {
    return refuse(ACK_BEYOND_SERVED, 'this token acks past what was served to this lane — pull again', {
      token_log: t.log, served_seq: s.served ?? null,
      ...(t.graph ? { token_commit_seq: t.graph.commitSeq, served_commit_seq: s.graph_served ?? null } : {}),
      ...cursorOut(),
    });
  }
  if (logH === 'covered' && graphH === 'covered') {
    return { ok: true, advanced: false, code: 'ALREADY_ACKED', identity: key, ...cursorOut() };
  }
  if ((s.served_via ?? null) !== (t.via ?? null)) {
    return refuse(ACK_FENCED, 'this range was since served to another session of this lane — that session acks it, '
      + 'or it is re-served', { served_via_differs: true, ...cursorOut() });
  }
  if (logH === 'advance') s.acked = t.log;
  if (graphH === 'advance') s.graph_acked = t.graph.commitSeq;
  if (s.served != null && s.served <= s.acked) s.served = null;
  if (s.graph_served != null && s.graph_served <= (s.graph_acked ?? 0)) s.graph_served = null;
  if (s.served == null && (s.graph_served ?? null) == null) delete s.served_via;
  // #1561 ROLLBACK — every export the translation covered is now at or below acked: reconciled.
  if (Number.isSafeInteger(s.graph_rollback_through) && s.acked >= s.graph_rollback_through) {
    s.graph_reconciled = { ...graphHalfOf(s), acked: s.acked, at: new Date().toISOString() };
    clearGraphHalf(s);
  }
  saveCursors(eventDir, state);
  return { ok: true, advanced: true, identity: key, ...cursorOut(), envelope: envelopeFor(eventDir, key, { state }) };
}

/**
 * Reachability for every known lane, from INBOUND evidence only.
 *
 * `inputs: 'stream_open'` exists ONLY as the positive control the card demands.
 * It is the banned instrument — the one that scored a seat healthy for eight
 * hours while it received nothing — and it is kept here, runnable, so the
 * disagreement between the two projections can be demonstrated on one state
 * rather than argued about. It must never be used as health evidence.
 */
export function reachabilityReport(eventDir, { now = Date.now(), inputs = 'inbound', streamOpen = {}, ...opts } = {}) {
  const state = loadCursors(eventDir);
  const head = headSeq(eventDir);
  return Object.keys(state.seats).map((key) => {
    if (inputs === 'stream_open') {
      return {
        identity: key,
        state: streamOpen[key] ? REACHABLE : 'unreachable',
        lag: Math.max(0, head - state.seats[key].acked),
        reason: 'stream_open — BANNED as health evidence; positive control only',
        instrument: 'stream_open',
      };
    }
    const r = reachability(state, key, head, { now, ...opts });
    // #782 — additive: the two integers the cursor IS, beside the verdict about them.
    // #1576 — + the push high-water, reported beside (never part of) the cursor.
    return { identity: key, ...r, instrument: 'inbound', last_acked_seq: state.seats[key].acked, last_served_seq: state.seats[key].served ?? null,
      last_pushed_seq: state.seats[key].push_served ?? null };
  });
}

/**
 * Drop every pending (served-but-unacked) range. The server calls this at boot.
 *
 * ⚠️ NOT tidiness — soundness. The fence discriminates on the registry epoch,
 * and `core/seat-registry.mjs` keeps `epochCounter` in a closure with no
 * persistence, so epochs restart at 1 with the process. Measured across three
 * restarts: 3,4 → 5,6 → 1,2 — BACKWARDS. A fence that survived a restart could
 * therefore be satisfied by coincidence, an obsolete session's ack matching a
 * fresh epoch by number. The fence must be as ephemeral as its discriminator.
 *
 * The DURABLE cursor (`acked`) is untouched: a restart costs at most a re-serve
 * of the outstanding range, which is exactly the at-least-once contract.
 */
export function discardPendingServes(eventDir) {
  const state = loadCursors(eventDir);
  let dropped = 0;
  for (const s of Object.values(state.seats)) {
    if (s.served != null || s.served_via !== undefined || s.graph_served != null) dropped++;
    s.served = null;
    if ('graph_served' in s) s.graph_served = null;   // #1571 — the executor half, same reason
    delete s.served_via;
  }
  if (dropped) saveCursors(eventDir, state);
  return dropped;
}
