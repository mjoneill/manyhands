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
