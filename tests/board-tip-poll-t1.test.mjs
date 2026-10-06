/**
 * #1607 — AN IDLE BOARD TAB MUST COST WORK IN PROPORTION TO WHAT CHANGED. Today the board page polls `GET /api/conversations?since=<newest loaded>` with no limit every 5 s; with the graph unit on that
 * shape scans every Comment through a STR() filter (about 1 s of executor time per poll per tab on the live store), so open tabs fill the read gate. The builder's design (card #1607, 14:28Z, settled
 * by the contract owner): a new keyword `afterCommit=tip` on the existing commit-ordered discovery route returns the CURRENT cursor with no posts and no scan; the page fetches `tip` FIRST, then its initial list,
 * then polls `afterCommit=<cursor>`; 409 (another store) refetches tip plus a short list; 503 keeps the view; a board without the unit keeps the `?since=` poll. Written by the separate test author
 * BEFORE the build, black-box: REAL executor behind a recording proxy, REAL REST server, and (page rows) a real headless browser on the real board page. Synthetic content. Without a python with
 * pyoxigraph every row is SKIPPED, and a skip is NOT a pass.
 *
 * REST rows
 *   T0  CONTROL (green today): `afterCommit=start` pages to `phase:'live'`, a quiet poll answers empty and echoes its cursor, and a post published afterwards is delivered exactly once.
 *   T1  TIP COSTS NO POST SCAN: `afterCommit=tip` answers 200 `{conversations: [], phase: 'live', nextAfterCommit: gc1.…}` and, with 120 posts in the store, neither it nor the quiet poll that follows sends
 *       the executor any query that touches Comments.
 *   T2  EXACTLY ONCE: a post published between `tip` and the next poll is delivered by that poll once and by the one after it never.
 *   T4  ANOTHER STORE IS A RESYNC: after the executor behind REST is replaced by a different store, the old cursor answers 409 POST_CURSOR_EPOCH_CHANGED, and `tip` answers a fresh cursor.
 *   T5  A BOARD WITHOUT THE UNIT: `afterCommit=tip` answers 400 GRAPH_DISCOVERY_OFF, as `afterCommit=start` does.
 *   T6  A TIP CURSOR IS FILTER-SCOPED: issued for `attachedTo=A`, used with `attachedTo=B` it answers 400 CURSOR_FILTER_MISMATCH; used with A it works.
 * PAGE rows (the commons panel on the real board page, opened with `[data-commons-toggle]`)
 *   P1  ORDER: the page requests `afterCommit=tip` BEFORE its initial list (`/api/conversations?limit=50`, the panel's page size). A page that swaps them must fail this row.
 *   P2  NO WHOLE-HISTORY POLL: with the panel open for 12 s the page sends no `/api/conversations?since=` request and polls `afterCommit=gc1.…` at least once.
 *   P3  THE GAP BETWEEN TIP AND LIST: a post published while the initial list is held back is shown exactly once, and still once after the next poll.
 *   P4  CONTROL (green today): a post published after the page loaded appears in the panel within 12 s, once.
 *   P5  CONTROL (green today): on a board without the unit the page still polls `?since=` and a new post appears once.
 *   P6  RESYNC: when one poll is answered 409 POST_CURSOR_EPOCH_CHANGED the page fetches `tip` again and a post published afterwards still appears once.
 *
 * NOT COVERED, by name: commons.html (the builder asked whether it is a one-shot; the row follows his answer); the live "three or more tabs, hot reads stay 200, executor peak at or under the gate cap"
 * validation (measured on a checkpoint copy and then live, by the builder; Safari and Chrome tabs open beside seat reads); the 503 path on the page (keeps the view and retries: needs a held-down
 * executor under a real page, owed); the badge's own poll.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { makeBoardFixture, startRestServer, withBrowserServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'tip-test';
const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROSTER_FILE = path.join(os.tmpdir(), `tip-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(40000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
async function until(fn, ms, step = 250) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); } }

/** A forwarding proxy in front of the executor that RECORDS every /query body, and can be re-pointed at another executor. */
async function startProxy(execUrl) {
  const p = { target: execUrl, queries: [] };
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const buf = Buffer.concat(chunks);
    if (req.method === 'POST' && req.url === '/query') { try { p.queries.push(JSON.parse(buf.toString('utf8')).query ?? buf.toString('utf8')); } catch { p.queries.push(buf.toString('utf8')); } }
    const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
    try { const f = await fetch(`${p.target}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body: buf } : {}) }); const t = await f.text(); res.statusCode = f.status; res.end(t); }
    catch { try { req.socket.destroy(); } catch { /* gone */ } }
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r)); p.url = `http://127.0.0.1:${p.server.address().port}`;
  p.stop = () => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); });
  p.scans = () => p.queries.filter((q) => /Comment/.test(String(q))).length;
  return p;
}
const card = (shortId, title) => ({ id: `c${shortId}`, shortId, title, description: '', type: 'task', column: 'backlog', order: shortId, assignees: ['unassigned'], labels: [], priority: null, version: 1, createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z', relationships: { relatedTo: [], blockedBy: [] } });
const envFor = (url) => ({ SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' });
const fixture = () => makeBoardFixture({ cards: [card(1, 'one'), card(2, 'two')], nextShortId: 3, postSeqEpoch: EPOCH_DOC, nextPostSeq: 1 });
async function seed(base, n, tag) { for (let i = 0; i < n; i++) { const r = await api(base, 'POST', '/api/conversations', { author: 'ada', body: `${tag} seed ${i}` }); assert.equal(r.status, 201, r.text.slice(0, 200)); } }

async function restStack(body, { seedN = 0 } = {}) {
  const exec = await startExecutor({ store: tmpStore('tip-store-'), datasetId: DSID, create: true });
  const proxy = await startProxy(exec.baseUrl);
  const rest = await startRestServer({ board: fixture(), env: envFor(proxy.url) });
  try { if (seedN) await seed(rest.baseUrl, seedN, 'rest'); return await body({ base: rest.baseUrl, proxy, exec }); }
  finally { await rest.stop(); await proxy.stop(); await killExecutor(exec); }
}
const feed = (base, after, extra = '') => api(base, 'GET', `/api/conversations?afterCommit=${encodeURIComponent(after)}&limit=50${extra}`);
async function drainBootstrap(base) { let page = await feed(base, 'start'); assert.equal(page.status, 200, page.text.slice(0, 200)); const seen = [...page.body.conversations]; while (page.body.phase === 'bootstrap') { page = await feed(base, page.body.nextAfterCommit); assert.equal(page.status, 200); seen.push(...page.body.conversations); } return { seen, cursor: page.body.nextAfterCommit }; }

test('T0 CONTROL: start pages to live, a quiet poll is empty and echoes its cursor, a new post is delivered exactly once', { skip: SKIP, timeout: 180000 }, async () => {
  await restStack(async ({ base }) => {
    const { seen, cursor } = await drainBootstrap(base);
    assert.ok(seen.length >= 5, `the bootstrap delivered the seeded posts (${seen.length})`);
    assert.match(cursor, /^gc1\./, 'and ends on a live cursor');
    const quiet = await feed(base, cursor);
    assert.deepEqual(quiet.body.conversations, [], 'a quiet poll is empty'); assert.equal(quiet.body.nextAfterCommit, cursor, 'and echoes its own cursor');
    const made = await api(base, 'POST', '/api/conversations', { author: 'ada', body: 't0 new post' }); assert.equal(made.status, 201);
    const got = await feed(base, cursor);
    assert.deepEqual(got.body.conversations.map((c) => c.id), [made.body.id], 'the new post is delivered');
    const after = await feed(base, got.body.nextAfterCommit);
    assert.deepEqual(after.body.conversations, [], 'and never again');
  }, { seedN: 6 });
});

test('T1 TIP COSTS NO POST SCAN: tip answers 200 with no posts and a gc1 cursor, and neither it nor the quiet poll after it sends the executor a query that touches Comments', { skip: SKIP, timeout: 240000 }, async () => {
  await restStack(async ({ base, proxy }) => {
    await feed(base, 'start'); await sleep(300);   // warm any one-off work
    proxy.queries.length = 0;
    const tip = await feed(base, 'tip');
    assert.equal(tip.status, 200, `tip is a cursor keyword: ${tip.status} ${tip.text.slice(0, 200)}`);
    assert.deepEqual(tip.body.conversations, [], 'it carries no posts');
    assert.equal(tip.body.phase, 'live');
    assert.match(tip.body.nextAfterCommit, /^gc1\./, 'and a live cursor');
    const quiet = await feed(base, tip.body.nextAfterCommit);
    assert.deepEqual(quiet.body.conversations, [], 'the quiet poll after it is empty');
    assert.equal(proxy.scans(), 0, `no query touched Comments across tip and the quiet poll (${proxy.scans()} of ${proxy.queries.length}): ${proxy.queries.filter((q) => /Comment/.test(String(q))).map((q) => String(q).slice(0, 80)).join(' | ')}`);
  }, { seedN: 120 });
});

test('T2 EXACTLY ONCE: a post published between tip and the next poll is delivered by that poll and never again', { skip: SKIP, timeout: 180000 }, async () => {
  await restStack(async ({ base }) => {
    const tip = await feed(base, 'tip'); assert.equal(tip.status, 200, tip.text.slice(0, 200));
    const made = await api(base, 'POST', '/api/conversations', { author: 'ada', body: 't2 between tip and poll' }); assert.equal(made.status, 201);
    const p1 = await feed(base, tip.body.nextAfterCommit);
    assert.deepEqual(p1.body.conversations.map((c) => c.id), [made.body.id], 'delivered by the poll after tip');
    const p2 = await feed(base, p1.body.nextAfterCommit);
    assert.deepEqual(p2.body.conversations, [], 'and not again by the next');
  }, { seedN: 4 });
});

test('T4 ANOTHER STORE IS A RESYNC: the old cursor answers 409 POST_CURSOR_EPOCH_CHANGED after the executor is replaced, and tip answers a fresh cursor', { skip: SKIP, timeout: 240000 }, async () => {
  await restStack(async ({ base, proxy }) => {
    const tip = await feed(base, 'tip'); assert.equal(tip.status, 200, tip.text.slice(0, 200));
    const other = await startExecutor({ store: tmpStore('tip-other-'), datasetId: DSID, create: true });
    try {
      proxy.target = other.baseUrl;   // REST now talks to a DIFFERENT store with the same dataset id
      const old = await feed(base, tip.body.nextAfterCommit);
      assert.equal(old.status, 409, `the old cursor is refused: ${old.status} ${old.text.slice(0, 200)}`);
      assert.equal(old.body?.code, 'POST_CURSOR_EPOCH_CHANGED');
      const fresh = await feed(base, 'tip');
      assert.equal(fresh.status, 200, `tip answers on the new store: ${fresh.status} ${fresh.text.slice(0, 200)}`);
      assert.notEqual(fresh.body.nextAfterCommit, tip.body.nextAfterCommit, 'and the cursor is a different one');
    } finally { await killExecutor(other); }
  }, { seedN: 3 });
});

test('T5 A BOARD WITHOUT THE UNIT: afterCommit=tip answers 400 GRAPH_DISCOVERY_OFF, as start does', { timeout: 120000 }, async () => {
  const rest = await startRestServer({ board: fixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const start = await feed(rest.baseUrl, 'start'); assert.equal(start.status, 400, start.text.slice(0, 200)); assert.equal(start.body?.code, 'GRAPH_DISCOVERY_OFF');
    const tip = await feed(rest.baseUrl, 'tip');
    assert.equal(tip.status, 400, `tip is refused the same way: ${tip.status} ${tip.text.slice(0, 200)}`);
    assert.equal(tip.body?.code, 'GRAPH_DISCOVERY_OFF', tip.text.slice(0, 200));
  } finally { await rest.stop(); }
});

test('T6 A TIP CURSOR IS FILTER-SCOPED: issued for attachedTo=A it is refused for B (400 CURSOR_FILTER_MISMATCH) and works for A', { skip: SKIP, timeout: 180000 }, async () => {
  await restStack(async ({ base }) => {
    const tipA = await feed(base, 'tip', '&attachedTo=c1'); assert.equal(tipA.status, 200, tipA.text.slice(0, 200));
    const okA = await feed(base, tipA.body.nextAfterCommit, '&attachedTo=c1'); assert.equal(okA.status, 200, `the same filter works: ${okA.text.slice(0, 200)}`);
    const bad = await feed(base, tipA.body.nextAfterCommit, '&attachedTo=c2');
    assert.equal(bad.status, 400, `a different filter is refused: ${bad.status} ${bad.text.slice(0, 200)}`);
    assert.equal(bad.body?.code, 'CURSOR_FILTER_MISMATCH');
  }, { seedN: 2 });
});

// ───────────── page rows ─────────────
async function pageStack(unitOn, body) {
  if (!unitOn) {
    return withBrowserServer(async ({ server, browser }) => body({ base: server.baseUrl, browser, proxy: null }), { server: { board: fixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } } });
  }
  const exec = await startExecutor({ store: tmpStore('tip-page-'), datasetId: DSID, create: true });
  const proxy = await startProxy(exec.baseUrl);
  try { return await withBrowserServer(async ({ server, browser }) => { await seed(server.baseUrl, 5, 'page'); return body({ base: server.baseUrl, browser, proxy }); }, { server: { board: fixture(), env: envFor(proxy.url) } }); }
  finally { await proxy.stop(); await killExecutor(exec); }
}
/** Open the board, record every /api/conversations request in order, open the commons panel. Resolves with the live request log. */
async function openBoard(page, base, { holdList = null } = {}) {
  const log = [];
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const u = req.url();
    if (u.includes('/api/conversations') && req.method() === 'GET') log.push({ url: u.replace(base, ''), at: Date.now() });
    if (holdList && PANEL_LIST.test(u) && !holdList.released) { holdList.hits++; holdList.waiting.push(req); return; }
    req.continue().catch(() => {});
  });
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.board-header', { timeout: 30000 });
  await page.click('[data-commons-toggle]');
  await page.waitForSelector('#convs-panel.visible', { timeout: 30000 });
  return log;
}
/** The commons panel's own initial list: the page's CONVS_PAGE_SIZE is 50. Other consumers on the page (the badge, search) read other sizes, and must not stand in for it. */
const PANEL_LIST = /\/api\/conversations\?limit=50(&|$)/;
const shownCount = (page, text) => page.$$eval('#convs-feed .conv-msg', (els, t) => els.filter((e) => e.textContent.includes(t)).length, text);

test('P1 ORDER: the page requests afterCommit=tip BEFORE its initial list; a page that swaps them must fail', { skip: SKIP, timeout: 240000 }, async () => {
  await pageStack(true, async ({ base, browser }) => {
    const page = await browser.newPage(); const log = await openBoard(page, base);
    await until(async () => log.some((r) => PANEL_LIST.test(r.url)), 20000);
    const iTip = log.findIndex((r) => /afterCommit=tip/.test(r.url)); const iList = log.findIndex((r) => PANEL_LIST.test(r.url));
    assert.ok(iTip >= 0, `the page asks for the tip (requests: ${log.map((r) => r.url).join(' , ')})`);
    assert.ok(iList >= 0, 'and loads its initial list');
    assert.ok(iTip < iList, `tip comes first (tip at ${iTip}, list at ${iList}): the order that closes the gap`);
  });
});

test('P2 NO WHOLE-HISTORY POLL: with the panel open for 12 s the page sends no /api/conversations?since= request and polls afterCommit=gc1.…', { skip: SKIP, timeout: 240000 }, async () => {
  await pageStack(true, async ({ base, browser }) => {
    const page = await browser.newPage(); const log = await openBoard(page, base);
    await sleep(12000);
    const since = log.filter((r) => /[?&]since=/.test(r.url));
    assert.equal(since.length, 0, `no unbounded since poll (${since.length}): ${since.slice(0, 2).map((r) => r.url).join(' , ')}`);
    assert.ok(log.filter((r) => /afterCommit=gc1\./.test(r.url)).length >= 1, `it polls the commit-ordered feed instead (requests: ${log.map((r) => r.url.slice(0, 60)).join(' , ')})`);
  });
});

test('P3 THE GAP BETWEEN TIP AND LIST: a post published while the initial list is held back is shown exactly once, and still once after the next poll', { skip: SKIP, timeout: 240000 }, async () => {
  await pageStack(true, async ({ base, browser }) => {
    const page = await browser.newPage(); const hold = { hits: 0, waiting: [], released: false };
    const opening = openBoard(page, base, { holdList: hold });
    await until(async () => hold.hits >= 1, 30000);
    assert.ok(hold.hits >= 1, 'the initial list request was held');
    const made = await api(base, 'POST', '/api/conversations', { author: 'ada', body: 'p3 published in the gap' }); assert.equal(made.status, 201);
    hold.released = true; for (const r of hold.waiting) r.continue().catch(() => {});
    await opening;
    assert.ok(await until(async () => (await shownCount(page, 'p3 published in the gap')) >= 1, 15000), 'the post is shown');
    assert.equal(await shownCount(page, 'p3 published in the gap'), 1, 'exactly once');
    await sleep(7000);
    assert.equal(await shownCount(page, 'p3 published in the gap'), 1, 'and still once after the next poll');
  });
});

test('P4 CONTROL: a post published after the page loaded appears in the panel within 12 s, once', { skip: SKIP, timeout: 240000 }, async () => {
  await pageStack(true, async ({ base, browser }) => {
    const page = await browser.newPage(); await openBoard(page, base); await sleep(1500);
    const made = await api(base, 'POST', '/api/conversations', { author: 'ada', body: 'p4 arrives live' }); assert.equal(made.status, 201);
    assert.ok(await until(async () => (await shownCount(page, 'p4 arrives live')) >= 1, 12000), 'it appears within 12 s');
    await sleep(6000);
    assert.equal(await shownCount(page, 'p4 arrives live'), 1, 'once');
  });
});

test('P5 CONTROL: on a board without the unit the page still polls ?since= and a new post appears once', { timeout: 240000 }, async () => {
  await pageStack(false, async ({ base, browser }) => {
    const page = await browser.newPage(); const log = await openBoard(page, base);
    assert.equal((await api(base, 'POST', '/api/conversations', { author: 'ada', body: 'p5 no unit' })).status, 201);
    assert.ok(await until(async () => (await shownCount(page, 'p5 no unit')) >= 1, 15000), 'the post appears');
    await sleep(6000);
    assert.equal(await shownCount(page, 'p5 no unit'), 1, 'once');
    assert.ok(log.some((r) => /[?&]since=/.test(r.url)), 'through the since poll: it is the fallback, unchanged');
    assert.ok(!log.some((r) => /afterCommit=/.test(r.url)), 'with no afterCommit request on a board that does not serve it');
  });
});

test('P6 RESYNC: when one poll is answered 409 POST_CURSOR_EPOCH_CHANGED the page fetches tip again and a post published afterwards still appears once', { skip: SKIP, timeout: 240000 }, async () => {
  await pageStack(true, async ({ base, browser }) => {
    const page = await browser.newPage(); const log = [];
    await page.setRequestInterception(true);
    let injected = false; let listSeen = false;
    page.on('request', (req) => {
      const u = req.url();
      if (u.includes('/api/conversations') && req.method() === 'GET') { log.push(u.replace(base, '')); if (PANEL_LIST.test(u)) listSeen = true; }
      // the badge also polls afterCommit; the 409 goes to the first commit-ordered poll AFTER the panel's own list, which is the panel's poll
      if (!injected && listSeen && /afterCommit=gc1\./.test(u)) { injected = true; req.respond({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'another store', code: 'POST_CURSOR_EPOCH_CHANGED', resync: 'afterCommit=start' }) }).catch(() => {}); return; }
      req.continue().catch(() => {});
    });
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' }); await page.waitForSelector('.board-header', { timeout: 30000 });
    await page.click('[data-commons-toggle]'); await page.waitForSelector('#convs-panel.visible', { timeout: 30000 });
    assert.ok(await until(async () => injected, 15000), 'the panel polls the commit-ordered feed, and one of its polls was answered 409');
    await sleep(6000);
    assert.ok(log.filter((u) => /afterCommit=tip/.test(u)).length >= 2, `after the 409 the page asks for the tip again (requests: ${log.map((u) => u.slice(0, 50)).join(' , ')})`);
    const made = await api(base, 'POST', '/api/conversations', { author: 'ada', body: 'p6 after the resync' }); assert.equal(made.status, 201);
    assert.ok(await until(async () => (await shownCount(page, 'p6 after the resync')) >= 1, 15000), 'a post published after the resync appears');
    await sleep(6000);
    assert.equal(await shownCount(page, 'p6 after the resync'), 1, 'once');
  });
});
