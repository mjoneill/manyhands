/**
 * #1644, THE TWO HEAVY ROWS: the mid-read SNAPSHOT row and the LATENCY row (test author, written BEFORE the build, 2026-10-09). The functional family is ready-executor-1644.test.mjs.
 *
 * S1  THE SNAPSHOT RULE (card text: "the answer must equal ONE complete before-or-after snapshot, never a mixture that never existed"). A real executor holds a 1,200-card board (past the 1,000-row
 *     page the current sub-queries read in). A counting proxy sits in front of it. For each injection point k the proxy lets the reader's first k-1 /query requests through, then, BEFORE forwarding
 *     the k-th, deletes one card THROUGH REST (a real card write, committed to the executor), and the read carries on. Valid answers: the full BEFORE (the write after the read: no injection) or
 *     the full AFTER (the write before the first query: k=1). A fresh executor (a copy of one seeded store) and a fresh REST per run. The reader under test is `GET /api/ready` with
 *     `SCRUM_GRAPH_READY_SOURCE=executor`; its number of queries is whatever the build uses (one query, or position bracketing with retries): the sweep covers every point.
 *     PRECONDITIONS (a row that cannot fail is not a row): the reader touched the executor; BEFORE != AFTER (the deleted card is visible in the answer).
 *   S1-CONTROL  the same sweep with a deliberately NAIVE reader written in this file (the 6 ready sub-queries, paged LIMIT/OFFSET with no ORDER BY, one request at a time over HTTP): it MUST produce at
 *     least one answer that is neither BEFORE nor AFTER, a card skipped or duplicated when a row is deleted between pages. If it cannot, the injection is not able to produce a mixture and S1 proves nothing.
 *
 * L1  LATENCY (the steward's bound, on the card): on a production-sized board (1,500 cards, a relatedTo edge on all but the first, a blockedBy edge on one in ten) the executor path's p95 over >= 20
 *     timed calls, after 3 warm-ups, is <= 1.0 s (hard ceiling) AND <= 2x the in-process path's p95 measured in the same run on the same host, in two phases: idle, and with 6 CPU-burning processes running
 *     (a loaded host; load average is printed). The sample sizes and the p95s are printed in the assertion messages and on stdout. Precondition: the switched run really read the executor.
 *
 * S2  THE CARD'S OWN WORDING ("a card write AND a projector batch are injected mid-read"): the same sweep with BOTH writers: the card delete before query k and a REAL projector batch
 *     (core/activity-projector.mjs projectBatch, production code, one /update that adds prov:Activity triples and moves the cursor) before query m, for every k <= m. Valid answers are still BEFORE or AFTER
 *     (the batch changes no card fact); a run in which the batch wrote nothing is a precondition failure. S2-CONTROL: the naive reader is still caught with both writers active.
 *
 * SCOPE OF THE SWEEP (changed 15:50Z after the builder's first run): the injection points are the READER's own queries. REST's own cards-currency ping, which opens every /api/ready call with the cards unit on,
 * is passed through untouched and is not an injection point. FAILURE-PATH OBSERVATION, recorded here and not asserted: injecting a card write while that ping was HELD made the GET answer a correct 503
 * (never a partial queue) and killed the injected DELETE's socket, because both wait on one single-flight currency check. A bounded 503 can be correct failure behaviour; it does not prove the snapshot property.
 * LIMIT OF A ONE-QUERY BUILD: if the reader issues ONE readiness query the sweep has only its two ends (the write before it, the write after it); atomicity DURING that one query is the executor's snapshot
 * property, which these rows do not exercise (the naive control shows the multi-request hazard is real; nothing here makes a write land inside a single running query).
 *
 * S3  THE SINGLE QUERY'S OWN SNAPSHOT (the review's first point: atomicity DURING one query is the core promise, so it is shown, not assumed). At the EXECUTOR, no REST, no builder code: a deliberately slow
 *     read (a 1,200 x 1,200 cross count with a string filter, about 2 s) is running; while it runs, ONE update that removes the type triple of 100 cards commits. The count must be the full BEFORE
 *     (1,200^2) or the full AFTER (1,100^2), never a torn number in between, in three rounds. Preconditions: the read is long enough (>= 800 ms alone); the update STARTED while the read was in flight.
 *     The row records which of the two mechanisms the engine used (the write COMMITTED while the read ran = snapshot isolation; the write WAITED until the read finished = serialization) and the
 *     pyoxigraph version, because the answer belongs to that version.
 *
 * NOT covered, by name: writes of other kinds mid-read (a conversation post); a batch BEFORE the card write (it would have no event to project); two card writers; the
 * shipped-commits argument; MCP-level latency (transport adds its own); a board larger than 1,500 cards; production's real data shape (the fixture is synthetic).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { SKIP, READY_ENV, DSID, ROSTER_FILE, card, makeBoardFixture, startRestServer, startProxy, migrate, tmpStore, startExecutor, startExecutorOnCopy, killExecutor } from './helpers/ready-world-1644.mjs';
import { queryGraphExecutor } from '../core/graph-replica.mjs';
import { projectBatch } from '../core/activity-projector.mjs';
import * as rq from '../core/ready-query.mjs';
import { PY as PY_FOR_S3 } from './helpers/graph-executor-proc.mjs';

const relCard = (i, N) => card(i, `card-${i}`, {
  priority: 'p2',
  ...(i % 13 === 0 ? { column: 'done' } : {}),
  ...(i % 17 === 0 ? { claimedBy: 'ada', claimedAt: '2026-08-02T00:00:00.000Z' } : {}),
  relationships: { relatedTo: i > 1 ? [i - 1] : [], blockedBy: i % 10 === 0 && i > 1 ? [i - 1] : [], supersedes: [], derivedFrom: [] },
});
const bigBoard = (N) => makeBoardFixture({ cards: Array.from({ length: N }, (_, i) => relCard(i + 1, N)), nextShortId: N + 1, conversations: [] });
const isPlainReady = (i) => i % 13 !== 0 && i % 17 !== 0 && i % 10 !== 0 && (i + 1) % 10 !== 0;   // ready, and nothing blocked on it, so deleting it changes only its own presence

async function seed(N) {
  const store = tmpStore('r44s-seed-'); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r44s-board-')); const boardFile = path.join(dir, 'board.json');
  fs.writeFileSync(boardFile, JSON.stringify(bigBoard(N)));
  const exec = await startExecutor({ store, datasetId: DSID, create: true });
  try {
    const m = await migrate(boardFile, exec.baseUrl); assert.equal(m.code, 0, `precondition: ${N} cards copied into the executor (exit ${m.code}): ${m.out.slice(0, 300)}`);
    // the card to delete: one whose facts row sits in the MIDDLE of the first 1,000 rows the facts query returns (a deletion there shifts every later row by one across the page boundary)
    const page = await queryGraphExecutor(exec.baseUrl, `${rq.readyFactsQuery()} LIMIT 1000 OFFSET 0`, { limit: 1000 });
    assert.ok(page.rows.length >= 1000, `precondition: the facts query returns more than one page (${page.rows.length} rows)`);
    const target = page.rows.slice(200, 800).map((r) => Number(r.shortId ?? r.id ?? r.card)).find((n) => Number.isInteger(n) && isPlainReady(n));
    assert.ok(target, `precondition: a plain ready card inside the first page (row keys: ${Object.keys(page.rows[0]).join(',')})`);
    return { store, boardFile, target, N };
  } finally { await killExecutor(exec); }
}

const PAGE = 1000;
async function pagedExec(url, q) { const rows = []; for (let off = 0; ; off += PAGE) { const r = await queryGraphExecutor(url, `${q} LIMIT ${PAGE} OFFSET ${off}`, { limit: PAGE }); rows.push(...r.rows); if (r.rows.length < PAGE) break; } return rows; }
/** The NAIVE reader: the six sub-queries of readyFromStore, each paged LIMIT/OFFSET with no ORDER BY, over HTTP, one request at a time. */
async function naiveAnswer(url) {
  const facts = await pagedExec(url, rq.readyFactsQuery()); const blockers = await pagedExec(url, rq.readyBlockersQuery()); const superseded = await pagedExec(url, rq.readySupersededQuery());
  const human = await pagedExec(url, rq.readyHumanBlockersQuery()); const context = await pagedExec(url, rq.readyContextQuery()); const cond = await pagedExec(url, rq.readyConditionBlockersQuery());
  const v = rq.computeReady(facts, blockers, superseded, context, human, cond, {});
  const ids = v.included.map((c) => c.shortId).sort((a, b) => a - b);
  return { ready: ids, total: ids.length, excludedTotal: v.excluded.length };
}
async function restAnswer(base) {
  const r = await fetch(`${base}/api/ready?limit=5000`, { signal: AbortSignal.timeout(60000) }); const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
  if (r.status !== 200 || !Array.isArray(j?.ready)) return { failed: `${r.status} ${text.slice(0, 200)}` };
  const ids = j.ready.map((c) => c.shortId).sort((a, b) => a - b); return { ready: ids, total: j.readyTotal, excludedTotal: j.excludedTotal };
}
const sig = (a) => (a.failed ? `FAILED ${a.failed}` : `${a.total}/${a.excludedTotal}:${a.ready.length}:${a.ready.slice(0, 2)}..${a.ready.slice(-2)}:${a.ready.reduce((h, x) => (h * 31 + x) % 1000003, 7)}`);

/** One run on a fresh executor (a copy of the seeded store) and a fresh REST. k = 0: no injection. k >= 1: delete the target card through REST just before the k-th /query request of the read. */
async function run(sd, { k, reader, m = 0 }) {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'r44s-run-')); fs.cpSync(sd.store, store, { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r44s-rboard-')); const boardFile = path.join(dir, 'board.json'); fs.copyFileSync(sd.boardFile, boardFile);
  const exec = await startExecutorOnCopy({ store, datasetId: DSID }); const proxy = await startProxy(exec.baseUrl);
  const rest = await startRestServer({ boardFile, env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_CARDS: '1', ...(reader === 'rest' ? { [READY_ENV]: 'executor' } : {}) } });
  try {
    proxy.queries = 0;
    let projected = null;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r44s-work-')); fs.writeFileSync(path.join(workDir, 'work-objects.jsonl'), '');
    if (k >= 1 || m >= 1) proxy.onQuery = async (n) => {
      if (n === k) { const r = await fetch(`${rest.baseUrl}/api/cards/${sd.target}`, { method: 'DELETE', signal: AbortSignal.timeout(60000) }); assert.ok(r.status === 200 || r.status === 204, `precondition: the injected card write is accepted (${r.status})`); }
      // a REAL projector batch (core/activity-projector.mjs, the production code): the card delete above appended an event to REST's log; this projects it into the executor as prov:Activity triples + a cursor move, in ONE /update
      if (n === m) projected = await projectBatch({ logDir: `${boardFile.replace(/\.json$/, '')}-events`, workDir, executorUrl: exec.baseUrl, batchSize: 500 });
    };
    const answer = reader === 'rest' ? await restAnswer(rest.baseUrl) : await naiveAnswer(proxy.url);
    return { answer, queries: proxy.queries, readyQueries: proxy.readyQueries, projected };
  } finally { await rest.stop(); try { await proxy.down(); } catch { /* down */ } await killExecutor(exec); }
}
async function sweep(sd, reader) {
  const before = await run(sd, { k: 0, reader }); const n = before.queries;
  const after = await run(sd, { k: 1, reader });
  const results = [{ k: 0, ...before }, { k: 1, ...after }];
  for (let k = 2; k <= n; k++) results.push({ k, ...(await run(sd, { k, reader })) });
  return { before, after, n, results };
}

/** The two-writer sweep: the card delete before query k AND a real projector batch before query m >= k (the delete's event must exist for the batch to have anything to write). */
async function sweepPairs(sd, reader, ks) {
  const before = await run(sd, { k: 0, reader }); const n = before.queries; const after = await run(sd, { k: 1, reader }); const results = [];
  for (const k of ks(n)) for (let m = k; m <= n; m++) results.push({ k, m, ...(await run(sd, { k, m, reader })) });
  return { before, after, n, results };
}

let seeded = null;
const seedOnce = async () => (seeded ??= await seed(1200));

test('S1 SNAPSHOT: with a card write injected before every query of the read, `GET /api/ready` (switch on) answers the full before or the full after, never a mixture', { skip: SKIP, timeout: 1200000 }, async () => {
  const sd = await seedOnce(); const s = await sweep(sd, 'rest');
  assert.ok(s.before.readyQueries >= 1, `PRECONDITION: the switched /api/ready read READY FACTS from the executor (the proxy counted ${s.before.readyQueries} such queries, ${s.before.queries} in all); a build that ignores the switch answers from the in-process copy and passes everything below`);
  assert.ok(!s.before.answer.failed && !s.after.answer.failed, `PRECONDITION: the uninjected reads answer (${sig(s.before.answer)} / ${sig(s.after.answer)})`);
  assert.notEqual(sig(s.before.answer), sig(s.after.answer), `PRECONDITION: the injected write is visible, BEFORE != AFTER (card ${sd.target} deleted)`);
  const valid = new Set([sig(s.before.answer), sig(s.after.answer)]);
  const bad = s.results.filter((r) => !valid.has(sig(r.answer)));
  assert.deepEqual(bad.map((r) => ({ k: r.k, answer: sig(r.answer) })), [], `every injection point k=1..${s.n} (${s.n} queries in the read) must give BEFORE (${sig(s.before.answer)}) or AFTER (${sig(s.after.answer)})`);
});

test('S1-CONTROL the NAIVE paged reader, under the same sweep, produces an answer that is neither before nor after (so the sweep CAN fail)', { skip: SKIP, timeout: 1200000 }, async () => {
  const sd = await seedOnce(); const s = await sweep(sd, 'naive');
  assert.ok(s.n >= 7, `precondition: the naive read made its ${s.n} requests (6 sub-queries, the facts one over a page boundary)`);
  assert.notEqual(sig(s.before.answer), sig(s.after.answer), 'precondition: BEFORE != AFTER');
  const valid = new Set([sig(s.before.answer), sig(s.after.answer)]);
  const mixed = s.results.filter((r) => !valid.has(sig(r.answer)));
  console.log(`S1-CONTROL naive reader: ${s.n} requests per read; BEFORE ${sig(s.before.answer)}; AFTER ${sig(s.after.answer)}; mixtures at k=${mixed.map((r) => `${r.k} (${sig(r.answer)})`).join(', ') || 'none'}`);
  assert.ok(mixed.length >= 1, `the naive reader must be caught by the sweep: it gave only BEFORE/AFTER at every k (${s.results.map((r) => `${r.k}:${sig(r.answer)}`).join(' | ')}); if it cannot produce a mixture, S1 proves nothing and the injection must change`);
});

// ---- L1 latency ----
const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]; };
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
async function timeCalls(base, n = 20, warm = 3) {
  for (let i = 0; i < warm; i++) { const r = await fetch(`${base}/api/ready?limit=20`, { signal: AbortSignal.timeout(60000) }); await r.text(); }
  const ms = []; for (let i = 0; i < n; i++) { const t = performance.now(); const r = await fetch(`${base}/api/ready?limit=20`, { signal: AbortSignal.timeout(60000) }); await r.text(); assert.equal(r.status, 200); ms.push(performance.now() - t); }
  return ms;
}
async function phase(sd, label) {
  const mk = async (ready) => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'r44l-run-')); fs.cpSync(sd.store, store, { recursive: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r44l-board-')); const boardFile = path.join(dir, 'board.json'); fs.copyFileSync(sd.boardFile, boardFile);
    const exec = await startExecutorOnCopy({ store, datasetId: DSID }); const proxy = await startProxy(exec.baseUrl);
    const rest = await startRestServer({ boardFile, env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_CARDS: '1', ...(ready ? { [READY_ENV]: 'executor' } : {}) } });
    try { proxy.readyQueries = 0; const ms = await timeCalls(rest.baseUrl); return { ms, queries: proxy.readyQueries }; } finally { await rest.stop(); try { await proxy.down(); } catch { /* down */ } await killExecutor(exec); }
  };
  const off = await mk(false); const on = await mk(true);
  const line = `L1 ${label}: load1=${os.loadavg()[0].toFixed(2)}  in-process n=${off.ms.length} p50=${Math.round(med(off.ms))} p95=${Math.round(p95(off.ms))} ms | executor n=${on.ms.length} p50=${Math.round(med(on.ms))} p95=${Math.round(p95(on.ms))} ms (${on.queries} executor queries)`;
  console.log(line); return { off, on, line };
}
test('L1 LATENCY on a production-sized board: executor p95 <= 1.0 s AND <= 2x the in-process p95, idle and under CPU load', { skip: SKIP, timeout: 1500000 }, async () => {
  const sd = await seed(1500);
  const check = (ph) => {
    assert.ok(ph.on.queries >= 1, `PRECONDITION: the switched run read the executor (${ph.on.queries} queries)`);
    const a = p95(ph.on.ms); const b = p95(ph.off.ms);
    assert.ok(a <= 1000, `executor p95 ${Math.round(a)} ms must be <= 1000 ms (hard ceiling); ${ph.line}`);
    assert.ok(a <= 2 * b, `executor p95 ${Math.round(a)} ms must be <= 2x the in-process p95 ${Math.round(b)} ms; ${ph.line}`);
  };
  check(await phase(sd, 'idle'));
  const burners = Array.from({ length: 6 }, () => spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }));
  try { await new Promise((r) => setTimeout(r, 3000)); check(await phase(sd, 'loaded (6 CPU burners)')); } finally { for (const b of burners) b.kill('SIGKILL'); }
});

test('S2 TWO WRITERS: a card write AND a real projector batch injected mid-read (every k <= m), `GET /api/ready` (switch on) still answers the full before or the full after', { skip: SKIP, timeout: 1500000 }, async () => {
  const sd = await seedOnce(); const s = await sweepPairs(sd, 'rest', (n) => Array.from({ length: n }, (_, i) => i + 1));
  assert.ok(s.before.readyQueries >= 1, `PRECONDITION: the switched /api/ready read READY FACTS from the executor (${s.before.readyQueries} such queries, ${s.before.queries} in all)`);
  assert.notEqual(sig(s.before.answer), sig(s.after.answer), 'PRECONDITION: BEFORE != AFTER');
  const noBatch = s.results.filter((r) => !r.projected || !(r.projected.projected >= 1));
  assert.deepEqual(noBatch.map((r) => ({ k: r.k, m: r.m })), [], 'PRECONDITION: in every run the projector batch really wrote (projected >= 1): a batch that wrote nothing is not a second writer');
  const valid = new Set([sig(s.before.answer), sig(s.after.answer)]);
  const bad = s.results.filter((r) => !valid.has(sig(r.answer)));
  assert.deepEqual(bad.map((r) => ({ k: r.k, m: r.m, answer: sig(r.answer) })), [], `every (card write before query k, projector batch before query m>=k) over the ${s.n} queries of the read must give BEFORE or AFTER, and must not fail or hang`);
});

test('S2-CONTROL the NAIVE reader under the same two-writer sweep (k = the page boundary) is still caught, and the batch really wrote', { skip: SKIP, timeout: 1500000 }, async () => {
  const sd = await seedOnce(); const s = await sweepPairs(sd, 'naive', () => [2]);
  assert.ok(s.n >= 7, `precondition: the naive read made its ${s.n} requests`);
  assert.ok(s.results.length >= 1 && s.results.every((r) => r.projected && r.projected.projected >= 1), 'precondition: the projector batch wrote in every control run');
  const valid = new Set([sig(s.before.answer), sig(s.after.answer)]); const mixed = s.results.filter((r) => !valid.has(sig(r.answer)));
  console.log(`S2-CONTROL naive reader, card delete before k=2 plus a projector batch before m=2..${s.n}: mixtures at ${mixed.map((r) => `m=${r.m}`).join(', ') || 'none'} of ${s.results.length} runs`);
  assert.ok(mixed.length >= 1, 'the naive reader must still be caught when a second writer is also active');
});

// ---- S3: the single query's own snapshot, at the executor ----
test('S3 SNAPSHOT WITHIN ONE QUERY: a write that commits while a slow read runs never produces a torn count (snapshot isolation or serialization, said which, for this pyoxigraph)', { skip: SKIP, timeout: 600000 }, async () => {
  const ver = spawnSync(PY_FOR_S3, ['-c', 'import pyoxigraph; print(pyoxigraph.__version__)'], { encoding: 'utf8' }).stdout.trim();
  const sd = await seedOnce();
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'r44s3-')); fs.cpSync(sd.store, store, { recursive: true });
  const exec = await startExecutorOnCopy({ store, datasetId: DSID });
  const CW = '<https://schema.org/CreativeWork>';
  const READ = `SELECT (COUNT(*) AS ?n) WHERE { ?a a ${CW} . ?b a ${CW} . FILTER(STRLEN(CONCAT(STR(?a), STR(?b))) > 0) }`;
  const count = async () => { const t = performance.now(); const r = await fetch(`${exec.baseUrl}/query`, { method: 'POST', body: READ, signal: AbortSignal.timeout(120000) }); const j = await r.json(); return { n: Number(j.results.bindings[0].n.value), ms: performance.now() - t }; };
  try {
    const alone = await count();
    assert.ok(alone.ms >= 800, `PRECONDITION: the slow read must be slow enough for a write to land inside it (${Math.round(alone.ms)} ms alone, ${alone.n} rows)`);
    let have = alone.n; const rounds = []; assert.equal(have, sd.N * sd.N, 'PRECONDITION: the read counts the full cross product before any write');
    for (let round = 1; round <= 3; round++) {
      const epoch = (await (await fetch(`${exec.baseUrl}/health`)).json()).epoch;
      const victims = Array.from({ length: 100 }, (_, i) => `"${sd.N - (round - 1) * 100 - i}"`).join(' ');
      const UPDATE = `DELETE { ?c a ${CW} } WHERE { ?c a ${CW} ; <https://schema.org/identifier> ?id . VALUES ?id { ${victims} } }`;
      const before = have; const after = (before === sd.N * sd.N ? (sd.N - 100) * (sd.N - 100) : (Math.sqrt(before) - 100) ** 2);
      const t0 = performance.now(); const reading = count();
      await new Promise((r) => setTimeout(r, 250));
      const w0 = performance.now(); const wr = await fetch(`${exec.baseUrl}/update`, { method: 'POST', body: UPDATE, headers: { 'content-type': 'application/sparql-update', 'x-op-id': `urn:ex:op/r44s3/${round}/${Date.now()}`, ...(epoch != null ? { 'x-epoch': String(epoch) } : {}) }, signal: AbortSignal.timeout(120000) }); const wDone = performance.now(); await wr.text();
      const got = await reading; const readDone = performance.now();
      assert.equal(wr.status, 200, `PRECONDITION: the update is accepted (${wr.status})`);
      assert.ok(w0 - t0 < got.ms, `PRECONDITION: the update STARTED while the read was in flight (started ${Math.round(w0 - t0)} ms in, read took ${Math.round(got.ms)} ms)`);
      const mechanism = wDone < readDone - 5 ? 'snapshot isolation (the write committed while the read was still running)' : 'serialization (the write waited for the read)';
      assert.ok(got.n === before || got.n === after, `round ${round}: a TORN read: ${got.n} is neither BEFORE (${before}) nor AFTER (${after}); ${mechanism}`);
      const settled = await count(); assert.equal(settled.n, after, `round ${round}: after both finished the count is AFTER (the write really landed)`);
      rounds.push(`${round}: read ${got.n === before ? 'BEFORE' : 'AFTER'} (${Math.round(got.ms)} ms), ${mechanism}`); have = after;
    }
    console.log(`S3 pyoxigraph ${ver}; ${rounds.join(' | ')}`);
  } finally { await killExecutor(exec); }
});
