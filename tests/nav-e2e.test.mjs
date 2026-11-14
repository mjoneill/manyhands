/**
 * #303-2 — end-to-end nav parity. Each of the four surfaces must render the
 * shared header with all four links and its own tab marked active. This is the
 * regression guard for the "I can't see Settings from the commons" finding.
 *
 * #488 — this is also the SERVED lane, and the served page is the product. So
 * these tests refuse ANY page error, with no allow-list. The direct-file runner
 * tolerates a named set of `file://` CORS failures because they are properties
 * of that sandbox; here there is no sandbox to blame. A module that fails to
 * load, or a script that throws, is a defect on the surface a stranger actually
 * uses — and every module-backed feature is exercised through this door.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, withBrowserServer } from './helpers/harness.mjs';

const ts = '2026-05-01T00:00:00.000Z';
const board = {
  cards: [{
    id: 'c1', shortId: 1, title: 'Anchor', description: 'a page', type: 'reference',
    assignees: ['sage'], labels: [], for: '', priority: null, column: 'backlog',
    order: 0, createdAt: ts, updatedAt: ts, relationships: { relatedTo: [], blockedBy: [] },
  }],
  columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
  conversations: [],
  nextShortId: 2,
};

const EXPECTED_LABELS = ['▦ Board', '📖 Wiki', '💬 Commons', '⚙️ Settings'];
const SURFACES = [
  { path: '/', active: '▦ Board' },
  { path: '/wiki.html', active: '📖 Wiki' },
  { path: '/commons.html', active: '💬 Commons' },
  { path: '/settings.html', active: '⚙️ Settings' },
];

for (const s of SURFACES) {
  test(`#303-2 ${s.path} shows all four nav links, with "${s.active}" active`, async () => {
    await withBrowserServer(async ({ server, browser }) => {
      const page = await browser.newPage();
      // #488 — the served lane is intolerant of page errors, full stop.
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
      page.on('console', (msg) => {
        if (msg.type() === 'error') pageErrors.push(`console.error: ${msg.text()}`);
      });

      await page.goto(`${server.baseUrl}${s.path}`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('.topnav .navlink', { timeout: 5000 });

      const labels = await page.$$eval('.topnav .navlink', (els) => els.map((e) => e.textContent.trim()));
      for (const want of EXPECTED_LABELS) {
        assert.ok(labels.includes(want), `${s.path} nav includes ${want} (saw: ${labels.join(', ')})`);
      }

      const active = await page.$$eval('.topnav .navlink.active', (els) => els.map((e) => e.textContent.trim()));
      assert.deepEqual(active, [s.active], `${s.path} marks exactly "${s.active}" active`);

      // Asserted LAST so a genuine nav failure reports as a nav failure rather
      // than as whatever error it also happened to emit.
      assert.deepEqual(
        pageErrors, [],
        `${s.path} served by the real server must produce no page errors; saw:\n  ${pageErrors.join('\n  ')}`,
      );
    }, { server: { board }, launch: { headless: 'new' } });
  });
}

// #1894 — the shared nav is seven no-wrap buttons: at 390px it was 447px wide, and the seventh item (Reading) made it 506px, so
// index, wiki, commons, insights and settings scrolled sideways on a phone. Under 560px the nav wraps onto a second row; wide
// layouts keep their one row. Measured on the SERVED page, as the product is used.
// wiki.html is not in this list on purpose: at 390px its own two-pane layout (#main, 60px padding) is 436px wide with the nav hidden, a
// wiki fault the nav's 506px used to mask. It is a separate card, not the nav's.
const PHONE_SURFACES = SURFACES.filter((s) => ['/', '/commons.html', '/settings.html'].includes(s.path));
for (const width of [390, 480]) {
  test(`#1894 at ${width}px no surface scrolls sideways because of the nav`, async () => {
    await withBrowserServer(async ({ server, browser }) => {
      for (const s of PHONE_SURFACES) {
        const page = await browser.newPage();
        await page.setViewport({ width, height: 800 });
        await page.goto(`${server.baseUrl}${s.path}`, { waitUntil: 'networkidle0' });
        await page.waitForSelector('.topnav .navlink', { timeout: 5000 });
        const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth,
          right: Math.max(...[...document.querySelectorAll('.topnav .navlink')].map((e) => e.getBoundingClientRect().right)) }));
        assert.ok(m.sw <= m.iw, `${s.path} @${width}px: scrollWidth ${m.sw} > innerWidth ${m.iw}`);
        assert.ok(m.right <= m.iw, `${s.path} @${width}px: a nav link ends at ${m.right}, past the ${m.iw}px viewport`);
        await page.close();
      }
    }, { server: { board }, launch: { headless: 'new' } });
  });
}

test('#1894 at 1024px the header is still ONE row of nav links, and a phone gets more than one (the wrap is real)', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const rows = async (width, path) => {
      const page = await browser.newPage();
      await page.setViewport({ width, height: 800 });
      await page.goto(`${server.baseUrl}${path}`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('.topnav .navlink', { timeout: 5000 });
      const n = await page.$$eval('.topnav .navlink', (els) => new Set(els.map((e) => e.getBoundingClientRect().top)).size);
      await page.close();
      return n;
    };
    for (const s of SURFACES) assert.equal(await rows(1024, s.path), 1, `${s.path} @1024px: the nav is one row, as before`);
    assert.ok(await rows(390, '/') > 1, 'at 390px the nav wraps onto more than one row (so the test above is not passing by accident)');
  }, { server: { board }, launch: { headless: 'new' } });
});
