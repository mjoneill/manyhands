/**
 * #1749 — the RESTORE HOLD: the half of B1 common to both recovery options on the card (46196), as the test author's
 * independent RED rows. Written against recovery contract draft v1 §R-1 (the hold, set by promotion itself) and §R-2 (named
 * refusals on BOTH allocation paths), whose DIRECTION the 03:12Z review accepted; that review did NOT freeze the contract.
 * Reconciliation (§R-3/§R-4), the journal and B8–B12 are not here: they wait on the freeze and the owner's A/B ruling.
 * The rows' author does not build the hold.
 *
 * THE WORLD is the B-rows' (tests/restore-postseq-1749.test.mjs): a live store with a hand-seeded allocator, reservation A
 * (100, 101) before a BACKUP (a copy of the stopped store), reservation B (102) after it, the live store then lost. A restore
 * is the supported path: start the copy with --promote-epoch.
 *
 *   H1  promotion of a store WITH an allocator writes exactly ONE RecoveryHold, naming the promoted epoch and the restored
 *       high-water (the max postSeq over reservations; posts and tombstones are not in this world)
 *   H2  CONTROLS: a plain restart at the SAME home writes no hold, and the live store keeps allocating
 *   H3  a store with NO allocator gets no hold (B4's refusal still applies)
 *   H4  an ORDINARY reservation on a held store → PRECONDITION_FAILED, code RECOVERY_HOLD; the postseq records unchanged
 *   H5  an ANNOUNCEMENT-slot reservation on a held store → the same, by code (the second allocation path)
 *   H6  the allocator reader answers {ok:false, status:'RECOVERY_HOLD'}, never the allocator as if usable
 *   H7  the hold survives a plain restart AND a second backup + promotion
 *   H8  reads stay available while held: a reservation made before the backup reads back, and its old-epoch replay still
 *       returns its ORIGINAL numbers (B1, under the hold)
 *   H9  a retry of a REFUSED (receipted) attempt is refused again, by code, and writes nothing
 *
 * ASSUMED NAMES (one table each, from draft v1): the HOLD terms below, and the refusal's code on the outcome's `reason`
 * (or `code`) field. NOT COVERED, BY NAME: the origin-commit card.write slot reservation (the second path inside an origin
 * commit; needs a card world, so it rides #1744/#1747's harness, owed); tampering with the hold through a current-protocol
 * intention (R4: needs the reconcile op's schema); a hold set by a cutover CANDIDATE's promotion vs a disaster restore's
 * (R5: the same mechanism, distinguished only at reconcile).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { HAVE_PY, tmpStore, spawnExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { postWriteId } from '../core/post-write.mjs';

const MOD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'core', 'postseq-reserve.mjs');
const M = await import(pathToFileURL(MOD).href);
const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 240000 };
const DSID = 'hold-1749';
const BK = 'urn:scrum:bookkeeping:executor';
const P = (x) => `<urn:ex:postseq/${x}>`;
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const EPOCH = 'e-1749-hold';
const HOLD = { subject: 'urn:ex:postseq/recovery-hold', type: 'urn:ex:postseq/RecoveryHold', epoch: 'urn:ex:postseq/epoch', restoredHighWater: 'urn:ex:postseq/restoredHighWater', restoredCommitSeq: 'urn:ex:postseq/restoredCommitSeq' };
const CODE = 'RECOVERY_HOLD';

const ordinary = (requestId) => ({ mode: 'ordinary', author: 'ada', requestId, draft: { body: `post ${requestId}`, attachedTo: null, mentions: [], attachments: [], conversation: null, onBehalfOf: null } });
const announcement = (mutationId, slot) => ({ mode: 'announcement', mutationId, slot, draft: { body: `ada ${slot}ed #9`, author: 'board', originActor: 'ada', occurredAt: '2026-10-25T03:00:00.000Z', mentions: [], notify: true } });
const intention = (reservations) => ({ kind: 'postseq.reserve', opId: M.reserveOpId(reservations), actor: 'urn:ex:seat/ada', reservations });
const allocatorTriples = (next = 100) => `${P('allocator')} a ${P('Allocator')} ; ${P('postSeqEpoch')} "${EPOCH}" ; ${P('nextPostSeq')} "${next}"^^<${XSD}integer> ; ${P('version')} "1"^^<${XSD}integer> .`;

const owned = { stores: new Set(), children: new Set() };
const store = (p) => { const d = tmpStore(p); owned.stores.add(d); fs.rmSync(d, { recursive: true }); return d; };
const start = async (dir, extra = []) => { const x = await spawnExecutor(['--store', dir, '--port', '0', '--dataset-id', DSID, ...extra]); owned.children.add(x); return x; };
const stopX = async (x) => { await killExecutor(x); owned.children.delete(x); };
after(async () => {
  for (const x of owned.children) await killExecutor(x);
  for (const d of owned.stores) fs.rmSync(d, { recursive: true, force: true });
});
const client = (x) => createGraphClient({ baseUrl: x.baseUrl, expectedDatasetId: DSID, label: 'hold-1749-rows' });
let opN = 0;
const raw = async (x, sparql) => {
  const epoch = String((await (await fetch(`${x.baseUrl}/health`)).json()).epoch);
  const r = await fetch(`${x.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/hold-${process.pid}-${opN++}`, 'x-epoch': epoch }, body: sparql });
  assert.equal(r.status, 200, `PRECONDITION: test setup write (${await r.text()})`);
};
const health = async (x) => (await fetch(`${x.baseUrl}/health`)).json();
const bk = async (x) => {
  const r = await fetch(`${x.baseUrl}/query`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/holdq-${opN++}` }, body: `SELECT ?s ?p ?o WHERE { GRAPH <${BK}> { ?s ?p ?o } }` });
  assert.equal(r.status, 200);
  const t = (b) => `${b.type}:${b.value}:${b.datatype || ''}`;
  return (await r.json()).results.bindings.map((b) => [t(b.s), t(b.p), t(b.o)].join(' ')).sort();
};
const isPostseq = (line) => line.startsWith('uri:urn:ex:postseq/') && !line.startsWith(`uri:${HOLD.subject} `);
/** every value of every predicate on the hold subject, typed */
async function holdOf(x) {
  const r = await fetch(`${x.baseUrl}/query`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/holdr-${opN++}` }, body: `SELECT ?s ?p ?o WHERE { GRAPH <${BK}> { ?s a <${HOLD.type}> ; ?p ?o } }` });
  assert.equal(r.status, 200);
  const rows = (await r.json()).results.bindings;
  return { subjects: [...new Set(rows.map((b) => b.s.value))], get: (p) => rows.filter((b) => b.p.value === p).map((b) => ({ value: b.o.value, datatype: b.o.datatype ?? null })) };
}
const seqsOf = async (c, items) => {
  const out = [];
  for (const it of items) { const r = await M.readPostSeqReservation(c, it.mode === 'ordinary' ? postWriteId(it.author, it.requestId) : null); out.push(r.ok ? r.reservation?.postSeq ?? null : null); }
  return out;
};
const heldBy = (r) => r.outcome === 'PRECONDITION_FAILED' && (r.reason === CODE || r.code === CODE);

/** the B-rows' scenario: A (100, 101) before the backup, B (102) after it, then the live store is lost */
async function scenario({ allocator = true } = {}) {
  const live = store('hold-live-');
  let x = await start(live, ['--create']);
  if (allocator) await raw(x, `INSERT DATA { GRAPH <${BK}> { ${allocatorTriples(100)} } }`);
  const A = intention([ordinary('h-a1'), ordinary('h-a2')]);
  if (allocator) {
    const rA = await client(x).update(A);
    assert.equal(rA.outcome, 'APPLIED', `PRECONDITION: A reserved (${JSON.stringify(rA).slice(0, 200)})`);
    assert.deepEqual(await seqsOf(client(x), A.reservations), [100, 101], 'PRECONDITION: A holds 100, 101');
  }
  const epochBefore = (await health(x)).epoch;
  await stopX(x);
  const backup = store('hold-backup-');
  fs.cpSync(live, backup, { recursive: true });
  if (allocator) {
    x = await start(live);
    const rB = await client(x).update(intention([ordinary('h-b1')]));
    assert.equal(rB.outcome, 'APPLIED', 'PRECONDITION: B reserved on the live store only');
    await stopX(x);
  }
  return { live, backup, A, epochBefore };
}

test('#1749 (H1) promotion of a store WITH an allocator writes exactly one RecoveryHold: the promoted epoch and the restored high-water', T, async () => {
  const s = await scenario();
  const x = await start(s.backup, ['--promote-epoch']);
  try {
    const ep = String((await health(x)).epoch);
    assert.notEqual(ep, String(s.epochBefore), 'PRECONDITION: promotion bumped the epoch');
    const h = await holdOf(x);
    assert.deepEqual(h.subjects, [HOLD.subject], 'exactly one hold, at its named subject');
    assert.deepEqual(h.get(HOLD.epoch).map((v) => v.value), [ep], 'it names THIS promotion\'s epoch, exactly once');
    assert.deepEqual(h.get(HOLD.restoredHighWater), [{ value: '101', datatype: `${XSD}integer` }], 'the restored high-water: A\'s 101 (B\'s 102 died with the live store), xsd:integer');
    assert.equal(h.get(HOLD.restoredCommitSeq).length, 1, 'one restoredCommitSeq');
  } finally { await stopX(x); }
});

test('#1749 (H2) CONTROLS: a plain restart at the SAME home writes no hold, and the live store keeps allocating', T, async () => {
  const s = await scenario();
  const x = await start(s.live);
  try {
    assert.deepEqual((await holdOf(x)).subjects, [], 'no hold without a promotion');
    const r = await client(x).update(intention([ordinary('h-live-1')]));
    assert.equal(r.outcome, 'APPLIED', `the live store allocates (${JSON.stringify(r).slice(0, 160)})`);
    assert.deepEqual(await seqsOf(client(x), [ordinary('h-live-1')]), [103], 'at the next number');
  } finally { await stopX(x); }
});

test('#1749 (H3) a store with NO allocator gets no hold on promotion (B4\'s own refusal still applies)', T, async () => {
  const s = await scenario({ allocator: false });
  const x = await start(s.backup, ['--promote-epoch']);
  try {
    assert.deepEqual((await holdOf(x)).subjects, [], 'no allocator, no hold');
    const r = await client(x).update(intention([ordinary('h-noalloc')]));
    assert.notEqual(r.outcome, 'APPLIED', 'and still no number');
  } finally { await stopX(x); }
});

for (const [path_, item] of [['an ORDINARY', ordinary('h-c1')], ['an ANNOUNCEMENT-slot', announcement('0a1e1749-0000-4000-8000-000000000001', 'claim')]]) {
  test(`#1749 (H4/H5) ${path_} reservation on a held store → PRECONDITION_FAILED, code ${CODE}; the postseq records unchanged`, T, async () => {
    const s = await scenario();
    const x = await start(s.backup, ['--promote-epoch']);
    try {
      const before = (await bk(x)).filter(isPostseq);
      assert.ok(before.length > 0, 'PRECONDITION: there are postseq records to compare');
      const r = await client(x).update(intention([item]));
      assert.ok(heldBy(r), `refused BY CODE, not merely "not APPLIED" (${JSON.stringify(r).slice(0, 200)})`);
      assert.deepEqual((await bk(x)).filter(isPostseq), before, 'no reservation, no allocator advance');
    } finally { await stopX(x); }
  });
}

test(`#1749 (H6) the allocator reader on a held store answers {ok:false, status:'${CODE}'}`, T, async () => {
  const s = await scenario();
  const x = await start(s.backup, ['--promote-epoch']);
  try {
    const a = await M.readPostSeqAllocator(client(x));
    assert.deepEqual([a.ok, a.status], [false, CODE], `never the allocator as if usable (${JSON.stringify(a).slice(0, 200)})`);
  } finally { await stopX(x); }
});

test('#1749 (H7) the hold survives a plain restart AND a second backup + promotion; allocation stays refused by code', T, async () => {
  const s = await scenario();
  let x = await start(s.backup, ['--promote-epoch']);
  assert.equal((await holdOf(x)).subjects.length, 1, 'PRECONDITION: held after the first promotion');
  await stopX(x);
  x = await start(s.backup);
  try {
    assert.deepEqual((await holdOf(x)).subjects, [HOLD.subject], 'still held after a plain restart');
    assert.ok(heldBy(await client(x).update(intention([ordinary('h-r1')]))), 'and allocation is still refused by code');
  } finally { await stopX(x); }
  const second = store('hold-backup2-');
  fs.cpSync(s.backup, second, { recursive: true });
  x = await start(second, ['--promote-epoch']);
  try {
    assert.deepEqual((await holdOf(x)).subjects, [HOLD.subject], 'still exactly one hold after a second backup and promotion');
    assert.ok(heldBy(await client(x).update(intention([ordinary('h-r2')]))), 'and allocation is still refused by code');
  } finally { await stopX(x); }
});

test('#1749 (H8) reads stay available while held: A reads back, and its old-epoch replay returns its ORIGINAL numbers', T, async () => {
  const s = await scenario();
  const x = await start(s.backup, ['--promote-epoch']);
  try {
    assert.equal((await holdOf(x)).subjects.length, 1, 'PRECONDITION: held');
    assert.deepEqual(await seqsOf(client(x), s.A.reservations), [100, 101], 'A reads back');
    const r = await client(x).update(s.A, { epoch: String(s.epochBefore) });
    assert.equal(r.outcome, 'APPLIED', `the recorded outcome still answers under the hold (${JSON.stringify(r).slice(0, 200)})`);
    assert.deepEqual(await seqsOf(client(x), s.A.reservations), [100, 101], 'with its original numbers');
  } finally { await stopX(x); }
});

test(`#1749 (H9) a retry of a REFUSED attempt is refused again by code, and writes nothing`, T, async () => {
  const s = await scenario();
  const x = await start(s.backup, ['--promote-epoch']);
  try {
    const C = intention([ordinary('h-retry')]);
    assert.ok(heldBy(await client(x).update(C)), 'PRECONDITION: the first attempt is held');
    const before = await bk(x);
    const again = await client(x).update(C);
    assert.ok(heldBy(again), `the retry answers the same refusal, by code (${JSON.stringify(again).slice(0, 200)})`);
    assert.deepEqual(await bk(x), before, 'the retry wrote nothing at all (its refusal was already recorded)');
  } finally { await stopX(x); }
});
