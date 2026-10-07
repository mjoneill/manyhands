/**
 * #1598 K3, FIFTH FILE: A FORWARD REFERENCE BECOMES AN EDGE WHEN ITS TARGET IS BORN. The builder named this as a known gap: a card whose text mentions `#N` before card N exists has no `mentionsCard` edge to it, and when card N is created the edge appears
 * today (the in-process replica re-derives it for every card) but, with cards in the executor, only when the mentioning card is next written. So `graph_query` and every "what mentions this card" read could answer a shorter set than the document-and-replica
 * pair did, for as long as the mentioning card is not touched. Written as a row so the gap is a PINNED DIFFERENCE and not prose, and so that fixing it (or deciding it is acceptable) is a decision that has a test beside it. Same template: REST with a REAL
 * executor, a unit-off server as the control, synthetic content. Without a python with pyoxigraph the unit-on rows are SKIPPED, and a skip is NOT a pass. Switch: `SCRUM_GRAPH_UNIT_CARDS`.
 *
 *   C12a  CONTROL (green today): with the unit OFF, a card created with text `see #N` before card N exists, and then card N created, answers an ASK for the edge `<A> scrum:mentionsCard <N>` through `POST /api/graph` with true, and the edge to a
 *         card that does NOT exist does not appear.
 *   C12b  THROUGH THE GRAPH (unit on): the same two creates, and the same ASK through `/api/graph` answers true; AND the EXECUTOR's own store holds the triple `<A> scrum:mentionsCard <N>` (the read that does not go through the in-process replica),
 *         without the mentioning card having been written again.
 *
 *   C13   A CLAIM AND ITS ANNOUNCEMENT SURVIVE A KILL BETWEEN THE TWO WRITES (K4: "a claim never lands without its announcement, or the reverse"). The builder described the order: the claim is sent to the executor as one update, and only when
 *         that is APPLIED are the events and the document (the announcement's outbox entry among them) written, so the window is between the two. This row CLOSES that window on purpose: a proxy forwards the claim's update to the executor and then
 *         SIGKILLs the REST server instead of answering (the server dies after the executor applied the claim and before it wrote anything else), the server is started again on the same file, and after it has had time to settle: if the card is claimed,
 *         exactly ONE announcement for that claim exists; if it is not claimed, none does. Never a claim without its announcement. (Unit on only. RED until the announcement is part of the same update, or is recoverable from the graph on restart.)
 *
 * NOT COVERED, by name: a forward reference inside a card's relationships or checks; a reference to a card that is later DELETED (the edge's removal); a post that mentions a card (its edge has a post as subject and is another kind); an edit that REMOVES the
 * mention; many cards mentioning one that is created later (one is used).
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
const ROSTER_FILE = path.join(os.tmpdir(), `c5k-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, gizmo: { name: 'Gizmo', glyph: 'g', color: '#c4a07c' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const ALNUM = () => `${process.pid}x${Date.now().toString(36)}`.replace(/[^a-z0-9]/gi, '').toLowerCase();
const ENT = 'https://scrumboard.local/entity/'; const MENTIONS = 'https://scrumboard.local/ns#mentionsCard';

async function startProxy(execUrl) {
  const p = {};
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
    try { const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }); const t = await f.text(); res.statusCode = f.status; res.end(t); } catch { try { req.socket.destroy(); } catch { /* gone */ } }
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r)); p.url = `http://127.0.0.1:${p.server.address().port}`;
  p.down = () => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); });
  return p;
}
async function unitOn(body, dsid = 'c5k-test') {
  const exec = await startExecutor({ store: tmpStore('c5k-store-'), datasetId: dsid, create: true });
  const proxy = await startProxy(exec.baseUrl);
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', [UNIT_ENV]: '1' } });
  try { return await body({ base: rest.baseUrl, rest, proxy, exec }); } finally { await rest.stop(); try { await proxy.down(); } catch { /* down */ } await killExecutor(exec); }
}
/** a proxy that forwards everything and, when `killAfterNextUpdate` is set, forwards the next `/update`, then KILLS the REST server instead of answering */
async function startKillProxy(execUrl, ctx) {
  const p = { killAfterNextUpdate: false };
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
    const doKill = req.url === '/update' && p.killAfterNextUpdate; if (doKill) p.killAfterNextUpdate = false;
    try {
      const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }); const t = await f.text();
      if (doKill) { p.killed = true; try { ctx.rest.kill('SIGKILL'); } catch { /* gone */ } req.socket.destroy(); return; }
      res.statusCode = f.status; res.end(t);
    } catch { try { req.socket.destroy(); } catch { /* gone */ } }
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r)); p.url = `http://127.0.0.1:${p.server.address().port}`;
  p.close = () => { p.server.closeAllConnections?.(); p.server.close(); };
  return p;
}
const ask = async (base, a, b) => (await api(base, 'POST', '/api/graph', { query: `ASK { <${ENT}${a}> <${MENTIONS}> <${ENT}${b}> }` })).body;
const executorAsk = async (exec, a, b) => (await (await fetch(`${exec.baseUrl}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query' }, body: `ASK { <${ENT}${a}> <${MENTIONS}> <${ENT}${b}> }` })).json()).boolean === true;
const truthy = (r) => r?.ask === true;   // the route answers {ask: true|false, ...}; nothing looser: a substring match on the body passed for the wrong reason in my first draft

async function scenario(base, tag) {
  const probe = (await api(base, 'POST', '/api/cards', { title: `${tag} probe`, description: 'x', createdBy: 'ada' })).body; const m = probe.shortId;
  const A = (await api(base, 'POST', '/api/cards', { title: `${tag} A`, description: `forward reference to #${m + 2} and to a card that never exists #99999`, createdBy: 'ada' })).body;
  const B = (await api(base, 'POST', '/api/cards', { title: `${tag} B`, description: 'the target', createdBy: 'ada' })).body;
  assert.equal(B.shortId, m + 2, `PRECONDITION: B is the card A pointed at (#${m + 2}; got #${B.shortId})`);
  return { A, B };
}

test('C12a CONTROL: with the unit OFF a forward reference becomes an edge when its target is born, and a dangling one does not', { timeout: 200000 }, async () => {
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const { A, B } = await scenario(rest.baseUrl, ALNUM());
    assert.ok(truthy(await ask(rest.baseUrl, A.id, B.id)), 'the edge A to B exists once B is born');
    const none = await api(rest.baseUrl, 'POST', '/api/graph', { query: `ASK { <${ENT}${A.id}> <${MENTIONS}> ?x . FILTER(?x != <${ENT}${B.id}>) }` });
    assert.ok(!truthy(none.body), `and A has no edge to any card but B: the unresolved #99999 is not an edge (${JSON.stringify(none.body).slice(0, 100)})`);
  } finally { await rest.stop(); }
});

test('C12b THROUGH THE GRAPH: the same, and the executor\'s own store holds the edge without the mentioning card being written again', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, exec }) => {
    const { A, B } = await scenario(base, ALNUM());
    assert.ok(truthy(await ask(base, A.id, B.id)), 'through /api/graph the edge A to B exists once B is born');
    assert.ok(await executorAsk(exec, A.id, B.id), 'and the EXECUTOR holds <A> mentionsCard <B>, though A was not written after B was created');
  });
});

test('C13 A CLAIM AND ITS ANNOUNCEMENT SURVIVE A KILL BETWEEN THE TWO WRITES: claimed implies exactly one announcement, not claimed implies none', { skip: SKIP, timeout: 400000 }, async (t) => {
  const exec = await startExecutor({ store: tmpStore('c5k-kill-'), datasetId: 'c5k-kill', create: true }); const ctx = {};
  const proxy = await startKillProxy(exec.baseUrl, ctx);
  const env = { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: 'c5k-kill', SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', [UNIT_ENV]: '1' };
  let rest2 = null;
  try {
    ctx.rest = await startRestServer({ board: makeBoardFixture(), env });
    const tag = ALNUM(); const c = (await api(ctx.rest.baseUrl, 'POST', '/api/cards', { title: `${tag} to claim`, description: 'x', createdBy: 'ada' })).body; assert.ok(c?.id, 'CONTROL: a card is created');
    const file = ctx.rest.boardFile;
    proxy.killAfterNextUpdate = true;
    await api(ctx.rest.baseUrl, 'POST', `/api/cards/${c.id}/claim`, { by: 'ada' }).catch(() => null);
    assert.ok(proxy.killed, 'THE KILL FIRED: the claim reached the executor and the server was killed before it answered (a row that never injected its fault proves nothing)');
    await sleep(500);
    const heldInGraph = (await query(exec, `SELECT ?s WHERE { ?s ?p ?o FILTER(isLiteral(?o) && CONTAINS(STR(?o), "claimedBy\\":\\"ada")) }`)).length >= 1
      || (await query(exec, `SELECT ?s WHERE { ?s ?p ?o FILTER(isLiteral(?o) && CONTAINS(STR(?o), "\\"claimedBy\\":\\"ada\\"")) }`)).length >= 1;
    rest2 = await startRestServer({ boardFile: file, env: { ...env, SCRUM_GRAPH_EXECUTOR_URL: proxy.url } });
    await sleep(6000);   // the outbox publisher and any recovery get their time
    const card = (await api(rest2.baseUrl, 'GET', `/api/cards/${c.id}`)).body;
    const posts = ((await api(rest2.baseUrl, 'GET', '/api/conversations?limit=300')).body ?? []).filter((x) => String(x.body ?? '').includes(`claimed #${card.shortId}`));
    const claimed = card.claimedBy === 'ada';
    t.diagnostic?.(`executor held the claim: ${heldInGraph}; served card claimedBy: ${card.claimedBy}; announcements: ${posts.length}`);
    if (claimed) assert.equal(posts.length, 1, `the card is claimed (the graph applied it) and there must be EXACTLY ONE announcement for it, found ${posts.length}: a claim that landed without its announcement is the window the builder described`);
    else assert.equal(posts.length, 0, `the card is not claimed, so there must be no announcement (found ${posts.length}): an announcement without its claim`);
  } finally { try { await rest2?.stop(); } catch { /* gone */ } try { await ctx.rest?.stop(); } catch { /* killed */ } proxy.close(); await killExecutor(exec); }
});
async function query(exec, sparql) { const res = await fetch(`${exec.baseUrl}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query' }, body: sparql, signal: AbortSignal.timeout(30000) }); assert.equal(res.status, 200, `the store answers a query (${res.status})`); return (await res.json()).results.bindings; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
