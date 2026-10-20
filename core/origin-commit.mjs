/**
 * #1629 slice 2 — the READ side of `origin.prepare` and the origin-bearing `card.write` commit (r3 on #1629, frozen with
 * the rows at card v117). The write side is in core/graph-compiler.mjs; these readers share its derivations, so a write
 * and a read cannot drift apart.
 *
 *   originKeyOf(route, subject, requestKey, originActor)   the closed 5-tuple key (JSON array), r3 §1
 *   mutationIdOf(originKey)                                 UUIDv5 of it under the frozen namespace
 *   readPreparedOrigin(client, mutationId)                  {ok, prepared|null} | {ok:false, status:'UNAVAILABLE'|'INVALID', reason}
 *   readCommittedOrigin(client, mutationId)                 {ok, committed:{origin, obligations, reservations}|null} | the same failures
 *   enumerateOriginRecords(client)                          every Prepared / Origin / Obligation subject, sorted (PR1's control)
 *
 * Reader discipline is slice 1's (core/postseq-reserve.mjs): strict on cardinality, datatype and term identity; a partial
 * row is INVALID, never null; stored JSON must equal its own canonicalization; every digest is recomputed from stored JSON;
 * the mutationId is recomputed from originKeyJson. Nothing here writes, repairs or defaults. readCommittedOrigin validates
 * the WHOLE join (§2a), and the commit receipt's digest is RECONSTRUCTED from the stored descriptor, plan and occurredAt
 * (§2a.5a) rather than compared to another stored string.
 *
 * Isolated primitive only: no route wiring, no publisher, nothing live.
 */
import { ORIGIN_TERMS, EX, BK, POSTSEQ_TERMS } from './graph-vocab.mjs';
import {
  originKeyOf as _originKeyOf, mutationIdOf as _mutationIdOf, canonOriginDescriptor, originDescriptorDigest, originPlanDigest,
  originCommitDigest, originCommitOp, ValidationError,
} from './graph-compiler.mjs';
import { readPostSeqReservation, canonAnnouncementDraft } from './postseq-reserve.mjs';
import { announcePostId } from './announce-outbox.mjs';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const T = ORIGIN_TERMS;
const bare = (t) => t.slice(1, -1);   // '<iri>' → 'iri'
const PRED = Object.fromEntries(Object.entries(T).filter(([, x]) => typeof x === 'string' && x.startsWith('<')).map(([k, x]) => [bare(x), k]));

/** The pure derivations the compiler uses, re-exported so rows test the same functions (ValidationError → TypeError-like throw). */
export const originKeyOf = (route, subject, requestKey, originActor) => _originKeyOf(route, subject, requestKey, originActor);
export const mutationIdOf = (originKey) => _mutationIdOf(originKey);

const isStr = (v) => typeof v === 'string' && v.isWellFormed();
const invalid = (reason) => ({ ok: false, status: 'INVALID', reason });
class Bad extends Error {}
class Unavailable extends Error {}
const bad = (r) => { throw new Bad(r); };

/** Group a subject's (?p ?o) rows by predicate IRI; refuse a predicate this subject type does not carry. */
function byPredicate(rows, allowed, what) {
  const out = new Map();
  for (const r of rows) {
    const p = r.p?.value;
    if (p === RDF_TYPE) { (out.get('type') ?? out.set('type', []).get('type')).push(r.o); continue; }
    const name = PRED[p];
    if (!name || !allowed.includes(name)) bad(`${what} carries an unexpected predicate ${p}`);
    (out.get(name) ?? out.set(name, []).get(name)).push(r.o);
  }
  return out;
}
const one = (m, name, what) => {
  const xs = m.get(name) ?? [];
  if (xs.length !== 1) bad(`${what}.${name} has ${xs.length} values; exactly one is required`);
  return xs[0];
};
const plain = (t, what) => {
  if (!t || t.type !== 'literal' || typeof t.value !== 'string' || t['xml:lang'] != null || (t.datatype != null && t.datatype !== `${XSD}string`)) bad(`${what} is not a plain string literal`);
  return t.value;
};
const uri = (t, what) => { if (!t || t.type !== 'uri') bad(`${what} is not an IRI`); return t.value; };
const integer = (t, what) => {
  if (!t || t.type !== 'literal' || t.datatype !== `${XSD}integer` || !/^-?\d+$/.test(t.value) || !Number.isSafeInteger(Number(t.value))) bad(`${what} is not an exact xsd:integer`);
  return Number(t.value);
};
const dateTime = (t, what) => {
  if (!t || t.type !== 'literal' || t.datatype !== `${XSD}dateTime` || !Number.isFinite(Date.parse(t.value))) bad(`${what} is not an xsd:dateTime`);
  return t.value;   // the STORED lexical form, never normalized (Q4)
};
const typeIs = (m, want, what) => {
  const xs = m.get('type') ?? [];
  if (xs.length !== 1 || xs[0].type !== 'uri' || xs[0].value !== bare(want)) bad(`${what} must have exactly the type ${bare(want)}`);
};

async function triplesOf(client, subject) {
  const r = await client.query(`SELECT ?p ?o WHERE { GRAPH ${BK} { ${subject} ?p ?o } }`);
  return r.ok ? { ok: true, rows: r.rows } : { ok: false, status: 'UNAVAILABLE', reason: r.reason };
}

const PREPARED_FIELDS = ['mutationId', 'originKeyJson', 'route', 'originActor', 'descriptorJson', 'descriptorDigest', 'planJson', 'planDigest', 'occurredAt', 'committedBy'];

/**
 * The Prepared record of one origin. `{ok:true, prepared:null}` when its subject holds nothing at all. The returned
 * fields are the stored ones under their predicate names; occurredAt is the stored lexical string (copy it, unchanged,
 * into the commit's origin.occurredAt).
 */
export async function readPreparedOrigin(client, mutationId) {
  if (!isStr(mutationId) || !mutationId) return invalid('mutationId is not a non-empty well-formed string');
  const r = await triplesOf(client, T.preparedSubject(mutationId));
  if (!r.ok) return r;
  if (!r.rows.length) return { ok: true, prepared: null };
  try {
    return { ok: true, prepared: validatePrepared(r.rows, mutationId).prepared };
  } catch (e) {
    if (e instanceof Bad || e instanceof ValidationError) return invalid(e.message);
    throw e;
  }
}

function validatePrepared(rows, mutationId) {
  const w = 'Prepared';
  const m = byPredicate(rows, PREPARED_FIELDS, w);
  typeIs(m, T.Prepared, w);
  const s = (name) => plain(one(m, name, w), `${w}.${name}`);
  const prepared = {
    mutationId: s('mutationId'), originKeyJson: s('originKeyJson'), route: s('route'), originActor: s('originActor'),
    descriptorJson: s('descriptorJson'), descriptorDigest: s('descriptorDigest'), planJson: s('planJson'), planDigest: s('planDigest'),
    occurredAt: dateTime(one(m, 'occurredAt', w), `${w}.occurredAt`),
    committedBy: null,
  };
  const cb = m.get('committedBy') ?? [];
  if (cb.length > 1) bad(`${w}.committedBy has ${cb.length} values`);
  if (cb.length === 1) prepared.committedBy = uri(cb[0], `${w}.committedBy`);
  // identity: the key is the closed tuple, and the mutationId is RECOMPUTED from it (Q3)
  let key;
  try { key = JSON.parse(prepared.originKeyJson); } catch (e) { bad(`${w}.originKeyJson is not JSON: ${e.message}`); }
  if (!Array.isArray(key) || key.length !== 5 || key[0] !== 'origin-v1') bad(`${w}.originKeyJson is not the origin-v1 tuple`);
  if (_originKeyOf(key[1], key[2], key[3], key[4]) !== prepared.originKeyJson) bad(`${w}.originKeyJson is not its own canonical encoding`);
  const mid = _mutationIdOf(prepared.originKeyJson);
  if (mid !== prepared.mutationId || mid !== mutationId) bad(`${w}.mutationId ${prepared.mutationId} is not the recomputed ${mid}`);
  if (prepared.route !== key[1] || prepared.originActor !== key[4]) bad(`${w}.route/originActor disagree with originKeyJson`);
  // the descriptor: canonical, byte-equal to its own canonicalization, the same identity, its digest recomputed
  let parsed;
  try { parsed = JSON.parse(prepared.descriptorJson); } catch (e) { bad(`${w}.descriptorJson is not JSON: ${e.message}`); }
  const { descriptor } = canonOriginDescriptor(parsed);
  if (JSON.stringify(descriptor) !== prepared.descriptorJson) bad(`${w}.descriptorJson is not its own canonical form`);
  if (descriptor.mutationId !== mid || descriptor.route !== key[1] || descriptor.subject !== key[2] || descriptor.requestKey !== key[3] || descriptor.originActor !== key[4]) bad(`${w}.descriptorJson names a different identity`);
  if (originDescriptorDigest(descriptor) !== prepared.descriptorDigest) bad(`${w}.descriptorDigest is not the digest of descriptorJson`);
  // the plan: JSON in normal form, its digest recomputed
  let plan;
  try { plan = JSON.parse(prepared.planJson); } catch (e) { bad(`${w}.planJson is not JSON: ${e.message}`); }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || !Array.isArray(plan.parts) || JSON.stringify(plan) !== prepared.planJson) bad(`${w}.planJson is not a canonical plan`);
  if (originPlanDigest(plan) !== prepared.planDigest) bad(`${w}.planDigest is not the digest of planJson`);
  if (prepared.committedBy != null && prepared.committedBy !== originCommitOp(mid)) bad(`${w}.committedBy is not ${originCommitOp(mid)}`);
  return { prepared, descriptor, plan };
}

const ORIGIN_FIELDS = ['mutationId', 'originKeyJson', 'descriptorDigest', 'planDigest', 'committedAt', 'commitOp', 'slotCount'];
const OBLIGATION_FIELDS = ['obligationId', 'mutationId', 'slot', 'index', 'status', 'mode', 'provenanceJson', 'reservation'];

/**
 * The committed origin: the Origin, its Obligations and its reservations, validated as ONE join (§2a). `{ok:true,
 * committed:null}` when nothing of the commit exists (the Prepared node may or may not). Anything partial is INVALID.
 */
export async function readCommittedOrigin(client, mutationId) {
  if (!isStr(mutationId) || !mutationId) return invalid('mutationId is not a non-empty well-formed string');
  const pr = await triplesOf(client, T.preparedSubject(mutationId));
  if (!pr.ok) return pr;
  const orr = await triplesOf(client, T.originSubject(mutationId));
  if (!orr.ok) return orr;
  try {
    const P = pr.rows.length ? validatePrepared(pr.rows, mutationId) : null;
    if (!orr.rows.length) {
      if (P?.prepared.committedBy) bad('the Prepared node names a commit, but no Origin exists');
      const ob = await obligationSubjects(client, mutationId, P?.descriptor.slots ?? []);
      if (ob.size) bad('Obligations exist for this mutationId, but no Origin');
      return { ok: true, committed: null };
    }
    if (!P) bad('an Origin exists with no Prepared node');
    const { prepared, descriptor, plan } = P;
    if (prepared.committedBy == null) bad('an Origin exists, but the Prepared node names no commit');
    const op = originCommitOp(mutationId);
    // §2a.1–2: the Origin itself
    const w = 'Origin';
    const om = byPredicate(orr.rows, ORIGIN_FIELDS, w);
    typeIs(om, T.Origin, w);
    const origin = {
      mutationId: plain(one(om, 'mutationId', w), `${w}.mutationId`), originKeyJson: plain(one(om, 'originKeyJson', w), `${w}.originKeyJson`),
      descriptorDigest: plain(one(om, 'descriptorDigest', w), `${w}.descriptorDigest`), planDigest: plain(one(om, 'planDigest', w), `${w}.planDigest`),
      committedAt: dateTime(one(om, 'committedAt', w), `${w}.committedAt`), commitOp: uri(one(om, 'commitOp', w), `${w}.commitOp`),
      slotCount: integer(one(om, 'slotCount', w), `${w}.slotCount`),
    };
    if (origin.mutationId !== mutationId || origin.originKeyJson !== prepared.originKeyJson) bad(`${w} names a different identity than its Prepared node`);
    if (origin.commitOp !== op || prepared.committedBy !== op) bad(`${w}.commitOp and Prepared.committedBy must both be ${op}`);
    if (origin.descriptorDigest !== prepared.descriptorDigest || origin.planDigest !== prepared.planDigest) bad(`${w} digests differ from the Prepared ones`);
    // §2a.1 + 5a: the APPLIED receipt, whose digest is RECONSTRUCTED from the stored canonical parts
    const rc = await client.query(`SELECT ?p ?o WHERE { GRAPH ${BK} { <${op}> ?p ?o FILTER(?p IN (${EX.outcome}, ${EX.digest})) } }`);
    if (!rc.ok) return { ok: false, status: 'UNAVAILABLE', reason: rc.reason };
    const outs = rc.rows.filter((r) => r.p.value === bare(EX.outcome)), digs = rc.rows.filter((r) => r.p.value === bare(EX.digest));
    if (outs.length !== 1 || digs.length !== 1) bad(`the commit receipt must carry exactly one outcome and one digest (${outs.length}, ${digs.length})`);
    if (uri(outs[0].o, 'receipt.outcome') !== bare(EX.APPLIED)) bad('the commit receipt is not APPLIED');
    const expected = originCommitDigest(descriptor, plan, prepared.occurredAt);
    if (plain(digs[0].o, 'receipt.digest') !== expected) bad('the commit receipt digest is not the digest reconstructed from the stored descriptor, plan and occurredAt');
    // §2a.3–4: exactly N obligations, one per descriptor slot, in order
    const N = descriptor.slots.length;
    if (origin.slotCount !== N) bad(`${w}.slotCount ${origin.slotCount} is not the descriptor's ${N} slots`);
    const subjects = await obligationSubjects(client, mutationId, descriptor.slots);
    const want = descriptor.slots.map((s) => bare(T.obligationSubject(mutationId, s.slot)));
    if (subjects.size !== N || want.some((x) => !subjects.has(x))) bad(`expected exactly the ${N} obligations of the descriptor's slots; found ${subjects.size}`);
    const provenanceJson = JSON.stringify(descriptor.provenance);
    const obligations = [], reservations = [];
    for (const [i, s] of descriptor.slots.entries()) {
      const ow = `Obligation[${s.slot}]`;
      const tr = await triplesOf(client, `<${want[i]}>`);
      if (!tr.ok) return tr;
      const bm = byPredicate(tr.rows, OBLIGATION_FIELDS, ow);
      typeIs(bm, T.Obligation, ow);
      const ob = {
        obligationId: plain(one(bm, 'obligationId', ow), `${ow}.obligationId`), mutationId: plain(one(bm, 'mutationId', ow), `${ow}.mutationId`),
        slot: plain(one(bm, 'slot', ow), `${ow}.slot`), index: integer(one(bm, 'index', ow), `${ow}.index`),
        status: plain(one(bm, 'status', ow), `${ow}.status`), mode: plain(one(bm, 'mode', ow), `${ow}.mode`),
        provenanceJson: plain(one(bm, 'provenanceJson', ow), `${ow}.provenanceJson`), reservation: uri(one(bm, 'reservation', ow), `${ow}.reservation`),
      };
      const postId = announcePostId(mutationId, s.slot);
      if (ob.slot !== s.slot || ob.index !== i || ob.mutationId !== mutationId || ob.obligationId !== `${mutationId}:${s.slot}`) bad(`${ow} does not match descriptor slot ${i}`);
      if (ob.status !== 'pending' || ob.mode !== 'publisher') bad(`${ow} must be pending / publisher in this slice`);
      if (ob.provenanceJson !== provenanceJson) bad(`${ow}.provenanceJson is not the descriptor's provenance`);
      if (ob.reservation !== bare(POSTSEQ_TERMS.reservation(postId))) bad(`${ow}.reservation is not the reservation at ${postId}`);
      obligations.push(ob);
      // §2a.5: the reservation, itself ok through slice 1's reader, and joined to this origin
      const rr = await readPostSeqReservation(client, postId);
      if (!rr.ok) { if (rr.status === 'UNAVAILABLE') return rr; bad(`reservation ${postId}: ${rr.reason}`); }
      const x = rr.reservation;
      if (!x) bad(`reservation ${postId} is missing`);
      const draft = canonAnnouncementDraft({ body: s.body, author: s.author, originActor: descriptor.originActor, occurredAt: prepared.occurredAt, mentions: s.mentions, notify: s.notify });
      if (x.mode !== 'announcement' || x.index !== i || x.identity.mutationId !== mutationId || x.identity.slot !== s.slot) bad(`reservation ${postId} is not announcement slot ${i} of this origin`);
      if (JSON.stringify(x.draft) !== JSON.stringify(draft)) bad(`reservation ${postId}'s draft is not descriptor slot ${i} at the Prepared occurredAt`);
      if (x.reserveOpId !== op || x.reserveDigest !== expected) bad(`reservation ${postId}'s reserveOpId/reserveDigest are not the commit's`);
      reservations.push(x);
    }
    // §2a.6: one epoch, consecutive numbers in index order, created at the commit's NOW()
    for (const [i, x] of reservations.entries()) {
      if (x.postSeqEpoch !== reservations[0].postSeqEpoch) bad('the reservations do not share one postSeqEpoch');
      if (x.postSeq !== reservations[0].postSeq + i) bad('the reservations\' postSeqs are not consecutive in index order');
      if (x.createdAt !== origin.committedAt) bad(`reservation ${x.postId}'s createdAt is not Origin.committedAt`);
    }
    return { ok: true, committed: { origin, obligations, reservations } };
  } catch (e) {
    if (e instanceof Unavailable) return { ok: false, status: 'UNAVAILABLE', reason: e.message };
    if (e instanceof Bad || e instanceof ValidationError) return invalid(e.message);
    throw e;
  }
}

/** Every Obligation subject of this mutationId: typed ones naming it, plus any triple on a derived slot subject. */
async function obligationSubjects(client, mutationId, slots) {
  const derived = slots.map((s) => T.obligationSubject(mutationId, s.slot));
  const q = `SELECT DISTINCT ?s WHERE { GRAPH ${BK} { { ?s a ${T.Obligation} ; ${T.mutationId} ?m . FILTER(STR(?m) = ${JSON.stringify(mutationId)}) }${derived.length ? ` UNION { VALUES ?s { ${derived.join(' ')} } ?s ?p ?o }` : ''} } }`;
  const r = await client.query(q);
  if (!r.ok) throw new Unavailable(r.reason);
  return new Set(r.rows.map((b) => b.s.value));
}

/** PR1's named control: one bookkeeping SELECT over the three origin types, sorted by subject. */
export async function enumerateOriginRecords(client) {
  const r = await client.query(`SELECT ?s ?t ?m WHERE { GRAPH ${BK} { ?s a ?t . FILTER(?t IN (${T.Prepared}, ${T.Origin}, ${T.Obligation})) OPTIONAL { ?s ${T.mutationId} ?m } } } ORDER BY ?s`);
  if (!r.ok) return { ok: false, status: 'UNAVAILABLE', reason: r.reason };
  const name = { [bare(T.Prepared)]: 'Prepared', [bare(T.Origin)]: 'Origin', [bare(T.Obligation)]: 'Obligation' };
  return { ok: true, records: r.rows.map((b) => ({ type: name[b.t.value], subject: b.s.value, mutationId: b.m?.value ?? null })) };
}
