/**
 * R1, THIN SLICE (#1602 rubric) — `GET /api/conversations` READS THE GRAPH WITH THE UNIT ON. Pre-registered by the separate test author BEFORE the read moves. Copy
 * unchanged into tests/. REAL executor; without a python with pyoxigraph every test is SKIPPED, and a skip is NOT a pass.
 *
 * WHY: with the unit on an ordinary post lives only in the graph, and the list route reads only the document, so a reader gets "3 new" and a room that shows
 * nothing new (seen in a real browser, 2026-10-05). The slice, as the builder proposed it and the contract owner confirmed: with the unit on the list is the
 * graph's posts MERGED with any document-only posts, through the SAME filters, order and count; a redacted post never appears (decision dd472a5f); an unreadable
 * graph is a 503, never a silent document-only list.
 *
 * HOW PARITY IS PINNED: one small corpus of 30 posts, answered twice. The BASELINE run holds all 30 in the document with the unit OFF and NO executor (today's
 * behaviour: the reference). The MIXED run splits the SAME posts: odd numbers only in the document, even numbers only in the graph, every seventh in BOTH (the
 * live board's shape), with the unit ON. Every query below must answer the same status, the same posts in the same order (supported fields) and the same
 * X-Total-Count. Parameters: none, limit (0, 5, over the cap), since (equal to a shared timestamp), before (strict), attachedTo (a card, `null`), author, q
 * (case-insensitive, body or author), mentions_me (case-insensitive), two combinations, and three refusals (an unknown card 404, a malformed talk 400).
 * Pinned beside parity: tombstones are omitted from the list AND the count (including a post the document still holds in plain text), an unreadable graph is a
 * 503, a post created through the API afterwards appears in order, and the unit OFF with no executor configured behaves as before.
 * DEFERRED WITH TRIGGERS, BY NAME (rubric): search, card comments, board status, people and `afterSeq`/`beforeSeq` paging (no caller uses them; the lossless
 * contract applies only to `afterSeq`); misses/stale-claims are decision-makers and are NOT deferred past the flag-on rehearsal; the full-corpus latency at 36k is
 * learned on the rehearsal copy (the document baseline is 55-138 ms for 36,243 posts, 8.7 MB); talk-tagged posts and attachments need their own fixtures.
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


const T0 = Date.parse('2026-10-01T12:00:00.000Z');
const N = 30;
// timestamps: one a minute, except posts 11-13 SHARE one (the equality edges of since and before)
const stamp = (i) => new Date(T0 + (i >= 11 && i <= 13 ? 11 : i) * 60000).toISOString();
const mkPost = (i) => ({ id: `p${i}`, body: `post ${i} ${i % 7 === 0 ? 'Zebra' : 'plain'}`, author: ['ada', 'bea', 'cy'][i % 3], attachedTo: i % 6 === 0 ? 'c1' : null, attachments: [], mentions: i % 5 === 0 ? ['bea'] : [], createdAt: stamp(i), postSeq: i });
const corpus = Array.from({ length: N }, (_, i) => mkPost(i + 1));
const card = { id: 'c1', shortId: 1, title: 'A card', description: 'body', type: 'task', assignees: ['ada'], labels: [], for: '', priority: 'p1', column: 'backlog', order: 0, createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z', relationships: { relatedTo: [], blockedBy: [] } };
const boardOf = (docPosts) => makeBoardFixture({ cards: [card], nextShortId: 2, conversations: docPosts, postSeqEpoch: EPOCH_DOC, nextPostSeq: N + 1 });
const importFull = async (s, p) => { const r = await createGraphClient({ baseUrl: s.exec.baseUrl, expectedDatasetId: DSID }).update({ kind: 'post.import', opId: `urn:ex:op/backfill/${p.id}`, actor: `${PERSON}board`, post: { id: p.id, body: p.body, author: p.author, createdAt: p.createdAt, attachedTo: p.attachedTo, mentions: p.mentions, postSeq: p.postSeq } }); assert.equal(r.outcome, 'APPLIED', JSON.stringify(r)); };
const redactPost = async (s, id) => { const r = await createGraphClient({ baseUrl: s.exec.baseUrl, expectedDatasetId: DSID }).update({ kind: 'post.redact', opId: `urn:ex:op/redact/${id}`, actor: `${PERSON}ada`, post: { id }, authorityRef: 'test-authority-ref', occurredAt: '2026-10-05T12:00:00.000Z' }); assert.equal(r.outcome, 'APPLIED', JSON.stringify(r)); };
const seed = async (s) => { for (const p of corpus) if (p.postSeq % 2 === 0 || p.postSeq % 7 === 0) await importFull(s, p); };      // the graph holds the even ones and every seventh
const mixedDoc = () => boardOf(corpus.filter((p) => p.postSeq % 2 === 1 || p.postSeq % 7 === 0));                                      // the document holds the odd ones and every seventh
const norm = (c) => ({ id: c.id, body: c.body, author: c.author, createdAt: c.createdAt, attachedTo: c.attachedTo ?? null, mentions: [...(c.mentions || [])].sort(), postSeq: c.postSeq, attachments: c.attachments || [], onBehalfOf: c.onBehalfOf ?? null });
const ask = async (s, qs) => { const r = await fetch(`${s.base}/api/conversations${qs}`); const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch { /* not json */ } return { status: r.status, total: r.headers.get('x-total-count'), body: Array.isArray(body) ? body.map(norm) : body, code: body && body.code }; };
const QUERIES = [
  ['none', ''], ['limit=5', '?limit=5'], ['limit=0', '?limit=0'], ['limit=500 (over the cap)', '?limit=500'],
  ['since = a shared timestamp (inclusive)', `?since=${encodeURIComponent(stamp(11))}`], ['before = a shared timestamp (strict)', `?before=${encodeURIComponent(stamp(11))}`],
  ['attachedTo=<card>', '?attachedTo=c1'], ['attachedTo=null', '?attachedTo=null'], ['author=bea', '?author=bea'],
  ['q=zebra', '?q=zebra'], ['q=ZEBRA (case)', '?q=ZEBRA'], ['q=ada (matches the author)', '?q=ada'], ['mentions_me=bea', '?mentions_me=bea'], ['mentions_me=BEA (case)', '?mentions_me=BEA'],
  ['author+since+limit', `?author=ada&since=${encodeURIComponent(stamp(4))}&limit=3`], ['since+before+q', `?since=${encodeURIComponent(stamp(3))}&before=${encodeURIComponent(stamp(20))}&q=post`],
  ['refusal: unknown card', '?attachedTo=c-missing'], ['refusal: unknown talk', '?conversation=no-such-talk'],
];

test('R1a PARITY: with the unit ON, a corpus split across the graph and the document (odd numbers in the document only, even in the graph only, every seventh in BOTH) answers every query exactly as the same corpus in the document alone with the unit OFF: same status, same posts in the same order, same X-Total-Count (the three refusals the same status and code)', { skip: SKIP }, async () => {
  const want = new Map();
  await stack(boardOf(corpus), async (s) => {
    for (const [label, qs] of QUERIES) want.set(label, await ask(s, qs));
    assert.equal(want.get('none').body.length, N, 'control: the baseline holds all thirty');
    assert.equal(want.get('refusal: unknown card').status, 404, 'control: the baseline refuses an unknown card');
    assert.equal(s.proxy.requests, 0, 'control: the baseline never touched an executor');
  }, { flag: false, noExecutor: true });
  await stack(mixedDoc(), async (s) => {
    await seed(s);
    const diffs = [];
    for (const [label, qs] of QUERIES) {
      const got = await ask(s, qs); const exp = want.get(label);
      if (got.status !== exp.status) { diffs.push(`${label}: status ${got.status} (want ${exp.status})`); continue; }
      if (exp.status !== 200) { if (got.code !== exp.code) diffs.push(`${label}: code ${got.code} (want ${exp.code})`); continue; }
      if (got.total !== exp.total) diffs.push(`${label}: X-Total-Count ${got.total} (want ${exp.total})`);
      if (JSON.stringify(got.body) !== JSON.stringify(exp.body)) diffs.push(`${label}: posts [${got.body.map((c) => c.id).join(',')}] (want [${exp.body.map((c) => c.id).join(',')}])`);
    }
    assert.deepEqual(diffs, [], `queries that differ from the document baseline:\n${diffs.join('\n')}`);
  });
});

test('R1b A TOMBSTONE IS OMITTED FROM THE LIST AND THE COUNT (decision dd472a5f), including a post the DOCUMENT still holds in plain text: redacting a graph-only post and a post held by both substrates removes both from `none`, from `q` matches on their former text, from `author`, and lowers X-Total-Count by two; the stale document copy is never served', { skip: SKIP }, async () => {
  await stack(mixedDoc(), async (s) => {
    await seed(s);
    const before = await ask(s, ''); assert.equal(before.body.length, N, 'control: all thirty before the redaction');
    await redactPost(s, 'p2');            // graph-only
    await redactPost(s, 'p14');           // in BOTH: the document still holds its text
    const after = await ask(s, '');
    assert.equal(after.status, 200); assert.equal(after.total, String(N - 2), 'the count falls by two');
    assert.deepEqual(after.body.map((c) => c.id), before.body.map((c) => c.id).filter((id) => id !== 'p2' && id !== 'p14'), 'both are gone and the order is otherwise unchanged');
    assert.deepEqual((await ask(s, '?q=zebra')).body.map((c) => c.id), before.body.filter((c) => /zebra/i.test(c.body) && c.id !== 'p14').map((c) => c.id), 'p14 matched `zebra` in the document: it must not any more');
    assert.ok(!JSON.stringify(after.body).includes('post 14 Zebra'), 'the document\'s stale text is nowhere in the answer');
  });
});

test('R1c AN UNREADABLE GRAPH IS A 503, NEVER A SILENT DOCUMENT-ONLY LIST: with the unit on and the graph unreadable, the list (with no parameters and with a limit) answers 503; once it is readable the full merged list is back', { skip: SKIP }, async () => {
  await stack(mixedDoc(), async (s) => {
    await seed(s);
    assert.equal((await ask(s, '')).body.length, N, 'control: the merged list is whole while the graph is readable');
    s.proxy.down = true;
    for (const qs of ['', '?limit=5']) { const r = await ask(s, qs); assert.equal(r.status, 503, `${qs || 'no params'}: ${r.status}`); }
    s.proxy.down = false;
    assert.equal((await ask(s, '')).body.length, N, 'and whole again afterwards');
  });
});

test('R1d A POST CREATED THROUGH THE API AFTERWARDS APPEARS, in order and counted: a new ordinary post (graph-only) is the last item of `none`, the last of `limit=3`, found by `author` and by `q`, and X-Total-Count rises by one', { skip: SKIP }, async () => {
  await stack(mixedDoc(), async (s) => {
    await seed(s);
    const r = await post(s.base, { author: 'ada', body: 'a fresh post about quokkas' }); assert.equal(r.status, 201, r.text);
    const all = await ask(s, ''); assert.equal(all.total, String(N + 1)); assert.equal(all.body.at(-1).id, r.body.id, 'last in order');
    assert.equal((await ask(s, '?limit=3')).body.at(-1).id, r.body.id);
    assert.ok((await ask(s, '?author=ada')).body.some((c) => c.id === r.body.id), 'found by author');
    assert.deepEqual((await ask(s, '?q=quokkas')).body.map((c) => c.id), [r.body.id], 'found by q');
    const seqs = all.body.map((c) => c.postSeq); assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'the merged order follows postSeq across both substrates');
  });
});

test('R1e THE UNIT OFF NEEDS NO EXECUTOR: with the unit off and no executor configured at all, the list answers as today (the thirty document posts, X-Total-Count 30) and nothing reaches an executor', { skip: SKIP }, async () => {
  await stack(boardOf(corpus), async (s) => {
    const r = await ask(s, ''); assert.equal(r.status, 200); assert.equal(r.body.length, N); assert.equal(r.total, String(N));
    assert.equal(s.proxy.requests, 0);
  }, { flag: false, noExecutor: true });
});
