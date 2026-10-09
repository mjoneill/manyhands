/**
 * #1562 — OxigraphSaver (core/langgraph-saver.mjs) against a REAL graph
 * executor on throwaway stores. Fabricated data only; the one "effect" in the
 * StateGraph test is an in-test array, never a real message.
 *
 * Design: research/2026-10-04-1562-saver-design-v0.1.md, v0.2 revisions.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INTERRUPT, RESUME, uuid6 } from '@langchain/langgraph-checkpoint';
import { StateGraph, Annotation, START, END, interrupt, Command } from '@langchain/langgraph';
import { createGraphClient } from '../core/graph-client.mjs';
import { compile, staticCheck, lgMint } from '../core/graph-compiler.mjs';
import { LG } from '../core/graph-vocab.mjs';
import { OxigraphSaver } from '../core/langgraph-saver.mjs';
import { ROOT, HAVE_PY, PY, startExecutor, killExecutor, tmpStore } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;
const NULL_TASK_ID = '00000000-0000-0000-0000-000000000000';

let exec, client;
let scopeN = 0;
const freshSaver = (over = {}) => new OxigraphSaver({ client, scope: `t${process.pid}x${++scopeN}`, ...over });

before(async () => {
  if (SKIP) return;
  exec = await startExecutor({ store: tmpStore('lg-test-'), datasetId: 'lg-saver-test', create: true });
  client = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: 'lg-saver-test', timeoutMs: 30000 });
});
after(async () => { await killExecutor(exec); });

// ---------- fabricated checkpoints and events ----------

function cp(id, values = {}) {
  const channel_versions = Object.fromEntries(Object.keys(values).map((k) => [k, 1]));
  return { v: 4, id, ts: new Date().toISOString(), channel_values: values, channel_versions, versions_seen: {} };
}
/** A three-checkpoint lineage C0 → C1 → C2 with an interrupt on C1, for one thread. */
function lineage(thread) {
  const ids = [uuid6(-1), uuid6(0), uuid6(1)];
  const at = (i) => ({ configurable: { thread_id: thread, checkpoint_ns: '', checkpoint_id: ids[i] } });
  const parent = (i) => ({ configurable: { thread_id: thread, checkpoint_ns: '', ...(i > 0 ? { checkpoint_id: ids[i - 1] } : {}) } });
  const step = [-1, 0, 1];
  const cps = ids.map((id) => cp(id)); // built ONCE: a replayed put is the same intention
  const put = (i) => ({ name: `P${i}`, run: (s) => s.put(parent(i), cps[i], { source: i === 0 ? 'input' : 'loop', step: step[i], parents: {} }, {}) });
  return {
    ids, at,
    P0: put(0), P1: put(1), P2: put(2),
    W1: { name: 'W1', run: (s) => s.putWrites(at(1), [['out', 'b-done']], 'taskB') },
    I1: { name: 'I1', run: (s) => s.putWrites(at(1), [[INTERRUPT, { value: { assignee: 'approver', ask: 'approve the draft?' }, id: 'int-1' }]], 'taskA') },
    R1: { name: 'R1', run: (s) => s.putWrites({ configurable: { ...at(1).configurable, resumer: 'approver' } }, [[RESUME, { approved: true }]], NULL_TASK_ID) },
  };
}
function permutations(xs) {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}
const facts = (p) => (p ? { status: p.status, head: p.head, asOfStep: p.asOfStep, waitingOn: p.waitingOn, resumedBy: p.resumedBy } : null);

/**
 * The async-possible orders at the two step boundaries (contract research §Lifecycle):
 *   invocation 1: P0 completes before P1 is dispatched (puts are chained); the
 *     step's putWrites (I1 interrupt, W1 a sibling task's write) are NOT chained
 *     to P1, so {P1, I1, W1} may land in any order — 6 orders;
 *   invocation 2 (the resume, a later invoke): the RESUME putWrites R1 is not
 *     chained to the next put P2 — 2 orders.
 * R1 cannot precede I1 (resume reads the stored interrupt), and nothing of
 * invocation 2 can precede invocation 1's end (the loop awaits its writes).
 */
const INV1 = permutations(['P1', 'I1', 'W1']).map((p) => ['P0', ...p]);
const INV2 = [['R1', 'P2'], ['P2', 'R1']];
const EXPECT1 = (L) => ({ status: 'waiting', head: L.ids[1], asOfStep: 0, waitingOn: 'approver', resumedBy: null });
const EXPECT2 = (L) => ({ status: 'running', head: L.ids[2], asOfStep: 1, waitingOn: null, resumedBy: 'approver' });

// ---------- 1 + 2: the official conformance suite, and its controls ----------

const CONF_OUT = process.env.LG_CONFORMANCE_OUT_DIR || os.tmpdir();
function runConformance(variant) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run',
    '--config', 'tests/fixtures/langgraph-conformance.vitest.config.mjs', '--root', '.', '--reporter=verbose', '--color=false'],
  { cwd: ROOT, env: { ...process.env, LG_SAVER_VARIANT: variant, NO_COLOR: '1', FORCE_COLOR: '0' }, encoding: 'utf8', timeout: 280000 });
  const out = `${r.stdout}\n${r.stderr}`;
  const file = path.join(CONF_OUT, `lg-conformance-${variant}-${process.pid}.txt`);
  fs.writeFileSync(file, out);
  const passed = Number(/Tests\s+(?:\d+ failed \| )?(\d+) passed/.exec(out)?.[1] ?? NaN);
  const failed = Number(/Tests\s+(\d+) failed/.exec(out)?.[1] ?? 0);
  const total = Number(/Tests\s+.*\((\d+)\)/.exec(out)?.[1] ?? NaN);
  const skipped = Number(/(\d+) skipped/.exec(out)?.[1] ?? 0);
  return { status: r.status, out, file, passed, failed, total, skipped };
}

test('#1562 official conformance suite (@langchain/langgraph-checkpoint-validation 1.1.1) passes against OxigraphSaver', { skip: SKIP, timeout: 300000 }, () => {
  const r = runConformance('oxigraph');
  console.log(`# conformance output: ${r.file} — ${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped, of ${r.total}`);
  assert.equal(r.status, 0, r.out.slice(-4000));
  assert.equal(r.failed, 0);
  assert.equal(r.skipped, 0, 'no conformance test may be skipped for this saver');
  assert.ok(r.total > 0 && r.passed === r.total, `passed ${r.passed} of ${r.total}`);
  // the delta-storage and fork-parent tests are not skipped for a saver named OxigraphSaver
  assert.match(r.out, /✓ .*should only store channel_values that have changed/);
  assert.match(r.out, /✓ .*reconstructs carried-over channels when loading the latest checkpoint/);
});

test('#1562 v0.2 #9 controls: the official suite FAILS a saver that drops writes, but does NOT catch putWrites-requires-checkpoint', { skip: SKIP, timeout: 300000 }, () => {
  // a control the suite must catch, so a pass above is not a harness that cannot fail
  const drops = runConformance('putwrites-drops-writes');
  console.log(`# control putwrites-drops-writes: ${drops.file} — ${drops.passed} passed, ${drops.failed} failed of ${drops.total}`);
  assert.notEqual(drops.status, 0);
  assert.ok(drops.failed > 0);
  // MEASURED GAP (2026-10-04, suite 1.1.1): every putWrites in the suite follows its put, so a
  // saver that REQUIRES the checkpoint passes it. The async-order property is proven by the
  // order-insensitivity loop below instead: runOrderPermutations against
  // DropsEarlyWritesSaver must fail by PROPERTY (not by an exception) in at least one order.
  // If a later suite version catches it, this assertion fails and should be flipped.
  const req = runConformance('putwrites-requires-checkpoint');
  console.log(`# control putwrites-requires-checkpoint: ${req.file} — ${req.passed} passed, ${req.failed} failed of ${req.total}`);
  assert.equal(req.status, 0, 'the official suite now catches putWrites-requires-checkpoint: flip this assertion');
});

// ---------- 3: order-insensitivity (v0.2 #3), run IDENTICALLY against the saver and two control savers ----------

/**
 * CONTROL saver 1: putWrites silently DROPS a write whose checkpoint is not stored
 * yet (no exception: the property check below is what must catch it).
 */
class DropsEarlyWritesSaver extends OxigraphSaver {
  async putWrites(config, writes, taskId) {
    if (!(await this.getTuple(config))) return;
    return super.putWrites(config, writes, taskId);
  }
}
/**
 * CONTROL saver 2: last-write-wins. Every put is followed by an unconditional
 * overwrite of its branch's run status to RUNNING (waitingAt/waitingOn dropped).
 * The overwrite is a raw update sent to the same executor (with an opId); it
 * deliberately bypasses the compiler's transition table — that is the defect.
 */
let lwwN = 0;
class LastWriteWinsSaver extends OxigraphSaver {
  async put(config, checkpoint, metadata, newVersions) {
    const out = await super.put(config, checkpoint, metadata, newVersions);
    const C = `<${lgMint.cp(this.scope, String(out.configurable.thread_id), out.configurable.checkpoint_ns, checkpoint.id)}>`;
    const r = await fetch(`${exec.baseUrl}/update`, {
      method: 'POST',
      headers: { 'x-op-id': `urn:ex:op/test-lww/${process.pid}/${++lwwN}`, 'content-type': 'application/sparql-update' },
      body: `DELETE { ?b ${LG.status} ?o . ?b ${LG.waitingAt} ?wa . ?b ${LG.waitingOn} ?wo } INSERT { ?b ${LG.status} ${LG.running} } WHERE { ${C} ${LG.branch} ?b . ?b ${LG.status} ?o . OPTIONAL { ?b ${LG.waitingAt} ?wa } OPTIONAL { ?b ${LG.waitingOn} ?wo } }`,
    });
    if (r.status !== 200) throw new Error(`lww overwrite failed: ${r.status}`);
    return out;
  }
}

const ROWS_OUT = process.env.LG_ROWS_OUT_DIR || os.tmpdir();
const ORDERS = INV1.flatMap((o1) => INV2.map((o2) => [o1, o2]));
/**
 * Run the 12 hand-derived orders (6 × 2, from the contract research's lifecycle
 * enumeration — NOT an exhaustive exploration of the engine) against fresh
 * savers from `saverFactory`, one thread per order. Never throws: an exception
 * inside an order is recorded on that order's row. Writes one JSONL row per
 * order and returns { rows, file }.
 */
async function runOrderPermutations(label, saverFactory) {
  const rows = [];
  for (const [k, [o1, o2]] of ORDERS.entries()) {
    const L = lineage(`perm-${label}-${k}`);
    const lab = (f) => (f ? { ...f, head: f.head == null ? null : `C${L.ids.indexOf(f.head)}` } : f);
    const row = { saver: label, orderIndex: k, order: [...o1, ...o2], afterInvocation1: null, final: null, pendingChannelsC1: null, error: null };
    try {
      const s = saverFactory();
      for (const e of o1) await L[e].run(s);
      row.afterInvocation1 = lab(facts(await s.getProcess(L.at(1))));
      for (const e of o2) await L[e].run(s);
      row.final = lab(facts(await s.getProcess({ configurable: { thread_id: L.at(0).configurable.thread_id, checkpoint_ns: '' } })));
      row.pendingChannelsC1 = (await s.getTuple(L.at(1)))?.pendingWrites.map((w) => w[1]).sort() ?? null;
    } catch (e) {
      row.error = String(e?.message ?? e);
    }
    const e1 = { ...EXPECT1(L), head: 'C1' };
    const e2 = { ...EXPECT2(L), head: 'C2' };
    row.ok = {
      afterInvocation1: JSON.stringify(row.afterInvocation1) === JSON.stringify(e1),
      final: JSON.stringify(row.final) === JSON.stringify(e2),
      writes: JSON.stringify(row.pendingChannelsC1) === JSON.stringify([INTERRUPT, RESUME, 'out'].sort()),
    };
    row.pass = !row.error && row.ok.afterInvocation1 && row.ok.final && row.ok.writes;
    row.failedBy = row.pass ? null : row.error ? 'exception' : 'property';
    rows.push(row);
  }
  const file = path.join(ROWS_OUT, `lg-orders-${label}-${process.pid}.jsonl`);
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const failed = rows.filter((r) => !r.pass);
  console.log(`# orders[${label}]: ${rows.length} orders, ${rows.length - failed.length} pass, ${failed.filter((r) => r.failedBy === 'property').length} fail by property, ${failed.filter((r) => r.failedBy === 'exception').length} fail by exception; distinct finals ${new Set(rows.map((r) => JSON.stringify(r.final))).size} — ${file}`);
  return { rows, file };
}

test('#1562 v0.2 #3: all 12 hand-derived async orders end in the SAME status, head/asOf and waitingOn (OxigraphSaver)', { skip: SKIP }, async () => {
  const { rows } = await runOrderPermutations('oxigraph', () => freshSaver());
  assert.equal(rows.length, 12);
  for (const r of rows) assert.ok(r.pass, `order ${r.order.join(',')}: ${JSON.stringify(r)}`);
  assert.equal(new Set(rows.map((r) => JSON.stringify(r.final))).size, 1, 'one final state across all orders');
});

test('#1562 v0.2 #3 control: the SAME loop FAILS by property against a saver that drops writes arriving before their checkpoint', { skip: SKIP }, async () => {
  const { rows } = await runOrderPermutations('control-drops-early-writes', () => { const s = freshSaver(); return new DropsEarlyWritesSaver({ client, scope: s.scope }); });
  assert.ok(rows.every((r) => !r.error), 'the control never throws; only the property check may catch it');
  assert.ok(rows.some((r) => r.failedBy === 'property'), 'the control passed every order: the loop did not exercise putWrites-before-put');
});

test('#1562 v0.2 #3 control: the SAME loop FAILS by property against a last-write-wins saver', { skip: SKIP }, async () => {
  const { rows } = await runOrderPermutations('control-last-write-wins', () => { const s = freshSaver(); return new LastWriteWinsSaver({ client, scope: s.scope }); });
  assert.ok(rows.every((r) => !r.error), 'the control never throws; only the property check may catch it');
  assert.ok(rows.some((r) => r.failedBy === 'property'), 'the control passed every order: the loop did not exercise the race');
});

test('#1562 a stale thread generation is never trusted: a put after ANOTHER saver deleted the thread is stored, not answered from the old receipt', { skip: SKIP }, async () => {
  const A = freshSaver();
  const B = new OxigraphSaver({ client, scope: A.scope });
  const L = lineage('stale-gen');
  await L.P0.run(A); // A has now written generation 0 of the thread
  await B.deleteThread('stale-gen'); // B bumps the generation to 1
  assert.equal(await A.getTuple(L.at(0)), undefined);
  await L.P0.run(A); // the SAME put (identical intention) from A again
  const t = await A.getTuple(L.at(0));
  assert.ok(t, 'the re-put checkpoint must be stored (a stale generation would replay g0\'s old APPLIED receipt and store nothing)');
  assert.equal(t.checkpoint.id, L.ids[0]);
});

// ---------- 4: interrupt writes first, then an equal-step put: WAITING stays (v0.2 #1) ----------

test('#1562 v0.2 #1: interrupt writes first, then the equal-step put — status STAYS WAITING', { skip: SKIP }, async () => {
  const s = freshSaver();
  const L = lineage('eq');
  await L.P0.run(s);
  await L.I1.run(s); // the interrupt write for C1 lands BEFORE put(C1)
  await L.P1.run(s); // the equal-step put of the same checkpoint
  let p = await s.getProcess(L.at(1));
  assert.equal(p.status, 'waiting');
  assert.equal(p.waitingOn, 'approver');
  assert.equal(p.waitingAt, L.ids[1]);
  // a replayed put (same intention) changes nothing
  await L.P1.run(s);
  assert.equal((await s.getProcess(L.at(1))).status, 'waiting');
  // another put at the SAME step extending the waiting head (e.g. a state update) does not clear it
  const cEq = uuid6(0);
  await s.put(L.at(1), cp(cEq), { source: 'update', step: 0, parents: {} }, {});
  p = await s.getProcess({ configurable: { thread_id: 'eq', checkpoint_ns: '', checkpoint_id: cEq } });
  assert.equal(p.status, 'waiting', 'a put never clears WAITING');
  assert.equal(p.head, cEq);
  assert.equal(p.waitingAt, L.ids[1]);
  // an UNAUTHORIZED resume (not the declared assignee) records the write but does not clear WAITING
  await s.putWrites({ configurable: { ...L.at(1).configurable, resumer: 'mallory' } }, [[RESUME, { approved: true }]], NULL_TASK_ID);
  assert.equal((await s.getProcess(L.at(1))).status, 'waiting');
  // a resume with no resumer at all does not clear it either
  await s.putWrites(L.at(1), [[RESUME, { approved: true, n: 2 }]], NULL_TASK_ID);
  assert.equal((await s.getProcess(L.at(1))).status, 'waiting');
  // the declared assignee's resume clears it
  await L.R1.run(s);
  p = await s.getProcess(L.at(1));
  assert.equal(p.status, 'running', 'resumed at C1 while the head is the later checkpoint → running');
  assert.equal(p.resumedBy, 'approver');
  assert.equal(p.waitingOn, null);
});

// ---------- 5: fork from an earlier checkpoint ----------

test('#1562 v0.2 #2: fork from an earlier checkpoint — head selection and process status are right per branch', { skip: SKIP }, async () => {
  const s = freshSaver();
  const L = lineage('fork');
  for (const e of ['P0', 'P1', 'P2']) await L[e].run(s);
  // the main branch waits at C2
  await s.putWrites(L.at(2), [[INTERRUPT, { value: { assignee: 'approver' }, id: 'int-2' }]], 'taskA');
  assert.equal((await s.getProcess(L.at(2))).status, 'waiting');
  // fork: a new checkpoint whose parent is C1, which is not its branch's head
  const cF = uuid6(1);
  await s.put(L.at(1), cp(cF), { source: 'fork', step: 1, parents: {} }, {});
  const at = (id) => ({ configurable: { thread_id: 'fork', checkpoint_ns: '', checkpoint_id: id } });
  const main = await s.getProcess(at(L.ids[2]));
  const fork = await s.getProcess(at(cF));
  assert.notEqual(main.branch, fork.branch, 'the fork is its own branch');
  assert.deepEqual([main.status, main.head, main.waitingOn], ['waiting', L.ids[2], 'approver']);
  assert.deepEqual([fork.status, fork.head, fork.waitingOn], ['running', cF, null]);
  // the C0/C1 checkpoints stay on the main branch
  assert.equal((await s.getProcess(at(L.ids[1]))).branch, main.branch);
  // retrieval convention: the latest checkpoint (max id) is the fork, explicitly addressable checkpoints stay
  assert.equal((await s.getTuple({ configurable: { thread_id: 'fork', checkpoint_ns: '' } })).checkpoint.id, cF);
  assert.equal((await s.getTuple(at(L.ids[2]))).pendingWrites[0][1], INTERRUPT);
  assert.equal((await s.getTuple(at(cF))).parentConfig.configurable.checkpoint_id, L.ids[1]);
  assert.equal((await s.getProcess({ configurable: { thread_id: 'fork', checkpoint_ns: '' } })).branch, fork.branch);
  // the fork finishes; done is terminal for its incarnation and does not touch the waiting branch
  assert.equal(await s.markRun(at(cF), 'done'), 'APPLIED');
  assert.equal((await s.getProcess(at(cF))).status, 'done');
  assert.equal((await s.getProcess(at(L.ids[2]))).status, 'waiting');
  // done cannot be set on a branch that is waiting, nor on a checkpoint that is not its branch's head
  assert.equal(await s.markRun(at(L.ids[2]), 'done'), 'PRECONDITION_FAILED');
  assert.equal(await s.markRun(at(L.ids[1]), 'failed'), 'PRECONDITION_FAILED');
  // a later put extending the finished fork opens the next incarnation
  const cF2 = uuid6(2);
  await s.put(at(cF), cp(cF2), { source: 'input', step: 2, parents: {} }, {});
  const f2 = await s.getProcess(at(cF2));
  assert.deepEqual([f2.branch, f2.status, f2.incarnation], [fork.branch, 'running', 2]);
});

// ---------- reads: one snapshot; LIMIT never truncates writes ----------

test('#1562 v0.2 #4: list with a LIMIT returns every pending write of the selected checkpoints', { skip: SKIP }, async () => {
  const s = freshSaver();
  const L = lineage('lim');
  for (const e of ['P0', 'P1', 'P2']) await L[e].run(s);
  const writes = Array.from({ length: 25 }, (_, i) => [`ch${i}`, i]);
  await s.putWrites(L.at(2), writes, 'big');
  await s.putWrites(L.at(1), [['x', 1]], 't');
  const got = [];
  for await (const t of s.list({ configurable: { thread_id: 'lim' } }, { limit: 1 })) got.push(t);
  assert.equal(got.length, 1);
  assert.equal(got[0].checkpoint.id, L.ids[2]);
  assert.equal(got[0].pendingWrites.length, 25);
  assert.deepEqual(got[0].pendingWrites.map((w) => w[2]), writes.map((w) => w[1]));
});

test('#1562 every lg.* intention compiles to ONE update that passes the unchanged staticCheck', () => {
  const base = { opId: 'urn:ex:op/lg/x/1', actor: 'urn:ex:a' };
  const lg = { scope: 's', thread: 'th; DELETE WHERE { ?s ?p ?o }', ns: 'n|x', gen: 0, cid: 'c"1' };
  const intents = [
    { ...base, kind: 'lg.put', lg: { ...lg, parentCid: 'p', step: -1, payloadType: 'json', payload: 'e30=', metaType: 'json', metadata: 'e30=', meta: [{ key: 'source} ; INSERT', value: 'ImlucHV0Ig==' }], channelVersions: [{ channel: 'a', version: '1' }], blobs: [{ channel: 'a', version: '1', type: 'json', value: 'MQ==' }] } },
    { ...base, kind: 'lg.putWrites', lg: { ...lg, taskId: 't', resumer: 'm', writes: [{ idx: -3, channel: '__interrupt__', type: 'json', value: 'e30=', assignee: 'approver' }, { idx: -4, channel: '__resume__', type: 'json', value: 'e30=' }] } },
    { ...base, kind: 'lg.putWrites', lg: { ...lg, taskId: 't', resumer: null, writes: [{ idx: 0, channel: 'a', type: 'json', value: 'e30=' }, { idx: -1, channel: '__error__', type: 'json', value: 'e30=' }] } },
    { ...base, kind: 'lg.deleteThread', lg: { scope: 's', thread: 'th', gen: 3 } },
    { ...base, kind: 'lg.runTransition', lg: { ...lg, gen: 1, to: 'done' } },
    { ...base, kind: 'lg.reap', lg: { ...lg, gen: 2, parentCid: 'p"0' } },
  ];
  for (const it of intents) {
    const { sparql } = compile(it);
    const chk = staticCheck(sparql, it.opId);
    assert.ok(chk.ok, `${it.kind}: ${chk.errors.join('; ')}`);
    assert.ok(chk.triples.some((t) => t.cat === 'DOMAIN') && chk.triples.some((t) => t.cat === 'RECEIPT') && chk.triples.some((t) => t.cat === 'MARKER'));
    assert.ok(!/;\s*(INSERT|DELETE)/i.test(sparql), 'caller text never reaches the update unencoded');
  }
  // validation: a payload that is not base64, a special write with the wrong idx, an unknown field
  assert.throws(() => compile({ ...intents[0], lg: { ...intents[0].lg, payload: 'not base64!' } }), /base64/);
  assert.throws(() => compile({ ...intents[1], lg: { ...intents[1].lg, writes: [{ idx: 0, channel: '__interrupt__', type: 'json', value: '' }] } }), /does not match channel/);
  assert.throws(() => compile({ ...intents[3], lg: { ...intents[3].lg, extra: 1 } }), /unknown field/);
});

test('#1562 a lost acknowledgement converges by replaying the SAME intention (one write, one marker step)', { skip: SKIP }, async () => {
  let drop = 1;
  const lossy = createGraphClient({
    baseUrl: exec.baseUrl,
    fetchImpl: async (url, init) => {
      const r = await fetch(url, init);
      if (String(url).endsWith('/update') && drop > 0) { drop--; await r.text(); throw new Error('ack lost'); }
      return r;
    },
  });
  // #1656 — since #1638 the dataset marker and every receipt live in the bookkeeping graph, not the default graph
  const seq = async () => Number((await client.query('SELECT ?s WHERE { GRAPH <urn:scrum:bookkeeping:executor> { <urn:ex:dataset> <urn:ex:commitSeq> ?s } }')).rows[0].s.value);
  const s = new OxigraphSaver({ client: lossy, scope: `lossy${process.pid}` });
  await s._readGen('la'); // so the first update is the put itself
  const s0 = await seq();
  const id = uuid6(-1);
  await s.put({ configurable: { thread_id: 'la', checkpoint_ns: '' } }, cp(id, { a: 1 }), { source: 'input', step: -1, parents: {} }, { a: 1 });
  assert.equal(drop, 0, 'the first acknowledgement was dropped');
  assert.equal(await seq(), s0 + 1, 'applied once: the replay hit the duplicate guard');
  assert.deepEqual((await s.getTuple({ configurable: { thread_id: 'la' } })).checkpoint.channel_values, { a: 1 });
});

test('#1562 deleteThread is a receipted mutation; the same ids can be written again afterwards', { skip: SKIP }, async () => {
  const s = freshSaver();
  const L = lineage('del');
  await L.P0.run(s); await L.P1.run(s); await L.I1.run(s);
  await s.deleteThread('del');
  assert.equal(await s.getTuple(L.at(1)), undefined);
  assert.equal(await s.getProcess(L.at(1)), undefined);
  const rec = await client.query(`SELECT ?o WHERE { GRAPH <urn:scrum:bookkeeping:executor> { <urn:ex:op/lg/${s.scope}/delete/del/g0> <urn:ex:outcome> ?o } }`);
  assert.equal(rec.rows[0].o.value, 'urn:ex:APPLIED');
  // the SAME put replayed after the delete is written again (generation 1 → a fresh opId), even
  // by another saver instance — never answered from generation 0's old APPLIED receipt
  const s2 = new OxigraphSaver({ client, scope: s.scope });
  await L.P0.run(s2);
  assert.equal((await s2.getTuple(L.at(0))).checkpoint.id, L.ids[0]);
  const again = await client.query(`ASK { GRAPH <urn:scrum:bookkeeping:executor> { <urn:ex:op/lg/${s.scope}/put/del/g1/ns%3A/${L.ids[0]}> <urn:ex:outcome> <urn:ex:APPLIED> } }`);
  assert.equal(again.ok, false); // ask() is the ASK door; query() refuses a non-SELECT result
  const g1 = await client.ask(`ASK { GRAPH <urn:scrum:bookkeeping:executor> { <urn:ex:op/lg/${s.scope}/put/del/g1/ns%3A/${L.ids[0]}> <urn:ex:outcome> <urn:ex:APPLIED> } }`);
  assert.equal(g1.boolean, true);
});

// ---------- 6: a real StateGraph with interrupt(), killed and restarted ----------

test('#1562 real StateGraph: interrupt() under durability "sync", executor SIGKILLed and restarted, a NEW saver resumes and completes', { skip: SKIP, timeout: 120000 }, async () => {
  const store = tmpStore('lg-restart-');
  const ds = 'lg-restart';
  let x = await startExecutor({ store, datasetId: ds, create: true });
  const sink = []; // the fabricated external effect: never a real message
  const State = Annotation.Root({
    topic: Annotation(),
    draft: Annotation(),
    approved: Annotation(),
    drafts: Annotation({ reducer: (a, b) => a + b, default: () => 0 }),
  });
  const build = (saver) => new StateGraph(State)
    .addNode('write_draft', (st) => ({ draft: `digest for ${st.topic}`, drafts: 1 }))
    .addNode('ask_approval', () => {
      const answer = interrupt({ assignee: 'approver', ask: 'send this digest?' });
      return { approved: answer?.approved === true };
    })
    .addNode('send', (st) => { if (st.approved) sink.push({ effect: 'post', body: st.draft }); return {}; })
    .addEdge(START, 'write_draft').addEdge('write_draft', 'ask_approval').addEdge('ask_approval', 'send').addEdge('send', END)
    .compile({ checkpointer: saver });
  const thread = { configurable: { thread_id: 'digest-2026-W41', checkpoint_ns: '' } };
  try {
    const c1 = createGraphClient({ baseUrl: x.baseUrl, expectedDatasetId: ds });
    const saver1 = new OxigraphSaver({ client: c1, scope: 'proof' });
    const g1 = build(saver1);
    const out1 = await g1.invoke({ topic: '2026-W41' }, { ...thread, durability: 'sync' });
    assert.ok(out1.__interrupt__?.length, 'the run stopped at the interrupt');
    assert.equal(sink.length, 0, 'no effect before approval');
    const p1 = await saver1.getProcess(thread);
    assert.equal(p1.status, 'waiting');
    assert.equal(p1.waitingOn, 'approver');

    // SIGKILL the executor while the workflow waits; restart it on the SAME store
    await killExecutor(x);
    await assert.rejects(saver1.getTuple(thread), /unavailable/i, 'the dead executor is UNAVAILABLE, never an empty read');
    x = await startExecutor({ store, datasetId: ds });
    const c2 = createGraphClient({ baseUrl: x.baseUrl, expectedDatasetId: ds });
    assert.equal((await c2.datasetIdentity()).ok, true);

    // a NEW saver instance and a newly compiled graph: nothing carried in memory
    const saver2 = new OxigraphSaver({ client: c2, scope: 'proof' });
    const g2 = build(saver2);
    const p2 = await saver2.getProcess(thread);
    assert.deepEqual([p2.status, p2.waitingOn], ['waiting', 'approver'], 'still waiting after the restart, waitingOn queryable');
    const snap = await g2.getState(thread);
    assert.equal(snap.values.draft, 'digest for 2026-W41', 'the workflow state survived the restart');
    assert.deepEqual(snap.next, ['ask_approval']);

    const out2 = await g2.invoke(new Command({ resume: { approved: true } }), { configurable: { ...thread.configurable, resumer: 'approver' }, durability: 'sync' });
    assert.equal(out2.approved, true);
    assert.equal(out2.draft, 'digest for 2026-W41');
    assert.equal(out2.drafts, 1, 'the draft node did not re-run after the restart');
    assert.deepEqual(sink, [{ effect: 'post', body: 'digest for 2026-W41' }], 'exactly one effect, after approval');
    const p3 = await saver2.getProcess(thread);
    assert.equal(p3.status, 'running');
    assert.equal(p3.resumedBy, 'approver', 'the resumer came through the invoke config');
    const head = (await saver2.getTuple(thread)).config;
    assert.equal(await saver2.markRun(head, 'done'), 'APPLIED');
    assert.equal((await saver2.getProcess(thread)).status, 'done');
    assert.equal((await g2.getState(thread)).next.length, 0);
  } finally {
    await killExecutor(x);
  }
});
