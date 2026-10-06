/**
 * `since` WITHOUT A LIMIT, AND `before`, ARE EXACT AND TARGETED (#1574 attempt 3, bug #1; the board's request to the test author at 03:10Z, after tonight's second rollback). Written by the
 * separate test author, before the build, from the contract text, the code at caa4398, and the inspection of the callers: the browser's poll sends `?since=<ts>` with NO limit (a whole-store
 * read), and the resident runners page backward with `before=<cursor>`, which is not in the targeted path's accepted keys (pages 2 to 25 of every minute's scan are whole-store reads).
 *
 * WHAT THESE ROWS ARE. Same family as the exact-`since` rows (X1-X6), and the same trap: a targeted path that takes the newest N posts by postSeq and filters afterwards silently misses
 * matches when postSeq order and createdAt order disagree. With the unlimited and `before` shapes there is a second trap: with no limit the window is "all matching", and a path
 * that treats "no limit" as "some default window" would silently truncate. Y1-Y3, Y6 and Y7 are PARITY and EXACTNESS rows: GREEN today (the bulk path is exact) and RED on a targeted
 * implementation that filters after windowing, or truncates. Y4 and Y5 are the COST rows: RED today, the work to be done.
 *
 * THE CORPUS is the exact-`since` corpus: 1200 posts, document order = postSeq order. NORMAL postSeq 1..1140 with createdAt = minute i; LATE postSeq 1141..1200 (the newest sequence
 * numbers) with OLD createdAt (minute i-1140); RECENT-LOW postSeq 5, 6, 7 with the newest timestamps (minute 1500). Authors alternate, some posts mention, some attach to a card, one
 * redacted graph-only post sits at postSeq 1100. Substrates are mixed as before. For each row the expected list is computed HERE from the corpus alone, and the flag-off baseline
 * must equal it first (a fixture error shows as a failed CONTROL, never as a candidate defect).
 *
 *   Y1 BROWSER SHAPE   ?since=<minute 1100>   (NO limit): the 43 live matches in postSeq order, posts 5, 6, 7 first, the tombstone at 1100 hidden, parity with the baseline.
 *   Y2 BEFORE, TRAP    ?before=<minute 30>&limit=10: createdAt < minute 30 matches 55 live posts; the ten newest by postSeq are the LATE posts 1160..1169. A newest-ten window by postSeq
 *                      (1191..1200, all createdAt >= minute 51) filtered afterwards returns NOTHING.
 *   Y3 SINCE + BEFORE  ?since=<minute 20>&before=<minute 55>&limit=30: 70 matches; the newest 30 by postSeq are LATE 1165..1194. A newest-30 window (1171..1200) filtered afterwards returns 24.
 *   Y4 COST, BROWSER   the Y1 request reads under 30 % of the bytes of one whole-graph read (the yardstick: the unfiltered all-posts query through the counting proxy). RED today.
 *   Y5 COST, SCAN PAGE the resident runner's later page: ?attachedTo=null&since=<minute 2>&before=<minute 1000>&limit=200: parity with the baseline AND under 30 % of a whole-graph read.
 *                      RED on the cost half today.
 *   Y6 OLD, UNLIMITED  ?since=<minute 0> (everything, NO limit): all 1199 live posts in postSeq order, the tombstone hidden. May be costly; must never be wrong, and never truncated.
 *   Y7 BEFORE ALONE    ?before=<minute 30> (NO limit, NO since): the 55 live matches in order.
 *
 * REAL executor behind a COUNTING proxy, REAL REST servers; without a python with pyoxigraph every test is SKIPPED, and a skip is NOT a pass. Synthetic content only.
 * NOT COVERED, by name: `q`, `conversation`, seq-mode parameters and the fully unlimited list with neither `since` nor `before` (they stay on the bulk path by design); `before` or `since`
 * combined with `author` or `mentions_me`; ties on createdAt (the corpus has none, so equal timestamps are not pinned); the resident runner's own cursor bug (#1608, a runner change, not
 * a route one); the browser's behaviour (index.html); executor failure while serving (H1/S6 own the failure shape); the admission gate (A-rows own it).
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
const DSID = 'yb-test';
const PERSON = 'https://scrumboard.local/person/';
const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const N = 1200;
const CARD = 'yb-card-1';
const SECRET = 'yb-secret-redacted-text';
const ROSTER_FILE = path.join(os.tmpdir(), `yb-roster-${process.pid}.json`);
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
      id: `yb-p-${String(i).padStart(4, '0')}`, body: tomb ? `${SECRET} post ${i}` : `${onCard ? 'card post' : 'filler post'} ${i}`,
      author: i % 2 ? 'ada' : 'bea', attachedTo: onCard ? CARD : null, attachments: [],
      mentions: (i === 7 || i === 1010 || i === 1120 || i % 97 === 0) ? ['bea'] : [],
      postSeq: i, createdAt, kind, tomb,
    });
  }
  return posts;
}
const docShape = ({ kind, tomb, ...p }) => p;
const card = { id: CARD, shortId: 1, title: 'before-exact card', description: 'x', type: 'task', column: 'backlog', order: 0, assignees: [], labels: [], priority: null, createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z', version: 1, relationships: { relatedTo: [], blockedBy: [] } };
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
const SINCE_RECENT = minute(1100);   // inside the newest posts of the NORMAL group; the tombstone at 1100 matches by timestamp and is hidden
const B30 = minute(30);
const ROUTES = {
  y1: `/api/conversations?since=${encodeURIComponent(SINCE_RECENT)}`,
  y2: `/api/conversations?before=${encodeURIComponent(B30)}&limit=10`,
  y3: `/api/conversations?since=${encodeURIComponent(minute(20))}&before=${encodeURIComponent(minute(55))}&limit=30`,
  y5: `/api/conversations?attachedTo=null&since=${encodeURIComponent(minute(2))}&before=${encodeURIComponent(minute(1000))}&limit=200`,
  y6: `/api/conversations?since=${encodeURIComponent(minute(0))}`,
  y7: `/api/conversations?before=${encodeURIComponent(B30)}`,
};
const routes = async (base) => { const out = {}; for (const [k, r] of Object.entries(ROUTES)) out[k] = await api(base, r); return out; };
const ids = (rows) => (rows || []).map((c) => c.id);

let memo = null;
function worlds() {
  return memo ||= (async () => {
    const all = corpus(); const live = all.filter((p) => !p.tomb);
    const off = await startRestServer({ board: makeBoardFixture({ cards: [card], nextShortId: 2, conversations: live.map(docShape), postSeqEpoch: EPOCH_DOC, nextPostSeq: N + 1 }), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
    let base; try { base = await routes(off.baseUrl); } finally { await off.stop(); }
    const exec = await startExecutor({ store: tmpStore('yb-store-'), datasetId: DSID, create: true });
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
/** the expected list, from the corpus alone: createdAt >= since and createdAt < before (when given), attachedTo null (when asked), in postSeq order, the newest `limit` of them (all when none), tombstones hidden */
const expected = (all, { since = null, before = null, boardLevel = false } = {}, limit = Infinity) => {
  const m = all.filter((p) => !p.tomb && (since === null || p.createdAt >= since) && (before === null || p.createdAt < before) && (!boardLevel || p.attachedTo === null)).sort((a, b) => a.postSeq - b.postSeq);
  return { total: m.length, ids: limit === Infinity ? m.map((p) => p.id) : m.slice(-limit).map((p) => p.id) };
};
const parity = (w, k, msg) => {
  assert.equal(w.cand[k].status, 200, `${k} answers: ${w.cand[k].text.slice(0, 200)}`);
  assert.deepEqual({ posts: ids(w.cand[k].body), total: w.cand[k].total }, { posts: ids(w.base[k].body), total: w.base[k].total }, msg);
  assert.ok(!w.cand[k].text.includes(SECRET), 'no word of the redacted post');
};
const baselineIsOracle = (w, k, e) => assert.deepEqual(ids(w.base[k].body), e.ids, `CONTROL: the baseline ${k} equals the list computed from the corpus alone`);

test('Y1 BROWSER SHAPE: ?since=<recent> with NO limit returns the 43 live matches in postSeq order, posts 5, 6, 7 first, the tombstone hidden, exactly like the baseline', { skip: SKIP }, async () => {
  const w = await worlds(); const e = expected(w.all, { since: SINCE_RECENT });
  assert.equal(e.total, 43, 'CONTROL: 3 recent-low posts + postSeq 1101..1140 (the tombstone at 1100 is hidden)');
  assert.deepEqual(e.ids.slice(0, 3), ['yb-p-0005', 'yb-p-0006', 'yb-p-0007']);
  baselineIsOracle(w, 'y1', e);
  parity(w, 'y1', 'PARITY with the baseline: all matches, none dropped by a default window');
});

test('Y2 BEFORE, TRAP: ?before=<minute 30>&limit=10 returns the ten newest MATCHING posts, the late-committed 1160..1169 (a newest-ten window by postSeq holds none of them)', { skip: SKIP }, async () => {
  const w = await worlds(); const e = expected(w.all, { before: B30 }, 10);
  assert.equal(expected(w.all, { before: B30 }).total, 55, 'CONTROL: 26 normal posts + 29 late ones match');
  assert.deepEqual(e.ids[e.ids.length - 1], 'yb-p-1169'); assert.equal(e.ids.length, 10);
  baselineIsOracle(w, 'y2', e);
  parity(w, 'y2', 'PARITY with the baseline: the newest matches by postSeq, found by filtering inside the query before choosing the window');
});

test('Y3 SINCE + BEFORE: ?since=<minute 20>&before=<minute 55>&limit=30 returns the thirty newest matches, the late-committed 1165..1194 (a newest-30 window by postSeq would hold only 24 of them)', { skip: SKIP }, async () => {
  const w = await worlds(); const e = expected(w.all, { since: minute(20), before: minute(55) }, 30);
  assert.equal(expected(w.all, { since: minute(20), before: minute(55) }).total, 70, 'CONTROL: 35 normal + 35 late matches');
  assert.equal(e.ids.length, 30); assert.equal(e.ids[0], 'yb-p-1165'); assert.equal(e.ids[29], 'yb-p-1194');
  baselineIsOracle(w, 'y3', e);
  parity(w, 'y3', 'PARITY with the baseline');
});

test('Y4 COST, BROWSER SHAPE: ?since=<recent> with NO limit reads under 30 % of the bytes of one whole-graph read', { skip: SKIP }, async () => {
  const w = await worlds();
  assert.equal(w.cand.y1.status, 200);
  assert.ok(w.cost.y1.bytes < 0.30 * w.fullBytes, `the executor returned ${w.cost.y1.bytes} bytes in ${w.cost.y1.queries} queries against ${w.fullBytes} bytes for one whole-graph read: the browser's poll must not read the whole store`);
});

test('Y5 COST, RESIDENT SCAN PAGE: ?attachedTo=null&since=<old>&before=<x>&limit=200 equals the baseline and reads under 30 % of one whole-graph read', { skip: SKIP }, async () => {
  const w = await worlds(); const e = expected(w.all, { since: minute(2), before: minute(1000), boardLevel: true }, 200);
  assert.equal(e.ids.length, 200, 'CONTROL: a full page of 200');
  baselineIsOracle(w, 'y5', e);
  parity(w, 'y5', 'PARITY with the baseline');
  assert.ok(w.cost.y5.bytes < 0.30 * w.fullBytes, `the executor returned ${w.cost.y5.bytes} bytes in ${w.cost.y5.queries} queries against ${w.fullBytes} bytes for one whole-graph read: a later page of the scan must not read the whole store (25 of them a minute did, tonight)`);
});

test('Y6 OLD UNLIMITED: ?since=<minute 0> with NO limit returns all 1199 live posts in postSeq order, none truncated, the tombstone hidden', { skip: SKIP }, async () => {
  const w = await worlds(); const e = expected(w.all, { since: minute(0) });
  assert.equal(e.total, 1199, 'CONTROL: every live post (the tombstone is the 1200th)');
  baselineIsOracle(w, 'y6', e);
  parity(w, 'y6', 'PARITY with the baseline: an old unlimited `since` may cost a lot, but it is never wrong and never cut short');
});

test('Y7 BEFORE ALONE: ?before=<minute 30> with NO limit and NO since returns the 55 live matches in order', { skip: SKIP }, async () => {
  const w = await worlds(); const e = expected(w.all, { before: B30 });
  assert.equal(e.total, 55, 'CONTROL');
  baselineIsOracle(w, 'y7', e);
  parity(w, 'y7', 'PARITY with the baseline');
});
