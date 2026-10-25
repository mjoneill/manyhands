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
import { HAVE_PY, PY, tmpStore, spawnExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { createGraphClient } from '../core/graph-client.mjs';
import { postWriteId } from '../core/post-write.mjs';

const MOD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'core', 'postseq-reserve.mjs');
const M = await import(pathToFileURL(MOD).href);
const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 240000 };
const DSID = 'hold-1749';
const BK = 'urn:scrum:bookkeeping:executor';
const RG = 'urn:ex:postseq/recovery';   // #1749 v3 A7 v2: the hold and every ReconciliationRecord live in their OWN named graph
const P = (x) => `<urn:ex:postseq/${x}>`;
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const EPOCH = 'e-1749-hold';
const HOLD = { subject: 'urn:ex:postseq/recovery-hold', type: 'urn:ex:postseq/RecoveryHold', epoch: 'urn:ex:postseq/epoch', incarnation: 'urn:ex:postseq/incarnation', restoredHighWater: 'urn:ex:postseq/restoredHighWater', restoredCommitSeq: 'urn:ex:postseq/restoredCommitSeq', priorHoldEpoch: 'urn:ex:postseq/priorHoldEpoch' };
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
/** r2 (review 46506): write straight into a STOPPED store with pyoxigraph. A wrong lineage or a planted high-water is set up
 *  OFFLINE, before startup, never by an /update the hold's own protection must refuse (B5e). */
const plantOffline = (dir, sparql) => {
  const r = spawnSync(PY, ['-I', '-c', 'import sys, pyoxigraph as px; s = px.Store(sys.argv[1]); s.update(sys.argv[2]); s.flush()', dir, sparql], { encoding: 'utf8' });
  assert.equal(r.status, 0, `PRECONDITION: planted offline (${r.stderr})`);
};
const bk = async (x) => {
  const r = await fetch(`${x.baseUrl}/query`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/holdq-${opN++}` }, body: `SELECT ?s ?p ?o WHERE { GRAPH <${BK}> { ?s ?p ?o } }` });
  assert.equal(r.status, 200);
  const t = (b) => `${b.type}:${b.value}:${b.datatype || ''}`;
  return (await r.json()).results.bindings.map((b) => [t(b.s), t(b.p), t(b.o)].join(' ')).sort();
};
const rg = async (x) => {
  const r = await fetch(`${x.baseUrl}/query`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/holdrg-${opN++}` }, body: `SELECT ?s ?p ?o WHERE { GRAPH <${RG}> { ?s ?p ?o } }` });
  assert.equal(r.status, 200);
  const t = (b) => `${b.type}:${b.value}:${b.datatype || ''}`;
  return (await r.json()).results.bindings.map((b) => [t(b.s), t(b.p), t(b.o)].join(' ')).sort();
};
/** one raw /update, its status and body text (for the protection and P3 v3 rows) */
const post = async (x, body, header = { 'x-manyhands-write-protocol': 'postseq-v1' }) => {
  const r = await fetch(`${x.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/hold-post-${opN++}`, 'x-epoch': String((await health(x)).epoch), ...header }, body });
  return { status: r.status, text: await r.text() };
};
const askQ = async (x, q) => {
  const r = await fetch(`${x.baseUrl}/query`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/holdask-${opN++}` }, body: q });
  return (await r.json()).boolean;
};
const isPostseq = (line) => line.startsWith('uri:urn:ex:postseq/') && !line.startsWith(`uri:${HOLD.subject} `);
/** every value of every predicate on the hold subject, typed */
async function holdOf(x) {
  const r = await fetch(`${x.baseUrl}/query`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/holdr-${opN++}` }, body: `SELECT ?s ?p ?o WHERE { GRAPH <${RG}> { ?s a <${HOLD.type}> ; ?p ?o } }` });
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
    assert.deepEqual(h.get(HOLD.incarnation).map((v) => v.value), [String((await health(x)).incarnation)], 'and THIS promotion\'s incarnation, exactly once (draft v2 V2-1)');
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
  const firstEpoch = String((await health(x)).epoch);
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
    const h2 = await holdOf(x); const hh = await health(x);
    assert.deepEqual(h2.subjects, [HOLD.subject], 'still exactly one hold after a second backup and promotion');
    // ⚠️ an open question in draft v2 (it does not say): if the hold kept the FIRST promotion's lineage, every restore of a held store
    // would refuse WRONG_LINEAGE forever. These rows require it re-bound to the current epoch and incarnation, the restored high-water kept.
    assert.deepEqual([h2.get(HOLD.epoch).map((v) => v.value), h2.get(HOLD.incarnation).map((v) => v.value)], [[String(hh.epoch)], [String(hh.incarnation)]], 'the hold names the CURRENT epoch and incarnation');
    assert.deepEqual(h2.get(HOLD.restoredHighWater), [{ value: '101', datatype: `${XSD}integer` }], 'and keeps the restored high-water (the lost tail is still unknown)');
    // draft v2 V2-1 as amended (post 46354): the replacing hold records the hold it replaced
    assert.deepEqual(h2.get(HOLD.priorHoldEpoch).map((v) => v.value), [firstEpoch], 'priorHoldEpoch names the replaced hold\'s epoch, exactly once');
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

// ── draft v2 V2-3 (under decision 27ab297c): reconciliation is a DECLARED GAP approved by a person, never inferred. ASSUMED intention shape
// (one table): kind postseq.reconcile with opId, actor, nextPostSeq, declaredGap, approvedBy, approvalRef, evidence[]. Draft v2 R1 is H3
// (no allocator → no hold: the cutover candidate, promoted BEFORE the import writes its allocator) plus H1 (an allocator → a hold).
// These rows are a PROPOSAL against an unfrozen draft, like H1–H9.
const RECONCILE = { kind: 'postseq.reconcile', record: 'urn:ex:postseq/ReconciliationRecord', approvalRef: 'urn:ex:postseq/approvalRef' };
const APPROVER = 'https://scrumboard.local/person/approver';
const reconcile = (R, G, tag, extra = {}) => ({ kind: RECONCILE.kind, opId: `urn:ex:op/postseq/reconcile/test-${tag}-${process.pid}`, actor: APPROVER, nextPostSeq: R, declaredGap: G, approvedBy: APPROVER, approvalRef: 'decision:00000000-0000-4000-8000-0000000017a9', evidence: [], ...extra });
const refusedBy = (r, code) => (r.outcome === 'PRECONDITION_FAILED' || r.outcome === 'REJECTED') && (r.reason === code || r.code === code);
// r3 (contract v3 A2): reconciliation is a MAINTENANCE START on a stopped store, `--reconcile-postseq <file>`, never an /update.
// ASSUMED file shape (v3 names the flag; A5 the `hold` block): v2-3's intention fields without kind/opId/actor, plus the
// REQUIRED `hold` {datasetId, epoch, incarnation, restoredCommitSeq, restoredHighWater} the file was written against.
// epoch/incarnation as the stored strings, the two counts as integers. A refusal stops the start with its code on stderr.
/** the hold block, read from a running executor (before it is stopped for the maintenance start) */
const holdBlock = async (x) => {
  const h = await holdOf(x); const one = (p) => h.get(p).map((v) => v.value)[0];
  return { datasetId: DSID, epoch: one(HOLD.epoch), incarnation: one(HOLD.incarnation), restoredCommitSeq: Number(one(HOLD.restoredCommitSeq)), restoredHighWater: Number(one(HOLD.restoredHighWater)) };
};
const reconcileFile = (dir, R, G, hold, extra = {}) => {
  const d = fs.mkdtempSync(path.join(path.dirname(dir), 'recon-')); owned.stores.add(d);   // removed by after(), like the stores
  const f = path.join(d, 'reconcile.json');
  fs.writeFileSync(f, JSON.stringify({ nextPostSeq: R, declaredGap: G, approvedBy: APPROVER, approvalRef: 'decision:00000000-0000-4000-8000-0000000017a9', evidence: [], hold, ...extra }));
  return f;
};
const reconcileStart = (dir, file) => start(dir, ['--reconcile-postseq', file]);
const refusedStart = async (dir, file, code, what) => {
  await assert.rejects(reconcileStart(dir, file), (e) => new RegExp(`\\b${code}\\b`).test(String(e?.stderr ?? e?.message)), `${what}: the maintenance start refuses with ${code}`);
};
const recordsOf = async (x) => {
  const r = await fetch(`${x.baseUrl}/query`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/holdrec-${opN++}` }, body: `SELECT ?r ?ref WHERE { GRAPH <${RG}> { ?r a <${RECONCILE.record}> ; <${RECONCILE.approvalRef}> ?ref } }` });
  return (await r.json()).results.bindings.map((b) => [b.r.value, b.ref.value]);
};

test('#1749 (B5a, r3) a --reconcile-postseq start with R = restoredHighWater + G + 1 clears the hold, then serves; the next allocation is EXACTLY R; the record reads back with its approval', T, async () => {
  const s = await scenario();
  let x = await start(s.backup, ['--promote-epoch']);
  assert.equal((await holdOf(x)).subjects.length, 1, 'PRECONDITION: held');
  const hb = await holdBlock(x);
  await stopX(x);
  x = await reconcileStart(s.backup, reconcileFile(s.backup, 101 + 10 + 1, 10, hb));
  try {
    assert.deepEqual((await holdOf(x)).subjects, [], 'the hold is gone');
    const C = intention([ordinary('h-after-reconcile')]);
    assert.equal((await client(x).update(C)).outcome, 'APPLIED', 'allocation is open again');
    assert.deepEqual(await seqsOf(client(x), C.reservations), [112], 'at EXACTLY R');
    assert.deepEqual((await recordsOf(x)).map(([, ref]) => ref), ['decision:00000000-0000-4000-8000-0000000017a9'], 'one ReconciliationRecord, carrying the approval it recorded');
  } finally { await stopX(x); }
});
for (const [what, R] of [['one BELOW high-water + G + 1', 111], ['one ABOVE it', 113]]) {
  test(`#1749 (B5b, r3) a --reconcile-postseq start with R ${what} → refuses to start, BAD_GAP; the store unchanged, still held`, T, async () => {
    const s = await scenario();
    let x = await start(s.backup, ['--promote-epoch']);
    const before = (await bk(x)).filter(isPostseq), hold0 = await holdOf(x), hb = await holdBlock(x);
    await stopX(x);
    await refusedStart(s.backup, reconcileFile(s.backup, R, 10, hb), 'BAD_GAP', `R ${R}`);
    x = await start(s.backup);
    try {
      assert.deepEqual((await holdOf(x)).subjects, hold0.subjects, 'still held');
      assert.deepEqual((await bk(x)).filter(isPostseq), before, 'nothing changed');
    } finally { await stopX(x); }
  });
}
test('#1749 (B5c) a hold naming ANOTHER incarnation (a copied lineage), planted OFFLINE before startup → WRONG_LINEAGE; still held', T, async () => {
  const s = await scenario();
  let x = await start(s.backup, ['--promote-epoch']);
  assert.equal((await holdOf(x)).subjects.length, 1, 'PRECONDITION: held after the promotion');
  await stopX(x);
  // r2 (review 46506): the lineage is rewritten in the STOPPED store, as a hold copied from another store's promotion would read;
  // an /update cannot do it, because the hold is protected (B5e)
  plantOffline(s.backup, `DELETE { GRAPH <${RG}> { <${HOLD.subject}> <${HOLD.incarnation}> ?i } } INSERT { GRAPH <${RG}> { <${HOLD.subject}> <${HOLD.incarnation}> "another-incarnation" } } WHERE { GRAPH <${RG}> { <${HOLD.subject}> <${HOLD.incarnation}> ?i } }`);
  x = await start(s.backup);
  let hb;
  try {
    assert.deepEqual((await holdOf(x)).get(HOLD.incarnation).map((v) => v.value), ['another-incarnation'], 'PRECONDITION: the plain restart serves the planted lineage');
    hb = await holdBlock(x);   // a file that matches the STORED hold exactly, so only the hold-vs-store check (A2) can refuse it
  } finally { await stopX(x); }
  await refusedStart(s.backup, reconcileFile(s.backup, 112, 10, hb), 'WRONG_LINEAGE', 'a copied lineage');
  x = await start(s.backup);
  try { assert.deepEqual((await holdOf(x)).subjects, [HOLD.subject], 'still held'); } finally { await stopX(x); }
});

// r2 (review 46506): max() with a CONTROLLED fixture. The prior hold's high-water is planted ABOVE what the second promotion would
// recompute, so only max() keeps it; priorHoldEpoch names the replaced hold's EPOCH (the store epoch, not commit-sequence history).
test('#1749 (H7b) a re-promotion keeps the PRIOR hold\'s high-water when it exceeds the recomputed one (max), and priorHoldEpoch is the replaced hold\'s epoch', T, async () => {
  const s = await scenario();
  let x = await start(s.backup, ['--promote-epoch']);
  const h1 = await holdOf(x); const firstEpoch = String((await health(x)).epoch);
  assert.deepEqual(h1.get(HOLD.restoredHighWater), [{ value: '101', datatype: `${XSD}integer` }], 'PRECONDITION: the first hold recomputed 101');
  await stopX(x);
  plantOffline(s.backup, `DELETE { GRAPH <${RG}> { <${HOLD.subject}> <${HOLD.restoredHighWater}> ?h } } INSERT { GRAPH <${RG}> { <${HOLD.subject}> <${HOLD.restoredHighWater}> "150"^^<${XSD}integer> } } WHERE { GRAPH <${RG}> { <${HOLD.subject}> <${HOLD.restoredHighWater}> ?h } }`);
  const second = store('hold-backup-max-');
  fs.cpSync(s.backup, second, { recursive: true });
  x = await start(second, ['--promote-epoch']);
  try {
    const h2 = await holdOf(x);
    assert.deepEqual(h2.get(HOLD.restoredHighWater), [{ value: '150', datatype: `${XSD}integer` }], 'max(prior 150, recomputed 101) = 150: the higher, prior value is kept');
    assert.deepEqual(h2.get(HOLD.priorHoldEpoch).map((v) => v.value), [firstEpoch], 'priorHoldEpoch is the replaced hold\'s epoch, exactly once');
    assert.notEqual(firstEpoch, String((await health(x)).epoch), 'CONTROL: the new hold\'s epoch is a different one');
  } finally { await stopX(x); }
});

test('#1749 (B5d, r3) the SAME reconcile file rerun on the reconciled store writes nothing and serves (ALREADY reconciled); a DIFFERENT file → refuses to start, NO_HOLD', T, async () => {
  const s = await scenario();
  let x = await start(s.backup, ['--promote-epoch']);
  const hb = await holdBlock(x);
  await stopX(x);
  const f = reconcileFile(s.backup, 112, 10, hb);
  x = await reconcileStart(s.backup, f);
  const b1 = await bk(x);
  await stopX(x);
  x = await reconcileStart(s.backup, f);
  try {
    const b2 = (await bk(x)).filter((l) => !l.includes('selfcheck') && !l.includes('storeHome'));
    assert.deepEqual(b2, b1.filter((l) => !l.includes('selfcheck') && !l.includes('storeHome')), 'the same file again writes nothing (one record, the allocator unchanged)');
    assert.equal((await recordsOf(x)).length, 1, 'still exactly one ReconciliationRecord');
  } finally { await stopX(x); }
  await refusedStart(s.backup, reconcileFile(s.backup, 112, 10, hb, { approvalRef: 'decision:00000000-0000-4000-8000-0000000017aa' }), 'NO_HOLD', 'a different file after success');
});

// contract v3 A5 (46518): the reconcile file names the hold it was written against; an OLD file never bypasses or clears a NEW hold
test('#1749 (B5f, r3) reconcile → backup → promote → the OLD file → refuses to start, WRONG_HOLD; the fresh hold intact and reservations still RECOVERY_HOLD', T, async () => {
  const s = await scenario();
  let x = await start(s.backup, ['--promote-epoch']);
  const hb = await holdBlock(x);
  await stopX(x);
  const old = reconcileFile(s.backup, 112, 10, hb);
  x = await reconcileStart(s.backup, old);
  await stopX(x);
  const next = store('hold-backup-b5f-'); fs.cpSync(s.backup, next, { recursive: true });
  x = await start(next, ['--promote-epoch']);
  const fresh = await holdOf(x);
  assert.equal(fresh.subjects.length, 1, 'PRECONDITION: the new promotion holds again');
  await stopX(x);
  await refusedStart(next, old, 'WRONG_HOLD', 'the old file against the new hold');
  x = await start(next);
  try {
    assert.deepEqual([...(await holdOf(x)).get(HOLD.epoch)], [...fresh.get(HOLD.epoch)], 'the fresh hold is intact');
    assert.ok(heldBy(await client(x).update(intention([ordinary('h-b5f')]))), 'and a reservation is still refused RECOVERY_HOLD');
  } finally { await stopX(x); }
});
for (const field of ['datasetId', 'epoch', 'incarnation', 'restoredCommitSeq', 'restoredHighWater']) {
  test(`#1749 (B5g, r3) a reconcile file whose hold.${field} is off by one value → refuses to start, WRONG_HOLD; the store unchanged`, T, async () => {
    const s = await scenario();
    let x = await start(s.backup, ['--promote-epoch']);
    const hb = await holdBlock(x), before = (await bk(x)).filter(isPostseq);
    await stopX(x);
    const off = { ...hb, [field]: typeof hb[field] === 'number' ? hb[field] + 1 : `${hb[field]}-other` };
    await refusedStart(s.backup, reconcileFile(s.backup, 112, 10, off), 'WRONG_HOLD', `hold.${field} off`);
    x = await start(s.backup);
    try { assert.deepEqual((await bk(x)).filter(isPostseq), before, 'nothing changed'); } finally { await stopX(x); }
  });
}

// contract A6 (46525): the reconcile file is a CLOSED schema; the check order is no-hold → WRONG_LINEAGE → WRONG_HOLD → arithmetic
for (const [what, extra] of [['an unknown top-level key', { approvedByy: 'x' }], ['an unknown key inside hold', null], ['NO hold block (a missing key)', { hold: undefined }]]) {
  test(`#1749 (B5i, r3) a reconcile file with ${what} (closed schema, A6) → refuses to start, BAD_FILE; the store unchanged, still held`, T, async () => {
    const s = await scenario();
    let x = await start(s.backup, ['--promote-epoch']);
    const hb = await holdBlock(x), before = (await bk(x)).filter(isPostseq);
    await stopX(x);
    const f = reconcileFile(s.backup, 112, 10, extra ? hb : { ...hb, extraField: 1 }, extra ?? {});
    await refusedStart(s.backup, f, 'BAD_FILE', what);
    x = await start(s.backup);
    try {
      assert.deepEqual((await bk(x)).filter(isPostseq), before, 'nothing changed');
      assert.equal((await holdOf(x)).subjects.length, 1, 'still held');
    } finally { await stopX(x); }
  });
}

// 46528: every numeric field keeps safe-integer validation, including overflow on highWater + gap + 1
// codes accepted by the contract reviewer (46533): a field that is not a (positive, for the gap)
// safe JSON integer is a schema refusal, BAD_FILE; a well-typed gap whose R = highWater + G + 1 cannot be a safe integer is BAD_GAP
for (const [what, R, G, code] of [['a declaredGap so large that highWater + gap + 1 overflows the safe integers', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 50, 'BAD_GAP'], ['a declaredGap that is not an integer', 112, 10.5, 'BAD_FILE'], ['a negative declaredGap', 100, -2, 'BAD_FILE'], ['a ZERO declaredGap (the gap is positive; only commitSeq and high-water may be zero, 46533)', 102, 0, 'BAD_FILE'], ['a nextPostSeq given as a string', '112', 10, 'BAD_FILE']]) {
  test(`#1749 (B5j, r3) a reconcile file with ${what} → refuses to start, ${code}; the store unchanged, still held`, T, async () => {
    const s = await scenario();
    let x = await start(s.backup, ['--promote-epoch']);
    const hb = await holdBlock(x), before = (await bk(x)).filter(isPostseq);
    await stopX(x);
    await refusedStart(s.backup, reconcileFile(s.backup, R, G, hb), code, what);
    x = await start(s.backup);
    try {
      assert.deepEqual((await bk(x)).filter(isPostseq), before, 'nothing changed');
      assert.equal((await holdOf(x)).subjects.length, 1, 'still held');
    } finally { await stopX(x); }
  });
}

// A2/A6 guards (5) and (6): R must exceed every evidence maxPostSeqSeen, and be at least the allocator's current next
const EVIDENCE = (maxPostSeqSeen) => [{ kind: 'post-log', location: 'board-data-events/events-2026-10-25.jsonl', sha256: '0'.repeat(64), maxPostSeqSeen }];
test('#1749 (B5k, r3) evidence whose maxPostSeqSeen is NOT below R → refuses to start, BELOW_EVIDENCE; evidence just below R is admitted', T, async () => {
  const s = await scenario();
  let x = await start(s.backup, ['--promote-epoch']);
  const hb = await holdBlock(x), before = (await bk(x)).filter(isPostseq);
  await stopX(x);
  await refusedStart(s.backup, reconcileFile(s.backup, 112, 10, hb, { evidence: EVIDENCE(112) }), 'BELOW_EVIDENCE', 'evidence at R');
  x = await start(s.backup);
  try { assert.deepEqual((await bk(x)).filter(isPostseq), before, 'nothing changed by the refusal'); } finally { await stopX(x); }
  x = await reconcileStart(s.backup, reconcileFile(s.backup, 112, 10, hb, { evidence: EVIDENCE(111) }));
  try { assert.deepEqual((await holdOf(x)).subjects, [], 'CONTROL: evidence below R reconciles'); } finally { await stopX(x); }
});
test('#1749 (B5l, r3) an allocator whose next is ABOVE R (planted offline) → refuses to start, BELOW_NEXT; still held', T, async () => {
  const s = await scenario();
  let x = await start(s.backup, ['--promote-epoch']);
  const hb = await holdBlock(x);
  await stopX(x);
  plantOffline(s.backup, `DELETE { GRAPH <${BK}> { ${P('allocator')} ${P('nextPostSeq')} ?n } } INSERT { GRAPH <${BK}> { ${P('allocator')} ${P('nextPostSeq')} "200"^^<${XSD}integer> } } WHERE { GRAPH <${BK}> { ${P('allocator')} ${P('nextPostSeq')} ?n } }`);
  await refusedStart(s.backup, reconcileFile(s.backup, 112, 10, hb), 'BELOW_NEXT', 'R below the allocator\'s next');
  x = await start(s.backup);
  try { assert.equal((await holdOf(x)).subjects.length, 1, 'still held'); } finally { await stopX(x); }
});

test('#1749 (B5h, r3) a ReconciliationRecord is PROTECTED too: an /update that deletes or rewrites it → 409 HOLD_PROTECTED, the record intact', T, async () => {
  const s = await scenario();
  let x = await start(s.backup, ['--promote-epoch']);
  const hb = await holdBlock(x);
  await stopX(x);
  x = await reconcileStart(s.backup, reconcileFile(s.backup, 112, 10, hb));
  try {
    const recs0 = await recordsOf(x);
    assert.equal(recs0.length, 1, 'PRECONDITION: one record');
    const epoch = String((await health(x)).epoch);
    for (const [what, body] of [
      ['a delete', `DELETE WHERE { GRAPH <${RG}> { <${recs0[0][0]}> ?p ?o } }`],
      ['a rewrite of its approvalRef', `DELETE { GRAPH <${RG}> { <${recs0[0][0]}> <${RECONCILE.approvalRef}> ?v } } INSERT { GRAPH <${RG}> { <${recs0[0][0]}> <${RECONCILE.approvalRef}> "decision:forged" } } WHERE { GRAPH <${RG}> { <${recs0[0][0]}> <${RECONCILE.approvalRef}> ?v } }`],
    ]) {
      const r = await fetch(`${x.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/rec-tamper-${opN++}`, 'x-epoch': epoch, 'x-manyhands-write-protocol': 'postseq-v1' }, body });
      const t = await r.text();
      assert.equal(r.status, 409, `${what}: 409 (${r.status} ${t.slice(0, 160)})`);
      assert.match(t, /HOLD_PROTECTED/, `${what}: named HOLD_PROTECTED`);
      assert.deepEqual(await recordsOf(x), recs0, `${what}: the record intact`);
    }
  } finally { await stopX(x); }
});

test('#1749 (B5e, r2) an update that deletes OR rewrites the hold is refused even WITH the current protocol header (executor-enforced protection, review 46506); the hold stays and allocation stays refused', T, async () => {
  const s = await scenario();
  const x = await start(s.backup, ['--promote-epoch']);
  try {
    const epoch = String((await health(x)).epoch);
    const h0 = await holdOf(x);
    for (const [what, body] of [
      ['a delete', `DELETE WHERE { GRAPH <${RG}> { <${HOLD.subject}> ?p ?o } }`],
      ['a rewrite of its high-water', `DELETE { GRAPH <${RG}> { <${HOLD.subject}> <${HOLD.restoredHighWater}> ?h } } INSERT { GRAPH <${RG}> { <${HOLD.subject}> <${HOLD.restoredHighWater}> "1"^^<${XSD}integer> } } WHERE { GRAPH <${RG}> { <${HOLD.subject}> <${HOLD.restoredHighWater}> ?h } }`],
    ]) {
      for (const header of [{ 'x-manyhands-write-protocol': 'postseq-v1' }, {}]) {
        const r = await fetch(`${x.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/hold-tamper-${opN++}`, 'x-epoch': epoch, ...header }, body });
        const t = await r.text();
        assert.equal(r.status, 409, `${what} (${Object.keys(header).length ? 'WITH' : 'without'} the header): 409 (${r.status} ${t.slice(0, 160)})`);
        assert.match(t, /HOLD_PROTECTED/, `${what}: named HOLD_PROTECTED (contract v3 A1)`);
      }
      assert.deepEqual([...(await holdOf(x)).get(HOLD.restoredHighWater)], [...h0.get(HOLD.restoredHighWater)], `${what}: the hold is intact, its high-water unchanged`);
    }
    assert.deepEqual((await holdOf(x)).subjects, [HOLD.subject], 'the hold is intact');
    assert.ok(heldBy(await client(x).update(intention([ordinary('h-after-tamper')]))), 'and allocation is still refused by code');
  } finally { await stopX(x); }
});

// ── r4: contract v3 A7 v2 with P1, P2, P3 v3 and P4 (refrozen at card v58) ──
// P1: protection is by EFFECT on the recovery graph, on EVERY store; graph-wide and computed-target forms are caught by what they do
const GRAPH_WIDE = [
  ['DROP ALL', 'DROP ALL'],
  ['CLEAR NAMED', 'CLEAR NAMED'],
  ['MOVE the recovery graph elsewhere', `MOVE <${RG}> TO <urn:ex:elsewhere>`],
  ['a computed-target DELETE', 'DELETE WHERE { GRAPH ?g { ?s ?p ?o } }'],
];
test('#1749 (B5m, r4, P1) on a HELD store, graph-wide and computed-target updates are refused 409 HOLD_PROTECTED; the recovery graph byte-unchanged', T, async () => {
  const s = await scenario();
  const x = await start(s.backup, ['--promote-epoch']);
  try {
    const g0 = await rg(x);
    assert.ok(g0.length > 0, 'PRECONDITION: the recovery graph holds the hold');
    for (const [what, body] of GRAPH_WIDE) {
      const r = await post(x, body);
      assert.equal(r.status, 409, `${what}: 409 (${r.status} ${r.text.slice(0, 160)})`);
      assert.match(r.text, /HOLD_PROTECTED/, `${what}: named HOLD_PROTECTED`);
      assert.deepEqual(await rg(x), g0, `${what}: the recovery graph is byte-unchanged`);
    }
  } finally { await stopX(x); }
});
test('#1749 (B5n, r4, A7 v2) on an UNHELD store (never promoted), an UNTYPED quad, a planted hold, or a planted record INTO the recovery graph is refused 409, nothing applied', T, async () => {
  const dir = store('hold-unheld-');
  const x = await start(dir, ['--create']);
  try {
    assert.deepEqual(await rg(x), [], 'PRECONDITION: the recovery graph is empty');
    const h0 = await health(x);
    for (const [what, body] of [
      ['an untyped quad', `INSERT DATA { GRAPH <${RG}> { <urn:ex:anything> <urn:ex:p> "x" } }`],
      ['a hold planted by /update', `INSERT DATA { GRAPH <${RG}> { <${HOLD.subject}> a <${HOLD.type}> ; <${HOLD.epoch}> "e" } }`],
      ['a record planted by /update', `INSERT DATA { GRAPH <${RG}> { <urn:ex:postseq/reconciliation/forged> a <${RECONCILE.record}> } }`],
    ]) {
      for (const header of [{ 'x-manyhands-write-protocol': 'postseq-v1' }, {}]) {
        const r = await post(x, body, header);
        assert.equal(r.status, 409, `${what} (${Object.keys(header).length ? 'with' : 'without'} the header): 409 (${r.status} ${r.text.slice(0, 160)})`);
        assert.match(r.text, /HOLD_PROTECTED/, `${what}: named HOLD_PROTECTED`);
      }
    }
    assert.deepEqual(await rg(x), [], 'the recovery graph is still empty');
    assert.deepEqual([(await health(x)).updates], [h0.updates], 'nothing was applied');
  } finally { await stopX(x); }
});
test('#1749 (B5o, r4, P1 authoritative graph) a hold-SHAPED quad in ANOTHER graph is inert: it is admitted, and it neither holds allocation nor satisfies a reader', T, async () => {
  const dir = store('hold-stray-');
  const x = await start(dir, ['--create']);
  try {
    await raw(x, `INSERT DATA { GRAPH <${BK}> { ${allocatorTriples(100)} } }`);
    const r = await post(x, `INSERT DATA { GRAPH <${BK}> { <${HOLD.subject}> a <${HOLD.type}> ; <${HOLD.epoch}> "${String((await health(x)).epoch)}" } }`);
    assert.equal(r.status, 200, `a stray hold-shaped quad outside the recovery graph is admitted (${r.status} ${r.text.slice(0, 160)})`);
    assert.deepEqual((await holdOf(x)).subjects, [], 'no hold is read (readers read only the recovery graph)');
    assert.equal((await client(x).update(intention([ordinary('h-stray')]))).outcome, 'APPLIED', 'and allocation is NOT held by it');
  } finally { await stopX(x); }
});
// P3 v3: every /update on every store runs body + "\n;\n" + guard ONCE, with no retry. Stated change: a body with no operation is a
// parse error (500), nothing applied. A dangling-clause body is an honest 500 with nothing applied (never fused into the guard).
test('#1749 (B5p, r4, P3 v3) on an UNHELD store: an ordinary body applies; comment-only and prologue-only bodies, and the three fusion shapes, are a 500 with NOTHING applied', T, async () => {
  const dir = store('hold-p3-');
  const x = await start(dir, ['--create']);
  try {
    const ok = await post(x, 'INSERT DATA { <urn:ex:p3/ok> <urn:ex:p> "x" }', {});
    assert.equal(ok.status, 200, `CONTROL: an ordinary body applies (${ok.status} ${ok.text.slice(0, 160)})`);
    await post(x, 'INSERT DATA { <urn:ex:p3/keep> <urn:ex:p> "x" }', {});
    for (const [what, body, mark] of [
      ['comment-only (the stated change)', '# nothing to do', null],
      ['prologue-only (the stated change)', 'PREFIX ex: <urn:ex:>', null],
      ['a DELETE template with no WHERE', 'DELETE { <urn:ex:p3/keep> <urn:ex:p> "x" }', null],
      ['an INSERT, then a dangling DELETE', 'INSERT DATA { <urn:ex:p3/t9> <urn:ex:p> "x" } ; DELETE { <urn:ex:p3/keep> <urn:ex:p> "x" }', 'urn:ex:p3/t9'],
      ['an INSERT, then a dangling WITH', 'INSERT DATA { <urn:ex:p3/t10> <urn:ex:p> "x" } ; WITH <urn:ex:g>', 'urn:ex:p3/t10'],
    ]) {
      const u0 = (await health(x)).updates;
      const r = await post(x, body, {});
      assert.equal(r.status, 500, `${what}: a 500, never a success (${r.status} ${r.text.slice(0, 160)})`);
      assert.equal((await health(x)).updates, u0, `${what}: nothing applied`);
      if (mark) assert.equal(await askQ(x, `ASK { <${mark}> ?p ?o }`), false, `${what}: its valid half was NOT applied`);
    }
    assert.equal(await askQ(x, 'ASK { <urn:ex:p3/keep> ?p ?o }'), true, 'and nothing was deleted');
  } finally { await stopX(x); }
});
// P4: a 50,000-triple INSERT DATA on an UNHELD store, this build vs the base (8edd075), median of 5; within 10% or 50 ms, whichever is larger
const BASE_REF = '8edd075';
const startBase = (dir, extra) => new Promise((resolve, reject) => {
  const src = spawnSync('git', ['show', `${BASE_REF}:graph-executor/executor.py`], { encoding: 'utf8', cwd: path.dirname(fileURLToPath(import.meta.url)) });
  if (src.status !== 0) return reject(new Error(`PRECONDITION: git show ${BASE_REF} (${src.stderr})`));
  const f = path.join(fs.mkdtempSync(path.join(path.dirname(dir), 'base-exec-')), 'executor.py'); owned.stores.add(path.dirname(f));
  fs.writeFileSync(f, src.stdout);
  const p = spawn(PY, [f, '--store', dir, '--port', '0', '--dataset-id', DSID, ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; if (out.includes('\n')) { try { const ready = JSON.parse(out.split('\n')[0]); const x = { proc: p, port: ready.port, baseUrl: `http://127.0.0.1:${ready.port}` }; owned.children.add(x); resolve(x); } catch (e) { reject(e); } } });
  p.on('exit', (code) => reject(new Error(`the base executor exited ${code}`)));
});
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
async function time50k(x) {
  const ms = [];
  for (let k = 0; k < 5; k++) {
    const body = `INSERT DATA { ${Array.from({ length: 50000 }, (_, i) => `<urn:ex:p4/${k}/${i}> <urn:ex:p> "${i}" .`).join(' ')} }`;
    const t0 = performance.now();
    const r = await post(x, body, {});
    ms.push(performance.now() - t0);
    assert.equal(r.status, 200, `PRECONDITION: the 50k insert applied (${r.status} ${r.text.slice(0, 120)})`);
  }
  return median(ms);
}
test('#1749 (P4, r4) a 50,000-triple INSERT DATA on an UNHELD store: this build is within 10% (or 50 ms) of the base 8edd075, median of 5; both printed', { ...T, timeout: 600000 }, async () => {
  const base = await startBase(store('hold-p4-base-'), ['--create']);
  let b; try { b = await time50k(base); } finally { await stopX(base); }
  const x = await start(store('hold-p4-build-'), ['--create']);
  let n; try { n = await time50k(x); } finally { await stopX(x); }
  console.log(`# P4 median ms: base ${b.toFixed(1)}, build ${n.toFixed(1)}`);
  assert.ok(n <= Math.max(b * 1.10, b + 50), `the build's median ${n.toFixed(1)} ms is within 10% or 50 ms of the base's ${b.toFixed(1)} ms`);
});
