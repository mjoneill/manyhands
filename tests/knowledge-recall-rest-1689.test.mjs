/**
 * #1689 — AMBIENT RECALL over REST, with the log-born unit and the conversations unit (the shape production runs), observe
 * auth with real seat credentials, a FAKE embedder that speaks Ollama's /api/embed shape (it never calls a model), and a
 * proxy in front of the executor that counts its queries.
 *
 * INTERFACE PINNED HERE:
 *   POST /api/recall { text, k? (1..5) } → 200 { available: true, bar, partial, items: [{ source: { title, url }, readingPage, readAt,
 *        why: { gist, quote, quoteTruncated?, claim }, score }], searched: { claims, embedded, sources }, means }
 *      | 200 { available: false, reason, items: [] }      (embedder down or late, log-born unit off, config invalid)
 *   GET /api/conversations/:id and each entry of GET /api/conversations may carry recall: { items } | { unavailable, gaveUp? };
 *        ABSENT when nothing surfaced or nothing was decided
 *   POST /api/recall/opened { run, post } → 200 { recorded } · 400 BAD_RUN_ID / BAD_POST_ID · 404 RECALL_POST_NOT_FOUND / RECALL_OFFER_NOT_FOUND
 *   GET /api/recall/counts[?since] → { offered, opened, postsWithRecall, unavailable, pendingRetries, gaveUp, since, means }
 *
 *   R0  the first call over more claims than one batch is partial and says how many are embedded; later calls finish the index
 *   R1  a hit above the bar: one item per source (its best claim), best first, with the sentence that matched; a miss is items:[]
 *   R2  a source whose url is in the text is left out; k caps the items; a bad text or k is a 400
 *   R3  the embedder down, or slower than deadlineMs: available:false with the reason, at the deadline
 *   U1  the log-born unit off: available:false naming it
 *   P1  a room post by a seat carries the reading it touches; the post answered at once, with the embedder slow
 *   P2  system posts, a service that is not a seat, short posts and card posts get nothing, and are not computed
 *   P3  the quiet rule through REST: N carries the source, N+1…N+20 do not, N+21 does
 *   P4  an untouched post's GET and LIST text are the same before and after recall exists; no `recall` key
 *   P5  the read routes ask the executor and the embedder nothing more for a post with recall than for one without
 *   P6  a post whose recall could not be computed is retried by a later post and then carries its items
 *   K1  opened: validated, 404 for an unknown post or an offer that was not made; counts move
 *   L1  latency: POST /api/conversations with recall on vs a post that gets none (printed)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { HAVE_PY } from './helpers/graph-executor-proc.mjs';
import { wholeBoardWorld } from './helpers/whole-board-1645.mjs';
import { startRestServer } from './helpers/harness.mjs';
import { WRITE_PROTOCOL, WRITE_PROTOCOL_HEADER } from '../core/graph-client.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';
import { readRecallConfig } from '../core/knowledge-recall.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 300000 };
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RS = 'https://scrumboard.local/ns#';
const PROV = 'http://www.w3.org/ns/prov#';
const SCHEMA = 'https://schema.org/';
const CFG = readRecallConfig();
assert.ok(CFG.ok, `PRECONDITION: the tracked config is valid (${CFG.error})`);

const SEATS = { 'seat-a': 'admin', 'seat-b': 'admin' };
const ROSTER = path.join(os.tmpdir(), `kr1689-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER, JSON.stringify({ seats: { 'seat-a': { name: 'A', glyph: 'a', color: '#7cc4a0' }, 'seat-b': { name: 'B', glyph: 'b', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const TOK = Object.fromEntries(Object.keys(SEATS).map((s) => [s, mintToken()]));
const TOKENS = path.join(os.tmpdir(), `kr1689-tokens-${process.pid}.json`);
{
  const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  fs.writeFileSync(TOKENS, JSON.stringify({ seats: Object.fromEntries(Object.entries(SEATS).map(([s, scope]) => [s, { credentials: [{ tokenHash: hashToken(TOK[s]), scope, issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null }] }])) }));
}
after(() => { for (const f of [ROSTER, TOKENS]) fs.rmSync(f, { force: true }); });

// ── the fake embedder: a word's count on its own axis, so every score below is computed by hand ───────────────────────────
const AX = ['kiwi', 'melon', 'plum', 'fig', 'pear', 'quince', 'lime', 'grape', 'olive'];
const fakeVec = (t) => { const s = String(t).toLowerCase(); const v = AX.map((w) => (s.match(new RegExp(`\\b${w}\\b`, 'g')) || []).length); return v.some(Boolean) ? [...v, 0] : [...AX.map(() => 0), 1]; };
function fakeEmbedder() {
  const st = { calls: 0, mode: 'pass', delayMs: 0, server: null };
  st.server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      st.calls += 1;
      const body = JSON.parse(raw);
      if (st.mode === 'down') { res.writeHead(500); return res.end('injected'); }
      if (st.mode === 'slow') await new Promise((r) => setTimeout(r, st.delayMs));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ model: body.model, embeddings: body.input.map(fakeVec) }));
    });
  });
  return { st, start: () => new Promise((r) => st.server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${st.server.address().port}/api/embed`))), stop: () => new Promise((r) => { st.server.closeAllConnections?.(); st.server.close(() => r()); }) };
}
// ── the executor proxy: counts queries, and the recall claims query on its own ────────────────────────────────────────────
const isClaimsRead = (b) => b.includes(`${RS}Assertion`) && b.includes(`${RS}op`) && b.includes(`${PROV}used`) && b.includes(`${RS}gist`) && !b.includes('VALUES');
function executorProxy() {
  const st = { queries: 0, claimsReads: 0, server: null };
  const start = (execUrl) => new Promise((resolve) => {
    st.server = http.createServer((req, res) => {
      const chunks = []; req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);
        const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length'].includes(k)));
        try {
          if (req.method === 'POST' && req.url.startsWith('/query')) { st.queries += 1; if (isClaimsRead(body.toString())) st.claimsReads += 1; }
          const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers, body: req.method === 'GET' ? undefined : body });
          const t = await f.text();
          res.writeHead(f.status, { 'content-type': f.headers.get('content-type') || 'application/json' }); res.end(t);
        } catch { try { req.socket.destroy(); } catch { /* gone */ } }
      });
    });
    st.server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${st.server.address().port}`));
  });
  return { st, start, stop: () => new Promise((r) => (st.server ? st.server.close(() => r()) : r())) };
}

let w, emb, proxy;
before(async () => {
  if (SKIP) return;
  emb = fakeEmbedder();
  const url = await emb.start();
  proxy = executorProxy();
  // SEARCH_MAX_EMBED 2: an existing setting, set small so the batching and `partial` are visible with a handful of claims
  w = await wholeBoardWorld({ logborn: true, front: proxy.start, env: { SCRUM_ROSTER_FILE: ROSTER, SCRUM_SEAT_TOKENS: TOKENS, SCRUM_AUTH: '', SEARCH_EMBED_URL: url, SEARCH_EMBED_MODEL: 'fake-embed', SEARCH_MAX_EMBED: '2' } });
});
after(async () => { if (w) await w.stop(); if (proxy) await proxy.stop(); if (emb) await emb.stop(); });

const call = async (method, route, payload, { seat = 'seat-a', base = w?.rest.baseUrl } = {}) => {
  const headers = { ...(seat ? { authorization: `Bearer ${TOK[seat]}` } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) };
  const t0 = performance.now();
  const x = await fetch(`${base}${route}`, { method, headers, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(60000) });
  const t = await x.text(); const ms = performance.now() - t0;
  let j = null; try { j = JSON.parse(t); } catch { /* not json */ } return { status: x.status, text: t, json: j, ms };
};
const recall = (text, extra = {}) => call('POST', '/api/recall', { text, ...extra });
const uuid = () => crypto.randomUUID();
const L = (s) => JSON.stringify(String(s));
const FILL = ' and that is what we were saying about the thing in the room this afternoon, more or less.';
const long = (words) => `${words}${FILL}`;
assert.ok(long('x').length >= CFG.minChars, 'PRECONDITION: the filler makes a post long enough');

async function seed(triples) {
  const ep = (await (await fetch(`${w.exec.baseUrl}/health`)).json()).epoch;
  const res = await fetch(`${w.exec.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': `urn:ex:op/seed-${uuid()}`, 'x-epoch': String(ep), 'content-type': 'application/sparql-update', [WRITE_PROTOCOL_HEADER]: WRITE_PROTOCOL },
    body: `INSERT DATA { ${triples} }` });
  assert.equal(res.status, 200, `fixture applied (${await res.text()})`);
}
/** One extraction run over one source, written the way the extractor leaves it. `claims` are { gist, quote }. */
async function seedRun({ title, url, claims }) {
  const id = `run-${uuid()}`;
  const run = `https://scrumboard.local/activity/${id}`;
  const src = `https://scrumboard.local/source/${crypto.createHash('sha256').update(uuid()).digest('hex')}`;
  const at = new Date().toISOString();
  const t = [`<${src}> <${RDF}type> <${RS}SourceVersion> ; <${SCHEMA}url> ${L(url)} ; <${SCHEMA}name> ${L(title)} .`,
    `<${run}> <${RDF}type> <${PROV}Activity> ; <${RS}op> "extract" ; <${PROV}used> <${src}> .`,
    `<${run}/extraction> <${RDF}type> <${RS}ExtractionReport> ; <${RS}ofRun> <${run}> ; <${RS}outcome> "complete" ; <${RS}at> ${L(at)} .`];
  const ids = claims.map((c) => {
    const a = `https://scrumboard.local/assertion/${uuid()}`;
    t.push(`<${a}> <${RDF}type> <${RS}Assertion> ; <${RS}ofRun> <${run}> ; <${RS}anchorText> ${L(c.quote ?? c.gist)}${c.gist ? ` ; <${RS}gist> ${L(c.gist)}` : ''} .`);
    return a;
  });
  await seed(t.join('\n'));
  return { id, run, src, ids, at };
}
const posted = async (author, body, extra = {}, seat = author in SEATS ? author : null) => {
  const r = await call('POST', '/api/conversations', { author, body, ...extra }, { seat });
  assert.equal(r.status, 201, r.text);
  return r;
};
/** Wait until a post's GET carries `recall` (or the time runs out). The hook runs after the answer, so this polls. */
async function recallOf(id, { ms = 20000 } = {}) {
  const until = Date.now() + ms;
  for (;;) {
    const g = await call('GET', `/api/conversations/${id}`);
    if (g.json?.recall || Date.now() > until) return g;
    await new Promise((r) => setTimeout(r, 100));
  }
}
/** The hook is a serial queue: once a LATER eligible post is decided, every earlier one (and its retries) has been too. A post
 *  where nothing surfaced is absent from every read, so this waits on the state file itself, in the server's data folder. */
async function settle() {
  const s = await posted('seat-b', long('lime lime'));   // lime matches nothing seeded
  const file = path.join(path.dirname(w.boardFile), 'recall-state.json');
  const until = Date.now() + 20000;
  for (;;) {
    let has = false;
    try { has = Object.hasOwn(JSON.parse(fs.readFileSync(file, 'utf8')).posts, s.json.id); } catch { /* not written yet */ }
    if (has) return s;
    assert.ok(Date.now() < until, 'the marker post was decided within 20 s');
    await new Promise((r) => setTimeout(r, 50));
  }
}

let kiwi, plum;
test('R0 the first call over more claims than one batch is partial and says so; later calls finish the index', T, async () => {
  kiwi = await seedRun({ title: 'The kiwi book', url: 'https://example.com/kiwi', claims: [{ gist: 'kiwi', quote: 'All about the kiwi.' }, { gist: 'kiwi melon', quote: 'Kiwi beside melon.' }] });
  plum = await seedRun({ title: 'The plum paper', url: 'https://example.com/plum', claims: [{ gist: null, quote: 'plum plum plum' }] });
  const r = await recall('kiwi');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.available, true);
  assert.deepEqual(r.json.searched, { claims: 3, embedded: 2, sources: 2 });
  assert.equal(r.json.partial, true);
  const r2 = await recall('kiwi');
  assert.deepEqual(r2.json.searched, { claims: 3, embedded: 3, sources: 2 });
  assert.equal(r2.json.partial, false);
});

test('R1 a hit: one item per source, its best claim, with the sentence; a miss is items:[]', T, async () => {
  const r = await recall('kiwi kiwi plum plum');   // kiwi→0.707 (the "kiwi" claim beats "kiwi melon" at 0.5); plum (by its quote, no gist)→0.707
  assert.equal(r.json.available, true);
  assert.equal(r.json.bar, CFG.minScore);
  assert.equal(r.json.items.length, 2);
  const byTitle = Object.fromEntries(r.json.items.map((i) => [i.source.title, i]));
  assert.deepEqual(byTitle['The kiwi book'], { source: { title: 'The kiwi book', url: 'https://example.com/kiwi' }, readingPage: `/reading.html?run=${kiwi.id}`, readAt: kiwi.at,
    why: { gist: 'kiwi', quote: 'All about the kiwi.', claim: kiwi.ids[0] }, score: 0.707 });
  assert.equal(byTitle['The plum paper'].why.gist, null, 'a claim with no gist is matched by its quote');
  const miss = await recall('pear pear quince');
  assert.equal(miss.status, 200);
  assert.deepEqual({ available: miss.json.available, items: miss.json.items }, { available: true, items: [] }, 'the search ran; nothing cleared the bar');
  assert.ok(typeof miss.json.means === 'string' && miss.json.means.length > 40);
});

test('R2 own url excluded; k caps; bad text or k is a 400', T, async () => {
  const own = await recall('kiwi plum plum, see https://example.com/kiwi');   // the url's own "kiwi" is the second kiwi
  assert.deepEqual(own.json.items.map((i) => i.source.title), ['The plum paper']);
  const one = await recall('kiwi kiwi plum plum', { k: 1 });
  assert.equal(one.json.items.length, 1);
  assert.equal((await recall('   ')).json.code, 'BAD_TEXT');
  assert.equal((await recall('kiwi', { k: 6 })).json.code, 'BAD_K');
  assert.equal((await recall('kiwi', { k: 0 })).status, 400);
});

test('R3 the embedder down, or slower than the deadline: available:false with the reason, at the deadline', T, async () => {
  emb.st.mode = 'down';
  try {
    const r = await recall('kiwi');
    assert.deepEqual({ status: r.status, available: r.json.available, items: r.json.items }, { status: 200, available: false, items: [] });
    assert.match(r.json.reason, /embedder/);
    emb.st.mode = 'slow'; emb.st.delayMs = CFG.deadlineMs + 2000;
    const s = await recall('kiwi');
    assert.equal(s.json.available, false); assert.match(s.json.reason, new RegExp(`within ${CFG.deadlineMs} ms`));
    assert.ok(s.ms < CFG.deadlineMs + 1500, `answered at the deadline (${Math.round(s.ms)} ms), not when the embedder finished`);
  } finally { emb.st.mode = 'pass'; emb.st.delayMs = 0; }
});

test('U1 the log-born unit off: available:false naming it (and no embedder call)', async () => {
  const e = fakeEmbedder(); const url = await e.start();
  const srv = await startRestServer({ env: { SEARCH_EMBED_URL: url, SEARCH_EMBED_MODEL: 'fake-embed' } });
  try {
    const r = await call('POST', '/api/recall', { text: 'kiwi' }, { seat: null, base: srv.baseUrl });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual({ available: r.json.available, items: r.json.items }, { available: false, items: [] });
    assert.match(r.json.reason, /log-born unit/);
    assert.equal(e.st.calls, 0);
  } finally { await srv.stop(); await e.stop(); }
});

test('P1 a room post by a seat carries the reading it touches, and its answer did not wait for the embedder', T, async () => {
  emb.st.mode = 'slow'; emb.st.delayMs = 2500;
  let p;
  try {
    p = await posted('seat-a', long('kiwi kiwi kiwi'));
    assert.ok(p.ms < 1500, `the post answered in ${Math.round(p.ms)} ms with a 2500 ms embedder`);
    assert.equal('recall' in p.json, false, 'the post\'s own answer is unchanged');
  } finally { /* the slow mode stays until the recall lands */ }
  const g = await recallOf(p.json.id);
  emb.st.mode = 'pass'; emb.st.delayMs = 0;
  assert.equal(g.json.recall.items.length, 1);
  assert.equal(g.json.recall.items[0].source.title, 'The kiwi book');
  assert.equal(g.json.recall.items[0].why.quote, 'All about the kiwi.');
  const list = await call('GET', '/api/conversations?limit=5');
  assert.deepEqual(list.json.find((x) => x.id === p.json.id).recall, g.json.recall, 'the LIST entry carries the same field');
  const again = await call('GET', `/api/conversations/${p.json.id}`);
  assert.equal(again.text, g.text, 'a re-read gives the same answer');
});

test('P2 system posts, a non-seat service, short posts and card posts get nothing and are not computed', T, async () => {
  const before = proxy.st.claimsReads;
  const sys = await posted('board', long('kiwi kiwi kiwi'));
  const svc = await posted('extractor', long('kiwi kiwi kiwi'));
  const short = await posted('seat-a', 'kiwi kiwi kiwi');
  const onCard = await posted('seat-a', long('kiwi kiwi kiwi'), { attachedTo: 'uuid-1' });
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(proxy.st.claimsReads, before, 'no recall was computed for any of them');
  for (const p of [sys, svc, short, onCard]) {
    const g = await call('GET', `/api/conversations/${p.json.id}`);
    assert.equal(g.status, 200);
    assert.equal('recall' in g.json, false, `${p.json.author}: ${p.json.body.slice(0, 20)}`);
  }
});

test('P3 the quiet rule: N carries the source, N+1…N+20 do not, N+21 does', T, async () => {
  const fig = await seedRun({ title: 'The fig essay', url: 'https://example.com/fig', claims: [{ gist: 'fig', quote: 'Figs.' }] });
  await recall('fig');   // embed it before the posts start
  const first = await posted('seat-a', long('fig fig'));
  const n = first.json.postSeq;
  assert.equal((await recallOf(first.json.id)).json.recall.items[0].source.title, 'The fig essay');
  const quiet = [];
  for (let i = 1; i <= CFG.quietPosts; i++) quiet.push(await posted(i % 2 ? 'seat-a' : 'seat-b', long('fig fig')));
  const back = await posted('seat-a', long('fig fig'));
  assert.equal(back.json.postSeq, n + CFG.quietPosts + 1, 'PRECONDITION: no other post interleaved');
  assert.equal((await recallOf(back.json.id)).json.recall.items[0].source.title, 'The fig essay', 'N+21 carries it again');
  for (const q of quiet) assert.equal('recall' in (await call('GET', `/api/conversations/${q.json.id}`)).json, false, `post ${q.json.postSeq} is quiet`);
  void fig;
});

let untouched;
test('P4 an untouched post: GET and LIST text unchanged after recall exists elsewhere, and no recall key', T, async () => {
  untouched = await posted('seat-b', 'a short one, under minChars');
  const g0 = await call('GET', `/api/conversations/${untouched.json.id}`);
  const l0 = await call('GET', `/api/conversations?author=seat-b&limit=1`);
  const withOne = await posted('seat-a', long('kiwi kiwi melon'));
  await recallOf(withOne.json.id);
  const g1 = await call('GET', `/api/conversations/${untouched.json.id}`);
  assert.equal(g1.text, g0.text, 'byte for byte');
  assert.equal(g1.text.includes('"recall"'), false);
  // the LIST: the same window read again (seat-b's newest is still the untouched post)
  const l1 = await call('GET', `/api/conversations?author=seat-b&limit=1`);
  assert.equal(l1.text, l0.text);
});

test('P5 the read routes ask the executor and the embedder nothing more for a post with recall', T, async () => {
  const withR = await posted('seat-a', long('plum plum'));
  await recallOf(withR.json.id);
  await settle();
  const cost = async (id) => {
    const q0 = proxy.st.queries, e0 = emb.st.calls, c0 = proxy.st.claimsReads;
    const g = await call('GET', `/api/conversations/${id}`);
    return { q: proxy.st.queries - q0, e: emb.st.calls - e0, c: proxy.st.claimsReads - c0, has: 'recall' in g.json };
  };
  const a = await cost(withR.json.id); const b = await cost(untouched.json.id);
  assert.equal(a.has, true); assert.equal(b.has, false);
  assert.deepEqual([a.q, a.e, a.c], [b.q, 0, 0], `GET one: ${JSON.stringify({ withRecall: a, without: b })}`);
  const q0 = proxy.st.queries, e0 = emb.st.calls, c0 = proxy.st.claimsReads;
  const l = await call('GET', '/api/conversations?limit=50');
  assert.ok(l.json.some((x) => x.recall), 'the list carries recall');
  assert.deepEqual([emb.st.calls - e0, proxy.st.claimsReads - c0], [0, 0], 'the list asks the embedder nothing and never reads the claims');
  const lq = proxy.st.queries - q0;
  const l2q0 = proxy.st.queries;
  await call('GET', '/api/conversations?author=board&limit=50');   // the same route and shape over posts that carry none
  assert.equal(lq, proxy.st.queries - l2q0, 'the same executor queries as a list with no recall on it');
});

test('P6 unavailable, then retried by a later post: the earlier post carries its items', T, async () => {
  emb.st.mode = 'down';
  const early = await posted('seat-a', long('quince quince'));
  const g = await recallOf(early.json.id);
  assert.match(g.json.recall.unavailable, /embedder/);
  emb.st.mode = 'pass';
  await seedRun({ title: 'The quince letter', url: 'https://example.com/quince', claims: [{ gist: 'quince', quote: 'Quince.' }] });
  await recall('quince');   // the new claim is embedded
  await settle();           // a later post that succeeds retries the earlier one
  const after = await call('GET', `/api/conversations/${early.json.id}`);
  assert.deepEqual(after.json.recall.items.map((i) => i.source.title), ['The quince letter']);
});

test('K1 opened: validated, 404 for an unknown post or an offer that was not made; counts move', T, async () => {
  await seedRun({ title: 'The grape list', url: 'https://example.com/grape', claims: [{ gist: 'grape', quote: 'Grapes.' }] });
  await recall('grape');   // embedded before the post (kiwi would be quiet here: it surfaced within the last 20 posts)
  const p = await posted('seat-a', long('grape grape'));
  const g = await recallOf(p.json.id);
  assert.ok(g.json.recall?.items?.length, g.text);
  const run = g.json.recall.items[0].readingPage.split('run=')[1];
  const c0 = (await call('GET', '/api/recall/counts')).json;
  assert.equal((await call('POST', '/api/recall/opened', { run: 'run-nope', post: p.json.id })).json.code, 'BAD_RUN_ID');
  assert.equal((await call('POST', '/api/recall/opened', { run, post: 'not a post' })).json.code, 'BAD_POST_ID');
  const unknown = await call('POST', '/api/recall/opened', { run, post: uuid() });
  assert.deepEqual([unknown.status, unknown.json.code], [404, 'RECALL_POST_NOT_FOUND']);
  const notOffered = await call('POST', '/api/recall/opened', { run: `run-${uuid()}`, post: p.json.id });
  assert.deepEqual([notOffered.status, notOffered.json.code], [404, 'RECALL_OFFER_NOT_FOUND']);
  const ok = await call('POST', '/api/recall/opened', { run, post: p.json.id });
  assert.deepEqual([ok.status, ok.json.recorded], [200, true]);
  const c1 = (await call('GET', '/api/recall/counts')).json;
  assert.equal(c1.opened, c0.opened + 1);
  assert.ok(c1.offered >= 4 && c1.postsWithRecall >= 4, JSON.stringify(c1));
  for (const k of ['unavailable', 'pendingRetries', 'gaveUp']) assert.equal(typeof c1[k], 'number');
  assert.equal(c1.since, null);
  const later = (await call('GET', `/api/recall/counts?since=${encodeURIComponent(new Date(Date.now() + 3600_000).toISOString())}`)).json;
  assert.deepEqual([later.offered, later.opened, later.postsWithRecall], [0, 0, 0]);
  assert.equal((await call('GET', '/api/recall/counts?since=yesterday')).json.code, 'BAD_SINCE');
});

test('K2 a seat\'s read of a post with a reading is counted once; no credential is not attributed; the list counts nothing; the read costs the same', T, async () => {
  // a source of its own: every earlier one surfaced within the last quietPosts posts
  await seedRun({ title: 'The olive grove', url: 'https://example.com/olive', claims: [{ gist: 'olive', quote: 'Olives.' }] });
  await recall('olive');
  const q = await posted('seat-a', long('olive olive'));
  const g = await recallOf(q.json.id);
  assert.ok(g.json.recall?.items?.length, g.text);
  const seats0 = (await call('GET', '/api/recall/counts')).json.seats;
  const before = (k) => seats0[k]?.readCarrying ?? 0;
  const cost = async (seat) => {
    const q0 = proxy.st.queries, e0 = emb.st.calls;
    const r = await call('GET', `/api/conversations/${q.json.id}`, null, { seat });
    return { q: proxy.st.queries - q0, e: emb.st.calls - e0, ms: r.ms, text: r.text };
  };
  const anon = await cost(null);
  const b1 = await cost('seat-b'); const b2 = await cost('seat-b'); const b3 = await cost('seat-b');
  assert.deepEqual([b1.q, b1.e], [anon.q, anon.e], `a seat's read asks nothing more than an anonymous one: ${JSON.stringify({ anon: anon.q, seat: b1.q })}`);
  assert.equal(b1.text, anon.text, 'and answers the same bytes');
  await call('GET', '/api/conversations?limit=20', null, { seat: 'seat-a' });   // the list is not a read of a post
  const c = (await call('GET', '/api/recall/counts')).json;
  assert.equal((c.seats['seat-b']?.readCarrying ?? 0) - before('seat-b'), 1, 'three reads, counted once');
  assert.equal((c.seats['seat-a']?.readCarrying ?? 0) - before('seat-a'), 0, 'the list and the anonymous read count nothing');
  console.log(`# K2 GET /api/conversations/:id ms: anonymous ${anon.ms.toFixed(1)}, seat ${[b1, b2, b3].map((x) => x.ms.toFixed(1)).join('/')}`);
  // an opening with a seat is attributed; the browser's (no credential) counts in opened only
  const run = g.json.recall.items[0].readingPage.split('run=')[1];
  const o0 = c.opened;
  assert.equal((await call('POST', '/api/recall/opened', { run, post: q.json.id }, { seat: null })).status, 200);
  const c2 = (await call('GET', '/api/recall/counts')).json;
  assert.equal(c2.opened, o0 + 1);
  assert.equal(c2.seats['seat-b']?.opened ?? 0, c.seats['seat-b']?.opened ?? 0);
  assert.equal((await call('POST', '/api/recall/opened', { run, post: q.json.id }, { seat: 'seat-b' })).status, 200);
  const c3 = (await call('GET', '/api/recall/counts')).json;
  assert.equal(c3.opened, o0 + 1, 'the same (post, run) pair is one opening overall');
  assert.equal(c3.seats['seat-b'].opened, (c.seats['seat-b']?.opened ?? 0) + 1, 'and attributed to the seat that opened it');
});

test('L1 latency: POST /api/conversations with recall on, against a post that gets none (printed, not asserted beyond "no wait")', T, async () => {
  emb.st.mode = 'slow'; emb.st.delayMs = 1500;
  try {
    const eligible = []; const none = [];
    for (let i = 0; i < 6; i++) {
      eligible.push((await posted('seat-a', long('pear pear'))).ms);
      none.push((await posted('seat-a', 'short pear')).ms);
    }
    const med = (xs) => xs.sort((a, b) => a - b)[xs.length >> 1];
    console.log(`# L1 POST /api/conversations median ms: eligible for recall ${med(eligible).toFixed(1)}, not eligible ${med(none).toFixed(1)} (embedder delay 1500 ms)`);
    assert.ok(med(eligible) < 1000, 'the post never waits for the embedder');
  } finally { emb.st.mode = 'pass'; emb.st.delayMs = 0; }
});
