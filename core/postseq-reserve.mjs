/**
 * #1629 slice 1 — the `postseq.reserve` primitive. ONE compiler-owned, executor-backed shared allocator across ordinary
 * posts and announcement slots (contract v2 §1, §7 rows A1, A2, DS1; the closed interface in
 * docs/1629-postseq-reserve-slice1-shape.md).
 *
 *   reserveOpId(reservations)             the deterministic opId (lowercase SHA256 of the ordered [mode, postId] vector)
 *   readPostSeqReservation(client, postId) typed reservation readback (ok/UNAVAILABLE/INVALID — never default)
 *   readPostSeqAllocator(client)          typed allocator readback (ok/UNAVAILABLE/INVALID/RECOVERY_HOLD — never default)
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
// every input string is well-formed text, the same rule post.write's rStr applies (a lone surrogate is refused BEFORE
// anything is sent, so the allocator can never commit a reservation its own reader would call INVALID).
const isStr = (v) => typeof v === 'string' && v.isWellFormed();
const isNonEmpty = (v) => isStr(v) && v !== '';
// closed keysets compare OWN keys against an array, never `k in obj`: a JSON-parsed `constructor`/`toString`/`__proto__`
// key is an own key that must be refused, not matched against Object.prototype.
const closed = (o, allowed, what) => { for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new TypeError(`${what}: unknown key ${k}`); };

function canonAttachment(a, what) {
  if (!isObj(a)) throw new TypeError(`${what} must be an object`);
  closed(a, ['id', 'mime', 'name', 'size'], what);
  // the same members post.write requires: all four present, strings well-formed, size a non-negative safe integer
  // (no null member is accepted, so nothing reserved here can be refused when it is later published)
  if (!isStr(a.id)) throw new TypeError(`${what}.id must be a well-formed string`);
  if (!isStr(a.mime)) throw new TypeError(`${what}.mime must be a well-formed string`);
  if (!isStr(a.name)) throw new TypeError(`${what}.name must be a well-formed string`);
  if (!Number.isSafeInteger(a.size) || a.size < 0) throw new TypeError(`${what}.size must be a non-negative safe integer`);
  const { mime, name, size } = a;
  return { id: a.id, mime, name, size };
}

function canonOrigin(o, what) {
  if (!isObj(o)) throw new TypeError(`${what} must be an object`);
  // the same keyset post.write accepts (graph-compiler.mjs post.import/post.write: mutationId, slot, optional occurredAt).
  // occurredAt is bound and stored when present; absent and null are the same (rOpt there), so both canonicalize to absent.
  closed(o, ['mutationId', 'slot', 'occurredAt'], what);
  if (!isStr(o.mutationId)) throw new TypeError(`${what}.mutationId is required`);
  if (!isStr(o.slot)) throw new TypeError(`${what}.slot is required`);
  if (o.occurredAt != null && !isStr(o.occurredAt)) throw new TypeError(`${what}.occurredAt must be a string or null`);
  return o.occurredAt == null ? { mutationId: o.mutationId, slot: o.slot } : { mutationId: o.mutationId, slot: o.slot, occurredAt: o.occurredAt };
}

function validateOrdinaryDraft(d, what) {
  if (!isObj(d)) throw new TypeError(`${what} must be an object`);
  closed(d, ORDINARY_KEYS, what);
  if (!isNonEmpty(d.body)) throw new TypeError(`${what}.body is required`);
  if (d.attachedTo != null && !isStr(d.attachedTo)) throw new TypeError(`${what}.attachedTo must be a string or null`);
  if (d.mentions != null && (!Array.isArray(d.mentions) || d.mentions.some((m) => !isStr(m)))) throw new TypeError(`${what}.mentions must be an array of strings`);
  if (d.attachments != null && (!Array.isArray(d.attachments))) throw new TypeError(`${what}.attachments must be an array`);
  if (d.attachments) d.attachments.forEach((a, k) => canonAttachment(a, `${what}.attachments[${k}]`));
  if (d.conversation != null && !isStr(d.conversation)) throw new TypeError(`${what}.conversation must be a string or null`);
  if (d.onBehalfOf != null && !isStr(d.onBehalfOf)) throw new TypeError(`${what}.onBehalfOf must be a string or null`);
  if (d.recovered != null && !isStr(d.recovered)) throw new TypeError(`${what}.recovered must be a string or null`);
  if (d.opId != null && !isStr(d.opId)) throw new TypeError(`${what}.opId must be a string or null`);
  if (d.origin != null) canonOrigin(d.origin, `${what}.origin`);
  if (d.originalAuthorToken != null && !isStr(d.originalAuthorToken)) throw new TypeError(`${what}.originalAuthorToken must be a string or null`);
  if (d.authorCorrectedAt != null && !isStr(d.authorCorrectedAt)) throw new TypeError(`${what}.authorCorrectedAt must be a string or null`);
  if (d.authorCorrectedBy != null && !isStr(d.authorCorrectedBy)) throw new TypeError(`${what}.authorCorrectedBy must be a string or null`);
}

function validateAnnouncementDraft(d, what) {
  if (!isObj(d)) throw new TypeError(`${what} must be an object`);
  closed(d, ANNOUNCEMENT_KEYS, what);
  if (!isNonEmpty(d.body)) throw new TypeError(`${what}.body is required`);
  if (!isNonEmpty(d.author)) throw new TypeError(`${what}.author is required`);
  if (!isNonEmpty(d.originActor)) throw new TypeError(`${what}.originActor is required`);
  if (!isNonEmpty(d.occurredAt)) throw new TypeError(`${what}.occurredAt is required`);
  if (!Array.isArray(d.mentions) || d.mentions.some((m) => !isStr(m))) throw new TypeError(`${what}.mentions must be an array of strings`);
  if (typeof d.notify !== 'boolean') throw new TypeError(`${what}.notify must be a boolean`);
}

/**
 * The FROZEN canonical ordinary draft — every accepted field, normalized, key order FIXED so two intentions with
 * the same content (key order independent) canonicalize to the same bytes. attachments are PRESERVED IN INPUT ORDER
 * (the contract says nothing reorders them by default; mentions are the only documented-unordered array). The SAME
 * shape is what the compiler stores as `draftJson` and what the reader surfaces — the stored reservation is the
 * FROZEN draft, never a digest-only object.
 */
export function canonOrdinaryDraft(d) {
  const mentions = d.mentions ? [...d.mentions].sort() : [];
  const attachments = (d.attachments ?? []).map((a, k) => canonAttachment(a, `attachments[${k}]`));
  return {
    body: d.body,
    attachedTo: d.attachedTo ?? null,
    mentions,
    attachments,
    conversation: d.conversation ?? null,
    onBehalfOf: d.onBehalfOf ?? null,
    recovered: d.recovered ?? null,
    opId: d.opId ?? null,
    origin: d.origin ? canonOrigin(d.origin, 'origin') : null,
    originalAuthorToken: d.originalAuthorToken ?? null,
    authorCorrectedAt: d.authorCorrectedAt ?? null,
    authorCorrectedBy: d.authorCorrectedBy ?? null,
  };
}

export function canonAnnouncementDraft(d) {
  return {
    body: d.body,
    author: d.author,
    originActor: d.originActor,
    occurredAt: d.occurredAt,
    mentions: [...d.mentions].sort(),
    notify: d.notify,
  };
}

/**
 * Validate a single reservation item and return a canonical form. Ordinary carries `author`+`requestId` at the item
 * (per the shape); announcement carries `mutationId`+`slot`. The id is the derived postId. Derived/canonical fields are
 * NOT inputs (forbidden by the schema). The stored draft is the FROZEN canonical form returned here (every accepted
 * field, normalized), so a roundtrip read surfaces exactly what was sent.
 */
export function canonReservationItem(it, what) {
  if (!isObj(it)) throw new TypeError(`${what} must be an object`);
  if (it.mode === 'ordinary') {
    closed(it, ['mode', 'author', 'requestId', 'draft'], what);
    if (!isNonEmpty(it.author)) throw new TypeError(`${what}.author must be a non-empty well-formed string`);
    if (!isNonEmpty(it.requestId)) throw new TypeError(`${what}.requestId must be a non-empty well-formed string`);
    validateOrdinaryDraft(it.draft, `${what}.draft`);
    const draft = canonOrdinaryDraft(it.draft);
    return { mode: 'ordinary', author: it.author, requestId: it.requestId, draft, postId: postWriteId(it.author, it.requestId) };
  }
  if (it.mode === 'announcement') {
    closed(it, ['mode', 'mutationId', 'slot', 'draft'], what);
    if (!isNonEmpty(it.mutationId)) throw new TypeError(`${what}.mutationId must be a non-empty well-formed string`);
    if (!isNonEmpty(it.slot)) throw new TypeError(`${what}.slot must be a non-empty well-formed string`);
    validateAnnouncementDraft(it.draft, `${what}.draft`);
    const draft = canonAnnouncementDraft(it.draft);
    return { mode: 'announcement', mutationId: it.mutationId, slot: it.slot, draft, postId: announcePostId(it.mutationId, it.slot) };
  }
  throw new TypeError(`${what}.mode must be ordinary or announcement`);
}

/**
 * Canonical form of a reservation batch: the items in INPUT order, each validated and canonicalized, with duplicate
 * derived postIds refused. The opId binds the ordered [mode, postId] vector only, so a changed draft for the same
 * identities keeps the SAME opId; the digest binds the ordered identities AND every canonical draft field, so that
 * changed draft has a DIFFERENT digest and collides at the receipt (DS1). Nothing here is sorted except `mentions`.
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
//
// The digest body BINDs EVERY accepted field (P1, REVIEW-FIX-1629): a changed attachment id, a changed nested
// origin field, a recovered token — all change the digest (DS1: a changed draft for the same identities is a
// different digest, the same opId; intent-collision). The shape of each draft here is the SAME frozen shape the
// compiler stores as `draftJson` and the reader surfaces — content-bound, not digest-only.

export function reserveDigestBody(items) {
  return {
    items: items.map((it) => ({
      mode: it.mode,
      postId: it.postId,
      identity: it.mode === 'ordinary'
        ? { author: it.author, requestId: it.requestId }
        : { mutationId: it.mutationId, slot: it.slot },
      draft: it.draft,
    })),
  };
}

// ── reader helpers: typed reads, no defaulting, no repair, no clock substitution ──
//
// The readers are STRICT on cardinality, term identity, JSON content and exact datatype. A partially present
// Reservation (the type triple but not the predicates the contract binds) is INVALID, never `{ok:true, reservation:null}` —
// a missing row and a partial row are different observations. Mismatched identity/draft in the stored JSON is INVALID —
// the reader does not accept arbitrary parsed JSON. Multiple allocator subjects are INVALID — never pick one.

function val(b, name) {
  const t = b?.[name];
  if (!t || t.type !== 'literal' || typeof t.value !== 'string') throw new Error(`binding ${name} is missing or not a plain literal`);
  return t.value;
}
// postSeqEpoch is a PLAIN string literal: no language tag, no datatype other than xsd:string (an IRI, a
// lang-tagged literal or a typed number is a different term and is INVALID, never coerced to its lexical form).
function epochOf(b, name) {
  const t = b?.[name];
  if (!t || t.type !== 'literal' || typeof t.value !== 'string') throw new Error(`binding ${name} is missing or not a literal`);
  if (t['xml:lang'] != null) throw new Error(`binding ${name} is language-tagged; a plain string literal is required`);
  if (t.datatype != null && t.datatype !== `${XSD}string`) throw new Error(`binding ${name} is typed ${t.datatype}; a plain string literal is required`);
  if (!t.value) throw new Error(`binding ${name} is empty`);
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
  if (t.datatype == null) throw new Error(`binding ${name} has no datatype; an exact xsd:integer term is required (no bare numeric literals, no xsd:string, no xsd:long)`);
  if (t.datatype !== XSD_INT) throw new Error(`binding ${name} is typed ${t.datatype}, not xsd:integer`);
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

// The full reservation row pattern: every predicate the contract binds must be present. A partial row (only the type
// triple, or only some of the predicates) will not match this pattern → the partial-shape query below will catch it.
const RESERVATION_SPARQL = (postIdTerm) => `SELECT ?mode ?postId ?reserveOpId ?reserveDigest ?postSeqEpoch ?postSeq ?createdAt ?index ?identityJson ?draftJson WHERE {
  GRAPH ${BK} {
    ${postIdTerm} a ${POSTSEQ_TERMS.Reservation} ; ${POSTSEQ_TERMS.mode} ?mode ; ${POSTSEQ_TERMS.postId} ?postId ; ${POSTSEQ_TERMS.reserveOpId} ?reserveOpId ; ${POSTSEQ_TERMS.reserveDigest} ?reserveDigest ; ${POSTSEQ_TERMS.postSeqEpoch} ?postSeqEpoch ; ${POSTSEQ_TERMS.postSeq} ?postSeq ; ${POSTSEQ_TERMS.createdAt} ?createdAt ; ${POSTSEQ_TERMS.index} ?index ; ${POSTSEQ_TERMS.identityJson} ?identityJson ; ${POSTSEQ_TERMS.draftJson} ?draftJson .
  }
}`;

// Partial-shape: asks whether ANY triple has the reservation SUBJECT in the bookkeeping graph. Run only when the
// full-row pattern found nothing, so `true` means a partial row (with or without the type triple): a writer bug,
// never "missing".
const RESERVATION_PARTIAL_SPARQL = (postIdTerm) => `ASK {
  GRAPH ${BK} {
    ${postIdTerm} ?p ?o .
  }
}`;

const ALLOCATOR_SPARQL = `SELECT ?postSeqEpoch ?nextPostSeq ?version WHERE {
  GRAPH ${BK} { ${POSTSEQ_TERMS.allocator} a ${POSTSEQ_TERMS.Allocator} ; ${POSTSEQ_TERMS.postSeqEpoch} ?postSeqEpoch ; ${POSTSEQ_TERMS.nextPostSeq} ?nextPostSeq ; ${POSTSEQ_TERMS.version} ?version . }
}`;

// Multi-subject detection: the cardinality MUST be over TERM identity (different allocator subjects are different
// terms, never value-equal). This SELECT returns one row per distinct Allocator subject.
const ALLOCATOR_SUBJECTS_SPARQL = `SELECT ?x_alloc WHERE { GRAPH ${BK} { ?x_alloc a ${POSTSEQ_TERMS.Allocator} . } }`;

// Per-predicate cardinality on the single allocator subject: one row per (predicate, object) pair, so a duplicate
// nextPostSeq/version/postSeqEpoch triple with a different OBJECT term yields TWO rows for that predicate. Counts
// > 1 on any of the three are a writer bug — a partial / duplicated allocator must NEVER silently coerce. The
// comparison is over TERM IDENTITY (`!sameTerm`), so a different numeric datatype with the same lexical value
// cannot evade the duplicate check (P2: sameTerm, not value inequality).
const ALLOCATOR_TUPLE_CARD_SPARQL = `SELECT ?pred WHERE {
  GRAPH ${BK} {
    { ${POSTSEQ_TERMS.allocator} ${POSTSEQ_TERMS.nextPostSeq} ?nx1 . ${POSTSEQ_TERMS.allocator} ${POSTSEQ_TERMS.nextPostSeq} ?nx2 FILTER(!sameTerm(?nx1, ?nx2)) BIND(${POSTSEQ_TERMS.nextPostSeq} AS ?pred) }
    UNION
    { ${POSTSEQ_TERMS.allocator} ${POSTSEQ_TERMS.version} ?vx1 . ${POSTSEQ_TERMS.allocator} ${POSTSEQ_TERMS.version} ?vx2 FILTER(!sameTerm(?vx1, ?vx2)) BIND(${POSTSEQ_TERMS.version} AS ?pred) }
    UNION
    { ${POSTSEQ_TERMS.allocator} ${POSTSEQ_TERMS.postSeqEpoch} ?ex1 . ${POSTSEQ_TERMS.allocator} ${POSTSEQ_TERMS.postSeqEpoch} ?ex2 FILTER(!sameTerm(?ex1, ?ex2)) BIND(${POSTSEQ_TERMS.postSeqEpoch} AS ?pred) }
  }
}`;

/**
 * One reservation row. `{ok:true, reservation: null}` when the postId has no reservation AT ALL (no partial, no
 * duplicates); `{ok:false, status:'INVALID', reason}` when the row is malformed/duplicate/partial/mismatched-identity-or-draft
 * (a writer bug); `{ok:false, status:'UNAVAILABLE', reason}` when the read itself failed. Never silently picks one.
 */
export async function readPostSeqReservation(client, postId) {
  if (!isStr(postId)) return { ok: false, status: 'INVALID', reason: 'postId is not a well-formed string' };
  const subj = POSTSEQ_TERMS.reservation(postId);
  const r = await client.query(RESERVATION_SPARQL(subj));
  if (!r.ok) return { ok: false, status: 'UNAVAILABLE', reason: r.reason };
  const rows = r.rows;
  if (rows.length > 1) return { ok: false, status: 'INVALID', reason: `reservation for ${postId} has ${rows.length} rows (duplicate stored reservation)` };
  if (rows.length === 1) {
    try {
      const b = rows[0];
      const mode = val(b, 'mode');
      if (mode !== 'ordinary' && mode !== 'announcement') return { ok: false, status: 'INVALID', reason: `reservation mode ${mode} is not ordinary or announcement` };
      const storedPostId = val(b, 'postId');
      if (storedPostId !== postId) return { ok: false, status: 'INVALID', reason: `stored postId ${storedPostId} does not match subject ${postId}` };
      const reserveOpId = iriOf(b, 'reserveOpId');
      const reserveDigest = val(b, 'reserveDigest');
      const postSeqEpoch = epochOf(b, 'postSeqEpoch');
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
      // The identity is a CLOSED object: exactly {author, requestId} (ordinary) or {mutationId, slot} (announcement),
      // non-empty well-formed strings, and the postId it derives must be the stored postId. The draft is the FROZEN
      // canonical form: it must pass the same closed schema as an input draft AND be byte-identical to its own
      // canonicalization, so a draft the compiler could not have written is INVALID rather than surfaced.
      const idKeys = mode === 'ordinary' ? ['author', 'requestId'] : ['mutationId', 'slot'];
      if (!isObj(identity) || Object.keys(identity).length !== idKeys.length || !idKeys.every((k) => isNonEmpty(identity[k]))) {
        return { ok: false, status: 'INVALID', reason: `${mode} identity must be exactly {${idKeys.join(', ')}} with non-empty strings; got ${JSON.stringify(identity)}` };
      }
      const derived = mode === 'ordinary' ? postWriteId(identity.author, identity.requestId) : announcePostId(identity.mutationId, identity.slot);
      if (derived !== storedPostId) return { ok: false, status: 'INVALID', reason: `identity derives postId ${derived}, not the stored ${storedPostId}` };
      try {
        if (mode === 'ordinary') validateOrdinaryDraft(draft, 'stored draft'); else validateAnnouncementDraft(draft, 'stored draft');
      } catch (e) { return { ok: false, status: 'INVALID', reason: `stored draft fails the closed schema: ${e.message}` }; }
      const frozen = JSON.stringify(mode === 'ordinary' ? canonOrdinaryDraft(draft) : canonAnnouncementDraft(draft));
      if (frozen !== draftJson) return { ok: false, status: 'INVALID', reason: 'stored draft is not the frozen canonical draft (its bytes differ from its own canonicalization)' };
      return { ok: true, reservation: { postId: storedPostId, mode, reserveOpId, reserveDigest, postSeqEpoch, postSeq, createdAt, index, draft, identity } };
    } catch (e) {
      return { ok: false, status: 'INVALID', reason: e.message };
    }
  }
  // rows.length === 0: probe whether the partial-shape IS present (only the type triple), so partial ≠ missing.
  const pr = await client.ask(RESERVATION_PARTIAL_SPARQL(subj));
  if (!pr.ok) return { ok: false, status: 'UNAVAILABLE', reason: pr.reason };
  if (pr.boolean) return { ok: false, status: 'INVALID', reason: `reservation for ${postId} is partially present (the type triple exists but the bound predicates are missing — a writer bug, never treated as missing)` };
  return { ok: true, reservation: null };
}

/**
 * One allocator tuple. Returns `{ok:true, allocator}` or `{ok:false, status:'INVALID'|'UNAVAILABLE'}`. Strict: exactly
 * ONE allocator subject in the bookkeeping graph (multiple -> INVALID, never silently pick one), `nextPostSeq` and
 * `version` are exact xsd:integer (no value-inequality escape), positive and safe, `postSeqEpoch` non-empty.
 */
export async function readPostSeqAllocator(client) {
  // #1749 a promoted restore that is not yet reconciled: the allocator is NOT usable, whatever it holds, so it is never
  // reported as if it were (the allocator guard refuses the same state with RECOVERY_HOLD)
  const held = await client.ask(`ASK { GRAPH ${BK} { ${POSTSEQ_TERMS.recoveryHold} ?p ?o } }`);
  if (!held.ok) return { ok: false, status: 'UNAVAILABLE', reason: held.reason };
  if (held.boolean) return { ok: false, status: POSTSEQ_TERMS.RECOVERY_HOLD_CODE, reason: 'a recovery hold is in place: this store was promoted from a restore and is not reconciled (executor --reconcile-postseq)' };
  // multi-subject detection FIRST, before any single-tuple read, so a duplicate allocator subject is named even when
  // the canonical subject's predicate set is empty.
  const ms = await client.query(ALLOCATOR_SUBJECTS_SPARQL);
  if (!ms.ok) return { ok: false, status: 'UNAVAILABLE', reason: ms.reason };
  if (ms.rows.length > 1) return { ok: false, status: 'INVALID', reason: `allocator graph has ${ms.rows.length} allocator subjects (multiple stored allocators); never picks one` };
  if (ms.rows.length === 0) return { ok: false, status: 'INVALID', reason: 'no allocator tuple' };
  // Per-predicate cardinality (single subject, but two distinct nextPostSeq / version / postSeqEpoch objects):
  // a duplicate predicate value is a writer bug — the SELECT returns one row per such predicate, and any non-empty
  // row set is INVALID.
  const card = await client.query(ALLOCATOR_TUPLE_CARD_SPARQL);
  if (!card.ok) return { ok: false, status: 'UNAVAILABLE', reason: card.reason };
  if (card.rows.length > 0) {
    const preds = card.rows.map((r) => iriOf(r, 'pred'));
    return { ok: false, status: 'INVALID', reason: `allocator subject has duplicate ${[...new Set(preds)].join(', ')} triples (term-identity cardinality failed); never picks one` };
  }
  const r = await client.query(ALLOCATOR_SPARQL);
  if (!r.ok) return { ok: false, status: 'UNAVAILABLE', reason: r.reason };
  const rows = r.rows;
  // The subjects query already proved exactly one subject; a single-row SELECT over the canonical allocator
  // confirms the predicate set is well-formed end to end.
  if (rows.length === 0) return { ok: false, status: 'INVALID', reason: `allocator subject has a type triple but no predicate values (partial stored allocator; a writer bug)` };
  if (rows.length > 1) return { ok: false, status: 'INVALID', reason: `allocator tuple has ${rows.length} rows (duplicate stored allocator values); never picks one` };
  try {
    const b = rows[0];
    const postSeqEpoch = epochOf(b, 'postSeqEpoch');
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