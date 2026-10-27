/**
 * #1762 S3 — /api/changes card-side history read from the GRAPH, once a valid frontier F exists (contract v2 + v2.1–v2.3).
 *
 * Two sources replace the event log, both read from the executor:
 *
 *   LEGACY  the projector's `activity:seq-N` nodes with N ≤ F.logSeq, every kind but `conversation` (today's non-post
 *           bucket), carrying the backfill's facts. Each becomes a synthetic log event that carries its finished public
 *           row (`historyRow`), so the existing merge / cursor / paging code serves it unchanged and `toRow` never invents
 *           a title it does not have.
 *   NATIVE  S1's `scrum:ChangeActivity` nodes whose APPLIED receipt is past F.commitSeq: one row per (opId, part).
 *
 * Every row is the public row shape: kind, op, seq, id, shortId, title, column, by, at, graph (+ holder on card rows, +
 * the refusal's fields on a refusal, + `unknown` naming each field whose fact is scrum:unknown or was never held).
 * `title` is null on every graph row (disclosed: an activity stores no content). `at` is the log's recorded time
 * (scrum:logRecordedAt) for a legacy row and the write's own time for a native one, both in the log's ISO form.
 */
import { NS, BK } from './graph-vocab.mjs';
import { isoAt } from './logborn-feed.mjs';

// The namespaces as graph-replica.mjs IRI spells them. Not imported from there: graph-replica pulls in `oxigraph`, and
// server.js must boot with no npm dependency in its static import graph (#868).
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const PROV = 'http://www.w3.org/ns/prov#';
const BASE = 'https://scrumboard.local/';
const RS = `${BASE}ns#`, ACT = `${BASE}activity/`, ENT = `${BASE}entity/`, PERSON = `${BASE}person/`;
const NONE = `${RS}none`, UNKNOWN = `${RS}unknown`;
const P = {
  op: `${RS}op`, entityKind: `${RS}entityKind`, used: `${PROV}used`, actor: `${PROV}wasAssociatedWith`, startedAt: `${PROV}startedAtTime`,
  shortId: `${RS}shortId`, columnAfter: `${RS}columnAfter`, holderAtWrite: `${RS}holderAtWrite`, logRecordedAt: `${RS}logRecordedAt`,
  reason: `${RS}reason`, httpStatus: `${RS}httpStatus`, part: `${RS}part`, versionAfter: `${RS}versionAfter`, recordedBy: `${RS}recordedBy`,
};
const KEEP = Object.values(P).map((p) => `<${p}>`).join(', ');

/** S1's native ops → the log's vocabulary (contract v2 §2): the public `op` is mapped, `graph.nativeOp` keeps the raw one. */
export const NATIVE_TO_LOG_OP = Object.freeze({
  create: 'create', update: 'update', move: 'update', claim: 'update', release: 'update', reproject: 'update', delete: 'delete',
});

const dt = (iso) => `${JSON.stringify(new Date(Date.parse(iso)).toISOString())}^^<${XSD}dateTime>`;

/**
 * The legacy seq-nodes a request can see: N ≤ F.logSeq, not a conversation, and inside the window — by INSTANT
 * (`logRecordedAt >= since`) for an ISO since, or by seq (`N > log half`) for a cursor. One query; facts only.
 */
export function legacyQuery({ logSeqMax, sinceIso = null, afterSeq = null }) {
  const seqExpr = `xsd:integer(STRAFTER(STR(?a), ${JSON.stringify(`${ACT}seq-`)}))`;
  const window = sinceIso != null ? `FILTER(?lat >= ${dt(sinceIso)})` : `FILTER(${seqExpr} > ${Number(afterSeq)})`;
  return `PREFIX xsd: <${XSD}>
SELECT ?a ?p ?o WHERE {
  ?a <${P.logRecordedAt}> ?lat .
  FILTER(STRSTARTS(STR(?a), ${JSON.stringify(`${ACT}seq-`)}))
  FILTER(${seqExpr} <= ${Number(logSeqMax)})
  ${window}
  FILTER NOT EXISTS { ?a <${P.entityKind}> "conversation" }
  ?a ?p ?o . FILTER(?p IN (${KEEP}))
}`;
}

/** The native ChangeActivities committed after F and at or before `through` (the receipt feed's high-water: one cut). */
export function nativeQuery({ afterCommitSeq, through }) {
  return `SELECT ?a ?p ?o ?opId ?seq WHERE {
  ?a a <${RS}ChangeActivity> ; <${P.recordedBy}> ?opId .
  GRAPH ${BK} { ?opId <${NS}outcome> <${NS}APPLIED> ; <${NS}commitSeq> ?seq }
  FILTER(?seq > ${Number(afterCommitSeq)} && ?seq <= ${Number(through)})
  ?a ?p ?o . FILTER(?p IN (${KEEP}))
}`;
}

function group(bindings, extra = () => {}) {
  const nodes = new Map();
  for (const b of bindings) {
    const a = b.a.value;
    let n = nodes.get(a);
    if (!n) { n = { iri: a, t: {} }; nodes.set(a, n); extra(n, b); }
    (n.t[b.p.value] ||= []).push(b.o);
  }
  return [...nodes.values()];
}

const first = (n, p) => n.t[p]?.[0] ?? null;
const seatOf = (term) => (term && term.value.startsWith(PERSON) ? decodeURIComponent(term.value.slice(PERSON.length)) : null);
const idOf = (term) => (term && term.value.startsWith(ENT) ? term.value.slice(ENT.length) : term?.value ?? null);

/** shortId as the public row has it: a number, or null (named in `unknown`) when the fact is missing or not a number. */
function shortIdOf(n, unknown) {
  const v = first(n, P.shortId);
  if (v && /^\d+$/.test(v.value)) return Number(v.value);
  unknown.push('shortId');
  return null;
}
/** a card fact that is a literal, scrum:none (→ null) or scrum:unknown (→ null, named) */
function cardFact(term, name, unknown) {
  if (!term) { unknown.push(name); return null; }
  if (term.type === 'uri' && term.value === NONE) return null;
  if (term.type === 'uri' && term.value === UNKNOWN) { unknown.push(name); return null; }
  return term.type === 'uri' ? (name === 'holder' ? seatOf(term) : term.value) : term.value;
}
const withUnknown = (row, unknown) => (unknown.length ? { ...row, unknown } : row);

/** LEGACY bindings → synthetic, seq-ascending events whose `historyRow` is the finished public row. */
export function legacyEventsFromBindings(bindings) {
  const out = [];
  for (const n of group(bindings)) {
    const seq = Number(n.iri.slice(`${ACT}seq-`.length));
    const kind = first(n, P.entityKind)?.value ?? null;
    const op = first(n, P.op)?.value ?? null;
    const at = isoAt(first(n, P.logRecordedAt).value);
    const unknown = [];
    const base = { kind, op, seq, id: idOf(first(n, P.used)), shortId: null, title: null, column: null, by: seatOf(first(n, P.actor)), at, graph: null };
    let row;
    if (op === 'refused') {
      base.shortId = shortIdOf(n, unknown);
      row = { ...base, reason: first(n, P.reason)?.value ?? null, status: first(n, P.httpStatus)?.value ?? null, route: null, request: null, response: null, rule: null };
      unknown.push('route', 'request', 'response', 'rule');   // the projector never held them (graph-replica.mjs, #1217)
    } else if (kind === 'card') {
      base.shortId = shortIdOf(n, unknown);
      row = { ...base, column: cardFact(first(n, P.columnAfter), 'column', unknown), holder: cardFact(first(n, P.holderAtWrite), 'holder', unknown) };
    } else {
      const s = first(n, P.shortId);
      row = { ...base, shortId: s && /^\d+$/.test(s.value) ? Number(s.value) : null };
    }
    out.push({ seq, op, actor: row.by, recorded_at: at, entity: { kind, id: row.id, shortId: row.shortId }, historyRow: withUnknown(row, unknown) });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** NATIVE bindings → graph rows, in (commitSeq, part) order. */
export function nativeRowsFromBindings(bindings) {
  const rows = [];
  for (const n of group(bindings, (node, b) => { node.opId = b.opId.value; node.commitSeq = Number(b.seq.value); })) {
    const nativeOp = first(n, P.op)?.value ?? null;
    const kind = first(n, P.entityKind)?.value ?? null;
    const unknown = [];
    const v = first(n, P.versionAfter);
    const graph = { opId: n.opId, commitSeq: n.commitSeq, version: v && /^\d+$/.test(v.value) ? Number(v.value) : null, part: Number(first(n, P.part)?.value ?? 0), nativeOp };
    if (graph.version == null) unknown.push('version');
    const base = { kind, op: NATIVE_TO_LOG_OP[nativeOp] ?? nativeOp, seq: null, id: idOf(first(n, P.used)), shortId: null, title: null, column: null, by: seatOf(first(n, P.actor)), at: isoAt(first(n, P.startedAt)?.value), graph };
    let row;
    if (kind === 'card') {
      base.shortId = shortIdOf(n, unknown);
      row = { ...base, column: cardFact(first(n, P.columnAfter), 'column', unknown), holder: cardFact(first(n, P.holderAtWrite), 'holder', unknown) };
    } else {
      const s = first(n, P.shortId);
      row = { ...base, shortId: s && /^\d+$/.test(s.value) ? Number(s.value) : null };
    }
    rows.push(withUnknown(row, unknown));
  }
  return rows.sort((a, b) => a.graph.commitSeq - b.graph.commitSeq || a.graph.part - b.graph.part);
}
