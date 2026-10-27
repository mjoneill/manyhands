/**
 * #1795 — the Raised-hands panel's BOOT read must not become a retry storm when it FAILS.
 *
 * #1392 made the steady state read deltas; its rows all run against a board that answers. Measured 2026-10-27 01:20–01:38Z
 * on prod: the unfiltered boot read failed under load, the page took the error reply for "zero posts", `convoSince` stayed
 * unset, and every 8 s tick started ANOTHER whole-corpus read. Each ran 30–90 s, so they overlapped and kept the executor
 * saturated, which kept them failing. One tab, 64 reads, 3,845 s of executor time.
 *
 * Two rows, two sabotages that fail DIFFERENTLY:
 *   F1  the boot read answers 503: over ~40 s the page makes at most 2 full reads (backoff), not one per tick.
 *       Sabotage: drop the backoff → 5–6 reads. (Drop the r.ok check alone: a 503 with JSON is "zero posts" → also a storm.)
 *   F2  the boot read HANGS: while it is outstanding no second full read starts (one refresh at a time).
 *       Sabotage: drop the in-flight guard → a new full read every tick.
 * And a CONTROL in F1: once the read answers again the panel loads and moves on to deltas, so "never fetch again" fails it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withBrowserServer } from './helpers/harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isFull = (u) => u.pathname === '/api/conversations' && ![...u.searchParams.keys()].length;
const isDelta = (u) => u.pathname === '/api/conversations' && u.searchParams.has('since');
const board = { cards: [], columns: [{ id: 'backlog', name: 'Backlog', order: 0 }], conversations: [{ id: 'm1', author: 'bo', body: 'hello room', createdAt: '2026-10-27T01:00:00.000Z', attachedTo: null }], nextShortId: 10 };

test('#1795 F1 a FAILING boot read backs off (at most 2 full reads in ~40 s), and loads once the board answers again', { timeout: 120000 }, async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    let failing = true; const full = []; const delta = [];
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = new URL(req.url());
      if (isFull(u)) { full.push(Date.now()); if (failing) return req.respond({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'the graph could not be read', code: 'GRAPH_UNAVAILABLE' }) }); }
      if (isDelta(u)) delta.push(Date.now());
      req.continue();
    });
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'domcontentloaded' });
    await sleep(40_000);
    assert.ok(full.length >= 1, 'PRECONDITION: the page made its boot read');
    assert.ok(full.length <= 2, `a failing boot read backs off, never one whole-corpus read per 8 s tick — saw ${full.length} in ~40 s`);
    failing = false;
    await sleep(45_000);   // the backoff is at most 32 s at this point
    assert.ok(full.length >= 2, 'CONTROL: after the board answers, the boot read is tried again');
    assert.ok(delta.length >= 1, `CONTROL: once it succeeds the panel moves on to since= deltas (saw ${delta.length})`);
  }, { server: { board }, launch: { headless: 'new' } });
});

test('#1795 F2 a HANGING boot read is never overlapped by another full read', { timeout: 120000 }, async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    const full = [];
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = new URL(req.url());
      if (isFull(u)) { full.push(Date.now()); return; }   // never answered: the read hangs, as a 60 s executor query does
      req.continue();
    });
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'domcontentloaded' });
    await sleep(30_000);   // three ticks of the 8 s poll
    assert.equal(full.length, 1, `one refresh at a time: while the boot read is outstanding no second one starts — saw ${full.length}`);
  }, { server: { board }, launch: { headless: 'new' } });
});

// ── #144 review: the two interleavings the first rows did not cover ──────────────────────────────────────────────────
const isCards = (u) => u.pathname === '/api/cards' && !u.searchParams.has('updatedSince');

test('#1795 F3 MIXED FAILURE: a card read that fails while the whole-corpus read HANGS never lets a second corpus read start, even after the backoff', { timeout: 120000 }, async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    const full = [];
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = new URL(req.url());
      if (isFull(u)) { full.push(Date.now()); return; }   // the corpus read hangs (an executor query still running)
      if (isCards(u)) return req.abort('failed');        // the card read fails at the network
      req.continue();
    });
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'domcontentloaded' });
    await sleep(40_000);   // past the first 16 s backoff and several 8 s ticks
    assert.equal(full.length, 1, `the guard is held until BOTH reads settle: one corpus read only — saw ${full.length}`);
  }, { server: { board }, launch: { headless: 'new' } });
});

test('#1795 F3-CONTROL a healthy boot: cards and conversations both answer, one corpus read, then deltas', { timeout: 120000 }, async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    const full = []; const delta = [];
    await page.setRequestInterception(true);
    page.on('request', (req) => { const u = new URL(req.url()); if (isFull(u)) full.push(Date.now()); if (isDelta(u)) delta.push(Date.now()); req.continue(); });
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'domcontentloaded' });
    await sleep(20_000);
    assert.equal(full.length, 1, `one corpus read — saw ${full.length}`);
    assert.ok(delta.length >= 1, `then since= deltas (saw ${delta.length})`);
  }, { server: { board }, launch: { headless: 'new' } });
});

test('#1795 F4 a card read answered 503 is a FAILURE, never "no cards": the panel backs off and RETRIES the boot read, and settles once cards answer', { timeout: 120000 }, async () => {
  // A 503 accepted as an empty card page would mark the panel loaded with no cards, and it would then see only cards
  // changed AFTER boot, a silent wrong state. So the observable is the retry: one failed boot, ONE more after the backoff
  // (never one per 8 s tick), and none after that once cards answer.
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    const full = []; let cardsDown = true;
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = new URL(req.url());
      if (isFull(u)) full.push(Date.now());
      if (isCards(u) && cardsDown) return req.respond({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'cards are unavailable', code: 'CARDS_UNAVAILABLE' }) });
      req.continue();
    });
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'domcontentloaded' });
    await sleep(6_000); cardsDown = false;   // the cards come back before the first backoff (16 s) ends
    await sleep(34_000);                     // past the backoff and several ticks
    assert.equal(full.length, 2, `a failed card read is retried exactly once after its backoff, then deltas: saw ${full.length} corpus read(s)`);
  }, { server: { board }, launch: { headless: 'new' } });
});
