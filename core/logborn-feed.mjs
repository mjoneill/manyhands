/**
 * #1561 — the change-feed rows for the log-born unit's writes, read from the
 * graph EXECUTOR (the unit no longer appends them to the event log).
 *
 * A receipt is NOT automatically a change (reviewer a reviewer). A row is emitted only
 * for a receipt that is
 *   • APPLIED            — a PRECONDITION_FAILED receipt changed no domain triple;
 *   • a LIVE unit write  — opId under `urn:ex:op/logborn/` (core/logborn-unit.mjs
 *                          opIri). The migration's receipts (`urn:ex:op/migrate-1561/`)
 *                          import history whose events are still in the event log,
 *                          so counting them would serve every migrated record twice.
 * A refused write never reaches the executor (no receipt), and a replayed opId writes
 * nothing (the compiler's duplicate guard), so one op is at most one row.
 *
 * The receipt itself carries outcome, digest, actor, at, commitSeq and (for writes
 * that name an existing node) target. It does NOT carry the kind or the new entity,
 * so those are read from the DOMAIN nodes the op wrote (`urn:ex:recordedBy <op>`):
 *
 *   memory   create  versions recordedBy op → ofMemory   (no target)
 *            revise  target = the memory                  (versions optional)
 *   decision create  the decision recordedBy op           (no target)
 *            relate  target = the decision                (no node recorded)
 *   seat     declare the declaration recordedBy op → declaredSeat; target = the one it ended
 *            clear   no node recorded; target = the declaration ended → declaredSeat
 *
 * Each row has EXACTLY the event-log row's fields (core/changes-log-query.mjs toRow),
 * with the flag-OFF values for kind / op / id, plus one `graph` object saying where it
 * came from: { opId, commitSeq, version }. `seq` is null: a receipt has no log seq,
 * and inventing one would be a second, colliding sequence.
 */
import { LOGBORN_TERMS as TM } from './graph-compiler.mjs';
import { NS } from './graph-vocab.mjs';
import { PERSON_BASE } from './logborn-unit.mjs';
import { incarnationTag, INCARNATION_TAG } from './changes-log-query.mjs';   // #1577

export const LIVE_OP_PREFIX = `${NS}op/logborn/`;
const I = (x) => `<${x}>`;
const RX = (local) => `<${NS}${local}>`;

/**
 * ONE query, so one snapshot: every APPLIED live receipt past `afterCommitSeq`, the
 * domain facts its op recorded, the target's seat / owner, and the store's commit
 * high-water (the marker row) — the receipts returned are exactly those ≤ that mark.
 */
export function feedQuery(afterCommitSeq = 0) {
  const n = Number(afterCommitSeq);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`feedQuery: afterCommitSeq must be a non-negative integer (got ${afterCommitSeq})`);
  const keep = [TM.type, TM.ofMemory, TM.version, TM.author, TM.decidedBy, TM.declaredSeat].map(I).join(', ');
  return `SELECT ?hw ?ep ?eb ?inc ?incf ?op ?seq ?at ?actor ?target ?tseat ?towner ?rec ?rp ?ro WHERE {
  { ${RX('dataset')} ${RX('commitSeq')} ?hw ; ${RX('epoch')} ?ep . OPTIONAL { ${RX('dataset')} ${RX('epochBase')} ?eb }
    OPTIONAL { ${RX('dataset')} ${RX('incarnation')} ?inc } OPTIONAL { ${RX('dataset')} ${RX('incarnationFrom')} ?incf } }
  UNION
  { ?op ${RX('outcome')} ${RX('APPLIED')} ; ${RX('commitSeq')} ?seq ; ${RX('at')} ?at ; ${RX('actor')} ?actor .
    FILTER(STRSTARTS(STR(?op), ${JSON.stringify(LIVE_OP_PREFIX)}) && ?seq > ${n})
    OPTIONAL { ?op ${RX('target')} ?target .
      OPTIONAL { ?target ${I(TM.declaredSeat)} ?tseat }
      OPTIONAL { ?target ${I(TM.owner)} ?towner } }
    OPTIONAL { ?rec ${I(TM.recordedBy)} ?op ; ?rp ?ro . FILTER(?rp IN (${keep})) } }
}`;
}

const local = (iri) => String(iri).replace(/^.*[#/:]/, '');
const seatOf = (iri) => (String(iri).startsWith(PERSON_BASE) ? decodeURIComponent(String(iri).slice(PERSON_BASE.length)) : local(iri));
const actorSeat = (iri) => (String(iri).startsWith(`${NS}seat/`) ? String(iri).slice(`${NS}seat/`.length) : null);
/** The executor's xsd:dateTime (µs) → the log's ISO form (ms), so `since` and the merge compare like with like. */
export const isoAt = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : String(v); };

/**
 * Executor bindings (raw SPARQL JSON terms) → { rows, through }.
 * `through` is the commit high-water of the snapshot (the forward cursor's graph half).
 * An op whose kind cannot be read from the store is an ERROR, never a dropped row:
 * a feed that silently loses a write is the defect this module exists to fix.
 */
export function feedRowsFromBindings(bindings) {
  let through = null, epoch = null, epochBase = null, incarnation = null, incarnationFrom = null, markers = 0;
  const ops = new Map();
  for (const b of bindings) {
    if (b.hw) {
      markers++;
      through = Number(b.hw.value); epoch = Number(b.ep.value); epochBase = b.eb ? Number(b.eb.value) : null;
      incarnation = b.inc ? incarnationTag(b.inc.value) : null;            // #1577
      incarnationFrom = b.incf ? incarnationTag(b.incf.value) : null;
      continue;
    }
    const op = b.op.value;
    const o = ops.get(op) || { op, seq: Number(b.seq.value), at: b.at.value, actor: b.actor.value, target: null, tseat: null, towner: null, recs: new Map() };
    ops.set(op, o);
    if (b.target) o.target = b.target.value;
    if (b.tseat) o.tseat = b.tseat.value;
    if (b.towner) o.towner = b.towner.value;
    if (b.rec) {
      const r = o.recs.get(b.rec.value) || { iri: b.rec.value, types: new Set(), props: {} };
      o.recs.set(b.rec.value, r);
      if (b.rp.value === TM.type) r.types.add(b.ro.value);
      else (r.props[b.rp.value] ??= []).push(b.ro.value);
    }
  }
  if (through == null) throw Object.assign(new Error('graph feed: the store has no commit marker'), { code: 'GRAPH_EXECUTOR_UNAVAILABLE' });
  // #1575 — a cursor is only as good as the epoch it names: an unreadable or contradictory
  // epoch must not be guessed (a guessed epoch is the silent skip this card closes).
  if (markers !== 1 || !Number.isSafeInteger(epoch) || epoch < 1) {
    throw Object.assign(new Error(`graph feed: the commit marker is not one readable epoch (${markers} marker rows, epoch ${epoch})`), { code: 'GRAPH_EXECUTOR_UNAVAILABLE' });
  }
  // #1577 — nor an unreadable incarnation: two promoted restores share an epoch, and only the
  // incarnation tells them apart. (Two values multiply the marker rows: caught above.) The
  // executor mints one at every start that finds none, so its absence is a fault, not a legacy.
  if (!INCARNATION_TAG.test(incarnation ?? '') || (incarnationFrom != null && !INCARNATION_TAG.test(incarnationFrom))) {
    throw Object.assign(new Error(`graph feed: the commit marker has no readable incarnation (${incarnation})`), { code: 'GRAPH_EXECUTOR_UNAVAILABLE' });
  }
  const rows = [];
  for (const o of [...ops.values()].sort((a, b) => a.seq - b.seq)) rows.push(rowOf(o));
  return { rows, through, epoch, epochBase, incarnation, incarnationFrom };
}

function rowOf(o) {
  const tag = o.op.slice(LIVE_OP_PREFIX.length).split('/')[0];
  const recs = [...o.recs.values()];
  const ofType = (t) => recs.filter((r) => r.types.has(t));
  const one = (r, p) => r?.props[p]?.[0] ?? null;
  const fail = (why) => { throw Object.assign(new Error(`graph feed: op ${o.op} (commitSeq ${o.seq}): ${why}`), { code: 'GRAPH_FEED_UNREADABLE' }); };
  let kind, op, id, by, version = null;
  if (tag === 'memory') {
    kind = 'memory';
    const vers = ofType(TM.MemoryVersion).sort((a, b) => Number(one(a, TM.version)) - Number(one(b, TM.version)));
    const newest = vers.at(-1) ?? null;
    if (o.target) { op = 'update'; id = o.target; } else { op = 'create'; id = one(newest, TM.ofMemory) ?? fail('a create with no version node'); }
    version = newest ? Number(one(newest, TM.version)) : null;
    // `by` is the seat that MADE the change: the receipt's actor. Under enforced auth
    // the server fills `by` with that seat (#1343), so flag OFF credits it too; the
    // owner is a different fact (reviewers 14:48Z: a retag by bob of ada's memory
    // credited ada, and fanout-decide #717 would have hidden bob's write). Only a
    // non-seat actor (the trial bypass) falls back to the version's author / owner.
    by = actorSeat(o.actor)
      ?? (newest && one(newest, TM.author) ? local(one(newest, TM.author)) : (o.towner ? local(o.towner) : null));
  } else if (tag === 'decision') {
    kind = 'decision';
    if (o.target) {
      op = 'update'; id = o.target;
      // flag-OFF `by` is the body's `by`, which the relate intention does not carry:
      // the authenticated seat that made the write is the closest recorded fact.
      by = actorSeat(o.actor);
    } else {
      const d = ofType(TM.Decision)[0] ?? fail('a create with no decision node');
      op = 'create'; id = d.iri; by = one(d, TM.decidedBy) ? local(one(d, TM.decidedBy)) : null;
    }
  } else if (tag === 'seat') {
    kind = 'seat-state';
    const decl = ofType(TM.SeatDeclaration)[0] ?? null;
    if (decl) { op = o.target ? 'update' : 'create'; id = seatOf(one(decl, TM.declaredSeat) ?? fail('a declaration with no seat')); }
    else { op = 'delete'; id = seatOf(o.tseat ?? fail('a clear whose ended declaration names no seat')); }
    by = id;   // flag-OFF: seatStateEvent's actor is the declaring seat
  } else {
    fail(`unknown op family ${JSON.stringify(tag)}`);
  }
  return {
    kind, op, seq: null, id, shortId: null, title: null, column: null, by, at: isoAt(o.at),
    graph: { opId: o.op, commitSeq: o.seq, version },
  };
}

// ── #1574 C1–C6 — POSTS IN THE CHANGES FEED (the graph conversations unit ON) ──────────────────────────────────────────
// With the unit on a post lives in the graph, so the changes feed reads its receipts here: ordinary writes (`op/post/`),
// publisher announcements (`op/announce/`) and redactions (`op/redact/`). Not `op/backfill/`: an import is history, not a
// change. Each row's projection is the post node AS IT IS NOW, so a post redacted since its write replays as a content-free
// tombstone, never its text. The rows are cut to the commit high-water of the feed's own snapshot (`through`), so the one
// graph position of the cursor covers them exactly.
export const POST_OP_PREFIXES = Object.freeze([`${NS}op/post/`, `${NS}op/announce/`, `${NS}op/redact/`]);
const S_TEXT = 'https://schema.org/text', S_AUTHOR = 'https://schema.org/author', RDF_T = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const T_REDACTED = 'https://scrumboard.local/ns#RedactedPost', T_POSTSEQ = 'https://scrumboard.local/ns#postSeq';
const T_RECBY = 'urn:ex:recordedBy', T_REDBY = 'https://scrumboard.local/ns#redactedBy';
const ENTITY_IRI = 'https://scrumboard.local/entity/', PERSON_IRI = 'https://scrumboard.local/person/';

export function postFeedQuery(afterCommitSeq = 0) {
  const n = Number(afterCommitSeq);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`postFeedQuery: afterCommitSeq must be a non-negative integer (got ${afterCommitSeq})`);
  const pre = POST_OP_PREFIXES.map((p) => `STRSTARTS(STR(?op), ${JSON.stringify(p)})`).join(' || ');
  return `SELECT ?op ?seq ?at ?actor ?p ?t ?text ?author WHERE {
  ?op ${RX('outcome')} ${RX('APPLIED')} ; ${RX('commitSeq')} ?seq ; ${RX('at')} ?at ; ${RX('actor')} ?actor .
  FILTER((${pre}) && ?seq > ${n})
  { ?p <${T_RECBY}> ?op } UNION { ?p <${T_REDBY}> ?op }
  ?p <${T_POSTSEQ}> ?ps .
  OPTIONAL { ?p <${RDF_T}> ?t } OPTIONAL { ?p <${S_TEXT}> ?text } OPTIONAL { ?p <${S_AUTHOR}> ?author }
}`;
}

/** Bindings → changes rows (the log's conversation row shape), cut to `through`. */
export function postFeedRows(bindings, through) {
  const ops = new Map();
  for (const b of bindings || []) {
    const op = b.op.value, seq = Number(b.seq.value);
    if (!Number.isSafeInteger(seq) || (Number.isSafeInteger(through) && seq > through)) continue;
    const o = ops.get(op) || { op, seq, at: b.at.value, actor: b.actor?.value ?? null, p: b.p.value, types: new Set(), text: null, author: null };
    if (b.t) o.types.add(b.t.value);
    if (b.text) o.text = b.text.value;
    if (b.author) o.author = b.author.value;
    ops.set(op, o);
  }
  return [...ops.values()].sort((a, b) => a.seq - b.seq).map((o) => {
    const redactOp = o.op.startsWith(`${NS}op/redact/`);
    const gone = redactOp || o.types.has(T_REDACTED);
    const id = o.p.startsWith(ENTITY_IRI) ? o.p.slice(ENTITY_IRI.length) : local(o.p);
    const by = !gone && o.author ? (o.author.startsWith(PERSON_IRI) ? o.author.slice(PERSON_IRI.length) : local(o.author)) : actorSeat(o.actor);
    return {
      kind: 'conversation', op: redactOp ? 'redact' : 'post', seq: null, id, shortId: null,
      title: gone ? null : (typeof o.text === 'string' ? o.text.slice(0, 120) : null),
      column: null, by, at: isoAt(o.at),
      ...(gone ? { redacted: true } : {}),
      graph: { opId: o.op, commitSeq: o.seq, version: null },
    };
  });
}

/** Every post the graph holds as a tombstone: a log row naming one is served without its text. */
export const REDACTED_IDS_QUERY = `SELECT ?p WHERE { ?p <${RDF_T}> <${T_REDACTED}> }`;
export const redactedIdsFrom = (bindings) => new Set((bindings || []).map((b) => String(b.p.value)).filter((v) => v.startsWith(ENTITY_IRI)).map((v) => v.slice(ENTITY_IRI.length)));
