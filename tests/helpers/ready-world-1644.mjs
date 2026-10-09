/** Shared fixtures for the #1644 rows (the functional file and the snapshot/latency file). Test-author's, written before the build. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeBoardFixture, startRestServer } from './harness.mjs';
import { spawn } from 'node:child_process';
import { HAVE_PY, tmpStore, startExecutor, killExecutor, EXEC, PY } from './graph-executor-proc.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATE = path.join(HERE, '..', '..', 'scripts', 'migrate-cards-1598.mjs');
export const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
export const READY_ENV = 'SCRUM_GRAPH_READY_SOURCE';
export const DSID = 'r44-test';
export const ROSTER_FILE = path.join(os.tmpdir(), `r44-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
export { tmpStore, startExecutor, killExecutor, startRestServer, makeBoardFixture };

export const card = (shortId, title, extra = {}) => ({
  id: `uuid-${shortId}`, shortId, title, description: 'body', type: 'task', assignees: [], labels: [], for: '', priority: null, column: 'backlog', order: 0,
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', createdBy: 'ada',
  relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [] }, claimedBy: null, claimedAt: null, ...extra,
});
export const smallBoard = () => makeBoardFixture({
  cards: [
    card(1, 'free', { priority: 'p2' }),
    card(2, 'held', { priority: 'p0', claimedBy: 'ada', claimedAt: '2026-08-02T00:00:00.000Z' }),
    card(3, 'waiting', { priority: 'p1', relationships: { relatedTo: [], blockedBy: [4], supersedes: [], derivedFrom: [] } }),
    card(4, 'blocker', { priority: 'p3', column: 'in-progress' }),
    card(5, 'finished', { priority: 'p0', column: 'done' }),
  ],
  nextShortId: 6, conversations: [],
});

export const richBoard = () => makeBoardFixture({
  cards: [
    card(1, 'free', { priority: 'p2', relationships: { relatedTo: [4], blockedBy: [], supersedes: [], derivedFrom: [] } }),
    card(2, 'held', { priority: 'p0', claimedBy: 'ada', claimedAt: '2026-08-02T00:00:00.000Z' }),
    card(3, 'waiting', { priority: 'p1', relationships: { relatedTo: [], blockedBy: [4], supersedes: [], derivedFrom: [] } }),
    card(4, 'blocker', { priority: 'p3', column: 'in-progress', relationships: { relatedTo: [1], blockedBy: [], supersedes: [], derivedFrom: [] } }),
    card(5, 'finished', { priority: 'p0', column: 'done' }),
    card(6, 'parked', { priority: 'p1', parkedBy: 'ada', parkedAt: '2026-08-03T00:00:00.000Z', parkedUntil: '2099-01-01T00:00:00.000Z', parkedReason: 'fixture' }),
    card(7, 'successor', { priority: 'p2', relationships: { relatedTo: [], blockedBy: [], supersedes: [8], derivedFrom: [] } }),
    card(8, 'old', { priority: 'p2', relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [], supersededBy: [7] } }),
    card(9, 'child', { priority: 'p2', relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [1] } }),
    card(10, 'dangling', { priority: 'p2', relationships: { relatedTo: [], blockedBy: [999], supersedes: [], derivedFrom: [] } }),
    // human blockers and release conditions are card fields (blockers / acceptance) that the projection turns into scrum:Blocker and scrum:ReleaseCondition nodes
    card(11, 'waits on a person', { priority: 'p2', blockers: [{ person: 'ada', status: 'open', note: 'fixture' }] }),
    card(12, 'waits on any human', { priority: 'p2', blockers: [{ anyHuman: true, status: 'open', note: 'fixture' }] }),
    card(13, 'has a condition blocked by an open card', { priority: 'p2', acceptance: [{ condition: 'the fixture condition', evidence: [], blockedBy: [4] }] }),
    card(14, 'has a met condition', { priority: 'p2', acceptance: [{ condition: 'another fixture condition', evidence: ['0123456789012345678901234567890123456789'] }] }),
  ],
  nextShortId: 15, conversations: [],
});

/** A proxy in front of the executor that COUNTS /query requests (and can hold, corrupt or stop answering). */
export async function startProxy(execUrl) {
  // `queries` counts EVERY /query request outside an injection; `readyQueries` counts the ones that read READY facts (the text names scrum:parkedUntil, which only a readiness read needs).
  // Why two: with the cards unit on, every /api/ready call makes one currency query of its own EVEN WITH THE SWITCH OFF (measured 14:17Z: 1 per call), so "the executor was asked" must be about the ready read, not any query.
  const p = { queries: 0, readyQueries: 0, mode: 'pass', injecting: false, onQuery: null, rewrite: null };
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const isQuery0 = req.method === 'POST' && (req.url === '/query' || req.url.startsWith('/query?'));
    // REST's OWN executor ping (the cards-currency check at the start of every GET /api/ready with the cards unit on, `SELECT ?x WHERE { BIND(1 AS ?x) }`) is never the reader's: it is passed through at once,
    // not counted, not hooked, never held or corrupted. Holding it while an injected card write waits on the same single-flight currency check deadlocks REST against itself (measured 15:46Z: the injected
    // DELETE died UND_ERR_SOCKET while the GET answered a correct 503); that is a failure-path observation, recorded in the snapshot file's header, not the property S1 measures.
    const isPing = isQuery0 && Buffer.concat(chunks).toString('utf8').trim() === 'SELECT ?x WHERE { BIND(1 AS ?x) }';
    const isQuery = isQuery0 && !isPing;   // the graph client posts to /query, queryGraphExecutor to /query?dataset=public: a build may use either
    if (isQuery && p.bodies && !p.injecting) p.bodies.push(Buffer.concat(chunks).toString('utf8'));   // diagnostic: keep every query text when asked
    const isReadyRead = isQuery && /parkedUntil/.test(Buffer.concat(chunks).toString('utf8'));   // the modes below hit ONLY readiness reads, so a build that ignores the switch is not failed by the unrelated currency query
    if (isQuery && !p.injecting) { p.queries += 1; if (isReadyRead) p.readyQueries += 1; if (p.onQuery) { p.injecting = true; try { await p.onQuery(p.queries); } finally { p.injecting = false; } } }
    if (isReadyRead && p.mode === 'hold') return;   // never answers
    const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
    try {
      const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
      let t = await f.text();
      if (isReadyRead && p.mode === 'garbage') t = t.slice(0, Math.max(1, Math.floor(t.length / 2)));
      if (isQuery && p.rewrite) { try { const j = JSON.parse(t); p.rewrite(j); t = JSON.stringify(j); } catch { /* not a SELECT result */ } }
      res.statusCode = f.status; res.setHeader('content-type', f.headers.get('content-type') || 'application/json'); res.end(t);
    } catch { res.statusCode = 502; res.end('{}'); }
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r)); p.port = p.server.address().port; p.url = `http://127.0.0.1:${p.port}`;
  p.down = () => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); });
  return p;
}
export const migrate = (boardFile, execUrl) => new Promise((resolve) => {
  execFile(process.execPath, [MIGRATE, '--board-data', boardFile, '--executor', execUrl, '--dataset', DSID, '--apply'], { timeout: 180000 }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout}${stderr}` }));
});

/** A world: a real executor holding the board's cards, a counting proxy in front of it, and REST (cards unit ON) with the switch as asked. Restartable with a different switch on the SAME executor and board. */
export async function world(board, body) {
  const exec = await startExecutor({ store: tmpStore('r44-store-'), datasetId: DSID, create: true });
  const proxy = await startProxy(exec.baseUrl);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r44-board-')); const boardFile = path.join(dir, 'board.json');
  fs.writeFileSync(boardFile, JSON.stringify(board, null, 2));
  let rest = null;
  const w = {
    exec, proxy, boardFile,
    async start({ ready = false } = {}) {
      if (rest) await rest.stop();
      rest = await startRestServer({ boardFile, env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_CARDS: '1', ...(ready ? { [READY_ENV]: 'executor' } : {}) } });
      w.base = rest.baseUrl; w.rest = rest; return w;
    },
    async get(route) { const r = await fetch(`${w.base}${route}`, { signal: AbortSignal.timeout(40000) }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } return { status: r.status, text, json }; },
    async patch(id, b) { const r = await fetch(`${w.base}/api/cards/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by: 'ada', ...b }), signal: AbortSignal.timeout(40000) }); return r.status; },
  };
  try {
    const m = await migrate(boardFile, exec.baseUrl); assert.equal(m.code, 0, `precondition: the cards are copied into the executor (exit ${m.code}): ${m.out.slice(0, 300)}`);
    return await body(w);
  } finally { if (rest) await rest.stop(); try { await proxy.down(); } catch { /* down */ } await killExecutor(exec); }
}

/** Start the executor on a COPY of a seeded store: since #1638 an executor refuses a copied store unless it is told to promote it (--promote-epoch). Same contract as startExecutor otherwise. */
export function startExecutorOnCopy({ store, datasetId }) {
  return new Promise((resolve, reject) => {
    const p = spawn(PY, [EXEC, '--store', store, '--port', '0', '--dataset-id', datasetId, '--promote-epoch'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = ''; let done = false;
    p.stdout.on('data', (d) => { out += d; if (!done && out.includes('\n')) { done = true; try { const ready = JSON.parse(out.split('\n')[0]); resolve({ proc: p, ready, port: ready.port, baseUrl: `http://127.0.0.1:${ready.port}` }); } catch (e) { reject(e); } } });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code, sig) => { if (!done) { done = true; reject(new Error(`executor exited ${code ?? sig}: ${err}`)); } });
  });
}
