/**
 * #1629 slice 1 REVIEW CORRECTIONS — supplemental rows added to the prior supplemental file
 * (tests/postseq-reserve-supplemental-1629.test.mjs). Each row EXACTLY names the reviewer's rule from
 * REVIEW-FIX-1629.md. These rows are written FIRST and RED — the implementation edits
 * follow. No mirroring of the independently authored tests (their SHA256 is preserved byte-identically).
 *
 *   P1 (digest must bind EVERY accepted field; stored draft must roundtrip attachments/metadata):
 *     D1  a changed attachment `id` for the same identities changes BOTH the canonical digest and the stored
 *         reserveDigest (and the roundtripped stored draft.attachments[id] reflects the change)
 *     D2  the roundtripped stored draft preserves every accepted ordinary field (attachments, recovered, opId,
 *         origin, originalAuthorToken, authorCorrectedAt, authorCorrectedBy) verbatim. The reader surfaces
 *         the exact stored draft as it was sent
 *     D3  an ordinary draft whose nested origin is reordered (mutationId/slot keys in opposite order)
 *         canonicalizes to a stable digest — same digest for both orderings (the canonicalization is stable;
 *         the stored draft surface preserves the order it was sent — the contract binds the CONTENT, not the
 *         object key order)
 *     D4  an unknown root-level field on a reservation item refuses validation, never silently drops the bad
 *         key in the canonical digest
 *     D5  preserve relevant arrays order: an ordinary draft's attachments array is preserved in INPUT order
 *         on the stored reservation (no silent re-sort). Mentions DOES keep its existing semantic unordered
 *         canonicalization (sorted for the digest), and that is unchanged
 *
 *   P2 (allocator version overflow; sameTerm cardinality; exact typed numeric terms; malformed reads):
 *     A2k allocator `version` at MAX_SAFE_INTEGER — advance past MAX produces MAX+1 — refuses with NO advance,
 *         nothing reserved, allocator reads back UNCHANGED
 *     A2l allocator `version` typed xsd:decimal refuses (the safe-integer check must catch it: a decimal
 *         version adds fine and so proves the datatype check is doing the refusal, not a parser)
 *     A2m postSeqEpoch that is not a non-empty plain IRI/safe string refuses (the contract says non-empty
 *         plain literal; a value-empty literal is INVALID on a real read and a runtime INCONSISTENT_ONE on
 *         a compile attempt)
 *     A2n postSeqEpoch with two distinct bindings on the allocator refuses (the cardinality check must
 *         use term identity — different terms with the same LITERAL value cannot both pass the duplicate
 *         guard)
 *     P2-multi two allocator subjects (one in the bookkeeping graph, one ELSEWHERE) — the compile path
 *         refuses with PRECONDITION_FAILED (the cardinality check runs over the bookkeeping graph; an
 *         out-of-graph allocator is irrelevant — the in-graph one is the sole source of truth)
 *     P2-deco a second numeric term whose VALUE equals `?x_next` but whose DATATYPE differs (e.g. one
 *         xsd:integer, one xsd:long) refuses (no two triples can share the same predicate on the same subject
 *         even if the values compare equal — that's a different term, and sameTerm, not `!=`, is the rule)
 *     R7 a PARTIALLY PRESENT Reservation (a reservation IR with only the type triple, no predicates)
 *         returns `{ok:false, status:'INVALID', reason}` — the exact pattern the read MUST recognise the partial
 *         shape — NEVER `{ok:true, reservation:null}` (a missing row and a partial row are different things)
 *     R8 a stored Reservation whose `identityJson` parses to JSON but does NOT equal the expected identity
 *         (e.g. `{author:'ada'}` when stored was `{author:'ada', requestId:'x'}`) refuses with INVALID — the
 *         reader does not accept arbitrary parsed JSON; the shape binds the identity content
 *     R9 a stored Reservation whose `draftJson` parses but does NOT match the frozen draft returns INVALID
 *     R10 two reservations with the same TIME-but-different postId are independent; the reader returns each
 *          independently (no implicit batch merge on the read side; no "near-equal" picks)
 *     R11 a stored Reservation whose `postSeq` is a positive integer but STRING-TYPED (xsd:string instead
 *          of xsd:integer) refuses — exact typed numeric terms, no value-inequality escape
 *     R12 the allocator read detects MULTIPLE allocator subjects (two `a ex:Allocator` triples in the
 *          bookkeeping graph) and refuses INVALID — not "pick the first"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { canonicalize, digestOf, compile } from '../core/graph-compiler.mjs';
import { postWriteId } from '../core/post-write.mjs';
import { reserveOpId, reserveDigestBody, canonReservationBatch, readPostSeqReservation, readPostSeqAllocator } from '../core/postseq-reserve.mjs';

const MOD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'core', 'postseq-reserve.mjs');
let M = null, modErr = null;
try { M = await import(pathToFileURL(MOD).href); } catch (e) { modErr = e; }
const T = { skip: HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)', timeout: 240000 };
const DSID = 'ps1629rc';
const BK = 'urn:scrum:bookkeeping:executor';
const P = (x) => `<urn:ex:postseq/${x}>`;
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const MAX = Number.MAX_SAFE_INTEGER;
const EPOCH = 'rc-1629';

let seedN = 0;
async function seed(exec, body) {
  const r = await fetch(`${exec.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/rc-seed-${process.pid}-${seedN++}` }, body: `INSERT DATA { GRAPH <${BK}> { ${body} } }` });
  assert.equal(r.status, 200, `the test seed was written (${await r.text()})`);
}
async function world(seedTriples, body) {
  assert.ok(M, `the slice-1 module core/postseq-reserve.mjs does not exist yet (${modErr?.message?.slice(0, 120)})`);
  const store = tmpStore('ps1629rc-'); const fs = await import('node:fs'); fs.rmSync(store, { recursive: true });
  const exec = await startExecutor({ store, datasetId: DSID, create: true });
  try {
    if (seedTriples) await seed(exec, seedTriples);
    const client = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID, label: 'ps1629rc-rows' });
    await body({ exec, client });
  } finally { await killExecutor(exec); fs.rmSync(store, { recursive: true, force: true }); }
}

const ordinary = (requestId, draft = {}) => ({ mode: 'ordinary', author: 'ada', requestId, draft: { body: `post ${requestId}`, attachedTo: null, mentions: [], attachments: [], conversation: null, onBehalfOf: null, ...draft } });

// the FROZEN canonical ordinary draft, exactly as the compiler stores it (for hand-seeded reservation rows)
const frozenDraft = (body = 'p') => JSON.stringify({ body, attachedTo: null, mentions: [], attachments: [], conversation: null, onBehalfOf: null, recovered: null, opId: null, origin: null, originalAuthorToken: null, authorCorrectedAt: null, authorCorrectedBy: null });
const lit = (v) => (typeof v === 'number' ? `"${v}"^^<${XSD}integer>` : JSON.stringify(String(v)));
const allocatorTriples = ({ epoch = EPOCH, next = 100, version = 1 } = {}) =>
  `${P('allocator')} a ${P('Allocator')} ; ${P('postSeqEpoch')} ${lit(epoch)} ; ${P('nextPostSeq')} ${lit(next)} ; ${P('version')} ${lit(version)} .`;

// ──────────────────────── P1 ────────────────────────

test('#1629 review (D1) a changed attachment id for the same identities changes the canonical digest and the stored reserveDigest; roundtripped draft.attachments[id] reflects it', T, async () => {
  const one = [ordinary('d1-1', { attachments: [{ id: 'one', mime: 'image/png', name: 'o.png', size: 10 }] })];
  const two = [ordinary('d1-1', { attachments: [{ id: 'two', mime: 'image/png', name: 'o.png', size: 10 }] })];
  const i1 = { kind: 'postseq.reserve', opId: reserveOpId(one), actor: 'urn:ex:seat/ada', reservations: one };
  const i2 = { kind: 'postseq.reserve', opId: reserveOpId(two), actor: 'urn:ex:seat/ada', reservations: two };
  const d1 = digestOf(canonicalize(i1));
  const d2 = digestOf(canonicalize(i2));
  assert.notEqual(d1, d2, 'a changed attachment id changes the canonical digest (P1: every accepted field is bound)');
  const body1 = JSON.stringify(reserveDigestBody(canonReservationBatch(one, 'one')));
  const body2 = JSON.stringify(reserveDigestBody(canonReservationBatch(two, 'two')));
  assert.ok(body1.includes('"attachments":[{"id":"one"') && body2.includes('"attachments":[{"id":"two"'), 'attachments survive in the digest body');
  // The persisted reservation holds the same digest and the same roundtripped draft
  await world(allocatorTriples(), async ({ client }) => {
    const r = await client.update({ kind: 'postseq.reserve', opId: reserveOpId(one), actor: 'urn:ex:seat/ada', reservations: one });
    assert.equal(r.outcome, 'APPLIED', `the reservation applied (${JSON.stringify(r).slice(0, 200)})`);
    const res = await M.readPostSeqReservation(client, postWriteId('ada', 'd1-1'));
    assert.equal(res.ok, true, 'the reservation reads back');
    assert.equal(res.reservation.reserveDigest, d1, 'the stored reserveDigest equals the canonical digest of the sending intention');
    assert.equal(res.reservation.draft.attachments?.[0]?.id, 'one', 'the roundtripped draft preserves the attachment id');
  });
});

test('#1629 review (D2) the roundtripped stored draft preserves EVERY accepted ordinary field (attachments, recovered, opId, origin, originalAuthorToken, authorCorrectedAt, authorCorrectedBy)', T, async () => {
  const full = {
    body: 'hello',
    attachedTo: null,
    mentions: ['ada', 'grace'],
    attachments: [{ id: 'att-1', mime: 'application/json', name: 'f.json', size: 42 }],
    conversation: null,
    onBehalfOf: null,
    recovered: 'rec-1629',
    opId: 'urn:ex:op/post/write/abc',
    origin: { mutationId: 'mut-x', slot: 'claim' },
    originalAuthorToken: 'tok-1629',
    authorCorrectedAt: '2026-10-18T01:02:03.000Z',
    authorCorrectedBy: 'grace',
  };
  const items = [ordinary('d2-1', full)];
  await world(allocatorTriples(), async ({ client }) => {
    const opId = reserveOpId(items);
    const r = await client.update({ kind: 'postseq.reserve', opId, actor: 'urn:ex:seat/ada', reservations: items });
    assert.equal(r.outcome, 'APPLIED', `the reservation applied (${JSON.stringify(r).slice(0, 200)})`);
    const res = await M.readPostSeqReservation(client, postWriteId('ada', 'd2-1'));
    assert.equal(res.ok, true);
    const d = res.reservation.draft;
    assert.equal(d.attachments?.[0]?.id, 'att-1', 'attachments[id] preserved');
    assert.equal(d.recovered, 'rec-1629', 'recovered preserved');
    assert.equal(d.opId, 'urn:ex:op/post/write/abc', 'draft opId preserved (the per-post payload opId, distinct from the reserve opId)');
    assert.deepEqual(d.origin, { mutationId: 'mut-x', slot: 'claim' }, 'origin preserved');
    assert.equal(d.originalAuthorToken, 'tok-1629');
    assert.equal(d.authorCorrectedAt, '2026-10-18T01:02:03.000Z');
    assert.equal(d.authorCorrectedBy, 'grace');
    // the digest body also reflects the same content (the digest must be content-bound, not field-bound)
    const dBody = JSON.stringify(reserveDigestBody(canonReservationBatch(items, 'd2')));
    assert.ok(dBody.includes('att-1') && dBody.includes('rec-1629') && dBody.includes('urn:ex:op/post/write/abc'), 'the canonical digest binds every accepted field');
  });
});

test('#1629 review (D3) nested origin with reordered keys canonicalizes to a stable digest (key order independent)', () => {
  const a = [ordinary('d3-1', { origin: { mutationId: 'm', slot: 's' } })];
  const b = [ordinary('d3-1', { origin: { slot: 's', mutationId: 'm' } })];
  const da = JSON.stringify(reserveDigestBody(canonReservationBatch(a, 'a')));
  const db = JSON.stringify(reserveDigestBody(canonReservationBatch(b, 'b')));
  assert.equal(da, db, 'canonicalization is stable (key order does not change the digest)');
});

test('#1629 review (D4) a reservation item with an unknown root field refuses validation, never silently drops it', () => {
  assert.throws(
    () => M.canonReservationBatch([{ mode: 'ordinary', author: 'ada', requestId: 'd4-1', draft: { body: 'hi' }, nextPostSeq: 5 }], 'r'),
    /unknown key/,
  );
  // and the digest never contains the unknown key
  try { M.canonReservationBatch([{ mode: 'ordinary', author: 'ada', requestId: 'd4-1', draft: { body: 'hi' } }, { mode: 'ordinary', author: 'ada', requestId: 'd4-1', draft: { body: 'hi', unknownInside: 1 } }], 'r'); } catch (e) { return; }
  assert.fail('a batch with a draft key the schema refuses must not silently round-trip');
});

test('#1629 review (D5) the attachments array is preserved in INPUT order on the stored reservation (no silent re-sort)', T, async () => {
  const items = [ordinary('d5-1', { attachments: [
    { id: 'c', mime: 'image/png', name: 'c.png', size: 3 },
    { id: 'a', mime: 'image/png', name: 'a.png', size: 1 },
    { id: 'b', mime: 'image/png', name: 'b.png', size: 2 },
  ] })];
  await world(allocatorTriples(), async ({ client }) => {
    const opId = reserveOpId(items);
    const r = await client.update({ kind: 'postseq.reserve', opId, actor: 'urn:ex:seat/ada', reservations: items });
    assert.equal(r.outcome, 'APPLIED');
    const res = await M.readPostSeqReservation(client, postWriteId('ada', 'd5-1'));
    assert.equal(res.ok, true);
    assert.deepEqual(res.reservation.draft.attachments?.map((a) => a.id), ['c', 'a', 'b'], 'attachments order preserved');
  });
});

// ──────────────────────── P2: allocator overflow, cardinality, exact typing ────────────────────────

const _lit = (v) => (typeof v === 'number' ? `"${v}"^^<${XSD}integer>` : JSON.stringify(String(v)));
// allocatorTriples already defined at the top of the file

test('#1629 review (A2k) allocator version at MAX_SAFE_INTEGER: advance produces MAX+1 and refuses (no advance, no reservation)', T, async () => {
  await world(allocatorTriples({ next: 100, version: MAX }), async ({ client }) => {
    const items = [ordinary('a2k-1')]; const a0 = await M.readPostSeqAllocator(client);
    assert.equal(a0.ok, true, 'CONTROL: pre-state allocator is well-formed (positive safe integer version)');
    const r = await client.update({ kind: 'postseq.reserve', opId: reserveOpId(items), actor: 'urn:ex:seat/ada', reservations: items });
    assert.notEqual(r.outcome, 'APPLIED', `version at MAX refuses the advance (got ${JSON.stringify(r).slice(0, 300)})`);
    assert.equal((await M.readPostSeqReservation(client, postWriteId('ada', 'a2k-1'))).reservation, null, 'no reservation written');
    assert.deepEqual(await M.readPostSeqAllocator(client), a0, 'allocator unchanged');
  });
});

test('#1629 review (A2l) allocator version typed xsd:decimal refuses (a datatype check, not a sign check, is what does it)', T, async () => {
  await world(`${P('allocator')} a ${P('Allocator')} ; ${P('postSeqEpoch')} ${lit(EPOCH)} ; ${P('nextPostSeq')} 1 ; ${P('version')} "1"^^<${XSD}decimal> .`, async ({ client }) => {
    const items = [ordinary('a2l-1')];
    const r = await client.update({ kind: 'postseq.reserve', opId: reserveOpId(items), actor: 'urn:ex:seat/ada', reservations: items });
    assert.notEqual(r.outcome, 'APPLIED', `decimal version refuses (got ${JSON.stringify(r).slice(0, 300)})`);
    const a = await M.readPostSeqAllocator(client);
    assert.equal(a.ok, false, 'read invalid because version is not xsd:integer');
    assert.equal(a.status, 'INVALID');
  });
});

test('#1629 review (A2m) postSeqEpoch that is the empty string refuses (non-empty plain literal is required)', T, async () => {
  await world(`${P('allocator')} a ${P('Allocator')} ; ${P('postSeqEpoch')} "" ; ${P('nextPostSeq')} 1 ; ${P('version')} 1 .`, async ({ client }) => {
    const items = [ordinary('a2m-1')];
    const r = await client.update({ kind: 'postseq.reserve', opId: reserveOpId(items), actor: 'urn:ex:seat/ada', reservations: items });
    assert.notEqual(r.outcome, 'APPLIED', `empty epoch refuses (got ${JSON.stringify(r).slice(0, 300)})`);
    const a = await M.readPostSeqAllocator(client);
    assert.equal(a.ok, false);
    assert.equal(a.status, 'INVALID');
  });
});

test('#1629 review (P2-deco) a second numeric term with the same VALUE but a different DATATYPE refuses (sameTerm, not value inequality)', T, async () => {
  // Two nextPostSeq triples on the allocator: 1 (xsd:integer) and "1.0"^^xsd:decimal. They are different TERMS that
  // compare EQUAL as values, so a `!=` duplicate guard lets them through and only sameTerm refuses. (xsd:long is NOT
  // usable here: the executor canonicalizes it to xsd:integer and stores ONE triple, so the fixture would be a no-op.)
  await world(`${P('allocator')} a ${P('Allocator')} ; ${P('postSeqEpoch')} ${lit(EPOCH)} ; ${P('nextPostSeq')} 1 ; ${P('nextPostSeq')} "1.0"^^<${XSD}decimal> ; ${P('version')} 1 .`, async ({ client }) => {
    const n = await client.query(`SELECT ?o WHERE { GRAPH <${BK}> { ${P('allocator')} ${P('nextPostSeq')} ?o } }`);
    assert.equal(n.rows?.length, 2, 'CONTROL: the fixture really holds two distinct nextPostSeq terms');
    const items = [ordinary('p2-deco-1')];
    const r = await client.update({ kind: 'postseq.reserve', opId: reserveOpId(items), actor: 'urn:ex:seat/ada', reservations: items });
    assert.notEqual(r.outcome, 'APPLIED', `same-value/different-datatype refuses (got ${JSON.stringify(r).slice(0, 300)})`);
  });
});

test('#1629 review (P2-multi) two allocator SUBJECTS in the bookkeeping graph refuse (cardinality over the bookkeeping graph alone)', T, async () => {
  await world(`${allocatorTriples()} ${P('allocator2')} a ${P('Allocator')} ; ${P('postSeqEpoch')} "other-epoch" ; ${P('nextPostSeq')} 200 ; ${P('version')} 5 .`, async ({ client }) => {
    const items = [ordinary('p2-multi-1')];
    const r = await client.update({ kind: 'postseq.reserve', opId: reserveOpId(items), actor: 'urn:ex:seat/ada', reservations: items });
    assert.notEqual(r.outcome, 'APPLIED', `two allocators refuse (got ${JSON.stringify(r).slice(0, 300)})`);
    const a = await M.readPostSeqAllocator(client);
    assert.equal(a.ok, false);
    assert.equal(a.status, 'INVALID');
    assert.ok(/multiple/i.test(a.reason), 'reason names the multiplicity');
  });
});

// ──────────────────────── P2 readers: partial / mismatched / typed numerics / multiple allocators ────────────────────────

test('#1629 review (R7) a PARTIALLY PRESENT Reservation (only the type triple) returns INVALID, not reservation:null', T, async () => {
  const postId = postWriteId('ada', 'r7');
  const subj = `<urn:ex:postseq/reservation/${postId}>`;
  // only the type triple — every other predicate absent
  await world(`${subj} a ${P('Reservation')} .`, async ({ client }) => {
    const r = await M.readPostSeqReservation(client, postId);
    assert.equal(r.ok, false, `partial reservation MUST NOT report reservation:null (got ${JSON.stringify(r)})`);
    assert.equal(r.status, 'INVALID');
    assert.ok(/partial|missing/i.test(r.reason), `reason names the partial shape (${r.reason})`);
  });
});

test('#1629 review (R8) a stored Reservation whose parsed identityJson does NOT equal the expected identity returns INVALID', T, async () => {
  const postId = postWriteId('ada', 'r8');
  const subj = `<urn:ex:postseq/reservation/${postId}>`;
  const bad = JSON.stringify({ author: 'ada' }); // missing requestId on an ordinary row
  const base = `${subj} a ${P('Reservation')} ; ${P('mode')} "ordinary" ; ${P('postId')} "${postId}" ; ${P('reserveOpId')} <urn:ex:op/postseq/reserve/x> ; ${P('reserveDigest')} "d" ; ${P('postSeqEpoch')} "${EPOCH}" ; ${P('postSeq')} 1 ; ${P('createdAt')} "2026-10-18T03:00:00.000Z" ; ${P('index')} 0 ; ${P('draftJson')} "{}" ;`;
  await world(`${base} ${P('identityJson')} ${JSON.stringify(bad)} .`, async ({ client }) => {
    const r = await M.readPostSeqReservation(client, postId);
    assert.equal(r.ok, false, `mismatched identity refuses (got ${JSON.stringify(r)})`);
    assert.equal(r.status, 'INVALID');
    assert.ok(/identity/i.test(r.reason), `reason names the identity (${r.reason})`);
  });
});

test('#1629 review (R9) a stored Reservation whose parsed draftJson does NOT match the frozen draft returns INVALID', T, async () => {
  const postId = postWriteId('ada', 'r9');
  const subj = `<urn:ex:postseq/reservation/${postId}>`;
  const ident = JSON.stringify({ author: 'ada', requestId: 'r9' });
  const base = `${subj} a ${P('Reservation')} ; ${P('mode')} "ordinary" ; ${P('postId')} "${postId}" ; ${P('reserveOpId')} <urn:ex:op/postseq/reserve/x> ; ${P('reserveDigest')} "d" ; ${P('postSeqEpoch')} "${EPOCH}" ; ${P('postSeq')} 1 ; ${P('createdAt')} "2026-10-18T03:00:00.000Z" ; ${P('index')} 0 ; ${P('identityJson')} ${JSON.stringify(ident)} ;`;
  // CONTROL: the same row with a frozen canonical draft reads back, so the refusal below is about the draft only
  await world(`${base} ${P('draftJson')} ${JSON.stringify(frozenDraft('same'))} .`, async ({ client }) => {
    const r = await M.readPostSeqReservation(client, postId);
    assert.equal(r.ok, true, `CONTROL: a frozen draft reads back (${JSON.stringify(r)})`);
  });
  // a draft that parses as JSON but is not the frozen form (missing accepted fields the compiler always writes)
  const draft = JSON.stringify({ body: 'DIFFERENT', attachedTo: null, mentions: [], conversation: null, onBehalfOf: null });
  await world(`${base} ${P('draftJson')} ${JSON.stringify(draft)} .`, async ({ client }) => {
    const r = await M.readPostSeqReservation(client, postId);
    assert.equal(r.ok, false, `mismatched draft refuses (got ${JSON.stringify(r)})`);
    assert.equal(r.status, 'INVALID');
    assert.ok(/draft/i.test(r.reason), `reason names the draft (${r.reason})`);
  });
});

test('#1629 review (R10) two reservations with the same TIME but different postIds are independent (no read-side batch merge)', T, async () => {
  const a = postWriteId('ada', 'r10a');
  const b = postWriteId('ada', 'r10b');
  const sa = `<urn:ex:postseq/reservation/${a}>`;
  const sb = `<urn:ex:postseq/reservation/${b}>`;
  const T_ = '"2026-10-18T03:00:00.000Z"';
  const row = (subj, id, n, requestId) => `${subj} a ${P('Reservation')} ; ${P('mode')} "ordinary" ; ${P('postId')} "${id}" ; ${P('reserveOpId')} <urn:ex:op/postseq/reserve/x> ; ${P('reserveDigest')} "d-${id}" ; ${P('postSeqEpoch')} "${EPOCH}" ; ${P('postSeq')} ${n} ; ${P('createdAt')} ${T_} ; ${P('index')} 0 ; ${P('identityJson')} ${JSON.stringify(JSON.stringify({ author: 'ada', requestId }))} ; ${P('draftJson')} ${JSON.stringify(frozenDraft())} .`;
  await world(`${row(sa, a, 1, 'r10a')} ${row(sb, b, 2, 'r10b')}`, async ({ client }) => {
    const ra = await M.readPostSeqReservation(client, a);
    const rb = await M.readPostSeqReservation(client, b);
    assert.equal(ra.ok, true); assert.equal(rb.ok, true);
    assert.equal(ra.reservation.postSeq, 1); assert.equal(rb.reservation.postSeq, 2);
    assert.equal(ra.reservation.postId, a); assert.equal(rb.reservation.postId, b);
  });
});

test('#1629 review (R11) a stored Reservation whose postSeq is typed xsd:string (not xsd:integer) refuses INVALID — exact typed numeric terms', T, async () => {
  const postId = postWriteId('ada', 'r11');
  const subj = `<urn:ex:postseq/reservation/${postId}>`;
  const ident = JSON.stringify({ author: 'ada', requestId: 'r11' });
  const draft = frozenDraft();
  const base = `${subj} a ${P('Reservation')} ; ${P('mode')} "ordinary" ; ${P('postId')} "${postId}" ; ${P('reserveOpId')} <urn:ex:op/postseq/reserve/x> ; ${P('reserveDigest')} "d" ; ${P('postSeqEpoch')} "${EPOCH}" ; ${P('createdAt')} "2026-10-18T03:00:00.000Z" ; ${P('index')} 0 ; ${P('identityJson')} ${JSON.stringify(ident)} ; ${P('draftJson')} ${JSON.stringify(draft)} ;`;
  await world(`${base} ${P('postSeq')} "1"^^<${XSD}string> .`, async ({ client }) => {
    const r = await M.readPostSeqReservation(client, postId);
    assert.equal(r.ok, false, `xsd:string postSeq refuses (got ${JSON.stringify(r)})`);
    assert.equal(r.status, 'INVALID');
    assert.ok(/xsd:integer/.test(r.reason), `reason names the datatype (${r.reason})`);
  });
});

test('#1629 review (R12) the allocator read detects MULTIPLE allocator subjects and refuses INVALID (never picks one)', T, async () => {
  await world(`${allocatorTriples()} ${P('allocator2')} a ${P('Allocator')} ; ${P('postSeqEpoch')} "other-epoch" ; ${P('nextPostSeq')} 200 ; ${P('version')} 5 .`, async ({ client }) => {
    const a = await M.readPostSeqAllocator(client);
    assert.equal(a.ok, false, `two allocators -> INVALID (got ${JSON.stringify(a)})`);
    assert.equal(a.status, 'INVALID');
    assert.ok(/multiple/.test(a.reason), `reason names the multiplicity (${a.reason})`);
  });
});

// ──────────────────────── recovery-pass rows (REVIEW-FIX-1629 "Remaining source gaps") ────────────────────────

test('#1629 review (D6) EACH accepted ordinary draft field, changed alone, changes the canonical digest and keeps the opId', () => {
  const base = { body: 'b', attachedTo: null, mentions: [], attachments: [], conversation: null, onBehalfOf: null };
  const changed = {
    body: 'b2', attachedTo: 'card-x', mentions: ['grace'], attachments: [{ id: 'z', mime: 'image/png', name: 'z.png', size: 1 }],
    conversation: 'talk-x', onBehalfOf: 'grace', recovered: 'rec', opId: 'urn:ex:op/post/write/x', origin: { mutationId: 'm', slot: 's' },
    originalAuthorToken: 'tok', authorCorrectedAt: '2026-10-18T00:00:00.000Z', authorCorrectedBy: 'grace',
  };
  const intent = (draft) => { const r = [{ mode: 'ordinary', author: 'ada', requestId: 'd6', draft }]; return { kind: 'postseq.reserve', opId: reserveOpId(r), actor: 'urn:ex:seat/ada', reservations: r }; };
  const d0 = digestOf(canonicalize(intent(base)));
  for (const [k, v] of Object.entries(changed)) {
    const i = intent({ ...base, [k]: v });
    assert.equal(i.opId, intent(base).opId, `${k}: the opId binds identities only`);
    assert.notEqual(digestOf(canonicalize(i)), d0, `${k}: a change to this accepted field changes the digest`);
  }
  // and each nested attachment field
  for (const [k, v] of Object.entries({ id: 'q', mime: 'text/plain', name: 'n', size: 7 })) {
    const att = { id: 'z', mime: 'image/png', name: 'z.png', size: 1 };
    const a1 = digestOf(canonicalize(intent({ ...base, attachments: [att] })));
    const a2 = digestOf(canonicalize(intent({ ...base, attachments: [{ ...att, [k]: v }] })));
    assert.notEqual(a1, a2, `attachments[].${k}: bound in the digest`);
  }
});

test('#1629 review (D7) a reserved draft re-sent with ONE changed metadata field collides (intent-collision) and changes nothing', T, async () => {
  await world(allocatorTriples(), async ({ client }) => {
    const a = [ordinary('d7-1', { recovered: 'r-one' })];
    const b = [ordinary('d7-1', { recovered: 'r-two' })];
    const r1 = await client.update({ kind: 'postseq.reserve', opId: reserveOpId(a), actor: 'urn:ex:seat/ada', reservations: a });
    assert.equal(r1.outcome, 'APPLIED', 'CONTROL: the first reservation applies');
    const al1 = await M.readPostSeqAllocator(client);
    const r2 = await client.update({ kind: 'postseq.reserve', opId: reserveOpId(b), actor: 'urn:ex:seat/ada', reservations: b });
    assert.notEqual(r2.outcome, 'APPLIED', `a changed recovered field collides (${JSON.stringify(r2).slice(0, 200)})`);
    assert.deepEqual(await M.readPostSeqAllocator(client), al1, 'allocator unchanged by the collision');
    assert.equal((await M.readPostSeqReservation(client, postWriteId('ada', 'd7-1'))).reservation.draft.recovered, 'r-one', 'the stored draft is the first one');
  });
});

test('#1629 review (R13) a reservation subject with predicates but NO type triple is INVALID (partial), not missing', T, async () => {
  const postId = postWriteId('ada', 'r13');
  await world(`<urn:ex:postseq/reservation/${postId}> ${P('postId')} "${postId}" .`, async ({ client }) => {
    const r = await M.readPostSeqReservation(client, postId);
    assert.equal(r.ok, false, `untyped partial row is not absent (${JSON.stringify(r)})`);
    assert.equal(r.status, 'INVALID');
  });
  // CONTROL: a subject with no triples at all is genuinely missing
  await world(null, async ({ client }) => {
    const r = await M.readPostSeqReservation(client, postId);
    assert.deepEqual(r, { ok: true, reservation: null }, 'an absent row reads as missing');
  });
});

const handRow = (postId, { identity, epoch = `"${EPOCH}"` }) => `<urn:ex:postseq/reservation/${postId}> a ${P('Reservation')} ; ${P('mode')} "ordinary" ; ${P('postId')} "${postId}" ; ${P('reserveOpId')} <urn:ex:op/postseq/reserve/x> ; ${P('reserveDigest')} "d" ; ${P('postSeqEpoch')} ${epoch} ; ${P('postSeq')} 1 ; ${P('createdAt')} "2026-10-18T03:00:00.000Z" ; ${P('index')} 0 ; ${P('identityJson')} ${JSON.stringify(JSON.stringify(identity))} ; ${P('draftJson')} ${JSON.stringify(frozenDraft())} .`;

test('#1629 review (R14) identity must be a CLOSED keyset whose derived postId equals the stored postId', T, async () => {
  const postId = postWriteId('ada', 'r14');
  await world(handRow(postId, { identity: { author: 'ada', requestId: 'r14' } }), async ({ client }) => {
    assert.equal((await M.readPostSeqReservation(client, postId)).ok, true, 'CONTROL: the exact identity reads back');
  });
  for (const [why, identity] of [
    ['an extra key', { author: 'ada', requestId: 'r14', extra: 1 }],
    ['an empty value', { author: '', requestId: 'r14' }],
    ['a different requestId (derives another postId)', { author: 'ada', requestId: 'r14-other' }],
  ]) {
    await world(handRow(postId, { identity }), async ({ client }) => {
      const r = await M.readPostSeqReservation(client, postId);
      assert.equal(r.ok, false, `${why} is INVALID (${JSON.stringify(r)})`);
      assert.equal(r.status, 'INVALID');
    });
  }
});

test('#1629 review (A2o) postSeqEpoch must be a PLAIN string literal: IRI, language-tagged and typed-number epochs refuse on compile and read', T, async () => {
  const postId = postWriteId('ada', 'a2o');
  for (const [why, epoch] of [['an IRI', '<urn:ex:epoch/x>'], ['a language tag', `"${EPOCH}"@en`], ['a typed number', `"7"^^<${XSD}integer>`]]) {
    await world(`${P('allocator')} a ${P('Allocator')} ; ${P('postSeqEpoch')} ${epoch} ; ${P('nextPostSeq')} 1 ; ${P('version')} 1 .`, async ({ client }) => {
      const items = [ordinary('a2o-1')];
      const r = await client.update({ kind: 'postseq.reserve', opId: reserveOpId(items), actor: 'urn:ex:seat/ada', reservations: items });
      assert.notEqual(r.outcome, 'APPLIED', `${why} epoch refuses the reservation (${JSON.stringify(r).slice(0, 200)})`);
      const a = await M.readPostSeqAllocator(client);
      assert.equal(a.ok, false, `${why} epoch: the allocator read is INVALID (${JSON.stringify(a)})`);
      assert.equal(a.status, 'INVALID');
    });
    await world(handRow(postId, { identity: { author: 'ada', requestId: 'a2o' }, epoch }), async ({ client }) => {
      const r = await M.readPostSeqReservation(client, postId);
      assert.equal(r.ok, false, `${why} epoch on a reservation is INVALID (${JSON.stringify(r)})`);
    });
  }
  // CONTROL: an explicit xsd:string epoch is the same term as a plain literal and is accepted
  await world(`${P('allocator')} a ${P('Allocator')} ; ${P('postSeqEpoch')} "${EPOCH}"^^<${XSD}string> ; ${P('nextPostSeq')} 1 ; ${P('version')} 1 .`, async ({ client }) => {
    const items = [ordinary('a2o-ok')];
    const r = await client.update({ kind: 'postseq.reserve', opId: reserveOpId(items), actor: 'urn:ex:seat/ada', reservations: items });
    assert.equal(r.outcome, 'APPLIED', `CONTROL: a plain string epoch applies (${JSON.stringify(r).slice(0, 200)})`);
  });
});

// ──────────────────────── code-review rows (R1–R3, #1629 changes requested at 86d77d2) ────────────────────────

test('#1629 review (D8) origin.occurredAt is accepted like post.write, bound in the digest, stored, and a change to it alone collides', T, async () => {
  const at1 = '2026-10-18T01:00:00.000Z', at2 = '2026-10-18T02:00:00.000Z';
  const intent = (origin) => { const r = [ordinary('d8-1', { origin })]; return { kind: 'postseq.reserve', opId: reserveOpId(r), actor: 'urn:ex:seat/ada', reservations: r }; };
  const withAt = intent({ mutationId: 'm', slot: 's', occurredAt: at1 });
  assert.notEqual(digestOf(canonicalize(withAt)), digestOf(canonicalize(intent({ mutationId: 'm', slot: 's', occurredAt: at2 }))), 'occurredAt is bound in the digest');
  assert.equal(digestOf(canonicalize(intent({ mutationId: 'm', slot: 's', occurredAt: null }))), digestOf(canonicalize(intent({ mutationId: 'm', slot: 's' }))), 'null and absent occurredAt are the same, as in post.write');
  assert.throws(() => canonicalize(intent({ mutationId: 'm', slot: 's', occurredAt: 5 })), /occurredAt/, 'a non-string occurredAt is refused');
  await world(allocatorTriples(), async ({ client }) => {
    const r1 = await client.update(withAt);
    assert.equal(r1.outcome, 'APPLIED', `origin with occurredAt applies (${JSON.stringify(r1).slice(0, 200)})`);
    const got = await M.readPostSeqReservation(client, postWriteId('ada', 'd8-1'));
    assert.equal(got.ok, true, `and reads back (${JSON.stringify(got)})`);
    assert.deepEqual(got.reservation.draft.origin, { mutationId: 'm', slot: 's', occurredAt: at1 }, 'occurredAt roundtrips');
    const al = await M.readPostSeqAllocator(client);
    const r2 = await client.update(intent({ mutationId: 'm', slot: 's', occurredAt: at2 }));
    assert.notEqual(r2.outcome, 'APPLIED', 'a changed occurredAt alone collides');
    assert.deepEqual(await M.readPostSeqAllocator(client), al, 'and allocates nothing');
  });
});

test('#1629 review (D9) prototype-named own keys (constructor, toString, __proto__) are refused in every closed object, not silently dropped', () => {
  const att = '{"id":"a","mime":"image/png","name":"a.png","size":1}';
  const good = JSON.parse(`[{"mode":"ordinary","author":"ada","requestId":"d9","draft":{"body":"b","attachments":[${att}]}}]`);
  assert.doesNotThrow(() => canonReservationBatch(good, 'r'), 'CONTROL: a valid JSON-parsed attachment is accepted');
  for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const bad = (where) => JSON.parse(where.replace('@', `"${key}":"discarded",`));
    for (const [what, src] of [
      ['attachment', `[{"mode":"ordinary","author":"ada","requestId":"d9","draft":{"body":"b","attachments":[{@"id":"a","mime":"image/png","name":"a.png","size":1}]}}]`],
      ['draft', `[{"mode":"ordinary","author":"ada","requestId":"d9","draft":{@"body":"b"}}]`],
      ['origin', `[{"mode":"ordinary","author":"ada","requestId":"d9","draft":{"body":"b","origin":{@"mutationId":"m","slot":"s"}}}]`],
      ['item', `[{@"mode":"ordinary","author":"ada","requestId":"d9","draft":{"body":"b"}}]`],
      ['announcement draft', `[{"mode":"announcement","mutationId":"m","slot":"s","draft":{@"body":"b","author":"board","originActor":"ada","occurredAt":"2026-10-18T00:00:00.000Z","mentions":[],"notify":false}}]`],
    ]) {
      const parsed = bad(src);
      assert.throws(() => canonReservationBatch(parsed, 'r'), /unknown key/, `${what} with own key ${key} is refused`);
    }
  }
});

test('#1629 review (R15) a malformed identity string is refused BEFORE anything is sent: no reservation, no allocation', T, async () => {
  const lone = String.fromCharCode(0xd800);
  await world(allocatorTriples(), async ({ client }) => {
    const a0 = await M.readPostSeqAllocator(client);
    for (const [why, items] of [
      ['ordinary author', [{ mode: 'ordinary', author: lone, requestId: 'r15', draft: { body: 'b' } }]],
      ['ordinary requestId', [{ mode: 'ordinary', author: 'ada', requestId: `r15${lone}`, draft: { body: 'b' } }]],
      ['announcement mutationId', [{ mode: 'announcement', mutationId: lone, slot: 's', draft: { body: 'b', author: 'board', originActor: 'ada', occurredAt: '2026-10-18T00:00:00.000Z', mentions: [], notify: false } }]],
      ['announcement slot', [{ mode: 'announcement', mutationId: 'm', slot: lone, draft: { body: 'b', author: 'board', originActor: 'ada', occurredAt: '2026-10-18T00:00:00.000Z', mentions: [], notify: false } }]],
    ]) {
      assert.throws(() => canonicalize({ kind: 'postseq.reserve', opId: reserveOpId(items), actor: 'urn:ex:seat/ada', reservations: items }), /well-formed/, `${why}: refused at canonicalize`);
      let threw = false;
      try { await client.update({ kind: 'postseq.reserve', opId: reserveOpId(items), actor: 'urn:ex:seat/ada', reservations: items }); } catch { threw = true; }
      assert.ok(threw, `${why}: the client refuses to send it`);
    }
    assert.deepEqual(await M.readPostSeqAllocator(client), a0, 'nothing allocated');
    // CONTROL: a well-formed non-ASCII identity roundtrips
    const ok = [{ mode: 'ordinary', author: 'adá', requestId: 'r15-ünï', draft: { body: 'b' } }];
    const r = await client.update({ kind: 'postseq.reserve', opId: reserveOpId(ok), actor: 'urn:ex:seat/ada', reservations: ok });
    assert.equal(r.outcome, 'APPLIED', `CONTROL: a well-formed identity applies (${JSON.stringify(r).slice(0, 200)})`);
    const back = await M.readPostSeqReservation(client, postWriteId('adá', 'r15-ünï'));
    assert.equal(back.ok, true, `CONTROL: and reads back (${JSON.stringify(back)})`);
  });
});

test('#1629 review (D10) attachment members follow post.write: mime, name and size are required, never null or missing', () => {
  const item = (att) => [{ mode: 'ordinary', author: 'ada', requestId: 'd10', draft: { body: 'b', attachments: [att] } }];
  const full = { id: 'a', mime: 'image/png', name: 'a.png', size: 1 };
  assert.doesNotThrow(() => canonReservationBatch(item(full), 'r'), 'CONTROL: a complete attachment is accepted');
  assert.doesNotThrow(() => canonReservationBatch([{ mode: 'ordinary', author: 'ada', requestId: 'd10', draft: { body: 'b', attachments: null } }], 'r'), 'CONTROL: a null attachments ARRAY still defaults to empty');
  for (const k of ['id', 'mime', 'name', 'size']) {
    const missing = { ...full }; delete missing[k];
    assert.throws(() => canonReservationBatch(item(missing), 'r'), new RegExp(k), `missing ${k} is refused`);
    assert.throws(() => canonReservationBatch(item({ ...full, [k]: null }), 'r'), new RegExp(k), `null ${k} is refused`);
  }
  for (const size of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) assert.throws(() => canonReservationBatch(item({ ...full, size }), 'r'), /size/, `size ${size} is refused`);
});
