/**
 * #1629 slice 1 — the `postseq.reserve` primitive. ONE compiler-owned, executor-backed shared allocator across ordinary
 * posts and announcement slots (contract v2 §1, §7 rows A1, A2, DS1; the closed interface in
 * docs/1629-postseq-reserve-slice1-shape.md).
 *
 *   reserveOpId(reservations)             the deterministic opId (lowercase SHA256 of the ordered [mode, postId] vector)
 *   readPostSeqReservation(client, postId) typed reservation readback (ok/UNAVAILABLE/INVALID — never default)
 *   readPostSeqAllocator(client)          typed allocator readback (ok/UNAVAILABLE/INVALID — never default)
 *
 * Compile is wired into core/graph-compiler.mjs; the production compile path goes through `compile(intention)` and the
 * existing staticCheck guard discipline (S1). The executor carries the state: one allocator + reservations under
 * `urn:ex:postseq/` inside `urn:scrum:bookkeeping:executor` (the classifier in core/graph-vocab.mjs), and the receipt
 * on the op IRI it was registered with. Replays are APPLIED via the stored receipt; identical identities with a
 * different draft collide at the same opId and are REJECTED, intent-collision, with NOTHING changed.
 *
 * The slice is isolated: there is NO production initializer or reset API, and the announcement-mode items in this
 * slice do not create an origin or wire a business route. They demonstrate the shared primitive ONLY. Future new-origin
 * allocation (O1) must compose this same allocation plan inside its business+origin+obligation transaction and NOT
 * commit a standalone reservation first. Legacy import/binding, live floor activation, and business-route wiring remain
 * outside slice 1.
 */
import { createHash } from 'node:crypto';
import { postWriteId } from './post-write.mjs';
import { announcePostId } from './announce-outbox.mjs';
import { POSTSEQ_TERMS } from './graph-vocab.mjs';

const PERSON_IRI = 'https://scrumboard.local/person/';
const BK = `<urn:scrum:bookkeeping:executor>`;
const XSD = 'http://www.w3.org/2001/XMLSchema#';

/**
 * The derived postId for one reservation item, by the EXISTING v2 UUIDv5 rule (post.write for ordinary,
 * announce-outbox for announcement). Exported so callers that build the int identity (the route / planner) read the
 * same id the opId hash binds.
 */
export function postIdOfItem(item) {
  if (!item || typeof item !== 'object') throw new TypeError('reservation item must be an object');
  if (item.mode === 'ordinary') return postWriteId(item.author, item.requestId);
  if (item.mode === 'announcement') return announcePostId(item.mutationId, item.slot);
  throw new TypeError(`unknown reservation mode: ${item.mode}`);
}

/**
 * The identity vector of one reservation batch: `[[mode, postId], ...]` in INPUT order, NOT sorted. The opId is the
 * lowercase SHA256 of `JSON.stringify` over this array, prefixed `urn:ex:op/postseq/reserve/`. Drafts, actor, time,
 * and sequence are excluded by construction: a changed draft for the same ordered identities collides at the SAME opId
 * (DS1) rather than getting a fresh reservation.
 */
export function reserveOpId(reservations) {
  if (!Array.isArray(reservations) || reservations.length === 0) throw new TypeError('reservations must be a non-empty array');
  const id = reservations.map((r, k) => {
    if (!r || typeof r !== 'object') throw new TypeError(`reservations[${k}] must be an object`);
    if (r.mode !== 'ordinary' && r.mode !== 'announcement') throw new TypeError(`reservations[${k}].mode must be ordinary or announcement`);
    return [r.mode, postIdOfItem(r)];
  });
  const body = createHash('sha256').update(JSON.stringify(id)).digest('hex');
  return `${POSTSEQ_TERMS.OP_PREFIX}${body}`;
}

// ── closed schema validation (reused by canonicalize and the readers' write-back contract) ──

const ORDINARY_KEYS = ['body', 'attachedTo', 'mentions', 'attachments', 'conversation', 'onBehalfOf', 'recovered', 'opId', 'origin', 'originalAuthorToken', 'authorCorrectedAt', 'authorCorrectedBy'];
const ANNOUNCEMENT_KEYS = ['body', 'author', 'originActor', 'occurredAt', 'mentions', 'notify'];

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isStr = (v) => typeof v === 'string' && v.isWellFormed();

function validateOrdinaryDraft(d, what) {
  if (!isObj(d)) throw new TypeError(`${what} must be an object`);
  for (const k of Object.keys(d)) if (!ORDINARY_KEYS.includes(k)) throw new TypeError(`${what}: unknown key ${k}`);
  if (typeof d.body !== 'string' || !d.body) throw new TypeError(`${what}.body is required`);
  if (d.attachedTo != null && !isStr(d.attachedTo)) throw new TypeError(`${what}.attachedTo must be a string or null`);
  if (d.mentions != null && (!Array.isArray(d.mentions) || d.mentions.some((m) => !isStr(m)))) throw new TypeError(`${what}.mentions must be an array of strings`);
  if (d.attachments != null && (!Array.isArray(d.attachments))) throw new TypeError(`${what}.attachments must be an array`);
  if (d.attachments) d.attachments.forEach((a, k) => {
    if (!isObj(a)) throw new TypeError(`${what}.attachments[${k}] must be an object`);
    for (const ak of Object.keys(a)) if (!['id', 'mime', 'name', 'size'].includes(ak)) throw new TypeError(`${what}.attachments[${k}]: unknown key ${ak}`);
    if (typeof a.id !== 'string') throw new TypeError(`${what}.attachments[${k}].id is required`);
  });
  if (d.conversation != null && !isStr(d.conversation)) throw new TypeError(`${what}.conversation must be a string or null`);
  if (d.onBehalfOf != null && !isStr(d.onBehalfOf)) throw new TypeError(`${what}.onBehalfOf must be a string or null`);
  if (d.recovered != null && !isStr(d.recovered)) throw new TypeError(`${what}.recovered must be a string or null`);
  if (d.opId != null && !isStr(d.opId)) throw new TypeError(`${what}.opId must be a string or null`);
  if (d.origin != null) {
    if (!isObj(d.origin)) throw new TypeError(`${what}.origin must be an object`);
    for (const k of Object.keys(d.origin)) if (!['mutationId', 'slot'].includes(k)) throw new TypeError(`${what}.origin: unknown key ${k}`);
    if (typeof d.origin.mutationId !== 'string') throw new TypeError(`${what}.origin.mutationId is required`);
    if (typeof d.origin.slot !== 'string') throw new TypeError(`${what}.origin.slot is required`);
  }
  if (d.originalAuthorToken != null && !isStr(d.originalAuthorToken)) throw new TypeError(`${what}.originalAuthorToken must be a string or null`);
  if (d.authorCorrectedAt != null && !isStr(d.authorCorrectedAt)) throw new TypeError(`${what}.authorCorrectedAt must be a string or null`);
  if (d.authorCorrectedBy != null && !isStr(d.authorCorrectedBy)) throw new TypeError(`${what}.authorCorrectedBy must be a string or null`);
}

function validateAnnouncementDraft(d, what) {
  if (!isObj(d)) throw new TypeError(`${what} must be an object`);
  for (const k of Object.keys(d)) if (!ANNOUNCEMENT_KEYS.includes(k)) throw new TypeError(`${what}: unknown key ${k}`);
  if (typeof d.body !== 'string' || !d.body) throw new TypeError(`${what}.body is required`);
  if (typeof d.author !== 'string' || !d.author) throw new TypeError(`${what}.author is required`);
  if (typeof d.originActor !== 'string' || !d.originActor) throw new TypeError(`${what}.originActor is required`);
  if (typeof d.occurredAt !== 'string' || !d.occurredAt) throw new TypeError(`${what}.occurredAt is required`);
  if (!Array.isArray(d.mentions) || d.mentions.some((m) => !isStr(m))) throw new TypeError(`${what}.mentions must be an array of strings`);
  if (typeof d.notify !== 'boolean') throw new TypeError(`${what}.notify must be a boolean`);
}

/**
 * Validate a single reservation item and return a canonical form. Ordinary carries `author`+`requestId` at the item
 * (per the shape); announcement carries `mutationId`+`slot`. The id is the derived postId. Derived/canonical fields are
 * NOT inputs (forbidden by the schema).
 */
export function canonReservationItem(it, what) {
  if (!isObj(it)) throw new TypeError(`${what} must be an object`);
  if (it.mode === 'ordinary') {
    for (const k of Object.keys(it)) if (!['mode', 'author', 'requestId', 'draft'].includes(k)) throw new TypeError(`${what}: unknown key ${k}`);
    if (typeof it.author !== 'string' || !it.author) throw new TypeError(`${what}.author is required`);
    if (typeof it.requestId !== 'string' || !it.requestId) throw new TypeError(`${what}.requestId is required`);
    validateOrdinaryDraft(it.draft, `${what}.draft`);
    return { mode: 'ordinary', author: it.author, requestId: it.requestId, draft: it.draft, postId: postWriteId(it.author, it.requestId) };
  }
  if (it.mode === 'announcement') {
    for (const k of Object.keys(it)) if (!['mode', 'mutationId', 'slot', 'draft'].includes(k)) throw new TypeError(`${what}: unknown key ${k}`);
    if (typeof it.mutationId !== 'string' || !it.mutationId) throw new TypeError(`${what}.mutationId is required`);
    if (typeof it.slot !== 'string' || !it.slot) throw new TypeError(`${what}.slot is required`);
    validateAnnouncementDraft(it.draft, `${what}.draft`);
    return { mode: 'announcement', mutationId: it.mutationId, slot: it.slot, draft: it.draft, postId: announcePostId(it.mutationId, it.slot) };
  }
  throw new TypeError(`${what}.mode must be ordinary or announcement`);
}

/**
 * Canonical form of a reservation batch — same items, the same opId, and a canonical, sorted-by-postId identity map for
 * the digest. The batch identity the shape names is the ORDERED [mode, postId] vector (NOT sorted); the digest binds
 * that ordered vector, so a draft change for the same identities is the same digest. The reader never sees the sorted
 * form; it is purely for the hash input.
 */
export function canonReservationBatch(reservations, what = 'reservations') {
  if (!Array.isArray(reservations) || reservations.length === 0) throw new TypeError(`${what} must be a non-empty array`);
  const items = reservations.map((r, k) => canonReservationItem(r, `${what}[${k}]`));
  const seen = new Set();
  for (const it of items) {
    if (seen.has(it.postId)) throw new TypeError(`${what}: duplicate derived postId ${it.postId}`);
    seen.add(it.postId);
  }
  return items;
}

// ── the canonical digest body: ordered [mode, postId] + every canonical draft field, no executor-assigned values ──

function canonDraftForDigest(d, mode) {
  if (mode === 'ordinary') {
    return {
      body: d.body,
      attachedTo: d.attachedTo ?? null,
      mentions: [...(d.mentions ?? [])].sort(),
      conversation: d.conversation ?? null,
      onBehalfOf: d.onBehalfOf ?? null,
    };
  }
  return {
    body: d.body,
    author: d.author,
    originActor: d.originActor,
    occurredAt: d.occurredAt,
    mentions: [...(d.mentions ?? [])].sort(),
    notify: d.notify,
  };
}

/**
 * The digest body of a postseq.reserve intention. Excludes executor-assigned fields (postSeq, createdAt, allocator
 * version, etc.) so the executor's published reserveDigest is unchanged by any of those. Includes the opId so the digest
 * is content-bound: two intentions with the same opId and different drafts collide at compile time (DS1).
 */
export function reserveDigestBody(items) {
  return {
    items: items.map((it) => ({
      mode: it.mode,
      postId: it.postId,
      identity: it.mode === 'ordinary'
        ? { author: it.author, requestId: it.requestId }
        : { mutationId: it.mutationId, slot: it.slot },
      draft: canonDraftForDigest(it.draft, it.mode),
    })),
  };
}

// ── reader helpers: typed reads, no defaulting, no repair, no clock substitution ──

function val(b, name) {
  const t = b?.[name];
  if (!t || t.type !== 'literal' || typeof t.value !== 'string') throw new Error(`binding ${name} is missing or not a plain literal`);
  return t.value;
}
function iriOf(b, name) {
  const t = b?.[name];
  if (!t || t.type !== 'uri' || typeof t.value !== 'string') throw new Error(`binding ${name} is missing or not an IRI`);
  return t.value;
}
const XSD_INT = 'http://www.w3.org/2001/XMLSchema#integer';
const XSD_DT = 'http://www.w3.org/2001/XMLSchema#dateTime';
function intOf(b, name) {
  const t = b?.[name];
  if (!t || t.type !== 'literal' || typeof t.value !== 'string') throw new Error(`binding ${name} is missing or not a literal`);
  if (t.datatype != null && t.datatype !== XSD_INT) throw new Error(`binding ${name} is typed ${t.datatype}, not xsd:integer`);
  if (!/^-?\d+$/.test(t.value) || !Number.isSafeInteger(Number(t.value))) throw new Error(`binding ${name} is not a safe integer: ${t.value}`);
  return Number(t.value);
}
function dateOf(b, name) {
  const t = b?.[name];
  if (!t || t.type !== 'literal' || typeof t.value !== 'string') throw new Error(`binding ${name} is missing or not a literal`);
  if (t.datatype != null && t.datatype !== XSD_DT) throw new Error(`binding ${name} is typed ${t.datatype}, not xsd:dateTime`);
  const ms = Date.parse(t.value);
  if (!Number.isFinite(ms)) throw new Error(`binding ${name} is not an xsd:dateTime: ${t.value}`);
  return t.value;
}

/** A safe-integer check that an executor-side nextPostSeq is positive and finite. */
function isPosSafeInt(n) {
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
}

const RESERVATION_SPARQL = (postIdTerm) => `SELECT ?mode ?postId ?reserveOpId ?reserveDigest ?postSeqEpoch ?postSeq ?createdAt ?index ?identityJson ?draftJson WHERE {
  GRAPH ${BK} {
    ${postIdTerm} a ${POSTSEQ_TERMS.Reservation} ; ${POSTSEQ_TERMS.mode} ?mode ; ${POSTSEQ_TERMS.postId} ?postId ; ${POSTSEQ_TERMS.reserveOpId} ?reserveOpId ; ${POSTSEQ_TERMS.reserveDigest} ?reserveDigest ; ${POSTSEQ_TERMS.postSeqEpoch} ?postSeqEpoch ; ${POSTSEQ_TERMS.postSeq} ?postSeq ; ${POSTSEQ_TERMS.createdAt} ?createdAt ; ${POSTSEQ_TERMS.index} ?index ; ${POSTSEQ_TERMS.identityJson} ?identityJson ; ${POSTSEQ_TERMS.draftJson} ?draftJson .
  }
}`;

const ALLOCATOR_SPARQL = `SELECT ?postSeqEpoch ?nextPostSeq ?version WHERE {
  GRAPH ${BK} { ${POSTSEQ_TERMS.allocator} a ${POSTSEQ_TERMS.Allocator} ; ${POSTSEQ_TERMS.postSeqEpoch} ?postSeqEpoch ; ${POSTSEQ_TERMS.nextPostSeq} ?nextPostSeq ; ${POSTSEQ_TERMS.version} ?version . }
}`;

/**
 * One reservation row. `{ok:true, reservation: null}` when the postId has no reservation; `{ok:false, status:'INVALID', reason}`
 * when the row is malformed/duplicate (a writer bug); `{ok:false, status:'UNAVAILABLE', reason}` when the read itself
 * failed. Strict on cardinality: one row → ok, zero rows → null, two rows → INVALID (never silently picks one).
 */
export async function readPostSeqReservation(client, postId) {
  if (!isStr(postId)) return { ok: false, status: 'INVALID', reason: 'postId is not a well-formed string' };
  const subj = POSTSEQ_TERMS.reservation(postId);
  const r = await client.query(RESERVATION_SPARQL(subj));
  if (!r.ok) return { ok: false, status: 'UNAVAILABLE', reason: r.reason };
  const rows = r.rows;
  if (rows.length === 0) return { ok: true, reservation: null };
  if (rows.length > 1) return { ok: false, status: 'INVALID', reason: `reservation for ${postId} has ${rows.length} rows (duplicate stored reservation)` };
  try {
    const b = rows[0];
    const mode = val(b, 'mode');
    if (mode !== 'ordinary' && mode !== 'announcement') return { ok: false, status: 'INVALID', reason: `reservation mode ${mode} is not ordinary or announcement` };
    const storedPostId = val(b, 'postId');
    if (storedPostId !== postId) return { ok: false, status: 'INVALID', reason: `stored postId ${storedPostId} does not match subject ${postId}` };
    const reserveOpId = iriOf(b, 'reserveOpId');
    const reserveDigest = val(b, 'reserveDigest');
    const postSeqEpoch = val(b, 'postSeqEpoch');
    const postSeq = intOf(b, 'postSeq');
    if (!isPosSafeInt(postSeq)) return { ok: false, status: 'INVALID', reason: `postSeq ${postSeq} is not a positive safe integer` };
    const createdAt = dateOf(b, 'createdAt');
    const index = intOf(b, 'index');
    if (index < 0) return { ok: false, status: 'INVALID', reason: `index ${index} must be >= 0` };
    const identityJson = val(b, 'identityJson');
    const draftJson = val(b, 'draftJson');
    let identity, draft;
    try { identity = JSON.parse(identityJson); } catch (e) { return { ok: false, status: 'INVALID', reason: `identityJson is not parseable JSON: ${e.message}` }; }
    try { draft = JSON.parse(draftJson); } catch (e) { return { ok: false, status: 'INVALID', reason: `draftJson is not parseable JSON: ${e.message}` }; }
    return { ok: true, reservation: { postId: storedPostId, mode, reserveOpId, reserveDigest, postSeqEpoch, postSeq, createdAt, index, draft, identity } };
  } catch (e) {
    return { ok: false, status: 'INVALID', reason: e.message };
  }
}

/**
 * One allocator row. Returns `{ok:true, allocator}` or `{ok:false, status:'INVALID'|'UNAVAILABLE'}`. Strict: one row only,
 * `nextPostSeq` positive safe integer, `version` positive safe integer, `postSeqEpoch` non-empty. No defaulting.
 */
export async function readPostSeqAllocator(client) {
  const r = await client.query(ALLOCATOR_SPARQL);
  if (!r.ok) return { ok: false, status: 'UNAVAILABLE', reason: r.reason };
  const rows = r.rows;
  if (rows.length === 0) return { ok: false, status: 'INVALID', reason: 'no allocator tuple' };
  if (rows.length > 1) return { ok: false, status: 'INVALID', reason: `allocator has ${rows.length} tuples (multiple stored allocators)` };
  try {
    const b = rows[0];
    const postSeqEpoch = val(b, 'postSeqEpoch');
    if (!postSeqEpoch) return { ok: false, status: 'INVALID', reason: 'postSeqEpoch is empty' };
    const nextPostSeq = intOf(b, 'nextPostSeq');
    if (!isPosSafeInt(nextPostSeq)) return { ok: false, status: 'INVALID', reason: `nextPostSeq ${nextPostSeq} is not a positive safe integer` };
    const version = intOf(b, 'version');
    if (!isPosSafeInt(version)) return { ok: false, status: 'INVALID', reason: `version ${version} is not a positive safe integer` };
    return { ok: true, allocator: { postSeqEpoch, nextPostSeq, version } };
  } catch (e) {
    return { ok: false, status: 'INVALID', reason: e.message };
  }
}

// export a small helper for tests and readers that need the actor IRI shape
export const postseqActorIri = (seat) => `${PERSON_IRI}${seat}`;