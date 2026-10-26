/**
 * #1788 — ONE data folder: SCRUM_DATA_DIR places every derived store, and the board file defaults into it. The test author's
 * independent RED rows, written black-box against the "#1788 CONTRACT" (commons, 2026-10-26 20:27Z) before the build.
 *
 * THE CONTRACT (one table, so a rename is one edit): DATA_DIR = SCRUM_DATA_DIR || dirname(SCRUM_BOARD_FILE). Derived from it:
 * seat-tokens.json (only when SCRUM_SEAT_TOKENS is unset), graph-query-log.jsonl, search-index.jsonl, search-log.jsonl; named
 * for the board file's identity but placed in DATA_DIR: <board>-events/ (unless SCRUM_EVENT_LOG_DIR) and <board>-misses.jsonl.
 * The board file defaults to $SCRUM_DATA_DIR/board-data.json when SCRUM_BOARD_FILE is unset. Every explicit env var wins.
 *
 * ROWS:
 *   D1  SCRUM_DATA_DIR set, the board file ELSEWHERE: the graph-query log, the search index and log, the misses log and the
 *       event log land in DATA_DIR and NOT beside the board file; the seat tokens are READ from DATA_DIR (a token only that
 *       file holds is accepted under SCRUM_AUTH=required, and a request without it is refused)
 *   D2  CONTROL, SCRUM_DATA_DIR unset: the same stores land beside the board file (today's paths, unchanged)
 *   D3  an explicit SCRUM_EVENT_LOG_DIR still wins over DATA_DIR
 *   D4  two boards sharing one DATA_DIR never share an event log or a misses log, including two boards whose files have
 *       the SAME name in different folders (the harness's normal case). A board OUTSIDE its DATA_DIR logs under its stem plus
 *       the first 8 hex of sha256(its absolute path); a board INSIDE it keeps the bare stem (D5, production)
 *   D5  a mode-off boot with SCRUM_BOARD_FILE UNSET and only SCRUM_DATA_DIR set serves, writes its event log into DATA_DIR,
 *       and creates nothing in the project folder
 *
 * NOT COVERED, BY NAME: graph-snapshot.* (retired by #1789; no live writer to observe); the production plist change.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startRestServer, makeBoardFixture, freePort, PROJECT_DIR } from './helpers/harness.mjs';
import { HAVE_PY } from './helpers/graph-executor-proc.mjs';
import { wholeBoardWorld, WB_DATASET } from './helpers/whole-board-1645.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';
import { BOOKKEEPING_GRAPH } from '../core/graph-vocab.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKFILL = path.join(HERE, '..', 'scripts', 'card-ref-index-1744.mjs');
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const SKIP_PY = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const TOK = mintToken();
const tokensFile = (dir) => { const at = (h) => new Date(Date.now() + h * 3600_000).toISOString(); fs.writeFileSync(path.join(dir, 'seat-tokens.json'), JSON.stringify({ seats: { ada: { credentials: [{ tokenHash: hashToken(TOK), scope: 'admin', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null }] } } })); };

/** an embedder stub, so search writes its index and log */
async function fakeEmbedder() {
  const srv = http.createServer((req, res) => { let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => { const b = JSON.parse(raw); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ model: b.model, embeddings: b.input.map(() => [1, 0, 0]) })); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}/api/embed`, stop: () => new Promise((r) => srv.close(r)) };
}
/** drive every store the contract names, with ada's token */
async function exercise(baseUrl) {
  const H = { 'Content-Type': 'application/json', authorization: `Bearer ${TOK}` };
  const r1 = await fetch(`${baseUrl}/api/cards`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'dd card', description: 'x', createdBy: 'ada' }) });
  assert.equal(r1.status, 201, `a card write (event log) (${r1.status} ${(await r1.text()).slice(0, 160)})`);
  await fetch(`${baseUrl}/api/graph`, { method: 'POST', headers: H, body: JSON.stringify({ query: 'SELECT ?c WHERE { ?c a schema:CreativeWork } LIMIT 1', by: 'ada' }) });   // query log
  await fetch(`${baseUrl}/api/search`, { method: 'POST', headers: H, body: JSON.stringify({ q: 'dd card', by: 'ada' }) });   // search index + log
  await fetch(`${baseUrl}/api/cards?sortBy=title&as=ada`, { headers: H });   // a miss (sortBy=title is not a real sort key)
}
const exists = (p) => fs.existsSync(p);
const stem = (boardFile) => path.basename(boardFile).replace(/\.json$/, '');
/** the board's log name IN a DATA_DIR: the bare stem when the board file lives there, else the stem plus the first 8 hex of
 *  sha256(its absolute path), so two boards with the same file name from different folders never share a log (settled with
 *  the builder: production's board lives in its DATA_DIR, so its log keeps its name) */
const logStem = (boardFile, dataDir) => (path.resolve(path.dirname(boardFile)) === path.resolve(dataDir)
  ? stem(boardFile)
  : `${stem(boardFile)}-${crypto.createHash('sha256').update(path.resolve(boardFile)).digest('hex').slice(0, 8)}`);

test('#1788 D1 — SCRUM_DATA_DIR set and the board elsewhere: every derived store lands in DATA_DIR, and seat tokens are read from it', async () => {
  const data = tmp('dd-1788-data-');
  tokensFile(data);
  const emb = await fakeEmbedder();
  let srv = null;
  try {
    srv = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }), env: { SCRUM_DATA_DIR: data, SCRUM_SEAT_TOKENS: '', SCRUM_AUTH: 'required', SEARCH_EMBED_URL: emb.url, SEARCH_EMBED_MODEL: 'fake' } });
    const beside = path.dirname(srv.boardFile);
    assert.notEqual(beside, data, 'PRECONDITION: the board file is NOT in DATA_DIR');
    const anon = await fetch(`${srv.baseUrl}/api/cards`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'no token', createdBy: 'ada' }) });
    assert.equal(anon.status, 401, `D1: required mode refuses a write without a token (${anon.status})`);
    await exercise(srv.baseUrl);   // its first assertion: the token ONLY DATA_DIR's seat-tokens.json holds is accepted
    for (const name of ['graph-query-log.jsonl', 'search-index.jsonl', 'search-log.jsonl', `${logStem(srv.boardFile, data)}-misses.jsonl`, `${logStem(srv.boardFile, data)}-events`]) {
      assert.ok(exists(path.join(data, name)), `D1: ${name} is in DATA_DIR (it holds: ${fs.readdirSync(data).join(', ')})`);
    }
    for (const name of ['graph-query-log.jsonl', 'search-index.jsonl', 'search-log.jsonl', `${stem(srv.boardFile)}-misses.jsonl`, `${stem(srv.boardFile)}-events`]) {
      assert.ok(!exists(path.join(beside, name)), `D1: ${name} is NOT beside the board file`);
    }
  } finally { await srv?.stop(); await emb.stop(); fs.rmSync(data, { recursive: true, force: true }); }
});

test('#1788 D2 CONTROL — SCRUM_DATA_DIR unset: the stores land beside the board file, as today', async () => {
  const emb = await fakeEmbedder();
  let srv = null;
  try {
    srv = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }), env: { SCRUM_DATA_DIR: '', SEARCH_EMBED_URL: emb.url, SEARCH_EMBED_MODEL: 'fake' } });
    tokensFile(path.dirname(srv.boardFile));   // read lazily or not at all with auth off; written so the paths match D1
    await exercise(srv.baseUrl);
    const beside = path.dirname(srv.boardFile);
    for (const name of ['graph-query-log.jsonl', 'search-index.jsonl', 'search-log.jsonl', `${stem(srv.boardFile)}-misses.jsonl`, `${stem(srv.boardFile)}-events`]) {
      assert.ok(exists(path.join(beside, name)), `D2: ${name} is beside the board file`);
    }
  } finally { await srv?.stop(); await emb.stop(); }
});

test('#1788 D3 — an explicit SCRUM_EVENT_LOG_DIR still wins over SCRUM_DATA_DIR', async () => {
  const data = tmp('dd-1788-d3-'), events = tmp('dd-1788-ev-');
  let srv = null;
  try {
    srv = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }), env: { SCRUM_DATA_DIR: data, SCRUM_EVENT_LOG_DIR: events } });
    const r = await fetch(`${srv.baseUrl}/api/cards`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'ev', createdBy: 'ada' }) });
    assert.equal(r.status, 201, `PRECONDITION: a write (${r.status})`);
    assert.ok(fs.readdirSync(events).length > 0, 'D3: the event log is in the explicit SCRUM_EVENT_LOG_DIR');
    assert.ok(!exists(path.join(data, `${logStem(srv.boardFile, data)}-events`)) && !exists(path.join(data, `${stem(srv.boardFile)}-events`)), 'D3: and not in DATA_DIR');
  } finally { await srv?.stop(); fs.rmSync(data, { recursive: true, force: true }); fs.rmSync(events, { recursive: true, force: true }); }
});

test('#1788 D4 — two boards sharing one DATA_DIR keep separate event and misses logs, even when their files have the same name', async () => {
  const data = tmp('dd-1788-d4-');
  let a = null, b = null;
  try {
    a = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }), env: { SCRUM_DATA_DIR: data } });
    b = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }), env: { SCRUM_DATA_DIR: data } });
    assert.equal(path.basename(a.boardFile), path.basename(b.boardFile), 'PRECONDITION: the two board files share a NAME (different folders)');
    for (const [srv, title] of [[a, 'from board A'], [b, 'from board B']]) {
      const r = await fetch(`${srv.baseUrl}/api/cards`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, createdBy: 'ada' }) });
      assert.equal(r.status, 201, `PRECONDITION: a write on ${title} (${r.status})`);
      await fetch(`${srv.baseUrl}/api/cards?sortBy=title&as=ada`);
    }
    // every event file in DATA_DIR, read whole: no single log may carry both boards' writes
    const logs = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else logs.push(p); } };
    walk(data);
    const eventFiles = logs.filter((p) => /-events[\\/]/.test(p));
    assert.ok(eventFiles.length >= 2, `D4: the event logs are in DATA_DIR (${eventFiles.map((p) => path.relative(data, p))})`);
    const dirs = new Set(eventFiles.map((p) => path.relative(data, p).split(path.sep)[0]));
    for (const d of dirs) {
      const text = eventFiles.filter((p) => path.relative(data, p).split(path.sep)[0] === d).map((p) => fs.readFileSync(p, 'utf8')).join('');
      assert.ok(!(text.includes('from board A') && text.includes('from board B')), `D4: event log ${d} carries ONE board's writes, never both`);
    }
    assert.ok(dirs.size >= 2, `D4: two boards, two event logs (${[...dirs]})`);
    const misses = logs.filter((p) => /-misses\.jsonl$/.test(p));
    assert.ok(misses.length >= 2, `D4: two boards, two misses logs (${misses.map((p) => path.basename(p))})`);
  } finally { await a?.stop(); await b?.stop(); fs.rmSync(data, { recursive: true, force: true }); }
});

test('#1788 D5 — mode off with SCRUM_BOARD_FILE UNSET and only SCRUM_DATA_DIR: REST serves, logs into DATA_DIR, and creates nothing in the project folder', { skip: SKIP_PY, timeout: 300000 }, async () => {
  const w = await wholeBoardWorld({ env: { SCRUM_GRAPH_UNIT_CARDS: '1', SCRUM_GRAPH_UNIT_COLUMNS: '1', SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_LOGBORN: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1', SCRUM_GRAPH_UNIT_DELIVERIES: '1' } });
  const kept = fs.readFileSync(w.boardFile);
  await w.rest.stop(); fs.writeFileSync(w.boardFile, kept);
  const data = tmp('dd-1788-d5-');
  const projectFiles = ['board-data.json', 'board-data-events', 'board-data-misses.jsonl', 'graph-query-log.jsonl'].map((n) => path.join(PROJECT_DIR, n));
  const before = projectFiles.map(exists);
  let child = null;
  try {
    const gc = createGraphClient({ baseUrl: w.exec.baseUrl, expectedDatasetId: WB_DATASET, timeoutMs: 30000, label: 'dd-1788' });
    const q = async (s) => { const r = await gc.query(s); assert.ok(r.ok, r.reason); return r.rows; };
    const seqs = (await q(`SELECT ?n WHERE { { ?s ?p ?n } UNION { GRAPH ?g { ?s ?p ?n } } FILTER(STRENDS(STR(?p), "/postSeq") || STRENDS(STR(?p), "#postSeq")) }`)).map((r) => Number(r.n.value)).filter(Number.isSafeInteger);
    const epoch = (/"postSeqEpoch"\s*:\s*"([^"]+)"/.exec(kept.toString('utf8')) || [])[1] || 'e-dd-1788';
    const ep = (await (await fetch(`${w.exec.baseUrl}/health`)).json()).epoch;
    const seed = await fetch(`${w.exec.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/test/dd-1788-allocator-${process.pid}-${Date.now()}`, 'x-epoch': String(ep) }, body: `INSERT DATA { GRAPH <${BOOKKEEPING_GRAPH}> { <urn:ex:postseq/allocator> a <urn:ex:postseq/Allocator> ; <urn:ex:postseq/postSeqEpoch> ${JSON.stringify(epoch)} ; <urn:ex:postseq/nextPostSeq> "${Math.max(0, ...seqs) + 1}"^^<${XSD}integer> ; <urn:ex:postseq/version> "1"^^<${XSD}integer> . } }` });
    assert.equal(seed.status, 200, 'PRECONDITION: the allocator is seeded');
    const bf = await new Promise((resolve) => { const p = spawn(process.execPath, [BACKFILL, '--executor', w.exec.baseUrl, '--dataset', WB_DATASET, '--backfill'], { stdio: 'ignore' }); p.on('close', resolve); });
    assert.equal(bf, 0, 'PRECONDITION: the reference index is backfilled');
    fs.copyFileSync(w.boardFile, path.join(data, 'board-data.json'));
    fs.chmodSync(path.join(data, 'board-data.json'), 0o000);   // production's mode off: the file is present and unreadable
    const port = await freePort();
    const env = { ...process.env, SCRUM_PORT: String(port), SCRUM_DATA_DIR: data, SCRUM_ATTACHMENTS_DIR: path.join(data, 'attachments'), SCRUM_CHANNEL_CONFIG_FILE: path.join(data, 'channel-config.json'), SCRUM_MCP_NOTIFY_URL: '',
      SCRUM_GRAPH_DATASET_ID: WB_DATASET, SCRUM_GRAPH_EXECUTOR_URL: w.exec.baseUrl, SCRUM_BOARD_DOCUMENT: 'off',
      SCRUM_GRAPH_UNIT_CARDS: '1', SCRUM_GRAPH_UNIT_COLUMNS: '1', SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_LOGBORN: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1', SCRUM_GRAPH_UNIT_DELIVERIES: '1',
      SCRUM_GRAPH_QUERY_SOURCE: 'executor', SCRUM_GRAPH_READY_SOURCE: 'executor', SCRUM_GRAPH_CHECKS_SOURCE: 'executor', SCRUM_GRAPH_NEIGHBORS_SOURCE: 'executor' };
    delete env.SCRUM_BOARD_FILE; delete env.SCRUM_EVENT_LOG_DIR; delete env.SCRUM_SEAT_TOKENS;
    let err = '';
    child = spawn(process.execPath, ['server.js'], { cwd: PROJECT_DIR, env, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', (d) => { err += d; });
    let up = false;
    for (const t0 = Date.now(); !up && Date.now() - t0 < 60_000 && child.exitCode == null; await new Promise((r) => setTimeout(r, 250))) {
      try { up = (await fetch(`http://127.0.0.1:${port}/api/cards?limit=1`, { signal: AbortSignal.timeout(2000) })).ok; } catch { /* not yet */ }
    }
    assert.ok(up, `D5: REST serves with SCRUM_BOARD_FILE unset (exit ${child.exitCode}; stderr: ${err.slice(-600)})`);
    const r = await fetch(`http://127.0.0.1:${port}/api/cards`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'dd d5', createdBy: 'ada' }) });
    assert.equal(r.status, 201, `D5: a write is accepted (${r.status} ${(await r.text()).slice(0, 160)})`);
    assert.ok(exists(path.join(data, 'board-data-events')), 'D5: the event log is in DATA_DIR');
    const after = projectFiles.map(exists);
    assert.deepEqual(after, before, `D5: nothing was created in the project folder (${projectFiles.filter((p, i) => after[i] && !before[i]).map((p) => path.basename(p))})`);
  } finally {
    if (child && child.exitCode == null) child.kill('SIGKILL');
    // a run against a build WITHOUT the change writes into the project folder: remove only what this run created
    projectFiles.forEach((p, i) => { if (!before[i] && exists(p)) fs.rmSync(p, { recursive: true, force: true }); });
    try { fs.chmodSync(path.join(data, 'board-data.json'), 0o644); } catch { /* absent */ }
    fs.rmSync(data, { recursive: true, force: true });
    try { fs.writeFileSync(w.boardFile, kept); } catch { /* going anyway */ }
    await w.stop();
  }
});
