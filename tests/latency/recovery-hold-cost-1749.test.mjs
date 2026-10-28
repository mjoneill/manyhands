/**
 * #1749 P4 v2, the COST rows (ruling 46591; the projector premise corrected in 46590), MOVED UNCHANGED out of
 * tests/recovery-hold-1749.test.mjs (ruling 46809), into tests/latency/: OUTSIDE the suite glob (scripts/run-tests.sh runs
 * tests/*.test.mjs) and outside T14's discovery (it lists tests/ itself), like the L1 latency file beside it. They are an ACCEPTANCE-ONLY measurement, NOT in the CI-required manifest:
 * a shared runner gives neither a stable load nor a known neighbour, so a red there cannot tell a regression from noise.
 * Required on the board machine, on the exact candidate head, at a 1-minute load < 4, median of five per side, with the load
 * at start and end recorded with the landing evidence. Bounds and stop-on-failure are unchanged (46591). The shared header
 * below is copied from the hold rows' file so these rows run alone; the P4 section is byte-identical to its source.
 */
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
import { HAVE_PY, PY, tmpStore, spawnExecutor, killExecutor } from '../helpers/graph-executor-proc.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { createGraphClient } from '../../core/graph-client.mjs';
import { postWriteId } from '../../core/post-write.mjs';
import { cardQuads, cardIriOf } from '../../core/cards-graph.mjs';
import { projectBatch } from '../../core/activity-projector.mjs';

const MOD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'core', 'postseq-reserve.mjs');
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

// P4 v2 (ruling 46591; the contract author's 46592; the projector premise corrected in 46590). Every case: this build vs the base
// 8edd075 (its executor.py run from `git show`), BOTH executors up at once and their samples INTERLEAVED (base, build, base, …) so
// machine drift lands on both; the SAME client code drives both, so only the executor differs. Median of 5 samples per side.
// BOUNDED (a, b1, b2, b3): the build's median is within 10% or 50 ms of the base's, whichever is larger. A bounded failure is a
// STOP-AND-REPORT, never a wider window. MEASURED (c): printed with its ratio, not bounded.
//   a   FLOORED 50k-triple INSERT DATA (both stores --install-write-floor postseq-v1, the header declared)
//   b1  UNFLOORED compiled card.write through graph-client: one sample = 20 single-card creates
//   b2  UNFLOORED compiled postseq.reserve through graph-client: one sample = 20 ordinary reservations
//   b3  UNFLOORED REAL projectBatch: one sample = ONE batch of 500 events plus a 50-row work-ledger slice (the live writer, #1641)
//   c   UNFLOORED 50k-triple INSERT DATA, measured and printed
const BASE_REF = '8edd075';
const P4_FLOOR = 'postseq-v1';
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
const within = (n, b) => n <= Math.max(b * 1.10, b + 50);
/** both executors up, `prep` once on each, then 5 interleaved samples; returns both medians and every sample */
async function paired(tag, extra, prep, sample) {
  const base = await startBase(store(`hold-p4${tag}-base-`), ['--create', ...extra]);
  const x = await start(store(`hold-p4${tag}-build-`), ['--create', ...extra]);
  try {
    for (const e of [base, x]) assert.equal((await health(e)).writeFloor ?? null, extra.length ? P4_FLOOR : null, `PRECONDITION (${tag}): the floor is as named`);
    await prep(base); await prep(x);
    const ms = { base: [], build: [] };
    for (let k = 0; k < 5; k++) {
      for (const [side, e] of [['base', base], ['build', x]]) {
        const t0 = performance.now();
        await sample(e, k, side);
        ms[side].push(performance.now() - t0);
      }
    }
    const b = median(ms.base), n = median(ms.build);
    console.log(`# P4 ${tag} median ms: base ${b.toFixed(1)}, build ${n.toFixed(1)} (x${(n / b).toFixed(2)}); samples base [${ms.base.map((v) => v.toFixed(0))}] build [${ms.build.map((v) => v.toFixed(0))}]`);
    return { b, n };
  } finally { await stopX(base); await stopX(x); }
}
const insert50k = (header) => async (e, k) => {
  const body = `INSERT DATA { ${Array.from({ length: 50000 }, (_, i) => `<urn:ex:p4/${k}/${i}> <urn:ex:p> "${i}" .`).join(' ')} }`;
  const epoch = String((await health(e)).epoch);
  const r = await fetch(`${e.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/hold-p4-${opN++}`, 'x-epoch': epoch, ...header }, body });
  assert.equal(r.status, 200, `PRECONDITION: the 50k insert applied (${r.status} ${(await r.text()).slice(0, 120)})`);
};
const P4T = { ...T, timeout: 900000 };
const bounded = (tag, { b, n }) => assert.ok(within(n, b), `P4 ${tag}: the build's median ${n.toFixed(1)} ms is within 10% or 50 ms of the base's ${b.toFixed(1)} ms — a failure here is STOP AND REPORT (ruling 46591)`);

test('#1749 (P4a, v2) FLOORED: a 50,000-triple INSERT DATA, build within 10% (or 50 ms) of the floored base 8edd075, median of 5', P4T, async () => {
  bounded('a', await paired('a', ['--install-write-floor', P4_FLOOR], async () => {}, insert50k({ 'x-manyhands-write-protocol': P4_FLOOR })));
});
test('#1749 (P4b1, v2) UNFLOORED: 20 compiled card.write creates through graph-client, build within 10% (or 50 ms) of the base 8edd075, median of 5', P4T, async () => {
  const card = (id, shortId) => ({ id, shortId, title: `card ${shortId}`, description: 'a body of ordinary length for a card on the board', column: 'backlog', createdAt: '2026-10-25T06:00:00.000Z', createdBy: 'ada', version: 1, labels: ['p4'] });
  bounded('b1', await paired('b1', [], async () => {}, async (e, k) => {
    const g = client(e);
    for (let i = 0; i < 20; i++) {
      const c = card(`p4-${k}-${i}`, 1 + k * 20 + i);
      const r = await g.update({ kind: 'card.write', opId: `urn:ex:op/card/p4-${process.pid}-${opN++}`, actor: 'https://scrumboard.local/person/ada', parts: [{ iri: cardIriOf(c.id), expectedVersion: null, version: c.version, quads: cardQuads(c, new Map()), json: JSON.stringify(c) }] });
      assert.equal(r.outcome, 'APPLIED', `PRECONDITION: the card.write applied (${JSON.stringify(r).slice(0, 200)})`);
    }
  }));
});
test('#1749 (P4b2, v2) UNFLOORED: 20 compiled postseq.reserve intentions through graph-client, build within 10% (or 50 ms) of the base 8edd075, median of 5', P4T, async () => {
  bounded('b2', await paired('b2', [], async (e) => { await raw(e, `INSERT DATA { GRAPH <${BK}> { ${allocatorTriples(100)} } }`); }, async (e, k) => {
    const g = client(e);
    for (let i = 0; i < 20; i++) {
      const r = await g.update(intention([ordinary(`p4-${k}-${i}`)]));
      assert.equal(r.outcome, 'APPLIED', `PRECONDITION: the reservation applied (${JSON.stringify(r).slice(0, 200)})`);
    }
  }));
});
test('#1749 (P4b3, v2) UNFLOORED: a REAL projectBatch of 500 events plus a 50-row ledger slice, build within 10% (or 50 ms) of the base 8edd075, median of 5', P4T, async () => {
  const logDir = fs.mkdtempSync(path.join(path.dirname(store('hold-p4b3-anchor-')), 'p4-log-')); owned.stores.add(logDir);
  const workDir = fs.mkdtempSync(path.join(path.dirname(logDir), 'p4-work-')); owned.stores.add(workDir);
  const LOG = path.join(logDir, 'events-2026-10-25.jsonl'), WORK = path.join(workDir, 'work-objects.jsonl');
  fs.writeFileSync(LOG, ''); fs.writeFileSync(WORK, '');
  const OPS = ['card.update', 'card.create', 'card.move', 'conversation.post'];
  let fed = -1;
  bounded('b3', await paired('b3', [], async () => {}, async (e, k) => {
    if (fed < k) {   // the base runs first in each round: append this round's input once, both executors then project the same slice
      const ev = Array.from({ length: 500 }, (_, i) => { const seq = k * 500 + i + 1; return JSON.stringify({ seq, ts: '2026-10-25T09:00:00.000Z', op: OPS[seq % OPS.length], actor: 'ada', entity: { id: `uuid-p4-${seq}`, kind: 'card', shortId: seq } }); });
      const wk = Array.from({ length: 50 }, (_, i) => JSON.stringify({ id: `w-p4-${k}-${i}`, seq: 1, declaredBy: 'ada', card: 9, required: ['bea'], transition: { type: 'declared', at: '2026-10-25T09:00:00.000Z', by: 'ada' } }));
      fs.appendFileSync(LOG, `${ev.join('\n')}\n`); fs.appendFileSync(WORK, `${wk.join('\n')}\n`); fed = k;
    }
    const r = await projectBatch({ logDir, workDir, executorUrl: e.baseUrl });
    assert.deepEqual([r.cursor.seq, r.cursor.workRows], [(k + 1) * 500, (k + 1) * 50], `PRECONDITION: the batch projected 500 events and 50 ledger rows (${JSON.stringify(r).slice(0, 200)})`);
  }));
});
test('#1749 (P4c, v2) UNFLOORED: a 50,000-triple INSERT DATA, build vs the base 8edd075, MEASURED AND PRINTED (not bounded; the slowdown is the record)', P4T, async () => {
  const { b, n } = await paired('c', [], async () => {}, insert50k({}));
  console.log(`# P4c RECORD: unfloored 50k INSERT DATA costs x${(n / b).toFixed(2)} the base (${b.toFixed(1)} -> ${n.toFixed(1)} ms)`);
});

