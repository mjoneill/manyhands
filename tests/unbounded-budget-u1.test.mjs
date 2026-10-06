/**
 * AN UNBOUNDED READ GETS THE LONG BUDGET, A BOUNDED PAGE KEEPS THE SHORT ONE (#1609; the contract owner's 03:49Z shape: "use the 10 s gated bulk budget for unbounded result materialization; keep bounded
 * pages on the short budget"). Written by the separate test author, before the fix, from the contract and from tonight's measurement: an unlimited `since` that matches every post ran every query on the
 * 3 s targeted reader, answered 200 in 3.5 s once and 503 "timeout: no answer within 3000 ms" at 4.5 s the next time (the builder's copy, 37,126 posts), because the work sits right at the bound.
 *
 * REAL executor behind a DELAYING proxy, REAL REST with the unit on (the pattern of the earlier budget rows, B1-B3). The delay stands in for "the work is bigger than the short bound"; it needs no 37,000-post store.
 *
 *   U1 UNBOUNDED, LONG BUDGET  ?since=<recent> with NO limit, every executor query answered 4 s late (past the 3 s short bound, well inside the 10 s long one): the read answers 200 with the posts, after the
 *                              delay and not before. With every query answered 13 s late it answers 503 GRAPH_UNAVAILABLE BEFORE the delayed answer could have arrived (the long bound is pinned only as "above 4 s, below 13 s").
 *   U2 BOUNDED, SHORT BUDGET   ?since=<recent>&limit=20, the same 4 s delay: a card-sized page is refused 503 GRAPH_UNAVAILABLE in under 4 s. The hot reads stay hot.
 *   U3 CONTROL                 no delay: both answer 200 and hold the post, so the rows above are about the budget, not the stack.
 *
 * NOT COVERED, by name: the exact budgets (3 s and 10 s are the builder's numbers, not pinned here); `before` alone with no limit (a known unpinned cost case, no caller); the size of the result an unbounded read can
 * return (a 37k-post body is probed, not a suite row); the gate (the admission rows own it); writes (B1 owns their budget).
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
const DSID = 'bud-test';
const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROSTER_FILE = path.join(os.tmpdir(), `bud-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));

const api = async (base, method, route, body) => {
  const t0 = Date.now();
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(40000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text, ms: Date.now() - t0 };
};
/** A forwarding proxy that delays the executor's `/update` and `/query` answers by the configured milliseconds BEFORE forwarding (so a delayed write is not applied during the delay). */
async function startDelayProxy(execUrl) {
  const p = { updateMs: 0, queryMs: 0 };
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const d = req.method === 'POST' && req.url === '/update' ? p.updateMs : req.method === 'POST' && req.url === '/query' ? p.queryMs : 0;
    if (d) await sleep(d);
    const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
    try { const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }); const t = await f.text(); res.statusCode = f.status; res.end(t); }
    catch { try { req.socket.destroy(); } catch { /* gone */ } }
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r)); p.url = `http://127.0.0.1:${p.server.address().port}`;
  p.stop = () => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); });
  return p;
}
async function stack(body) {
  const exec = await startExecutor({ store: tmpStore('bud-store-'), datasetId: DSID, create: true });
  const proxy = await startDelayProxy(exec.baseUrl);
  const rest = await startRestServer({ board: makeBoardFixture({ conversations: [], postSeqEpoch: EPOCH_DOC, nextPostSeq: 1 }), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' } });
  try { return await body({ base: rest.baseUrl, proxy }); } finally { await rest.stop(); await proxy.stop(); await killExecutor(exec); }
}


async function withPostsAndSince(body) {
  return stack(async ({ base, proxy }) => {
    const card = await api(base, 'POST', '/api/cards', { title: 'budget card', description: 'x', createdBy: 'ada' });
    assert.ok(card.status === 200 || card.status === 201, card.text);
    const w = await api(base, 'POST', '/api/conversations', { author: 'ada', body: 'a post for the unbounded rows u-marker', attachedTo: card.body.id });
    assert.equal(w.status, 201, w.text);
    const since = encodeURIComponent(new Date(Date.parse(w.body.createdAt) - 60000).toISOString());
    return body({ base, proxy, postId: w.body.id, since });
  });
}

test('U3 CONTROL: with no delay, the unbounded since read and the bounded page both answer 200 and hold the post', { skip: SKIP }, async () => {
  await withPostsAndSince(async ({ base, postId, since }) => {
    const all = await api(base, 'GET', `/api/conversations?since=${since}`); assert.equal(all.status, 200, all.text.slice(0, 200));
    assert.ok(all.body.some((c) => c.id === postId), 'the unbounded read holds the post');
    const page = await api(base, 'GET', `/api/conversations?since=${since}&limit=20`); assert.equal(page.status, 200, page.text.slice(0, 200));
    assert.ok(page.body.some((c) => c.id === postId), 'the bounded page holds the post');
  });
});

test('U1 UNBOUNDED, LONG BUDGET: an unlimited since read whose executor answers are 4 s late still answers 200; with answers 13 s late it answers 503 before they could arrive', { skip: SKIP }, async () => {
  await withPostsAndSince(async ({ base, proxy, postId, since }) => {
    proxy.queryMs = 4000;
    const slow = await api(base, 'GET', `/api/conversations?since=${since}`);
    assert.equal(slow.status, 200, `an unbounded read is given the long budget, not the 3 s one: ${slow.status} ${slow.text.slice(0, 200)}`);
    assert.ok(slow.ms >= 3500, `the delay really happened inside this request (${slow.ms} ms)`);
    assert.ok(slow.body.some((c) => c.id === postId), 'and the list holds the post');
    proxy.queryMs = 13000;
    const hung = await api(base, 'GET', `/api/conversations?since=${since}`);
    assert.equal(hung.status, 503, `a read whose executor answers in 13 s is refused, not served late: ${hung.status} ${hung.text.slice(0, 200)}`);
    assert.equal(hung.body?.code, 'GRAPH_UNAVAILABLE', hung.text.slice(0, 200));
    assert.ok(hung.ms < 13000, `and refused BEFORE the delayed answer could have arrived (${hung.ms} ms < 13000)`);
  });
});

test('U2 BOUNDED, SHORT BUDGET: a limit-20 page whose executor answers are 4 s late is refused 503 in under 4 s', { skip: SKIP }, async () => {
  await withPostsAndSince(async ({ base, proxy, since }) => {
    proxy.queryMs = 4000;
    const page = await api(base, 'GET', `/api/conversations?since=${since}&limit=20`);
    assert.equal(page.status, 503, `a bounded page is refused, not served late: ${page.status} ${page.text.slice(0, 200)}`);
    assert.equal(page.body?.code, 'GRAPH_UNAVAILABLE', page.text.slice(0, 200));
    assert.ok(page.ms < 4000, `and it is refused BEFORE the delayed answer could have arrived (${page.ms} ms < 4000): the bounded page keeps the short bound`);
  });
});
