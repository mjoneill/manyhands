/**
 * #1624 K13, ROLES AND OBLIGATIONS: the two small kinds whose guards the card says must stay INSIDE the same update ("generic storage must not become generic mutation authority"). Same template as the wake rows
 * (`wake-graph-w1.test.mjs`): REST with a REAL executor behind a proxy, type-agnostic (the entity is found by a marker in its text), written by the separate test author BEFORE the build, synthetic content. Without a python with
 * pyoxigraph the unit-on rows are SKIPPED, and a skip is NOT a pass. `UNIT_ENV` is a GUESS (`SCRUM_GRAPH_UNIT_SMALLKINDS`); the card does not name the switch.
 *
 * The guards are pinned by PARITY OF REFUSALS: one script of operations, the legal ones AND the refused ones, goes to a unit-off server and a unit-on server; every status and every refusal's wire must be the same, and the list read back
 * after the refusals must be the same (a refused write changed nothing). A guard that the generic primitive let through would show as a 201 where the document path answered 409/400, or as a changed list.
 *
 *   ROLES      create (201); a TWIN of the same key (409); a malformed key, a definition under 40 characters, no `definedBy`, a `definedBy` that names no card (all 400); revise the name (200, version 2); revise with a different `key`
 *              (400: the key is the identity); revise with an unknown `definedBy` (400); revise an unknown role (404); list.
 *   OBLIGATIONS  create (201); an `about` that resolves to nothing (400); a bad kind (400); close as discharged (200); close AGAIN as lapsed (200, and the FIRST closure stands: a closed obligation never reopens or changes); a bad status (400,
 *              "does not reopen"); close an unknown obligation (404); list with the owedBy, status, about and kind filters.
 *
 *   R0  CONTROL (green today): the unit-off server answers every step of both scripts as listed above.
 *   R1  PARITY OF ANSWERS AND REFUSALS: the same two scripts on a unit-on server answer the same statuses and the same masked wire, and the lists read back afterwards are equal.
 *   R2  THE GRAPH HOLDS THEM, THE DOCUMENT DOES NOT: after the scripts, the executor's store holds the role's and the obligation's marker text, and the board file holds neither.
 *   R3  THE GUARDS HOLD WITH THE EXECUTOR AWAY, AND FAIL LOUD: with the executor unreachable, creating a role and creating an obligation answer 503 (never 201), listing answers 503 (never an empty list), and an UNGUARDED refusal still
 *       refuses on its own grounds where it can (a malformed key is still 400); with it back, the same creates land once.
 *
 * NOT COVERED, by name: a card deleted between the role's `definedBy` check and its write (a race; the guard "inside the same update" is what makes it safe, and a race row would be timing-based); role versions read through any route
 * other than the list (the wire carries `version` and `versions`, which the parity compares); obligations whose `about` is a memory, decision or predicate (only a card is used here); the seat-declaration edge a role grant makes;
 * migration of the existing 2 roles and 3 obligations (its read-back compares them by id and field).
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
const ROSTER_FILE = path.join(os.tmpdir(), `r1k-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, gizmo: { name: 'Gizmo', glyph: 'g', color: '#c4a07c' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(40000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const MARK = (t) => `r1k-${t}-${process.pid}-${Date.now().toString(36)}`;
/** mask what legitimately differs between servers: ids, times, the id inside a nested object, and an obligation's `about` (the defining card's uuid, random per server: the first run found that on main, where both servers are the document and parity must hold trivially) */
const maskDeep = (v) => {
  if (Array.isArray(v)) return v.map(maskDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /^(id|about|createdAt|at|dischargedAt|dateCreated|dateModified)$/.test(k) && typeof x === 'string' ? `<${k}>` : maskDeep(x)]));
  return v;
};
const DEFN = (m) => `${m} is a role used only by these rows and it commits a seat to nothing in particular at all`;   // >= 40 characters

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
async function unitOn(body, dsid = 'r1k-test') {
  const exec = await startExecutor({ store: tmpStore('r1k-store-'), datasetId: dsid, create: true });
  const proxy = await startProxy(exec.baseUrl);
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', [UNIT_ENV]: '1' } });
  try { return await body({ base: rest.baseUrl, rest, proxy, exec }); } finally { await rest.stop(); try { await proxy.down(); } catch { /* down */ } await killExecutor(exec); }
}
async function holders(execUrl, needle) {
  const res = await fetch(`${execUrl}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query' }, body: `SELECT ?s ?p WHERE { { ?s ?p ?o FILTER(isLiteral(?o) && CONTAINS(STR(?o), ${JSON.stringify(needle)})) } UNION { GRAPH ?g { ?s ?p ?o FILTER(isLiteral(?o) && CONTAINS(STR(?o), ${JSON.stringify(needle)})) } } }`, signal: AbortSignal.timeout(30000) });
  assert.equal(res.status, 200, 'the store scan is answered'); return (await res.json()).results.bindings.length;
}

/** the roles script: legal and refused operations, in order; every answer recorded with ids and times masked */
async function rolesScript(base, tag) {
  const out = []; const rec = (label, r) => out.push([label, r.status, r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? maskDeep(r.body) : Array.isArray(r.body) ? maskDeep(r.body) : null]);
  const card = (await api(base, 'POST', '/api/cards', { title: `${tag} the defining card`, description: 'x', createdBy: 'ada' })).body;
  const key = `r1k-${tag.slice(-6).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
  const good = { by: 'ada', key, name: `${tag} role`, definition: DEFN(tag), definedBy: card.shortId };
  rec('create', await api(base, 'POST', '/api/roles', good));
  rec('create twin', await api(base, 'POST', '/api/roles', { ...good, name: 'a twin' }));
  rec('create bad key', await api(base, 'POST', '/api/roles', { ...good, key: 'Not A Slug!' }));
  rec('create short definition', await api(base, 'POST', '/api/roles', { ...good, key: `${key}b`, definition: 'too short' }));
  rec('create no definedBy', await api(base, 'POST', '/api/roles', { by: 'ada', key: `${key}c`, name: 'n', definition: DEFN(tag) }));
  rec('create unknown definedBy', await api(base, 'POST', '/api/roles', { ...good, key: `${key}d`, definedBy: 99999 }));
  rec('revise key change', await api(base, 'PATCH', `/api/roles/${key}`, { by: 'ada', key: 'other-key', name: 'x' }));
  rec('revise unknown definedBy', await api(base, 'PATCH', `/api/roles/${key}`, { by: 'ada', definedBy: 99999 }));
  rec('revise unknown role', await api(base, 'PATCH', '/api/roles/no-such-role', { by: 'ada', name: 'x' }));
  rec('revise name', await api(base, 'PATCH', `/api/roles/${key}`, { by: 'ada', name: `${tag} role, renamed` }));
  rec('list', await api(base, 'GET', '/api/roles'));
  return out;
}
/** the obligations script */
async function obligationsScript(base, tag) {
  const out = []; const rec = (label, r) => out.push([label, r.status, r.body && typeof r.body === 'object' ? maskDeep(r.body) : null]);
  const card = (await api(base, 'POST', '/api/cards', { title: `${tag} what is owed about`, description: 'x', createdBy: 'ada' })).body;
  const created = await api(base, 'POST', '/api/obligations', { by: 'ada', owedBy: 'gizmo', kind: 'promise', about: card.shortId, note: `${tag} owed` });
  rec('create', created); const id = created.body?.id;
  rec('create unresolved about', await api(base, 'POST', '/api/obligations', { by: 'ada', owedBy: 'gizmo', kind: 'promise', about: 'no-such-node' }));
  rec('create bad kind', await api(base, 'POST', '/api/obligations', { by: 'ada', owedBy: 'gizmo', kind: 'wish', about: card.shortId }));
  rec('close discharged', await api(base, 'PATCH', `/api/obligations/${encodeURIComponent(id)}`, { by: 'gizmo', status: 'discharged', note: `${tag} done` }));
  rec('close again as lapsed', await api(base, 'PATCH', `/api/obligations/${encodeURIComponent(id)}`, { by: 'ada', status: 'lapsed', note: 'second closure must not stand' }));
  rec('bad status', await api(base, 'PATCH', `/api/obligations/${encodeURIComponent(id)}`, { by: 'ada', status: 'open' }));
  rec('close unknown', await api(base, 'PATCH', `/api/obligations/${encodeURIComponent('https://scrumboard.local/obligation/none')}`, { by: 'ada', status: 'discharged' }));
  rec('list', await api(base, 'GET', '/api/obligations'));
  rec('list owedBy', await api(base, 'GET', '/api/obligations?owedBy=gizmo'));
  rec('list status=open', await api(base, 'GET', '/api/obligations?status=open'));
  rec('list kind=promise', await api(base, 'GET', '/api/obligations?kind=promise'));
  return out;
}

test('R0 CONTROL: with the unit OFF both scripts answer as listed: twin 409, bad inputs 400, unknown 404, the first closure stands', { timeout: 180000 }, async () => {
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const t = MARK('ctl'); const roles = await rolesScript(rest.baseUrl, t); const ob = await obligationsScript(rest.baseUrl, t);
    const st = (arr) => Object.fromEntries(arr.map(([l, s]) => [l, s]));
    assert.deepEqual(st(roles), { create: 201, 'create twin': 409, 'create bad key': 400, 'create short definition': 400, 'create no definedBy': 400, 'create unknown definedBy': 400, 'revise key change': 400, 'revise unknown definedBy': 400, 'revise unknown role': 404, 'revise name': 200, list: 200 });
    assert.deepEqual(st(ob), { create: 201, 'create unresolved about': 400, 'create bad kind': 400, 'close discharged': 200, 'close again as lapsed': 200, 'bad status': 400, 'close unknown': 404, list: 200, 'list owedBy': 200, 'list status=open': 200, 'list kind=promise': 200 });
    const again = ob.find(([l]) => l === 'close again as lapsed')[2];
    assert.equal(again.status, 'discharged', 'the FIRST closure stands: a second closure does not turn it into lapsed');
    assert.equal(ob.find(([l]) => l === 'list status=open')[2].length, 0, 'and nothing is open');
  } finally { await rest.stop(); }
});

test('R1 PARITY OF ANSWERS AND REFUSALS: both scripts on a unit-on server answer the same statuses and wire as the unit-off server, and the lists afterwards are equal', { skip: SKIP, timeout: 300000 }, async () => {
  const off = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const tag = MARK('par'); const eR = await rolesScript(off.baseUrl, tag); const eO = await obligationsScript(off.baseUrl, tag);
    await unitOn(async ({ base, exec }) => {
      const gR = await rolesScript(base, tag); const gO = await obligationsScript(base, tag);
      assert.deepEqual(gR, eR, 'every role answer, refusal included, equals the unit-off answer');
      assert.deepEqual(gO, eO, 'every obligation answer, refusal included, equals the unit-off answer');
      assert.ok(await holders(exec.baseUrl, tag) >= 2, 'CONTROL: the role and the obligation are in the executor (a build that never uses it cannot pass parity by being the document twice)');
    });
  } finally { await off.stop(); }
});

test('R2 THE GRAPH HOLDS THEM, THE DOCUMENT DOES NOT: the executor holds the role and the obligation text, the board file holds neither', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, rest, exec }) => {
    const tag = MARK('hold'); await rolesScript(base, tag); await obligationsScript(base, tag);
    assert.ok(await holders(exec.baseUrl, `${tag} role`) >= 1, 'the executor holds the role');
    assert.ok(await holders(exec.baseUrl, `${tag} owed`) >= 1, 'and the obligation');
    const file = JSON.stringify(rest.readBoardFile());
    assert.ok(!file.includes(`${tag} role`) && !file.includes(`${tag} owed`), 'the board file holds neither');
  });
});

test('R3 THE GUARDS HOLD WITH THE EXECUTOR AWAY, AND IT FAILS LOUD: creates and lists answer 503, a malformed key is still a 400, and with it back the creates land once', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, proxy }) => {
    const tag = MARK('down'); const card = (await api(base, 'POST', '/api/cards', { title: `${tag} card`, description: 'x', createdBy: 'ada' })).body;
    const key = `r1k-d${Date.now().toString(36).slice(-5)}`;
    const role = { by: 'ada', key, name: `${tag} role`, definition: DEFN(tag), definedBy: card.shortId };
    const ob = { by: 'ada', owedBy: 'gizmo', kind: 'promise', about: card.shortId, note: `${tag} owed` };
    await proxy.down();
    assert.equal((await api(base, 'POST', '/api/roles', role)).status, 503, 'a role create with the executor away is a 503, never a 201');
    assert.equal((await api(base, 'POST', '/api/obligations', ob)).status, 503, 'an obligation create is a 503');
    assert.equal((await api(base, 'GET', '/api/roles')).status, 503, 'a role list is a 503, never an empty list');
    assert.equal((await api(base, 'GET', '/api/obligations')).status, 503, 'an obligation list is a 503');
    assert.equal((await api(base, 'POST', '/api/roles', { ...role, key: 'Not A Slug!' })).status, 400, 'a malformed key is still refused on its own grounds');
    await sleep(500); await proxy.up();
    assert.equal((await api(base, 'POST', '/api/roles', role)).status, 201, 'with it back the role is created');
    assert.equal((await api(base, 'POST', '/api/obligations', ob)).status, 201, 'and the obligation');
    assert.equal(((await api(base, 'GET', '/api/roles')).body ?? []).filter((r) => r.key === key).length, 1, 'exactly one role with that key');
    assert.equal(((await api(base, 'GET', '/api/obligations')).body ?? []).filter((o) => String(o.note ?? '').includes(`${tag} owed`)).length, 1, 'and exactly one obligation');
  });
});
