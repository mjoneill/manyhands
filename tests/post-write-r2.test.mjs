/**
 * R2 — ORDINARY POST WRITES TO THE GRAPH (FLAG ON). Pre-registered by the separate test author BEFORE it exists. Copy unchanged into tests/ and build to
 * it; if the contract needs a change the test changes first and the change is announced on #1574.
 * REAL executor (a python with pyoxigraph); without one every test is SKIPPED, and a skip is NOT a pass.
 *
 * ⚠ THIS FILE IS NOT R2's ACCEPTANCE. R2 is also not shippable alone: R1 (the reader), R3's consumers, R4 and the live-size cost number (the last row, a
 * `todo`) land together before the production flag SCRUM_GRAPH_UNIT_CONVERSATIONS is turned on. This file proves the WRITE PATH only.
 *
 * CONTRACT PINNED HERE (the builder's proposal and answers, #1574 thread, 2026-10-05; nothing below was derived from code)
 *   ROUTE      POST /api/conversations, unchanged: body/author validation, `attachedTo` resolution and the talk checks behave EXACTLY as with the flag OFF
 *              (same status for the same bad request), inside the document lock. Flag OFF: byte-for-byte today's path, the executor never contacted.
 *   requestId  an optional body field. post id = a v5 UUID of `<author>:<requestId>` (the NAMESPACE VALUE is not pinned here: see NOT PINNED). Same
 *              (author, requestId) = the same post. No requestId: the server mints one, so there is NO dedupe (two identical posts are two posts).
 *   RESERVATION under the document lock, ONE document write records postReservations[requestId] = {postId, postSeq, createdAt}, postSeq taken from the SAME
 *              counter as every other post. A retry reuses it. A gap in postSeq is allowed. The lock is released BEFORE the executor is called (a held
 *              graph write must not block another post).
 *   WRITE      a `post.write` intention, opId `urn:ex:op/post/<postId>`, with the node shape R0 writes (type schema:Comment, text, author, dateCreated,
 *              ns#postSeq, schema:about, ns#mentionsName). APPLIED → 201 with the post. REJECTED / intent-collision → 409. UNKNOWN / UNAVAILABLE → 503
 *              code GRAPH_WRITE_UNKNOWN carrying the `requestId`; a retry of the same key replays.
 *   COLLISION  THE GRAPH IS THE ARBITER (no stored fingerprint): the same requestId with different body, attachedTo or conversation → 409 and the first
 *              post is byte-identical afterwards.
 *   COMPACTION a reservation is dropped after APPLIED + 7 days. With NO reservation the server first READS whether a node for that postId exists:
 *              exists + same content → exact replay (200, the stored post, its ORIGINAL postSeq, NO number consumed); exists + different → 409; absent →
 *              mint. If that READ fails: 503, nothing consumed, no reservation written (never "unreadable, so mint").
 *   NO DOCUMENT CONVERSATION is written with the flag ON.
 *   LIVE       ordinary posts are discovered through R3's afterCommit stream in COMMIT order. The live stream is NOT postSeq-monotonic.
 *   REWIND     the server keeps an in-memory high-water mark of nextPostSeq (startup: graph max postSeq + 1). Whenever it re-parses the document and the
 *              parsed nextPostSeq is LOWER than the mark, every post-creating write is 409 POST_SEQ_BEHIND_GRAPH until reconciled (the reconcile is a
 *              runbook step that raises the counter above the graph max; never automatic). File identity and mtime play no part. No duplicate postSeq is
 *              ever minted. Ordinary writes cost no scan.
 *
 * NOT PINNED, BY NAME: the namespace value of the v5 id (so ids are checked for determinism, version nibble and independence only, not recomputed);
 * 200 vs 201 on a replay inside the reservation window; where in the stored document the reservation map lives (read from `scrum:meta.postReservations` or the top level); the 409 / 503 body beyond `code` and `requestId`; deliveries, attachment upload and edits (out of
 * R2); notify/fanout side effects; the live-size latency (the `todo` at the end).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { freePort, waitForHttp, makeBoardFixture, PROJECT_DIR } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'r2-test';
const ENTITY = 'https://scrumboard.local/entity/';
const PERSON = 'https://scrumboard.local/person/';
const SCHEMA = 'https://schema.org/';
const NS = 'https://scrumboard.local/ns#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_INT = 'http://www.w3.org/2001/XMLSchema#integer';
const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const UUID5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GC = /^gc1\.([0-9a-f-]{36})\.(\d+)\.(\d+)\.([0-9a-f]{64})$/;
const BASE = 40;   // the migrated board starts with 40 document posts, so nextPostSeq = 41

// a synthetic roster, so `@bea` is a rostered mention on this server (mention extraction validates against the roster; the test server has none by default)
const ROSTER_FILE = path.join(os.tmpdir(), `r2-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, bea: { name: 'Bea', glyph: 'b', color: '#c48ab0' }, cy: { name: 'Cy', glyph: 'c', color: '#e8b45c' } } }));
const docPosts = (n) => Array.from({ length: n }, (_, i) => ({ id: `d${i + 1}`, body: `doc ${i + 1}`, author: 'ada', attachedTo: null, attachments: [], mentions: [], createdAt: '2026-10-04T12:00:00.000Z', postSeq: i + 1 }));
const board = () => makeBoardFixture({ conversations: docPosts(BASE), postSeqEpoch: EPOCH_DOC, nextPostSeq: BASE + 1 });

async function api(base, method, route, body) {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
}
const post = (base, body) => api(base, 'POST', '/api/conversations', body);
const feed = (base, qs) => api(base, 'GET', `/api/conversations?${qs}`);
const newCard = async (base, title) => (await api(base, 'POST', '/api/cards', { title, description: 'x', createdBy: 'ada' })).body;

/** A proxy in front of the executor: counts /query and /update, can HOLD the next /update before forwarding, FAIL updates (socket destroyed before
 *  forwarding: never applied), DROP the answer of the next update AFTER forwarding it (applied, caller sees a dead socket), or go fully DOWN. */
async function startProxy(execUrl) {
  const p = { updates: 0, queries: 0, requests: 0, armed: null, armedAfter: null, pendingQueryHold: null, queryHold: null, down: false, failUpdates: false, dropNext: false };
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    p.requests++;
    if (p.down) { req.socket.destroy(); return; }
    const isUpdate = req.method === 'POST' && req.url === '/update';
    if (req.method === 'POST' && req.url === '/query') p.queries++;
    if (isUpdate) {
      p.updates++;
      if (p.failUpdates) { req.socket.destroy(); return; }
      if (p.armed) { const a = p.armed; p.armed = null; a.arrive(); await a.released; }
    }
    const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
    try {
      const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
      const text = await f.text();
      if (isUpdate && p.dropNext) { p.dropNext = false; req.socket.destroy(); return; }
      if (isUpdate && p.armedAfter) { const a = p.armedAfter; p.armedAfter = null; a.arrive(); await a.released; if (p.pendingQueryHold) { p.queryHold = p.pendingQueryHold; p.pendingQueryHold = null; } }
      if (req.method === 'POST' && req.url === '/query' && p.queryHold) { const a = p.queryHold; p.queryHold = null; a.arrive(); await a.released; }
      res.statusCode = f.status; res.end(text);
    } catch { try { req.socket.destroy(); } catch { /* gone */ } }
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r));
  p.url = `http://127.0.0.1:${p.server.address().port}`;
  p.hold = () => { let arrive, release; const arrived = new Promise((r) => { arrive = r; }); const released = new Promise((r) => { release = r; }); p.armed = { arrive, released }; return { arrived, release }; };
  p.holdQueryAfterUpdate = () => { let arrive, release; const arrived = new Promise((r) => { arrive = r; }); const released = new Promise((r) => { release = r; }); p.pendingQueryHold = { arrive, released }; return { arrived, release }; };
  p.holdAnswer = () => { let arrive, release; const arrived = new Promise((r) => { arrive = r; }); const released = new Promise((r) => { release = r; }); p.armedAfter = { arrive, released }; return { arrived, release }; };
  p.stop = () => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); });
  return p;
}

async function spawnServer(boardFile, execUrl, { flag = true, notifyUrl = '' } = {}) {
  const port = await freePort();
  const env = { ...process.env, SCRUM_BOARD_FILE: boardFile, SCRUM_PORT: String(port), SCRUM_MCP_NOTIFY_URL: notifyUrl, SCRUM_ATTACHMENTS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'r2-attach-')),
    SCRUM_CHANNEL_CONFIG_FILE: path.join(os.tmpdir(), `r2-chan-${process.pid}-${port}.json`), SCRUM_INSTANCE_ID: `r2-${port}`,
    SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: execUrl, ...(flag ? { SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' } : {}) };
  const child = spawn('node', ['server.js'], { cwd: PROJECT_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const err = []; child.stderr.on('data', (d) => err.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  await waitForHttp(`${base}/api/board`, 15000);
  return { base, stop: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, stderr: () => err.join('') };
}

async function stack(b, body, { flag = true } = {}) {
  const store = tmpStore('r2-store-');
  let exec = await startExecutor({ store, datasetId: DSID, create: true }); const port = exec.port;
  const proxy = await startProxy(exec.baseUrl);
  const notified = [];   // every announcement the server sends to the MCP side, captured by a local listener: {id (the post it names), body (if it carries one), raw, text}
  const notifier = http.createServer((req, res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => { try { const text = Buffer.concat(c).toString(); const raw = JSON.parse(text); const conv = raw?.conversation ?? raw; notified.push({ id: conv?.id ?? raw?.id ?? raw?.postId ?? null, body: conv?.body, raw, text }); } catch { /* not json */ } res.end('{}'); }); });
  await new Promise((r) => notifier.listen(0, '127.0.0.1', r)); const notifyUrl = `http://127.0.0.1:${notifier.address().port}/internal/notify`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-')); const file = path.join(dir, 'board.json'); fs.writeFileSync(file, JSON.stringify(b, null, 2));
  let srv = await spawnServer(file, proxy.url, { flag, notifyUrl });
  const gc = () => createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID });
  const s = {
    get base() { return srv.base; }, proxy, file, notified, eventsDir: file.replace(/\.json$/, '') + '-events', get exec() { return exec; },
    doc: () => readDoc(file),
    dropReservation: (key) => { const { raw, ld, meta } = readDoc(file); if (meta.postReservations?.[key]) delete meta.postReservations[key]; else if (raw.postReservations?.[key]) delete raw.postReservations[key]; else assert.fail(`no reservation for ${key} to drop`); fs.writeFileSync(file, JSON.stringify(raw, null, 2)); },
    setCounter: (n) => { const { raw, ld } = readDoc(file); if (ld) (raw['scrum:meta'] ||= {}).nextPostSeq = n; else raw.nextPostSeq = n; fs.writeFileSync(file, JSON.stringify(raw, null, 2)); },
    restartServer: async () => { srv.stop(); srv = await spawnServer(file, proxy.url, { flag, notifyUrl }); },
    stopServer: () => srv.stop(), startServer: async () => { srv = await spawnServer(file, proxy.url, { flag, notifyUrl }); },
    killExecutor: async () => { await killExecutor(exec); }, startExecutor: async () => { exec = await startExecutor({ store, datasetId: DSID, create: false, port }); },
    stderr: () => srv.stderr(),
    triples: async (id) => { const r = await gc().query(`SELECT ?p ?o WHERE { <${ENTITY}${id}> ?p ?o }`); assert.equal(r.ok, true, JSON.stringify(r)); const out = {}; for (const x of r.rows) (out[x.p.value] ||= []).push(`${x.o.type}|${x.o.value}|${x.o.datatype || ''}`); for (const k of Object.keys(out)) out[k].sort(); return out; },
    nodesByText: async (text) => { const r = await gc().query(`SELECT ?s WHERE { ?s <${SCHEMA}text> ${JSON.stringify(text)} }`); assert.equal(r.ok, true, JSON.stringify(r)); return r.rows.map((x) => x.s.value.replace(ENTITY, '')).sort(); },
    postSeqs: async () => { const r = await gc().query(`SELECT ?s ?n WHERE { ?s <${RDF_TYPE}> <${SCHEMA}Comment> . ?s <${NS}postSeq> ?n }`); assert.equal(r.ok, true, JSON.stringify(r)); return r.rows.map((x) => Number(x.n.value)).sort((a, b) => a - b); },
  };
  try { return await body(s); } finally { srv.stop(); await proxy.stop(); notifier.closeAllConnections?.(); notifier.close(); await killExecutor(exec); }
}

// The server rewrites the board file as JSON-LD on its first save, so the stored state is read in WHICHEVER shape the file now has: the document's posts are
// its Comment nodes (or its `conversations`), the counter and the reservations live on `scrum:meta` (or the top level). Where the builder keeps the reservation
// map is NOT pinned: it is read from `scrum:meta.postReservations` or the top level.
const readDoc = (file) => {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')); const ld = Array.isArray(raw['@graph']); const meta = ld ? (raw['scrum:meta'] || {}) : raw;
  return { raw, ld, meta, conversations: ld ? raw['@graph'].filter((e) => e && e['@type'] === 'Comment') : (raw.conversations || []), nextPostSeq: meta.nextPostSeq, postSeqEpoch: meta.postSeqEpoch, postReservations: meta.postReservations ?? raw.postReservations };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A held write that never arrives is a FAILURE with a name, not a hung test. */
const arrived = async (h, label) => { const got = await Promise.race([h.arrived.then(() => true), sleep(10000).then(() => false)]); assert.equal(got, true, `${label}: the graph write never reached the executor`); };
const okish = (r) => r.status === 200 || r.status === 201;
const expectedTriples = (p) => ({
  [RDF_TYPE]: [`uri|${SCHEMA}Comment|`], [`${SCHEMA}text`]: [`literal|${p.body}|`], [`${SCHEMA}author`]: [`uri|${PERSON}${p.author}|`],
  [`${SCHEMA}dateCreated`]: [`literal|${p.createdAt}|`], [`${NS}postSeq`]: [`literal|${p.postSeq}|${XSD_INT}`],
  ...(p.attachedTo ? { [`${SCHEMA}about`]: [`uri|${ENTITY}${p.attachedTo}|`] } : {}),
});
const withoutProvenance = (t) => { const o = { ...t }; delete o['urn:ex:recordedBy']; return o; };

// ------------------------------------------------------------------ flag, shape, counter
test('W0 flag OFF: a post is the document path as today (201, in the document, the executor NEVER contacted)', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const r = await post(s.base, { author: 'ada', body: 'off path' });
    assert.equal(r.status, 201, r.text);
    assert.equal(s.doc().conversations.length, BASE + 1, 'the post is in the document');
    assert.equal(s.proxy.requests, 0, 'no request reached the executor');
  }, { flag: false });
});

test('W0b flag ON: the write reaches the executor (the contrast that makes W0 mean something)', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const r = await post(s.base, { author: 'ada', body: 'on path' });
    assert.equal(r.status, 201, r.text);
    assert.ok(s.proxy.updates >= 1, 'with the flag ON the write DID reach the executor');
  });
});

test('W1 flag ON: 201 with the post, NO document conversation, the node has the R0 shape (type, text, author, dateCreated, postSeq, mentions), postSeq above the migrated counter and the counter advanced', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const docBefore = s.doc().conversations.length;
    const r = await post(s.base, { author: 'ada', body: 'first on graph @bea' });
    assert.equal(r.status, 201, r.text);
    const p = r.body;
    assert.match(String(p.id), UUID5, 'the id is a v5 UUID');
    assert.ok(Number.isSafeInteger(p.postSeq) && p.postSeq > BASE, `postSeq above the migrated counter: ${p.postSeq}`);
    assert.equal(p.author, 'ada'); assert.equal(p.body, 'first on graph @bea'); assert.ok(p.createdAt);
    assert.equal(s.doc().conversations.length, docBefore, 'no document conversation was written');
    assert.ok(s.doc().nextPostSeq > p.postSeq, 'the document counter advanced past the issued number');
    const t = withoutProvenance(await s.triples(p.id));
    const want = expectedTriples(p);
    if (Array.isArray(p.mentions) && p.mentions.length) want[`${NS}mentionsName`] = p.mentions.map((m) => `literal|${m}|`).sort();
    assert.deepEqual(t, want, 'the node carries exactly the R0 shape');
    assert.ok(Array.isArray(p.mentions) && p.mentions.includes('bea'), 'control: the mention was extracted, so the mentionsName row above is not vacuous');
    await sleep(300);
    assert.equal(s.notified.filter((c) => c.id === p.id).length, 1, 'control: a created post is announced to the MCP side exactly once (so the capture works, and the no-announcement rows below are not vacuous)');
  });
});

test('W2 postSeq is ONE counter: strictly increasing across posts, every node carries the number the response named, gaps allowed but never a duplicate', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const got = [];
    for (let i = 0; i < 4; i++) { const r = await post(s.base, { author: i % 2 ? 'bea' : 'ada', body: `seq ${i}` }); assert.equal(r.status, 201, r.text); got.push(r.body.postSeq); }
    for (let i = 1; i < got.length; i++) assert.ok(got[i] > got[i - 1], `strictly increasing: ${got}`);
    assert.deepEqual(await s.postSeqs(), got, 'the graph holds exactly the numbers the responses named, once each');
    assert.ok(s.doc().nextPostSeq > got.at(-1));
  });
});

// ------------------------------------------------------------------ idempotency, collision, separation
test('W3 a retry of the same (author, requestId, content) is the SAME post: same id, same postSeq, one node, not a 409', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const a = await post(s.base, { author: 'ada', body: 'retry me', requestId: 'req-1' });
    assert.equal(a.status, 201, a.text);
    const b = await post(s.base, { author: 'ada', body: 'retry me', requestId: 'req-1' });
    assert.ok(okish(b), `a retry replays: ${b.status} ${b.text}`);
    assert.equal(b.body.id, a.body.id); assert.equal(b.body.postSeq, a.body.postSeq);
    assert.deepEqual(await s.nodesByText('retry me'), [a.body.id], 'one node');
    assert.equal(s.doc().conversations.length, BASE, 'still no document conversation');
  });
});

test('W4 the SAME requestId with a DIFFERENT body, attachedTo or conversation is a 409 and the first post stays byte-identical (the graph arbitrates; a replay would swallow the second message)', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const cardA = await newCard(s.base, 'A'); const cardB = await newCard(s.base, 'B');
    const a = await post(s.base, { author: 'ada', body: 'original', requestId: 'req-c', attachedTo: cardA.id });
    assert.equal(a.status, 201, a.text);
    const before = await s.triples(a.body.id);
    assert.ok(Object.keys(before).length > 4, 'control: the first post has a node to compare');
    for (const [label, variant] of [['body', { body: 'changed' , attachedTo: cardA.id }], ['attachedTo', { body: 'original', attachedTo: cardB.id }], ['attachedTo dropped', { body: 'original' }]]) {
      const r = await post(s.base, { author: 'ada', requestId: 'req-c', ...variant });
      assert.equal(r.status, 409, `${label}: ${r.text}`);
      assert.deepEqual(await s.triples(a.body.id), before, `${label}: the first post is byte-identical`);
    }
    assert.deepEqual(await s.nodesByText('changed'), [], 'the colliding body never became a node');
  });
});

test('W5 with NO requestId nothing is deduplicated: two identical posts are two posts with different ids and postSeqs', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const a = await post(s.base, { author: 'ada', body: 'same words' }); const b = await post(s.base, { author: 'ada', body: 'same words' });
    assert.equal(a.status, 201, a.text); assert.equal(b.status, 201, b.text);
    assert.notEqual(a.body.id, b.body.id); assert.notEqual(a.body.postSeq, b.body.postSeq);
    assert.equal((await s.nodesByText('same words')).length, 2);
  });
});

test('W6 two AUTHORS using the same requestId are two different posts (a reservation keyed by requestId alone would hand one author the other\'s post)', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const a = await post(s.base, { author: 'ada', body: 'from ada', requestId: 'shared-key' });
    const b = await post(s.base, { author: 'bea', body: 'from bea', requestId: 'shared-key' });
    assert.equal(a.status, 201, a.text);
    assert.equal(b.status, 201, `a different author with the same key is a NEW post, not a collision or a replay: ${b.status} ${b.text}`);
    assert.notEqual(a.body.id, b.body.id); assert.notEqual(a.body.postSeq, b.body.postSeq);
    assert.equal(b.body.author, 'bea'); assert.equal(b.body.body, 'from bea');
    // and each author's own retry still replays its own post
    const a2 = await post(s.base, { author: 'ada', body: 'from ada', requestId: 'shared-key' }); assert.ok(okish(a2), a2.text); assert.equal(a2.body.id, a.body.id);
  });
});

// ------------------------------------------------------------------ unknown / unavailable, reservation, restart
test('W7 UNKNOWN: the write never reaches the executor → 503 GRAPH_WRITE_UNKNOWN carrying the requestId, a reservation in the document, no node, no document conversation; the retry of the same key lands ONE node with the RESERVED postSeq', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const ok = await post(s.base, { author: 'ada', body: 'control before', requestId: 'req-ok' });
    assert.equal(ok.status, 201, `control: the stack writes when healthy: ${ok.text}`);
    s.proxy.failUpdates = true;
    const r = await post(s.base, { author: 'ada', body: 'lost write', requestId: 'req-u' });
    assert.equal(r.status, 503, r.text);
    assert.equal(r.body.code, 'GRAPH_WRITE_UNKNOWN'); assert.equal(r.body.requestId, 'req-u');
    const res = s.doc().postReservations?.['req-u'];
    assert.ok(res && UUID5.test(String(res.postId)) && Number.isSafeInteger(res.postSeq) && res.createdAt, `the reservation is recorded as {postId, postSeq, createdAt}: ${JSON.stringify(res)}`);
    assert.deepEqual(await s.nodesByText('lost write'), [], 'nothing was applied');
    assert.equal(s.doc().conversations.length, BASE, 'no document conversation');
    s.proxy.failUpdates = false;
    const again = await post(s.base, { author: 'ada', body: 'lost write', requestId: 'req-u' });
    assert.ok(okish(again), again.text);
    assert.equal(again.body.id, res.postId, 'the reserved id'); assert.equal(again.body.postSeq, res.postSeq, 'the RESERVED postSeq');
    assert.deepEqual(await s.nodesByText('lost write'), [res.postId]);
  });
});

test('W7b UNKNOWN the other way: the write APPLIED but the answer was lost → 503, and the retry replays the receipt: ONE node, the same postSeq, no second number', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    s.proxy.dropNext = true;
    const r = await post(s.base, { author: 'ada', body: 'applied unseen', requestId: 'req-d' });
    assert.equal(r.status, 503, r.text); assert.equal(r.body.code, 'GRAPH_WRITE_UNKNOWN');
    const nodes = await s.nodesByText('applied unseen');
    assert.equal(nodes.length, 1, 'control: the write DID apply, so this row exercises replay and not a plain retry');
    const again = await post(s.base, { author: 'ada', body: 'applied unseen', requestId: 'req-d' });
    assert.ok(okish(again), again.text);
    assert.equal(again.body.id, nodes[0]);
    assert.deepEqual(await s.nodesByText('applied unseen'), nodes, 'still one node');
    assert.equal((await s.triples(nodes[0]))[`${NS}postSeq`][0], `literal|${again.body.postSeq}|${XSD_INT}`, 'the node and the response agree on the number');
  });
});

test('W8 the reservation survives a SERVER restart: the retry after the restart lands the reserved post, and the counter never reissues the reserved number', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    s.proxy.failUpdates = true;
    const r = await post(s.base, { author: 'ada', body: 'across restart', requestId: 'req-r' });
    assert.equal(r.status, 503, r.text);
    const reserved = s.doc().postReservations['req-r'];
    s.proxy.failUpdates = false;
    await s.restartServer();
    const other = await post(s.base, { author: 'bea', body: 'someone else meanwhile' });
    assert.equal(other.status, 201, other.text);
    assert.notEqual(other.body.postSeq, reserved.postSeq, 'a reserved number is never reissued to another post');
    const again = await post(s.base, { author: 'ada', body: 'across restart', requestId: 'req-r' });
    assert.ok(okish(again), again.text);
    assert.equal(again.body.id, reserved.postId); assert.equal(again.body.postSeq, reserved.postSeq);
  });
});

test('W9 the executor is entirely DOWN before the write: 503, NOTHING consumed (counter unchanged, no reservation), and the key is still usable afterwards', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const warm = await post(s.base, { author: 'ada', body: 'warm' }); assert.equal(warm.status, 201, warm.text);
    const counter = s.doc().nextPostSeq; const resBefore = JSON.stringify(s.doc().postReservations || {});
    s.proxy.down = true;
    const r = await post(s.base, { author: 'ada', body: 'while down', requestId: 'req-x' });
    assert.equal(r.status, 503, r.text);
    assert.equal(s.doc().nextPostSeq, counter, 'no number consumed');
    assert.equal(JSON.stringify(s.doc().postReservations || {}), resBefore, 'no reservation written');
    s.proxy.down = false;
    const again = await post(s.base, { author: 'ada', body: 'while down', requestId: 'req-x' });
    assert.equal(again.status, 201, again.text);
  });
});

// ------------------------------------------------------------------ after compaction
async function compacted(s, { requestId, body, author = 'ada', attachedTo }) {
  const a = await post(s.base, { author, body, requestId, ...(attachedTo ? { attachedTo } : {}) });
  assert.equal(a.status, 201, a.text);
  s.stopServer();
  assert.ok(s.doc().postReservations?.[requestId], 'control: the reservation existed before the compaction edit'); s.dropReservation(requestId);
  await s.startServer();
  return a;
}

test('W10 NO reservation (compacted), the node EXISTS: same content is an exact replay (200, the stored post, its ORIGINAL postSeq, NO number consumed); different content is a 409', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const a = await compacted(s, { requestId: 'req-k', body: 'old post' });
    const counter = s.doc().nextPostSeq;
    const r = await post(s.base, { author: 'ada', body: 'old post', requestId: 'req-k' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.id, a.body.id); assert.equal(r.body.postSeq, a.body.postSeq, 'the ORIGINAL postSeq');
    assert.equal(s.doc().nextPostSeq, counter, 'no number consumed, no gap');
    assert.deepEqual(await s.nodesByText('old post'), [a.body.id]);
    const before = await s.triples(a.body.id);
    const c = await post(s.base, { author: 'ada', body: 'different now', requestId: 'req-k' });
    assert.equal(c.status, 409, c.text);
    assert.deepEqual(await s.triples(a.body.id), before, 'the stored post is untouched');
    assert.equal(s.doc().nextPostSeq, counter, 'a refused collision consumed nothing');
  });
});

test('W11 NO reservation and the pre-mint READ FAILS: 503, no number consumed, no reservation, no node. Unreadable must never fall through to "absent, so mint"', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const a = await compacted(s, { requestId: 'req-p', body: 'present node' });
    const counter = s.doc().nextPostSeq; const nodeBefore = await s.triples(a.body.id);
    s.proxy.down = true;
    const r = await post(s.base, { author: 'ada', body: 'present node', requestId: 'req-p' });
    assert.equal(r.status, 503, r.text);
    assert.equal(s.doc().nextPostSeq, counter, 'no number consumed');
    assert.equal(s.doc().postReservations?.['req-p'], undefined, 'no reservation written');
    s.proxy.down = false;
    assert.deepEqual(await s.triples(a.body.id), nodeBefore, 'the node is untouched, and (control) the executor is readable again');
    assert.deepEqual(await s.nodesByText('present node'), [a.body.id], 'no second node for the same key');
  });
});

test('W12 CONCURRENT retries of one requestId after compaction (and of a brand-new one): ONE node, ONE postSeq, every caller gets the same post', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const a = await compacted(s, { requestId: 'req-q', body: 'concurrent old' });
    const rs = await Promise.all(Array.from({ length: 4 }, () => post(s.base, { author: 'ada', body: 'concurrent old', requestId: 'req-q' })));
    for (const r of rs) { assert.ok(okish(r), r.text); assert.equal(r.body.id, a.body.id); assert.equal(r.body.postSeq, a.body.postSeq); }
    assert.deepEqual(await s.nodesByText('concurrent old'), [a.body.id]);
    const fresh = await Promise.all(Array.from({ length: 4 }, () => post(s.base, { author: 'bea', body: 'concurrent new', requestId: 'req-n' })));
    for (const r of fresh) assert.ok(okish(r), r.text);
    assert.equal(new Set(fresh.map((r) => r.body.id)).size, 1); assert.equal(new Set(fresh.map((r) => r.body.postSeq)).size, 1, 'one number');
    assert.equal((await s.nodesByText('concurrent new')).length, 1);
  });
});

// ------------------------------------------------------------------ validation parity, lock
test('W13 the existing checks are unchanged: a post the flag-OFF route refuses is refused with the SAME status with the flag ON, and nothing is consumed, reserved or written', { skip: SKIP }, async () => {
  const cases = [['empty body', { author: 'ada', body: '' }], ['attachedTo naming no card', { author: 'ada', body: 'x', attachedTo: '00000000-0000-4000-8000-000000000000' }], ['missing author', { body: 'x' }]];
  const off = {};
  await stack(board(), async (s) => { for (const [k, b] of cases) off[k] = (await post(s.base, b)).status; }, { flag: false });
  for (const [k, st] of Object.entries(off)) assert.ok(st >= 400 && st < 500, `control: the flag-OFF route refuses "${k}" (${st}), so a parity row compares like with like`);
  await stack(board(), async (s) => {
    const counter = s.doc().nextPostSeq;
    for (const [k, b] of cases) {
      const r = await post(s.base, { ...b, requestId: `req-${k.length}` });
      assert.equal(r.status, off[k], `${k}: ${r.text}`);
    }
    assert.equal(s.doc().nextPostSeq, counter, 'no number consumed'); assert.deepEqual(s.doc().postReservations || {}, {}, 'no reservation');
    assert.equal((await s.postSeqs()).length, 0, 'no node');
  });
});

test('W14 the document lock is released BEFORE the executor: a post whose graph write is HELD does not block another post', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const h = s.proxy.hold();
    const slow = post(s.base, { author: 'ada', body: 'held write', requestId: 'req-h' }); slow.catch(() => {});
    try { await arrived(h, 'W14'); } catch (e) { h.release(); throw e; }
    const quick = await Promise.race([post(s.base, { author: 'bea', body: 'overtakes' }), new Promise((r) => setTimeout(() => r('BLOCKED'), 8000))]);
    assert.notEqual(quick, 'BLOCKED', 'the second post completed while the first graph write was held');
    assert.equal(quick.status, 201, quick.text);
    h.release();
    const first = await slow; assert.equal(first.status, 201, first.text);
    assert.ok(first.body.postSeq < quick.body.postSeq, 'the held post reserved its number FIRST (lower), and committed LAST');
  });
});

// ------------------------------------------------------------------ live discovery
test('W15 live discovery: an ordinary post reaches the R3 afterCommit stream exactly once, in COMMIT order. The stream is NOT postSeq-monotonic', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    let page = await feed(s.base, 'afterCommit=start&limit=200');
    while (page.body.phase === 'bootstrap') page = await feed(s.base, `afterCommit=${page.body.nextAfterCommit}&limit=200`);
    assert.equal(page.status, 200); assert.match(page.body.nextAfterCommit, GC, 'control: a live cursor from an empty-of-graph-posts board');
    let cursor = page.body.nextAfterCommit;
    const h = s.proxy.hold();
    const slow = post(s.base, { author: 'ada', body: 'reserved first', requestId: 'req-l1' }); slow.catch(() => {});
    try { await arrived(h, 'W15'); } catch (e) { h.release(); throw e; }
    const quick = await post(s.base, { author: 'bea', body: 'committed first' }); assert.equal(quick.status, 201, quick.text);
    const p1 = await feed(s.base, `afterCommit=${cursor}&limit=50`);
    assert.deepEqual(p1.body.conversations.map((c) => c.body), ['committed first'], 'the held post is not visible before it commits');
    cursor = p1.body.nextAfterCommit;
    h.release(); const first = await slow; assert.equal(first.status, 201, first.text);
    const p2 = await feed(s.base, `afterCommit=${cursor}&limit=50`);
    assert.deepEqual(p2.body.conversations.map((c) => c.body), ['reserved first'], 'delivered once, after its commit');
    assert.ok(p2.body.conversations[0].postSeq < p1.body.conversations[0].postSeq, 'delivered in commit order: the LATER delivery has the LOWER postSeq');
    const p3 = await feed(s.base, `afterCommit=${p2.body.nextAfterCommit}&limit=50`);
    assert.deepEqual(p3.body.conversations, [], 'nothing is delivered twice');
  });
});

// ------------------------------------------------------------------ rewind
const threePosts = async (s) => { const out = []; for (let i = 0; i < 3; i++) { const r = await post(s.base, { author: 'ada', body: `rw ${i}` }); assert.equal(r.status, 201, r.text); out.push(r.body); } return out; };
const noDuplicates = async (s) => { const n = await s.postSeqs(); assert.equal(new Set(n).size, n.length, `no duplicate postSeq in the graph: ${n}`); };

test('W16 a document REWOUND under a RUNNING server (older version copied over the file, no restart): the next post-creating write is 409 POST_SEQ_BEHIND_GRAPH, no node, no duplicate postSeq', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const first = await post(s.base, { author: 'ada', body: 'rw base' }); assert.equal(first.status, 201, first.text);
    const older = fs.readFileSync(s.file, 'utf8');
    await threePosts(s);
    const graphBefore = await s.postSeqs();
    fs.writeFileSync(s.file, older);
    const r = await post(s.base, { author: 'ada', body: 'after rewind' });
    assert.equal(r.status, 409, r.text); assert.equal(r.body.code, 'POST_SEQ_BEHIND_GRAPH');
    assert.deepEqual(await s.nodesByText('after rewind'), [], 'no node');
    assert.deepEqual(await s.postSeqs(), graphBefore, 'the graph is unchanged');
    const again = await post(s.base, { author: 'bea', body: 'still refused' });
    assert.equal(again.status, 409, 'it stays refused until reconciled, whoever asks');
    await noDuplicates(s);
  });
});

test('W17 the same rewind with the old file\'s MTIME PRESERVED (cp -p, rsync -t, tar) is still refused: identity and mtime play no part', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const first = await post(s.base, { author: 'ada', body: 'rw base' }); assert.equal(first.status, 201, first.text);
    const snap = `${s.file}.snap`; assert.equal(spawnSync('cp', ['-p', s.file, snap]).status, 0, 'fixture: cp -p the earlier version'); const stOld = fs.statSync(snap, { bigint: true });
    await new Promise((r) => setTimeout(r, 1100));
    await threePosts(s);
    assert.equal(spawnSync('cp', ['-p', snap, s.file]).status, 0, 'the restore: cp -p over the live file');
    assert.equal(fs.statSync(s.file, { bigint: true }).mtimeNs, stOld.mtimeNs, 'control: the restored file carries the OLD mtime to the nanosecond, so this row exercises the mtime-preserving restore');
    const r = await post(s.base, { author: 'ada', body: 'after cp -p' });
    assert.equal(r.status, 409, r.text); assert.equal(r.body.code, 'POST_SEQ_BEHIND_GRAPH');
    await noDuplicates(s);
  });
});

test('W18 a rewind then a RESTART is still refused (the startup mark is the graph max + 1), and the reconcile (counter raised above the graph max) reopens writes with a number ABOVE every existing one', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const first = await post(s.base, { author: 'ada', body: 'rw base' }); assert.equal(first.status, 201, first.text);
    const older = fs.readFileSync(s.file, 'utf8');
    const three = await threePosts(s);
    const graphMax = Math.max(...three.map((p) => p.postSeq));
    s.stopServer(); fs.writeFileSync(s.file, older); await s.startServer();
    const r = await post(s.base, { author: 'ada', body: 'after restart' });
    assert.equal(r.status, 409, r.text); assert.equal(r.body.code, 'POST_SEQ_BEHIND_GRAPH');
    // the runbook step: raise the counter above the graph max, while the server RUNS
    s.setCounter(graphMax + 1);
    const ok = await post(s.base, { author: 'ada', body: 'after reconcile' });
    assert.equal(ok.status, 201, `reconciled: ${ok.text}`);
    assert.ok(ok.body.postSeq > graphMax, `above every existing number: ${ok.body.postSeq} vs ${graphMax}`);
    await noDuplicates(s);
  });
});

// ------------------------------------------------------------------ cost shape
test('W19 an ordinary write costs a BOUNDED number of graph reads that does not grow with history: at most one /query per post, the same for the 1st and the 12th', { skip: SKIP }, async (t) => {
  await stack(board(), async (s) => {
    const per = [];
    for (let i = 0; i < 12; i++) { const q0 = s.proxy.queries; const r = await post(s.base, { author: 'ada', body: `cost ${i}`, requestId: `req-cost-${i}` }); assert.equal(r.status, 201, r.text); per.push(s.proxy.queries - q0); }
    t.diagnostic(`graph /query calls per post: ${per.join(',')}`);
    assert.equal(s.proxy.updates, 12, `exactly ONE executor write per ordinary post: twelve posts, no second write (no dispatch ticket, no extra receipt): ${s.proxy.updates}`);
    assert.ok(Math.max(...per) <= 1, `at most one read per post: ${per}`);
    assert.equal(per.at(-1), per[0], `no growth with history: ${per}`);
  });
});

test('W21 the executor is DOWN at server STARTUP: the server starts, document-backed reads work, every post write is a 503 with NOTHING minted and NOTHING reserved (fail closed), and once the executor is reachable the first post lands ABOVE the graph max with no restart', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const a = await post(s.base, { author: 'ada', body: 'before restart' }); assert.equal(a.status, 201, a.text);
    s.stopServer(); await s.killExecutor(); await s.startServer();
    assert.equal((await api(s.base, 'GET', '/api/board')).status, 200, 'a document-backed read still answers with the executor down');
    const counter = s.doc().nextPostSeq; const resBefore = JSON.stringify(s.doc().postReservations || {});
    const r = await post(s.base, { author: 'ada', body: 'while down at startup', requestId: 'req-s' });
    assert.equal(r.status, 503, r.text);
    assert.equal(s.doc().nextPostSeq, counter, 'nothing minted'); assert.equal(JSON.stringify(s.doc().postReservations || {}), resBefore, 'nothing reserved');
    assert.equal(s.doc().conversations.length, BASE, 'no document conversation');
    await s.startExecutor();
    const ok = await post(s.base, { author: 'ada', body: 'while down at startup', requestId: 'req-s' });
    assert.equal(ok.status, 201, `the first write after the executor returns succeeds without a restart: ${ok.text}`);
    assert.ok(ok.body.postSeq > a.body.postSeq, `above the graph max: ${ok.body.postSeq} vs ${a.body.postSeq}`);
    await noDuplicates(s);
  });
});

const attachmentNodes = async (s, id) => {
  const r = await createGraphClient({ baseUrl: s.exec.baseUrl, expectedDatasetId: DSID }).query(`SELECT ?s ?p ?o WHERE { ?s ?p ?o FILTER(STRSTARTS(STR(?s), ${JSON.stringify(`${ENTITY}${id}/attachment/`)})) }`);
  assert.equal(r.ok, true, JSON.stringify(r));
  const by = {}; for (const b of r.rows) { if (b.p.value === 'urn:ex:recordedBy') continue; ((by[b.s.value] ||= {})[b.p.value] ||= []).push(`${b.o.type}|${b.o.value}|${b.o.datatype || ''}`); }
  return by;
};
test('W22 an ordinary write with attachments and a card writes the SAME shape R0 writes: the post node carries schema:about, and each attachment is one node `<post>/attachment/<k>` with attachmentOf, attachmentIndex, identifier, name, encodingFormat and contentSize; the bytes are not in the graph', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const card = await newCard(s.base, 'carries a post');
    const atts = [{ id: 'a1b2.png', name: 'pic one.png', mime: 'image/png', size: 1234 }, { id: 'c3d4.pdf', name: 'doc.pdf', mime: 'application/pdf', size: 0 }];
    const r = await post(s.base, { author: 'ada', body: 'with attachments', attachedTo: card.id, attachments: atts });
    assert.equal(r.status, 201, r.text); const p = r.body;
    assert.equal(p.attachedTo, card.id); assert.equal(p.attachments.length, 2, 'control: the route accepted both attachments, so the node rows below are not vacuous');
    assert.deepEqual(withoutProvenance(await s.triples(p.id)), expectedTriples(p), 'the post node, including schema:about');
    const nodes = await attachmentNodes(s, p.id);
    assert.deepEqual(Object.keys(nodes).sort(), [0, 1].map((k) => `${ENTITY}${p.id}/attachment/${k}`), 'one node per attachment, by array index');
    p.attachments.forEach((a, k) => {
      assert.deepEqual(Object.fromEntries(Object.entries(nodes[`${ENTITY}${p.id}/attachment/${k}`]).map(([pr, v]) => [pr, [...v].sort()])), {
        [`${NS}attachmentOf`]: [`uri|${ENTITY}${p.id}|`], [`${NS}attachmentIndex`]: [`literal|${k}|${XSD_INT}`], [`${SCHEMA}identifier`]: [`literal|${a.id}|`],
        [`${SCHEMA}name`]: [`literal|${a.name}|`], [`${SCHEMA}encodingFormat`]: [`literal|${a.mime}|`], [`${SCHEMA}contentSize`]: [`literal|${a.size}|${XSD_INT}`] }, `attachment ${k}`);
    });
  });
});

test('W23 an attachment whose `size` is not a non-negative integer (fractional, negative) can never leave a stuck write: never a 5xx and never an UNKNOWN that a client would retry forever. Either it is refused with a 4xx and NO node, or it is stored with a valid integer contentSize that the response agrees with. Then the same key retried with a good size lands', { skip: SKIP }, async () => {
  for (const bad of [1.5, -1]) {
    await stack(board(), async (s) => {
      const key = `req-size-${bad}`; const counter0 = s.doc().nextPostSeq; const res0 = JSON.stringify(s.doc().postReservations || {});
      const r = await post(s.base, { author: 'ada', body: `odd size ${bad}`, requestId: key, attachments: [{ id: 'e5f6.png', name: 'x.png', mime: 'image/png', size: bad }] });
      assert.ok(r.status < 500, `size ${bad}: no 5xx and no GRAPH_WRITE_UNKNOWN: ${r.status} ${r.text}`);
      if (r.status >= 400) {
        assert.deepEqual(await s.nodesByText(`odd size ${bad}`), [], `size ${bad}: refused, so no node`);
        assert.equal(s.doc().nextPostSeq, counter0, `size ${bad}: a refused write consumed no number`); assert.equal(JSON.stringify(s.doc().postReservations || {}), res0, `size ${bad}: and reserved nothing`);
        const fixed = await post(s.base, { author: 'ada', body: `odd size ${bad}`, requestId: key, attachments: [{ id: 'e5f6.png', name: 'x.png', mime: 'image/png', size: 10 }] });
        assert.ok(okish(fixed), `size ${bad}: the same key retried with a good size lands (a refusal must not poison the key): ${fixed.status} ${fixed.text}`);
      } else {
        const nodes = await attachmentNodes(s, r.body.id); const size = Object.values(nodes)[0]?.[`${SCHEMA}contentSize`]?.[0];
        assert.ok(size, `size ${bad}: stored, so the attachment node has a contentSize`);
        const n = Number(size.split('|')[1]); assert.ok(Number.isSafeInteger(n) && n >= 0, `size ${bad}: stored as a non-negative integer, not ${size}`);
        assert.equal(r.body.attachments[0].size, n, `size ${bad}: the response and the node agree`);
      }
    });
  }
});

// ------------------------------------------------------------------ pruning must never lose an UNRESOLVED reservation
/** Age one stored reservation to `days` days old (server stopped while the file is edited), then restart. */
const ageReservation = async (s, key, days) => {
  s.stopServer();
  const { raw, meta } = s.doc(); const r = (meta.postReservations ?? raw.postReservations)?.[key];
  assert.ok(r, `fixture: a reservation for ${key} to age`); r.createdAt = new Date(Date.now() - days * 86400000).toISOString();
  fs.writeFileSync(s.file, JSON.stringify(raw, null, 2));
  await s.startServer();
  return r;
};
const unresolved = async (s, key, body) => {
  s.proxy.failUpdates = true;
  const r = await post(s.base, { author: 'ada', body, requestId: key }); assert.equal(r.status, 503, `fixture: the write for ${key} is left UNRESOLVED: ${r.text}`);
  s.proxy.failUpdates = false;
  const res = s.doc().postReservations?.[key]; assert.ok(res && Number.isSafeInteger(res.postSeq), `fixture: ${key} holds a reservation`);
  return { postId: res.postId, postSeq: res.postSeq };
};

test('W24 PRUNING NEVER LOSES AN UNRESOLVED RESERVATION: a reservation whose write never applied, aged past 7 days, SURVIVES the prune that another post triggers, and its retry lands the SAME post and postSeq (nothing reminted, no duplicate). The aged APPLIED one may be pruned or kept, but its retry replays with the original number either way', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const done = await post(s.base, { author: 'ada', body: 'applied and old', requestId: 'req-done' }); assert.equal(done.status, 201, done.text);
    const pend = await unresolved(s, 'req-old', 'never applied');
    await ageReservation(s, 'req-done', 8); await ageReservation(s, 'req-old', 8);
    const trigger = await post(s.base, { author: 'bea', body: 'triggers the prune', requestId: 'req-trigger' }); assert.equal(trigger.status, 201, trigger.text);
    const kept = s.doc().postReservations?.['req-old'];
    assert.ok(kept, 'the unresolved reservation is still there after the prune');
    assert.deepEqual({ postId: kept.postId, postSeq: kept.postSeq }, pend, 'unchanged');
    assert.notEqual(trigger.body.postSeq, pend.postSeq, 'its number was not handed to another post');
    const again = await post(s.base, { author: 'ada', body: 'never applied', requestId: 'req-old' });
    assert.ok(okish(again), again.text); assert.equal(again.body.id, pend.postId); assert.equal(again.body.postSeq, pend.postSeq, 'the SAME number: nothing reminted');
    assert.deepEqual(await s.nodesByText('never applied'), [pend.postId], 'one node');
    const replay = await post(s.base, { author: 'ada', body: 'applied and old', requestId: 'req-done' });
    assert.ok(okish(replay), replay.text); assert.equal(replay.body.id, done.body.id); assert.equal(replay.body.postSeq, done.body.postSeq, 'the aged applied post replays with its ORIGINAL number');
    await noDuplicates(s);
  });
});

test('W25 an aged UNRESOLVED reservation with the graph UNAVAILABLE: the retry is a 503, the reservation and the counter are untouched, and once the graph is back the retry lands the reserved number', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const pend = await unresolved(s, 'req-old', 'never applied');
    await ageReservation(s, 'req-old', 8);
    const trigger = await post(s.base, { author: 'bea', body: 'triggers the prune', requestId: 'req-trigger' }); assert.equal(trigger.status, 201, trigger.text);
    const counter = s.doc().nextPostSeq;
    s.proxy.down = true;
    const r = await post(s.base, { author: 'ada', body: 'never applied', requestId: 'req-old' });
    assert.equal(r.status, 503, r.text);
    assert.deepEqual(s.doc().postReservations?.['req-old'] && { postId: s.doc().postReservations['req-old'].postId, postSeq: s.doc().postReservations['req-old'].postSeq }, pend, 'the reservation is still there, unchanged');
    assert.equal(s.doc().nextPostSeq, counter, 'no number consumed by the failed retry');
    s.proxy.down = false;
    const again = await post(s.base, { author: 'ada', body: 'never applied', requestId: 'req-old' });
    assert.ok(okish(again), again.text); assert.equal(again.body.id, pend.postId); assert.equal(again.body.postSeq, pend.postSeq);
    await noDuplicates(s);
  });
});

test('W26 CONCURRENT retries of an aged UNRESOLVED reservation: every caller gets the reserved post, one node, one postSeq equal to the reserved one', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const pend = await unresolved(s, 'req-old', 'never applied');
    await ageReservation(s, 'req-old', 8);
    const rs = await Promise.all([post(s.base, { author: 'bea', body: 'triggers the prune', requestId: 'req-trigger' }), ...Array.from({ length: 4 }, () => post(s.base, { author: 'ada', body: 'never applied', requestId: 'req-old' }))]);
    for (const r of rs) assert.ok(okish(r), r.text);
    for (const r of rs.slice(1)) { assert.equal(r.body.id, pend.postId); assert.equal(r.body.postSeq, pend.postSeq); }
    assert.deepEqual(await s.nodesByText('never applied'), [pend.postId]);
    await noDuplicates(s);
  });
});

// ------------------------------------------------------------------ gaps found by mutating the builder's first R2 build
test('W27 A REWIND BY EXACTLY ONE POST IS STILL REFUSED: the document restored to the version just before the LAST post (its counter equals the number that last post already took) refuses the next write, because the guard mark advances on every mint, not only on every read; no duplicate postSeq', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const p1 = await post(s.base, { author: 'ada', body: 'one back 1' }); assert.equal(p1.status, 201, p1.text);
    const p2 = await post(s.base, { author: 'ada', body: 'one back 2' }); assert.equal(p2.status, 201, p2.text);
    const older = fs.readFileSync(s.file, 'utf8');
    const p3 = await post(s.base, { author: 'ada', body: 'one back 3' }); assert.equal(p3.status, 201, p3.text);
    assert.equal(s.doc().nextPostSeq > p3.body.postSeq, true, 'control: the counter moved past the last post');
    fs.writeFileSync(s.file, older);
    assert.equal(s.doc().nextPostSeq, p3.body.postSeq, 'control: the restored counter equals the number the last post ALREADY took, so minting again would duplicate it');
    const r = await post(s.base, { author: 'bea', body: 'after a one-post rewind' });
    assert.equal(r.status, 409, r.text); assert.equal(r.body.code, 'POST_SEQ_BEHIND_GRAPH');
    assert.deepEqual(await s.nodesByText('after a one-post rewind'), []);
    await noDuplicates(s);
  });
});

test('W28 TWO AUTHORS ONE KEY, THE FIRST UNRESOLVED: author B using the same requestId neither overwrites nor inherits author A\'s outstanding reservation; A\'s retry still lands A\'s RESERVED number and post, B has its own, and nothing is reminted', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    s.proxy.failUpdates = true;
    const a = await post(s.base, { author: 'ada', body: 'a never applied', requestId: 'shared-key' }); assert.equal(a.status, 503, a.text);
    s.proxy.failUpdates = false;
    const reservedA = (() => { const all = s.doc().postReservations || {}; return Object.values(all).find((r) => r && Number.isSafeInteger(r.postSeq)); })();
    assert.ok(reservedA, 'fixture: author A holds a reservation');
    const b = await post(s.base, { author: 'bea', body: 'b with the same key', requestId: 'shared-key' }); assert.equal(b.status, 201, b.text);
    assert.notEqual(b.body.id, reservedA.postId); assert.notEqual(b.body.postSeq, reservedA.postSeq);
    const again = await post(s.base, { author: 'ada', body: 'a never applied', requestId: 'shared-key' });
    assert.ok(okish(again), again.text);
    assert.equal(again.body.id, reservedA.postId, 'A lands A\'s reserved post'); assert.equal(again.body.postSeq, reservedA.postSeq, 'A\'s reserved number: not reminted');
    assert.deepEqual(await s.nodesByText('a never applied'), [reservedA.postId]); assert.equal((await s.nodesByText('b with the same key')).length, 1);
    await noDuplicates(s);
  });
});

test('W29 requestId: ANY string of 1-256 characters without control characters is accepted (the room\'s `<deliveryId>:<slot>` and anything else a client may send: slashes, at-signs, hashes, spaces, non-ASCII), and everything else is a 400, not a 5xx and never a stuck write, consuming nothing', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const goods = ['delivery-123:claim', '0b7e0e0c-5d1a-4a53-9a4e-0f2a7c6b8d11:slot-1', 'a.b_c-d:e', 'k'.repeat(256), '\u{1F600}'.repeat(128), 'has a space', 'x/y', 'a@b', 'h#sh', 'caf\u00e9:\u2713', 'e\u0301'];   // 256 UTF-16 units; 128 astral characters = 256 units; a decomposed e
    for (const good of goods) {
      const r = await post(s.base, { author: 'ada', body: `good ${good.slice(0, 12)}`, requestId: good });
      assert.equal(r.status, 201, `${JSON.stringify(good.slice(0, 30))}: ${r.text}`);
      const again = await post(s.base, { author: 'ada', body: `good ${good.slice(0, 12)}`, requestId: good });
      assert.ok(okish(again) && again.body.id === r.body.id, `${JSON.stringify(good.slice(0, 30))} replays as itself: ${again.status} ${again.text}`);
    }
    const counter = s.doc().nextPostSeq; const res = JSON.stringify(s.doc().postReservations || {}); const n = (await s.postSeqs()).length;
    for (const bad of ['', 'k'.repeat(257), '\u{1F600}'.repeat(129), 'line\nbreak', 'nul\u0000byte', 'tab\there', 'del\u007fchar', 'c1\u0085char', 'c1\u009fchar', 'lone\ud800high', 'lone\udc00low', 5, { a: 1 }, ['x'], true]) {
      const r = await post(s.base, { author: 'ada', body: 'bad key', requestId: bad });
      assert.equal(r.status, 400, `requestId ${JSON.stringify(bad)?.slice(0, 20)}: ${r.status} ${r.text}`);
    }
    assert.equal(s.doc().nextPostSeq, counter, 'nothing consumed'); assert.equal(JSON.stringify(s.doc().postReservations || {}), res, 'nothing reserved');
    assert.deepEqual(await s.nodesByText('bad key'), []); assert.equal((await s.postSeqs()).length, n, 'no node was written for a refused key');
  });
});

test('W33 A HOSTILE KEY IS JUST A KEY: `__proto__`, `constructor`, `toString`, `hasOwnProperty` and a key shaped like another author\'s composite (`k@ada`) each post, replay as themselves, and are never handed to the other author; an ordinary key afterwards is unaffected', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const keys = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'k@ada', 'k'];
    const seen = new Map();
    for (const author of ['ada', 'bea']) for (const key of keys) {
      const r = await post(s.base, { author, body: `hostile ${author} ${key}`, requestId: key });
      assert.equal(r.status, 201, `${author} ${key}: ${r.status} ${r.text}`);
      assert.equal(r.body.author, author); assert.equal(r.body.body, `hostile ${author} ${key}`);
      seen.set(`${author}|${key}`, r.body);
    }
    for (const [k, p] of seen) { const [author, key] = k.split('|'); const again = await post(s.base, { author, body: p.body, requestId: key }); assert.ok(okish(again), `${k}: ${again.status} ${again.text}`); assert.equal(again.body.id, p.id, `${k} replays as itself`); assert.equal(again.body.postSeq, p.postSeq); }
    assert.equal(new Set([...seen.values()].map((p) => p.id)).size, seen.size, 'every (author, key) is its own post');
    assert.equal(new Set([...seen.values()].map((p) => p.postSeq)).size, seen.size, 'and its own number');
    const plain = await post(s.base, { author: 'ada', body: 'ordinary afterwards' }); assert.equal(plain.status, 201, plain.text);
    await noDuplicates(s);
    // UNRESOLVED hostile keys survive a restart and the prune another post triggers, and their retry lands the reserved post
    const held = new Map();   // a Map: a plain object would swallow the `__proto__` key, the very bug this row tests
    for (const key of ['__proto__', 'constructor']) {
      s.proxy.failUpdates = true;
      const r = await post(s.base, { author: 'cy', body: `unresolved ${key}`, requestId: key }); assert.equal(r.status, 503, `${key}: ${r.text}`);
      s.proxy.failUpdates = false;
    }
    assert.ok(Object.keys(s.doc().postReservations || {}).includes('__proto__'), 'the `__proto__` reservation is an OWN key of the stored map');
    for (const key of ['__proto__', 'constructor']) held.set(key, JSON.stringify(Object.entries(s.doc().postReservations).filter(([k, v]) => k.startsWith(key) && v && v.postId).map(([k, v]) => [k, v.postId, v.postSeq])));
    await s.restartServer();
    const trigger = await post(s.base, { author: 'bea', body: 'triggers the prune', requestId: 'trigger-k' }); assert.equal(trigger.status, 201, trigger.text);
    assert.ok(Object.keys(s.doc().postReservations || {}).includes('__proto__'), 'the unresolved `__proto__` reservation survived the prune and the restart (it did not vanish into the prototype)');
    for (const key of ['__proto__', 'constructor']) {
      const again = await post(s.base, { author: 'cy', body: `unresolved ${key}`, requestId: key });
      assert.ok(okish(again), `${key}: ${again.status} ${again.text}`);
      assert.ok(held.get(key).includes(again.body.id) && held.get(key).includes(String(again.body.postSeq)), `${key}: the retry lands the RESERVED post and number (${held.get(key)} vs ${again.body.id} ${again.body.postSeq})`);
    }
    await noDuplicates(s);
  });
});

test('W35 EXACT COMPARISON, NO NORMALIZATION: the composed and the decomposed spelling of the same visible key are two different keys and two different posts; a retry of either replays only itself', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const nfc = 'café', nfd = 'café'; assert.notEqual(nfc, nfd); assert.equal(nfc.normalize('NFC'), nfd.normalize('NFC'), 'control: they are canonically equivalent');
    const a = await post(s.base, { author: 'ada', body: 'composed', requestId: nfc }); const b = await post(s.base, { author: 'ada', body: 'decomposed', requestId: nfd });
    assert.equal(a.status, 201, a.text); assert.equal(b.status, 201, `a different key, not a collision with the other spelling: ${b.status} ${b.text}`);
    assert.notEqual(a.body.id, b.body.id); assert.notEqual(a.body.postSeq, b.body.postSeq);
    const a2 = await post(s.base, { author: 'ada', body: 'composed', requestId: nfc }); assert.ok(okish(a2) && a2.body.id === a.body.id, a2.text);
    const b2 = await post(s.base, { author: 'ada', body: 'decomposed', requestId: nfd }); assert.ok(okish(b2) && b2.body.id === b.body.id, b2.text);
    await noDuplicates(s);
  });
});

const redactedKey = async (compact) => {
  await stack(board(), async (s) => {
    const a = await post(s.base, { author: 'ada', body: `redact me ${compact}`, requestId: 'req-red' }); assert.equal(a.status, 201, a.text);
    const red = await createGraphClient({ baseUrl: s.exec.baseUrl, expectedDatasetId: DSID }).update({ kind: 'post.redact', opId: `urn:ex:op/redact/${a.body.id}`, actor: `${PERSON}ada`, post: { id: a.body.id }, authorityRef: 'test-authority-ref', occurredAt: '2026-10-05T12:00:00.000Z' });
    assert.equal(red.outcome, 'APPLIED', `fixture: the post is redacted: ${JSON.stringify(red)}`);
    assert.deepEqual(await s.nodesByText(`redact me ${compact}`), [], 'control: the text is gone from the graph');
    if (compact) { s.stopServer(); s.dropReservation('req-red'); await s.startServer(); }
    await sleep(300); const announced = s.notified.filter((c) => c.id === a.body.id).length;
    assert.equal(announced, 1, 'control: the original creation was announced once, so a second announcement below would be seen');
    const r = await post(s.base, { author: 'ada', body: `redact me ${compact}`, requestId: 'req-red' });
    assert.deepEqual(await s.nodesByText(`redact me ${compact}`), [], `compacted=${compact}: the text did not come back into the graph`);
    assert.equal(r.status, 409, `compacted=${compact}: a redacted post's key is refused, never answered as a created post: ${r.status} ${r.text}`);
    assert.equal(r.body.code, 'POST_REDACTED', `compacted=${compact}: named as a redacted post`);
    await sleep(300); assert.equal(s.notified.filter((c) => c.id === a.body.id).length, announced, `compacted=${compact}: the redacted post is NOT announced again by the retry`);
  });
};
test('W30a A REDACTED POST IS NEVER RESURRECTED BY ITS KEY, reservation still held: after the post is redacted, a retry of the same requestId is a 409 (not a 201 that re-announces content), and no body text comes back into the graph', { skip: SKIP }, () => redactedKey(false));
test('W30b the same with the reservation COMPACTED away: the key still names a redacted post and is refused with a 409; no node, no text', { skip: SKIP }, () => redactedKey(true));

const texted = (s, id) => s.notified.filter((c) => c.id === id && typeof c.body === 'string' && c.body.length > 0);   // an announcement that carries the post's TEXT
const redactDirect = async (s, id) => { const red = await createGraphClient({ baseUrl: s.exec.baseUrl, expectedDatasetId: DSID }).update({ kind: 'post.redact', opId: `urn:ex:op/redact/${id}`, actor: `${PERSON}ada`, post: { id }, authorityRef: 'test-authority-ref', occurredAt: '2026-10-05T12:00:00.000Z' }); assert.equal(red.outcome, 'APPLIED', `fixture: redacted directly on the executor: ${JSON.stringify(red)}`); };
const liveCursor = async (s) => { let page = await feed(s.base, 'afterCommit=start&limit=200'); while (page.body.phase === 'bootstrap') page = await feed(s.base, `afterCommit=${page.body.nextAfterCommit}&limit=200`); assert.equal(page.status, 200, page.text); return page.body.nextAfterCommit; };

test('W37 PUSHES CARRY THE POST ID ONLY (the owner\'s decision 3dc9df18, 2026-10-05): the announcement of a created post is EXACTLY `{conversation:{id}}` (the shape `/internal/notify` acts on) and names the post and nothing else the post said: no body, no author, no attachment metadata, no mentions, no card or talk reference; the seat reads the post through discovery, which serves the tombstone. Exactly one announcement, and it names the right post', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const card = await newCard(s.base, 'carries a distinctive post');
    const body = 'zebra-quartz-7731 secret words @bea';
    const a = await post(s.base, { author: 'ada', body, attachedTo: card.id, attachments: [{ id: 'f7a8.png', name: 'pic-quartz.png', mime: 'image/png', size: 99 }] });
    assert.equal(a.status, 201, a.text);
    await sleep(500);
    const sent = s.notified.filter((n) => n.text.includes(a.body.id));
    assert.equal(sent.length, 1, `exactly one announcement names the post: ${s.notified.length} captured`);
    const n = sent[0];
    assert.deepEqual(n.raw, { conversation: { id: a.body.id } }, `the hint has EXACTLY the shape the real handler reads (it acts only on payload.conversation.id) and nothing more: ${n.text.slice(0, 200)}`);
    for (const needle of ['zebra-quartz-7731', 'secret words', 'pic-quartz', 'f7a8.png', '"ada"', '"bea"', card.id]) assert.ok(!n.text.includes(needle), `the announcement carries no ${JSON.stringify(needle)}: ${n.text.slice(0, 200)}`);
    const keys = new Set(); (function walk(x) { if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { keys.add(k); walk(v); } })(n.raw);
    for (const k of ['body', 'text', 'author', 'attachments', 'mentions', 'onBehalfOf', 'talkWith', 'attachedTo']) assert.ok(!keys.has(k), `no \`${k}\` field in the announcement (keys: ${[...keys].join(',')})`);
    // the hint is enough to find the post through discovery
    let page = await feed(s.base, 'afterCommit=start&limit=200'); const seen = [];
    while (true) { seen.push(...page.body.conversations); if (page.body.phase === 'live') break; page = await feed(s.base, `afterCommit=${page.body.nextAfterCommit}&limit=200`); }
    assert.ok(seen.some((c) => c.id === a.body.id && c.body === body), 'control: discovery serves the post the hint names, with its text');
  });
});

test('W38 HINT, THEN REDACTION, THEN RESOLUTION: a seat that receives the id-only hint and resolves it AFTER the post was redacted gets the tombstone and no text: through discovery (the bootstrap and the live stream) the post is served as redacted with a null body, and no announcement it received carried text', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const cursor = await liveCursor(s);
    const body = 'plover-onyx-5512 will be redacted';
    const a = await post(s.base, { author: 'ada', body, requestId: 'req-hint' }); assert.equal(a.status, 201, a.text);
    await sleep(500);
    const hints = s.notified.filter((n) => n.text.includes(a.body.id)); assert.equal(hints.length, 1, 'control: the seat received exactly one hint naming the post');
    assert.ok(!hints[0].text.includes('plover-onyx-5512'), 'the hint carried no text');
    await redactDirect(s, a.body.id);                                        // the redaction lands before the seat resolves the hint
    const live = (await feed(s.base, `afterCommit=${cursor}&limit=50`)).body.conversations.filter((c) => c.id === a.body.id);
    assert.ok(live.length >= 1, 'control: the live stream names the post');
    for (const it of live) { assert.equal(it.body, null, `the live stream serves no text: ${JSON.stringify(it)}`); assert.ok(it.redacted === true || it.op === 'redact', 'and marks it redacted'); }
    let page = await feed(s.base, 'afterCommit=start&limit=200'); const boot = [];
    while (true) { boot.push(...page.body.conversations); if (page.body.phase === 'live') break; page = await feed(s.base, `afterCommit=${page.body.nextAfterCommit}&limit=200`); }
    const mine = boot.filter((c) => c.id === a.body.id); assert.equal(mine.length, 1, 'a fresh bootstrap names the post once');
    assert.equal(mine[0].body, null, 'and serves the tombstone, not the text'); assert.equal(mine[0].redacted, true);
    assert.deepEqual(await s.nodesByText(body), [], 'no text left in the graph');
    assert.ok(!s.notified.some((n) => n.text.includes('plover-onyx-5512')), 'no announcement ever carried the text');
  });
});

test('W34a THE ORDERING RULE AT DISPATCH, redaction first: a post whose graph write applied and which is REDACTED before the route dispatches its announcement is never announced (the answer may be 201, it was created, or 409 POST_REDACTED); no text is in the graph and discovery serves it only as redacted, the redact item once', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const warm = await post(s.base, { author: 'ada', body: 'warm up the announcer' }); assert.equal(warm.status, 201, warm.text); await sleep(300);
    const cursor = await liveCursor(s); const before = s.notified.length;
    const h = s.proxy.holdAnswer();
    const inflight = post(s.base, { author: 'ada', body: 'redacted before dispatch', requestId: 'req-race' }); inflight.catch(() => {});
    const got = await Promise.race([h.arrived.then(() => true), sleep(10000).then(() => false)]); if (!got) { h.release(); assert.fail('the graph write never reached the executor'); }
    const ids = await s.nodesByText('redacted before dispatch'); assert.equal(ids.length, 1, 'control: the write APPLIED while its answer is held');
    await redactDirect(s, ids[0]);
    h.release();
    const r = await inflight;
    assert.ok(r.status === 201 || (r.status === 409 && r.body.code === 'POST_REDACTED'), `an honest answer either way: ${r.status} ${r.text}`);
    await sleep(500);
    assert.deepEqual(texted(s, ids[0]), [], 'the redacted post was NOT announced with its text (an id-only hint resolved through discovery would be allowed)');
    assert.ok(before >= 0);
    assert.deepEqual(await s.nodesByText('redacted before dispatch'), [], 'no text in the graph');
    const items = (await feed(s.base, `afterCommit=${cursor}&limit=50`)).body.conversations.filter((c) => c.id === ids[0]);
    assert.ok(items.length >= 1, 'control: discovery sees the post (as the redaction)');
    for (const it of items) assert.equal(it.body, null, `discovery never serves the text: ${JSON.stringify(it)}`);
    assert.equal(items.filter((it) => it.op === 'redact').length, 1, 'the redact item is delivered exactly once');
  });
});

test('W34b THE ORDERING RULE AT DISPATCH, dispatch first: a post announced BEFORE it is redacted was delivered (a retained copy: a later redaction cannot recall it); discovery then carries the redact item exactly once so a consumer can drop it, and the graph holds no text', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const cursor = await liveCursor(s);
    const a = await post(s.base, { author: 'ada', body: 'announced then redacted' }); assert.equal(a.status, 201, a.text);
    await sleep(400); assert.equal(s.notified.filter((c) => c.id === a.body.id).length, 1, 'control: it WAS announced before the redaction');
    await redactDirect(s, a.body.id);
    await sleep(300);
    assert.equal(s.notified.filter((c) => c.id === a.body.id).length, 1, 'the redaction recalled nothing and announced nothing more');
    assert.deepEqual(await s.nodesByText('announced then redacted'), []);
    const items = (await feed(s.base, `afterCommit=${cursor}&limit=50`)).body.conversations.filter((c) => c.id === a.body.id);
    assert.equal(items.filter((it) => it.op === 'redact').length, 1, 'the redact item is delivered exactly once');
    for (const it of items) assert.equal(it.body, null, 'and nothing in discovery serves the text');
  });
});

test('W34c NO CHECK-THEN-SEND RACE: if the route reads the graph after APPLIED to decide whether to announce, a redaction that commits while that read\'s answer is in flight still suppresses the announcement (the read was answered before the redaction, so "not redacted" is stale: the decision and the send must be ordered against redactions, not merely sequenced). If the build makes no such read the row has nothing to hold and records that', { skip: SKIP }, async (t) => {
  await stack(board(), async (s) => {
    const warm = await post(s.base, { author: 'ada', body: 'warm up the announcer' }); assert.equal(warm.status, 201, warm.text); await sleep(300);
    const before = s.notified.length;
    const h1 = s.proxy.holdAnswer(); const h2 = s.proxy.holdQueryAfterUpdate();
    const inflight = post(s.base, { author: 'ada', body: 'redacted during the check', requestId: 'req-check' }); inflight.catch(() => {});
    const got = await Promise.race([h1.arrived.then(() => true), sleep(10000).then(() => false)]); if (!got) { h1.release(); h2.release(); assert.fail('the graph write never reached the executor'); }
    const ids = await s.nodesByText('redacted during the check'); assert.equal(ids.length, 1, 'control: the write APPLIED');
    h1.release();
    const read = await Promise.race([h2.arrived.then(() => true), sleep(4000).then(() => false)]);
    if (!read) { h2.release(); t.diagnostic('W34c: the build issues no read after APPLIED, so there is no check to race; W34a covers the held-answer window'); await inflight; return; }
    await redactDirect(s, ids[0]);
    h2.release();
    const r = await inflight;
    assert.ok(r.status === 201 || (r.status === 409 && r.body.code === 'POST_REDACTED'), `an honest answer either way: ${r.status} ${r.text}`);
    await sleep(500);
    assert.deepEqual(texted(s, ids[0]), [], 'no text was announced although the check read answered before the redaction');
  });
});

test('W34d THE DISPATCH POINT IS ORDERED AT THE EXECUTOR, redaction first: whatever write the route sends AFTER the post is applied and BEFORE it announces (a dispatch commit, if the build has one), if it is held and a redaction commits first, the post is NOT announced. If the build sends no second write the row has nothing to hold and records that', { skip: SKIP }, async (t) => {
  await stack(board(), async (s) => {
    const warm = await post(s.base, { author: 'ada', body: 'warm up the announcer' }); assert.equal(warm.status, 201, warm.text); await sleep(300);
    const before = s.notified.length;
    const first = s.proxy.holdAnswer();                           // holds the ANSWER of the post write, so the second write (if any) is observable
    const inflight = post(s.base, { author: 'ada', body: 'held at the dispatch point', requestId: 'req-d1' }); inflight.catch(() => {});
    const got = await Promise.race([first.arrived.then(() => true), sleep(10000).then(() => false)]); if (!got) { first.release(); assert.fail('the graph write never reached the executor'); }
    const ids = await s.nodesByText('held at the dispatch point'); assert.equal(ids.length, 1, 'control: the post write APPLIED');
    const second = s.proxy.hold();                                 // holds the NEXT update BEFORE it is forwarded: the dispatch, if there is one
    first.release();
    const sawSecond = await Promise.race([second.arrived.then(() => true), sleep(4000).then(() => false)]);
    if (!sawSecond) { second.release(); t.diagnostic('W34d: the build sends no write between APPLIED and the announcement, so there is no dispatch commit to hold; W34a covers the held-answer window'); await inflight; return; }
    await redactDirect(s, ids[0]);
    second.release();
    const r = await inflight;
    assert.ok(r.status === 201 || (r.status === 409 && r.body.code === 'POST_REDACTED'), `an honest answer either way: ${r.status} ${r.text}`);
    await sleep(500);
    assert.deepEqual(texted(s, ids[0]), [], 'the redaction committed before the dispatch commit: no text was announced');
  });
});

test('W34e THE SEND ITSELF IS ORDERED AGAINST A REDACTION (the current promise, not a weaker one): if ANY write between APPLIED and the announcement has COMMITTED and a redaction then commits BEFORE the announcement is actually sent, the post is NOT announced with its text. A no-op ticket followed by an unordered send cannot pass this; what can is an announcement that carries no text (an id-only hint resolved through discovery, which serves the redaction), or a handoff the executor itself orders. The row does not pick one. If the build sends no write between APPLIED and the announcement, the row records that and W34a/W34d cover the window', { skip: SKIP }, async (t) => {
  await stack(board(), async (s) => {
    const warm = await post(s.base, { author: 'ada', body: 'warm up the announcer' }); assert.equal(warm.status, 201, warm.text); await sleep(300);
    const before = s.notified.length;
    const first = s.proxy.holdAnswer();
    const inflight = post(s.base, { author: 'ada', body: 'ticket then redacted', requestId: 'req-d2' }); inflight.catch(() => {});
    const got = await Promise.race([first.arrived.then(() => true), sleep(10000).then(() => false)]); if (!got) { first.release(); assert.fail('the graph write never reached the executor'); }
    const ids = await s.nodesByText('ticket then redacted'); assert.equal(ids.length, 1);
    const updatesBefore = s.proxy.updates; const second = s.proxy.holdAnswer();   // the next update is forwarded (COMMITS) and its ANSWER is held: the send has not happened yet
    first.release();
    const sawSecond = await Promise.race([second.arrived.then(() => true), sleep(4000).then(() => false)]);
    if (!sawSecond) { t.diagnostic('W34e: the build sends no write between APPLIED and the announcement'); await inflight; return; }
    assert.ok(s.proxy.updates > updatesBefore, 'control: a second write reached the executor and committed');
    await redactDirect(s, ids[0]);                                                  // the redaction commits AFTER that write and BEFORE the send
    second.release(); const r = await inflight;
    assert.ok(r.status === 201 || (r.status === 409 && r.body.code === 'POST_REDACTED'), `${r.status} ${r.text}`);
    await sleep(500);
    const sent = s.notified.filter((c) => c.id === ids[0]);
    for (const c of sent) assert.ok(c.body == null || c.body === '' || c.redacted === true, `an announcement that goes out after the redaction carries no text: ${JSON.stringify(c).slice(0, 160)}`);
    assert.equal(s.notified.length - before, sent.length, 'and nothing else was announced');
  });
});

test('W36 A REPLAY IS NOT A NEW CREATION: a retry of a post that was applied and announced does not announce it again (the announcement is a push hint; R3 discovery is the authority, so a duplicate retry must not duplicate the room\'s notification)', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const a = await post(s.base, { author: 'ada', body: 'announce me once', requestId: 'req-once' }); assert.equal(a.status, 201, a.text);
    await sleep(400); assert.equal(s.notified.filter((c) => c.id === a.body.id).length, 1, 'control: announced once on creation');
    for (let i = 0; i < 2; i++) { const again = await post(s.base, { author: 'ada', body: 'announce me once', requestId: 'req-once' }); assert.ok(okish(again), again.text); assert.equal(again.body.id, a.body.id); }
    await sleep(500);
    assert.equal(s.notified.filter((c) => c.id === a.body.id).length, 1, 'two retries announced nothing more');
  });
});

const scanTree = (dir, needle) => { const hits = []; const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else { try { if (fs.readFileSync(f, 'utf8').includes(needle)) hits.push(f); } catch { /* unreadable */ } } } }; walk(dir); return hits; };
test('W39 A REFUSAL MUST NOT BRING REDACTED TEXT BACK INTO A RETAINED COPY: `logRefused` appends the REQUEST of every refused write to the append-only event log, so a retry of a redacted post (the same key and body, answered 409 POST_REDACTED) would write the redacted text into the log again. After the post is redacted and its key retried, the event log holds no copy of the text (control: the log scan finds a marker that IS there, so an empty result means something)', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const M = 'quartzite-falcon-9047';
    const a = await post(s.base, { author: 'ada', body: `${M} redacted post`, requestId: 'rq-marker-5523' }); assert.equal(a.status, 201, a.text);
    await sleep(300);
    assert.ok(scanTree(s.eventsDir, 'rq-marker-5523').length > 0, 'control: the scan reads the event log (the reservation event names the key)');
    assert.deepEqual(scanTree(s.eventsDir, M), [], 'precondition: a graph post writes no text into the event log');
    await redactDirect(s, a.body.id);
    const r = await post(s.base, { author: 'ada', body: `${M} redacted post`, requestId: 'rq-marker-5523' });
    assert.equal(r.status, 409, r.text); assert.equal(r.body.code, 'POST_REDACTED');
    await sleep(300);
    assert.deepEqual(scanTree(s.eventsDir, M), [], 'the refusal of the retry left no copy of the redacted text in the event log');
  });
});

test('W40 REFUSAL AUDITS ARE CONTENT-FREE FOR EVERY REFUSAL STATUS OF A CONVERSATION WRITE, not just POST_REDACTED: a 400 for a malformed requestId, a 400 for a bad attachment size, a 400 for an unknown card, a 400 for an unknown talk, a 409 for a requestId reused with different content and a 409 for a redacted key each leave an audit row (outcome, status, route) but NO copy of the refused post\'s text, attachment names or card ids; the audit is still useful (control: a refusal row exists for each)', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const mk = (n) => `mk${n}-obsidian-heron-${n * 7919}`;
    const first = await post(s.base, { author: 'ada', body: mk(0), requestId: 'rq-w40-a' }); assert.equal(first.status, 201, first.text);
    await sleep(200);
    const refusals = [
      ['malformed requestId', 400, { author: 'ada', body: mk(1), requestId: 'bad\nkey' }, [mk(1)]],
      ['bad attachment size', 400, { author: 'ada', body: mk(2), attachments: [{ id: 'f7a8.png', name: `${mk(2)}-name.png`, mime: 'image/png', size: -1 }] }, [mk(2)]],
      ['unknown card', 400, { author: 'ada', body: mk(3), attachedTo: '00000000-0000-4000-8000-0000000000aa' }, [mk(3)]],
      ['unknown talk', 400, { author: 'ada', body: mk(4), conversation: 'no-such-talk-w40' }, [mk(4)]],
      ['requestId reused with different content', 409, { author: 'ada', body: mk(5), requestId: 'rq-w40-a' }, [mk(5)]],
    ];
    for (const [label, status, body] of refusals) { const r = await post(s.base, body); assert.equal(r.status, status, `${label}: ${r.status} ${r.text}`); }
    await redactDirect(s, first.body.id);
    const red = await post(s.base, { author: 'ada', body: mk(0), requestId: 'rq-w40-a' }); assert.equal(red.status, 409, red.text); assert.equal(red.body.code, 'POST_REDACTED');
    await sleep(400);
    for (const m of [mk(0), mk(1), mk(2), mk(3), mk(4), mk(5), `${mk(2)}-name.png`, '00000000-0000-4000-8000-0000000000aa']) assert.deepEqual(scanTree(s.eventsDir, m), [], `the refusal audit holds no copy of ${m.slice(0, 24)}`);
    let rows = 0; const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else { try { rows += (fs.readFileSync(f, 'utf8').match(/"op":\s*"refused"/g) || []).length; } catch { /* unreadable */ } } } }; walk(s.eventsDir);
    assert.ok(rows >= 6, `control: the audit still records the refusals (outcome, status, route): ${rows} refused rows for 6 refusals`);
  });
});

test('W31 COMPACTION HAPPENS: an APPLIED reservation older than 7 days is dropped by the next reservation write (the map does not grow forever for keys the server confirmed), and its retry still replays with the original number. The server restarts between the confirmation and the aging, so this does not depend on anything held only in memory', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const k1 = await post(s.base, { author: 'ada', body: 'compact me', requestId: 'req-k1' }); assert.equal(k1.status, 201, k1.text);
    const k2 = await post(s.base, { author: 'ada', body: 'next reservation', requestId: 'req-k2' }); assert.equal(k2.status, 201, k2.text);   // the write after k1 was confirmed
    assert.ok(s.doc().postReservations?.['req-k1'], 'control: the reservation exists before it ages');
    await ageReservation(s, 'req-k1', 8);
    const k3 = await post(s.base, { author: 'ada', body: 'triggers the prune', requestId: 'req-k3' }); assert.equal(k3.status, 201, k3.text);
    assert.equal(s.doc().postReservations?.['req-k1'], undefined, 'the aged APPLIED reservation was compacted away');
    assert.ok(s.doc().postReservations?.['req-k3'], 'control: the new reservation was recorded');
    const replay = await post(s.base, { author: 'ada', body: 'compact me', requestId: 'req-k1' });
    assert.ok(okish(replay), replay.text); assert.equal(replay.body.id, k1.body.id); assert.equal(replay.body.postSeq, k1.body.postSeq, 'the retry replays from the graph with the ORIGINAL number');
    await noDuplicates(s);
  });
});

test('W32 TODO (not a row): the reservation map has a stated bound. Today an APPLIED key is only stamped by the NEXT reservation write in the same process, so applied keys not yet stamped at a restart are kept forever: the growth is unmeasured, not bounded. A row or a count on a copy replaces this', { todo: 'retained-reservation growth: unmeasured' }, () => {});

test('W20 TODO (not a row): measured post latency at the live post population, flag ON, with the reservation map holding 7 days of traffic. The number is required before R5; no estimate stands in for it', { todo: 'measured at live size before R5 (the #1596 shape)' }, () => {});
