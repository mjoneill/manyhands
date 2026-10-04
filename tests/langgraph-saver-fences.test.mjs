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
import { StateGraph, Annotation, START, END } from '@langchain/langgraph';
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

/**
 * Every triple whose subject is the thread node or anything minted under it, EXCEPT the
 * deleteThread tombstones (<checkpoint> lg:deletedInGen g), which are asserted separately:
 * they are the only thing besides the generation a deleted thread may still hold.
 */
async function threadTriples(scope, thread) {
  const pre = lgMint.thread(scope, thread);
  const r = await client.query(`SELECT ?s ?p ?o WHERE { ?s ?p ?o FILTER(STRSTARTS(STR(?s), "${pre}")) }`);
  assert.ok(r.ok, r.reason);
  const all = r.rows.map((x) => [x.s.value, x.p.value, x.o.value]);
  for (const [s, p, o] of all.filter((t) => t[1] === 'urn:ex:lg/deletedInGen')) {
    assert.match(s, /\/cp\/[^/]+$/, `a tombstone on a non-checkpoint node: ${s}`);
    assert.match(o, /^\d+$/, `a tombstone without a generation: ${s} ${o}`);
  }
  return all.filter((t) => t[1] !== 'urn:ex:lg/deletedInGen').map((t) => t.join(' ')).sort();
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

// ---------- R2b: an OLD run's config carries its generation (via its checkpoint id) ----------

/** Live (non-tombstone) data of a thread: every node still lg:inThread it. */
async function liveTriples(scope, thread) {
  const r = await client.query(`SELECT ?s ?p ?o WHERE { ?s <urn:ex:lg/inThread> <${lgMint.thread(scope, thread)}> . ?s ?p ?o }`);
  assert.ok(r.ok, r.reason);
  return r.rows.map((x) => `${x.s.value} ${x.p.value} ${x.o.value}`).sort();
}

test('#1562 R2b: old config → deleteThread → delayed put/putWrites from that config write NOTHING into the new generation (any saver instance); new-generation work, incl. writes-before-put, still succeeds', { skip: SKIP }, async () => {
  const scope = newScope();
  const thread = 'stale-run';
  const run = new OxigraphSaver({ client, scope }); // the old run's saver
  const ids = [uuid6(-1), uuid6(0), uuid6(1)];
  const c0cfg = await run.put(root(thread), cp(ids[0], { a: 'zero' }), meta(-1), { a: 1 });
  const oldCfg = await run.put(c0cfg, cp(ids[1], { a: 'one' }, 2), meta(0), { a: 2 }); // the old run's current config
  await run.putWrites(oldCfg, [['out', 'before-delete']], 'taskA');
  await new OxigraphSaver({ client, scope }).deleteThread(thread); // the owner deletes the thread
  const gen = async () => (await client.query(`SELECT ?g WHERE { <${lgMint.thread(scope, thread)}> <urn:ex:lg/gen> ?g }`)).rows.map((x) => x.g.value);
  const genAfterDelete = await gen();

  // the old run keeps going AFTER the delete: every write is built from its old config
  const fenced = async (what, p) => {
    const e = await p.then(() => null, (x) => x);
    assert.deepEqual(await liveTriples(scope, thread), [], `${what} wrote into the new generation`);
    assert.equal(e?.name, 'ThreadDeletedError', `${what}: the caller must learn it was fenced; got ${e?.name}: ${e?.message}`);
  };
  const c2cfg = { configurable: { ...oldCfg.configurable, checkpoint_id: ids[2] } };
  await fenced('stale putWrites(old checkpoint)', run.putWrites(oldCfg, [['out', 'after-delete']], 'taskB'));
  await fenced('stale putWrites(old checkpoint) from ANOTHER saver instance', new OxigraphSaver({ client, scope }).putWrites(oldCfg, [['out', 'other-proc']], 'taskC'));
  // a write for the old run's NEXT checkpoint, whose put has not landed yet (async durability):
  // it cannot be told from writes-before-put on its own, so it may land — but the put that
  // follows is refused and reaps it, and nothing of it survives
  await run.putWrites(c2cfg, [['out', 'orphan']], 'taskD').catch(() => {});
  await fenced('stale put(child of old checkpoint)', run.put(oldCfg, cp(ids[2], { a: 'two' }, 3), meta(1), { a: 3 }));
  await fenced('stale putWrites(the refused child) after its put was refused', run.putWrites(c2cfg, [['out', 'orphan-2']], 'taskE'));
  assert.equal(await run.getTuple(oldCfg), undefined);
  assert.equal(await run.getTuple(c2cfg), undefined);
  const listed = []; for await (const t of run.list(root(thread))) listed.push(t);
  assert.deepEqual(listed, [], 'list shows data from the stale run');
  assert.deepEqual(await gen(), genAfterDelete, 'the generation moved');

  // deliberate new-generation work on the SAME thread id still succeeds, with the SAME saver instance
  const nid = [uuid6(10), uuid6(11)];
  const n0 = await run.put(root(thread), cp(nid[0], { a: 'new-zero' }, 4), meta(-1), { a: 4 });
  const n1cfg = { configurable: { ...n0.configurable, checkpoint_id: nid[1] } };
  await run.putWrites(n1cfg, [['out', 'new-early']], 'taskN'); // writes BEFORE their put
  await run.put(n0, cp(nid[1], { a: 'new-one' }, 5), meta(0), { a: 5 });
  await run.putWrites(n1cfg, [['out2', 'new-late']], 'taskM');
  const t = await run.getTuple(n1cfg);
  assert.ok(t, 'new-generation checkpoint stored');
  assert.deepEqual(t.checkpoint.channel_values, { a: 'new-one' });
  assert.deepEqual(t.pendingWrites.map((w) => w[2]).sort(), ['new-early', 'new-late']);
  // and a re-put of an OLD id with no parent (a deliberate new run reusing ids) is accepted
  await run.put(root(thread), cp(ids[0], { a: 'zero-again' }, 6), meta(-1), { a: 6 });
  assert.deepEqual((await run.getTuple(at(thread, ids[0]))).checkpoint.channel_values, { a: 'zero-again' });
});

test('#1562 R2b real StateGraph: a node deletes its own thread mid-run — every later write of that (old) run is refused; a new run on the thread then works', { skip: SKIP, timeout: 60000 }, async () => {
  for (const durability of ['sync', 'async']) {
    const scope = newScope();
    const thread = `sg-${durability}`;
    const saver = new OxigraphSaver({ client, scope });
    const owner = new OxigraphSaver({ client, scope });
    const State = Annotation.Root({ log: Annotation({ reducer: (a, b) => a.concat(b), default: () => [] }) });
    let deleteIn = 'b';
    const node = (name) => async () => {
      if (name === deleteIn) await owner.deleteThread(thread);
      return { log: [name] };
    };
    const g = new StateGraph(State).addNode('a', node('a')).addNode('b', node('b')).addNode('c', node('c'))
      .addEdge(START, 'a').addEdge('a', 'b').addEdge('b', 'c').addEdge('c', END).compile({ checkpointer: saver });
    const cfg = { configurable: { thread_id: thread } };
    const staleRun = async (what, input) => {
      deleteIn = 'b';
      const err = await g.invoke(input, { ...cfg, durability }).then(() => null, (e) => e);
      // whatever the loop does with the refusal, NOTHING of the old run may be live in the new generation
      assert.deepEqual(await liveTriples(scope, thread), [], `${durability}/${what}: the old run wrote into the new generation (invoke ${err ? `threw ${err.name}` : 'returned'})`);
      assert.equal(await saver.getTuple(cfg), undefined, `${durability}/${what}: a checkpoint of the old run is visible`);
      assert.equal(err?.name, 'ThreadDeletedError', `${durability}/${what}: the run must fail loudly; got ${err?.name}: ${err?.message}`);
    };
    const freshRun = async (what, input, expectLog) => {
      deleteIn = null;
      const out = await g.invoke(input, { ...cfg, durability });
      assert.deepEqual(out.log, expectLog, `${durability}/${what}`);
      assert.deepEqual((await saver.getTuple(cfg)).checkpoint.channel_values.log, expectLog, `${durability}/${what}: stored state`);
    };
    await staleRun('run born on an empty thread', { log: ['in'] });
    // a NEW run on the same thread id, same saver instance, is unaffected
    await freshRun('new run after the delete', { log: ['in2'] }, ['in2', 'a', 'b', 'c']);
    await freshRun('second run continuing the new history', { log: ['in3'] }, ['in2', 'a', 'b', 'c', 'in3', 'a', 'b', 'c']);
    // a run that LOADED existing history, deleted under it mid-run
    await staleRun('run born on a thread with history', { log: ['in4'] });
    await freshRun('new run after the second delete', { log: ['in5'] }, ['in5', 'a', 'b', 'c']);
  }
});
