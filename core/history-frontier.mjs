/**
 * #1762 S3 — the history FRONTIER F: the one node that says "card history below this point lives in the graph".
 *
 * F is `<urn:ex:history/frontier>` in the bookkeeping graph, written once by S6 after a verified backfill. /api/changes
 * switches to the graph iff F exists and is VALID (contract v2 §1). This module only READS and CLASSIFIES it:
 *
 *   { state: 'absent' }                       confirmed zero F triples anywhere: today's path, byte-for-byte
 *   { state: 'valid', frontier, marker }      every field present once, well-typed, in range, and the store's own identity
 *   { state: 'invalid', reason }              → 503 HISTORY_FRONTIER_INVALID
 *   { state: 'mismatch', reason }             → 503 HISTORY_FRONTIER_STORE_MISMATCH (another epoch or incarnation)
 *
 * A query that cannot be answered THROWS (code GRAPH_EXECUTOR_UNAVAILABLE): "couldn't tell whether F exists" must never
 * take the old path. F and the marker are read in ONE query, so they come from one store snapshot.
 */
import { historyCommitment, HISTORY_FORMAT } from './history-proof.mjs';

export const BOOKKEEPING_GRAPH = 'urn:scrum:bookkeeping:executor';
export const FRONTIER = 'urn:ex:history/frontier';
const MARKER = 'urn:ex:dataset';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
export const FRONTIER_PREDICATES = Object.freeze({
  logSeq: 'urn:ex:frontierLogSeq', commitSeq: 'urn:ex:frontierCommitSeq', recordedAt: 'urn:ex:frontierRecordedAt',
  epoch: 'urn:ex:frontierEpoch', incarnation: 'urn:ex:frontierIncarnation',
  // #1762 S4 v1.6.2/v1.6.3 — the history certificate: REQUIRED (one F shape for every reader)
  historyRoot: 'urn:ex:frontierHistoryRoot', historyLeafCount: 'urn:ex:frontierHistoryLeafCount', historyTree: 'urn:ex:frontierHistoryTree',
  historyFormat: 'urn:ex:frontierHistoryFormat', historyCommitment: 'urn:ex:frontierHistoryCommitment',
});

/** One query: every F triple in ANY graph (default included, so a second F is visible), and the marker's identity. */
export const FRONTIER_QUERY = `SELECT ?src ?p ?o WHERE {
  { GRAPH <${BOOKKEEPING_GRAPH}> { <${FRONTIER}> ?p ?o } BIND("bk" AS ?src) }
  UNION { GRAPH ?g { <${FRONTIER}> ?p ?o } FILTER(?g != <${BOOKKEEPING_GRAPH}>) BIND("other" AS ?src) }
  UNION { <${FRONTIER}> ?p ?o BIND("default" AS ?src) }
  UNION { GRAPH <${BOOKKEEPING_GRAPH}> { <${MARKER}> ?p ?o } FILTER(?p IN (<urn:ex:epoch>, <urn:ex:incarnation>, <urn:ex:commitSeq>)) BIND("marker" AS ?src) }
}`;

const hex = (s) => String(s).replace(/-/g, '').toLowerCase();
// an integer that is SAFE: 9007199254740993 parses to ...992 in JavaScript, and a rounded position is a wrong one
const safeInt = (text) => /^-?\d+$/.test(text) && Number.isSafeInteger(Number(text)) && String(Number(text)) === String(BigInt(text));
const isInt = (b) => b && b.type !== 'uri' && b.datatype === `${XSD}integer` && safeInt(b.value);
const unavailable = (why) => Object.assign(new Error(`the store's dataset marker is not readable: ${why}`), { code: 'GRAPH_EXECUTOR_UNAVAILABLE' });

/** Classify the bindings of FRONTIER_QUERY. Pure: the caller runs the query. */
export function classifyFrontier(bindings) {
  const f = {}; const marker = {}; let elsewhere = 0;
  for (const b of bindings) {
    const src = b.src?.value, p = b.p?.value;
    if (src === 'marker') { (marker[p] ||= []).push(b.o); continue; }
    if (src === 'bk') { (f[p] ||= []).push(b.o); continue; }
    elsewhere++;   // F in the default graph or another named graph
  }
  // the marker is read in every outcome, "absent" included: a store whose identity cannot be read cannot confirm anything
  // every marker field: exactly ONE term, of the right KIND and datatype, in range — read before any outcome, absent F included
  const mOne = (p) => { const v = marker[p] || []; if (v.length !== 1) throw unavailable(`${p} has ${v.length} values`); return v[0]; };
  const intField = (p, min) => {
    const t = mOne(p);
    if (!isInt(t) || Number(t.value) < min) throw unavailable(`${p} must be one xsd:integer of at least ${min} (got ${t.type === 'uri' ? 'an IRI' : JSON.stringify(t.value)})`);
    return Number(t.value);
  };
  const incT = mOne('urn:ex:incarnation');
  if (incT.type === 'uri' || !/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i.test(incT.value)) {
    throw unavailable(`urn:ex:incarnation must be one literal in UUID or 32-hex form (got ${incT.type === 'uri' ? 'an IRI' : JSON.stringify(incT.value)})`);
  }
  const mk = { epoch: intField('urn:ex:epoch', 1), incarnation: incT.value, commitSeq: intField('urn:ex:commitSeq', 0) };
  const fTriples = Object.values(f).reduce((n, v) => n + v.length, 0);
  if (!fTriples && !elsewhere) return { state: 'absent', marker: mk };
  if (elsewhere) return { state: 'invalid', reason: 'the frontier also appears outside the bookkeeping graph (two frontiers)' };
  const one = (k) => {
    const v = f[FRONTIER_PREDICATES[k]] || [];
    if (v.length !== 1) throw new Error(`frontier ${k} has ${v.length} values (exactly one is required)`);
    return v[0];
  };
  let fr;
  try {
    const logSeq = one('logSeq'), commitSeq = one('commitSeq'), recordedAt = one('recordedAt'), epoch = one('epoch'), incarnation = one('incarnation');
    if (!isInt(logSeq) || Number(logSeq.value) < 1) throw new Error('frontierLogSeq must be an xsd:integer of at least 1');
    if (!isInt(commitSeq) || Number(commitSeq.value) < 0) throw new Error('frontierCommitSeq must be an xsd:integer of at least 0');
    if (recordedAt.type === 'uri' || recordedAt.datatype !== `${XSD}dateTime` || !Number.isFinite(Date.parse(recordedAt.value))) throw new Error('frontierRecordedAt must be a valid xsd:dateTime');
    if (!isInt(epoch) || Number(epoch.value) < 1) throw new Error('frontierEpoch must be an xsd:integer of at least 1');
    if (incarnation.type === 'uri' || !/^[0-9a-f]{32}$/.test(incarnation.value)) throw new Error('frontierIncarnation must be 32 lowercase hex');
    fr = { logSeq: Number(logSeq.value), commitSeq: Number(commitSeq.value), recordedAt: recordedAt.value, epoch: Number(epoch.value), incarnation: incarnation.value };
    // the history certificate (v1.6.2): each field exactly once, of the pinned kind; the commitment recomputed over all of them
    const plainHex = (b) => b.type !== 'uri' && (!b.datatype || b.datatype === `${XSD}string`) && !b['xml:lang'] && /^[0-9a-f]{64}$/.test(b.value);
    const root = one('historyRoot'), count = one('historyLeafCount'), tree = one('historyTree'), format = one('historyFormat'), commitment = one('historyCommitment');
    if (!plainHex(root)) throw new Error('frontierHistoryRoot must be a plain literal of 64 lowercase hex');
    if (!isInt(count) || Number(count.value) < 1) throw new Error('frontierHistoryLeafCount must be an xsd:integer of at least 1');
    if (tree.type !== 'uri' || !/^urn:scrum:history-tree:[^\s<>"{}|^`\\]+$/.test(tree.value)) throw new Error('frontierHistoryTree must be an IRI urn:scrum:history-tree:<buildId>');
    if (format.type === 'uri' || format.datatype && format.datatype !== `${XSD}string` || format.value !== HISTORY_FORMAT) throw new Error(`frontierHistoryFormat must be the plain literal "${HISTORY_FORMAT}"`);
    if (!plainHex(commitment)) throw new Error('frontierHistoryCommitment must be a plain literal of 64 lowercase hex');
    fr.history = { root: root.value, leafCount: Number(count.value), tree: tree.value, format: format.value, commitment: commitment.value };
    const want = historyCommitment({ format: fr.history.format, epoch: fr.epoch, incarnation: fr.incarnation, logSeq: fr.logSeq, commitSeq: fr.commitSeq, leafCount: fr.history.leafCount, tree: fr.history.tree, root: fr.history.root });
    if (want !== fr.history.commitment) throw new Error('frontierHistoryCommitment does not match the frontier it commits to');
  } catch (e) { return { state: 'invalid', reason: e.message }; }
  if (String(fr.epoch) !== String(Number(mk.epoch))) return { state: 'mismatch', reason: `the frontier's epoch ${fr.epoch} is not the store's (${mk.epoch})` };
  if (fr.incarnation !== hex(mk.incarnation)) return { state: 'mismatch', reason: 'the frontier names another store incarnation' };
  if (fr.commitSeq > mk.commitSeq) return { state: 'invalid', reason: `frontierCommitSeq ${fr.commitSeq} is beyond the store's commitSeq ${mk.commitSeq}` };
  return { state: 'valid', frontier: fr, marker: mk };
}
