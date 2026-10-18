/**
 * #1629 slice 1 supplemental tests — the rows the test author explicitly listed as NOT covered but the build must
 * own (docs/1629-postseq-reserve-slice1-shape.md: malformed stored reservation reads, cardinality, datatypes; terminal
 * refusal after allocator repair; staticCheck unguarded-write refusal). No mirrored implementation tests. Each row
 * exercises a single behavior not asserted by the independently authored A1/A2/DS1/S1 set.
 *
 *   R1  the stored reservation read refuses a row whose postSeq is xsd:decimal (it adds, so only a datatype check
 *       refuses it; the same surface as A2j for the read side) and a row whose postSeq is not positive, with the
 *       explicit INVALID reason — never a substituted default
 *   R2  the stored reservation read refuses two reservations for the same postId (an alias), again with INVALID —
 *       never silently picks one. The store seeds two typed Reservation nodes; the reader never returns either.
 *   R3  the stored reservation read refuses a row whose mode is something other than ordinary/announcement (a writer
 *       bug), with INVALID
 *   R4  the stored allocator read refuses a row whose nextPostSeq is xsd:decimal (datatype) and a row whose
 *       nextPostSeq is 0 (sign); the executor seeds these by hand in the bookkeeping graph, the reader reports INVALID.
 *       No defaulting, no repair.
 *   R5  after a PRECONDITION_FAILED reservation, repairing the allocator (a fresh, well-formed one) does not let
 *       a replay of the same exact refused operation allocate: the receipt's terminal state is the reason no retry
 *       can succeed against THIS opId; the post-allocator is untouched and a re-read of it shows the repaired state
 *   R6  structural negative control — the static checker REFUSES an allocator or reservation template write that is
 *       not ok-guarded (the SAME discipline S1 enforces on the production compile). An unguarded allocator delete
 *       of nextPostSeq (a plain `ALLOC nextPostSeq ?x`) trips the static checker with "DOMAIN triple lacks its guard
 *       variable"; no executor call is made.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { postWriteId } from '../core/post-write.mjs';
import { compile, staticCheck, ValidationError } from '../core/graph-compiler.mjs';
import { reserveOpId, readPostSeqReservation, readPostSeqAllocator, canonReservationBatch } from '../core/postseq-reserve.mjs';

const MOD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'core', 'postseq-reserve.mjs');
let M = null, modErr = null;
try { M = await import(pathToFileURL(MOD).href); } catch (e) { modErr = e; }
const T = { skip: HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)', timeout: 240000 };
const DSID = 'ps1629r';
const BK = 'urn:scrum:bookkeeping:executor';
const P = (x) => `<urn:ex:postseq/${x}>`;
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const MAX = Number.MAX_SAFE_INTEGER;
const EPOCH = 'sup-1629';
let seedN = 0;
async function seed(exec, triples) {
  const r = await fetch(`${exec.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/sup-seed-${process.pid}-${seedN++}` }, body: `INSERT DATA { GRAPH <${BK}> { ${triples} } }` });
  assert.equal(r.status, 200, `the test seed was written (${await r.text()})`);
}
async function world(triples, body) {
  assert.ok(M, `the slice-1 module core/postseq-reserve.mjs does not exist yet (${modErr?.message?.slice(0, 120)})`);
  const store = tmpStore('ps1629r-'); const fs = await import('node:fs'); fs.rmSync(store, { recursive: true });
  const exec = await startExecutor({ store, datasetId: DSID, create: true });
  try {
    if (triples) await seed(exec, triples);
    const client = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID, label: 'ps1629r-rows' });
    await body({ exec, client });
  } finally { await killExecutor(exec); fs.rmSync(store, { recursive: true, force: true }); }
}

const ordinary = (requestId, draft = {}) => ({ mode: 'ordinary', author: 'ada', requestId, draft: { body: `post ${requestId}`, attachedTo: null, mentions: [], attachments: [], conversation: null, onBehalfOf: null, ...draft } });

// ── R1: malformed stored reservation (datatype, sign) ──
test('#1629 (R1) the stored reservation read refuses an xsd:decimal postSeq and a non-positive one (never defaults)', T, async () => {
  const postId = postWriteId('ada', 'r1');
  const subj = `<urn:ex:postseq/reservation/${postId}>`;
  // row 1: postSeq typed xsd:decimal (adds, so only a datatype check refuses). The reader must NOT silently coerce.
  const base = `${subj} a ${P('Reservation')} ; ${P('mode')} "ordinary" ; ${P('postId')} "${postId}" ; ${P('reserveOpId')} <urn:ex:op/postseq/reserve/x> ; ${P('reserveDigest')} "d" ; ${P('postSeqEpoch')} "e" ; ${P('createdAt')} "2026-10-18T03:00:00.000Z" ; ${P('index')} 0 ; ${P('identityJson')} "{}" ; ${P('draftJson')} "{}" ;`;
  await world(`${base} ${P('postSeq')} "100"^^<${XSD}decimal> .`, async ({ client }) => {
    const r = await M.readPostSeqReservation(client, postId);
    assert.equal(r.ok, false, `xsd:decimal postSeq must refuse (got ${JSON.stringify(r)})`);
    assert.equal(r.status, 'INVALID');
    assert.ok(/xsd:integer/.test(r.reason), `the reason names the datatype (${r.reason})`);
  });
  await world(`${base} ${P('postSeq')} 0 .`, async ({ client }) => {
    const r = await M.readPostSeqReservation(client, postId);
    assert.equal(r.ok, false);
    assert.equal(r.status, 'INVALID');
    assert.ok(/positive safe integer/.test(r.reason), `the reason names the sign (${r.reason})`);
  });
});

// ── R2: duplicate stored reservation (alias) ──
test('#1629 (R2) two reservations for one postId refuse the read (never silently pick one)', T, async () => {
  const postId = postWriteId('ada', 'r2');
  const subj = `<urn:ex:postseq/reservation/${postId}>`;
  const row = (n) => `${subj} a ${P('Reservation')} ; ${P('mode')} "ordinary" ; ${P('postId')} "${postId}" ; ${P('reserveOpId')} <urn:ex:op/postseq/reserve/x> ; ${P('reserveDigest')} "${n}" ; ${P('postSeqEpoch')} "e" ; ${P('postSeq')} ${n + 100} ; ${P('createdAt')} "2026-10-18T03:00:00.000Z" ; ${P('index')} 0 ; ${P('identityJson')} "{}" ; ${P('draftJson')} "{}" .`;
  await world(`${row(1)} ${row(2)}`, async ({ client }) => {
    const r = await M.readPostSeqReservation(client, postId);
    assert.equal(r.ok, false);
    assert.equal(r.status, 'INVALID');
    assert.ok(/duplicate/.test(r.reason) || /\b2\b/.test(r.reason), `the reason names the duplicate (${r.reason})`);
  });
});

// ── R3: unknown mode ──
test('#1629 (R3) a reservation whose mode is not ordinary/announcement is INVALID (a writer bug, never silently accepted)', T, async () => {
  const postId = postWriteId('ada', 'r3');
  const subj = `<urn:ex:postseq/reservation/${postId}>`;
  const triple = `${subj} a ${P('Reservation')} ; ${P('mode')} "comment" ; ${P('postId')} "${postId}" ; ${P('reserveOpId')} <urn:ex:op/postseq/reserve/x> ; ${P('reserveDigest')} "d" ; ${P('postSeqEpoch')} "e" ; ${P('postSeq')} 100 ; ${P('createdAt')} "2026-10-18T03:00:00.000Z" ; ${P('index')} 0 ; ${P('identityJson')} "{}" ; ${P('draftJson')} "{}" .`;
  await world(triple, async ({ client }) => {
    const r = await M.readPostSeqReservation(client, postId);
    assert.equal(r.ok, false);
    assert.equal(r.status, 'INVALID');
    assert.ok(/ordinary or announcement/.test(r.reason), `the reason names the bad mode (${r.reason})`);
  });
});

// ── R4: malformed allocator read ──
test('#1629 (R4) the allocator read refuses xsd:decimal nextPostSeq and nextPostSeq 0 (no default, no repair)', T, async () => {
  const allocTriples = (dt) => `${P('allocator')} a ${P('Allocator')} ; ${P('postSeqEpoch')} "${EPOCH}" ; ${P('nextPostSeq')} "100"^^<${dt}> ; ${P('version')} "1"^^<${XSD}integer> .`;
  await world(allocTriples(`${XSD}decimal`), async ({ client }) => {
    const r = await M.readPostSeqAllocator(client);
    assert.equal(r.ok, false);
    assert.equal(r.status, 'INVALID');
    assert.ok(/xsd:integer/.test(r.reason), `the reason names the datatype (${r.reason})`);
  });
  await world(`${P('allocator')} a ${P('Allocator')} ; ${P('postSeqEpoch')} "${EPOCH}" ; ${P('nextPostSeq')} 0 ; ${P('version')} 1 .`, async ({ client }) => {
    const r = await M.readPostSeqAllocator(client);
    assert.equal(r.ok, false);
    assert.equal(r.status, 'INVALID');
    assert.ok(/positive safe integer/.test(r.reason), `the reason names the sign (${r.reason})`);
  });
});

// ── R5: terminal refusal after allocator repair ──
test('#1629 (R5) repairing the allocator does not make a refused exact-replay allocate (post-repair allocator is well-formed, the receipt is still terminal)', T, async () => {
  const items = [ordinary('r5-1')];
  // seed a postseq.reserve that will be PRECONDITION_FAILED (no allocator at all)
  const noAlloc = `<urn:ex:dataset> <urn:ex:commitSeq> 0 .`;
  await world(noAlloc, async ({ exec, client }) => {
    const opId = reserveOpId(items);
    const r0 = await client.update({ kind: 'postseq.reserve', opId, actor: 'urn:ex:seat/ada', reservations: items });
    assert.equal(r0.outcome, 'PRECONDITION_FAILED', `the no-allocator write is refused as PRECONDITION_FAILED (${JSON.stringify(r0).slice(0, 200)})`);
    // repair the allocator in the bookkeeping graph by hand (test-only setup path)
    await seed(exec, `${P('allocator')} a ${P('Allocator')} ; ${P('postSeqEpoch')} "${EPOCH}" ; ${P('nextPostSeq')} 100 ; ${P('version')} 1 .`);
    // exact replay: same opId, same digest → PRECONDITION_FAILED is terminal for THIS opId (the shape: "PRECONDITION_FAILED is
    // terminal for that exact reserve opId: repairing the allocator does not make replay of that operation allocate").
    const r1 = await client.update({ kind: 'postseq.reserve', opId, actor: 'urn:ex:seat/ada', reservations: items });
    assert.equal(r1.outcome, 'PRECONDITION_FAILED', `the exact replay returns the original terminal receipt (${JSON.stringify(r1).slice(0, 200)})`);
    // the allocator did NOT move (no allocation happened — replay is the stored receipt only)
    const a = await M.readPostSeqAllocator(client);
    assert.deepEqual(a, { ok: true, allocator: { postSeqEpoch: EPOCH, nextPostSeq: 100, version: 1 } }, 'the allocator is exactly as repaired, unchanged');
    // the reservation is null (nothing was reserved by this opId; the receipt alone was returned)
    const r = await M.readPostSeqReservation(client, postWriteId('ada', 'r5-1'));
    assert.equal(r.ok, true);
    assert.equal(r.reservation, null, 'no reservation was written (the terminal receipt is not an allocation)');
  });
});

// ── R6: staticCheck refuses an unguarded write ──
test('#1629 (R6) the static checker refuses a reservation template write whose literal slipped past the ok-guard discipline', () => {
  assert.ok(M, `the slice-1 module core/postseq-reserve.mjs does not exist yet (${modErr?.message?.slice(0, 120)})`);
  // build a valid compile first so we know what the production output looks like
  const items = [ordinary('r6-1'), ordinary('r6-2')];
  const opId = reserveOpId(items);
  const compiled = compile({ kind: 'postseq.reserve', opId, actor: 'urn:ex:seat/ada', reservations: items });
  // mutate the reservation mode INSERT line so the OBJECT is a raw literal instead of the ok-guarded `?d_r3` variable.
  // This is the structural negative control the shape names: a writer bug that slipped past the guard would land here.
  const unguarded = compiled.sparql.replace(
    /\?d_r1 <urn:ex:postseq\/mode> \?d_r3 \./,
    '?d_r1 <urn:ex:postseq/mode> "ordinary" .',
  );
  assert.notEqual(unguarded, compiled.sparql, 'the unguarded mutation actually changed something');
  const check = staticCheck(unguarded, opId);
  assert.equal(check.ok, false, `a reservation write with a raw literal must be refused (${JSON.stringify(check.errors).slice(0, 400)})`);
  assert.ok(check.errors.some((e) => /literal in template/.test(e)), `the error names the slipped literal (${JSON.stringify(check.errors)})`);
});

// ── a tiny: validation refuses an unknown root field without ever sending ──
test('#1629 (validation) a closed-schema reservation item with an unknown draft key refuses validation', () => {
  assert.throws(
    () => M.canonReservationBatch([{ mode: 'ordinary', author: 'ada', requestId: 'v1', draft: { body: 'hi', unknownKey: 1 } }], 'r'),
    /unknown key/,
  );
  // a missing body is also refused
  assert.throws(
    () => M.canonReservationBatch([{ mode: 'ordinary', author: 'ada', requestId: 'v2', draft: {} }], 'r'),
    /body is required/,
  );
  // and an opId that does not equal the identities' reserveOpId is refused at canonicalize
  const items = [ordinary('v3')];
  const opId = reserveOpId(items);
  assert.throws(
    () => compile({ kind: 'postseq.reserve', opId: opId + 'x', actor: 'urn:ex:seat/ada', reservations: items }),
    (e) => e instanceof ValidationError && /opId .* does not equal reserveOpId/.test(e.reason),
  );
});