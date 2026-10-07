/**
 * #1598 / #1628, THE UNKNOWN OUTCOME ON THE CARDS PATH: a card write that reaches the executor and APPLIES, whose ACKNOWLEDGEMENT is lost, and one that never ARRIVES. The caller sees the same dead connection both times and must be told the TRUE thing: the first has committed,
 * the second has not. Measured on #1628 (a create under a lost ack answered 500 "Failed to create card" while the card was in the store: a retry without a `requestId` doubles it). The rule the build owner stated on #1624: keep the intention, reconcile by the stored receipt, replay only an
 * ABSENT receipt with the same opId and intention. These rows pin only what a caller can SEE: the answer, and what the store holds afterwards. Same template as the other rows: REST with a REAL executor behind a proxy that, once armed, drops ONE `POST /update` (`ack`: forwarded, then the
 * connection is killed before the answer returns; `req`: killed before the executor sees it); receipt reads pass through. Every row asserts the proxy dropped exactly one write, so a row that dropped nothing fails instead of passing. Without a python with pyoxigraph the unit-on rows are SKIPPED,
 * and a skip is NOT a pass. Switch: `SCRUM_GRAPH_UNIT_CARDS`.
 * Every answer is also checked against the EXECUTOR's own store (a direct SPARQL count of the exact literal), not only the server's served list: the first version of these rows counted through the served list, and a mutant that answered 201 over an EMPTY store survived,
 * because the server's cache held what the store did not.
 *
 *   CL0  CONTROL (green today, unit off): a create is 201 and one card; an edit is 200 and the version moves by exactly one.
 *   CL1  LOST ACK, a create (unit on): 201 (it committed), never 500 or 503; exactly ONE card with that title in the store.
 *   CL2  LOST ACK, an edit (unit on): 200, the new title is there, and the version moved by exactly ONE.
 *   CL3  REQUEST NOT ARRIVED, a create (unit on): (201 and one card) or (503 and none); never 201 with none, never an error with one. If none, a later create of the same title lands once.
 *   CL4  REQUEST NOT ARRIVED, an edit (unit on): (200, new title, version +1) or (503, old title, version unchanged); never the mixed pair.
 *   CL5  STILL UNKNOWN AFTER RECONCILING (unit on): the create's ack is lost AND the receipt reads are lost, so the outcome stays undetermined and the card cache is uncertain. The create answers 201 or 503 (never a bare 500); then a request to a route that is NOT a card route
 *        (the column list) is answered 200, not dragged down by the uncertain cache; and the card list is then either 503 or exactly the executor's truth (the card once), never a short list that lacks a card the executor holds.
 *
 * NOT COVERED, by name: move, claim, delete and comment-attach under a lost ack; a write that carries a collection family as well (the combined card/collection path: its row belongs with that build); a lost ack on the second of several updates in one request; the executor restarting between write and
 * receipt; the document copy's state after a reconciled write.
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
const UNIT_ENV = 'SCRUM_GRAPH_UNIT_CARDS';
const ROSTER_FILE = path.join(os.tmpdir(), `c7k-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, gizmo: { name: 'Gizmo', glyph: 'g', color: '#c4a07c' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const ALNUM = () => `${process.pid}x${Date.now().toString(36)}`.replace(/[^a-z0-9]/gi, '').toLowerCase();

/** a proxy that, once ARMED with 'ack' or 'req', drops exactly the next `POST /update` */
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
async function unitOn(body, dsid = 'c7k-test') {
  const exec = await startExecutor({ store: tmpStore('c7k-store-'), datasetId: dsid, create: true });
  const proxy = await startProxy(exec.baseUrl);
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', [UNIT_ENV]: '1' } });
  try { return await body({ base: rest.baseUrl, rest, proxy, exec }); } finally { await rest.stop(); try { await proxy.down(); } catch { /* down */ } await killExecutor(exec); }
}
/** how many DISTINCT nodes in the executor's own store carry exactly this literal: the store, not the server's cached view of it */
async function storeN(execUrl, literal) {
  const res = await fetch(`${execUrl}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query' }, body: `SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE { { ?s ?p ?o FILTER(isLiteral(?o) && STR(?o) = ${JSON.stringify(literal)}) } UNION { GRAPH ?g { ?s ?p ?o FILTER(isLiteral(?o) && STR(?o) = ${JSON.stringify(literal)}) } } }`, signal: AbortSignal.timeout(30000) });
  assert.equal(res.status, 200, 'the store scan is answered'); return Number((await res.json()).results.bindings[0].n.value);
}
const titlesHeld = async (base, tag) => { const r = (await api(base, 'GET', '/api/cards?limit=500')).body; return (Array.isArray(r) ? r : r.cards).filter((c) => String(c.title).startsWith(tag)); };
const mk = async (base, title) => { const r = await api(base, 'POST', '/api/cards', { title, description: 'x', createdBy: 'ada' }); assert.equal(r.status, 201, `CONTROL: the card is created (${r.status} ${r.text.slice(0, 120)})`); return r.body; };
const edit = (base, id, title) => api(base, 'PATCH', `/api/cards/${id}`, { by: 'gizmo', title });
const armed = (proxy, mode) => { proxy.mode = mode; proxy.dropped = 0; };
const assertDropped = (proxy, what) => assert.equal(proxy.dropped, 1, `PRECONDITION: the proxy dropped exactly one write (${what}); a row that dropped nothing proves nothing`);

test('CL0 CONTROL: with the unit OFF a create is 201 and one card; an edit is 200 and the version moves by exactly one', { timeout: 180000 }, async () => {
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const tag = ALNUM(); const c = await mk(rest.baseUrl, `${tag} card`); assert.equal((await titlesHeld(rest.baseUrl, tag)).length, 1);
    const r = await edit(rest.baseUrl, c.id, `${tag} card edited`); assert.equal(r.status, 200, `${r.status} ${r.text.slice(0, 120)}`);
    const after = (await titlesHeld(rest.baseUrl, tag))[0]; assert.equal(after.title, `${tag} card edited`); assert.equal(after.version - c.version, 1);
  } finally { await rest.stop(); }
});

test('CL1 LOST ACK, a create: 201 (it committed) and exactly one card in the store', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, proxy, exec }) => {
    const tag = ALNUM(); armed(proxy, 'ack'); const r = await api(base, 'POST', '/api/cards', { title: `${tag} card`, description: 'x', createdBy: 'ada' }); assertDropped(proxy, 'ack lost');
    assert.equal(r.status, 201, `the create COMMITTED and only its answer was lost: 201, never an error (got ${r.status} ${r.text.slice(0, 160)}); a caller that retries without a requestId doubles the card`);
    assert.equal((await titlesHeld(base, tag)).length, 1, 'exactly one card with that title in the served list');
    assert.equal(await storeN(exec.baseUrl, `${tag} card`), 1, "and exactly one in the EXECUTOR's store (a served card the store does not hold is a cache's claim, not a commit)");
  });
});

test('CL2 LOST ACK, an edit: 200, the new title is there, the version moved by exactly one', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, proxy, exec }) => {
    const tag = ALNUM(); const c = await mk(base, `${tag} card`); armed(proxy, 'ack'); const r = await edit(base, c.id, `${tag} card edited`); assertDropped(proxy, 'ack lost');
    assert.equal(r.status, 200, `the edit COMMITTED and only its answer was lost: 200, never an error (got ${r.status} ${r.text.slice(0, 160)})`);
    const after = (await titlesHeld(base, tag)); assert.equal(after.length, 1); assert.equal(after[0].title, `${tag} card edited`, 'the new title is there'); assert.equal(after[0].version - c.version, 1, `the version moved by exactly one (from ${c.version} to ${after[0].version})`);
    assert.equal(await storeN(exec.baseUrl, `${tag} card edited`), 1, "and the EXECUTOR's store holds the new title"); assert.equal(await storeN(exec.baseUrl, `${tag} card`), 0, 'and no longer the old one');
  });
});

test('CL3 REQUEST NOT ARRIVED, a create: 201 and one card, or 503 and none; a later create lands once', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, proxy, exec }) => {
    const tag = ALNUM(); armed(proxy, 'req'); const r = await api(base, 'POST', '/api/cards', { title: `${tag} card`, description: 'x', createdBy: 'ada' }); assertDropped(proxy, 'request not arrived');
    const n = (await titlesHeld(base, tag)).length; assert.equal(await storeN(exec.baseUrl, `${tag} card`), n, `the served list (${n}) and the EXECUTOR's store must agree: a 201 over an empty store is a cache's claim`);
    assert.ok((r.status === 201 && n === 1) || (r.status === 503 && n === 0), `answer and store must agree: got ${r.status} (${r.text.slice(0, 100)}) with ${n} card(s); 201 with none says it landed when it did not, an error with one says it did not when it did`);
    if (n === 0) assert.equal((await api(base, 'POST', '/api/cards', { title: `${tag} card`, description: 'x', createdBy: 'ada' })).status, 201, 'a later create lands');
    assert.equal((await titlesHeld(base, tag)).length, 1, 'and the served list holds it exactly once'); assert.equal(await storeN(exec.baseUrl, `${tag} card`), 1, "and so does the EXECUTOR's store");
  });
});

test('CL4 REQUEST NOT ARRIVED, an edit: (200, new title, version +1) or (503, old title, version unchanged)', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, proxy, exec }) => {
    const tag = ALNUM(); const c = await mk(base, `${tag} card`); armed(proxy, 'req'); const r = await edit(base, c.id, `${tag} card edited`); assertDropped(proxy, 'request not arrived');
    const after = (await titlesHeld(base, tag))[0]; const moved = after.version - c.version; assert.equal(await storeN(exec.baseUrl, `${tag} card edited`), moved, `the served card (version moved by ${moved}) and the EXECUTOR's store must agree about the new title`);
    assert.ok((r.status === 200 && after.title === `${tag} card edited` && moved === 1) || (r.status === 503 && after.title === `${tag} card` && moved === 0), `answer and store must agree: got ${r.status} (${r.text.slice(0, 100)}), title "${after.title}", version moved by ${moved}`);
  });
});

test('CL5 STILL UNKNOWN AFTER RECONCILING: create 201 or 503, then a non-card route answers 200, and the card list is the executor\'s truth or a 503', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, proxy, exec }) => {
    const tag = ALNUM(); armed(proxy, 'ack'); proxy.dropReceipts = 1000; const r = await api(base, 'POST', '/api/cards', { title: `${tag} card`, description: 'x', createdBy: 'ada' }); proxy.dropReceipts = 0;
    assertDropped(proxy, 'ack lost'); assert.ok(proxy.receiptsDropped >= 1, `PRECONDITION: at least one receipt read was dropped (${proxy.receiptsDropped}); otherwise the outcome was never left undetermined and this row proves nothing`);
    assert.ok([201, 503].includes(r.status), `an undetermined create answers 201 or 503, never a bare error (got ${r.status} ${r.text.slice(0, 140)})`);
    const cols = await api(base, 'GET', '/api/columns'); assert.equal(cols.status, 200, `a route that is not a card route is answered while the card cache is uncertain (got ${cols.status} ${cols.text.slice(0, 140)})`);
    const list = await api(base, 'GET', '/api/cards?limit=500'); const truth = await storeN(exec.baseUrl, `${tag} card`);
    if (list.status === 200) { const held = (Array.isArray(list.body) ? list.body : list.body.cards).filter((c) => String(c.title).startsWith(tag)).length; assert.equal(held, truth, `the served card list (${held}) equals the executor's store (${truth}): never a short list`); } else assert.equal(list.status, 503, `a card list that is not served is a 503 (got ${list.status})`);
    assert.equal(truth, 1, "the create COMMITTED (only its ack and the receipt reads were lost): the executor holds the card once");
  });
});
