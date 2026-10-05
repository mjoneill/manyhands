/**
 * TARGETED READS FOR THE HOT PAGES (#1574, the slice the builder proposed at 22:38Z after the full-read measurement at 22:37Z). Pre-registered by the separate test author BEFORE the
 * slice exists. Copy unchanged into tests/. REAL executor behind a COUNTING proxy, REAL REST servers; without a python with pyoxigraph every test is SKIPPED, and a skip is NOT a pass.
 * Synthetic content only.
 *
 * WHY: measured on `ed6aaae` (this seat, 22:37Z, a synthetic 36,800-post corpus): every page that shows posts reads EVERY post's triples from the graph (229,097 rows) through the shared
 * post view, so a card page, the board status, `?limit=N` and people each cost 1.8-2.0 s at normal priority (and over the 3 s read bound at background priority), against 55-138 ms from
 * the document. The slice reads only what the hot pages show: a card's posts, the newest N, a count. `/api/load?conversations=1`, people and search keep the whole read (bulk, pinned by
 * the S/R1 rows that must keep passing). NOTE (corrected by a run, 22:42Z; my first draft of this note was wrong): the REST list with NO `limit` returns EVERY post (1,197 of 1,197 on this file's corpus); the clamp of 200 applies only to an explicit `limit`
 * above 200 (`limit=500` returns 200). The MCP `conversation_list` tool never sends a `limit`, so each seat's call fetches the whole list and trims it by a byte budget afterwards: it is a
 * hot consumer of the unbounded read, and the contract owner asked for it to be in this slice or its cost disclosed.
 *
 * WHAT IS PINNED, as properties of the answers and of what crossed the executor boundary (not of the query text):
 *   PARITY   each hot route answers EXACTLY what the same board answers with the unit OFF and every live post in the document (the baseline), in a world that mixes document-only posts,
 *            graph-only posts, posts held by BOTH substrates, and redacted posts (one of them with its plain text still in the document), so identity, tombstones and the document merge
 *            are exercised, not just the graph.
 *   COST     the bytes the executor returned for the hot route are a small fraction (under 15 %) of one WHOLE-GRAPH read of the same corpus, measured independently of the server by sending the unfiltered all-posts query straight through the proxy: the route did not read the rest.
 *   WINDOW   a tombstone inside the newest ten does NOT shrink the page: `ORDER BY postSeq DESC LIMIT 10` would also return the tombstone (it keeps its number) and leave nine live posts,
 *            and a document-only post has no graph number. The newest ten LIVE posts, over both substrates, are returned, and the TOTAL counts live posts of both substrates once each.
 *   T1 CARD    `GET /api/cards/:id`: `comments.total` and the recent stubs equal the baseline; no word of a redacted post; cost.
 *   T2 STATUS  `GET /api/board/status`: `conversationsTotal` and `recentConversations` equal the baseline; WINDOW; cost.
 *   T3 LIMIT   `GET /api/conversations?limit=10`: the posts and `X-Total-Count` equal the baseline; WINDOW; cost.
 *   T4 CLAMP   `GET /api/conversations?limit=200` (the largest page the route serves): the posts and `X-Total-Count` equal the baseline; cost under 30 % of a whole-graph read (200 of
 *              about 1,200 posts here; at the live corpus it is about 0.5 %).
 *   T4b OVER THE CAP `?limit=500`: exactly 200 posts (the route's clamp), the baseline's, with the baseline's `X-Total-Count`, and the cost bound of T4. (Added after a mutant that dropped
 *              the clamp on the targeted path survived: no earlier row asked for more than 200 posts of a corpus larger than 200.)
 *   T5 FILTERED `?limit=10&author=bea` and `?limit=10&attachedTo=null`: the N MATCHING visible posts and the MATCHING total equal the baseline, a tombstone inside the window
 *              notwithstanding. Parity only: a builder may keep the whole read for a filter; if it pushes the filter down, this is the row that says it did not change what the list means.
 *   T7 MCP, EXPLICIT HISTORIES (the contract owner's pin, 22:44Z: bound the DEFAULT catch-up request, but do not silently turn a stated request into a shorter one): `limit: 'all'` returns
 *              EVERY live post in order (the one value that bypasses the tool's byte budget, with '0'), and a numeric `limit: '300'` behaves exactly like the default call in the same world
 *              (a gap-free run of the newest live posts, trimmed by the same byte budget: 146 rows in the baseline and 135 in the candidate on this corpus, because a graph row is a little
 *              larger), never shorter than it. A guard row: it passes today. (My first draft expected exactly 300 rows and was wrong in BOTH worlds: the tool trims numeric limits too.)
 *   T6 MCP     the real MCP `conversation_list` tool with default arguments (the call every seat makes): the answer is a non-empty run of the NEWEST live posts with no gap and none of a
 *              redacted post, ending at the newest, and the whole call costs under 30 % of a whole-graph read. (Exact equality with the baseline is NOT pinned: the tool trims by a byte budget,
 *              and a graph row carries one more field than a document row, so the two worlds legitimately fit a different number of rows.) For the cost to fall, the tool has to ask REST for a
 *              bounded page; how is the builder's. *
 * NOT COVERED, by name: the read BUDGETS (3 s for targeted reads, longer for whole-graph reads, is the builder's proposal and per-request; `graph-budgets-b1`/H1/S6 own failure shapes);
 * `?limit=N` combined with a filter (author, q, since, before, attachedTo, mentions_me), which may legitimately keep the whole read; the unlimited list, load, people, search (S/R1 rows);
 * attachments on the hot routes; the timing target (under about 0.5 s on the 36,800-post corpus) is a probe at normal priority, not a row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { makeBoardFixture, startRestServer, startMcpServer, mcpSession } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'tgt-test';
const PERSON = 'https://scrumboard.local/person/';
const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const N = 1200;
const CARD = 'tgt-card-1';
const SECRET = 'tgt-secret-redacted-text';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROSTER_FILE = path.join(os.tmpdir(), `tgt-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, bea: { name: 'Bea', glyph: 'b', color: '#c48ab0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));

// ---- the corpus: posts 1..N in time order, with a defined mix
const CARD_KINDS = ['doc', 'graph', 'graph', 'both', 'graph', 'doc', 'graph', 'graph', 'graph', 'both', 'graph', 'doc', 'graph', 'doc', 'graph'];   // the 15 live posts of the card
function corpus() {
  const posts = []; let cardIdx = 0;
  for (let i = 1; i <= N; i++) {
    const isCard = i % 79 === 0;     // 15 card posts: 79 .. 1185
    let kind = i % 4 === 0 ? 'doc' : 'graph'; let attachedTo = null; let tomb = false;
    if (isCard) { kind = CARD_KINDS[cardIdx++]; attachedTo = CARD; }
    if (i === 300) { kind = 'both'; attachedTo = CARD; tomb = true; }       // imported, then redacted; the document still holds its text
    if (i === 600) { kind = 'graph'; attachedTo = CARD; tomb = true; }      // graph-only, redacted
    if (i === N - 2) { kind = 'graph'; attachedTo = null; tomb = true; }    // graph-only, redacted, INSIDE the newest ten
    posts.push({ id: `tgt-p-${String(i).padStart(4, '0')}`, body: tomb ? `${SECRET} post ${i}` : `${isCard ? 'card post' : 'filler post'} ${i}`, author: i % 2 ? 'ada' : 'bea', attachedTo, attachments: [], mentions: [], postSeq: i, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0) + i * 60000).toISOString(), kind, tomb });
  }
  return posts;
}
const docShape = ({ kind, tomb, ...p }) => p;
const card = { id: CARD, shortId: 1, title: 'targeted-read card', description: 'x', type: 'task', column: 'backlog', order: 0, assignees: [], labels: [], priority: null, createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z', version: 1, relationships: { relatedTo: [], blockedBy: [] } };
const api = async (base, method, route) => {
  const res = await fetch(`${base}${route}`, { method, signal: AbortSignal.timeout(60000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text, total: res.headers.get('x-total-count') };
};
/** A forwarding proxy that adds up the bytes the executor returns for /query, and counts the queries. */
async function startCountingProxy(execUrl) {
  const p = { bytes: 0, queries: 0, reset() { p.bytes = 0; p.queries = 0; } };
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
    try {
      const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
      const t = await f.text();
      if (req.method === 'POST' && req.url === '/query') { p.queries++; p.bytes += Buffer.byteLength(t); }
      res.statusCode = f.status; res.end(t);
    } catch { try { req.socket.destroy(); } catch { /* gone */ } }
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r)); p.url = `http://127.0.0.1:${p.server.address().port}`;
  p.stop = () => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); });
  return p;
}
const ROUTES = {
  card: `/api/cards/${CARD}`, status: '/api/board/status', limit: '/api/conversations?limit=10', dflt: '/api/conversations?limit=200', over: '/api/conversations?limit=500',
  byAuthor: '/api/conversations?limit=10&author=bea', boardLevel: '/api/conversations?limit=10&attachedTo=null',
};
/** the real MCP tool, default arguments, the way every seat calls it */
async function viaMcp(restBase, args = {}) {
  const mcp = await startMcpServer({ restApiBase: restBase });
  try {
    const sess = await mcpSession(mcp.mcpUrl);
    const r = await sess.callTool('conversation_list', args);
    const text = r?.result?.content?.[0]?.text ?? '';
    let body = null; try { body = JSON.parse(text); } catch { /* not json */ }
    return { text, body, isError: !!r?.result?.isError };
  } finally { await mcp.stop(); }
}
const mcpIds = (m) => { const rows = Array.isArray(m.body) ? m.body : (m.body?.conversations ?? m.body?.items ?? []); return rows.map((c) => c.id); };
const routes = (base) => async () => {
  const out = {}; for (const [k, route] of Object.entries(ROUTES)) out[k] = await api(base, 'GET', route);
  out.mcp = await viaMcp(base);
  out.mcpAll = await viaMcp(base, { limit: 'all' });
  out.mcp300 = await viaMcp(base, { limit: '300' });
  return out;
};

let memo = null;
function worlds() {
  return memo ||= (async () => {
    const all = corpus(); const live = all.filter((p) => !p.tomb);
    // BASELINE: the unit OFF, every live post in the document
    const off = await startRestServer({ board: makeBoardFixture({ cards: [card], nextShortId: 2, conversations: live.map(docShape), postSeqEpoch: EPOCH_DOC, nextPostSeq: N + 1 }), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
    let base; try { base = await routes(off.baseUrl)(); } finally { await off.stop(); }
    // CANDIDATE: the unit ON. The document holds the doc-only, both-substrate and the imported-then-redacted posts; the graph holds the rest, and every tombstone.
    const exec = await startExecutor({ store: tmpStore('tgt-store-'), datasetId: DSID, create: true });
    const proxy = await startCountingProxy(exec.baseUrl);
    try {
      const gc = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID });
      for (const p of all) {
        if (p.kind === 'doc') continue;
        const r = await gc.update({ kind: 'post.import', opId: `urn:ex:op/backfill/${p.id}`, actor: `${PERSON}board`, post: { id: p.id, body: p.body, author: p.author, createdAt: p.createdAt, attachedTo: p.attachedTo, mentions: [], postSeq: p.postSeq } });
        assert.equal(r.outcome, 'APPLIED', JSON.stringify(r));
        if (p.tomb) { const x = await gc.update({ kind: 'post.redact', opId: `urn:ex:op/redact/${p.id}`, actor: `${PERSON}ada`, post: { id: p.id }, authorityRef: 'test-authority-ref', occurredAt: new Date().toISOString() }); assert.equal(x.outcome, 'APPLIED', JSON.stringify(x)); }
      }
      const docPosts = all.filter((p) => p.kind === 'doc' || p.kind === 'both').map(docShape);   // the redacted imported post (i=300) is kind 'both': its plain text is in the document
      const on = await startRestServer({ board: makeBoardFixture({ cards: [card], nextShortId: 2, conversations: docPosts, postSeqEpoch: EPOCH_DOC, nextPostSeq: N + 1 }),
        env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' } });
      try {
        await api(on.baseUrl, 'GET', '/api/conversations?limit=1');   // warm: the first request after boot may do one-off work
        const cost = {};
        // the YARDSTICK, independent of the server: the unfiltered all-posts query sent straight through the proxy
        proxy.reset();
        const full = await createGraphClient({ baseUrl: proxy.url, expectedDatasetId: DSID, timeoutMs: 120000 }).query(`SELECT ?s ?p ?o WHERE { ?s <https://scrumboard.local/ns#postSeq> ?n . ?s ?p ?o }`);
        assert.equal(full.ok, true, JSON.stringify(full).slice(0, 200));
        cost.full = { bytes: proxy.bytes, queries: proxy.queries };
        const cand = await routes(on.baseUrl)();
        for (const [k, route] of Object.entries(ROUTES)) { proxy.reset(); await api(on.baseUrl, 'GET', route); cost[k] = { bytes: proxy.bytes, queries: proxy.queries }; }
        proxy.reset(); await viaMcp(on.baseUrl); cost.mcp = { bytes: proxy.bytes, queries: proxy.queries };
        return { base, cand, cost, live: live.length, all };
      } finally { await on.stop(); }
    } finally { await proxy.stop(); await killExecutor(exec); }
  })();
}
const ids = (rows) => (rows || []).map((c) => c.id);
const recentIds = (b) => (b?.comments?.recent || []).map((c) => c.id);
const COST_FRACTION = 0.15;
const DEFAULT_LIST_FRACTION = 0.30;
const costOk = (w, k, frac = COST_FRACTION) => assert.ok(w.cost[k].bytes < frac * w.cost.full.bytes, `${k}: the executor returned ${w.cost[k].bytes} bytes in ${w.cost[k].queries} queries, against ${w.cost.full.bytes} for one whole-graph read; this route must read under ${frac * 100} % of that`);

test('T1 CARD: comments.total and the recent stubs equal the all-in-the-document baseline, none of a redacted post\'s words, and the card read costs a small fraction of a full read', { skip: SKIP }, async () => {
  const w = await worlds();
  assert.equal(w.base.card.status, 200); assert.equal(w.cand.card.status, 200, `the card page answers: ${w.cand.card.text.slice(0, 200)}`);
  assert.equal(w.base.card.body.comments.total, 15, 'CONTROL: the baseline card holds its 15 live posts');
  assert.deepEqual({ total: w.cand.card.body.comments.total, recent: recentIds(w.cand.card.body) }, { total: w.base.card.body.comments.total, recent: recentIds(w.base.card.body) }, 'PARITY with the baseline');
  assert.ok(!w.cand.card.text.includes(SECRET), 'no word of a redacted post');
  costOk(w, 'card');
});

test('T2 STATUS: conversationsTotal and recentConversations equal the baseline (a tombstone inside the newest ten does not shrink the list; the total counts live posts of both substrates once each), and the status costs a small fraction of a full read', { skip: SKIP }, async () => {
  const w = await worlds();
  assert.equal(w.cand.status.status, 200, `the status answers: ${w.cand.status.text.slice(0, 200)}`);
  assert.equal(w.base.status.body.conversationsTotal, w.live, 'CONTROL: the baseline total is the live posts');
  assert.equal(w.base.status.body.recentConversations.length, 10, 'CONTROL: the baseline has ten recent');
  assert.deepEqual({ total: w.cand.status.body.conversationsTotal, recent: ids(w.cand.status.body.recentConversations) }, { total: w.base.status.body.conversationsTotal, recent: ids(w.base.status.body.recentConversations) }, 'PARITY with the baseline, ten live posts in the window');
  assert.ok(!w.cand.status.text.includes(SECRET), 'no word of a redacted post');
  costOk(w, 'status');
});

test('T3 LIMIT: ?limit=10 returns the baseline\'s ten newest LIVE posts and the baseline\'s X-Total-Count, and costs a small fraction of a full read', { skip: SKIP }, async () => {
  const w = await worlds();
  assert.equal(w.cand.limit.status, 200, `the list answers: ${w.cand.limit.text.slice(0, 200)}`);
  assert.equal(w.base.limit.body.length, 10, 'CONTROL: the baseline returns ten');
  assert.deepEqual({ posts: ids(w.cand.limit.body), total: w.cand.limit.total }, { posts: ids(w.base.limit.body), total: w.base.limit.total }, 'PARITY with the baseline, a tombstone in the window notwithstanding');
  assert.ok(!w.cand.limit.text.includes(SECRET), 'no word of a redacted post');
  costOk(w, 'limit');
});

test('T4 CLAMP: ?limit=200 returns the baseline\'s posts and X-Total-Count, and reads under 30 % of a whole-graph read', { skip: SKIP }, async () => {
  const w = await worlds();
  assert.equal(w.cand.dflt.status, 200, w.cand.dflt.text.slice(0, 200));
  assert.equal(w.base.dflt.body.length, 200, 'CONTROL: the baseline list is the clamp of 200');
  assert.deepEqual({ posts: ids(w.cand.dflt.body), total: w.cand.dflt.total }, { posts: ids(w.base.dflt.body), total: w.base.dflt.total }, 'PARITY with the baseline');
  assert.ok(!w.cand.dflt.text.includes(SECRET), 'no word of a redacted post');
  costOk(w, 'dflt', DEFAULT_LIST_FRACTION);
});

test('T5 FILTERED LIMITS: ?limit=10&author=bea and ?limit=10&attachedTo=null return the N MATCHING visible posts and the MATCHING total, a tombstone inside the window notwithstanding', { skip: SKIP }, async () => {
  const w = await worlds();
  for (const k of ['byAuthor', 'boardLevel']) {
    assert.equal(w.cand[k].status, 200, `${k}: ${w.cand[k].text.slice(0, 200)}`);
    assert.equal(w.base[k].body.length, 10, `CONTROL (${k}): the baseline returns ten`);
    assert.deepEqual({ posts: ids(w.cand[k].body), total: w.cand[k].total }, { posts: ids(w.base[k].body), total: w.base[k].total }, `${k}: PARITY with the baseline`);
    assert.ok(!w.cand[k].text.includes(SECRET), `${k}: no word of a redacted post`);
  }
});

test('T6 MCP: the real conversation_list tool with default arguments returns a non-empty, gap-free run of the NEWEST live posts, none of a redacted post, ending at the newest, for under 30 % of a whole-graph read\'s cost', { skip: SKIP }, async () => {
  const w = await worlds();
  const liveOrder = w.all.filter((p) => !p.tomb).sort((a, b) => a.postSeq - b.postSeq).map((p) => p.id);
  for (const [label, m] of [['baseline', w.base.mcp], ['candidate', w.cand.mcp]]) {
    assert.equal(m.isError, false, `${label} tool answers: ${m.text.slice(0, 200)}`);
    const got = mcpIds(m);
    assert.ok(got.length >= 20, `${label}: a useful number of posts came back (${got.length})`);
    assert.deepEqual(got, liveOrder.slice(-got.length), `${label}: a gap-free run ending at the newest live post`);
  }
  assert.ok(!w.cand.mcp.text.includes(SECRET), 'no word of a redacted post');
  costOk(w, 'mcp', DEFAULT_LIST_FRACTION);
});

test('T7 MCP, EXPLICIT HISTORIES: limit "all" returns every live post in order; limit "300" behaves like the default call (gap-free newest run, same byte budget), never shorter; no word of a redacted post', { skip: SKIP }, async () => {
  const w = await worlds();
  const liveOrder = w.all.filter((p) => !p.tomb).sort((a, b) => a.postSeq - b.postSeq).map((p) => p.id);
  for (const [label, m] of [['limit all', w.cand.mcpAll], ['limit 300', w.cand.mcp300]]) assert.equal(m.isError, false, `${label}: the tool answers: ${m.text.slice(0, 200)}`);
  assert.deepEqual(mcpIds(w.cand.mcpAll), liveOrder, `limit "all": every live post, in order (${mcpIds(w.cand.mcpAll).length} of ${liveOrder.length})`);
  assert.deepEqual(mcpIds(w.base.mcpAll), liveOrder, 'CONTROL: the baseline tool returns the same for "all"');
  for (const [label, m] of [['baseline', w.base], ['candidate', w.cand]]) {
    const dflt = mcpIds(m.mcp); const n300 = mcpIds(m.mcp300);
    assert.ok(n300.length >= 20, `${label}: limit "300" returns a useful number of posts (${n300.length})`);
    assert.deepEqual(n300, liveOrder.slice(-n300.length), `${label}: limit "300" is a gap-free run ending at the newest live post`);
    assert.ok(n300.length >= dflt.length, `${label}: an explicit limit is never shorter than the default call (${n300.length} vs ${dflt.length})`);
  }
  assert.ok(!w.cand.mcpAll.text.includes(SECRET) && !w.cand.mcp300.text.includes(SECRET), 'no word of a redacted post');
});

test('T4b OVER THE CAP: ?limit=500 returns exactly the baseline\'s 200 posts (the route\'s clamp) and X-Total-Count, and reads under 30 % of a whole-graph read', { skip: SKIP }, async () => {
  const w = await worlds();
  assert.equal(w.cand.over.status, 200, w.cand.over.text.slice(0, 200));
  assert.equal(w.base.over.body.length, 200, 'CONTROL: the baseline clamps to 200');
  assert.equal(w.cand.over.body.length, 200, 'the candidate clamps to 200 too, not 500');
  assert.deepEqual({ posts: ids(w.cand.over.body), total: w.cand.over.total }, { posts: ids(w.base.over.body), total: w.base.over.total }, 'PARITY with the baseline');
  costOk(w, 'over', DEFAULT_LIST_FRACTION);
});
