/**
 * Board UX fixes (2026-06-16, user-reported):
 *  #232 — the per-card "open as page" 📄 glyph must be visible without hover.
 *  #233 — per-card ◀ ▶ column-move arrows: one-click move, disabled at the ends.
 *  #234 — the edit-modal Column dropdown must list CUSTOM columns and not reset
 *         a card's column on save (it was hardcoded to backlog/in-progress/done).
 *
 * Puppeteer against an isolated server (own port + temp board) — never the live
 * :3141. Fixture has a custom "Planned" column to exercise the #234 regression.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, withBrowserServer } from './helpers/harness.mjs';

const ts = '2026-05-01T00:00:00.000Z';
const card = (id, shortId, title, column) => ({
  id, shortId, title, description: '', type: 'task', assignees: ['sage'],
  labels: [], for: '', priority: null, column, order: 0,
  createdAt: ts, updatedAt: ts, relationships: { relatedTo: [], blockedBy: [] },
});

const board = {
  cards: [
    card('a', 1, 'Card A', 'backlog'),
    card('p', 2, 'Card P', 'planned-x'), // sits in a CUSTOM column
  ],
  columns: [
    { id: 'backlog', name: 'Backlog', order: 0 },
    { id: 'planned-x', name: 'Planned', order: 1 },
    { id: 'in-progress', name: 'In Progress', order: 2 },
    { id: 'done', name: 'Done', order: 3 },
  ],
  conversations: [],
  nextShortId: 3,
};

async function pollColumn(baseUrl, shortId, want, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const c = await (await fetch(`${baseUrl}/api/cards/${shortId}`)).json();
      if (c && c.column === want) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test('#232 the card "open as page" glyph is visible without hover', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.card .card-page-btn', { timeout: 5000 });
    const opacity = await page.$eval('.card .card-page-btn', (el) => parseFloat(getComputedStyle(el).opacity));
    assert.ok(opacity > 0, `page glyph discoverable without hover (opacity ${opacity})`);
  }, { server: { board }, launch: { headless: 'new' } });
});

test('#233 column-move arrows: ▶ moves to the next column; ◀ disabled at the leftmost', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.card[data-id="a"] .card-move-right', { timeout: 5000 });

    // Card A is in backlog (leftmost) → ◀ disabled, ▶ enabled.
    assert.equal(await page.$eval('.card[data-id="a"] .card-move-left', (e) => e.disabled), true, '◀ disabled at leftmost');
    assert.equal(await page.$eval('.card[data-id="a"] .card-move-right', (e) => e.disabled), false, '▶ enabled');

    // Click ▶ → Card A moves backlog → planned-x (the next column by order).
    await page.click('.card[data-id="a"] .card-move-right');
    assert.ok(await pollColumn(server.baseUrl, 1, 'planned-x'), 'Card A moved one column right via ▶');
  }, { server: { board }, launch: { headless: 'new' } });
});

test('#234 edit Column dropdown lists custom columns and preserves them on save', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.card[data-id="p"] .card-edit-btn', { timeout: 5000 });

    // Open edit on Card P (in the custom "Planned" column).
    await page.click('.card[data-id="p"] .card-edit-btn');
    await page.waitForSelector('.card[data-id="p"] .edit-column', { timeout: 5000 });

    const opts = await page.$$eval('.card[data-id="p"] .edit-column option', (els) => els.map((o) => o.value));
    assert.ok(opts.includes('planned-x'), 'custom column appears in the dropdown: ' + opts.join(','));
    const selected = await page.$eval('.card[data-id="p"] .edit-column', (e) => e.value);
    assert.equal(selected, 'planned-x', 'current custom column is preselected (NOT reset to backlog)');

    // Save without changing the column → it must STAY planned-x (the old bug reset it).
    await page.click('.card[data-id="p"] .btn-save-edit');
    assert.ok(await pollColumn(server.baseUrl, 2, 'planned-x'), 'custom column preserved through an edit-save');
  }, { server: { board }, launch: { headless: 'new' } });
});

// ── #303-4: backlog staleness expander + column collapse ──

const STALE_TS = '2026-01-01T00:00:00.000Z';   // way older than 30 days from any run
const FRESH_TS = new Date().toISOString();       // touched "now"
const mkCard = (id, shortId, title, updatedAt) => ({
  id, shortId, title, description: '', type: 'task', assignees: ['sage'], labels: [],
  for: '', priority: null, column: 'backlog', order: 0, createdAt: STALE_TS, updatedAt,
  relationships: { relatedTo: [], blockedBy: [] },
});
// 1 fresh + 6 stale (≥ STALE_MIN_TO_FOLD=5, so the fold engages).
const staleBoard = {
  cards: [
    mkCard('fresh', 1, 'Fresh Card', FRESH_TS),
    mkCard('old1', 2, 'Old One', STALE_TS),
    mkCard('old2', 3, 'Old Two', STALE_TS),
    mkCard('old3', 4, 'Old Three', STALE_TS),
    mkCard('old4', 5, 'Old Four', STALE_TS),
    mkCard('old5', 6, 'Old Five', STALE_TS),
    mkCard('old6', 7, 'Old Six', STALE_TS),
  ],
  columns: [
    { id: 'backlog', name: 'Backlog', order: 0 },
    { id: 'in-progress', name: 'In Progress', order: 1 },
    { id: 'done', name: 'Done', order: 2 },
  ],
  conversations: [],
  nextShortId: 8,
};

test('#303-4 backlog folds 30+-day-stale cards behind a "show N older" expander', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.card[data-id="fresh"]', { timeout: 5000 });

    // Fresh card shows; the two stale ones are hidden by default.
    assert.ok(await page.$('.card[data-id="fresh"]'), 'fresh card visible');
    assert.equal(await page.$('.card[data-id="old1"]'), null, 'stale card hidden by default');

    // The expander advertises the right count.
    const toggleText = await page.$eval('.stale-toggle', (e) => e.textContent);
    assert.ok(/show 6 older/.test(toggleText), 'expander shows the stale count: ' + toggleText);

    // Click it → stale cards appear.
    await page.click('.stale-toggle');
    await page.waitForSelector('.card[data-id="old1"]', { timeout: 3000 });
    assert.ok(await page.$('.card[data-id="old2"]'), 'both stale cards revealed after expand');
  }, { server: { board: staleBoard }, launch: { headless: 'new' } });
});

test('#303-4 a column can be collapsed to just its header (persists across re-render)', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.column[id="column-backlog"] .card', { timeout: 5000 });

    // Collapse the backlog column.
    await page.click('.column-header[data-column-id="backlog"] .column-collapse-btn');
    await page.waitForSelector('.column[id="column-backlog"].collapsed', { timeout: 3000 });
    const bodyHidden = await page.$eval('.column[id="column-backlog"] .column-body',
      (el) => getComputedStyle(el).display === 'none');
    assert.ok(bodyHidden, 'collapsed column body is hidden');

    // Force a re-render (add a card via API poll) — collapse state must survive.
    await page.evaluate(() => window.renderBoard && window.renderBoard());
    const stillCollapsed = await page.$('.column[id="column-backlog"].collapsed');
    assert.ok(stillCollapsed, 'collapse state persists across re-render');
  }, { server: { board: staleBoard }, launch: { headless: 'new' } });
});
