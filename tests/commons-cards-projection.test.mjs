/**
 * #209 (commons.html slice) — the commons page pulled BARE /api/cards TWICE
 * (refreshBlocked + the card-pointer index): 998 cards WITH FULL DESCRIPTIONS,
 * 8.49 MB each, ~17 MB per load+poll cycle, to answer questions that need
 * title/blockers/labels/claim state and never a body.
 *
 * The paged summary projection already ships: /api/cards?limit=500 returns
 * {cards, cardsTotal} with every field these consumers use and NO descriptions
 * (616 KB/page measured). This test pins the swap AND the half that makes a
 * naive swap dangerous (#209 acceptance 5): a single ?limit=500 call covers
 * 500 of N and renders a partial answer SILENTLY. So the fixture puts the
 * only person-blocker on a LOW shortId — the second page — and the panel must
 * still find it. Pages arrive ASCENDING; paging backwards uses cards[0]
 * (the LOWEST shortId), never cards[-1] (#209's measured cursor mechanics).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withBrowserServer } from './helpers/harness.mjs';

const ts = new Date(Date.UTC(2026, 7, 30, 12, 0, 0)).toISOString();
const card = (shortId, extra = {}) => ({
  id: `u-${shortId}`, shortId, title: `card ${shortId}`, description: 'x'.repeat(200),
  type: 'task', assignees: [], labels: [], for: '', priority: null,
  column: 'backlog', order: shortId, createdAt: ts, updatedAt: ts,
  relationships: { relatedTo: [], blockedBy: [] }, ...extra,
});

// 520 cards: shortIds 1..520. The FIRST page (no cursor) is the newest 500
// (21..520), so shortId 5 is reachable ONLY by paging with the before cursor.
const bigBoard = () => {
  const cards = [];
  for (let i = 1; i <= 520; i++) {
    cards.push(i === 5
      ? card(5, { blockers: [{ person: 'ada', status: 'open', note: 'second-page ask' }] })
      : card(i));
  }
  return {
    cards,
    columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
    conversations: [],
    nextShortId: 521,
  };
};

test('#209 commons.html reads the PAGED SUMMARY, never bare /api/cards — and pages to full coverage', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();

    const listRequests = [];
    page.on('request', (req) => {
      const u = new URL(req.url());
      // list reads only — /api/cards/<id> single-card routes are not this test's surface
      if (u.pathname === '/api/cards' && req.method() === 'GET') listRequests.push(u);
    });

    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });

    // ⭐ COVERAGE, the assertion a lazy swap cannot pass: the only open
    // person-blocker lives on shortId 5 — beyond the first 500-row page.
    // Bare-fetch code passes this (full corpus); single-page code does NOT.
    await page.waitForFunction(
      () => / · 1$/.test(document.getElementById('blocked-toggle').textContent),
      { timeout: 8000 },
    );

    // ⛔ THE PAYLOAD HALF: every list read must be the summary projection.
    // A bare GET /api/cards ships 998 full bodies (8.49 MB measured live);
    // the projection is the no-description default that `limit` selects.
    assert.ok(listRequests.length > 0, 'the page read the card list at least once');
    for (const u of listRequests) {
      assert.ok(u.searchParams.has('limit'),
        `bare /api/cards fetch found (${u.search || 'no params'}) — this is the 8.5 MB full-body read #209 exists to remove`);
    }

    // Positive control on the panel content itself — the blocker renders,
    // so the projection swap cannot satisfy the payload half by breaking
    // the consumer.
    await page.evaluate(() => document.getElementById('blocked-toggle').click());
    await page.waitForSelector('#blocked-panel.visible .blocked-item', { timeout: 3000 });
    const items = await page.$$eval('.blocked-item', (els) => els.map((e) => e.textContent || ''));
    assert.match(JSON.stringify(items), /second-page ask/,
      'the second-page blocker renders — coverage came from PAGING, not from the bare fetch');
  }, { server: { board: bigBoard() }, launch: { headless: 'new' } });
});
