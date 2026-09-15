/**
 * #1392 — THE RAISED-HANDS POLL MUST NOT RE-READ THE WORLD EVERY 8 SECONDS.
 *
 * Measured 2026-09-15T03:57Z on prod: `refreshBlocked` fetched
 * `GET /api/conversations` UNFILTERED — 45,056,767 bytes, 27,131 messages,
 * 0.50 s of REST's single thread — plus three 1 MB card pages, every 8 s, per
 * open commons tab, then rebuilt the panel whether or not anything had
 * changed. One tab ≈ 80 MB of JSON churn per tick and ~6 % of REST; a
 * 17-day-old tab was the process that put the box into swap the night before.
 *
 * The fix: full read ONCE, then `since=` / `updatedSince=` deltas merged into
 * kept state, and a render only when a delta arrived. Both filters already
 * existed on the server; the page never used them.
 *
 * Two tests, two sabotages that fail DIFFERENTLY:
 *   - drop the `since=` filter  → test 1 counts a second full read
 *   - drop the delta merge      → test 2 never sees the new raise
 * A single test could be satisfied by "never fetch again", which is why the
 * second one exists.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withBrowserServer } from './helpers/harness.mjs';

const ts = (n) => new Date(Date.UTC(2026, 8, 15, 10, n, 0)).toISOString();
const card = (id, shortId, title, extra = {}) => ({
  id, shortId, title, description: '', type: 'task', assignees: [],
  labels: [], for: '', priority: null, column: 'backlog', order: 0,
  createdAt: ts(1), updatedAt: ts(1), version: 1,
  relationships: { relatedTo: [], blockedBy: [] }, ...extra,
});

const board = {
  cards: [
    card('quiet', 10, 'nothing waiting here'),
    card('later', 20, 'a hand goes up on this one during the test'),
  ],
  columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
  conversations: [
    { id: 'm1', author: 'bo', body: 'hello room', createdAt: ts(2), attachedTo: null },
  ],
  nextShortId: 30,
};

// Two ticks of the 8 s poll, with margin. The interval is the page's own —
// a test knob would measure a page nobody ships.
const TWO_TICKS_MS = 18_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every REST read the page made, by path + query, in order. */
function recordReads(page) {
  const reads = [];
  page.on('request', (req) => {
    const u = new URL(req.url());
    if (u.pathname.startsWith('/api/')) reads.push({ path: u.pathname, q: Object.fromEntries(u.searchParams) });
  });
  return reads;
}

test('#1392 after the first load, the raised-hands poll reads DELTAS, never the whole corpus again', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    const reads = recordReads(page);
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#blocked-toggle', { timeout: 5000 });
    await sleep(TWO_TICKS_MS);

    const convos = reads.filter((r) => r.path === '/api/conversations');
    const full = convos.filter((r) => !('since' in r.q) && !('attachedTo' in r.q) && !('limit' in r.q));
    const delta = convos.filter((r) => 'since' in r.q && !('attachedTo' in r.q));
    assert.equal(full.length, 1,
      `the unfiltered /api/conversations read is a boot cost, paid ONCE — saw ${full.length}: ${JSON.stringify(convos)}`);
    assert.ok(delta.length >= 2,
      `two ticks should have produced at least two since= reads — saw ${delta.length}: ${JSON.stringify(convos)}`);
    for (const r of delta) assert.match(r.q.since, /^\d{4}-\d{2}-\d{2}T/, `since= must be an ISO stamp, got ${r.q.since}`);

    const cards = reads.filter((r) => r.path === '/api/cards');
    const fullCards = cards.filter((r) => !('updatedSince' in r.q));
    const deltaCards = cards.filter((r) => 'updatedSince' in r.q);
    // Boot pays the paged summary read for the panel AND once more for the
    // #294 pointer index; neither is a per-tick cost. What must not happen is
    // a third, fourth, fifth… as the ticks go by.
    assert.ok(fullCards.length <= 2,
      `unfiltered card pages are a boot cost, not a tick cost — saw ${fullCards.length}: ${JSON.stringify(cards)}`);
    assert.ok(deltaCards.length >= 2,
      `two ticks should have produced at least two updatedSince= reads — saw ${deltaCards.length}: ${JSON.stringify(cards)}`);
  }, { server: { board }, launch: { headless: 'new' } });
});

test('#1392 a hand raised AFTER the page loaded still reaches the panel through the delta', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#blocked-toggle', { timeout: 5000 });
    const before = await page.$eval('#blocked-toggle', (el) => el.textContent.trim());
    assert.match(before, /· 0$/, `the board starts with no raised hands: "${before}"`);

    // A raise lands on #20 from outside the page — the server's clock stamps it.
    const res = await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'bo', body: '🚧 need a decision on the colour', attachedTo: 'later' }),
    });
    assert.equal(res.status, 201, `the raise must land: ${res.status} ${await res.text()}`);

    await page.waitForFunction(
      () => /· 1$/.test(document.getElementById('blocked-toggle').textContent.trim()),
      { timeout: TWO_TICKS_MS, polling: 500 },
    );
    await page.evaluate(() => document.getElementById('blocked-toggle').click());
    await page.waitForSelector('#blocked-panel.visible .blocked-group', { timeout: 5000 });
    const refs = await page.$$eval('.blocked-ref', (els) => els.map((e) => e.textContent.trim()));
    assert.deepEqual(refs, ['#20'], `the delta must carry the raise into the panel: ${JSON.stringify(refs)}`);
  }, { server: { board }, launch: { headless: 'new' } });
});

test('#1392 a blocker written to a CARD after load reaches the panel through updatedSince', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#blocked-toggle', { timeout: 5000 });

    // #1132 — blockers replace the whole array, so the write names the version it read.
    const { version } = await (await fetch(`${server.baseUrl}/api/cards/later`)).json();
    const res = await fetch(`${server.baseUrl}/api/cards/later`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: 'bo', ifVersion: version, blockers: [{ person: 'bex', status: 'open', note: 'pick one' }] }),
    });
    assert.equal(res.status, 200, `the blocker must land: ${res.status} ${await res.text()}`);

    await page.waitForFunction(
      () => /· 1$/.test(document.getElementById('blocked-toggle').textContent.trim()),
      { timeout: TWO_TICKS_MS, polling: 500 },
    );
    await page.evaluate(() => document.getElementById('blocked-toggle').click());
    await page.waitForSelector('#blocked-panel.visible .blocked-group', { timeout: 5000 });
    const refs = await page.$$eval('.blocked-ref', (els) => els.map((e) => e.textContent.trim()));
    assert.deepEqual(refs, ['#20'], `the card delta must carry the blocker into the panel: ${JSON.stringify(refs)}`);
  }, { server: { board }, launch: { headless: 'new' } });
});
