/**
 * #1747 R1 — the records the §6 cutover IMPORTS from the document, and the one rule every reader uses to recognise and
 * validate them (interface v2, #1747 v50). A record is IMPORTED iff it carries origin:migrationId; an imported record
 * that also carries a native-only field, and a native record that carries migrationId, are both INVALID.
 *
 *   reservation  <urn:ex:postseq/reservation/<postId>>   postId postSeq createdAt legacyKey sourceReservationJson
 *                                                        sourceApplied? migrationId — no mode, receipt, draft or identity
 *   origin       <urn:ex:origin/origin/<mutationId>>     mutationId mode originActor occurredAt committedAt slotCount
 *                                                        sourceOriginJson migrationId — and NO Prepared node
 *   obligation   <urn:ex:origin/obligation/<mid>/<slot>> obligationId slot mode status sourceEntryJson migrationId
 *                                                        retirementReason? retirementProofPostId? notifyDisposition? notifyDispositionNote?
 *
 * Every typed field is a MIRROR of the stored source JSON and must agree with it; the source JSON must be its own
 * canonical form. Nothing is fabricated: an imported reservation has no draft, and a reader that needs one says so.
 *
 * Pure: no I/O. The validators take the subject's triples as SPARQL JSON bindings ({p, o}).
 */
import { POSTSEQ_NS, ORIGIN_NS, ORIGIN_TERMS } from './graph-vocab.mjs';
import { announcePostId } from './announce-outbox.mjs';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const bare = (t) => t.replace(/^<|>$/g, '');

export const IMPORTED_TERMS = Object.freeze({
  legacyKey: `${POSTSEQ_NS}legacyKey`, sourceApplied: `${POSTSEQ_NS}sourceApplied`,
  sourceReservationJson: `${POSTSEQ_NS}sourceReservationJson`,
  sourceOriginJson: `${ORIGIN_NS}sourceOriginJson`, sourceEntryJson: `${ORIGIN_NS}sourceEntryJson`,
  retirementReason: `${ORIGIN_NS}retirementReason`, retirementProofPostId: `${ORIGIN_NS}retirementProofPostId`,
  notifyDisposition: `${ORIGIN_NS}notifyDisposition`, notifyDispositionNote: `${ORIGIN_NS}notifyDispositionNote`,
  migrationId: `${ORIGIN_NS}migrationId`,
});

/** Sorted-key JSON with no whitespace; anything JSON cannot carry exactly (a non-finite number, a class instance) throws.
 *  The ONE JS canonicaliser (the origin reader imports it too). CAVEAT (#1758): keys sort by UTF-16 code unit, the executor's
 *  Python by code point; they agree in the Basic Multilingual Plane and differ above U+FFFF, which #1758 makes both refuse. */
export function canonicalJson(v) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('a non-finite number in a source record'); return JSON.stringify(v); }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  throw new Error(`a ${typeof v} in a source record`);
}

class Invalid extends Error {}
const bad = (m) => { throw new Invalid(m); };

/** Group a subject's {p, o} rows by predicate IRI. */
const byPred = (rows) => { const m = new Map(); for (const r of rows) { const k = r.p.value; if (!m.has(k)) m.set(k, []); m.get(k).push(r.o); } return m; };
/** The subject carries origin:migrationId — the one discriminator. */
export const isImportedRows = (rows) => rows.some((r) => r.p.value === IMPORTED_TERMS.migrationId);

function closed(m, allowed, what) {
  for (const p of m.keys()) if (!allowed.has(p)) bad(`${what} carries ${p}, which an imported record may not (native-only or unknown)`);
}
function one(m, p, what) { const xs = m.get(p) ?? []; if (xs.length !== 1) bad(`${what} must carry exactly one ${p} (found ${xs.length})`); return xs[0]; }
function opt(m, p, what) { const xs = m.get(p) ?? []; if (xs.length > 1) bad(`${what} carries ${xs.length} ${p}`); return xs[0]; }
function plain(t, what) {
  if (!t || t.type !== 'literal' || typeof t.value !== 'string' || t['xml:lang'] != null || (t.datatype != null && t.datatype !== `${XSD}string`)) bad(`${what} is not a plain string literal`);
  return t.value;
}
function integer(t, what) {
  if (!t || t.type !== 'literal' || t.datatype !== `${XSD}integer` || !/^-?\d+$/.test(t.value) || !Number.isSafeInteger(Number(t.value))) bad(`${what} is not an exact xsd:integer`);
  return Number(t.value);
}
/**
 * A FULL ISO-8601 instant with a zone that names a REAL calendar time (#122 re-review, finding 1). Date.parse alone is
 * lenient: V8 reads `2026-02-31T00:00:00Z` as March 3, and the store keeps the ill-typed literal (SPARQL comparisons on it
 * come back unbound). So every field is range-checked: month 1-12, the day within its month (leap years included), hour
 * 0-23, minute and second 0-59, a zone offset of at most 14:00. Shared by the importer (before any write) and this reader.
 */
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/;
export function calendarInstant(v) {
  const m = typeof v === 'string' ? ISO_INSTANT.exec(v) : null;
  if (!m) return false;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  if (!days || d < 1 || d > days || h > 23 || mi > 59 || se > 59) return false;
  if (m[8] !== 'Z' && (Number(m[10]) > 14 || Number(m[11]) > 59 || (Number(m[10]) === 14 && Number(m[11]) !== 0))) return false;
  return Number.isFinite(Date.parse(v));
}
function dateTime(t, what) {
  if (!t || t.type !== 'literal' || t.datatype !== `${XSD}dateTime` || !calendarInstant(t.value)) bad(`${what} is not an xsd:dateTime`);
  return t.value;
}
function boolean(t, what) {
  if (!t || t.type !== 'literal' || t.datatype !== `${XSD}boolean` || (t.value !== 'true' && t.value !== 'false')) bad(`${what} is not an xsd:boolean`);
  return t.value === 'true';
}
function typeIs(m, want, what) {
  const xs = m.get(RDF_TYPE) ?? [];
  if (xs.length !== 1 || xs[0].type !== 'uri' || xs[0].value !== bare(want)) bad(`${what} must have exactly the type ${bare(want)}`);
}
/** The stored source JSON: parseable, a plain object, and byte-identical to its own canonical form. */
function sourceJson(text, what) {
  let v;
  try { v = JSON.parse(text); } catch (e) { bad(`${what} is not parseable JSON: ${e.message}`); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) bad(`${what} is not a JSON object`);
  let c;
  try { c = canonicalJson(v); } catch (e) { bad(`${what}: ${e.message}`); }
  if (c !== text) bad(`${what} is not its own canonical form`);
  return v;
}
const sameInstant = (a, b) => typeof a === 'string' && typeof b === 'string' && Number.isFinite(Date.parse(a)) && Date.parse(a) === Date.parse(b);
const keysExactly = (o, keys) => { const k = Object.keys(o).sort(); return k.length === keys.length && keys.slice().sort().every((x, i) => x === k[i]); };
const wrap = (f) => { try { return f(); } catch (e) { if (e instanceof Invalid) return { ok: false, status: 'INVALID', reason: e.message }; throw e; } };

const PS = (local) => `${POSTSEQ_NS}${local}`;
const RES_ALLOWED = new Set([RDF_TYPE, PS('postId'), PS('postSeq'), PS('createdAt'), IMPORTED_TERMS.legacyKey, IMPORTED_TERMS.sourceReservationJson,
  IMPORTED_TERMS.sourceApplied, IMPORTED_TERMS.migrationId]);
const RES_SOURCE_KEYS = new Set(['applied', 'createdAt', 'postId', 'postSeq']);

/**
 * One imported reservation, from its subject's rows. `migrationId` is the allocator's; the record must name the same one.
 * → {ok:true, reservation:{kind:'imported', postId, postSeq, createdAt, legacyKey, sourceApplied, migrationId}} | {ok:false, status:'INVALID', reason}
 */
export function validateImportedReservation(rows, postId, migrationId) {
  return wrap(() => {
    const w = `imported reservation ${postId}`;
    const m = byPred(rows);
    closed(m, RES_ALLOWED, w);
    typeIs(m, `<${PS('Reservation')}>`, w);
    const storedPostId = plain(one(m, PS('postId'), w), `${w}.postId`);
    if (storedPostId !== postId) bad(`${w}: stored postId ${storedPostId} is not the subject's`);
    const postSeq = integer(one(m, PS('postSeq'), w), `${w}.postSeq`);
    if (postSeq < 1) bad(`${w}.postSeq ${postSeq} is not positive`);
    const createdAt = dateTime(one(m, PS('createdAt'), w), `${w}.createdAt`);
    const legacyKey = plain(one(m, IMPORTED_TERMS.legacyKey, w), `${w}.legacyKey`);
    if (!legacyKey) bad(`${w}.legacyKey is empty`);
    const mig = plain(one(m, IMPORTED_TERMS.migrationId, w), `${w}.migrationId`);
    if (mig !== migrationId) bad(`${w}.migrationId ${mig} is not the allocator's ${migrationId}`);
    const src = sourceJson(plain(one(m, IMPORTED_TERMS.sourceReservationJson, w), `${w}.sourceReservationJson`), `${w}.sourceReservationJson`);
    if (!keysExactly(src, [legacyKey])) bad(`${w}.sourceReservationJson must hold exactly its legacyKey ${legacyKey}`);
    const rec = src[legacyKey];
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) bad(`${w}: the source reservation is not an object`);
    for (const k of Object.keys(rec)) if (!RES_SOURCE_KEYS.has(k)) bad(`${w}: the source reservation carries ${k}, which no measured shape has`);
    if (rec.postId !== storedPostId) bad(`${w}: postId mirror disagrees with the source`);
    if (rec.postSeq !== postSeq) bad(`${w}: postSeq mirror ${postSeq} disagrees with the source ${rec.postSeq}`);
    if (!sameInstant(rec.createdAt, createdAt)) bad(`${w}: createdAt mirror ${createdAt} is not the source's instant ${rec.createdAt}`);
    const appliedTerm = opt(m, IMPORTED_TERMS.sourceApplied, w);
    let sourceApplied = null;
    if ('applied' in rec) {
      if (typeof rec.applied !== 'boolean') bad(`${w}: the source applied is not a boolean`);
      if (!appliedTerm) bad(`${w}: the source has applied, its mirror is absent`);
      sourceApplied = boolean(appliedTerm, `${w}.sourceApplied`);
      if (sourceApplied !== rec.applied) bad(`${w}: sourceApplied mirror disagrees with the source`);
    } else if (appliedTerm) bad(`${w}: sourceApplied is present, the source has no applied`);
    return { ok: true, reservation: { kind: 'imported', postId: storedPostId, postSeq, createdAt, legacyKey, sourceApplied, migrationId: mig } };
  });
}

const OR = (local) => `${ORIGIN_NS}${local}`;
const ORIGIN_ALLOWED = new Set([RDF_TYPE, OR('mutationId'), OR('mode'), OR('originActor'), OR('occurredAt'), OR('committedAt'), OR('slotCount'),
  IMPORTED_TERMS.sourceOriginJson, IMPORTED_TERMS.migrationId]);
const ORIGIN_SOURCE_KEYS = ['committedAt', 'mode', 'mutationId', 'occurredAt', 'origin', 'originActor', 'slots'];
const OB_ALLOWED = new Set([RDF_TYPE, OR('obligationId'), OR('slot'), OR('mode'), OR('status'), IMPORTED_TERMS.sourceEntryJson, IMPORTED_TERMS.migrationId,
  IMPORTED_TERMS.retirementReason, IMPORTED_TERMS.retirementProofPostId, IMPORTED_TERMS.notifyDisposition, IMPORTED_TERMS.notifyDispositionNote]);
const SLOT_RE = /^[a-z][a-z0-9-]{0,31}$/;   // the outbox's own slot grammar (server.js XO_RE)
export const IMPORTED_STATUSES = Object.freeze(['published', 'blocked']);   // pending is INVALID: the importer HOLDs it before READY

/**
 * One imported origin and its obligations. `obligationRows` maps each obligation SUBJECT IRI found for this mutationId to
 * its rows (the caller finds them by the derived subjects AND by prefix, so an extra one is seen).
 * → {ok:true, committed:{kind:'imported', origin, obligations}} | {ok:false, status:'INVALID', reason}
 */
export function validateImportedOrigin(originRows, obligationRows, mutationId, migrationId) {
  return wrap(() => {
    const w = `imported origin ${mutationId}`;
    const m = byPred(originRows);
    closed(m, ORIGIN_ALLOWED, w);
    typeIs(m, ORIGIN_TERMS.Origin, w);
    if (plain(one(m, OR('mutationId'), w), `${w}.mutationId`) !== mutationId) bad(`${w}: stored mutationId is not the subject's`);
    const mode = plain(one(m, OR('mode'), w), `${w}.mode`);
    if (mode !== 'legacy' && mode !== 'publisher') bad(`${w}.mode ${mode} is not legacy or publisher`);
    const originActor = plain(one(m, OR('originActor'), w), `${w}.originActor`);
    const occurredAt = dateTime(one(m, OR('occurredAt'), w), `${w}.occurredAt`);
    const committedAt = dateTime(one(m, OR('committedAt'), w), `${w}.committedAt`);
    const slotCount = integer(one(m, OR('slotCount'), w), `${w}.slotCount`);
    const mig = plain(one(m, IMPORTED_TERMS.migrationId, w), `${w}.migrationId`);
    if (mig !== migrationId) bad(`${w}.migrationId ${mig} is not the allocator's ${migrationId}`);
    const src = sourceJson(plain(one(m, IMPORTED_TERMS.sourceOriginJson, w), `${w}.sourceOriginJson`), `${w}.sourceOriginJson`);
    if (!keysExactly(src, ORIGIN_SOURCE_KEYS)) bad(`${w}.sourceOriginJson must have exactly the keys ${ORIGIN_SOURCE_KEYS.join(', ')}`);
    if (src.mutationId !== mutationId || src.mode !== mode || src.originActor !== originActor) bad(`${w}: a mirror (mutationId, mode or originActor) disagrees with the source`);
    if (!sameInstant(src.occurredAt, occurredAt) || !sameInstant(src.committedAt, committedAt)) bad(`${w}: a time mirror is not the source's instant`);
    const slots = src.slots;
    if (!Array.isArray(slots) || slots.some((s) => typeof s !== 'string' || !SLOT_RE.test(s)) || new Set(slots).size !== slots.length) bad(`${w}: the source slots are not distinct slot names`);
    if (slotCount !== slots.length) bad(`${w}.slotCount ${slotCount} is not the source's ${slots.length} slots`);
    const want = new Map(slots.map((s) => [bare(ORIGIN_TERMS.obligationSubject(mutationId, s)), s]));
    for (const subj of obligationRows.keys()) if (!want.has(subj)) bad(`${w}: an obligation ${subj} exists that is not one of its slots`);
    const obligations = slots.map((slot) => {
      const subj = bare(ORIGIN_TERMS.obligationSubject(mutationId, slot));
      const rows = obligationRows.get(subj);
      if (!rows || !rows.length) bad(`${w}: no obligation for slot ${slot}`);
      return obligationOf(rows, mutationId, slot, mode, migrationId);
    });
    return { ok: true, committed: { kind: 'imported', origin: { mutationId, mode, originActor, occurredAt, committedAt, slotCount, migrationId: mig }, obligations } };
  });
}

function obligationOf(rows, mutationId, slot, mode, migrationId) {
  const w = `imported obligation ${mutationId}/${slot}`;
  const m = byPred(rows);
  closed(m, OB_ALLOWED, w);
  typeIs(m, ORIGIN_TERMS.Obligation, w);
  const obligationId = plain(one(m, OR('obligationId'), w), `${w}.obligationId`);
  if (plain(one(m, OR('slot'), w), `${w}.slot`) !== slot) bad(`${w}: stored slot is not the subject's`);
  if (plain(one(m, OR('mode'), w), `${w}.mode`) !== mode) bad(`${w}: mode is not its origin's ${mode}`);
  const status = plain(one(m, OR('status'), w), `${w}.status`);
  if (!IMPORTED_STATUSES.includes(status)) bad(`${w}.status ${status} is not terminal (${IMPORTED_STATUSES.join(' or ')})`);
  if (plain(one(m, IMPORTED_TERMS.migrationId, w), `${w}.migrationId`) !== migrationId) bad(`${w}.migrationId is not the allocator's`);
  const src = sourceJson(plain(one(m, IMPORTED_TERMS.sourceEntryJson, w), `${w}.sourceEntryJson`), `${w}.sourceEntryJson`);
  if (src.obligationId !== obligationId || src.mutationId !== mutationId || src.slot !== slot || src.mode !== mode) bad(`${w}: a mirror (obligationId, mutationId, slot or mode) disagrees with the source`);
  const term = (p) => { const t = opt(m, p, w); return t === undefined ? undefined : plain(t, `${w}.${p.slice(ORIGIN_NS.length)}`); };
  const reason = term(IMPORTED_TERMS.retirementReason), proof = term(IMPORTED_TERMS.retirementProofPostId);
  const disposition = term(IMPORTED_TERMS.notifyDisposition), note = term(IMPORTED_TERMS.notifyDispositionNote);
  if ((reason === undefined) !== (proof === undefined)) bad(`${w}: retirementReason and retirementProofPostId come together or not at all`);
  if ((disposition === undefined) !== (note === undefined)) bad(`${w}: notifyDisposition and its note come together or not at all`);
  if (reason === undefined) {
    if (status !== src.status) bad(`${w}: status ${status} differs from the source's ${src.status} with no retirement`);
    if (disposition !== undefined) bad(`${w}: a notify disposition with no retirement`);
  } else {
    if (status !== 'published') bad(`${w}: a retired obligation must read published, not ${status}`);
    if (reason === 'legacy-post-verified') {
      if (mode !== 'legacy' || proof !== src.legacyPostId || !proof) bad(`${w}: legacy-post-verified needs a legacy entry whose proof is its legacyPostId`);
      if (disposition !== undefined) bad(`${w}: a legacy retirement carries no notify disposition`);
    } else if (reason === 'publisher-dispatch-disposed') {
      if (mode !== 'publisher' || proof !== announcePostId(mutationId, slot)) bad(`${w}: publisher-dispatch-disposed needs a publisher entry whose proof is its announcement post`);
      if (disposition !== 'disposed-not-sent' || !note) bad(`${w}: publisher-dispatch-disposed needs disposition disposed-not-sent with a non-empty note`);
    } else bad(`${w}.retirementReason ${reason} is not a known reason`);
  }
  // the published post, as the outbox showed it before cutover: the retirement's proof, else the source's own post
  let postId;
  if (status === 'published') {
    postId = proof ?? src.postId ?? src.legacyPostId;
    if (typeof postId !== 'string' || !postId) bad(`${w}: a published obligation names no post`);
    if (reason === undefined && mode === 'publisher' && postId !== announcePostId(mutationId, slot)) bad(`${w}: the source's post ${postId} is not its announcement post`);
  }
  return { obligationId, slot, mode, status, imported: true, ...(postId ? { postId } : {}), ...(reason ? { retirementReason: reason, retirementProofPostId: proof } : {}),
    ...(disposition ? { notifyDisposition: disposition, notifyDispositionNote: note } : {}) };
}
