/**
 * #1629 slice 1 — the `postseq.reserve` primitive: ONE executor-owned allocator shared by ordinary posts and announcement slots (contract v2 §1,
 * §7 rows A1, A2 and DS1; the interface in docs/1629-postseq-reserve-slice1-shape.md). TEST AUTHOR's, written before any build.
 *
 * Black-box over the module the shape names (core/postseq-reserve.mjs: reserveOpId, readPostSeqReservation, readPostSeqAllocator), the EXISTING
 * graph client (createGraphClient(...).update) and a REAL executor on a throwaway store. The allocator is seeded straight into that store's
 * bookkeeping graph (the shape's "trusted test setup path": there is no production initializer in this slice). Every row asserts persisted
 * readback and allocator state, never an APPLIED outcome alone.
 *
 *   A1a  an ordinary batch (2) and an announcement batch (2), sent CONCURRENTLY against one allocator at 100: both APPLIED; the four numbers are
 *        exactly 100..103, unique; each batch's numbers are consecutive in item order; one createdAt per batch; the allocator is next 104,
 *        version 3; the persisted draft and identity are what was sent
 *   A1b  the same two intentions again: APPLIED (the original receipt), every readback byte-identical, the allocator unchanged
 *   A1c  eight single-item batches sent concurrently: numbers exactly 100..107, no gap, no repeat; allocator next 108, version 9
 *   A2   each refuses with NO side effects (no reservation written, allocator unchanged or still unreadable):
 *        a no allocator · b two allocator tuples · c nextPostSeq not an integer · d nextPostSeq 0 · e an advance past MAX_SAFE_INTEGER (next =
 *        MAX-1, N = 2) · g a batch with the same identity twice · h a batch containing an identity already reserved (its other item is NOT
 *        allocated) · i a root field the shape forbids (nextPostSeq) · j nextPostSeq typed xsd:decimal (it adds, so only a DATATYPE check refuses it;
 *        c's "abc" cannot add and so cannot tell a check from none) · and f, the CONTROL for e: next = MAX-2, N = 2 lands exactly on MAX and is
 *        APPLIED, so e is refused for the overflow and not for the size of the number
 *   DS1  the same identities with a changed draft collide at the SAME opId (REJECTED, intent-collision) and change nothing: a changed body, a
 *        changed mention list, an announcement's notify flipped. The stored reserveDigest is the canonical digest of the intention as sent
 *        (no executor-assigned value can be in it: none is an input)
 *
 *   S1   PRODUCTION GUARD (asked for in review, 43529): the compiled update passes the compiler's own staticCheck (every write ?ok-guarded, every
 *        triple in the graph its vocabulary says), for an ordinary and an announcement batch. The rows' scratch proof BYPASSED staticCheck, so
 *        S1 is the one row here NOT shown satisfiable by the test author: passing it needs staticCheck to know the postseq vocabulary, which
 *        is the build's (shape: POSTSEQ_TERMS shared across compiler, read and authority). The behavioural half of "no unguarded write" is A2:
 *        a scratch mutant that wrote the reservation under a constant subject (unguarded) turned A2a-e, h and j red.
 *
 * NOT covered, by name: an HTTP 409 mapping (no adapter exists in this slice, shape §"Persisted result"); UNKNOWN and RECONCILE_REQUIRED paths
 * (E1); the malformed-STORED-reservation read (INVALID), which needs a reservation seeded by hand in the reservation vocabulary (next, with the
 * build's own fixtures); restore and restart (B1); the O1 composition inside a business transaction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { canonicalize, digestOf, compile, staticCheck } from '../core/graph-compiler.mjs';
import { postWriteId } from '../core/post-write.mjs';
import { announcePostId } from '../core/announce-outbox.mjs';

const MOD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'core', 'postseq-reserve.mjs');
let M = null, modErr = null;
try { M = await import(pathToFileURL(MOD).href); } catch (e) { modErr = e; }
const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 240000 };
const DSID = 'ps1629';
const BK = 'urn:scrum:bookkeeping:executor';
const P = (x) => `<urn:ex:postseq/${x}>`;
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const MAX = Number.MAX_SAFE_INTEGER;
const EPOCH = 'e-1629-test';

const ordinary = (requestId, draft = {}) => ({ mode: 'ordinary', author: 'ada', requestId, draft: { body: `post ${requestId}`, attachedTo: null, mentions: [], attachments: [], conversation: null, onBehalfOf: null, ...draft } });
const announcement = (slot, draft = {}) => ({ mode: 'announcement', mutationId: 'mut-1629', slot, draft: { body: `announce ${slot}`, author: 'board', originActor: 'ada', occurredAt: '2026-10-18T03:00:00.000Z', mentions: ['ada'], notify: false, ...draft } });
const postIdOf = (item) => (item.mode === 'ordinary' ? postWriteId(item.author, item.requestId) : announcePostId(item.mutationId, item.slot));
const intention = (reservations, extra = {}) => ({ kind: 'postseq.reserve', opId: M.reserveOpId(reservations), actor: 'urn:ex:seat/ada', reservations, ...extra });

/** The allocator triples, by hand, for the seed. `next`/`version` are written as given (a number becomes xsd:integer, a string a plain literal). */
const lit = (v) => (typeof v === 'number' ? `"${v}"^^<${XSD}integer>` : JSON.stringify(String(v)));
const allocatorTriples = ({ epoch = EPOCH, next = 100, version = 1 } = {}) =>
  `${P('allocator')} a ${P('Allocator')} ; ${P('postSeqEpoch')} ${lit(epoch)} ; ${P('nextPostSeq')} ${lit(next)} ; ${P('version')} ${lit(version)} .`;
let seedN = 0;
async function seed(exec, triples) {
  const r = await fetch(`${exec.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/postseq-seed-${process.pid}-${seedN++}` }, body: `INSERT DATA { GRAPH <${BK}> { ${triples} } }` });
  assert.equal(r.status, 200, `PRECONDITION: the test seed was written (${await r.text()})`);
}

async function world(seedTriples, body) {
  assert.ok(M, `the slice-1 module core/postseq-reserve.mjs does not exist yet (${modErr?.message?.slice(0, 120)})`);
  const store = tmpStore('ps1629-'); const fs = await import('node:fs'); fs.rmSync(store, { recursive: true });
  const exec = await startExecutor({ store, datasetId: DSID, create: true });
  try {
    if (seedTriples) await seed(exec, seedTriples);
    const client = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID, label: 'postseq-1629-rows' });
    await body({ exec, client });
  } finally { await killExecutor(exec); fs.rmSync(store, { recursive: true, force: true }); }
}
const reservationOf = async (client, item) => {
  const r = await M.readPostSeqReservation(client, postIdOf(item));
  assert.equal(r.ok, true, `the reservation of ${postIdOf(item)} is readable (${JSON.stringify(r)})`); return r.reservation;
};
const allocatorOf = async (client) => M.readPostSeqAllocator(client);

// ── A1 ──
test('#1629 (A1a) an ordinary and an announcement batch, sent concurrently, share one allocator: 100..103, consecutive per batch', T, async () => {
  await world(allocatorTriples(), async ({ client }) => {
    const O = [ordinary('a1-r1'), ordinary('a1-r2')], A = [announcement('claim'), announcement('done')];
    const [ro, ra] = await Promise.all([client.update(intention(O)), client.update(intention(A))]);
    assert.equal(ro.outcome, 'APPLIED', `the ordinary batch (${JSON.stringify(ro).slice(0, 200)})`); assert.equal(ra.outcome, 'APPLIED', `the announcement batch (${JSON.stringify(ra).slice(0, 200)})`);
    const res = { O: [], A: [] };
    for (const [k, items] of [['O', O], ['A', A]]) for (const it of items) res[k].push(await reservationOf(client, it));
    const all = [...res.O, ...res.A];
    assert.ok(all.every((r) => r && Number.isSafeInteger(r.postSeq)), `every item is reserved with an integer postSeq (${JSON.stringify(all)})`);
    assert.deepEqual(all.map((r) => r.postSeq).sort((a, b) => a - b), [100, 101, 102, 103], 'exactly 100..103, no gap, no repeat');
    for (const [k, items] of [['O', O], ['A', A]]) {
      const rs = res[k];
      assert.equal(rs[1].postSeq, rs[0].postSeq + 1, `${k}: the batch's numbers are consecutive in item order`);
      assert.deepEqual(rs.map((r) => r.index), [0, 1], `${k}: and each knows its batch slot`);
      assert.equal(rs[0].createdAt, rs[1].createdAt, `${k}: one executor time per batch`);
      assert.ok(!Number.isNaN(Date.parse(rs[0].createdAt)), `${k}: and it is a time (${rs[0].createdAt})`);
      rs.forEach((r, i) => {
        assert.equal(r.postSeqEpoch, EPOCH, `${k}[${i}]: the allocator's epoch`);
        assert.equal(r.mode, items[i].mode); assert.equal(r.postId, postIdOf(items[i]));
        assert.equal(r.draft.body, items[i].draft.body, `${k}[${i}]: the persisted draft is the one sent`);
        assert.deepEqual(r.draft.mentions, items[i].draft.mentions);
      });
    }
    assert.deepEqual(res.O[0].identity, { author: 'ada', requestId: 'a1-r1' }); assert.deepEqual(res.A[1].identity, { mutationId: 'mut-1629', slot: 'done' });
    const a = await allocatorOf(client);
    assert.deepEqual(a, { ok: true, allocator: { postSeqEpoch: EPOCH, nextPostSeq: 104, version: 3 } }, 'the allocator advanced by 4 in two versions');
  });
});

test('#1629 (A1b) replaying both intentions is APPLIED by the original receipt and changes nothing', T, async () => {
  await world(allocatorTriples(), async ({ client }) => {
    const O = [ordinary('a1-r1'), ordinary('a1-r2')], A = [announcement('claim'), announcement('done')];
    for (const b of [O, A]) assert.equal((await client.update(intention(b))).outcome, 'APPLIED', 'PRECONDITION: the first send applies');
    const before = []; for (const it of [...O, ...A]) before.push(await reservationOf(client, it));
    const a0 = await allocatorOf(client);
    for (const b of [O, A]) assert.equal((await client.update(intention(b))).outcome, 'APPLIED', 'a replay is APPLIED (the original receipt)');
    const after = []; for (const it of [...O, ...A]) after.push(await reservationOf(client, it));
    assert.deepEqual(after, before, 'every reservation reads back byte-identical: same number, same time, same draft');
    assert.deepEqual(await allocatorOf(client), a0, 'and the allocator did not move');
  });
});

test('#1629 (A1c) eight single-item batches sent concurrently take exactly 100..107', T, async () => {
  await world(allocatorTriples(), async ({ client }) => {
    const items = Array.from({ length: 8 }, (_, i) => (i % 2 ? announcement(`s${i}`) : ordinary(`c-${i}`)));
    const outs = await Promise.all(items.map((it) => client.update(intention([it]))));
    assert.ok(outs.every((o) => o.outcome === 'APPLIED'), `all eight apply (${outs.map((o) => o.outcome)})`);
    const seqs = []; for (const it of items) seqs.push((await reservationOf(client, it)).postSeq);
    assert.deepEqual([...seqs].sort((a, b) => a - b), [100, 101, 102, 103, 104, 105, 106, 107], `no gap and no repeat (${seqs})`);
    assert.deepEqual((await allocatorOf(client)).allocator, { postSeqEpoch: EPOCH, nextPostSeq: 108, version: 9 });
  });
});

// ── A2 ──
const BAD = [
  ['a', 'no allocator at all', null],
  ['b', 'two allocator tuples', `${allocatorTriples({ next: 100 })} ${P('allocator')} ${P('nextPostSeq')} ${lit(200)} .`],
  ['c', 'nextPostSeq that is not an integer', allocatorTriples({ next: 'abc' })],
  ['d', 'nextPostSeq 0', allocatorTriples({ next: 0 })],
  ['e', 'an advance past MAX_SAFE_INTEGER (next MAX-1, N 2)', allocatorTriples({ next: MAX - 1 })],
  // j: a number that DOES do arithmetic but is not an xsd:integer. "abc" (c) cannot add, so c alone cannot tell a datatype check from none
  // (a mutant without the check survived c on the scratch build); a decimal 100 adds fine and is only refused BY the datatype check
  ['j', 'nextPostSeq typed xsd:decimal ("100")', `${P('allocator')} a ${P('Allocator')} ; ${P('postSeqEpoch')} ${lit(EPOCH)} ; ${P('nextPostSeq')} "100"^^<${XSD}decimal> ; ${P('version')} ${lit(1)} .`],
];
for (const [id, label, seedT] of BAD) {
  test(`#1629 (A2${id}) ${label}: the reservation is refused with no side effects`, T, async () => {
    await world(seedT, async ({ client }) => {
      const items = [ordinary(`a2${id}-1`), ordinary(`a2${id}-2`)];
      const a0 = await allocatorOf(client);
      const o = await client.update(intention(items));
      assert.notEqual(o.outcome, 'APPLIED', `${label}: refused (${JSON.stringify(o).slice(0, 200)})`);
      for (const it of items) assert.equal(await reservationOf(client, it), null, `${label}: no reservation was written for ${it.requestId}`);
      assert.deepEqual(await allocatorOf(client), a0, `${label}: the allocator reads exactly as before (${JSON.stringify(a0)})`);
      if (id !== 'e') assert.equal(a0.ok, false, `${label}: and the allocator read itself refuses this state, never a default (${JSON.stringify(a0)})`);
    });
  });
}

test('#1629 (A2f CONTROL for A2e) next MAX-2 with N 2 lands exactly on MAX_SAFE_INTEGER and is APPLIED', T, async () => {
  await world(allocatorTriples({ next: MAX - 2 }), async ({ client }) => {
    const items = [ordinary('a2f-1'), ordinary('a2f-2')];
    assert.equal((await client.update(intention(items))).outcome, 'APPLIED', 'the boundary is allowed');
    assert.deepEqual([(await reservationOf(client, items[0])).postSeq, (await reservationOf(client, items[1])).postSeq], [MAX - 2, MAX - 1]);
    assert.equal((await allocatorOf(client)).allocator.nextPostSeq, MAX);
  });
});

test('#1629 (A2g) a batch with the same identity twice is refused and allocates nothing', T, async () => {
  await world(allocatorTriples(), async ({ client }) => {
    const it = ordinary('a2g-1'); const a0 = await allocatorOf(client);
    let o; try { o = await client.update({ kind: 'postseq.reserve', opId: M.reserveOpId([it, it]), actor: 'urn:ex:seat/ada', reservations: [it, it] }); } catch (e) { o = { outcome: 'THREW', reason: e.message }; }
    assert.notEqual(o.outcome, 'APPLIED', `refused (${JSON.stringify(o).slice(0, 200)})`);
    assert.equal(await reservationOf(client, it), null, 'no reservation'); assert.deepEqual(await allocatorOf(client), a0, 'the allocator did not move');
  });
});

test('#1629 (A2h) a batch containing an already-reserved identity is refused whole: its new item is NOT allocated', T, async () => {
  await world(allocatorTriples(), async ({ client }) => {
    const first = ordinary('a2h-1'), fresh = ordinary('a2h-9');
    assert.equal((await client.update(intention([first]))).outcome, 'APPLIED', 'PRECONDITION: the first identity is reserved');
    const held = await reservationOf(client, first); const a0 = await allocatorOf(client);
    const o = await client.update(intention([first, fresh]));
    assert.notEqual(o.outcome, 'APPLIED', `the mixed batch is refused (${JSON.stringify(o).slice(0, 200)})`);
    assert.equal(await reservationOf(client, fresh), null, 'its other item was not allocated');
    assert.deepEqual(await reservationOf(client, first), held, 'the reserved identity is untouched');
    assert.deepEqual(await allocatorOf(client), a0, 'and the allocator did not move');
  });
});

test('#1629 (A2i) a root field the shape forbids (nextPostSeq) is refused before anything is sent', T, async () => {
  await world(allocatorTriples(), async ({ client }) => {
    const it = ordinary('a2i-1'); const a0 = await allocatorOf(client);
    const o = await client.update(intention([it], { nextPostSeq: 500 }));
    assert.equal(o.outcome, 'REJECTED', `a closed schema refuses the field (${JSON.stringify(o).slice(0, 200)})`);
    assert.equal(await reservationOf(client, it), null); assert.deepEqual(await allocatorOf(client), a0);
  });
});

// ── DS1 ──
const CHANGES = [
  ['a changed body', [ordinary('ds1-1')], [ordinary('ds1-1', { body: 'post ds1-1, edited' })]],
  ['a changed mention list', [ordinary('ds1-1')], [ordinary('ds1-1', { mentions: ['grace'] })]],
  ['an announcement\'s notify flipped', [announcement('claim')], [announcement('claim', { notify: true })]],
];
for (const [label, first, changed] of CHANGES) {
  test(`#1629 (DS1) ${label} under the same identities collides at the same opId and changes nothing`, T, async () => {
    await world(allocatorTriples(), async ({ client }) => {
      assert.equal(M.reserveOpId(changed), M.reserveOpId(first), 'PRECONDITION: the reserve opId depends on the identities only');
      assert.equal((await client.update(intention(first))).outcome, 'APPLIED', 'PRECONDITION: the first draft is reserved');
      const held = await reservationOf(client, first[0]); const a0 = await allocatorOf(client);
      const o = await client.update(intention(changed));
      assert.equal(o.outcome, 'REJECTED', `${label}: refused (${JSON.stringify(o).slice(0, 200)})`); assert.equal(o.reason, 'intent-collision');
      assert.deepEqual(await reservationOf(client, first[0]), held, `${label}: the reservation keeps the ORIGINAL draft, number and time`);
      assert.deepEqual(await allocatorOf(client), a0, `${label}: and the allocator did not move`);
    });
  });
}

test('#1629 (DS1) the stored reserveDigest is the canonical digest of the intention as sent, so no assigned value can be in it', T, async () => {
  await world(allocatorTriples(), async ({ client }) => {
    const items = [ordinary('ds1-d'), announcement('claim')]; const i = intention(items);
    assert.equal((await client.update(i)).outcome, 'APPLIED');
    const want = digestOf(canonicalize(i));
    for (const it of items) {
      const r = await reservationOf(client, it);
      assert.equal(r.reserveDigest, want, 'the stored digest is the digest of the intention as sent');
      assert.equal(r.reserveOpId, i.opId, 'and the reservation names the operation that made it');
    }
    assert.equal(digestOf(canonicalize(intention(items))), want, 'and building the same intention again gives the same digest (nothing time-dependent in it)');
  });
});

test('#1629 (S1) the compiled postseq.reserve update passes the compiler\'s own staticCheck', { timeout: 30000 }, () => {
  assert.ok(M, `the slice-1 module core/postseq-reserve.mjs does not exist yet (${modErr?.message?.slice(0, 120)})`);
  for (const items of [[ordinary('s1-1'), ordinary('s1-2')], [announcement('claim')], [ordinary('s1-3'), announcement('done')]]) {
    const i = intention(items); const c = compile(i);
    const check = staticCheck(c.sparql, c.canonical.opId);
    assert.equal(check.ok, true, `staticCheck accepts the compiled update for ${items.map((x) => x.mode).join('+')}: ${JSON.stringify(check.errors ?? []).slice(0, 400)}`);
  }
});
