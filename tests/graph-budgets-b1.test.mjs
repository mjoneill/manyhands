/**
 * THE READ BUDGET IS FOR READS ONLY (#1574, builder commit ed6aaae; contract owner's pin 22:12Z: "apply the short budget to READ paths, not mutation acknowledgement or UNKNOWN
 * handling"). Written by the separate test author after reading the diff of ed6aaae, which the frozen rows do not cover on one side: H1 and S6 pin that a HUNG or DEAD executor
 * makes a post READ fail fast; nothing pins that a post WRITE whose executor answer is merely SLOW (longer than the read budget, well inside the write budget) still completes. A
 * mistake that bound a write path to the read client (a different line of the same file) would pass every existing row, turn a slow-but-working write into an UNKNOWN refusal at the
 * read budget, and nobody would see it until the store was slow.
 *
 * REAL executor behind a DELAYING proxy, REAL REST server with the unit on; without a python with pyoxigraph every test is SKIPPED, and a skip is NOT a pass. Synthetic content.
 *
 *   B1 A SLOW WRITE STILL COMPLETES: with the executor's update answer delayed by 5 s (above the 3 s read budget, under the 15 s write budget) an ordinary post answers 201, after
 *      the delay and not before, and the post is there afterwards. It is not refused at the read budget and not turned into an UNKNOWN 503.
 *   B2a A SLOW TARGETED READ IS CUT OFF SHORT: with the executor's query answers delayed by 5 s, a card page (a hot, interactive read) answers 503 GRAPH_UNAVAILABLE BEFORE the delayed answer
 *       would have arrived, so its bound is shorter than 5 s. No number is pinned: "3 s" is a per-request proposal, and a route can make more than one request.
 *   B2b A BULK READ GETS THE LONG BOUND (revised 22:45Z, to the two-tier plan the builder and the contract owner agreed at 22:39Z: targeted reads keep the short bound, genuinely bulk reads get a
 *       longer one, so a healthy-but-busy store is not mistaken for a hung one): with the same 5 s delay, the unlimited post list still answers 200 with the post; with a delay of 13 s it
 *       answers 503 before the delayed answer would have arrived. The long bound is pinned only as "above 5 s and below 13 s".
 *   B3 CONTROL: with no delay, the card page and the unlimited list answer 200 and the list holds the post, so the rows above are about the delays and not about the stack.
 *   (The previous B2 pinned the unlimited list at the SHORT bound; it passed on ed6aaae and is replaced by B2a and B2b.)
 *
 * NOT COVERED, by name: the exact read budget (3 s is the builder's proposal, a per-request bound, not pinned here); a write held beyond the write budget (R2's UNKNOWN rows already own
 * that); the publisher's update and its post-check (a separate call site, driven by the outbox rows); /api/changes (its graph branch shares the read client; C6 and the revised H1 pin
 * its failure shape, not its slow-read bound).
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

test('B1 A SLOW WRITE STILL COMPLETES: with the executor\'s update answer delayed 5 s (above the read budget, under the write budget) a post answers 201 after the delay, and is there afterwards', { skip: SKIP }, async () => {
  await stack(async ({ base, proxy }) => {
    proxy.updateMs = 5000;
    const w = await api(base, 'POST', '/api/conversations', { author: 'ada', body: 'a slow write b1-marker' });
    assert.equal(w.status, 201, `a slow-but-working write is not refused at the read budget: ${w.status} ${w.text.slice(0, 300)}`);
    assert.ok(w.ms >= 4500, `the 5 s delay really happened inside this request (${w.ms} ms), so the row proves something`);
    assert.ok(w.ms < 14000, `and it finished well inside the write budget (${w.ms} ms)`);
    proxy.updateMs = 0;
    const list = await api(base, 'GET', '/api/conversations');
    assert.equal(list.status, 200, list.text);
    assert.ok(list.body.some((c) => c.id === w.body.id && c.body === 'a slow write b1-marker'), 'and the post is in the list');
  });
});

async function withBoardCard(body) {
  return stack(async ({ base, proxy }) => {
    const card = await api(base, 'POST', '/api/cards', { title: 'budget card', description: 'x', createdBy: 'ada' });
    assert.ok(card.status === 200 || card.status === 201, card.text);
    const w = await api(base, 'POST', '/api/conversations', { author: 'ada', body: 'a post for the read rows b2-marker', attachedTo: card.body.id });
    assert.equal(w.status, 201, w.text);
    return body({ base, proxy, cardId: card.body.id, postId: w.body.id });
  });
}

test('B3 CONTROL: with no delay, the card page and the unlimited list answer 200 and the list holds the post', { skip: SKIP }, async () => {
  await withBoardCard(async ({ base, cardId, postId }) => {
    const page = await api(base, 'GET', `/api/cards/${cardId}`); assert.equal(page.status, 200, page.text.slice(0, 200));
    const list = await api(base, 'GET', '/api/conversations'); assert.equal(list.status, 200, list.text.slice(0, 200));
    assert.ok(list.body.some((c) => c.id === postId), 'and holds the post');
  });
});

test('B2a A SLOW TARGETED READ IS CUT OFF SHORT: with the executor\'s query answers delayed 5 s, the card page answers 503 GRAPH_UNAVAILABLE before the delayed answer could have arrived', { skip: SKIP }, async () => {
  await withBoardCard(async ({ base, proxy, cardId }) => {
    proxy.queryMs = 5000;
    const slow = await api(base, 'GET', `/api/cards/${cardId}`);
    assert.equal(slow.status, 503, `a card page whose executor answers in 5 s is refused, not served late: ${slow.status} ${slow.text.slice(0, 200)}`);
    assert.equal(slow.body?.code, 'GRAPH_UNAVAILABLE', slow.text.slice(0, 200));
    assert.ok(slow.ms < 5000, `and it is refused BEFORE the delayed answer could have arrived (${slow.ms} ms < 5000): the targeted read has its own, shorter bound`);
  });
});

test('B2b A BULK READ GETS THE LONG BOUND: with the same 5 s delay the unlimited list still answers 200 with the post; with a 13 s delay it answers 503 before the delayed answer could have arrived', { skip: SKIP }, async () => {
  await withBoardCard(async ({ base, proxy, postId }) => {
    proxy.queryMs = 5000;
    const busy = await api(base, 'GET', '/api/conversations');
    assert.equal(busy.status, 200, `a healthy-but-busy store is not mistaken for a hung one: ${busy.status} ${busy.text.slice(0, 200)}`);
    assert.ok(busy.ms >= 4500, `the 5 s delay really happened inside this request (${busy.ms} ms)`);
    assert.ok(busy.body.some((c) => c.id === postId), 'and the list holds the post');
    proxy.queryMs = 13000;
    const hung = await api(base, 'GET', '/api/conversations');
    assert.equal(hung.status, 503, `a bulk read whose executor answers in 13 s is refused, not served late: ${hung.status} ${hung.text.slice(0, 200)}`);
    assert.equal(hung.body?.code, 'GRAPH_UNAVAILABLE', hung.text.slice(0, 200));
    assert.ok(hung.ms < 13000, `and it is refused BEFORE the delayed answer could have arrived (${hung.ms} ms < 13000)`);
  });
});
