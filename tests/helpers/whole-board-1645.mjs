/**
 * #1645 — A WHOLE-BOARD FIXTURE: one small board, put into a scratch executor by the same migration scripts production used, so the executor holds
 * the board the in-process replica projects. Test author's, for the slice-2 differentials (2a vocabulary and predicate shapes; 2b the census).
 *
 * The ORDER comes from the scripts' own preconditions, not from memory or git dates (the code reviewer's point, 43292):
 *   migrate-to-jsonld          the board file becomes JSON-LD (some migrations read only that shape)
 *   migrate-post-seq-1592      numbers the posts in the stopped FILE: backfill-posts-r0 refuses an unnumbered board (its own refusal says so)
 *   migrate-cards-1598         cards into the executor
 *   migrate-columns-1639       columns into the executor
 *   backfill-posts-r0          posts into the executor
 * Measured at 3b690b5 (scratch probe, 2026-10-17T20:15Z): on this fixture /api/graph source:replica answered 71 triples and source:executor 83, with
 * 0 only in the replica and 12 only in the executor, in three groups: scrum:CardImport receipts (type + scrum:sourceDigest, declared public
 * migration provenance, 43300), scrum:postSeq on each post, scrum:inCollection on each column. Those are EXISTING representation differences.
 *
 * NOT in this fixture, by name: memories, decisions and seat state (migrate-logborn-1561); deliveries and model calls (migrate-unit3-1582); the
 * small-kind collections (migrate-collections-1624); declared kinds (backfill-kinds, which needs a running REST). A differential over this
 * fixture says nothing about their terms.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeBoardFixture, startRestServer } from './harness.mjs';
import { tmpStore, startExecutor, killExecutor } from './graph-executor-proc.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const WB_DATASET = 'wb-1645';
const card = (n, extra = {}) => ({ id: `uuid-${n}`, shortId: n, title: `card ${n}`, description: 'body', type: 'task', assignees: [], labels: ['l1'], for: '', priority: 'p2', column: 'backlog', order: n, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', createdBy: 'ada', relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [] }, claimedBy: null, claimedAt: null, ...extra });
export const wholeBoard = () => makeBoardFixture({
  cards: [card(1), card(2, { relationships: { relatedTo: [1], blockedBy: [1], supersedes: [], derivedFrom: [] } }), card(3, { column: 'done' })],
  conversations: [
    { id: 'p-1', body: 'a board post', author: 'ada', attachedTo: null, createdAt: '2026-08-01T00:00:00.000Z', attachments: [], mentions: [] },
    { id: 'p-2', body: 'a card post', author: 'ada', attachedTo: 'uuid-1', createdAt: '2026-08-01T00:01:00.000Z', attachments: [], mentions: [] },
  ],
  nextShortId: 4,
});

const step = (script, args) => {
  try { return { script, code: 0, out: execFileSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 }) }; }
  catch (e) { return { script, code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }; }
};

/**
 * LOG-BORN DATA (#1645 2b, opt-in with { logborn: true }): one memory, one decision and one seat state, written through REST with the logborn unit
 * OFF (so they land in the document and its event log, as prod's did before its cutover), REST stopped, then migrate-logborn-1561 --run, and
 * the returned REST started with SCRUM_GRAPH_UNIT_LOGBORN=1. Measured by a scratch probe at bca80e3 (2026-10-18T00:26Z): all three are served
 * from the executor afterwards. The seat state's expiresAt is computed relative to now, never a fixed date (#1696).
 */
async function writeLogborn(boardFile, baseEnv) {
  const rest = await startRestServer({ boardFile, env: baseEnv });
  try {
    const send = async (method, route, body) => {
      const r = await fetch(`${rest.baseUrl}${route}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const t = await r.text(); if (r.status >= 300) throw new Error(`PRECONDITION: ${method} ${route} answered ${r.status}: ${t.slice(0, 200)}`);
      return JSON.parse(t);
    };
    const memory = await send('POST', '/api/memories', { title: 'a fixture memory', body: 'remembered for the #1645 2b fixture', by: 'ada' });
    const decision = await send('POST', '/api/decisions', { statement: 'a fixture decision', decidedBy: 'ada', constrains: ['fixture'], reopensIf: 'the fixture changes', by: 'ada' });
    const seat = await send('PUT', '/api/seats/ada/state', { mode: 'available', acceptsRoutineWork: true, expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(), note: 'the #1645 2b fixture', by: 'ada' });
    return { memoryId: memory.id, decisionId: decision.id, seat: seat.seat };
  } finally {
    // the harness's stop() UNLINKS the board file even when it was shared in (found 2026-10-18 by #1710's probe): keep the
    // document across it, or every log-born world runs with NO document, which production never does
    const kept = fs.readFileSync(boardFile);
    await rest.stop();
    fs.writeFileSync(boardFile, kept);
  }
}

/** Build the fixture, run the chain into a fresh executor, start REST (cards, columns and conversations units on). Every step must exit 0.
 *  `front` (optional): given the executor's URL once the chain has run, returns the URL REST should use instead (a fault-injecting proxy, #84's
 *  fault rows); the migrations always talk to the executor itself. The world returns it as `frontUrl`. */
export async function wholeBoardWorld({ env = {}, logborn = false, front = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb1645-')); const boardFile = path.join(dir, 'board.json');
  fs.writeFileSync(boardFile, JSON.stringify(wholeBoard(), null, 2));
  const store = tmpStore('wb1645-store-'); fs.rmSync(store, { recursive: true });
  const exec = await startExecutor({ store, datasetId: WB_DATASET, create: true });
  const cleanup = async (rest) => { if (rest) await rest.stop(); await killExecutor(exec); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(store, { recursive: true, force: true }); fs.rmSync(`${store}.checkpoints`, { recursive: true, force: true }); };
  try {
    const steps = [
      step('migrate-to-jsonld.mjs', [boardFile]),
      step('migrate-post-seq-1592.mjs', ['--board-file', boardFile]),
      step('migrate-cards-1598.mjs', ['--board-data', boardFile, '--executor', exec.baseUrl, '--dataset', WB_DATASET, '--apply']),
      step('migrate-columns-1639.mjs', ['--board-data', boardFile, '--executor', exec.baseUrl, '--dataset', WB_DATASET, '--apply']),
      step('backfill-posts-r0.mjs', ['--board-file', boardFile, '--executor-url', exec.baseUrl, '--dataset-id', WB_DATASET]),
    ];
    const bad = steps.find((s) => s.code !== 0);
    if (bad) throw new Error(`PRECONDITION: ${bad.script} exited ${bad.code}: ${bad.out.slice(-400)}`);
    const baseEnv = { SCRUM_GRAPH_DATASET_ID: WB_DATASET, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CARDS: '1', SCRUM_GRAPH_UNIT_COLUMNS: '1', SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' };
    let records = null;
    if (logborn) {
      records = await writeLogborn(boardFile, baseEnv);
      const m = step('migrate-logborn-1561.mjs', ['--board', boardFile, '--executor', exec.baseUrl, '--dataset-id', WB_DATASET, '--actor', 'urn:ex:seat/ada', '--run', '--audit', path.join(dir, 'logborn-audit.json')]);
      steps.push(m);
      if (m.code !== 0) throw new Error(`PRECONDITION: migrate-logborn-1561 exited ${m.code}: ${m.out.slice(-400)}`);
    }
    const frontUrl = front ? await front(exec.baseUrl) : null;
    const rest = await startRestServer({ boardFile, env: { ...baseEnv, ...(logborn ? { SCRUM_GRAPH_UNIT_LOGBORN: '1' } : {}), ...(frontUrl ? { SCRUM_GRAPH_EXECUTOR_URL: frontUrl } : {}), ...env } });
    return { exec, rest, boardFile, steps, records, frontUrl, stop: () => cleanup(rest) };
  } catch (e) { await cleanup(null); throw e; }
}
