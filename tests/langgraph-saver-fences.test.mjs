/**
 * #1562 — the two requirements a reviewer set on OxigraphSaver before any real
 * workflow relies on it:
 *
 *   R1  a read (getTuple / list) racing deleteThread returns EITHER the complete
 *       pre-delete checkpoint WITH all its pending writes, OR nothing — never a
 *       mixed tuple (checkpoint with writes partly/fully gone, or one
 *       generation's writes attached to another generation's checkpoint);
 *   R2  a put / putWrites built against a generation that deleteThread has since
 *       bumped writes NOTHING, and the fence is evaluated INSIDE the compiled
 *       update (the same DELETE/INSERT WHERE), not only by an earlier read.
 *
 * Interleavings are forced deterministically by wrapping the graph client (a
 * hook runs a deleteThread from ANOTHER saver between two client calls), plus
 * one stress test that issues reads and a delete concurrently over HTTP to the
 * real, multi-threaded executor. Fabricated data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { INTERRUPT, uuid6 } from '@langchain/langgraph-checkpoint';
import { createGraphClient } from '../core/graph-client.mjs';
import { lgMint } from '../core/graph-compiler.mjs';
import { OxigraphSaver } from '../core/langgraph-saver.mjs';
import { HAVE_PY, PY, startExecutor, killExecutor, tmpStore } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;

let exec, client;
let scopeN = 0;
const newScope = () => `f${process.pid}x${++scopeN}`;

before(async () => {
  if (SKIP) return;
  exec = await startExecutor({ store: tmpStore('lg-fence-'), datasetId: 'lg-fence-test', create: true });
  client = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: 'lg-fence-test', timeoutMs: 30000 });
});
after(async () => { await killExecutor(exec); });

function cp(id, values = {}, version = 1) {
  const channel_versions = Object.fromEntries(Object.keys(values).map((k) => [k, version]));
  return { v: 4, id, ts: new Date().toISOString(), channel_values: values, channel_versions, versions_seen: {} };
}
const at = (thread, id) => ({ configurable: { thread_id: thread, checkpoint_ns: '', checkpoint_id: id } });
const root = (thread) => ({ configurable: { thread_id: thread, checkpoint_ns: '' } });
const meta = (step) => ({ source: step < 0 ? 'input' : 'loop', step, parents: {} });

/** A client that records every update and can run a hook BEFORE an update / AFTER a query. */
function hookedClient() {
  const h = { updates: [], beforeUpdate: null, afterQuery: null, queries: 0 };
  h.client = {
    ...client,
    async update(intention, o) {
      h.updates.push(intention);
      if (h.beforeUpdate && h.beforeUpdate.kinds.includes(intention.kind)) { const f = h.beforeUpdate.run; h.beforeUpdate = null; await f(); }
      return client.update(intention, o);
    },
    async query(q) {
      h.queries++;
      const r = await client.query(q);
      if (h.afterQuery) { const f = h.afterQuery; h.afterQuery = null; await f(); }
      return r;
    },
  };
  return h;
}

/** Every triple whose subject is the thread node or anything minted under it. */
async function threadTriples(scope, thread) {
  const pre = lgMint.thread(scope, thread);
  const r = await client.query(`SELECT ?s ?p ?o WHERE { ?s ?p ?o FILTER(STRSTARTS(STR(?s), "${pre}")) }`);
  assert.ok(r.ok, r.reason);
  return r.rows.map((x) => `${x.s.value} ${x.p.value} ${x.o.value}`).sort();
}
async function seededThread(s, thread, nWrites) {
  const ids = [uuid6(-1), uuid6(0)];
  await s.put(root(thread), cp(ids[0], { a: 'zero' }), meta(-1), { a: 1 });
  await s.put(at(thread, ids[0]), cp(ids[1], { a: 'one' }, 2), meta(0), { a: 2 });
  const writes = Array.from({ length: nWrites }, (_, k) => ['out', `w-${k}`]);
  await s.putWrites(at(thread, ids[1]), writes, 'taskB');
  await s.putWrites(at(thread, ids[1]), [[INTERRUPT, { value: { assignee: 'approver', ask: 'ok?' }, id: 'int-1' }]], 'taskA');
  return { ids, expectWrites: nWrites + 1 };
}
/** R1's property for one read result: nothing, or the checkpoint with EVERY pending write. */
function completeOrNothing(t, { cid, nWrites }, what) {
  if (t === undefined) return 'empty';
  assert.equal(t.checkpoint.id, cid, `${what}: wrong checkpoint`);
  assert.deepEqual(t.checkpoint.channel_values, { a: 'one' }, `${what}: channel values torn`);
  const outs = t.pendingWrites.filter((w) => w[1] === 'out').map((w) => w[2]);
  const ints = t.pendingWrites.filter((w) => w[1] === INTERRUPT);
  assert.equal(t.pendingWrites.length, nWrites + 1, `${what}: MIXED tuple — checkpoint present with ${t.pendingWrites.length} of ${nWrites + 1} pending writes`);
  assert.deepEqual(outs, Array.from({ length: nWrites }, (_, k) => `w-${k}`), `${what}: writes not the pre-delete set`);
  assert.equal(ints.length, 1, `${what}: interrupt write missing`);
  return 'full';
}

// ---------- R2: the generation fence is inside the compiled update ----------

test('#1562 R2: a gen-0 put/putWrites/runTransition intention sent AFTER deleteThread is PRECONDITION_FAILED by the update itself and writes nothing', { skip: SKIP }, async () => {
  const scope = newScope();
  const h = hookedClient();
  const s = new OxigraphSaver({ client: h.client, scope });
  const thread = 'raw-fence';
  const { ids } = await seededThread(s, thread, 3);
  // intentions the saver itself built at generation 0 (no hand-written SPARQL)
  const late = uuid6(5);
  await s.putWrites(at(thread, ids[1]), [['out', 'late-write']], 'taskC');
  await s.put(at(thread, ids[1]), cp(late, { a: 'late' }, 3), meta(1), { a: 3 });
  const g0 = h.updates.filter((i) => i.lg.gen === 0);
  const putI = g0.filter((i) => i.kind === 'lg.put').at(-1);
  const wrI = g0.filter((i) => i.kind === 'lg.putWrites').at(-1);
  assert.equal(putI.lg.cid, late);
  await s.deleteThread(thread);
  const afterDelete = await threadTriples(scope, thread);
  assert.equal(afterDelete.length, 1, `after the delete only the generation triple remains, found:\n${afterDelete.join('\n')}`);
  // a FRESH opId for the same gen-0 bodies: the duplicate guard cannot answer it, only the gen precondition can
  const run = { kind: 'lg.runTransition', opId: `${putI.opId}/run-late`, actor: putI.actor, lg: { scope, thread, ns: '', gen: 0, cid: late, to: 'done' } };
  for (const i of [{ ...putI, opId: `${putI.opId}/again` }, { ...wrI, opId: `${wrI.opId}/again` }, run]) {
    const r = await client.update(i);
    assert.equal(r.outcome, 'PRECONDITION_FAILED', `${i.kind} at a deleted generation: ${r.outcome} ${r.reason ?? ''}`);
    assert.deepEqual(await threadTriples(scope, thread), afterDelete, `${i.kind} at a deleted generation wrote into the thread`);
  }
  assert.equal(await s.getTuple(at(thread, late)), undefined);
  assert.equal(await s.getTuple(at(thread, ids[1])), undefined);
});

test('#1562 R2: a put whose update lands after a concurrent deleteThread writes NOTHING (the saver does not re-aim it at the new generation)', { skip: SKIP }, async () => {
  const scope = newScope();
  const h = hookedClient();
  const s = new OxigraphSaver({ client: h.client, scope });
  const other = new OxigraphSaver({ client, scope });
  const thread = 'put-race';
  const { ids } = await seededThread(s, thread, 2);
  const late = uuid6(7);
  // the put has read generation 0; the other saver's delete lands before its update
  h.beforeUpdate = { kinds: ['lg.put'], run: () => other.deleteThread(thread) };
  const err = await s.put(at(thread, ids[1]), cp(late, { a: 'late' }, 3), meta(1), { a: 3 }).then(() => null, (e) => e);
  assert.equal(h.beforeUpdate, null, 'the hook fired');
  // what was STORED is checked first, so a failure here names the data, not just a missing error
  assert.equal(await s.getTuple(at(thread, late)), undefined, 'the late put resurrected a checkpoint after the delete');
  assert.equal(await s.getProcess(at(thread, late)), undefined);
  const left = await threadTriples(scope, thread);
  assert.equal(left.length, 1, `only the generation triple may remain, found:\n${left.join('\n')}`);
  assert.equal(err?.name, 'ThreadDeletedError', `the caller must learn the write was fenced; got ${err?.name}: ${err?.message}`);
  assert.equal(err.result?.outcome, 'PRECONDITION_FAILED');
});

test('#1562 R2: putWrites whose update lands after a concurrent deleteThread writes NOTHING — no old-generation writes attach to a re-put checkpoint', { skip: SKIP }, async () => {
  const scope = newScope();
  const h = hookedClient();
  const s = new OxigraphSaver({ client: h.client, scope });
  const other = new OxigraphSaver({ client, scope });
  const thread = 'writes-race';
  const ids = [uuid6(-1)];
  const c0 = cp(ids[0], { a: 'zero' });
  await s.put(root(thread), c0, meta(-1), { a: 1 });
  h.beforeUpdate = { kinds: ['lg.putWrites'], run: () => other.deleteThread(thread) };
  const err = await s.putWrites(at(thread, ids[0]), [['out', 'gen0-write'], ['other', 'gen0-write-2']], 'taskB').then(() => null, (e) => e);
  assert.equal(h.beforeUpdate, null, 'the hook fired');
  const left = await threadTriples(scope, thread);
  // the same checkpoint id is legitimately written again in the new generation, WITHOUT writes
  await other.put(root(thread), c0, meta(-1), { a: 1 });
  const t = await other.getTuple(at(thread, ids[0]));
  assert.ok(t, 'the re-put checkpoint is stored');
  assert.deepEqual(t.pendingWrites, [], 'MIXED generations: a write from the deleted generation is attached to the new generation\'s checkpoint');
  assert.equal(left.length, 1, `only the generation triple may remain, found:\n${left.join('\n')}`);
  assert.equal(err?.name, 'ThreadDeletedError', `the caller must learn the write was fenced; got ${err?.name}: ${err?.message}`);
  assert.equal(err.result?.outcome, 'PRECONDITION_FAILED');
});

// ---------- R1: reads racing deleteThread ----------

test('#1562 R1: getTuple / list with a deleteThread landing DURING the read (between any two of its queries) return all-or-nothing', { skip: SKIP }, async () => {
  for (const reader of ['getTuple', 'list', 'getTuple-latest']) {
    for (const when of ['after-first-query', 'before-read']) {
      const scope = newScope();
      const thread = `read-race-${reader}-${when}`;
      const writer = new OxigraphSaver({ client, scope });
      const nWrites = 12;
      const { ids } = await seededThread(writer, thread, nWrites);
      const h = hookedClient();
      const r = new OxigraphSaver({ client: h.client, scope });
      if (when === 'before-read') await writer.deleteThread(thread);
      else h.afterQuery = () => writer.deleteThread(thread);
      let got;
      if (reader === 'getTuple') got = await r.getTuple(at(thread, ids[1]));
      else if (reader === 'getTuple-latest') got = await r.getTuple(root(thread));
      else { const xs = []; for await (const t of r.list(root(thread), { limit: 1 })) xs.push(t); assert.ok(xs.length <= 1); got = xs[0]; }
      assert.equal(h.afterQuery, null, `${reader}/${when}: the hook did not fire`);
      const kind = completeOrNothing(got, { cid: ids[1], nWrites }, `${reader}/${when}`);
      // the delete DID land: a read now is empty, so "full" above was the pre-delete snapshot
      assert.equal(await r.getTuple(at(thread, ids[1])), undefined, `${reader}/${when}: the delete did not land`);
      assert.equal(kind, when === 'before-read' ? 'empty' : 'full', `${reader}/${when}: ${kind}`);
    }
  }
});

test('#1562 R1 stress: reads issued CONCURRENTLY with a deleteThread to the multi-threaded executor are each all-or-nothing', { skip: SKIP, timeout: 180000 }, async () => {
  // READERS loop until the delete is acknowledged (plus one read after), so reads are in
  // flight on the executor's other threads while the delete commits. Both outcomes must be
  // seen across the run, or the test did not sample the boundary at all.
  const ROUNDS = 6, READERS = 8, nWrites = 150;
  const tally = { full: 0, empty: 0, overlapped: 0, reads: 0 };
  for (let round = 0; round < ROUNDS; round++) {
    const scope = newScope();
    const thread = `stress-${round}`;
    const s = new OxigraphSaver({ client, scope });
    const { ids } = await seededThread(s, thread, nWrites);
    let delStart = Infinity, delEnd = Infinity, delDone = false;
    const reader = async (k) => {
      const r = new OxigraphSaver({ client, scope });
      const out = [];
      for (let n = 0; n < 400; n++) {
        const last = delDone;
        const t0 = performance.now();
        let got;
        if ((k + n) % 2) got = await r.getTuple(at(thread, ids[1]));
        else { for await (const t of r.list(root(thread), { limit: 1 })) got = t; }
        out.push({ got, t0, t1: performance.now(), k, n });
        if (last) break;
      }
      return out;
    };
    const reads = Array.from({ length: READERS }, (_, k) => reader(k));
    const del = (async () => { await new Promise((res) => setTimeout(res, 15)); delStart = performance.now(); await s.deleteThread(thread); delEnd = performance.now(); delDone = true; })();
    const results = (await Promise.all(reads)).flat();
    await del;
    for (const x of results) {
      tally.reads++;
      tally[completeOrNothing(x.got, { cid: ids[1], nWrites }, `round ${round} reader ${x.k} read ${x.n}`)]++;
      if (x.t0 < delEnd && x.t1 > delStart) tally.overlapped++;
    }
    assert.equal(await s.getTuple(at(thread, ids[1])), undefined);
  }
  console.log(`# R1 stress: ${tally.reads} reads — ${tally.full} full, ${tally.empty} empty, ${tally.overlapped} in flight while the delete was in flight (client-side clock)`);
  assert.equal(tally.full + tally.empty, tally.reads);
  assert.ok(tally.full > 0 && tally.empty > 0, 'the run never sampled both sides of the delete');
  assert.ok(tally.overlapped > 0, 'no read was in flight while the delete was');
});
