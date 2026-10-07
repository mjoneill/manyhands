/**
 * #1624 K13, THE THIN SLICE: WAKES. Wakes are the smallest of the small kinds (append-only, no guard beyond `by`, one create route and one list route), so they are the first family through the one storage primitive. These rows are
 * the template the other families will copy: each family gets the same four questions, asked through REST with a REAL executor behind a proxy, type-agnostic (they find the entity by a marker in its text, so they do not depend on which
 * rdf:type or predicate names the build chooses). Written by the separate test author BEFORE the build. Synthetic content. Without a python with pyoxigraph the unit-on rows are SKIPPED, and a skip is NOT a pass.
 *
 * THE SWITCH: the card says "one switch" and does not name it. `UNIT_ENV` below is a GUESS (`SCRUM_GRAPH_UNIT_SMALLKINDS=1`, by the family of the other unit flags); change that one constant if the build names another. The rows also
 * set the conversations unit on, as every unit since #1574 requires the graph slice.
 *
 *   W0  CONTROL (green today): with the unit OFF a wake is created (201, wire `{id, seat, at, note}`), listed newest first, and filtered by seat and limit.
 *   W1  PARITY: the same operations on a unit-off server and a unit-on server answer the same statuses and the same wire (ids and timestamps masked), and the same list order, filter and limit.
 *   W2  THE GRAPH HOLDS IT AND THE DOCUMENT DOES NOT: with the unit on, after a wake is created the executor's store holds the marker text and the board FILE does not.
 *   W3  READS AND WRITES FAIL LOUD: with the executor unreachable, creating a wake answers 503 and listing answers 503 (never a 201, never an empty list); with it back, a new wake is created and the list shows it AND the earlier ones.
 *
 * NOT COVERED, by name: the document's copies of wakes that existed before the switch (migration is a separate step: its read-back compares them by id and field); concurrency (wakes are append-only and unguarded); the MCP `seat_wake`/wake
 * tools above REST; the ordering of two wakes in the same millisecond.
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
const ROSTER_FILE = path.join(os.tmpdir(), `w1-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, gizmo: { name: 'Gizmo', glyph: 'g', color: '#c4a07c' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(40000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const MARK = (t) => `w1-${t}-${process.pid}-${Date.now().toString(36)}`;
const wake = (base, by, note) => api(base, 'POST', '/api/wakes', { by, note });
const listWakes = (base, q = '') => api(base, 'GET', `/api/wakes${q}`);
/** mask what legitimately differs between two servers: ids and times */
const mask = (w) => ({ ...w, id: w.id ? '<id>' : w.id, at: w.at ? '<at>' : w.at });

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
async function unitOn(body, dsid = 'w1-test') {
  const exec = await startExecutor({ store: tmpStore('w1-store-'), datasetId: dsid, create: true });
  const proxy = await startProxy(exec.baseUrl);
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', [UNIT_ENV]: '1' } });
  try { return await body({ base: rest.baseUrl, rest, proxy, exec }); } finally { await rest.stop(); try { await proxy.down(); } catch { /* down */ } await killExecutor(exec); }
}
async function holders(execUrl, needle) {
  const res = await fetch(`${execUrl}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query' }, body: `SELECT ?s ?p WHERE { { ?s ?p ?o FILTER(isLiteral(?o) && CONTAINS(STR(?o), ${JSON.stringify(needle)})) } UNION { GRAPH ?g { ?s ?p ?o FILTER(isLiteral(?o) && CONTAINS(STR(?o), ${JSON.stringify(needle)})) } } }`, signal: AbortSignal.timeout(30000) });
  assert.equal(res.status, 200, 'the store scan is answered'); return (await res.json()).results.bindings.length;
}
/** the operations every server is put through, in order; returns what each answered */
async function script(base, tag) {
  const out = [];
  const a = await wake(base, 'ada', `${tag} first`); out.push(['create ada', a.status, a.body && mask(a.body)]);
  await sleep(15);
  const b = await wake(base, 'gizmo', `${tag} second`); out.push(['create gizmo', b.status, b.body && mask(b.body)]);
  await sleep(15);
  const c = await wake(base, 'ada', `${tag} third`); out.push(['create ada again', c.status, c.body && mask(c.body)]);
  const nobody = await api(base, 'POST', '/api/wakes', { note: 'no seat' }); out.push(['create without by', nobody.status, nobody.body && Object.keys(nobody.body)]);
  const all = await listWakes(base); out.push(['list', all.status, (all.body ?? []).map((w) => `${w.seat}:${w.note}`)]);
  const ada = await listWakes(base, '?seat=ada'); out.push(['list seat=ada', ada.status, (ada.body ?? []).map((w) => `${w.seat}:${w.note}`)]);
  const two = await listWakes(base, '?limit=2'); out.push(['list limit=2', two.status, (two.body ?? []).map((w) => `${w.seat}:${w.note}`)]);
  return out;
}

test('W0 CONTROL: with the unit OFF a wake is created, listed newest first, and filtered by seat and limit', { timeout: 120000 }, async () => {
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const t = MARK('ctl'); const r = await script(rest.baseUrl, t);
    assert.equal(r[0][1], 201); assert.deepEqual(Object.keys(r[0][2]).sort(), ['at', 'id', 'note', 'seat']);
    assert.equal(r[3][1], 400, 'a wake without `by` is refused');
    assert.deepEqual(r[4][2], [`ada:${t} third`, `gizmo:${t} second`, `ada:${t} first`], 'newest first');
    assert.deepEqual(r[5][2], [`ada:${t} third`, `ada:${t} first`], 'the seat filter');
    assert.deepEqual(r[6][2], [`ada:${t} third`, `gizmo:${t} second`], 'the limit');
  } finally { await rest.stop(); }
});

test('W1 PARITY: the same operations on a unit-off and a unit-on server answer the same statuses and wire (ids and times masked)', { skip: SKIP, timeout: 240000 }, async () => {
  const off = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const tag = MARK('par'); const expected = await script(off.baseUrl, tag);
    await unitOn(async ({ base, exec }) => {
      const got = await script(base, tag);
      assert.deepEqual(got, expected, 'every answer equals the unit-off answer');
      assert.ok(await holders(exec.baseUrl, tag) >= 3, 'CONTROL: the three wakes are in the executor (a build that never uses it cannot pass parity by being the document twice)');
    });
  } finally { await off.stop(); }
});

test('W2 THE GRAPH HOLDS IT AND THE DOCUMENT DOES NOT: after a wake the executor holds the marker and the board file does not', { skip: SKIP, timeout: 240000 }, async () => {
  await unitOn(async ({ base, rest, exec }) => {
    const m = MARK('hold'); assert.equal((await wake(base, 'ada', m)).status, 201);
    assert.ok(await holders(exec.baseUrl, m) >= 1, 'the executor store holds the wake text');
    assert.ok(!JSON.stringify(rest.readBoardFile()).includes(m), 'and the board file does not');
  });
});

test('W3 READS AND WRITES FAIL LOUD: executor away: create 503 and list 503; back: a new wake is created and the list shows it and the earlier ones', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, proxy }) => {
    const m = MARK('down');
    assert.equal((await wake(base, 'ada', `${m} before`)).status, 201, 'CONTROL: a wake is created while the executor is up');
    await proxy.down();
    const w = await wake(base, 'ada', `${m} during`); assert.equal(w.status, 503, `a create with the executor away is a 503, never a 201 (${w.status} ${w.text.slice(0, 120)})`);
    const l = await listWakes(base); assert.equal(l.status, 503, `a list with the executor away is a 503, never an empty list (${l.status} ${l.text.slice(0, 120)})`);
    await sleep(500); await proxy.up();
    assert.equal((await wake(base, 'ada', `${m} after`)).status, 201, 'with it back a new wake is created');
    const notes = ((await listWakes(base)).body ?? []).map((x) => x.note);
    assert.ok(notes.includes(`${m} before`) && notes.includes(`${m} after`), `and the list shows the earlier and the later ones (${JSON.stringify(notes)})`);
    assert.ok(!notes.includes(`${m} during`), 'but not the one refused while the executor was away');
  });
});
