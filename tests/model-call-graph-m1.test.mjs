/**
 * #1582 (unit 3), THE MODEL-CALL HALF, KEPT TO THE SIX POINTS THE ROOM AGREED AT 19:44Z (the owner's "stop spiralling": no repricing/midnight matrix, no request digest, no server-side clock, no local-ledger
 * scrub, no /api/changes bucket move, no per-entry batch receipts). The six: (1) model calls leave the document; (3) a retry does not duplicate: a caller-held `requestId`, one row and one charge; (4) readers fail
 * LOUD, not empty: with the executor away the budget read is a 503, never "0 spent"; (5) the old document collections are gone from `/api/board`; (6) the `postedText` redaction guard: a redacted post's text does not
 * survive in the model-call row that quoted it, including a call recorded AFTER the redaction; plus the boot refusal (C7'): `SCRUM_GRAPH_UNIT_DELIVERIES=1` without `SCRUM_GRAPH_UNIT_CONVERSATIONS=1` refuses to start.
 * (2), the guarded claim, is the delivery file's. Written by the separate test author BEFORE the build, black-box through REST with a REAL executor behind a proxy. Synthetic content. Without a python with pyoxigraph
 * the unit-on rows are SKIPPED, and a skip is NOT a pass.
 *
 *   M0  CONTROL (green today): with the unit OFF a model call needs no requestId: POST answers 201 and the row reads back with its cost counted in `spent`; and `/api/board` carries `modelCalls`.
 *   M1  requestId IS REQUIRED AND CHECKED (unit on): none -> 400 `REQUEST_ID_REQUIRED`; 7 characters, 65, an illegal character -> 400; an agent with a space, a `>` or a non-ASCII letter -> 400 (the opId carries
 *       no raw caller text, so it cannot become a non-IRI: #1622); none of them is recorded; a valid one answers 201.
 *   M2  A RETRY IS ONE ROW AND ONE CHARGE: the same call (same requestId and payload) sent twice in a row, and sent twice at once, leaves ONE row and `spent` equal to ONE call's cost; the repeat answers a success
 *       (200 or 201) carrying the same id.
 *   M3  THE BUDGET READ FAILS LOUD: with the executor unreachable, `GET /api/model-calls?agent=..&since=..` answers 503 (never 200 with `spent: 0`) and a POST answers 503; with it back, the same POST
 *       (same requestId) is recorded once.
 *   M4  THE DOCUMENT NO LONGER HOLDS THEM: with the unit on, after a model call and a delivery, `/api/board` carries neither a `modelCalls` nor a `deliveries` collection, and the call is read back through
 *       `GET /api/model-calls`.
 *   M5  REDACTION REACHES `postedText`: a graph post is redacted after a model call that quoted it was recorded: no triple in the store holds the post's text and `GET /api/model-calls` returns it nowhere;
 *       and a model call recorded AFTER the redaction, naming the same post, leaves no copy either. (CONTROL inside: before the redaction the store holds the text, so the scan can see it.)
 *   M6  BOOT REFUSAL (C7'): `SCRUM_GRAPH_UNIT_DELIVERIES=1` without `SCRUM_GRAPH_UNIT_CONVERSATIONS=1` does not start.
 *
 * NOT COVERED, by name (each deferred by decision at 19:44Z, none silently dropped): the same requestId with a DIFFERENT payload (409 REQUEST_ID_CONFLICT), `creator` / `actorDeclared`, the server-side budget
 * clock and replaying the first `recordedAt`/price, the local-ledger fallback file's `postedText` copies, `/api/changes`, `core/ask-shape.mjs` and the export spaces, the search reader's own pricing, migration of
 * existing rows; and the accessor guard itself (the accessors throwing) can only be seen from outside as M3/M4, not tested directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const UNIT_DELIVERIES = 'SCRUM_GRAPH_UNIT_DELIVERIES';
const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const PERSON = 'https://scrumboard.local/person/';
const ROSTER_FILE = path.join(os.tmpdir(), `m1-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, gizmo: { name: 'Gizmo', glyph: 'g', color: '#c4a07c' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(40000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
let rq = 0; const RID = (tag) => `m1-${tag}-${process.pid}-${Date.now().toString(36)}-${++rq}`.slice(0, 64);
const COST = 0.25;
/** THE WIRE, in one place: a model call is today's body plus `requestId`; an unregistered model with a declared cost is recorded at that cost (`priceModelCall`). */
const call = (base, requestId, extra = {}) => api(base, 'POST', '/api/model-calls', { by: 'ada', agent: 'ada', model: 'm1-unregistered-model', cost: COST, ...(requestId === undefined ? {} : { requestId }), ...extra });
const listCalls = (base, agent = 'ada', sinceMsAgo = 3600000) => api(base, 'GET', `/api/model-calls?agent=${encodeURIComponent(agent)}&since=${encodeURIComponent(new Date(Date.now() - sinceMsAgo).toISOString())}`);

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
const fixture = () => makeBoardFixture({ conversations: [{ id: 'p1', body: 'delivered post p1', author: 'ada', attachedTo: null, attachments: [], mentions: ['gizmo'], postSeq: 1, createdAt: new Date(Date.now() - 300000).toISOString() }], postSeqEpoch: EPOCH_DOC, nextPostSeq: 2 });
const UNIT_ENVS = (proxyUrl, dsid) => ({ SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: proxyUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', [UNIT_DELIVERIES]: '1' });
async function unitOn(body, { dsid = 'm1-test', board } = {}) {
  const exec = await startExecutor({ store: tmpStore('m1-store-'), datasetId: dsid, create: true });
  const proxy = await startProxy(exec.baseUrl);
  const rest = await startRestServer({ board: board ?? fixture(), env: UNIT_ENVS(proxy.url, dsid) });
  try { return await body({ base: rest.baseUrl, proxy, exec, dsid }); } finally { await rest.stop(); try { await proxy.down(); } catch { /* down */ } await killExecutor(exec); }
}
/** how many triples in the executor's store hold a literal containing `needle`, wherever they are: the DEFAULT graph AND named ones (the compiler writes to the default graph; a `GRAPH ?g { }` scope alone reads zero rows, which my first draft did) */
async function holders(execUrl, needle) {
  const res = await fetch(`${execUrl}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query' }, body: `SELECT ?s ?p WHERE { { ?s ?p ?o FILTER(isLiteral(?o) && CONTAINS(STR(?o), ${JSON.stringify(needle)})) } UNION { GRAPH ?g { ?s ?p ?o FILTER(isLiteral(?o) && CONTAINS(STR(?o), ${JSON.stringify(needle)})) } } }`, signal: AbortSignal.timeout(30000) });
  assert.equal(res.status, 200, 'the store scan is answered'); return (await res.json()).results.bindings.length;
}

test('M0 CONTROL: with the unit OFF a model call needs no requestId, is counted in spent, and /api/board carries modelCalls', { timeout: 120000 }, async () => {
  const rest = await startRestServer({ board: fixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const r = await call(rest.baseUrl); assert.equal(r.status, 201, `${r.status} ${r.text.slice(0, 200)}`);
    const l = await listCalls(rest.baseUrl); assert.equal(l.status, 200); assert.equal(l.body.count, 1); assert.equal(Number(l.body.spent), COST, 'the declared cost is counted');
    const b = await api(rest.baseUrl, 'GET', '/api/board'); assert.equal(b.status, 200);
    assert.ok(Array.isArray(b.body?.modelCalls) && b.body.modelCalls.length === 1, `CONTROL for M4: with the unit off the board DOES carry its modelCalls collection (${JSON.stringify(Object.keys(b.body ?? {})).slice(0, 200)})`);
  } finally { await rest.stop(); }
});

test('M1 requestId IS REQUIRED AND CHECKED (unit on): none, short, long, illegal -> 400; a bad agent -> 400; none recorded; a valid one -> 201', { skip: SKIP, timeout: 240000 }, async () => {
  await unitOn(async ({ base }) => {
    const none = await call(base);
    assert.equal(none.status, 400, `a model call without a requestId is refused (${none.status} ${none.text.slice(0, 160)})`);
    assert.equal(none.body?.code, 'REQUEST_ID_REQUIRED', `and says why (${none.text.slice(0, 160)})`);
    for (const [why, v] of [['7 characters', 'abcdefg'], ['65 characters', 'a'.repeat(65)], ['an illegal character', 'abcd efgh!']]) { const r = await call(base, v); assert.equal(r.status, 400, `${why}: ${r.status} ${r.text.slice(0, 160)}`); }
    for (const [why, agent] of [['a space', 'ada lovelace'], ['a ">"', 'ada>x'], ['a non-ASCII letter', 'adá']]) {
      const r = await call(base, RID('agent'), { agent }); assert.equal(r.status, 400, `an agent with ${why} is refused before anything is built (${r.status} ${r.text.slice(0, 160)})`);
    }
    const l = await listCalls(base); assert.equal(l.status, 200); assert.equal(l.body.count, 0, 'none of the refused calls was recorded');
    const ok = await call(base, RID('ok')); assert.equal(ok.status, 201, `a valid requestId records (${ok.status} ${ok.text.slice(0, 160)})`);
  });
});

test('M2 A RETRY IS ONE ROW AND ONE CHARGE: the same call twice in a row and twice at once leaves one row and spent equal to one cost', { skip: SKIP, timeout: 240000 }, async () => {
  await unitOn(async ({ base }) => {
    const R = RID('retry');
    const first = await call(base, R); assert.equal(first.status, 201, `${first.status} ${first.text.slice(0, 160)}`);
    const again = await call(base, R);
    assert.ok(again.status === 200 || again.status === 201, `the repeat answers a success, not a conflict (${again.status} ${again.text.slice(0, 160)})`);
    assert.equal(again.body?.id, first.body?.id, 'carrying the same id');
    let l = await listCalls(base); assert.equal(l.body.count, 1, `one row after a repeat (${l.body.count})`); assert.equal(Number(l.body.spent), COST, `and the budget was charged once (spent ${l.body.spent})`);
    const C = RID('concurrent');
    const both = await Promise.all([call(base, C, { agent: 'gizmo', by: 'gizmo' }), call(base, C, { agent: 'gizmo', by: 'gizmo' })]);
    assert.ok(both.every((r) => r.status === 200 || r.status === 201), `both answer a success (${both.map((r) => r.status)})`);
    l = await listCalls(base, 'gizmo'); assert.equal(l.body.count, 1, `one row after two at once (${l.body.count})`); assert.equal(Number(l.body.spent), COST, `one charge (${l.body.spent})`);
  });
});

test('M3 THE BUDGET READ FAILS LOUD: executor away -> the spent read is a 503, never 200 with spent 0, and a POST is a 503; back -> the same POST records once', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, proxy }) => {
    const R = RID('down');
    assert.equal((await call(base, RID('seed'))).status, 201, 'CONTROL: a call is recorded while the executor is up');
    await proxy.down();
    const read = await listCalls(base);
    assert.equal(read.status, 503, `a budget read with the executor unreachable is a 503, not "0 spent" (${read.status} ${read.text.slice(0, 200)})`);
    const w = await call(base, R); assert.equal(w.status, 503, `a call is a 503 (${w.status} ${w.text.slice(0, 160)})`);
    await sleep(500); await proxy.up();
    const ok = await call(base, R); assert.equal(ok.status, 201, `with it back the same call (same requestId) records (${ok.status} ${ok.text.slice(0, 160)})`);
    const l = await listCalls(base); assert.equal(l.body.count, 2, `the seed and this one, once each (${l.body.count})`);
  });
});

// The DOCUMENT still holds the legacy rows until the migration (piece 5) moves them: M4 seeds one of each, because on a board with none, "the collections are absent" is true of ANY build (the mutant that keeps them survived the first draft of this row, found by kill-checking it).
const legacyBoard = () => ({ ...fixture(), modelCalls: [{ '@id': 'https://scrumboard.local/model-call/legacy-1', '@type': 'scrum:ModelCall', 'scrum:agent': 'ada', 'scrum:model': 'm1', 'scrum:calledAt': new Date(Date.now() - 600000).toISOString(), 'scrum:cost': 0.1 }], deliveries: [{ '@id': 'https://scrumboard.local/delivery/legacy-1', '@type': 'scrum:Delivery', 'scrum:deliveredTo': 'gizmo', 'scrum:ofConversation': 'p1', 'scrum:offeredAt': new Date(Date.now() - 600000).toISOString(), events: [] }] });
test('M4 THE DOCUMENT NO LONGER HOLDS THEM: a board that still carries legacy rows serves them on /api/board with the unit OFF and neither collection with the unit ON; a new call reads back through /api/model-calls', { skip: SKIP, timeout: 240000 }, async () => {
  const off = await startRestServer({ board: legacyBoard(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const b = await api(off.baseUrl, 'GET', '/api/board'); assert.equal(b.status, 200);
    assert.ok(Array.isArray(b.body?.modelCalls) && b.body.modelCalls.length === 1 && Array.isArray(b.body?.deliveries) && b.body.deliveries.length === 1, `CONTROL: with the unit OFF the board serves the legacy collections (${JSON.stringify(Object.keys(b.body ?? {})).slice(0, 200)})`);
  } finally { await off.stop(); }
  await unitOn(async ({ base }) => {
    assert.equal((await call(base, RID('doc'))).status, 201);
    const d = await api(base, 'POST', '/api/deliveries', { to: 'gizmo', conversation: 'p1', source: 'fanout', by: 'board' }); assert.equal(d.status, 201, `${d.status} ${d.text.slice(0, 160)}`);
    const b = await api(base, 'GET', '/api/board'); assert.equal(b.status, 200, `${b.status} ${b.text.slice(0, 160)}`);
    assert.ok(!('modelCalls' in (b.body ?? {})), 'no modelCalls collection on /api/board, although the document still holds a legacy row');
    assert.ok(!('deliveries' in (b.body ?? {})), 'no deliveries collection on /api/board, although the document still holds a legacy row');
    assert.equal((await listCalls(base)).body.count, 1, 'and the new call is read through the route');
  }, { board: legacyBoard() });
});

test('M5 REDACTION REACHES postedText: after a post is redacted no triple holds its text and the model-call route returns it nowhere; a call recorded AFTER the redaction leaves no copy either', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, exec, dsid }) => {
    const MARK = `raven-slate-${process.pid}-${Date.now().toString(36)}`; const TEXT = `post body ${MARK} to be redacted`;
    const p = await api(base, 'POST', '/api/conversations', { author: 'ada', body: TEXT, requestId: RID('post') }); assert.equal(p.status, 201, `${p.status} ${p.text.slice(0, 200)}`);
    const postId = p.body.id;
    const c1 = await call(base, RID('quote'), { producedPost: postId, postedText: TEXT }); assert.equal(c1.status, 201, `${c1.status} ${c1.text.slice(0, 200)}`);
    assert.ok(await holders(exec.baseUrl, MARK) >= 2, 'CONTROL: before the redaction the store holds the text in the post AND in the model-call row (a build that keeps model calls out of the graph cannot pass)');
    const red = await createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: dsid }).update({ kind: 'post.redact', opId: `urn:ex:op/redact/${postId}`, actor: `${PERSON}ada`, post: { id: postId }, authorityRef: 'test-authority-ref', occurredAt: '2026-10-05T12:00:00.000Z' });
    assert.ok(red && (red.outcome === 'APPLIED' || red.outcome === 'applied' || red.ok !== false), `the redaction applied (${JSON.stringify(red).slice(0, 160)})`);
    assert.equal(await holders(exec.baseUrl, MARK), 0, 'after the redaction NO triple in the store holds the text (post or model-call row)');
    const l = await listCalls(base); assert.ok(!l.text.includes(MARK), 'and /api/model-calls returns it nowhere');
    const late = await call(base, RID('late'), { producedPost: postId, postedText: TEXT });
    assert.ok(late.status >= 200 && late.status < 500, `a late call is answered (${late.status} ${late.text.slice(0, 160)})`);
    assert.equal(await holders(exec.baseUrl, MARK), 0, 'a call recorded AFTER the redaction leaves no copy of the text');
    assert.ok(!(await listCalls(base)).text.includes(MARK), 'and the route still returns it nowhere');
  });
});

test('M6 BOOT REFUSAL (C7\'): SCRUM_GRAPH_UNIT_DELIVERIES=1 without SCRUM_GRAPH_UNIT_CONVERSATIONS=1 does not start', { skip: SKIP, timeout: 120000 }, async () => {
  const exec = await startExecutor({ store: tmpStore('m1-boot-'), datasetId: 'm1-boot', create: true });
  let started = null;
  try {
    started = await startRestServer({ board: fixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: 'm1-boot', SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, [UNIT_DELIVERIES]: '1' } }).catch((e) => ({ refused: e }));
    assert.ok(started?.refused, 'the server refuses to start: a delivery step checks its post in the graph, and with the conversations unit off there is no graph to read');
  } finally { if (started && !started.refused) await started.stop(); await killExecutor(exec); }
});
