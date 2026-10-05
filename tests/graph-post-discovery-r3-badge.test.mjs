/**
 * R3 T2 — THE UNREAD BADGE (`core/commons-panel.mjs`) UNDER GRAPH POSTS. Pre-registered by the separate test author BEFORE the badge moves. Copy unchanged into tests/.
 * REAL executor, a REAL flag-ON server, and the REAL `mountCommonsPanel` in jsdom (fetch is the real one, `baseUrl` is the server). Without a python with
 * pyoxigraph every test is SKIPPED, and a skip is NOT a pass.
 *
 * WHY (found by reading the module, confirmed by the builder): the badge polls `GET /api/conversations?limit=100&since=<createdAt cursor>` and advances its
 * cursor to the newest `createdAt` it has seen when the panel is opened. A graph post gets its `createdAt` at RESERVATION and becomes visible at COMMIT, so a
 * post whose write is slow can carry an EARLIER time than a post that overtook it. If the reader opens the panel in between, the cursor passes the slow post and
 * the badge never counts it. Under the document path reservation and visibility were one write, so this could not happen: R2 makes it reachable.
 * The direction is to page by COMMIT (R3's afterCommit). Whatever the mechanism, these rows pin what the reader sees.
 *
 * ROWS: B0 control (the badge as it behaves today on the document path); B1 the held post (held reservation, a later post commits, the reader opens the panel,
 * the held post commits: counted exactly once, never repeated); B2 MORE than a page of unseen posts (99+, nothing lost or doubled across the open); B3 a post
 * redacted before the badge looks is not counted, and redacting an UNREAD post removes it from the count (the owner's decision dd472a5f: hidden from lists and
 * counts); B4 the LEGACY-CURSOR MIGRATION POLICY (an existing timestamp cursor keeps the reader's unread posts, neither marking them seen nor stranding the badge); B5 a server restart between polls loses nothing.
 * NOT PINNED, BY NAME: the cursor's stored format and key (the module may keep SEEN_KEY or replace it); that the page makes one request per refresh; the
 * poll interval (the rows drive `refreshUnread()` by hand); the first-visit rule beyond "counts history as zero", which is today's.
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
import { JSDOM } from 'jsdom';
import { mountCommonsPanel, SEEN_KEY } from '../core/commons-panel.mjs';

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
    get base() { return srv.base; }, proxy, file, notified, get exec() { return exec; },
    doc: () => readDoc(file),
    dropReservation: (key) => { const { raw, ld, meta } = readDoc(file); if (meta.postReservations?.[key]) delete meta.postReservations[key]; else if (raw.postReservations?.[key]) delete raw.postReservations[key]; else assert.fail(`no reservation for ${key} to drop`); fs.writeFileSync(file, JSON.stringify(raw, null, 2)); },
    setCounter: (n) => { const { raw, ld } = readDoc(file); if (ld) (raw['scrum:meta'] ||= {}).nextPostSeq = n; else raw.nextPostSeq = n; fs.writeFileSync(file, JSON.stringify(raw, null, 2)); },
    restartServer: async () => { srv.stop(); srv = await spawnServer(file, proxy.url, { flag, notifyUrl }); },
    stopServer: () => srv.stop(), startServer: async () => { srv = await spawnServer(file, proxy.url, { flag, notifyUrl }); },
    killExecutor: async () => { await killExecutor(exec); }, startExecutor: async () => { exec = await startExecutor({ store, datasetId: DSID, create: false, port }); },
    replaceStore: async () => { await killExecutor(exec); exec = await startExecutor({ store: tmpStore('r2-store2-'), datasetId: DSID, create: true, port }); },
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

const mkStorage = (init = {}) => { const m = new Map(Object.entries(init)); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, dump: () => Object.fromEntries(m) }; };
function mountBadge(base, storage) {
  const dom = new JSDOM('<!doctype html><html><body><div data-page-shell><header class="shell-head"></header></div></body></html>', { url: `${base}/`, pretendToBeVisual: true });
  const panel = mountCommonsPanel(dom.window.document, { activeId: 'board', baseUrl: base, pollMs: 3600000, storage });
  assert.ok(panel, 'the badge mounted');
  const badge = dom.window.document.querySelector('[data-commons-unread]');
  const text = () => (badge.hasAttribute('hidden') ? '0' : badge.textContent.trim());
  return { panel, text, close: () => { panel.destroy(); dom.window.close(); }, doc: dom.window.document };
}
const refresh = async (b) => { await b.panel.refreshUnread(); await sleep(50); return b.text(); };
const openClose = (b) => { b.panel.open(); b.panel.close(); };

test('B0 CONTROL, the document path as it is today: a first visit adopts the room\'s end and counts 0; one new post counts 1; opening the panel clears it; nothing is recounted', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const b = mountBadge(s.base, mkStorage());
    try {
      assert.equal(await refresh(b), '0', 'first visit counts history as zero');
      const p = await post(s.base, { author: 'ada', body: 'one new post' }); assert.equal(p.status, 201, p.text);
      await sleep(1100);   // createdAt has millisecond resolution but the cursor comparison is strict: keep the control clear of that known class
      const q = await post(s.base, { author: 'ada', body: 'a second new post' }); assert.equal(q.status, 201, q.text);
      assert.equal(await refresh(b), '2', 'two new posts count 2');
      openClose(b); assert.equal(b.text(), '0', 'opening clears the badge');
      assert.equal(await refresh(b), '0', 'and nothing is recounted');
    } finally { b.close(); }
  }, { flag: false });
});

test('B1 THE HELD POST (T2): a post whose graph write is HELD is reserved first (earlier createdAt) and commits last; a later post commits meanwhile; the reader opens the panel (the cursor moves past the later post); then the held post commits. The badge counts the held post EXACTLY ONCE and a further refresh does not repeat it', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const b = mountBadge(s.base, mkStorage());
    try {
      assert.equal(await refresh(b), '0', 'first visit adopts the end');
      const h = s.proxy.hold();
      const slow = post(s.base, { author: 'ada', body: 'held first', requestId: 'req-held' }); slow.catch(() => {});
      const got = await Promise.race([h.arrived.then(() => true), sleep(10000).then(() => false)]); if (!got) { h.release(); assert.fail('the held write never reached the executor'); }
      await sleep(30);
      const overtaker = await post(s.base, { author: 'bea', body: 'committed first' }); assert.equal(overtaker.status, 201, overtaker.text);
      assert.equal(await refresh(b), '1', 'the post that committed is counted');
      openClose(b);                                                              // the reader looks: the cursor moves past the overtaker
      assert.equal(b.text(), '0');
      h.release(); const first = await slow; assert.equal(first.status, 201, first.text);
      assert.ok(first.body.createdAt < overtaker.body.createdAt, 'control: the held post carries the EARLIER time (this is the case the time cursor misses)');
      assert.equal(await refresh(b), '1', 'the held post is counted once it commits, although its createdAt is older than what the reader has seen');
      assert.equal(await refresh(b), '1', 'and a repeated refresh does not count it again');
      openClose(b); assert.equal(await refresh(b), '0', 'once seen it stays seen');
    } finally { b.close(); }
  });
});

test('B2 MORE THAN A PAGE OF UNSEEN POSTS: 150 posts after the last look show 99+; opening clears it with nothing lost; then exactly five more posts show 5 (not 0, not 105)', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const b = mountBadge(s.base, mkStorage());
    try {
      assert.equal(await refresh(b), '0');
      for (let i = 0; i < 150; i++) { const r = await post(s.base, { author: 'ada', body: `bulk ${i}` }); assert.equal(r.status, 201, r.text); }
      assert.equal(await refresh(b), '99+', 'a hundred and fifty unseen posts read as 99+');
      openClose(b); assert.equal(b.text(), '0');
      assert.equal(await refresh(b), '0', 'and none of the hundred and fifty is counted again');
      for (let i = 0; i < 5; i++) { const r = await post(s.base, { author: 'bea', body: `after ${i}` }); assert.equal(r.status, 201, r.text); }
      assert.equal(await refresh(b), '5', 'exactly the five newer posts count');
    } finally { b.close(); }
  });
});

test('B3 A POST REDACTED BEFORE THE BADGE LOOKS IS NOT COUNTED, and redacting an UNREAD post that was already counted REMOVES it from the count (the owner\'s decision dd472a5f: a redacted post is hidden from lists and counts)', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const b = mountBadge(s.base, mkStorage());
    try {
      assert.equal(await refresh(b), '0');
      const a = await post(s.base, { author: 'ada', body: 'to be redacted early' }); const keep = await post(s.base, { author: 'ada', body: 'stays visible' });
      assert.equal(a.status, 201, a.text); assert.equal(keep.status, 201, keep.text);
      await createGraphClient({ baseUrl: s.exec.baseUrl, expectedDatasetId: DSID }).update({ kind: 'post.redact', opId: `urn:ex:op/redact/${a.body.id}`, actor: `${PERSON}ada`, post: { id: a.body.id }, authorityRef: 'test-authority-ref', occurredAt: '2026-10-05T12:00:00.000Z' });
      assert.equal(await refresh(b), '1', 'only the visible post counts');
      const later = await post(s.base, { author: 'ada', body: 'counted then redacted' }); assert.equal(later.status, 201, later.text);
      assert.equal(await refresh(b), '2');
      await createGraphClient({ baseUrl: s.exec.baseUrl, expectedDatasetId: DSID }).update({ kind: 'post.redact', opId: `urn:ex:op/redact/${later.body.id}`, actor: `${PERSON}ada`, post: { id: later.body.id }, authorityRef: 'test-authority-ref', occurredAt: '2026-10-05T12:01:00.000Z' });
      assert.equal(await refresh(b), '1', 'redacting an UNREAD post removes it from the count (hidden tombstones, dd472a5f): no stale unread count is left behind');
      openClose(b); assert.equal(await refresh(b), '0');
    } finally { b.close(); }
  });
});

test('B4 LEGACY-CURSOR MIGRATION KEEPS THE READER\'S UNREAD POSTS (reconciled with the owner\'s 15-minute grace, `edf8f91c`, which supersedes the strict-after rule this row first pinned): a timestamp cursor already in a browser\'s storage is not stranded and not treated as "everything seen"; with the cursor set to the FIRST of three fresh posts, all three are inside the grace and count 3 (the first is a seen post counted once: the accepted cost, pinned by B9a); a post made after the upgrade counts on top; opening clears them once', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const posts = [];
    for (let i = 0; i < 3; i++) { const r = await post(s.base, { author: 'ada', body: `pre-upgrade ${i}` }); assert.equal(r.status, 201, r.text); posts.push(r.body); await sleep(15); }
    assert.ok(posts[0].createdAt < posts[1].createdAt && posts[1].createdAt < posts[2].createdAt, 'control: three posts with distinct, ordered times');
    const storage = mkStorage({ [SEEN_KEY]: posts[0].createdAt });                // the reader last looked when the first post existed
    const b = mountBadge(s.base, storage);
    try {
      assert.equal(await refresh(b), '3', 'all three are within 15 minutes of the legacy cursor: neither marked seen nor stranded behind the old format');
      const p = await post(s.base, { author: 'bea', body: 'after the upgrade' }); assert.equal(p.status, 201, p.text);
      assert.equal(await refresh(b), '4', 'a post made after the upgrade counts on top of them');
      openClose(b); assert.equal(await refresh(b), '0', 'opening clears all four, once');
    } finally { b.close(); }
  });
});

test('B5 A SERVER RESTART between polls loses nothing: posts made before the restart that the reader has not seen are still counted after it, once', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const storage = mkStorage(); let b = mountBadge(s.base, storage);
    try {
      assert.equal(await refresh(b), '0');
      for (let i = 0; i < 3; i++) { const r = await post(s.base, { author: 'ada', body: `before restart ${i}` }); assert.equal(r.status, 201, r.text); }
      b.close(); await s.restartServer(); b = mountBadge(s.base, storage);
      assert.equal(await refresh(b), '3', 'the three unseen posts survive a server restart, counted once');
      assert.equal(await refresh(b), '3', 'and a repeated refresh does not add to them');
    } finally { b.close(); }
  });
});

// ------------------------------------------------------------------ the limits the first build named
const importPost = async (s, p) => { const r = await createGraphClient({ baseUrl: s.exec.baseUrl, expectedDatasetId: DSID }).update({ kind: 'post.import', opId: `urn:ex:op/backfill/${p.id}`, actor: `${PERSON}board`, post: { id: p.id, body: p.body, author: p.author, createdAt: p.createdAt, attachedTo: null, mentions: [], postSeq: p.postSeq } }); assert.equal(r.outcome, 'APPLIED', JSON.stringify(r)); };
const redactId = async (s, id) => { const r = await createGraphClient({ baseUrl: s.exec.baseUrl, expectedDatasetId: DSID }).update({ kind: 'post.redact', opId: `urn:ex:op/redact/${id}`, actor: `${PERSON}ada`, post: { id }, authorityRef: 'test-authority-ref', occurredAt: '2026-10-05T12:00:00.000Z' }); assert.equal(r.outcome, 'APPLIED', JSON.stringify(r)); };

test('B6 NO CAP, EXACT COUNT: with MORE unread posts than any fixed list could hold (1,040), the count stays exact as most are redacted: redacting all but 90 scattered across the whole range leaves exactly `90`, whichever end a bounded list would have dropped', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const b = mountBadge(s.base, mkStorage());
    try {
      assert.equal(await refresh(b), '0');
      const posts = [];
      for (let i = 0; i < 1040; i++) { const r = await post(s.base, { author: 'ada', body: `bulk ${i}` }); assert.equal(r.status, 201, r.text); posts.push(r.body); }
      assert.equal(await refresh(b), '99+', 'over a thousand unread reads 99+');
      const keep = new Set(Array.from({ length: 90 }, (_, k) => Math.floor(k * 1040 / 90)));   // 90 survivors scattered over the whole range
      assert.equal(keep.size, 90, 'fixture: ninety distinct survivors');
      for (let i = 0; i < posts.length; i++) if (!keep.has(i)) await redactId(s, posts[i].id);
      assert.equal(await refresh(b), '90', 'exactly the survivors count: nothing was dropped by a cap and no redacted post is left in the count');
      openClose(b); assert.equal(await refresh(b), '0');
    } finally { b.close(); }
  });
});

test('B7 STORE RESYNC RECONCILES BY POST IDENTITY: the executor is replaced by a store with a NEW incarnation that holds some of the same posts (same ids and numbers) but not all; the badge recovers without marking unread posts seen: the posts still held are still counted, the missing one is dropped, a post made afterwards counts on top, opening clears them once', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const b = mountBadge(s.base, mkStorage());
    try {
      assert.equal(await refresh(b), '0');
      const posts = []; for (const t of ['A', 'B', 'C', 'D']) { const r = await post(s.base, { author: 'ada', body: `resync ${t}` }); assert.equal(r.status, 201, r.text); posts.push(r.body); await sleep(15); }
      assert.equal(await refresh(b), '4');
      await s.replaceStore();                                            // a new incarnation: every cursor of the old one must resync
      for (const i of [0, 1, 3]) await importPost(s, posts[i]);          // A, B, D survive the rewrite; C does not
      assert.equal(await refresh(b), '3', 'A, B and D are still unread (not silently marked seen, not forgotten), C is gone');
      const e = await post(s.base, { author: 'bea', body: 'after the resync' }); assert.equal(e.status, 201, e.text);
      assert.equal(await refresh(b), '4', 'a post made after the resync counts on top');
      openClose(b); assert.equal(await refresh(b), '0', 'and opening clears all four, once');
    } finally { b.close(); }
  });
});

test('B7b A REBUILT STORE MUST NOT ALIAS A SEEN POST: after the reader has SEEN a post, a store with a new incarnation holds a DIFFERENT post (another id) carrying the same postSeq; that post is NEW to the reader and is counted (matching on the number alone would read it as the post already seen)', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const b = mountBadge(s.base, mkStorage());
    try {
      assert.equal(await refresh(b), '0');
      const a = await post(s.base, { author: 'ada', body: 'seen before the rebuild' }); assert.equal(a.status, 201, a.text);
      assert.equal(await refresh(b), '1'); openClose(b); assert.equal(await refresh(b), '0', 'seen');
      await s.replaceStore();
      await importPost(s, { id: 'aliased-post-id-0001', body: 'a different post with the same number', author: 'bea', createdAt: new Date().toISOString(), postSeq: a.body.postSeq });
      assert.equal(await refresh(b), '1', 'the different post is counted: the same number is not the same post');
    } finally { b.close(); }
  });
});

// the 24-bit FNV-1a fingerprint that the first compact-membership build used (`c9b7942`): kept here ONLY to construct a deliberate collision against it. Against any
// other design the two ids are simply two different ids, and the row's expectation (they are told apart) is the same.
const fnv24 = (id) => { let h = 0x811c9dc5; const t = String(id); for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 8; };
const FNV_P = 0x01000193;
const FNV_INV = (() => { let x = FNV_P; for (let i = 0; i < 6; i++) x = Math.imul(x, (2 - Math.imul(FNV_P, x)) | 0) >>> 0; return x >>> 0; })();   // the multiplicative inverse mod 2^32
const ALPHA36 = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** An id `<prefix><5 chars>` whose 24-bit fingerprint equals `target`, found by meeting in the middle (3 free bytes forward, 2 backward over the free low 8 bits). */
const collidingId = (target, prefix) => {
  let h0 = 0x811c9dc5; for (const ch of prefix) { h0 ^= ch.charCodeAt(0); h0 = Math.imul(h0, FNV_P) >>> 0; }
  const fwd = new Map();
  for (const a of ALPHA36) for (const b of ALPHA36) for (const c of ALPHA36) { let h = h0; for (const ch of a + b + c) { h ^= ch.charCodeAt(0); h = Math.imul(h, FNV_P) >>> 0; } if (!fwd.has(h)) fwd.set(h, a + b + c); }
  for (let low = 0; low < 256; low++) {
    const H = ((target << 8) | low) >>> 0;
    for (const d of ALPHA36) for (const e of ALPHA36) {
      let h = ((Math.imul(H, FNV_INV) >>> 0) ^ e.charCodeAt(0)) >>> 0; h = ((Math.imul(h, FNV_INV) >>> 0) ^ d.charCodeAt(0)) >>> 0;
      const hit = fwd.get(h); if (hit) return prefix + hit + d + e;
    }
  }
  throw new Error('no collision found');
};

test('B7c IDENTITY IS EXACT, NOT PROBABILISTIC: after the reader has SEEN five posts and the store is replaced, the new store puts a DIFFERENT post at each seen number except one: an id that a 24-bit hash of the first build merges with the seen id (a deliberate collision), the same id in UPPERCASE, the id with `=` appended, the id with `=` prepended; the fifth is the very same post (control). The four different posts are counted; the identical one is not. Nothing canonicalizes, truncates or hashes an id into a seen set', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const b = mountBadge(s.base, mkStorage());
    try {
      assert.equal(await refresh(b), '0');
      const seen = []; for (let i = 0; i < 5; i++) { const r = await post(s.base, { author: 'ada', body: `seen ${i}` }); assert.equal(r.status, 201, r.text); seen.push(r.body); await sleep(15); }
      assert.equal(await refresh(b), '5'); openClose(b); assert.equal(await refresh(b), '0', 'all five are seen');
      assert.equal(seen[0].id, seen[0].id.toLowerCase(), 'fixture: generated ids are lowercase UUIDs, so the uppercase form is a different id');
      const variants = [collidingId(fnv24(seen[0].id), 'collide-'), seen[1].id.toUpperCase(), `${seen[2].id}=`, `=${seen[3].id}`];
      assert.equal(fnv24(variants[0]), fnv24(seen[0].id), 'fixture: the first variant IS a 24-bit hash collision with the seen id');
      assert.equal(new Set([...variants, ...seen.map((p) => p.id)]).size, 9, 'fixture: nine distinct ids');
      await s.replaceStore();
      const at = (i, id) => ({ id, body: `rebuilt ${i}`, author: 'bea', createdAt: seen[i].createdAt, postSeq: seen[i].postSeq });
      for (let i = 0; i < 4; i++) await importPost(s, at(i, variants[i]));
      await importPost(s, { id: seen[4].id, body: seen[4].body, author: seen[4].author, createdAt: seen[4].createdAt, postSeq: seen[4].postSeq });   // the very same post, same id, same number
      assert.equal(await refresh(b), '4', 'the four different posts at seen numbers are counted; the identical one is not');
      openClose(b); assert.equal(await refresh(b), '0');
    } finally { b.close(); }
  });
});

test('B8 A FAILING STORAGE WRITE does not break the badge: when setItem throws (private mode, quota), the badge still mounts, polls and shows the right count for the session, and never throws into the page', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const m = new Map(); let failing = false;
    const storage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { if (failing) throw new Error('QuotaExceededError'); m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
    const b = mountBadge(s.base, storage);
    try {
      assert.equal(await refresh(b), '0'); failing = true;
      for (let i = 0; i < 3; i++) { const r = await post(s.base, { author: 'ada', body: `quota ${i}` }); assert.equal(r.status, 201, r.text); }
      let shown; await assert.doesNotReject(async () => { shown = await refresh(b); });
      assert.equal(shown, '3', 'the count is right for the session even though nothing can be persisted');
      assert.doesNotThrow(() => openClose(b)); assert.equal(b.text(), '0');
    } finally { b.close(); }
  });
});

test('B9a LEGACY-CURSOR MIGRATION, THE OWNER\'S GRACE OF 15 MINUTES (decision edf8f91c): a legacy cursor is a TIME, so the badge counts the posts created within 15 minutes BEFORE it as well as after it. A held write across the migration is the case it exists for: a post reserved before the reader\'s last look and committed after it IS counted, and so is the post that overtook it (up to the grace of SEEN posts are counted once per browser: the accepted cost)', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    const h = s.proxy.hold();
    const slow = post(s.base, { author: 'ada', body: 'held across the upgrade', requestId: 'req-mig' }); slow.catch(() => {});
    const got = await Promise.race([h.arrived.then(() => true), sleep(10000).then(() => false)]); if (!got) { h.release(); assert.fail('the held write never reached the executor'); }
    await sleep(30);
    const overtaker = await post(s.base, { author: 'bea', body: 'committed before the last look' }); assert.equal(overtaker.status, 201, overtaker.text);
    await sleep(1100);
    const lastLook = new Date().toISOString();                                            // the reader\'s legacy cursor: AFTER both createdAt values
    h.release(); const first = await slow; assert.equal(first.status, 201, first.text);
    assert.ok(first.body.createdAt < lastLook && overtaker.body.createdAt < lastLook, 'control: both posts carry a time BEFORE the legacy cursor, and the held one committed AFTER it');
    const b = mountBadge(s.base, mkStorage({ [SEEN_KEY]: lastLook }));
    try {
      assert.equal(await refresh(b), '2', 'within the grace both are counted: the held write (a post the old rule would lose) and the post that overtook it (already seen: the accepted once-per-browser cost)');
      openClose(b); assert.equal(await refresh(b), '0');
    } finally { b.close(); }
  });
});

test('B9b THE GRACE IS A WINDOW, NOT ALL HISTORY: posts created more than 15 minutes before the legacy cursor are NOT counted (a cursor 16 minutes ahead of three fresh posts counts 0), and a cursor 14 minutes ahead still counts them; the residual (a post delayed longer than the grace) is the owner\'s accepted loss and is named, not tested', { skip: SKIP }, async () => {
  await stack(board(), async (s) => {
    for (let i = 0; i < 3; i++) { const r = await post(s.base, { author: 'ada', body: `window ${i}` }); assert.equal(r.status, 201, r.text); await sleep(15); }
    for (const [minutes, want] of [[16, '0'], [14, '3']]) {
      const cursor = new Date(Date.now() + minutes * 60000).toISOString();
      const b = mountBadge(s.base, mkStorage({ [SEEN_KEY]: cursor }));
      try { assert.equal(await refresh(b), want, `a legacy cursor ${minutes} minutes after the posts counts ${want}`); } finally { b.close(); }
    }
  });
});

test('B10 TODO (measurement, not a row): the one-off walk from the start for a legacy cursor is a full bootstrap per browser, and the serialized unread state has a size: measured at 36k posts in the real browser, with the page-visible cost and the localStorage bytes, before acceptance', { todo: 'measure: per-browser migration cost and stored size at 36k' }, () => {});
