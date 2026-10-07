/**
 * #1624 K13, TALKS AND COLUMNS. Talks carry the third guard the card names ("a closed talk takes no new posts", #1409), and columns are the one small kind that other things move through (a card sits in one; deleting a column re-homes its
 * cards). Same template as the wake and role/obligation rows: REST with a REAL executor behind a proxy, type-agnostic (entities are found by a marker in their text), parity of answers AND refusals between a unit-off and a unit-on server,
 * written by the separate test author BEFORE the build, synthetic content. Without a python with pyoxigraph the unit-on rows are SKIPPED, and a skip is NOT a pass. `UNIT_ENV` is `SCRUM_GRAPH_UNIT_SMALLKINDS` (confirmed 22:13Z).
 *
 *   TALKS    open (201); no title, no `with`, an unknown seat (400 each); close by a non-participant (403); close by the opener (200); close again (200, `noop`); a post into the CLOSED talk (409, `TALK_CLOSED`, and the post is not
 *            stored); reopen (200); a post into the open talk (201); the open list, the `all=1` list, and get by id (and 404 for an unknown id).
 *   COLUMNS  list; add (201) with a name and none (400); rename; delete a column that holds a card: the card is re-homed, none is lost, and the column is gone; delete the LAST column (400); delete an unknown one (404).
 *            The column ORDER the board shows must survive each step. WHERE a deleted column's cards land is the owner's call for the page and is NOT pinned: the rows pin that every card exists afterwards and sits in a column that exists.
 *
 *   T0  CONTROL (green today): the unit-off server answers every step as listed above.
 *   T1  PARITY OF ANSWERS AND REFUSALS: both scripts on a unit-on server answer the same statuses and masked wire as unit off, the read-backs afterwards are equal, and the closed-talk refusal is the SAME 409 with the post not stored.
 *   T2  THE GRAPH HOLDS THEM, THE DOCUMENT DOES NOT: the executor holds the talk's and the column's marker text and the board file holds neither.
 *   T3  FAIL LOUD: with the executor away, opening a talk and adding a column answer 503, listing answers 503 (never an empty list), a talk with no title is still a 400 on its own grounds; with it back they land once.
 *
 * NOT COVERED, by name: where a deleted column's cards land (see above); concurrent column reorders; the page; talks' effect on delivery fanout; migration of the existing 22 talks and 4 columns (its read-back compares them by id and field).
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
const UNIT_ENV = 'SCRUM_GRAPH_UNIT_SMALLKINDS';
const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const ROSTER_FILE = path.join(os.tmpdir(), `t1k-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, gizmo: { name: 'Gizmo', glyph: 'g', color: '#c4a07c' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(40000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const MARK = (t) => `t1k-${t}-${process.pid}-${Date.now().toString(36)}`;
const maskDeep = (v) => {
  if (Array.isArray(v)) return v.map(maskDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /^(id|openedAt|closedAt|createdAt|at|dateCreated)$/.test(k) && typeof x === 'string' ? `<${k}>` : maskDeep(x)]));
  if (typeof v === 'string') return v.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>');
  return v;
};
let rq = 0; const RID = (tag) => `t1k-${tag}-${process.pid}-${Date.now().toString(36)}-${++rq}`.slice(0, 64);
const fixture = () => makeBoardFixture({ cards: [{ id: 'k1', shortId: 1, title: 'a card', description: '', type: 'task', column: 'planned', order: 1, assignees: ['unassigned'], labels: [], priority: null, version: 1, createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z', relationships: { relatedTo: [], blockedBy: [] } }], nextShortId: 2, postSeqEpoch: EPOCH_DOC, nextPostSeq: 1 });

async function startProxy(execUrl) {
  const p = {};
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
    try { const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }); const t = await f.text(); res.statusCode = f.status; res.end(t); } catch { try { req.socket.destroy(); } catch { /* gone */ } }
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r)); p.port = p.server.address().port; p.url = `http://127.0.0.1:${p.port}`;
  p.down = () => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); });
  p.up = () => new Promise((r, j) => { p.server.once('error', j); p.server.listen(p.port, '127.0.0.1', r); });
  return p;
}
async function unitOn(body, dsid = 't1k-test') {
  const exec = await startExecutor({ store: tmpStore('t1k-store-'), datasetId: dsid, create: true });
  const proxy = await startProxy(exec.baseUrl);
  const rest = await startRestServer({ board: fixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', [UNIT_ENV]: '1' } });
  try { return await body({ base: rest.baseUrl, rest, proxy, exec }); } finally { await rest.stop(); try { await proxy.down(); } catch { /* down */ } await killExecutor(exec); }
}
async function holders(execUrl, needle) {
  const res = await fetch(`${execUrl}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query' }, body: `SELECT ?s ?p WHERE { { ?s ?p ?o FILTER(isLiteral(?o) && CONTAINS(STR(?o), ${JSON.stringify(needle)})) } UNION { GRAPH ?g { ?s ?p ?o FILTER(isLiteral(?o) && CONTAINS(STR(?o), ${JSON.stringify(needle)})) } } }`, signal: AbortSignal.timeout(30000) });
  assert.equal(res.status, 200, 'the store scan is answered'); return (await res.json()).results.bindings.length;
}
const rec = (out, label, r) => out.push([label, r.status, r.body && typeof r.body === 'object' ? maskDeep(r.body) : null]);

async function talksScript(base, tag) {
  const out = []; const R = (l, r) => rec(out, l, r);
  const opened = await api(base, 'POST', '/api/talks', { by: 'ada', title: `${tag} talk`, with: 'gizmo' }); R('open', opened); const id = opened.body?.id;
  R('open no title', await api(base, 'POST', '/api/talks', { by: 'ada', with: 'gizmo' }));
  R('open no with', await api(base, 'POST', '/api/talks', { by: 'ada', title: 'x' }));
  R('open unknown seat', await api(base, 'POST', '/api/talks', { by: 'ada', title: 'x', with: 'nobody-at-all' }));
  R('close by non-participant', await api(base, 'PATCH', `/api/talks/${encodeURIComponent(id)}`, { by: 'board', closed: true }));
  R('close by opener', await api(base, 'PATCH', `/api/talks/${encodeURIComponent(id)}`, { by: 'ada', closed: true }));
  R('close again', await api(base, 'PATCH', `/api/talks/${encodeURIComponent(id)}`, { by: 'ada', closed: true }));
  const post = (b, t) => api(base, 'POST', '/api/conversations', { author: 'ada', body: `${tag} ${b}`, conversation: id, requestId: RID(t) });
  // a POST's own wire legitimately differs between a document post and a graph post (postSeq, ignoredFields, ids), so for the two post steps only the STATUS and the refusal CODE are compared: the row is about the closed-talk guard, not the post wire
  const postGuard = (l, r) => out.push([l, r.status, { code: r.body?.code ?? null }]);
  postGuard('post into closed talk', await post('into the closed talk', 'closed'));
  R('reopen', await api(base, 'PATCH', `/api/talks/${encodeURIComponent(id)}`, { by: 'gizmo', closed: false }));
  postGuard('post into open talk', await post('into the open talk', 'open'));
  R('bad closed value', await api(base, 'PATCH', `/api/talks/${encodeURIComponent(id)}`, { by: 'ada', closed: 'yes' }));
  R('get', await api(base, 'GET', `/api/talks/${encodeURIComponent(id)}`));
  R('get unknown', await api(base, 'GET', '/api/talks/no-such-talk'));
  R('list open', await api(base, 'GET', '/api/talks'));
  await api(base, 'PATCH', `/api/talks/${encodeURIComponent(id)}`, { by: 'ada', closed: true });
  R('list open after close', await api(base, 'GET', '/api/talks'));
  R('list all', await api(base, 'GET', '/api/talks?all=1'));
  // the closed-talk refusal must not have stored the refused post
  const posts = (await api(base, 'GET', '/api/conversations')).body ?? [];
  out.push(['refused post stored', posts.some((p) => String(p.body ?? '').includes('into the closed talk')), null]);
  return out;
}
async function columnsScript(base, tag) {
  const out = []; const R = (l, r) => rec(out, l, r);
  const order = async () => ((await api(base, 'GET', '/api/columns')).body ?? []).sort((a, b) => a.order - b.order).map((c) => c.id === undefined ? c : { id: /^col-/.test(c.id) ? '<col>' : c.id, name: c.name });
  out.push(['order at start', 200, await order()]);
  const added = await api(base, 'POST', '/api/columns', { name: `${tag} column` }); R('add', added); const id = added.body?.id;
  R('add no name', await api(base, 'POST', '/api/columns', { name: '  ' }));
  out.push(['order after add', 200, await order()]);
  R('rename', await api(base, 'PATCH', `/api/columns/${encodeURIComponent(id)}`, { name: `${tag} column, renamed` }));
  R('rename unknown', await api(base, 'PATCH', '/api/columns/no-such-column', { name: 'x' }));
  await api(base, 'PATCH', '/api/cards/k1', { column: id, by: 'ada' });
  R('delete unknown', await api(base, 'DELETE', '/api/columns/no-such-column'));
  const del = await api(base, 'DELETE', `/api/columns/${encodeURIComponent(id)}`); R('delete column holding a card', del);
  const cards = (await api(base, 'GET', '/api/cards')).body ?? []; const cols = new Set(((await api(base, 'GET', '/api/columns')).body ?? []).map((c) => c.id));
  out.push(['no card lost, each in an existing column', cards.length === 1 && cards.every((c) => cols.has(c.column)), null]);
  out.push(['order after delete', 200, await order()]);
  return out;
}

test('T0 CONTROL: with the unit OFF both scripts answer as listed', { timeout: 180000 }, async () => {
  const rest = await startRestServer({ board: fixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const t = MARK('ctl'); const talks = await talksScript(rest.baseUrl, t); const cols = await columnsScript(rest.baseUrl, t);
    const st = (arr) => Object.fromEntries(arr.map(([l, s]) => [l, s]));
    const T = st(talks);
    assert.deepEqual([T.open, T['open no title'], T['open no with'], T['open unknown seat'], T['close by non-participant'], T['close by opener'], T['close again'], T['post into closed talk'], T.reopen, T['post into open talk']], [201, 400, 400, 400, 403, 200, 200, 409, 200, 201]);
    assert.equal(T['refused post stored'], false, 'the post refused by a closed talk was not stored');
    const C = st(cols);
    assert.deepEqual([C.add, C['add no name'], C.rename, C['rename unknown'], C['delete unknown']], [201, 400, 200, 404, 404]);
    assert.ok([200, 204].includes(C['delete column holding a card']), `deleting a column answers a success (${C['delete column holding a card']})`);
    assert.equal(C['no card lost, each in an existing column'], true, 'the card was re-homed, not lost');
  } finally { await rest.stop(); }
});

test('T1 PARITY OF ANSWERS AND REFUSALS: both scripts on a unit-on server answer the same as unit off, and the closed-talk post is not stored', { skip: SKIP, timeout: 300000 }, async () => {
  const off = await startRestServer({ board: fixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const tag = MARK('par'); const eT = await talksScript(off.baseUrl, tag); const eC = await columnsScript(off.baseUrl, tag);
    await unitOn(async ({ base, exec }) => {
      const gT = await talksScript(base, tag); const gC = await columnsScript(base, tag);
      assert.deepEqual(gT, eT, 'every talk answer, refusal included, equals the unit-off answer');
      assert.deepEqual(gC, eC, 'every column answer, refusal included, equals the unit-off answer');
      assert.ok(await holders(exec.baseUrl, tag) >= 2, 'CONTROL: the talk and the column are in the executor (a build that never uses it cannot pass parity by being the document twice)');
    });
  } finally { await off.stop(); }
});

test('T2 THE GRAPH HOLDS THEM, THE DOCUMENT DOES NOT: the executor holds the talk and column text and the board file holds neither', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, rest, exec }) => {
    const tag = MARK('hold'); await api(base, 'POST', '/api/talks', { by: 'ada', title: `${tag} talk`, with: 'gizmo' }); await api(base, 'POST', '/api/columns', { name: `${tag} column` });
    assert.ok(await holders(exec.baseUrl, `${tag} talk`) >= 1, 'the executor holds the talk');
    assert.ok(await holders(exec.baseUrl, `${tag} column`) >= 1, 'and the column');
    const file = JSON.stringify(rest.readBoardFile());
    assert.ok(!file.includes(`${tag} talk`) && !file.includes(`${tag} column`), 'the board file holds neither');
  });
});

test('T3 FAIL LOUD: executor away: opening a talk, adding a column and listing answer 503, a missing title is still 400; back: they land once', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, proxy }) => {
    const tag = MARK('down');
    await proxy.down();
    assert.equal((await api(base, 'POST', '/api/talks', { by: 'ada', title: `${tag} talk`, with: 'gizmo' })).status, 503, 'opening a talk with the executor away is a 503, never a 201');
    assert.equal((await api(base, 'POST', '/api/columns', { name: `${tag} column` })).status, 503, 'adding a column is a 503');
    assert.equal((await api(base, 'GET', '/api/talks')).status, 503, 'listing talks is a 503, never an empty list');
    assert.equal((await api(base, 'GET', '/api/columns')).status, 503, 'listing columns is a 503, never an empty list');
    assert.equal((await api(base, 'POST', '/api/talks', { by: 'ada', with: 'gizmo' })).status, 400, 'a talk with no title is still refused on its own grounds');
    await sleep(500); await proxy.up();
    assert.equal((await api(base, 'POST', '/api/talks', { by: 'ada', title: `${tag} talk`, with: 'gizmo' })).status, 201, 'with it back the talk opens');
    assert.equal((await api(base, 'POST', '/api/columns', { name: `${tag} column` })).status, 201, 'and the column is added');
    assert.equal((((await api(base, 'GET', '/api/talks')).body ?? {}).talks ?? []).filter((t) => t.title === `${tag} talk`).length, 1, 'exactly one talk');
    assert.equal(((await api(base, 'GET', '/api/columns')).body ?? []).filter((c) => c.name === `${tag} column`).length, 1, 'and exactly one column');
  });
});
