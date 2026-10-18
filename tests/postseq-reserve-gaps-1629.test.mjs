/**
 * #1629 slice 1 — rows for the FOUR boundaries the author's first rows (tests/postseq-reserve-1629.test.mjs) missed, found by the
 * code reviewer in the first build (8fdeb6f) and recorded in her repair gate. TEST AUTHOR's: independent of the builder's own
 * supplemental rows, so each gap is caught by a row the builder did not write.
 *
 *   G1  EVERY accepted ordinary-draft field is bound by the digest AND kept in the stored draft: two drafts that differ only in
 *       `attachments` (or in each other accepted optional field) collide (same opId, different intention => REJECTED
 *       intent-collision), and a reserved draft's attachments read back exactly as sent. The first rows varied body, mentions and
 *       notify only; a digest that dropped attachments passed them.
 *   G2  the allocator's VERSION is bounded too: version at MAX_SAFE_INTEGER makes a reservation refuse with no side effects (the
 *       first rows bounded only nextPostSeq; version MAX advanced to MAX+1)
 *   G3  a DUPLICATE allocator tuple is caught by term identity, not by value: nextPostSeq "100"^^xsd:integer AND
 *       "100.0"^^xsd:decimal on the one allocator refuse (and the allocator read is INVALID); the first rows' duplicate had two
 *       different values, which a value comparison already catches
 *   G4  a PARTIALLY stored reservation reads back INVALID, never as missing (null); and an allocator stored under TWO subjects
 *       typed Allocator reads back INVALID
 *
 * Built the same way as the first rows (same world, same seed path). Red at 8fdeb6f for G1, G2, G3 and G4, per the reviewer's
 * reproductions; run here, not assumed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { postWriteId } from '../core/post-write.mjs';

const MOD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'core', 'postseq-reserve.mjs');
let M = null, modErr = null;
try { M = await import(pathToFileURL(MOD).href); } catch (e) { modErr = e; }
const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 240000 };
const DSID = 'ps1629g';
const BK = 'urn:scrum:bookkeeping:executor';
const P = (x) => `<urn:ex:postseq/${x}>`;
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const MAX = Number.MAX_SAFE_INTEGER;
const EPOCH = 'e-1629-gaps';
const int = (n) => `"${n}"^^<${XSD}integer>`;
const allocator = ({ next = int(100), version = int(1), epoch = JSON.stringify(EPOCH), extra = '' } = {}) =>
  `${P('allocator')} a ${P('Allocator')} ; ${P('postSeqEpoch')} ${epoch} ; ${P('nextPostSeq')} ${next} ; ${P('version')} ${version} . ${extra}`;

const ordinary = (requestId, draft = {}) => ({ mode: 'ordinary', author: 'ada', requestId, draft: { body: `post ${requestId}`, attachedTo: null, mentions: [], attachments: [], conversation: null, onBehalfOf: null, ...draft } });
const intention = (reservations) => ({ kind: 'postseq.reserve', opId: M.reserveOpId(reservations), actor: 'urn:ex:seat/ada', reservations });
let seedN = 0;
async function world(seedTriples, body) {
  assert.ok(M, `the slice-1 module core/postseq-reserve.mjs does not exist yet (${modErr?.message?.slice(0, 120)})`);
  const store = tmpStore('ps1629g-'); fs.rmSync(store, { recursive: true });
  const exec = await startExecutor({ store, datasetId: DSID, create: true });
  try {
    if (seedTriples) {
      const r = await fetch(`${exec.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/postseq-gaps-${process.pid}-${seedN++}` }, body: `INSERT DATA { GRAPH <${BK}> { ${seedTriples} } }` });
      assert.equal(r.status, 200, `PRECONDITION: the test seed was written (${await r.text()})`);
    }
    await body({ exec, client: createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID, label: 'postseq-1629-gaps' }) });
  } finally { await killExecutor(exec); fs.rmSync(store, { recursive: true, force: true }); }
}
const reservation = async (client, item) => M.readPostSeqReservation(client, postWriteId(item.author, item.requestId));

// ── G1 ──
const ATT_A = [{ id: 'att-one', mime: 'text/plain', name: 'one.txt', size: 3 }];
const ATT_B = [{ id: 'att-two', mime: 'text/plain', name: 'two.txt', size: 3 }];
test('#1629 (G1a) two drafts differing ONLY in attachments collide, and the reserved attachments read back exactly', T, async () => {
  await world(allocator(), async ({ client }) => {
    const a = ordinary('g1-att', { attachments: ATT_A }), b = ordinary('g1-att', { attachments: ATT_B });
    assert.equal(M.reserveOpId([a]), M.reserveOpId([b]), 'PRECONDITION: same identities, same opId');
    assert.equal((await client.update(intention([a]))).outcome, 'APPLIED', 'PRECONDITION: the first draft is reserved');
    const r = await reservation(client, a);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.reservation?.draft?.attachments, ATT_A, `the stored draft keeps the attachments exactly as sent (${JSON.stringify(r.reservation?.draft)})`);
    const o = await client.update(intention([b]));
    assert.equal(o.outcome, 'REJECTED', `a draft that differs only in attachments is a DIFFERENT intention: intent-collision, not a silent replay (${JSON.stringify(o).slice(0, 200)})`);
    assert.equal(o.reason, 'intent-collision');
  });
});
// each accepted optional ordinary field (contract: ordinary draft allowed keys), varied alone
const OPTIONAL = [
  ['recovered', 'recovered-a', 'recovered-b'],
  ['opId', 'urn:ex:op/post/payload-a', 'urn:ex:op/post/payload-b'],
  ['origin', { mutationId: 'm-a', slot: 'claim' }, { mutationId: 'm-b', slot: 'claim' }],
  ['originalAuthorToken', 'tok-a', 'tok-b'],
  ['authorCorrectedAt', '2026-10-18T00:00:00.000Z', '2026-10-18T00:00:01.000Z'],
  ['authorCorrectedBy', 'ada', 'grace'],
];
for (const [field, va, vb] of OPTIONAL) {
  test(`#1629 (G1b) two drafts differing ONLY in ${field} collide, and the reserved ${field} reads back exactly`, T, async () => {
    await world(allocator(), async ({ client }) => {
      const a = ordinary(`g1-${field}`, { [field]: va }), b = ordinary(`g1-${field}`, { [field]: vb });
      const first = await client.update(intention([a]));
      assert.equal(first.outcome, 'APPLIED', `PRECONDITION: a draft carrying ${field} is accepted (${JSON.stringify(first).slice(0, 200)})`);
      const r = await reservation(client, a);
      assert.deepEqual(r.reservation?.draft?.[field], va, `the stored draft keeps ${field} exactly (${JSON.stringify(r.reservation?.draft)})`);
      const o = await client.update(intention([b]));
      assert.equal(o.outcome, 'REJECTED', `${field} is a semantic field: changing it alone is an intent-collision (${JSON.stringify(o).slice(0, 200)})`);
    });
  });
}

// ── G2 ──
test('#1629 (G2) an allocator whose version is at MAX_SAFE_INTEGER refuses a reservation with no side effects', T, async () => {
  await world(allocator({ version: int(MAX) }), async ({ client }) => {
    const it = ordinary('g2-1'); const a0 = await M.readPostSeqAllocator(client);
    const o = await client.update(intention([it]));
    assert.notEqual(o.outcome, 'APPLIED', `version MAX cannot advance to MAX+1 (${JSON.stringify(o).slice(0, 200)})`);
    assert.equal((await reservation(client, it)).reservation ?? null, null, 'no reservation was written');
    assert.deepEqual(await M.readPostSeqAllocator(client), a0, 'and the allocator reads exactly as before');
  });
});

// ── G3 ──
test('#1629 (G3) a duplicate nextPostSeq with the SAME value in a different datatype is a duplicate tuple: refused, and the read is INVALID', T, async () => {
  await world(allocator({ extra: `${P('allocator')} ${P('nextPostSeq')} "100.0"^^<${XSD}decimal> .` }), async ({ client }) => {
    const it = ordinary('g3-1');
    const a0 = await M.readPostSeqAllocator(client);
    assert.equal(a0.ok, false, `the allocator read refuses two nextPostSeq terms, whatever their values compare as (${JSON.stringify(a0)})`);
    const o = await client.update(intention([it]));
    assert.notEqual(o.outcome, 'APPLIED', `and the reservation refuses (${JSON.stringify(o).slice(0, 200)})`);
    assert.equal((await reservation(client, it)).reservation ?? null, null, 'with no reservation written');
  });
});

// ── G4 ──
test('#1629 (G4a) a PARTIALLY stored reservation reads back INVALID, never as missing', T, async () => {
  const it = ordinary('g4-partial'); const pid = postWriteId(it.author, it.requestId);
  await world(`${allocator()} <urn:ex:postseq/reservation/${pid}> a ${P('Reservation')} ; ${P('postId')} ${JSON.stringify(pid)} ; ${P('postSeq')} ${int(100)} .`, async ({ client }) => {
    const r = await M.readPostSeqReservation(client, pid);
    assert.equal(r.ok, false, `a reservation with some fields and not others is malformed, not absent (${JSON.stringify(r)})`);
    assert.equal(r.status, 'INVALID');
  });
});
test('#1629 (G4b) an allocator held by TWO subjects typed Allocator reads back INVALID', T, async () => {
  await world(`${allocator()} <urn:ex:postseq/allocator-2> a ${P('Allocator')} ; ${P('postSeqEpoch')} ${JSON.stringify(EPOCH)} ; ${P('nextPostSeq')} ${int(500)} ; ${P('version')} ${int(1)} .`, async ({ client }) => {
    const a = await M.readPostSeqAllocator(client);
    assert.equal(a.ok, false, `two allocators is not one allocator (${JSON.stringify(a)})`); assert.equal(a.status, 'INVALID');
  });
});
