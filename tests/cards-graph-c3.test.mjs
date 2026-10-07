/**
 * #1598 K7, THIRD FILE: A SLOW EXECUTOR IS NOT A DOWN ONE. `cards-graph-c1.test.mjs` and `cards-graph-c2.test.mjs` are unchanged by this file. This file pins the availability contract the review of the K7 probe settled (the reviewer,
 * 06:14Z and 06:16Z, adopted by the builder on #1598): the K7 read half STAYS (executor unavailable: a card-dependent read is a 503), the probe is SINGLE-FLIGHT with a 2 s timeout, there is NO cached UP result (a brief cached DOWN is allowed), and K7 covers
 * the routes that actually depend on cards. It is written from tonight's incident: a recovery path that probes the executor on every request turns a saturated executor into a board-wide outage, and adds the load that keeps it saturated.
 * Same template: REST with a REAL executor behind a proxy that can DELAY every executor response, synthetic content. Without a python with pyoxigraph the rows are SKIPPED, and a skip is NOT a pass. Switch: `SCRUM_GRAPH_UNIT_CARDS`.
 *
 *   C10a  A SLOW EXECUTOR GETS A FAST 503 ON A CARD-DEPENDENT READ: with every executor response delayed by 6 s, a card read answers 503 within 4.5 s (the 2 s timeout plus slack), never a 200 that took 6 s and never a hang; with the delay removed
 *         (and a brief wait, because a cached DOWN is allowed) it answers 200 again.
 *   C10b  CARD-FREE ROUTES KEEP ANSWERING: during that same slow window `GET /api/columns`, `GET /api/roles` and `GET /api/wakes` answer 200 within 2 s: they read no card, and K7 covers the routes that do. (Column DELETE is card-dependent and is NOT in this row.)
 *   C10c  CONCURRENT REQUESTS SHARE ONE PROBE: twenty simultaneous card-LIST reads against an executor that is up but slow (300 ms per response) all answer 200, and the executor saw at most FOUR requests during them: single-flight, not one probe per request.
 *         (First version counted twenty card-BY-ID reads: the builder measured 41 requests on the single-flight build, 40 of them two comment reads per card page that are not the probe, so that row measured the wrong thing; it is the list now.)
 *   C10d  NO CACHED UP: right after the executor goes away, the very next card read is a 503 (it does not ride a "was up a moment ago"), and a card WRITE with the executor away is a 503.
 *
 * NOT COVERED, by name: which routes count as card-dependent beyond the card routes and the three card-free ones named (the full list is the build's to state; a route whose handler calls `readBoard()` is the case to watch); the brief cached DOWN's length
 * (allowed, not pinned, which is why C10a waits before expecting 200); slow executor on a WRITE; the probe's timeout exactly (a bound of 4.5 s is pinned, not 2 s); MCP above REST; the page poll.
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
const UNIT_ENV = 'SCRUM_GRAPH_UNIT_CARDS';
const ROSTER_FILE = path.join(os.tmpdir(), `c3k-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, gizmo: { name: 'Gizmo', glyph: 'g', color: '#c4a07c' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timed = async (fn) => { const t0 = Date.now(); const r = await fn(); return { ...r, ms: Date.now() - t0 }; };
const api = async (base, method, route, body, ms = 60000) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(ms) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const ALNUM = () => `${process.pid}x${Date.now().toString(36)}`.replace(/[^a-z0-9]/gi, '').toLowerCase();
const newCard = (base, title) => api(base, 'POST', '/api/cards', { title, description: 'body', createdBy: 'ada' });

/** a proxy that can DELAY every response (`delayMs`), be taken DOWN and UP, and counts every request it forwards */
async function startSlowProxy(execUrl) {
  const p = { delayMs: 0, count: 0 };
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c); p.count++;
    const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
    try {
      const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }); const t = await f.text();
      if (p.delayMs) await sleep(p.delayMs);
      res.statusCode = f.status; res.end(t);
    } catch { try { req.socket.destroy(); } catch { /* gone */ } }
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r)); p.port = p.server.address().port; p.url = `http://127.0.0.1:${p.port}`;
  p.down = () => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); });
  p.up = () => new Promise((r, j) => { p.server.once('error', j); p.server.listen(p.port, '127.0.0.1', r); });
  return p;
}
async function unitOn(body, dsid = 'c3k-test') {
  const exec = await startExecutor({ store: tmpStore('c3k-store-'), datasetId: dsid, create: true });
  const proxy = await startSlowProxy(exec.baseUrl);
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', [UNIT_ENV]: '1' } });
  try { return await body({ base: rest.baseUrl, rest, proxy, exec }); } finally { await rest.stop(); try { await proxy.down(); } catch { /* down */ } await killExecutor(exec); }
}

test('C10a + C10b A SLOW EXECUTOR GETS A FAST 503 ON A CARD READ, AND CARD-FREE ROUTES KEEP ANSWERING', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, proxy }) => {
    const tag = ALNUM(); const c = (await newCard(base, `${tag} before`)).body; assert.ok(c?.id, 'CONTROL: a card is created while the executor is up');
    assert.equal((await api(base, 'GET', `/api/cards/${c.id}`)).status, 200, 'CONTROL: and read');
    proxy.delayMs = 6000; await sleep(2500);   // every executor response now takes 6 s; let any brief cached UP lapse
    const slow = await timed(() => api(base, 'GET', `/api/cards/${c.id}`, undefined, 30000));
    assert.equal(slow.status, 503, `a card read with a SLOW executor is a 503 (got ${slow.status} after ${slow.ms} ms)`);
    assert.ok(slow.ms < 4500, `and a FAST one: ${slow.ms} ms (the probe's timeout bounds it; it must not wait out the executor's 6 s)`);
    for (const route of ['/api/columns', '/api/roles', '/api/wakes']) {
      const r = await timed(() => api(base, 'GET', route, undefined, 30000));
      assert.equal(r.status, 200, `${route} reads no card and must answer while the executor is slow (got ${r.status} after ${r.ms} ms)`);
      assert.ok(r.ms < 2000, `${route} answered in ${r.ms} ms, under 2 s`);
    }
    proxy.delayMs = 0; await sleep(3500);   // a cached DOWN is allowed to linger briefly
    assert.equal((await api(base, 'GET', `/api/cards/${c.id}`)).status, 200, 'with the delay removed the card read answers 200 again');
  });
});

test('C10c CONCURRENT REQUESTS SHARE ONE PROBE: twenty simultaneous card-list reads against a slowish executor cost the executor at most four requests', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, proxy }) => {
    const tag = ALNUM(); const c = (await newCard(base, `${tag} before`)).body; assert.ok(c?.id, 'CONTROL: a card is created');
    assert.equal((await api(base, 'GET', '/api/cards?limit=5')).status, 200, 'CONTROL: and the list is read');
    await sleep(1500); proxy.delayMs = 300; await sleep(300); const n0 = proxy.count;
    // the LIST, not a card by id: a card by id also reads its comments from the graph (two executor requests of its own, which are not the probe), and this row counts the probe
    const reads = await Promise.all(Array.from({ length: 20 }, () => api(base, 'GET', '/api/cards?limit=5')));
    const seen = proxy.count - n0; proxy.delayMs = 0;
    assert.deepEqual([...new Set(reads.map((r) => r.status))], [200], `all twenty answer 200 (${JSON.stringify(reads.map((r) => r.status))})`);
    assert.ok(seen <= 4, `the executor saw ${seen} requests for twenty concurrent card-list reads: single-flight means about one, a probe per request means twenty or more`);
  });
});

test('C10d NO CACHED UP: the very next card read after the executor goes away is a 503, and a write is a 503', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, proxy }) => {
    const tag = ALNUM(); const c = (await newCard(base, `${tag} before`)).body; assert.ok(c?.id, 'CONTROL: a card is created');
    assert.equal((await api(base, 'GET', `/api/cards/${c.id}`)).status, 200, 'CONTROL: and read a moment before the executor goes');
    await proxy.down();
    const read = await api(base, 'GET', `/api/cards/${c.id}`); assert.equal(read.status, 503, `the next card read does not ride a "was up a moment ago" (${read.status})`);
    const write = await newCard(base, `${tag} during`); assert.equal(write.status, 503, `and a write is a 503 (${write.status})`);
    await sleep(300); await proxy.up();
  });
});
