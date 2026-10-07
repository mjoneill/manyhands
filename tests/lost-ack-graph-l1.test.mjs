/**
 * #1624 K13, THE UNKNOWN OUTCOME: a write that reaches the executor and APPLIES, whose ACKNOWLEDGEMENT is lost, and a write that never ARRIVES. They look the same to the caller (the connection dies), and the two honest answers are different: the first has committed, the second has not.
 * What the caller may never be told is the wrong one. Two harms, both silent: answering 503 ("it did not happen") for a write that did, so the caller retries and DOUBLES it or gives up on something that exists; and answering 201 for a write that never landed.
 * The rule the build owner stated on #1624: retain the intention, reconcile by the stored receipt (`GET /receipt/<opId>`), and replay only an ABSENT receipt with the SAME opId and intention. These rows pin only what the caller can SEE: the answer and what is in the store afterwards.
 * Same template as the other K13 rows: REST with a REAL executor behind a proxy that, once armed, drops ONE write: `ack` forwards `POST /update` to the executor and then kills the connection before the answer reaches the server; `req` kills it before the executor sees it. Every other request (including the receipt read) passes through.
 * Two writes with different guards: a model key (one identity, a twin is a 409) and a procedure revision (the version number). Without a python with pyoxigraph the unit-on rows are SKIPPED, and a skip is NOT a pass. Switch: `SCRUM_GRAPH_UNIT_SMALLKINDS`.
 *
 *   L0  CONTROL (green today, unit off): a model create is 201 and one model; a procedure revision is 201 and exactly one new version.
 *   L1  LOST ACK, a model create (unit on): the answer is 201 (reconciled: it committed), never 503; the store holds exactly ONE model with that key; creating it again is a 409 (it exists), not a second node.
 *   L2  LOST ACK, a procedure revision (unit on): 201, and exactly one new version (v2), never v2 and v3; a following revision is v3.
 *   L3  REQUEST NOT ARRIVED, a model create (unit on): either 201 with ONE model (replayed) or 503 with NO model; never 201 with none and never 503 with one. And a later create of the same key lands (201), once.
 *   L4  REQUEST NOT ARRIVED, a procedure revision (unit on): either 201 and exactly one new version, or 503 and none; and the next revision then gets the next number with no gap and no duplicate.
 *
 * NOT COVERED, by name: a lost ack on a write that carries CARDS (the card rows' territory); a lost ack on the SECOND of several updates in one request; the executor restarting between write and receipt; a lost ack on a write that is then raced by a second request for the same key; the other families (the same helper arms any of them: only these two are asserted).
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
const ROSTER_FILE = path.join(os.tmpdir(), `l1k-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, gizmo: { name: 'Gizmo', glyph: 'g', color: '#c4a07c' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const ALNUM = () => `${process.pid}x${Date.now().toString(36)}`.replace(/[^a-z0-9]/gi, '').toLowerCase();

/** a proxy that, once ARMED with 'ack' or 'req', drops exactly the next `POST /update` */
async function startProxy(execUrl) {
  const p = { mode: null, dropped: 0 };
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
    const isUpdate = req.method === 'POST' && req.url.split('?')[0] === '/update';
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
async function unitOn(body, dsid = 'l1k-test') {
  const exec = await startExecutor({ store: tmpStore('l1k-store-'), datasetId: dsid, create: true });
  const proxy = await startProxy(exec.baseUrl);
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', [UNIT_ENV]: '1' } });
  try { return await body({ base: rest.baseUrl, rest, proxy, exec }); } finally { await rest.stop(); try { await proxy.down(); } catch { /* down */ } await killExecutor(exec); }
}
const modelCount = async (base, key) => ((await api(base, 'GET', `/api/models?key=${key}`)).body ?? []).length;
const versionsOf = async (base, procId) => ((await api(base, 'GET', '/api/procedures')).body ?? []).find((p) => p.id === procId)?.versions ?? [];
const newModel = (key, tag) => ({ by: 'ada', key, model: `${tag}-model:1b`, protocol: 'ollama-native' });
const mkProc = async (base, tag) => { const r = await api(base, 'POST', '/api/procedures', { by: 'ada', name: `${tag} method`, body: `${tag} v1 text` }); assert.equal(r.status, 201, `CONTROL: the procedure is created (${r.status} ${r.text.slice(0, 120)})`); return r.body.id; };
const revise = (base, id, tag, n) => api(base, 'POST', '/api/procedure-versions', { by: 'ada', procedure: id, body: `${tag} revision ${n}` });
const armed = (proxy, mode) => { proxy.mode = mode; proxy.dropped = 0; };
const assertDropped = (proxy, what) => assert.equal(proxy.dropped, 1, `PRECONDITION: the proxy dropped exactly one write (${what}); a row that dropped nothing proves nothing`);

test('L0 CONTROL: with the unit OFF a model create is 201 and one model; a procedure revision is 201 and exactly one new version', { timeout: 180000 }, async () => {
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const tag = ALNUM(); const key = `l1-${tag}`; const m = await api(rest.baseUrl, 'POST', '/api/models', newModel(key, tag)); assert.equal(m.status, 201, `${m.status} ${m.text.slice(0, 120)}`); assert.equal(await modelCount(rest.baseUrl, key), 1);
    assert.equal((await api(rest.baseUrl, 'POST', '/api/models', newModel(key, tag))).status, 409, 'a twin is a 409');
    const id = await mkProc(rest.baseUrl, tag); const before = (await versionsOf(rest.baseUrl, id)).length; const r = await revise(rest.baseUrl, id, tag, 2);
    assert.equal(r.status, 201, `${r.status} ${r.text.slice(0, 120)}`); assert.equal((await versionsOf(rest.baseUrl, id)).length, before + 1, 'exactly one new version');
  } finally { await rest.stop(); }
});

test('L1 LOST ACK, a model create: 201 (it committed), exactly one model, and creating it again is a 409', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, proxy }) => {
    const tag = ALNUM(); const key = `l1-${tag}`; armed(proxy, 'ack'); const r = await api(base, 'POST', '/api/models', newModel(key, tag)); assertDropped(proxy, 'ack lost');
    assert.equal(r.status, 201, `the write COMMITTED and only its answer was lost: the caller is told 201, never 503 (got ${r.status} ${r.text.slice(0, 160)})`);
    assert.equal(await modelCount(base, key), 1, 'exactly one model with that key in the store');
    const again = await api(base, 'POST', '/api/models', newModel(key, tag)); assert.equal(again.status, 409, `creating it again is refused as a twin, not a second node (${again.status})`); assert.equal(await modelCount(base, key), 1, 'still one');
  });
});

test('L2 LOST ACK, a procedure revision: 201 and exactly one new version, never v2 and v3; the next revision is the next number', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, proxy }) => {
    const tag = ALNUM(); const id = await mkProc(base, tag); const before = (await versionsOf(base, id)).length; armed(proxy, 'ack'); const r = await revise(base, id, tag, 2); assertDropped(proxy, 'ack lost');
    assert.equal(r.status, 201, `the revision COMMITTED and only its answer was lost: 201, never 503 (got ${r.status} ${r.text.slice(0, 160)})`);
    const after = await versionsOf(base, id); assert.equal(after.length, before + 1, `exactly one new version (${before} before, ${after.length} after): a duplicate re-attributes every past run that names a version`);
    assert.equal(after.filter((v) => String(v.body).startsWith(`${tag} revision 2`)).length, 1, 'and that revision text is held once');
    const next = await revise(base, id, tag, 3); assert.equal(next.status, 201); assert.equal((await versionsOf(base, id)).length, before + 2, 'the next revision is the next number, with no gap');
  });
});

test('L3 REQUEST NOT ARRIVED, a model create: 201 with ONE model or 503 with NONE, never the mixed pair; a later create lands once', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, proxy }) => {
    const tag = ALNUM(); const key = `l1-${tag}`; armed(proxy, 'req'); const r = await api(base, 'POST', '/api/models', newModel(key, tag)); assertDropped(proxy, 'request not arrived');
    const n = await modelCount(base, key);
    assert.ok((r.status === 201 && n === 1) || (r.status === 503 && n === 0), `answer and store must agree: got ${r.status} with ${n} model(s); 201 with none says it landed when it did not, 503 with one says it did not when it did`);
    if (n === 0) { const later = await api(base, 'POST', '/api/models', newModel(key, tag)); assert.equal(later.status, 201, `a later create of the same key lands (${later.status} ${later.text.slice(0, 120)})`); }
    assert.equal(await modelCount(base, key), 1, 'and the store holds it exactly once');
  });
});

test('L4 REQUEST NOT ARRIVED, a procedure revision: 201 and one new version, or 503 and none; the next revision has the next number, no gap and no duplicate', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, proxy }) => {
    const tag = ALNUM(); const id = await mkProc(base, tag); const before = (await versionsOf(base, id)).length; armed(proxy, 'req'); const r = await revise(base, id, tag, 2); assertDropped(proxy, 'request not arrived');
    const n = (await versionsOf(base, id)).length - before;
    assert.ok((r.status === 201 && n === 1) || (r.status === 503 && n === 0), `answer and store must agree: got ${r.status} with ${n} new version(s)`);
    const next = await revise(base, id, tag, 3); assert.equal(next.status, 201, `${next.status} ${next.text.slice(0, 120)}`);
    const vs = await versionsOf(base, id); assert.equal(vs.length, before + n + 1, `the next revision adds exactly one more (${before} before, ${vs.length} after)`);
    assert.equal(new Set(vs.map((v) => v.name)).size, vs.length, 'and no two versions share a number');
  });
});
