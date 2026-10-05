/**
 * D1 / R1 SLICE — DELIVERIES OF A GRAPH-ONLY POST. Pre-registered by the separate test author BEFORE the existence check moves. Copy unchanged into tests/.
 * REAL executor (a python with pyoxigraph); without one every test is SKIPPED, and a skip is NOT a pass.
 *
 * WHY: with the conversations unit ON an ordinary post lives only in the graph, but `handleCreateDelivery` accepts a delivery only for a post the DOCUMENT
 * holds ("is not a message this board holds. A delivery of nothing is refused"). Every fan-out offer to a resident would be a 400, silently from its side.
 * The resident is a pull reader: it claims a delivery, then reads the post by id. This file pins the real slice end to end on the server side:
 *   offer (201) -> idempotent re-offer (200, the same inbox item) -> claim -> resolve by id; a redaction BEFORE resolution gives the tombstone; an unknown
 *   id is still refused; and a graph that cannot be read is a 503, never "the board does not hold it" and never a created delivery.
 * SINGLE-POST ANSWER for a redacted post (the owner's decision dd472a5f, status and shape frozen HERE): HTTP 200 in R3's tombstone shape,
 *   {id, postSeq, redacted: true, body: null} and NOTHING else that the post said (no author, time, attachments, mentions, card or talk).
 * NOT COVERED, BY NAME: the resident process itself (`scripts/guest-once.mjs`, a pull reader, read but not run here), the receiving seat's turn
 * (D1 rows against the real MCP client and presence plugin), and whether a delivery may be OFFERED for an already-redacted post (the room has not decided).
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

async function spawnServer(boardFile, execUrl, { flag = true, notifyUrl = '', noExecutor = false } = {}) {
  const port = await freePort();
  const env = { ...process.env, SCRUM_BOARD_FILE: boardFile, SCRUM_PORT: String(port), SCRUM_MCP_NOTIFY_URL: notifyUrl, SCRUM_ATTACHMENTS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'r2-attach-')),
    SCRUM_CHANNEL_CONFIG_FILE: path.join(os.tmpdir(), `r2-chan-${process.pid}-${port}.json`), SCRUM_INSTANCE_ID: `r2-${port}`,
    SCRUM_ROSTER_FILE: ROSTER_FILE, ...(noExecutor ? {} : { SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: execUrl }), ...(flag ? { SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' } : {}) };
  const child = spawn('node', ['server.js'], { cwd: PROJECT_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const err = []; child.stderr.on('data', (d) => err.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  await waitForHttp(`${base}/api/board`, 15000);
  return { base, stop: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, stderr: () => err.join('') };
}

async function stack(b, body, { flag = true, noExecutor = false } = {}) {
  const store = tmpStore('r2-store-');
  let exec = await startExecutor({ store, datasetId: DSID, create: true }); const port = exec.port;
  const proxy = await startProxy(exec.baseUrl);
  const notified = [];   // every announcement the server sends to the MCP side, captured by a local listener: {id (the post it names), body (if it carries one), raw, text}
  const notifier = http.createServer((req, res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => { try { const text = Buffer.concat(c).toString(); const raw = JSON.parse(text); const conv = raw?.conversation ?? raw; notified.push({ id: conv?.id ?? raw?.id ?? raw?.postId ?? null, body: conv?.body, raw, text }); } catch { /* not json */ } res.end('{}'); }); });
  await new Promise((r) => notifier.listen(0, '127.0.0.1', r)); const notifyUrl = `http://127.0.0.1:${notifier.address().port}/internal/notify`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-')); const file = path.join(dir, 'board.json'); fs.writeFileSync(file, JSON.stringify(b, null, 2));
  let srv = await spawnServer(file, proxy.url, { flag, notifyUrl, noExecutor });
  const gc = () => createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID });
  const s = {
    get base() { return srv.base; }, proxy, file, notified, get exec() { return exec; },
    doc: () => readDoc(file),
    dropReservation: (key) => { const { raw, ld, meta } = readDoc(file); if (meta.postReservations?.[key]) delete meta.postReservations[key]; else if (raw.postReservations?.[key]) delete raw.postReservations[key]; else assert.fail(`no reservation for ${key} to drop`); fs.writeFileSync(file, JSON.stringify(raw, null, 2)); },
    setCounter: (n) => { const { raw, ld } = readDoc(file); if (ld) (raw['scrum:meta'] ||= {}).nextPostSeq = n; else raw.nextPostSeq = n; fs.writeFileSync(file, JSON.stringify(raw, null, 2)); },
    restartServer: async () => { srv.stop(); srv = await spawnServer(file, proxy.url, { flag, notifyUrl, noExecutor }); },
    stopServer: () => srv.stop(), startServer: async () => { srv = await spawnServer(file, proxy.url, { flag, notifyUrl, noExecutor }); },
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

const offer = (s, to, conversation, by = 'board') => api(s.base, 'POST', '/api/deliveries', { by, to, conversation, source: 'fanout' });
const claim = (s, id, by) => api(s.base, 'POST', `/api/deliveries/${encodeURIComponent(id)}/events`, { by, state: 'claimed', source: 'guest-runner' });
const TOMB_KEYS = ['id', 'postSeq', 'redacted', 'body'];
const redactDirect = async (s, id) => { const red = await createGraphClient({ baseUrl: s.exec.baseUrl, expectedDatasetId: DSID }).update({ kind: 'post.redact', opId: `urn:ex:op/redact/${id}`, actor: `${PERSON}ada`, post: { id }, authorityRef: 'test-authority-ref', occurredAt: '2026-10-05T12:00:00.000Z' }); assert.equal(red.outcome, 'APPLIED', JSON.stringify(red)); };
const graphPost = async (s, body = 'graph only post') => { const r = await post(s.base, { author: 'ada', body }); assert.equal(r.status, 201, r.text); assert.equal(s.doc().conversations.length, BASE, 'control: the post is NOT in the document'); return r.body; };

test('DL0 flag OFF baseline: a delivery for a document post is created (201) and an unknown id is refused 400, exactly as today', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const ok = await offer(s, 'cy', 'd1'); assert.equal(ok.status, 201, ok.text); assert.equal(ok.body.state, 'offered');
    const bad = await offer(s, 'cy', '00000000-0000-4000-8000-000000000000'); assert.equal(bad.status, 400, bad.text);
  }, { flag: false });
});

test('DL1 A GRAPH-ONLY POST CAN BE OFFERED: the delivery is created (201, state offered) although the document holds no such conversation; a re-offer of the same (seat, post) is 200 and the SAME inbox item, never a second one', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const p = await graphPost(s);
    const a = await offer(s, 'cy', p.id); assert.equal(a.status, 201, `a post the graph holds is a message this board holds: ${a.status} ${a.text}`);
    assert.equal(a.body.state, 'offered');
    const b = await offer(s, 'cy', p.id); assert.equal(b.status, 200, b.text); assert.equal(b.body.id, a.body.id, 'the same inbox item');
    const other = await offer(s, 'bea', p.id); assert.equal(other.status, 201, other.text); assert.notEqual(other.body.id, a.body.id, 'another seat is another delivery');
    const list = await api(s.base, 'GET', '/api/deliveries'); assert.equal(list.status, 200, list.text);
    const mine = (list.body.deliveries || list.body).filter((d) => (d.conversation || d.ofConversation) === p.id);
    assert.equal(mine.length, 2, `two deliveries for the post (one per seat): ${JSON.stringify(mine).slice(0, 200)}`);
  });
});

test('DL2 AN UNKNOWN ID IS STILL REFUSED: an id that neither the document nor the graph holds is a 400 and creates nothing', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const p = await graphPost(s);
    assert.equal((await offer(s, 'cy', p.id)).status, 201, 'control: a known graph post is accepted, so the refusal below is about the id');
    const before = (await api(s.base, 'GET', '/api/deliveries')).text;
    const r = await offer(s, 'cy', '00000000-0000-4000-8000-000000000000'); assert.equal(r.status, 400, r.text);
    assert.equal((await api(s.base, 'GET', '/api/deliveries')).text, before, 'nothing was created');
  });
});

test('DL3 AN EMPTY DOCUMENT MUST NOT BECOME A SILENT FALLBACK: with the graph UNREADABLE, an offer for a post the graph holds is a 503 (not a 400 "the board does not hold it", not a 201) and creates nothing; once the graph is readable the same offer is a 201', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const p = await graphPost(s);
    s.proxy.down = true;
    const down = await offer(s, 'cy', p.id);
    assert.equal(down.status, 503, `an unreadable graph is unavailable, not "not held": ${down.status} ${down.text}`);
    s.proxy.down = false;
    const list = await api(s.base, 'GET', '/api/deliveries'); assert.equal(((list.body.deliveries || list.body) || []).length, 0, 'nothing was created while the graph was down');
    const up = await offer(s, 'cy', p.id); assert.equal(up.status, 201, up.text);
  });
});

test('DL4 THE RESIDENT SLICE: offer -> claim -> resolve by id. The offered delivery is claimed (one claimant wins, the second gets 409), and the claimant reads the post by id through GET /api/conversations/:id and gets the post', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const p = await graphPost(s, 'resolve me by id');
    const d = await offer(s, 'cy', p.id); assert.equal(d.status, 201, d.text);
    const c1 = await claim(s, d.body.id, 'cy'); assert.ok(c1.status === 200 || c1.status === 201, `claimed: ${c1.status} ${c1.text}`);
    const c2 = await claim(s, d.body.id, 'bea'); assert.equal(c2.status, 409, `a second claim is refused: ${c2.status} ${c2.text}`);
    const got = await api(s.base, 'GET', `/api/conversations/${p.id}`);
    assert.equal(got.status, 200, `the resident resolves the offered post by id: ${got.status} ${got.text}`);
    assert.equal(got.body.id, p.id); assert.equal(got.body.body, 'resolve me by id'); assert.equal(got.body.author, 'ada');
  });
});

test('DL5 REDACTION BEFORE RESOLUTION: after the offer and the claim, the post is redacted; the claimant\'s read by id answers 200 in the tombstone shape {id, postSeq, redacted:true, body:null} with NOTHING else the post said, never a 404 and never the text; an unknown id is still a 404', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const p = await graphPost(s, 'raven-slate-4419 to be redacted');
    const d = await offer(s, 'cy', p.id); assert.equal(d.status, 201, d.text);
    const c = await claim(s, d.body.id, 'cy'); assert.ok(c.status === 200 || c.status === 201, c.text);
    await redactDirect(s, p.id);
    const got = await api(s.base, 'GET', `/api/conversations/${p.id}`);
    assert.equal(got.status, 200, `a redacted post answers 200, not 404: ${got.status} ${got.text}`);
    assert.equal(got.body.id, p.id); assert.equal(got.body.redacted, true); assert.equal(got.body.body, null); assert.equal(got.body.postSeq, p.postSeq);
    for (const k of Object.keys(got.body)) assert.ok(TOMB_KEYS.includes(k) || k === 'commitSeq', `no field the post said: unexpected \`${k}\``);
    assert.ok(!got.text.includes('raven-slate-4419'), 'and no text');
    const unknown = await api(s.base, 'GET', '/api/conversations/00000000-0000-4000-8000-000000000000'); assert.equal(unknown.status, 404, unknown.text);
  });
});

// ------------------------------------------------------------------ the lookup's flag boundary and the two substrates
const importToGraph = async (s, doc) => { const r = await createGraphClient({ baseUrl: s.exec.baseUrl, expectedDatasetId: DSID }).update({ kind: 'post.import', opId: `urn:ex:op/backfill/${doc.id}`, actor: `${PERSON}board`, post: { id: doc.id, body: doc.body, author: doc.author, createdAt: doc.createdAt, attachedTo: null, mentions: [], postSeq: doc.postSeq } }); assert.equal(r.outcome, 'APPLIED', JSON.stringify(r)); };

test('DL6 FLAG OFF NEEDS NO EXECUTOR AT ALL: with the unit off and NO executor configured (no URL, no dataset), a document post is read by id (200) and offered (201), an unknown id is refused 400 and a missing id is a 404, exactly as today; nothing reaches the executor', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const got = await api(s.base, 'GET', '/api/conversations/d1'); assert.equal(got.status, 200, got.text); assert.equal(got.body.body, 'doc 1');
    assert.equal((await offer(s, 'cy', 'd1')).status, 201);
    assert.equal((await offer(s, 'cy', '00000000-0000-4000-8000-000000000000')).status, 400);
    assert.equal((await api(s.base, 'GET', '/api/conversations/00000000-0000-4000-8000-000000000000')).status, 404);
    assert.equal(s.proxy.requests, 0, 'the executor was never contacted');
  }, { flag: false, noExecutor: true });
});

test('DL7 BOTH SUBSTRATES, THE LIVE BOARD\'S SHAPE: a post held by the document AND by the graph (an imported post) that is then redacted in the graph reads as the TOMBSTONE by id: 200 {id, postSeq, redacted:true, body:null}, never the document\'s stale text', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const doc = s.doc().conversations.find((c) => c.id === 'd1') || s.doc().conversations[0];
    const id = doc.id; const text = doc.body;
    await importToGraph(s, { id, body: text, author: doc.author || 'ada', createdAt: doc.createdAt, postSeq: doc.postSeq });
    const before = await api(s.base, 'GET', `/api/conversations/${id}`); assert.equal(before.status, 200, before.text); assert.equal(before.body.body, text, 'control: before the redaction the post reads normally');
    await redactDirect(s, id);
    const got = await api(s.base, 'GET', `/api/conversations/${id}`);
    assert.equal(got.status, 200, got.text); assert.equal(got.body.redacted, true); assert.equal(got.body.body, null, 'not the document\'s stale text');
    assert.ok(!got.text.includes(text), 'no trace of the document copy');
    for (const k of Object.keys(got.body)) assert.ok(TOMB_KEYS.includes(k) || k === 'commitSeq', `no field the post said: \`${k}\``);
  });
});

test('DL8 AN UNREADABLE GRAPH NEVER FALLS THROUGH TO STALE DOCUMENT TEXT: with the unit on and the graph unreadable, a read by id of a post the DOCUMENT holds is a 503, not a 200 with the document copy and not a 404', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const ok = await api(s.base, 'GET', '/api/conversations/d1'); assert.equal(ok.status, 200, `control: readable graph, document-only post (the graph says absent): ${ok.text}`);
    s.proxy.down = true;
    const down = await api(s.base, 'GET', '/api/conversations/d1');
    assert.equal(down.status, 503, `unavailable, not a stale copy: ${down.status} ${down.text}`); assert.ok(!down.text.includes('doc 1'), 'and no document text');
  });
});

test('DL9 THE SAME FOR DELIVERY VALIDATION: with the unit on and the graph unreadable, an OFFER for a post the DOCUMENT holds is a 503 (never a 201 on the strength of the document copy, which may be a stale or unredacted one); once the graph is readable the same offer is a 201, and a document-only post stays offerable (graph absent -> document is a compatibility rule, not a claim that the document copy was redacted)', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    s.proxy.down = true;
    const down = await offer(s, 'cy', 'd1');
    assert.equal(down.status, 503, `unavailable, not a delivery created from a possibly-stale document copy: ${down.status} ${down.text}`);
    s.proxy.down = false;
    const list = await api(s.base, 'GET', '/api/deliveries'); assert.equal(((list.body.deliveries || list.body) || []).length, 0, 'nothing was created while the graph was down');
    const up = await offer(s, 'cy', 'd1'); assert.equal(up.status, 201, up.text);
  });
});

test('DL10 A NEW OFFER FOR AN ALREADY-REDACTED POST IS 409 POST_REDACTED (the room\'s ruling): no inbox item is created, whoever the seat; a post that was redacted before anyone offered it behaves the same', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const p = await graphPost(s, 'garnet-heron-6628 redacted before any offer');
    await redactDirect(s, p.id);
    for (const to of ['cy', 'bea']) {
      const r = await offer(s, to, p.id);
      assert.equal(r.status, 409, `a delivery of a redacted post is refused, not created: ${r.status} ${r.text}`); assert.equal(r.body.code, 'POST_REDACTED');
      assert.ok(!r.text.includes('garnet-heron-6628'), 'and the refusal carries no text');
    }
    const list = await api(s.base, 'GET', '/api/deliveries'); assert.equal(((list.body.deliveries || list.body) || []).length, 0, 'no inbox item exists for it');
    const q = await offer(s, 'cy', '00000000-0000-4000-8000-000000000000'); assert.equal(q.status, 400, 'control: an unknown id is still the old 400, so POST_REDACTED is its own answer');
  });
});

test('DL11 AN EXISTING DELIVERY OUTLIVES THE REDACTION and is told apart from a new offer: the post is offered and claimed, THEN redacted; an idempotent re-offer of that SAME (seat, post) is 200 and the same inbox item (not 409), a NEW seat\'s offer is 409 POST_REDACTED, the existing delivery keeps its claim and history and can still be advanced, and resolving the post by id gives the tombstone, never a 404', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const p = await graphPost(s, 'amber-newt-3351 offered then redacted');
    const d = await offer(s, 'cy', p.id); assert.equal(d.status, 201, d.text);
    const c = await claim(s, d.body.id, 'cy'); assert.ok(c.status === 200 || c.status === 201, c.text);
    await redactDirect(s, p.id);
    const again = await offer(s, 'cy', p.id);
    assert.equal(again.status, 200, `an idempotent re-offer of an EXISTING delivery is not a new offer: ${again.status} ${again.text}`); assert.equal(again.body.id, d.body.id, 'the same inbox item');
    const fresh = await offer(s, 'bea', p.id); assert.equal(fresh.status, 409, fresh.text); assert.equal(fresh.body.code, 'POST_REDACTED');
    const list = await api(s.base, 'GET', '/api/deliveries'); const mine = ((list.body.deliveries || list.body) || []).filter((x) => (x.conversation || x.ofConversation) === p.id);
    assert.equal(mine.length, 1, 'still exactly one delivery for the post');
    assert.ok(/claimed/.test(JSON.stringify(mine[0])), `its claim is still on record: ${JSON.stringify(mine[0]).slice(0, 240)}`);
    const next = await api(s.base, 'POST', `/api/deliveries/${encodeURIComponent(d.body.id)}/events`, { by: 'cy', state: 'declined', source: 'guest-runner' });
    assert.ok(next.status === 200 || next.status === 201, `the existing delivery can still be advanced: ${next.status} ${next.text}`);
    const got = await api(s.base, 'GET', `/api/conversations/${p.id}`);
    assert.equal(got.status, 200, `resolution gives the tombstone, not a 404: ${got.status} ${got.text}`); assert.equal(got.body.redacted, true); assert.equal(got.body.body, null);
  });
});
