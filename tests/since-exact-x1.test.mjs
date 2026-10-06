/**
 * THE `since` PATH IS EXACT (#1574 attempt 2, #1605 v15 item 2; contract owner's correction 00:45Z: "apply since, mentions, author and attachedTo filters BEFORE
 * selecting N matching visible posts; fetching a newest-postSeq window and filtering afterwards can silently miss matches; late commits mean timestamp and sequence
 * order aren't interchangeable"). Written by the separate test author, before the build, from the contract text and the code at bfb74d0.
 *
 * WHAT THESE ROWS ARE. Today a `since` request takes the bulk path (the whole graph is read, then filtered), which is exact but costs ~2 s of executor work and is
 * what the residents' scans and the catch-ups send. The attempt-2 change gives it a targeted path. A targeted path can be fast and WRONG in one specific way: take the
 * newest N posts by postSeq, then filter. X1-X5 are GUARDS: expected GREEN on bfb74d0 (the bulk path is exact) and RED on the first targeted implementation that
 * filters after windowing. X6 is the RED row for the new work: a recent `since` read must cost a small fraction of a whole-graph read.
 *
 * THE TRAP, built into the corpus. 1200 posts, document order = postSeq order (the list's order). Three groups:
 *   NORMAL     postSeq 1..1140, createdAt = minute i of the corpus clock.
 *   LATE       postSeq 1141..1200 (the NEWEST sequence numbers), createdAt OLD (minutes 1..60): committed late, written long ago. A newest-postSeq window of up to 60
 *              rows holds only these, and none of them matches `since=T`.
 *   RECENT-LOW postSeq 5, 6, 7 with createdAt in the future of everything (minute 1500): low sequence numbers, newest timestamps. They MATCH `since=T` and sit
 *              at the START of the matching set in list order; a window of the newest 200 by postSeq (1001..1200) misses them.
 *   T = the createdAt of postSeq 1001. Matching set (createdAt >= T): RECENT-LOW (3) + NORMAL 1001..1140 (140) = 143 posts, of which the tombstone at 1100 is hidden: 142 LIVE matches, in postSeq order 5,6,7,1001..1099,1101..1140.
 * Substrates are mixed as in the targeted-reads rows: 'doc' posts only in the document, 'graph' only in the graph, one redacted (tombstoned) graph-only post at
 * postSeq 1100 that MATCHES `since` and must be hidden. Authors alternate; some posts carry mentions; some attach to a card.
 *
 * BASELINE: the unit OFF, every live post in the document (the contract's own implementation of the filters). CANDIDATE: the unit ON, posts split across both stores.
 * For X1 and X2 the expected list is ALSO computed here from the corpus, independently of either server, and the baseline must equal it first (a fixture error shows
 * as a failed CONTROL, not as a candidate defect).
 *
 *   X1 WINDOW TRAP A   ?since=T&limit=10: the ten newest MATCHING posts (postSeq 1131..1140) and the matching X-Total-Count (142 live matches, the tombstone not counted).
 *   X2 WINDOW TRAP B   ?since=T&limit=200: all 142 live matches in order, INCLUDING 5, 6, 7 first; the tombstone absent; X-Total-Count 142.
 *   X3 AUTHOR          ?since=T&author=bea&limit=50: parity with the baseline.
 *   X4 MENTIONS        ?since=T&mentions_me=bea&limit=50: parity with the baseline, mentions on a RECENT-LOW post included.
 *   X5 CARD            ?since=T&attachedTo=<card>&limit=50: parity with the baseline, a card post among RECENT-LOW included.
 *   X6 COST            ?since=<a minute inside the newest 100>&limit=20 answers exactly like the baseline and the executor returns under 30 % of the bytes of one
 *                      whole-graph read (the yardstick: the unfiltered all-posts query sent straight through the counting proxy). RED today: the bulk path reads it all.
 *
 * REAL executor behind a COUNTING proxy, REAL REST servers; without a python with pyoxigraph every test is SKIPPED, and a skip is NOT a pass. Synthetic content only.
 * NOT COVERED, by name: `since` combined with `q`, `before`, `conversation` or seq-mode parameters (a different listing; the plain shapes only); ties on createdAt (the
 * corpus has none, so equal timestamps are not pinned); the unlimited `?since=T` with no limit (bulk by definition, the 10 s tier); the MCP catch-up tool (it calls this route);
 * the resident runner's scan (T3 owns the runner's request shape); tombstones OUTSIDE the matching set; executor failure while serving (H1/S6 own the failure shape).
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
const DSID = 'sx-test';
const PERSON = 'https://scrumboard.local/person/';
const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const N = 1200;
const CARD = 'sx-card-1';
const SECRET = 'sx-secret-redacted-text';
const ROSTER_FILE = path.join(os.tmpdir(), `sx-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, bea: { name: 'Bea', glyph: 'b', color: '#c48ab0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));

const minute = (m) => new Date(Date.UTC(2026, 6, 1) + m * 60000).toISOString();
const T_SEQ = 1001;
const SINCE = minute(T_SEQ);
const RECENT_LOW = new Set([5, 6, 7]);
const TOMB_SEQ = 1100;

function corpus() {
  const posts = [];
  for (let i = 1; i <= N; i++) {
    const late = i >= 1141;
    const createdAt = RECENT_LOW.has(i) ? minute(1500) : late ? minute(i - 1140) : minute(i);
    const tomb = i === TOMB_SEQ;
    let kind = i % 4 === 0 ? 'doc' : 'graph';
    if (RECENT_LOW.has(i)) kind = i === 6 ? 'doc' : 'graph';
    if (tomb) kind = 'graph';
    const onCard = i % 59 === 0 || i === 5 || i === 1137;
    posts.push({
      id: `sx-p-${String(i).padStart(4, '0')}`, body: tomb ? `${SECRET} post ${i}` : `${onCard ? 'card post' : 'filler post'} ${i}`,
      author: i % 2 ? 'ada' : 'bea', attachedTo: onCard ? CARD : null, attachments: [],
      mentions: (i === 7 || i === 1010 || i === 1120 || i % 97 === 0) ? ['bea'] : [],
      postSeq: i, createdAt, kind, tomb,
    });
  }
  return posts;
}
const docShape = ({ kind, tomb, ...p }) => p;
const card = { id: CARD, shortId: 1, title: 'since-exact card', description: 'x', type: 'task', column: 'backlog', order: 0, assignees: [], labels: [], priority: null, createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z', version: 1, relationships: { relatedTo: [], blockedBy: [] } };
const api = async (base, route) => {
  const res = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(60000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text, total: res.headers.get('x-total-count') };
};
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
const SINCE_RECENT = minute(1100);                // inside the newest 100 NORMAL posts; matching set = RECENT-LOW (3) + postSeq 1100..1140 minus the tombstone
const ROUTES = {
  x1: `/api/conversations?since=${encodeURIComponent(SINCE)}&limit=10`,
  x2: `/api/conversations?since=${encodeURIComponent(SINCE)}&limit=200`,
  x3: `/api/conversations?since=${encodeURIComponent(SINCE)}&author=bea&limit=50`,
  x4: `/api/conversations?since=${encodeURIComponent(SINCE)}&mentions_me=bea&limit=50`,
  x5: `/api/conversations?since=${encodeURIComponent(SINCE)}&attachedTo=${CARD}&limit=50`,
  x6: `/api/conversations?since=${encodeURIComponent(SINCE_RECENT)}&limit=20`,
};
const routes = async (base) => { const out = {}; for (const [k, r] of Object.entries(ROUTES)) out[k] = await api(base, r); return out; };
const ids = (rows) => (rows || []).map((c) => c.id);

let memo = null;
function worlds() {
  return memo ||= (async () => {
    const all = corpus(); const live = all.filter((p) => !p.tomb);
    const off = await startRestServer({ board: makeBoardFixture({ cards: [card], nextShortId: 2, conversations: live.map(docShape), postSeqEpoch: EPOCH_DOC, nextPostSeq: N + 1 }), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
    let base; try { base = await routes(off.baseUrl); } finally { await off.stop(); }
    const exec = await startExecutor({ store: tmpStore('sx-store-'), datasetId: DSID, create: true });
    const proxy = await startCountingProxy(exec.baseUrl);
    try {
      const gc = createGraphClient({ baseUrl: exec.baseUrl, expectedDatasetId: DSID });
      for (const p of all) {
        if (p.kind === 'doc') continue;
        const r = await gc.update({ kind: 'post.import', opId: `urn:ex:op/backfill/${p.id}`, actor: `${PERSON}board`, post: { id: p.id, body: p.body, author: p.author, createdAt: p.createdAt, attachedTo: p.attachedTo, mentions: p.mentions, postSeq: p.postSeq } });
        assert.equal(r.outcome, 'APPLIED', JSON.stringify(r));
        if (p.tomb) { const x = await gc.update({ kind: 'post.redact', opId: `urn:ex:op/redact/${p.id}`, actor: `${PERSON}ada`, post: { id: p.id }, authorityRef: 'test-authority-ref', occurredAt: new Date().toISOString() }); assert.equal(x.outcome, 'APPLIED', JSON.stringify(x)); }
      }
      const docPosts = all.filter((p) => p.kind === 'doc').map(docShape);
      const on = await startRestServer({ board: makeBoardFixture({ cards: [card], nextShortId: 2, conversations: docPosts, postSeqEpoch: EPOCH_DOC, nextPostSeq: N + 1 }),
        env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' } });
      try {
        await api(on.baseUrl, '/api/conversations?limit=1');   // warm: the first request after boot may do one-off work
        proxy.reset();
        const full = await createGraphClient({ baseUrl: proxy.url, expectedDatasetId: DSID, timeoutMs: 120000 }).query(`SELECT ?s ?p ?o WHERE { ?s <https://scrumboard.local/ns#postSeq> ?n . ?s ?p ?o }`);
        assert.equal(full.ok, true, JSON.stringify(full).slice(0, 200));
        const fullBytes = proxy.bytes;
        const cand = await routes(on.baseUrl);
        const cost = {};
        for (const [k, r] of Object.entries(ROUTES)) { proxy.reset(); await api(on.baseUrl, r); cost[k] = { bytes: proxy.bytes, queries: proxy.queries }; }
        return { base, cand, cost, fullBytes, all, live };
      } finally { await on.stop(); }
    } finally { await proxy.stop(); await killExecutor(exec); }
  })();
}
/** the expected list, from the corpus alone: createdAt >= since, in postSeq order, the newest `limit` of them, tombstones hidden */
const expected = (all, since, limit) => {
  const m = all.filter((p) => !p.tomb && p.createdAt >= since).sort((a, b) => a.postSeq - b.postSeq);
  return { total: m.length, ids: m.slice(-limit).map((p) => p.id) };
};
const parity = (w, k, msg) => {
  assert.equal(w.cand[k].status, 200, `${k} answers: ${w.cand[k].text.slice(0, 200)}`);
  assert.deepEqual({ posts: ids(w.cand[k].body), total: w.cand[k].total }, { posts: ids(w.base[k].body), total: w.base[k].total }, msg);
  assert.ok(!w.cand[k].text.includes(SECRET), 'no word of the redacted post');
};

test('X1 WINDOW TRAP A: ?since=T&limit=10 returns the ten newest MATCHING posts (a newest-postSeq window holds only late-committed old posts) and the matching total', { skip: SKIP }, async () => {
  const w = await worlds(); const e = expected(w.all, SINCE, 10);
  assert.equal(e.total, 142, 'CONTROL: the corpus has 142 live matches (143 by timestamp, minus the tombstone at 1100)');
  assert.deepEqual({ posts: ids(w.base.x1.body), total: Number(w.base.x1.total) }, { posts: e.ids, total: e.total }, 'CONTROL: the baseline equals the list computed from the corpus alone');
  parity(w, 'x1', 'PARITY with the baseline: the ten newest matches, not whatever the newest ten sequence numbers leave after filtering');
});

test('X2 WINDOW TRAP B: ?since=T&limit=200 returns all 142 live matches in order, the three low-sequence recent posts FIRST, the tombstone absent', { skip: SKIP }, async () => {
  const w = await worlds(); const e = expected(w.all, SINCE, 200);
  assert.equal(e.ids.length, 142);
  assert.deepEqual(e.ids.slice(0, 3), ['sx-p-0005', 'sx-p-0006', 'sx-p-0007'], 'CONTROL: the recent-but-low-sequence posts lead the matching set');
  assert.deepEqual({ posts: ids(w.base.x2.body), total: Number(w.base.x2.total) }, { posts: e.ids, total: e.total }, 'CONTROL: the baseline equals the list computed from the corpus alone');
  parity(w, 'x2', 'PARITY with the baseline: posts 5, 6, 7 are matches although their sequence numbers are far outside any newest-200 window');
  assert.ok(!ids(w.cand.x2.body).includes('sx-p-1100'), 'the redacted post that matches `since` is hidden');
});

test('X3 AUTHOR: ?since=T&author=bea&limit=50 equals the baseline', { skip: SKIP }, async () => {
  const w = await worlds();
  assert.ok(w.base.x3.body.length > 5, 'CONTROL: the baseline returns a real list');
  parity(w, 'x3', 'PARITY with the baseline');
});

test('X4 MENTIONS: ?since=T&mentions_me=bea&limit=50 equals the baseline, the mention on a low-sequence recent post included', { skip: SKIP }, async () => {
  const w = await worlds();
  assert.ok(ids(w.base.x4.body).includes('sx-p-0007'), 'CONTROL: the baseline holds the low-sequence recent post that mentions bea');
  parity(w, 'x4', 'PARITY with the baseline');
});

test('X5 CARD: ?since=T&attachedTo=<card>&limit=50 equals the baseline, a low-sequence recent card post included', { skip: SKIP }, async () => {
  const w = await worlds();
  assert.ok(ids(w.base.x5.body).includes('sx-p-0005'), 'CONTROL: the baseline holds the low-sequence recent card post');
  parity(w, 'x5', 'PARITY with the baseline');
});

test('X6 COST: a recent ?since=…&limit=20 answers exactly like the baseline and the executor returns under 30 % of the bytes of one whole-graph read', { skip: SKIP }, async () => {
  const w = await worlds();
  assert.ok(w.base.x6.body.length === 20, 'CONTROL: the baseline returns twenty');
  parity(w, 'x6', 'PARITY with the baseline');
  assert.ok(w.cost.x6.bytes < 0.30 * w.fullBytes, `the executor returned ${w.cost.x6.bytes} bytes in ${w.cost.x6.queries} queries against ${w.fullBytes} bytes for one whole-graph read: a targeted \`since\` reads a small fraction, not the whole graph`);
});
