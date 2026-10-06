/**
 * #1582 (unit 3, deliveries + model calls into the graph), THE EXECUTOR LAYER OF THE BATCH CONTRACT. The C2 batch is ONE executor
 * update carrying N guarded intentions, and its semantics are: guards are PER ENTRY (a refused guard does not stop the others), an
 * engine fault is ALL OR NOTHING (a whole-batch error, never a partial write). That second half was measured on pyoxigraph directly
 * (the builder, 19:28Z); the contract owner's reading is that a measurement on the library is not a measurement on the service that
 * will carry it. This file pins it THROUGH THE REAL EXECUTOR (`graph-executor/executor.py`) over its own HTTP surface: raw SPARQL to
 * `/update`, read back through `/query`, a SIGKILL and a restart on the same store. No test hook: `/update` already takes SPARQL.
 * Written by the separate test author BEFORE the build. Synthetic content. Without a python with pyoxigraph the rows are SKIPPED,
 * and a skip is NOT a pass.
 *
 * These rows describe behaviour the executor ALREADY HAS, so they are expected GREEN today. They are the standing statement of what
 * the batch design leans on: a library upgrade, a change to `update()` that catches an engine error, or a split of an update into
 * per-operation calls turns one of them red. The REST-layer row (an executor error on a batch update maps to a whole-batch 503 and
 * never a per-entry result or a 201) needs the build and is NOT here; see NOT COVERED.
 *
 *   X0  CONTROL, THE TEST CAN SEE WRITES: one update with two valid `INSERT DATA` applies both (200, both visible through /query).
 *   X1  AN ENGINE FAULT IS ALL OR NOTHING, AT ANY POSITION: updates of the form [valid a ; fault ; valid b] with the fault first,
 *       in the middle and last (`CREATE GRAPH` on a graph that already exists) answer a whole-update error (HTTP 500) and leave
 *       NONE of that update's inserts visible, while the data that was there BEFORE is intact.
 *   X2  AND IT STAYS GONE ACROSS A RESTART: SIGKILL the executor and start it again on the same store: still none of the failed
 *       update's inserts, and the earlier data still there. (The failed update must not have reached disk half-applied.)
 *   X3  A FAULT DOES NOT LATCH THE EXECUTOR: after the failed update, the very next valid update applies (200) and `/health` reads
 *       OK. A latched executor would turn one bad batch into a stop for every writer; the latch is for storage faults only.
 *       ⚠️ Only X3b tests this. The X3 assertions inside the X1/X2 rows run AFTER the restart, which clears a latch, so they are a
 *       sanity check that the restarted store writes; a "latch on any error" mutant survives them (measured) and dies to X3b alone.
 *   X4  GUARDS ARE PER ENTRY INSIDE ONE UPDATE: three `DELETE/INSERT ... WHERE { guard }` operations joined by `;`, the middle
 *       one's guard false: the first and third apply, the middle entry is untouched, and the update answers 200.
 *   X5  A REFUSED ENTRY IS NOT A FAULT: the X4 update with every guard false answers 200 and changes nothing (a batch of all
 *       refusals is a normal outcome, not an error).
 *
 * KILL CHECKS (4 mutants of `executor.py`'s update path, in a scratch clone, restored by hash): apply statement by statement: dies to
 * X1 middle, X1 last and X3b (X1 "first" cannot tell it apart: a fault first stops it before anything applies, which is the same
 * observable as all-or-nothing); swallow an engine error: dies to all three X1 rows and X3b; latch on any error: dies to X3b ONLY
 * (see the note on X3); apply only the first statement: dies to X0, X1, X3b, X4 and X5.
 *
 * NOT COVERED, by name: the REST mapping (an executor 500 on the batch update becomes a whole-batch 503/UNKNOWN, never per-entry
 * results, never a 201 for any entry; a proxy in front of the executor answering that one `/update` with a 500 tests it without a
 * hook, as the 1b rows already do) because the batch-on-graph route does not exist yet; the per-entry RECEIPTS the contract says a
 * batch needs; a crash or power loss DURING an update (a storage-level property, not provoked here: X2 kills the process BETWEEN
 * updates); an OSError fault (an unreachable `LOAD`), which this executor treats as a storage fault and LATCHES on: REST never builds
 * a LOAD, so it is out of reach of a caller, but it is the one place an update can latch the executor. ALSO: the executor reads an
 * op's receipt with `<opId>` in a query AFTER the update has run, so a non-IRI opId makes a SUCCESSFUL update answer 500 (seen while
 * writing this file, with a plain id): a non-IRI opId is the one case where a 500 CERTAINLY means the write landed. CORRECTED (the card's C2'' correction, 19:35Z): even with an IRI opId a 500/503 means UNKNOWN, not 'nothing applied': a receipt-read failure, a lost response or a timeout can all come after the commit, and the engine-fault rollback measured here covers only the faults provoked here. The caller keeps the same requestId and retries.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'x1-test';
const G = 'urn:x1:g';
const ex = (s) => `<urn:x1:${s}>`;
let opn = 0;
// an opId is an IRI: the executor reads its receipt with `<opId>` in a query, and a non-IRI makes that read fail AFTER the update has run
const opId = () => `urn:x1:op/${process.pid}-${Date.now()}-${++opn}`;

async function update(base, sparql) {
  const res = await fetch(`${base}/update`, { method: 'POST', headers: { 'x-op-id': opId(), 'content-type': 'application/sparql-update' }, body: sparql, signal: AbortSignal.timeout(30000) });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}
async function subjects(base) {
  const res = await fetch(`${base}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query' }, body: `SELECT ?s WHERE { GRAPH <${G}> { ?s ?p ?o } }`, signal: AbortSignal.timeout(30000) });
  assert.equal(res.status, 200, 'the read-back query is answered');
  const j = await res.json();
  return j.results.bindings.map((b) => b.s.value).sort();
}
const health = async (base) => (await fetch(`${base}/health`, { signal: AbortSignal.timeout(10000) })).json();
const ins = (s) => `INSERT DATA { GRAPH <${G}> { ${ex(s)} <urn:x1:p> "v" } }`;
async function withExecutor(body) {
  const store = tmpStore('x1-store-');
  let x = await startExecutor({ store, datasetId: DSID, create: true });
  const state = { get base() { return x.baseUrl; }, restart: async () => { await killExecutor(x); x = await startExecutor({ store, datasetId: DSID }); } };
  try { return await body(state); } finally { await killExecutor(x); }
}

test('X0 CONTROL: one update with two valid INSERT DATA applies both', { skip: SKIP, timeout: 120000 }, async () => {
  await withExecutor(async (s) => {
    const r = await update(s.base, `${ins('a')} ; ${ins('b')}`);
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.deepEqual(await subjects(s.base), [ 'urn:x1:a', 'urn:x1:b' ], 'both writes are visible through the real executor, so the rows below can see a write that was NOT rolled back');
  });
});

for (const [row, where, build] of [
  ['first', 'fault first', (f) => `${f} ; ${ins('p1')} ; ${ins('p2')}`],
  ['middle', 'fault in the middle', (f) => `${ins('p1')} ; ${f} ; ${ins('p2')}`],
  ['last', 'fault last', (f) => `${ins('p1')} ; ${ins('p2')} ; ${f}`],
]) {
  test(`X1/X2/X3 (${row}) AN ENGINE FAULT IS ALL OR NOTHING, STAYS GONE ACROSS A RESTART, AND DOES NOT LATCH: ${where}`, { skip: SKIP, timeout: 180000 }, async () => {
    await withExecutor(async (s) => {
      // data that exists BEFORE: it also creates the graph the fault will then try to create again
      assert.equal((await update(s.base, ins('before'))).status, 200);
      assert.deepEqual(await subjects(s.base), [ 'urn:x1:before' ]);
      const fault = `CREATE GRAPH <${G}>`;
      const bad = await update(s.base, build(fault));
      assert.equal(bad.status, 500, `X1: the update fails as a WHOLE with an engine error (${bad.status} ${bad.text.slice(0, 200)})`);
      assert.deepEqual(await subjects(s.base), [ 'urn:x1:before' ], `X1: none of the failed update's inserts is visible (${where}), and the data from before is intact`);
      await s.restart();
      assert.deepEqual(await subjects(s.base), [ 'urn:x1:before' ], 'X2: after SIGKILL and a restart on the same store, still none of them, and the earlier data is still there');
      const again = await update(s.base, `${ins('after1')} ; ${ins('after2')}`);
      assert.equal(again.status, 200, `the restarted store writes again (${again.status} ${again.text.slice(0, 160)}). NOTE: this is after the restart, so it does NOT test the latch; X3b does`);
      assert.deepEqual(await subjects(s.base), [ 'urn:x1:after1', 'urn:x1:after2', 'urn:x1:before' ], 'and its writes are visible');
      assert.equal((await health(s.base)).status, 'OK', '/health reads OK');
    });
  });
}

test('X3b A FAULT DOES NOT LATCH, WITHOUT A RESTART IN BETWEEN: the next valid update applies on the same process', { skip: SKIP, timeout: 120000 }, async () => {
  await withExecutor(async (s) => {
    assert.equal((await update(s.base, ins('before'))).status, 200);
    assert.equal((await update(s.base, `${ins('p1')} ; CREATE GRAPH <${G}>`)).status, 500);
    const ok = await update(s.base, ins('next'));
    assert.equal(ok.status, 200, `the same process still writes (${ok.status} ${ok.text.slice(0, 160)})`);
    assert.deepEqual(await subjects(s.base), [ 'urn:x1:before', 'urn:x1:next' ]);
    const h = await health(s.base); assert.equal(h.status, 'OK'); assert.equal(h.degraded, null);
  });
});

// A "delivery" here is a node with a state; a guarded step moves it only if its state is one of the allowed predecessors.
const st = (d) => ex(d); const P = '<urn:x1:state>';
const seed = (rows) => rows.map(([d, v]) => `INSERT DATA { GRAPH <${G}> { ${st(d)} ${P} "${v}" } }`).join(' ; ');
const guarded = (d, allowed, to) => `DELETE { GRAPH <${G}> { ${st(d)} ${P} ?old } } INSERT { GRAPH <${G}> { ${st(d)} ${P} "${to}" } } WHERE { GRAPH <${G}> { ${st(d)} ${P} ?old . FILTER(?old IN (${allowed.map((a) => `"${a}"`).join(', ')})) } }`;
async function states(base) {
  const res = await fetch(`${base}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query' }, body: `SELECT ?s ?v WHERE { GRAPH <${G}> { ?s ${P} ?v } }`, signal: AbortSignal.timeout(30000) });
  const j = await res.json(); return Object.fromEntries(j.results.bindings.map((b) => [b.s.value.replace('urn:x1:', ''), b.v.value]));
}
const CLAIMABLE = ['offered', 'queued', 'failed'];

test('X4 GUARDS ARE PER ENTRY INSIDE ONE UPDATE: the middle entry\'s guard is false; the first and third apply and the middle is untouched', { skip: SKIP, timeout: 120000 }, async () => {
  await withExecutor(async (s) => {
    assert.equal((await update(s.base, seed([['d1', 'offered'], ['d2', 'published'], ['d3', 'failed']]))).status, 200);
    assert.deepEqual(await states(s.base), { d1: 'offered', d2: 'published', d3: 'failed' });
    const r = await update(s.base, [guarded('d1', CLAIMABLE, 'claimed'), guarded('d2', CLAIMABLE, 'claimed'), guarded('d3', CLAIMABLE, 'claimed')].join(' ; '));
    assert.equal(r.status, 200, `a refused guard is not an error (${r.status} ${r.text.slice(0, 160)})`);
    assert.deepEqual(await states(s.base), { d1: 'claimed', d2: 'published', d3: 'claimed' }, 'one refusal did not stop the others, and the refused entry was not touched');
  });
});

test('X5 A REFUSED ENTRY IS NOT A FAULT: every guard false answers 200 and changes nothing', { skip: SKIP, timeout: 120000 }, async () => {
  await withExecutor(async (s) => {
    assert.equal((await update(s.base, seed([['d1', 'published'], ['d2', 'published']]))).status, 200);
    const r = await update(s.base, [guarded('d1', CLAIMABLE, 'claimed'), guarded('d2', CLAIMABLE, 'claimed')].join(' ; '));
    assert.equal(r.status, 200, `a batch of refusals is a normal outcome (${r.status})`);
    assert.deepEqual(await states(s.base), { d1: 'published', d2: 'published' }, 'nothing changed');
  });
});
