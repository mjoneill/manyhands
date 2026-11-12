/**
 * #1879 — A TAB WHOSE FIRST `tip` FAILS MUST NOT POLL THE WHOLE HISTORY FOR GOOD. With the graph unit on, the board page (index.html) and the Commons page (commons.html) each take a commit-feed
 * cursor from `GET /api/conversations?afterCommit=tip` once, at load. Read on origin/main b3c0b73: when that one request fails (a 503 under load, a dropped socket), the cursor stays null and every later
 * tick takes the `?since=` poll, which is the whole-history read #1607 exists to retire. Nothing ever asks for `tip` again until the tab is reloaded. Found by reading the code (11-11 23:15Z);
 * these rows make it a measured property. A REAL REST server with the unit on, a REAL executor, a real headless browser. Without a python with pyoxigraph the rows are SKIPPED, and a skip is NOT a pass.
 *
 *   R1  BOARD PAGE: the page's first `afterCommit=tip` is answered 503. Within 15 s the page asks for `tip` again; after that tick it sends no `?since=` request for two more ticks and polls
 *       `afterCommit=gc1.…`; and a post published after that appears in the commons panel exactly once.
 *   R2  COMMONS PAGE: the same, for `/commons.html` and its 8 s tick: a second `tip`, then no `?since=` for two more ticks, and `afterCommit=gc1.…` polled.
 *   R3  A BOARD THAT SAYS IT HAS NO FEED STAYS ON `since` QUIETLY: every `tip` is answered 400 GRAPH_DISCOVERY_OFF (the server's own "no feed" answer). The page asks for `tip` at most once more after
 *       load in 15 s (no per-tick hammering of a route that has said no), and a new post still appears once through the `since` poll.
 *
 * Must-fail control: R1 and R2 are RED against the page code at b3c0b73 (the cursor stays null, so no second `tip` is ever sent). The unit-off path (flag false) is P5 in board-tip-poll-t1, unchanged.
 * NOT COVERED, by name: core/commons-panel.mjs (the badge) takes no `tip`; the 409 resync path (P6); how often a failing `tip` is retried beyond "on a later tick".
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBoardFixture, withBrowserServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'tip-retry-test';
const EPOCH_DOC = '11111111-2222-4333-8444-555555555555';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROSTER_FILE = path.join(os.tmpdir(), `tip-retry-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
after(() => { try { fs.unlinkSync(ROSTER_FILE); } catch { /* gone */ } });
async function until(fn, ms, step = 250) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); } }
const card = (shortId, title) => ({ id: `c${shortId}`, shortId, title, description: '', type: 'task', column: 'backlog', order: shortId, assignees: ['unassigned'], labels: [], priority: null, version: 1, createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z', relationships: { relatedTo: [], blockedBy: [] } });
const fixture = () => makeBoardFixture({ cards: [card(1, 'one'), card(2, 'two')], nextShortId: 3, postSeqEpoch: EPOCH_DOC, nextPostSeq: 1 });
const post = async (base, body) => { const r = await fetch(`${base}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ author: 'ada', body }) }); assert.equal(r.status, 201); return r.json(); };

async function unitStack(body) {
  const store = tmpStore('tip-retry-');
  const exec = await startExecutor({ store, datasetId: DSID, create: true });
  try {
    return await withBrowserServer(async ({ server, browser }) => { for (let i = 0; i < 4; i++) await post(server.baseUrl, `seed ${i}`); return body({ base: server.baseUrl, browser }); },
      { server: { board: fixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' } } });
  } finally { await killExecutor(exec); fs.rmSync(store, { recursive: true, force: true }); }
}

/** The PAGE's own tip: a bare `afterCommit=tip`. Other scripts on the same page ask for `afterCommit=tip&limit=200` and poll their own gc1 cursor (measured on commons.html), so neither
 *  their tips nor their gc1 polls can stand in for the page's. */
const PAGE_TIP = /[?&]afterCommit=tip$/;
/** Record every GET /api/conversations in order; answer the page's `tip` with `answer(n)` (n = how many page tips so far, 1-based) when it returns a response, else pass through. */
async function recordAndFailTip(page, base, answer) {
  const log = []; let tips = 0;
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('/api/conversations') && req.method() === 'GET') {
      log.push({ url: u.replace(base, ''), at: Date.now() });
      if (PAGE_TIP.test(u)) { tips++; const a = answer(tips); if (a) { req.respond(a).catch(() => {}); return; } }
    }
    req.continue().catch(() => {});
  });
  return log;
}
const UNAVAILABLE = { status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'executor unavailable', code: 'GRAPH_EXECUTOR_UNAVAILABLE' }) };
const DISCOVERY_OFF = { status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'commit-ordered discovery is not served', code: 'GRAPH_DISCOVERY_OFF' }) };
const shownCount = (page, text) => page.$$eval('#convs-feed .conv-msg', (els, t) => els.filter((e) => e.textContent.includes(t)).length, text);
const urls = (log) => log.map((r) => r.url.slice(0, 50)).join(' , ');
const pageTips = (log) => log.filter((r) => PAGE_TIP.test(r.url));
/** After the retried tip, the page's tick runs ONE since read (by design: it covers the gap between the old high-water and the new cursor). Every since request later than that tick
 *  means the page is still on the whole-history poll. The tick's own read lands within milliseconds of the tip; 2 s is a wide margin and still far below the 5 s and 8 s intervals. */
const SAME_TICK_MS = 2000;
async function assertSwitched(log, waitMs) {
  const tips = pageTips(log);
  const retryAt = tips[1].at;
  await sleep(waitMs);
  const later = log.filter((r) => r.at > retryAt + SAME_TICK_MS);
  const since = later.filter((r) => /[?&]since=/.test(r.url));
  assert.equal(since.length, 0, `no whole-history since poll after the retry tick (${since.length} in ${waitMs / 1000} s): ${since.slice(0, 2).map((r) => r.url).join(' , ')}`);
  assert.ok(later.some((r) => /afterCommit=gc1\./.test(r.url)), `and the commit-ordered feed is polled after it (requests: ${urls(later)})`);
}

async function openBoardPanel(page, base) {
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.board-header', { timeout: 30000 });
  await page.click('[data-commons-toggle]');
  await page.waitForSelector('#convs-panel.visible', { timeout: 30000 });
}

test('R1 BOARD PAGE: a first tip answered 503 is retried on a later tick, the page moves onto the feed, and stops polling since', { skip: SKIP, timeout: 240000 }, async () => {
  await unitStack(async ({ base, browser }) => {
    const page = await browser.newPage();
    const log = await recordAndFailTip(page, base, (n) => (n === 1 ? UNAVAILABLE : null));
    await openBoardPanel(page, base);
    const retried = await until(async () => pageTips(log).length >= 2, 15000);
    assert.ok(retried, `after a failed first tip the page asks for tip again on a later tick (requests: ${urls(log)})`);
    await assertSwitched(log, 11000);   // two 5 s ticks past the retry
    await post(base, 'r1 after the retry');
    assert.ok(await until(async () => (await shownCount(page, 'r1 after the retry')) >= 1, 15000), 'a post published after the retry appears');
    await sleep(6000);
    assert.equal(await shownCount(page, 'r1 after the retry'), 1, 'once');
  });
});

test('R2 COMMONS PAGE: a first tip answered 503 is retried on a later tick, the page moves onto the feed, and stops polling since', { skip: SKIP, timeout: 240000 }, async () => {
  await unitStack(async ({ base, browser }) => {
    const page = await browser.newPage();
    const log = await recordAndFailTip(page, base, (n) => (n === 1 ? UNAVAILABLE : null));
    await page.goto(`${base}/commons.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body', { timeout: 30000 });
    const retried = await until(async () => pageTips(log).length >= 2, 25000);
    assert.ok(retried, `after a failed first tip the Commons page asks for tip again on a later tick (requests: ${urls(log)})`);
    await assertSwitched(log, 17000);   // two 8 s ticks past the retry
  });
});

test('R3 A BOARD THAT SAYS IT HAS NO FEED: tip answered 400 GRAPH_DISCOVERY_OFF is not re-asked every tick, and posts still arrive through since', { skip: SKIP, timeout: 240000 }, async () => {
  await unitStack(async ({ base, browser }) => {
    const page = await browser.newPage();
    const log = await recordAndFailTip(page, base, () => DISCOVERY_OFF);
    await openBoardPanel(page, base);
    await sleep(15000);
    const tips = pageTips(log).length;
    assert.ok(tips <= 2, `a route that answered "no feed" is not hammered: ${tips} tip requests in ~15 s (requests: ${urls(log)})`);
    await post(base, 'r3 through since');
    assert.ok(await until(async () => (await shownCount(page, 'r3 through since')) >= 1, 15000), 'a new post still appears');
    await sleep(6000);
    assert.equal(await shownCount(page, 'r3 through since'), 1, 'once');
    assert.ok(log.some((r) => /[?&]since=/.test(r.url)), 'through the since poll, the fallback for a board with no feed');
  });
});
