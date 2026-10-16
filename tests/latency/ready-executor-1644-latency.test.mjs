/**
 * #1644, THE LATENCY ROW, in its own file (#1693, the steward rescope of 2026-10-15, option A): it runs alone in its own sequential
 * CI step, outside the suite glob (tests/*.test.mjs), so nothing else is running alongside it. Moved from
 * tests/ready-executor-1644-snapshot.test.mjs byte for byte: the test, `phase`, `timeCalls`, `p95` and `med`. The fixture helpers
 * (`relCard`, `bigBoard`, `isPlainReady`, the temp-dir cleanup and `seed`) are COPIES of that file's, because it still needs its own.
 * #1703 (decision a74dc60a, the owner's yes of 2026-10-16) replaced the bounds: the verdict is tests/helpers/l1-gate-1644.mjs, and its rows are tests/l1-ceilings-1703.test.mjs.
 *
 * L1  LATENCY: on a production-sized board (1,500 cards, a relatedTo edge on all but the first, a blockedBy edge on one in ten) the executor path's p95 over 40
 *     timed calls, after 3 warm-ups, is at most the phase's usability ceiling: 1.5 s idle, 3.0 s with 6 CPU-burning processes running (the two legs run at once and their calls are interleaved
 *     so they see the same load; load average is printed). The in-process path is still measured in the same run on the same host, and the ratio between them is PRINTED, not asserted.
 *     These are chosen ceilings, not a regression gate (that is #1702). Precondition: the switched run really read the executor.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SKIP, READY_ENV, DSID, ROSTER_FILE, card, makeBoardFixture, startRestServer, startProxy, migrate, tmpStore, startExecutor, startExecutorOnCopy, killExecutor, withOwned } from '../helpers/ready-world-1644.mjs';
import { queryGraphExecutor } from '../../core/graph-replica.mjs';
import * as rq from '../../core/ready-query.mjs';
import { p95, l1Verdict } from '../helpers/l1-gate-1644.mjs';

const relCard = (i, N) => card(i, `card-${i}`, {
  priority: 'p2',
  ...(i % 13 === 0 ? { column: 'done' } : {}),
  ...(i % 17 === 0 ? { claimedBy: 'ada', claimedAt: '2026-08-02T00:00:00.000Z' } : {}),
  relationships: { relatedTo: i > 1 ? [i - 1] : [], blockedBy: i % 10 === 0 && i > 1 ? [i - 1] : [], supersedes: [], derivedFrom: [] },
});
const bigBoard = (N) => makeBoardFixture({ cards: Array.from({ length: N }, (_, i) => relCard(i + 1, N)), nextShortId: N + 1, conversations: [] });
const isPlainReady = (i) => i % 13 !== 0 && i % 17 !== 0 && i % 10 !== 0 && (i + 1) % 10 !== 0;   // ready, and nothing blocked on it, so deleting it changes only its own presence

// #1669 — every temp directory this file makes is removed by the code that made it: per-run copies in that run's own `finally`, the shared seeds once the file is done.
const rmTemp = (...dirs) => { for (const d of dirs) { try { if (d) fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort: a leftover temp dir must not fail a test */ } } };
const SEEDED = [];
after(() => rmTemp(...SEEDED));
async function seed(N) {
  const store = tmpStore('r44s-seed-'); SEEDED.push(store);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r44s-board-')); SEEDED.push(dir); const boardFile = path.join(dir, 'board.json');
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

// ---- L1 latency ----
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
async function timeCalls(base, n = 20, warm = 3) {
  for (let i = 0; i < warm; i++) { const r = await fetch(`${base}/api/ready?limit=20`, { signal: AbortSignal.timeout(60000) }); await r.text(); }
  const ms = []; for (let i = 0; i < n; i++) { const t = performance.now(); const r = await fetch(`${base}/api/ready?limit=20`, { signal: AbortSignal.timeout(60000) }); await r.text(); assert.equal(r.status, 200); ms.push(performance.now() - t); }
  return ms;
}
async function phase(sd, label) {
  return withOwned(async (own) => {
  // BOTH instances run at once and their calls are INTERLEAVED (off, on, then on, off, ...): a sequential off-then-on run lets the host's load drift between the two legs, and the 2x ratio is
  // measured at ~100-200 ms where a few ms of drift decides it (the builder's 16:24Z run: executor p95 230 ms against a 236 ms bound). Interleaving gives both legs the same moments.
  const mk = async (ready) => {
    const store = own.dir('r44l-run-'); fs.cpSync(sd.store, store, { recursive: true });
    const dir = own.dir('r44l-board-'); const boardFile = path.join(dir, 'board.json'); fs.copyFileSync(sd.boardFile, boardFile);
    const exec = await startExecutorOnCopy({ store, datasetId: DSID }); own.adopt(() => killExecutor(exec));
    const proxy = await startProxy(exec.baseUrl); own.adopt(async () => { try { await proxy.down(); } catch { /* down */ } });
    const rest = await startRestServer({ boardFile, env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_CARDS: '1', ...(ready ? { [READY_ENV]: 'executor' } : {}) } });
    own.adopt(() => rest.stop());
    return { rest, proxy, exec };
  };
  const off = await mk(false); const on = await mk(true);
  {
    const call = async (x) => { const t = performance.now(); const r = await fetch(`${x.rest.baseUrl}/api/ready?limit=20`, { signal: AbortSignal.timeout(60000) }); const body = await r.text(); const ms = performance.now() - t; assert.equal(r.status, 200); return { ms, source: JSON.parse(body).source }; };
    for (let i = 0; i < 3; i++) { await call(off); await call(on); }
    off.proxy.readyQueries = 0; on.proxy.readyQueries = 0;
    const offMs = []; const onMs = []; let sources = new Set();
    for (let i = 0; i < 40; i++) {
      const order = i % 2 === 0 ? [off, on] : [on, off];
      for (const x of order) { const r = await call(x); (x === off ? offMs : onMs).push(r.ms); sources.add(`${x === off ? 'off' : 'on'}:${r.source}`); }
    }
    const line = `L1 ${label}: load1=${os.loadavg()[0].toFixed(2)}  in-process n=${offMs.length} p50=${Math.round(med(offMs))} p95=${Math.round(p95(offMs))} ms | executor n=${onMs.length} p50=${Math.round(med(onMs))} p95=${Math.round(p95(onMs))} ms (ratio ${(p95(onMs) / p95(offMs)).toFixed(2)}; ${on.proxy.readyQueries} readiness queries on the executor leg, ${off.proxy.readyQueries} on the in-process leg; responses said ${[...sources].sort().join(', ')})`;
    console.log(line); return { off: { ms: offMs, queries: off.proxy.readyQueries }, on: { ms: onMs, queries: on.proxy.readyQueries }, line };
  }
  });
}
test('L1 LATENCY on a production-sized board: executor p95 <= 1.5 s idle and <= 3.0 s under CPU load (the ratio to the in-process p95 is printed, not asserted)', { skip: SKIP, timeout: 1500000 }, async () => {
  const sd = await seed(1500);
  const idle = l1Verdict('idle', await phase(sd, 'idle'));
  assert.ok(idle.ok, idle.failures.join('; '));
  const burners = Array.from({ length: 6 }, () => spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }));
  try {
    await new Promise((r) => setTimeout(r, 3000));
    const loaded = l1Verdict('loaded', await phase(sd, 'loaded (6 CPU burners)'));
    assert.ok(loaded.ok, loaded.failures.join('; '));
  } finally { for (const b of burners) b.kill('SIGKILL'); }
});
