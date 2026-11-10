/**
 * #1874 — THE COMMONS TAB DOES NOT POLL CHANNEL STATUS WHILE HIDDEN. Each `/api/channel-status` poll reaches MCP's
 * `/channel/status`, which reads every channel resident's deliveries on the executor (#1776: one open tab kept ~2 of
 * those multi-second reads running). A real REST server and a real headless browser; the page's visibility is driven
 * by overriding `document.visibilityState` before the page's own script runs and firing `visibilitychange`.
 *
 *   H1  HIDDEN: after the tab goes hidden, ~9 s (two 4 s ticks) pass with no channel-status request.
 *   H2  VISIBLE AGAIN: becoming visible sends one at once, without waiting for the next tick.
 *   CONTROL: while visible, the page does poll (>= 2 requests in ~9 s), so H1's zero is not a page that never polls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withBrowserServer } from './helpers/harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('#1874 H1/H2 a hidden commons tab sends no channel-status poll; becoming visible polls at once', { timeout: 120000 }, async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    const hits = [];
    page.on('request', (req) => { if (req.url().includes('/api/channel-status')) hits.push(Date.now()); });
    await page.evaluateOnNewDocument(() => {
      window.__vis = 'visible';
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__vis });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__vis === 'hidden' });
    });
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'domcontentloaded' });
    await sleep(9000);
    const visibleCount = hits.length;
    assert.ok(visibleCount >= 2, `CONTROL: a visible tab polls (${visibleCount} channel-status requests in ~9 s)`);

    await page.evaluate(() => { window.__vis = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); });
    const hiddenAt = hits.length;
    await sleep(9000);
    assert.equal(hits.length - hiddenAt, 0, `H1: no channel-status request while hidden (${hits.length - hiddenAt} sent)`);

    const t0 = Date.now();
    await page.evaluate(() => { window.__vis = 'visible'; document.dispatchEvent(new Event('visibilitychange')); });
    await sleep(1500);
    const after = hits.filter((h) => h >= t0);
    assert.ok(after.length >= 1 && after[0] - t0 < 1500, `H2: becoming visible polls at once (${after.length} within 1.5 s)`);
  });
});
