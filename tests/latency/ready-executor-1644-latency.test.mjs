/**
 * #1644, THE LATENCY ROW, in its own file (#1693, the steward rescope of 2026-10-15, option A): it runs alone in its own sequential
 * CI step, outside the suite glob (tests/*.test.mjs), so nothing else is running alongside it. Moved from
 * tests/ready-executor-1644-snapshot.test.mjs byte for byte: the test, `phase`, `timeCalls`, `p95` and `med`. The fixture helpers
 * (`relCard`, `bigBoard`, `isPlainReady`, the temp-dir cleanup and `seed`) are COPIES of that file's, because it still needs its own.
 * Both bounds are unchanged. The original description of the row follows, unchanged.
 *
 * L1  LATENCY (the steward's bound, on the card): on a production-sized board (1,500 cards, a relatedTo edge on all but the first, a blockedBy edge on one in ten) the executor path's p95 over >= 20
 *     timed calls, after 3 warm-ups, is <= 1.0 s (hard ceiling) AND <= 2x the in-process path's p95 measured in the same run on the same host, in two phases: idle, and with 6 CPU-burning processes running (n = 40 per leg, the two legs run at once and their calls are interleaved so they see the same load)
 *     (a loaded host; load average is printed). The sample sizes and the p95s are printed in the assertion messages and on stdout. Precondition: the switched run really read the executor.
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
const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]; };
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
    // DIAGNOSTIC (#1644 / #1693): the executor logs each query's handler time to this file (`executor.py --log`); read below, never asserted.
    const logFile = path.join(own.dir('r44l-log-'), 'exec.log');
    const exec = await startExecutor({ store, datasetId: DSID, extraArgs: ['--promote-epoch', '--log', logFile] }); exec.logFile = logFile; own.adopt(() => killExecutor(exec));
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
    const logLines = (x) => fs.readFileSync(x.exec.logFile, 'utf8').split('\n').filter(Boolean);
    off.mark = logLines(off).length; on.mark = logLines(on).length;   // DIAGNOSTIC: only the measured calls, not the warm-ups
    const offMs = []; const onMs = []; let sources = new Set();
    for (let i = 0; i < 40; i++) {
      const order = i % 2 === 0 ? [off, on] : [on, off];
      for (const x of order) { const t0 = Date.now(); const r = await call(x); (x.calls ??= []).push({ t0, t1: Date.now(), ms: r.ms }); (x === off ? offMs : onMs).push(r.ms); sources.add(`${x === off ? 'off' : 'on'}:${r.source}`); }
    }
    // DIAGNOSTIC: for EACH measured call, the executor's logged query handler times that fall inside that call's wall-clock window (same host, so one clock),
    // then the per-call residual = end-to-end minus those handler times. Summarised per call, never as p95(end-to-end) minus p95(handler).
    const stamp = (l) => Date.parse(l.split(' ')[0]);
    const perCall = (x) => {
      const q = logLines(x).slice(x.mark).map((l) => l.split(' ')).filter((t) => t[2] === 'query' && t[3] === 'OK').map((t) => ({ at: Date.parse(t[0]), ms: Number(t[4]) }));
      const rows = x.calls.map((c) => { const hit = q.filter((e) => e.at >= c.t0 - 2 && e.at <= c.t1 + 2); const sum = hit.reduce((acc, e) => acc + e.ms, 0); return { n: hit.length, handler: sum, residual: c.ms - sum, e2e: c.ms }; });
      const f = (k) => `p50=${med(rows.map((r) => r[k])).toFixed(1)} p95=${p95(rows.map((r) => r[k])).toFixed(1)}`;
      return `calls=${rows.length}, calls with no matched handler line=${rows.filter((r) => r.n === 0).length}, handler lines per call min=${Math.min(...rows.map((r) => r.n))} max=${Math.max(...rows.map((r) => r.n))}; per-call handler sum ${f('handler')} ms; per-call residual ${f('residual')} ms; end-to-end ${f('e2e')} ms`;
    };
    // DIAGNOSTIC (#1694): the executor's own `query-phases` lines (setup, iterate_convert, encode, write, rows), attributed to the measured call whose start precedes them
    // (calls on a leg are sequential), then summed over the 2 to 3 queries each call makes. End-to-end minus the phase-line totals is the residual, never a p95 difference.
    const phaseRows = (x) => {
      const all = logLines(x).slice(x.mark).map((l) => l.split(' '));
      const ph = all.filter((t) => t[2] === 'query-phases' && t[3] === 'OK').map((t) => ({ at: Date.parse(t[0]), total: Number(t[4]), p: Object.fromEntries(t.slice(6).map((q) => q.split('=')).map(([k, v]) => [k, Number(v)])) }));
      const starts = x.calls.map((c) => c.t0 - 2);
      const owner = (at) => { let k = -1; for (let i = 0; i < starts.length; i++) if (starts[i] <= at) k = i; return k; };
      return x.calls.map((c, i) => {
        const q = ph.filter((e) => owner(e.at) === i); const sum = (f) => q.reduce((acc, e) => acc + f(e), 0);
        return { n: q.length, setup: sum((e) => e.p.setup ?? 0), iterate_convert: sum((e) => e.p.iterate_convert ?? 0), advance: sum((e) => e.p['iterate_convert.advance'] ?? 0), convert: sum((e) => e.p['iterate_convert.convert'] ?? 0), encode: sum((e) => e.p.encode ?? 0), write: sum((e) => e.p.write ?? 0), rows: sum((e) => e.p.rows ?? 0), phase_total: sum((e) => e.total), e2e: c.ms, residual: c.ms - sum((e) => e.total) };
      });
    };
    const phaseSummary = (x) => {
      const rows = phaseRows(x); const f = (k) => `${k}=${med(rows.map((r) => r[k])).toFixed(1)}/${p95(rows.map((r) => r[k])).toFixed(1)}`;
      return `calls=${rows.length}, calls with no phase line=${rows.filter((r) => r.n === 0).length}, phase lines per call min=${Math.min(...rows.map((r) => r.n))} max=${Math.max(...rows.map((r) => r.n))}; per-call sums p50/p95 ms: ${['setup', 'iterate_convert', 'advance', 'convert', 'encode', 'write', 'phase_total', 'residual', 'e2e'].map(f).join(' ')}; rows per call p50=${med(rows.map((r) => r.rows))}`;
    };
    console.log(`L1DIAG2 ${label}: executor query-phases (residual = end-to-end minus the phase-line totals: combined unmeasured overhead, not a proven split) | executor leg: ${phaseSummary(on)}`);
    console.log(`L1DIAG ${label}: PER-CALL correlation (residual = combined unmeasured overhead, not a proven queue/transport/serialization split) | executor leg: ${perCall(on)} | in-process leg's executor: ${perCall(off)}`);
    const line = `L1 ${label}: load1=${os.loadavg()[0].toFixed(2)}  in-process n=${offMs.length} p50=${Math.round(med(offMs))} p95=${Math.round(p95(offMs))} ms | executor n=${onMs.length} p50=${Math.round(med(onMs))} p95=${Math.round(p95(onMs))} ms (ratio ${(p95(onMs) / p95(offMs)).toFixed(2)}; ${on.proxy.readyQueries} readiness queries on the executor leg, ${off.proxy.readyQueries} on the in-process leg; responses said ${[...sources].sort().join(', ')})`;
    console.log(line); return { off: { ms: offMs, queries: off.proxy.readyQueries }, on: { ms: onMs, queries: on.proxy.readyQueries }, line };
  }
  });
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
  if (process.env.L1DIAG_IDLE_ONLY === '1') return;   // DIAGNOSTIC: the Mac run stops after the idle phase (no burners)
  const burners = Array.from({ length: 6 }, () => spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }));
  try { await new Promise((r) => setTimeout(r, 3000)); check(await phase(sd, 'loaded (6 CPU burners)')); } finally { for (const b of burners) b.kill('SIGKILL'); }
});
