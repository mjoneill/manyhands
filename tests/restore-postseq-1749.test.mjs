/**
 * #1749 — B1, the allocator half: a graph-store RESTORE never reuses a post number.
 *
 * Contract v1 §7 row B1: "Independently restore backup into isolated runtime, compare epochs/high-water/reservation/payload/
 * status joins and perform new allocation/retry". Negative control: "Backup omits allocator/outbox, or restore reuses number".
 * And §5: "After restore, RECONCILE_REQUIRED / absent receipt is a hold requiring downstream reconciliation; simply refreshing
 * epoch and blindly replaying is forbidden."
 *
 * THE HAZARD these rows pin: numbers handed out AFTER the backup die with the live store, but they may already be on posts other
 * seats have read. A restored allocator that simply carries on from its backed-up nextPostSeq hands the same numbers out again.
 * The restore can't know how many were lost, so a PROMOTED restore must refuse new allocation until it is reconciled against
 * evidence from outside the store.
 *
 * ROWS ONLY; the reconciliation step isn't built. Restore here is the supported path: copy the stopped store, start it with
 * --promote-epoch (#1559). The allocator is seeded by hand into the bookkeeping graph, as the slice-1 rows do.
 *   B0  CONTROL: the restored allocator and reservations are byte-identical to the backup's; the promotion adds its hold,
 *       and the allocator reads RECOVERY_HOLD until reconciled (contract v2 V2-1/V2-2, as frozen)
 *   B1  an old-epoch replay of a reservation made BEFORE the backup answers with its ORIGINAL numbers (the receipt survived)
 *   B2  an old-epoch replay of the reservation LOST with the live store is RECONCILE_REQUIRED, never re-issued
 *   B3  RED today: a NEW reservation from a fresh client on the promoted restore is NOT allocated (it would reuse a lost number);
 *       the allocator and the reservation set are unchanged
 *   B4  NEGATIVE CONTROL: a backup that lost its allocator refuses every reservation, with no side effects
 *   B5  RETIRED here: reconciliation is the frozen interface's maintenance start, tested by tests/recovery-hold-1749.test.mjs
 *       (B5a: the next allocation is exactly R = high-water + gap + 1; B5b–B5p its refusals).
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
const DSID = 'b1-1749';
const BK = 'urn:scrum:bookkeeping:executor';
const P = (x) => `<urn:ex:postseq/${x}>`;
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const EPOCH = 'e-1749-test';

const ordinary = (requestId) => ({ mode: 'ordinary', author: 'ada', requestId, draft: { body: `post ${requestId}`, attachedTo: null, mentions: [], attachments: [], conversation: null, onBehalfOf: null } });
const intention = (reservations) => ({ kind: 'postseq.reserve', opId: M.reserveOpId(reservations), actor: 'urn:ex:seat/ada', reservations });
const allocatorTriples = (next = 100) =>
  `${P('allocator')} a ${P('Allocator')} ; ${P('postSeqEpoch')} "${EPOCH}" ; ${P('nextPostSeq')} "${next}"^^<${XSD}integer> ; ${P('version')} "1"^^<${XSD}integer> .`;

// every store and child is tracked, so a failed precondition can neither leak an executor nor hang the run
const owned = { stores: new Set(), children: new Set() };
const store = (p) => { const d = tmpStore(p); owned.stores.add(d); fs.rmSync(d, { recursive: true }); return d; };
const start = async (dir, extra = []) => { const x = await spawnExecutor(['--store', dir, '--port', '0', '--dataset-id', DSID, ...extra]); owned.children.add(x); return x; };
const stopX = async (x) => { await killExecutor(x); owned.children.delete(x); };
after(async () => {
  for (const x of owned.children) await killExecutor(x);
  for (const d of owned.stores) fs.rmSync(d, { recursive: true, force: true });
});
const client = (x) => createGraphClient({ baseUrl: x.baseUrl, expectedDatasetId: DSID, label: 'b1-1749-rows' });
let opN = 0;
const raw = async (x, sparql) => {
  const epoch = String((await (await fetch(`${x.baseUrl}/health`)).json()).epoch);   // a promoted store refuses a write without its CURRENT epoch
  const r = await fetch(`${x.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/b1-${process.pid}-${opN++}`, 'x-epoch': epoch }, body: sparql });
  assert.equal(r.status, 200, `PRECONDITION: test setup write (${await r.text()})`);
};
const health = async (x) => (await fetch(`${x.baseUrl}/health`)).json();

/** The bookkeeping graph as sorted canonical lines: the restore is compared on CONTENT, never on a count. */
const bk = async (x, graph = BK) => {
  const r = await fetch(`${x.baseUrl}/query`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/b1q-${opN++}` }, body: `SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }` });
  assert.equal(r.status, 200);
  const t = (b) => `${b.type}:${b.value}:${b.datatype || ''}`;
  return (await r.json()).results.bindings.map((b) => [t(b.s), t(b.p), t(b.o)].join(' ')).sort();
};
// the RecoveryHold (contract v2 V2-1) is written BY the promotion, into its own recovery graph (A7 v2, P2), so it is checked on its own
const RECOVERY = 'urn:ex:postseq/recovery';
const isHold = (line) => line.startsWith('uri:urn:ex:postseq/recovery-hold');
const isPostseq = (line) => line.startsWith('uri:urn:ex:postseq/') && !isHold(line);
const seqsOf = async (c, items) => {
  const out = [];
  for (const it of items) {
    const r = await M.readPostSeqReservation(c, postWriteId(it.author, it.requestId));
    out.push(r.ok ? r.reservation?.postSeq ?? null : null);
  }
  return out;
};

/**
 * The scenario every row shares: live store seeded at 100 → reserve A (2 items: 100, 101) → stop → BACKUP (a copy) →
 * start live again → reserve B (1 item: 102) → stop. The live store is then "lost". Returns the paths and the intentions.
 */
async function scenario({ dropAllocatorFromBackup = false } = {}) {
  const live = store('b1-live-');
  let x = await start(live, ['--create']);
  await raw(x, `INSERT DATA { GRAPH <${BK}> { ${allocatorTriples(100)} } }`);
  const A = intention([ordinary('b1-a1'), ordinary('b1-a2')]);
  const rA = await client(x).update(A);
  assert.equal(rA.outcome, 'APPLIED', `PRECONDITION: A reserved (${JSON.stringify(rA).slice(0, 200)})`);
  assert.deepEqual(await seqsOf(client(x), A.reservations), [100, 101], 'PRECONDITION: A holds 100, 101');
  const epochBefore = (await health(x)).epoch;
  const postseqAtBackup = (await bk(x)).filter(isPostseq);   // read from the live store at the backup instant (a copy can't serve unpromoted)
  await stopX(x);
  const backup = store('b1-backup-');
  fs.cpSync(live, backup, { recursive: true });
  x = await start(live);
  const B = intention([ordinary('b1-b1')]);
  const rB = await client(x).update(B);
  assert.equal(rB.outcome, 'APPLIED', 'PRECONDITION: B reserved on the live store only');
  assert.deepEqual(await seqsOf(client(x), B.reservations), [102], 'PRECONDITION: B holds 102, a number that dies with the live store');
  await stopX(x);
  if (dropAllocatorFromBackup) {
    const y = await start(backup, ['--promote-epoch']);   // the home seal: a copy serves only once promoted
    await raw(y, `DELETE WHERE { GRAPH <${BK}> { ${P('allocator')} ?p ?o } }`);
    await stopX(y);
  }
  return { live, backup, A, B, epochBefore, postseqAtBackup };
}

test('#1749 (B0) CONTROL: a promoted restore\'s allocator and reservations are byte-identical to the backup\'s', T, async () => {
  const s = await scenario();
  const x = await start(s.backup, ['--promote-epoch']);
  try {
    assert.notEqual((await health(x)).epoch, s.epochBefore, 'PRECONDITION: promotion bumped the epoch');
    assert.ok(s.postseqAtBackup.length > 0, 'PRECONDITION: the comparison is not of two empty sets');
    // promotion rewrites the store's own epoch marker, so the comparison is of the postseq records, all of them, by content
    assert.deepEqual((await bk(x)).filter(isPostseq), s.postseqAtBackup, 'allocator and reservations restored exactly');
    assert.ok((await bk(x, RECOVERY)).some(isHold), 'the promotion wrote its RecoveryHold (V2-1) into the recovery graph (A7 v2, P2)');
    assert.ok(!(await bk(x)).some(isHold), 'and none into the bookkeeping graph');
    assert.deepEqual(await M.readPostSeqAllocator(client(x)), { ok: false, status: 'RECOVERY_HOLD' },
      'the allocator does not read as usable until reconciled (H6, V2-2): its next, 102, may be the lost store\'s number');
  } finally { await stopX(x); }
});

test('#1749 (B1) an old-epoch replay of a reservation made BEFORE the backup answers with its original numbers', T, async () => {
  const s = await scenario();
  const x = await start(s.backup, ['--promote-epoch']);
  try {
    const r = await client(x).update(s.A, { epoch: String(s.epochBefore) });
    assert.equal(r.outcome, 'APPLIED', `the recorded outcome still answers (${JSON.stringify(r).slice(0, 200)})`);
    assert.deepEqual(await seqsOf(client(x), s.A.reservations), [100, 101], 'and its numbers are the originals');
  } finally { await stopX(x); }
});

test('#1749 (B2) an old-epoch replay of the reservation LOST with the live store is RECONCILE_REQUIRED, never re-issued', T, async () => {
  const s = await scenario();
  const x = await start(s.backup, ['--promote-epoch']);
  try {
    const before = await bk(x);
    const r = await client(x).update(s.B, { epoch: String(s.epochBefore) });
    assert.equal(r.outcome, 'RECONCILE_REQUIRED', `B's 102 may already be on a post: no blind replay (${JSON.stringify(r).slice(0, 200)})`);
    assert.deepEqual(await bk(x), before, 'nothing was written');
  } finally { await stopX(x); }
});

test('#1749 (B3) RED: a NEW reservation from a fresh client on a promoted restore is NOT allocated until reconciled — it would reuse a lost number', T, async () => {
  const s = await scenario();
  const x = await start(s.backup, ['--promote-epoch']);
  try {
    const before = await bk(x);
    const C = intention([ordinary('b1-c1')]);
    const r = await client(x).update(C);   // a fresh client learns the NEW epoch, so the epoch fence admits it
    assert.notEqual(r.outcome, 'APPLIED',
      `a promoted restore allocated ${JSON.stringify(await seqsOf(client(x), C.reservations))}: 102 was B's on the lost store, and may be on a post already (${JSON.stringify(r).slice(0, 160)})`);
    // a refusal may be RECORDED (a receipt, a commitSeq step: a definitive outcome is durable), so the claim is about the postseq records
    assert.deepEqual((await bk(x)).filter(isPostseq), before.filter(isPostseq), 'the allocator and the reservations are unchanged');
  } finally { await stopX(x); }
});

test('#1749 (B4) NEGATIVE CONTROL: a backup that lost its allocator refuses every reservation, with no side effects', T, async () => {
  const s = await scenario({ dropAllocatorFromBackup: true });
  const x = await start(s.backup, ['--promote-epoch']);
  try {
    const before = await bk(x);
    assert.equal((await M.readPostSeqAllocator(client(x))).ok, false, 'PRECONDITION: the allocator is gone from this backup');
    const r = await client(x).update(intention([ordinary('b1-d1')]));
    assert.notEqual(r.outcome, 'APPLIED', `no allocator, no number (${JSON.stringify(r).slice(0, 160)})`);
    // the refusal's own receipt is expected (probed: op/postseq/reserve/<digest> + a commitSeq step); no allocator or reservation is
    assert.deepEqual((await bk(x)).filter(isPostseq), before.filter(isPostseq), 'no allocator invented, no reservation written');
  } finally { await stopX(x); }
});

// B5 (after reconciliation a new reservation is allocated ABOVE the restored high-water) is RETIRED here: the frozen recovery
// interface (#1749 v2 + v3 A1–A7, P1–P4) made reconciliation an executor maintenance start, and the hold rows test it there
// (tests/recovery-hold-1749.test.mjs B5a: the next allocation is exactly R = high-water + gap + 1; B5b–B5p its refusals).
