/**
 * #1624 — a collection write whose outcome stays UNKNOWN (its ack AND every receipt read lost) leaves the collection cache
 * uncertain. Builder's row, REST with the small-kinds unit on and a real executor behind a fault proxy:
 *   CU1 the write answers 201 or 503 (never a bare 500); a non-collection GET that reads the board is then answered 200
 *       (the cache is reloaded before the route, now that the executor answers); the talk list equals the executor's
 *       store or is a 503 — never the board from before the unknown write.
 * The row fails if the pre-route reload is removed (the board read then refuses: 503), and it also fails if the shared
 * GET board is reused while the cache is uncertain (a read through that board does not see the committed talk: 400).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const ROSTER_FILE = path.join(os.tmpdir(), `cu1-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, gizmo: { name: 'Gizmo', glyph: 'g', color: '#c4a07c' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};

async function startProxy(execUrl) {
  const p = { mode: null, dropped: 0, dropReceipts: 0, receiptsDropped: 0 };
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
    const isUpdate = req.method === 'POST' && req.url.split('?')[0] === '/update';
    if (req.method === 'GET' && req.url.startsWith('/receipt/') && p.dropReceipts > 0) { p.receiptsDropped++; try { req.socket.destroy(); } catch { /* gone */ } return; }
    if (isUpdate && p.mode === 'req') { p.mode = null; p.dropped++; try { req.socket.destroy(); } catch { /* gone */ } return; }
    try {
      const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }); const t = await f.text();
      if (isUpdate && p.mode === 'ack') { p.mode = null; p.dropped++; try { req.socket.destroy(); } catch { /* gone */ } return; }
      res.statusCode = f.status; res.end(t);
    } catch { try { req.socket.destroy(); } catch { /* gone */ } }
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r)); p.url = `http://127.0.0.1:${p.server.address().port}`;
  p.down = () => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); });
  return p;
}
async function storeN(execUrl, literal) {
  const res = await fetch(`${execUrl}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query' }, body: `SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE { ?s <https://schema.org/name> ?o FILTER(STR(?o) = ${JSON.stringify(literal)}) }`, signal: AbortSignal.timeout(30000) });
  assert.equal(res.status, 200); return Number((await res.json()).results.bindings[0].n.value);
}

test('CU1 a collection write left UNKNOWN: 201 or 503; a board-reading GET is then 200; the talk list is the store\'s truth or a 503', { skip: SKIP, timeout: 300000 }, async () => {
  const exec = await startExecutor({ store: tmpStore('cu1-store-'), datasetId: 'cu1', create: true });
  const proxy = await startProxy(exec.baseUrl);
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: 'cu1', SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1' } });
  try {
    const base = rest.baseUrl; const title = `cu1-${process.pid}-${Date.now().toString(36)}`;
    assert.equal((await api(base, 'GET', '/api/talks')).status, 200, 'CONTROL: the talk list is served (the shared board is built)');
    proxy.mode = 'ack'; proxy.dropped = 0; proxy.dropReceipts = 1000;
    const r = await api(base, 'POST', '/api/talks', { by: 'ada', title, with: 'gizmo' });
    proxy.dropReceipts = 0;
    assert.equal(proxy.dropped, 1, 'PRECONDITION: the write\'s ack was dropped');
    assert.ok(proxy.receiptsDropped >= 1, `PRECONDITION: a receipt read was dropped (${proxy.receiptsDropped}), so the outcome stayed undetermined`);
    assert.ok([201, 503].includes(r.status), `an undetermined write answers 201 or 503 (got ${r.status} ${r.text.slice(0, 140)})`);
    // A GET that is NOT a collection route but reads one off the board: the post list filtered by the talk. A board
    // from before the unknown write does not hold the talk and would answer 400 NO_SUCH_TALK for a talk the graph holds.
    const sub = await fetch(`${exec.baseUrl}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query' }, body: `SELECT ?s WHERE { ?s <https://schema.org/name> ${JSON.stringify(title)} }` });
    const talkIri = (await sub.json()).results.bindings[0]?.s?.value;
    assert.ok(talkIri, 'the store holds the talk');
    const posts = await api(base, 'GET', `/api/conversations?conversation=${encodeURIComponent(decodeURIComponent(talkIri.split('/').pop()))}`);
    assert.ok([200, 503].includes(posts.status), `a read through the board sees the committed talk or refuses (got ${posts.status} ${posts.text.slice(0, 140)})`);
    const cols = await api(base, 'GET', '/api/columns');
    assert.equal(cols.status, 200, `a board-reading GET is answered once the executor is back (got ${cols.status} ${cols.text.slice(0, 140)})`);
    const truth = await storeN(exec.baseUrl, title);
    assert.equal(truth, 1, 'the write COMMITTED (only its ack and the receipt reads were lost)');
    const list = await api(base, 'GET', '/api/talks');
    if (list.status === 200) assert.equal((list.body.talks ?? []).filter((t) => t.title === title).length, truth, 'the served list equals the store: never the board from before the write');
    else assert.equal(list.status, 503);
  } finally { await rest.stop(); try { await proxy.down(); } catch { /* down */ } await killExecutor(exec); }
});

test('CU2 the same UNKNOWN write and then the executor unreachable: a board read is a 503, never the board from before the write', { skip: SKIP, timeout: 300000 }, async () => {
  const exec = await startExecutor({ store: tmpStore('cu2-store-'), datasetId: 'cu2', create: true });
  const proxy = await startProxy(exec.baseUrl);
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: 'cu2', SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1' } });
  try {
    const base = rest.baseUrl; const title = `cu2-${process.pid}-${Date.now().toString(36)}`;
    assert.equal((await api(base, 'GET', '/api/talks')).status, 200, 'CONTROL: the talk list is served (the shared board is built)');
    proxy.mode = 'ack'; proxy.dropped = 0; proxy.dropReceipts = 1000;
    const r = await api(base, 'POST', '/api/talks', { by: 'ada', title, with: 'gizmo' });
    assert.equal(proxy.dropped, 1, 'PRECONDITION: the write\'s ack was dropped');
    assert.ok(proxy.receiptsDropped >= 1, 'PRECONDITION: a receipt read was dropped, so the outcome stayed undetermined');
    assert.ok([201, 503].includes(r.status), `an undetermined write answers 201 or 503 (got ${r.status})`);
    await proxy.down();
    const truth = await storeN(exec.baseUrl, title);
    assert.equal(truth, 1, 'the write COMMITTED: the store holds the talk');
    const cols = await api(base, 'GET', '/api/columns');
    assert.equal(cols.status, 503, `with the outcome undetermined and the executor away, a board read refuses rather than serve the board from before the write (got ${cols.status} ${cols.text.slice(0, 140)})`);
  } finally { await rest.stop(); try { await proxy.down(); } catch { /* down */ } await killExecutor(exec); }
});
