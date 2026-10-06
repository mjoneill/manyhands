/**
 * #1582 unit 3 — deliveries and model calls with the graph as the store of record.
 *
 * Pure helpers only: identities, opIds, the SPARQL reads, and rebuilding a DOCUMENT-SHAPED entity from graph rows,
 * so the server's existing wire builders (deliveryToWire, modelCallToWire) and transition rules run unchanged on
 * either store. The writes go through core/graph-compiler.mjs's record kinds (delivery.create, delivery.step,
 * modelcall.create); nothing here builds update text.
 *
 * Identities (agreed on #1582 C1/C4):
 *   - a delivery is ONE per (deliveredTo, ofConversation): its id is a v5 uuid of that pair, so a retried create, or two
 *     producers offering the same post to the same seat, are the same node;
 *   - a model call is ONE per (agent, requestId): its id is a v5 uuid of that pair;
 *   - every opId is an IRI under `urn:ex:op/` built only from derived uuids and the validated requestId, so no raw caller
 *     text can make it a non-IRI (#1622).
 */
import { createHash } from 'node:crypto';
import { LOGBORN_TERMS as TM } from './graph-compiler.mjs';

// Chosen once, NEVER changed: a different namespace derives a different id for the same pair.
export const DELIVERY_NAMESPACE = 'd301e56c-6e8a-45e0-a348-a63ab5295c8e';
export const MODEL_CALL_NAMESPACE = '1ba81e20-0201-4d31-8795-b18c07925476';

export const DELIVERY_PREFIX = 'https://scrumboard.local/delivery/';
export const MODEL_CALL_PREFIX = 'https://scrumboard.local/model-call/';
export const ENTITY_PREFIX = 'https://scrumboard.local/entity/';
const RS = 'https://scrumboard.local/ns#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/** An RFC 4122 version-5 uuid of `name` under `namespace` (same construction as announcePostId). */
export function uuidV5(namespace, name) {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const h = createHash('sha1').update(ns).update(Buffer.from(name, 'utf8')).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = b.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** The requestId rule shared with POST /api/conversations: 8–64 of [A-Za-z0-9-]. */
export const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
/** A seat key / agent as it may appear in a derived identity (the server's ASSIGNEE_KEY_RE shape). */
export const SEAT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** A conversation (post) id as REST accepts it today: safe to put inside an IRI. */
export const POST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export const deliveryIdOf = (to, conversation) => uuidV5(DELIVERY_NAMESPACE, `${to}\u0000${conversation}`);
export const deliveryIriOf = (to, conversation) => `${DELIVERY_PREFIX}${deliveryIdOf(to, conversation)}`;
const DELIVERY_IRI_RE = /^https:\/\/scrumboard\.local\/delivery\/[A-Za-z0-9-]{1,64}$/;
/** The uuid of a delivery IRI REST may put inside `<…>`, or null for anything else (an unknown id is a 404, never SPARQL). */
export const deliverySuffix = (iri) => (typeof iri === 'string' && DELIVERY_IRI_RE.test(iri) ? iri.slice(DELIVERY_PREFIX.length) : null);
export const deliveryCreateOp = (iri) => `urn:ex:op/delivery/${deliverySuffix(iri)}/create`;
export const deliveryStepOp = (iri, requestId) => `urn:ex:op/delivery/${deliverySuffix(iri)}/req/${requestId}`;
export const stepIri = (iri, index) => `${iri}/step/${index}`;

export const modelCallIdOf = (agent, requestId) => uuidV5(MODEL_CALL_NAMESPACE, `${agent}\u0000${requestId}`);
export const modelCallIriOf = (agent, requestId) => `${MODEL_CALL_PREFIX}${modelCallIdOf(agent, requestId)}`;
export const modelCallOp = (agent, requestId) => `urn:ex:op/model-call/${modelCallIdOf(agent, requestId)}`;

// ---------------------------------------------------------------- reads (SELECT text; the caller runs them through the read gate)

const lit = (s) => JSON.stringify(String(s));   // only ever called on values already checked against SEAT_RE / POST_ID_RE
const t = (local) => `<${RS}${local}>`;

/**
 * One delivery's own triples AND its steps' triples in ONE query, so the version and the step list come from one snapshot
 * (two reads could see a step whose version bump the first read missed). Rows: ?s ?p ?o, where ?s is the node or a step.
 */
export const deliveryQuery = (iri) => `SELECT ?s ?p ?o WHERE { { BIND(<${iri}> AS ?s) <${iri}> ?p ?o } UNION { ?s ${t('stepOf')} <${iri}> . ?s ?p ?o } }`;
/** Split one deliveryQuery result into its node rows and its step rows. */
export const splitDeliveryRows = (iri, rows) => ({ nodeRows: rows.filter((r) => r.s?.value === iri), stepRows: rows.filter((r) => r.s?.value !== iri) });

/** Every delivery for a seat (optionally one conversation): node triples and step triples in ONE query. Rows: ?d ?s ?p ?o. */
export function deliveriesForQuery({ to, conversation } = {}) {
  const where = `?d <${RDF_TYPE}> ${t('Delivery')}${to ? ` ; ${t('deliveredTo')} ${lit(to)}` : ''}${conversation ? ` ; ${t('ofConversation')} <${ENTITY_PREFIX}${conversation}>` : ''} .`;
  return `SELECT ?d ?s ?p ?o WHERE { ${where} { ?d ?p ?o . BIND(?d AS ?s) } UNION { ?s ${t('stepOf')} ?d . ?s ?p ?o } }`;
}

/** Does an opId hold an APPLIED receipt? (Y4/Y10: a caller's own retry gets its own outcome back, not a conflict.) */
export const receiptQuery = (opId) => `SELECT ?o WHERE { <${opId}> <urn:ex:outcome> ?o }`;
export const isApplied = (rows) => rows.some((r) => r.o?.value === 'urn:ex:APPLIED');

/** Is this post node live (a Comment) or redacted? */
export const postStateQuery = (postId) => `SELECT ?t WHERE { <${ENTITY_PREFIX}${postId}> <${RDF_TYPE}> ?t }`;
export const modelCallExistsQuery = (iri) => `SELECT ?t WHERE { <${iri}> <${RDF_TYPE}> ${t('ModelCall')} }`;

// ---------------------------------------------------------------- rows → a document-shaped entity

const val = (b) => b?.value;
// A step's fields keyed by the predicate the COMPILER writes (a step's note is schema.org's `text`, not this namespace's):
// read through the same table, so the writer and this reader cannot drift apart.
const STEP_FIELD = new Map(['stepIndex', 'state', 'at', 'source', 'creator', 'attempt', 'reason', 'text', 'traceId', 'ofModelCall'].map((k) => [TM[k], k]));

/**
 * Rebuild the document's delivery shape from graph rows, so deliveryToWire / deliveryState / the transition rules run
 * unchanged: `{'@id', 'scrum:deliveredTo', 'scrum:ofConversation', 'scrum:offeredAt', 'scrum:hasEvent': [...]}` plus
 * `ver` (the expected version for the next step). Steps are ordered by stepIndex, which IS the delivery version each
 * step made, so the order has no ties.
 */
export function deliveryFromRows(iri, nodeRows, stepRows) {
  const e = { '@id': iri, '@type': 'scrum:Delivery' };
  let ver = null;
  for (const r of nodeRows) {
    const p = val(r.p), o = val(r.o);
    if (p === TM.ver) ver = Number(o);
    else if (p === TM.deliveredTo) e['scrum:deliveredTo'] = o;
    else if (p === TM.ofConversation) e['scrum:ofConversation'] = o.startsWith(ENTITY_PREFIX) ? o.slice(ENTITY_PREFIX.length) : o;
    else if (p === TM.offeredAt) e['scrum:offeredAt'] = o;
    else if (p === TM.source) e['scrum:source'] = o;
  }
  if (ver == null || !e['scrum:deliveredTo']) return null;   // not a delivery node
  const steps = new Map();
  for (const r of stepRows) {
    const s = val(r.s); if (!steps.has(s)) steps.set(s, {});
    const k = STEP_FIELD.get(val(r.p));
    if (k) steps.get(s)[k] = val(r.o);
  }
  e['scrum:hasEvent'] = [...steps.values()]
    .filter((s) => s.stepIndex != null && s.state != null)
    .sort((a, b) => Number(a.stepIndex) - Number(b.stepIndex))
    .map((s) => ({
      'scrum:state': s.state, 'scrum:at': s.at, 'scrum:source': s.source, ...(s.creator != null ? { creator: s.creator } : {}),
      ...(s.attempt != null ? { 'scrum:attempt': Number(s.attempt) } : {}), ...(s.reason != null ? { 'scrum:reason': s.reason } : {}),
      ...(s.text != null ? { text: s.text } : {}), ...(s.traceId != null ? { 'scrum:traceId': s.traceId } : {}),
      ...(s.ofModelCall != null ? { 'scrum:ofModelCall': s.ofModelCall } : {}),
    }));
  return { entity: e, ver };
}

/** Group a multi-delivery read (deliveriesForQuery) into rebuilt deliveries. */
export function groupByDelivery(rows) {
  const by = new Map();
  for (const r of rows) {
    const d = val(r.d); if (!by.has(d)) by.set(d, { nodeRows: [], stepRows: [] });
    (val(r.s) === d ? by.get(d).nodeRows : by.get(d).stepRows).push(r);
  }
  return [...by.entries()].map(([d, g]) => deliveryFromRows(d, g.nodeRows, g.stepRows)).filter(Boolean);
}

// ---------------------------------------------------------------- model calls

/** A ledger timestamp bound REST may put inside a SPARQL string (an ISO-8601 instant or a prefix of one). */
export const SINCE_RE = /^[0-9][0-9A-Za-z:.+-]{0,39}$/;

/**
 * Model-call rows: the entity as JSON, plus `postedText` from its own triple (kept apart so a redaction can remove it, and
 * a call recorded after one never stores it). One row per call. `iri` reads one call; `agent` and `since` filter, and are
 * only ever passed already checked against SEAT_RE and SINCE_RE.
 */
export function modelCallsQuery({ iri, agent, since } = {}) {
  return `SELECT ?c ?j ?t WHERE { ${iri ? `VALUES ?c { <${iri}> } ` : ''}?c <${RDF_TYPE}> ${t('ModelCall')} ; ${t('entityJson')} ?j ; ${t('calledAt')} ?at ; ${t('agent')} ?ag . `
    + `OPTIONAL { ?c ${t('postedText')} ?t }${agent ? ` FILTER(?ag = ${lit(agent)})` : ''}${since ? ` FILTER(?at >= ${lit(since)})` : ''} }`;
}

/** One row → the document-shaped entity the existing wire builder reads (modelCallToWire). Null for a row that does not parse. */
export function modelCallFromRow(r) {
  let e; try { e = JSON.parse(val(r.j)); } catch { return null; }
  if (!e || typeof e !== 'object') return null;
  return { ...e, '@id': val(r.c), 'scrum:postedText': r.t ? val(r.t) : null };
}
