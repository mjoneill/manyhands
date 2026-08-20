/**
 * #485/#969 — READY FOR HIM vs WAITING ON PREREQUISITES.
 *
 * ⛔ THE BANANA TEST, @minimo 2026-08-20T23:01Z:
 *
 *   "Every item shown as waiting on Michael must be something he can act on
 *    NOW without another prerequisite first."
 *
 * ⇒ And her diagnosis of why the first cut isn't enough: "a panel that
 * accurately lists human dependencies but cannot distinguish 'now' from
 * 'later' still gives him a FALSE DECISION QUEUE."
 *
 * ── THE LIVE COUNTEREXAMPLE, found by @indigo the same hour ─────────────────
 * #586's blocker asked him to authorise "pointing WorkingDirectory at the
 * export." There is no export. `DEPLOY_SERVE` is unset, no serve directory
 * exists, and `deploy.sh export` has never run — so the decision sitting in his
 * queue authorised a directory that does not exist. Her words: "a decision he
 * cannot act on is not a decision — it is queue noise wearing a decision's
 * clothes." It had a claim AND a card-blocker on it too.
 *
 * ⭐ The panel already had every fact needed to know that and showed them
 * identically anyway. This is #965's own distinction — present-and-open vs
 * actually-pullable — arriving one surface over.
 *
 * ⚠️ DELIBERATELY the SAME predicate the queue uses, not a second opinion:
 * done · claimed · parked · unresolved card-blocker. Two surfaces answering
 * "can this move?" differently is how the room got two blocker registries in
 * the first place.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withBrowserServer } from './helpers/harness.mjs';

const ts = (n) => new Date(Date.UTC(2026, 7, 20, 12, n, 0)).toISOString();
const card = (id, shortId, title, extra = {}) => ({
  id, shortId, title, description: '', type: 'task', assignees: [],
  labels: [], for: '', priority: null, column: 'backlog', order: 0,
  createdAt: ts(1), updatedAt: ts(1),
  relationships: { relatedTo: [], blockedBy: [] }, ...extra,
});
const BLOCK = (note) => [{ person: 'michael', status: 'open', note }];

/**
 * Five cards, all carrying an OPEN michael-blocker. Only ONE is actually
 * actionable. A panel that cannot tell them apart shows five.
 */
const board = {
  cards: [
    // ✅ THE ONLY ACTIONABLE ONE. Nothing else stands in front of it.
    card('ready', 10, 'a decision he can make right now', { blockers: BLOCK('pick A or B') }),

    // ⛔ #586's shape: a person-blocker AND an unresolved card-blocker.
    card('prereq', 20, 'authorise a cutover to an export that does not exist', {
      blockers: BLOCK('authorise the cutover'), relationships: { relatedTo: [], blockedBy: [40] },
    }),
    // ⛔ someone is already holding it
    card('claimed', 30, 'already being worked', {
      blockers: BLOCK('approve the plan'), claimedBy: 'indigo',
    }),
    // ⛔ parked with a live expiry — an authored "not yet"
    card('parked', 35, 'deliberately deferred', {
      blockers: BLOCK('confirm'), parkedBy: 'minimo', parkedUntil: '2099-01-01T00:00:00.000Z',
    }),
    // the blocking target, NOT done, so `prereq` is genuinely blocked
    card('blocker', 40, 'the prerequisite nobody has built', {}),
  ],
  columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
  conversations: [],
  nextShortId: 50,
};

const groups = (page) => page.$$eval('.blocked-group', (els) => els.map((e) => ({
  head: (e.querySelector('.blocked-group-head')?.textContent || '').trim(),
  refs: [...e.querySelectorAll('.blocked-ref')].map((r) => r.textContent.trim()).sort(),
})));

test('#485 the panel separates READY-FOR-HIM from WAITING-ON-PREREQUISITES', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#blocked-toggle', { timeout: 5000 });
    await page.evaluate(() => document.getElementById('blocked-toggle').click());
    await page.waitForSelector('#blocked-panel.visible .blocked-group', { timeout: 5000 });

    const g = await groups(page);

    const ready = g.find((x) => /waiting on/i.test(x.head) && !/prerequisite/i.test(x.head));
    assert.ok(ready, `no ready-for-a-person group: ${JSON.stringify(g)}`);
    assert.deepEqual(ready.refs, ['#10'],
      'ONLY the card with nothing in front of it may be presented as his to act on — '
      + `#20 is card-blocked, #30 is claimed, #35 is parked: ${JSON.stringify(g)}`);

    const later = g.find((x) => /prerequisite/i.test(x.head));
    assert.ok(later, `no waiting-on-prerequisites group: ${JSON.stringify(g)}`);
    assert.deepEqual(later.refs, ['#20', '#30', '#35'],
      'the three that need something else first must be VISIBLE but SEPARATE — hiding them '
      + 'would lose his future authority; mixing them gives him a false decision queue');
  }, { server: { board }, launch: { headless: 'new' } });
});

/**
 * ⭐ THE COUNT IS THE PART HE READS. A chip saying 4 when one thing is his is
 * the false queue in one number.
 */
test('#485 the ready-for-a-person heading carries the ACTIONABLE count', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.getElementById('blocked-toggle').click());
    await page.waitForSelector('#blocked-panel.visible .blocked-group', { timeout: 5000 });
    const g = await groups(page);
    const ready = g.find((x) => /waiting on/i.test(x.head) && !/prerequisite/i.test(x.head));
    assert.match(ready.head, /\b1\b/, `the heading must say ONE, not four: "${ready.head}"`);
  }, { server: { board }, launch: { headless: 'new' } });
});

/**
 * ⛔ MUTATION, and it is the discriminating one. Clear the prerequisite and the
 * card MOVES to his actionable list. Without this the split could be produced
 * by any static rule that happens to sort these five cards correctly.
 */
test('#485 MUTATION: resolving the prerequisite promotes the card to actionable', async () => {
  const unblocked = JSON.parse(JSON.stringify(board));
  // The blocking card is finished, so nothing stands in front of #20 any more.
  unblocked.cards.find((c) => c.id === 'blocker').column = 'done';

  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.getElementById('blocked-toggle').click());
    await page.waitForSelector('#blocked-panel.visible .blocked-group', { timeout: 5000 });
    const g = await groups(page);
    const ready = g.find((x) => /waiting on/i.test(x.head) && !/prerequisite/i.test(x.head));
    assert.deepEqual(ready.refs, ['#10', '#20'],
      'with its card-blocker done, #20 is now genuinely his — a split that cannot move is a '
      + `static label, not a computation: ${JSON.stringify(g)}`);
  }, { server: { board: unblocked }, launch: { headless: 'new' } });
});
