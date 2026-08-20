/**
 * #485 disposition 2 — the raised-hands panel reads `blockers`, not only 🚧 posts.
 *
 * ⇒ THE MEASURED COST, 2026-08-20T21:54Z. @michael, unprompted, in the commons:
 * *"right now my assumption is nothing is waiting on me (and I'm super OK with
 * that)."* At that moment ELEVEN cards carried an open `scrum:Blocker` naming
 * him, and his panel read `🚧 Raised hands · 1`.
 *
 * ⛔ The panel was not lying. It consults exactly three things — a card-attached
 * post starting 🚧, a ✅ that supersedes it, and the static `blocked` label —
 * and the room stopped writing to that registry a month ago. Every directed ask
 * now goes into #881's `blockers` field, because that is what the MCP tooling
 * and `board_ready` use. Two mechanisms for one human question, neither aware
 * of the other.
 *
 * ── WHY THIS IS NOW BUILDABLE, WHEN #485 SAT AT p2 FOR A MONTH ──────────────
 * #485 deferred this disposition for one stated reason:
 *
 *   "currently raises aren't addressed to anyone, so the filter needs a
 *    definition of 'for you' (proposal: card assignee ∈ panel-owner, or
 *    @mention in the raise text)"
 *
 * ⭐ #881 shipped that definition on 2026-08-19: `scrum:blockedByPerson`. Both
 * proposed guesses were proxies for a fact the board could not state and now
 * states directly, so neither is needed — the card's prerequisite was met and
 * nobody went back to the card.
 *
 * ── DELIBERATELY NOT PERSONALISED ───────────────────────────────────────────
 * #485's standing rule: on a board with no authentication there is no "you" to
 * compute, and the panel must "fail honest, not fail personalized." So this
 * shows every open person-blocker and NAMES who each one waits on. It does not
 * filter to a viewer, and it does not manufacture one.
 *
 * ⚠️ Scope: read-only. No clear/resolve control for person-blockers, because
 * `blockers` is a whole-array replace (#466) — a per-entry clear would race and
 * silently delete a sibling. That is #466's fix, not this slice's.
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

/**
 * ⭐ THE FIXTURE IS THE INSTRUMENT. Three of these five cards MUST NOT appear;
 * a panel that shows all five, or that shows none, fails — so the assertion
 * cannot pass by accident in either direction.
 */
const blockerBoard = {
  cards: [
    // 1. SHOWS — an open person-blocker. The whole point.
    card('a', 11, 'Cutover decision', {
      blockers: [{ person: 'michael', status: 'open', note: 'point launchd at the export' }],
    }),
    // 2. SHOWS — a second, naming someone else. The panel is board-wide and
    //    must name WHO, not silently assume one person.
    card('b', 12, 'Vocabulary call', {
      blockers: [{ person: 'ada', status: 'open', note: 'pick the predicate' }],
    }),
    // 3. ⛔ CONTROL — cleared. #881 built `status` so the queue CONVERGES.
    //    A panel ignoring status accumulates forever and looks busy.
    card('c', 13, 'Already answered', {
      blockers: [{ person: 'michael', status: 'cleared', note: 'answered yesterday' }],
    }),
    // 4. ⛔ CONTROL — a CARD-blocker, not a person-blocker. Nobody is being
    //    waited on; this is work waiting on work. Showing it would turn the
    //    panel into a dependency list.
    card('d', 14, 'Waits on another card', {
      blockers: [{ card: 11, owner: 'ada', status: 'open', note: 'ada is chasing #11' }],
    }),
    // 5. ⛔ CONTROL — no blockers at all.
    card('e', 15, 'Nothing waiting'),
  ],
  columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
  conversations: [],
  nextShortId: 16,
};

test('#485 the raised-hands panel counts OPEN PERSON-BLOCKERS, not just 🚧 posts', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });

    // Two open person-blockers; the cleared one, the card-blocker and the bare
    // card are all excluded. There are ZERO 🚧 posts on this board, so a count
    // of 2 cannot have come from the legacy mechanism.
    await page.waitForFunction(
      () => / · 2$/.test(document.getElementById('blocked-toggle').textContent),
      { timeout: 5000 },
    );

    await page.evaluate(() => document.getElementById('blocked-toggle').click());
    await page.waitForSelector('#blocked-panel.visible .blocked-item', { timeout: 3000 });

    const items = await page.$$eval('.blocked-item', (els) => els.map((e) => ({
      who: e.querySelector('.blocked-who')?.textContent || '',
      ask: e.querySelector('.blocked-ask')?.textContent || '',
      ref: e.querySelector('.blocked-ref')?.textContent || '',
    })));
    assert.equal(items.length, 2, `expected exactly 2 items, got ${JSON.stringify(items)}`);

    const refs = items.map((i) => i.ref).sort();
    assert.deepEqual(refs, ['#11', '#12'],
      'the cleared blocker, the card-blocker and the unblocked card must all be absent');

    // ⭐ It must say WHO is waited on. A panel that shows the ask without the
    // person is the "blocked on you where you is nobody" defect this card was
    // filed for, one level down.
    const joined = JSON.stringify(items);
    assert.match(joined, /michael/i, 'names the person the ask waits on');
    assert.match(joined, /ada/i, 'names the OTHER person too — the panel is board-wide, not one-person');
    assert.match(joined, /point launchd at the export/, 'shows the ask itself, from the blocker note');
  }, { server: { board: blockerBoard }, launch: { headless: 'new' } });
});

/**
 * ⛔⛔ THE DISCRIMINATING CONTROL, and it is the one that matters most.
 *
 * An empty panel is about to become a load-bearing statement: @michael has said
 * he reads it as "nothing is waiting on me." A panel wired to a typo'd field
 * returns nothing and renders a confident, identical empty state.
 *
 * ⇒ So: a board with a directed blocker and NO 🚧 post must NOT be empty. That
 * is the assertion that fails if the wiring rots, and it is exactly @minimo's
 * point 4 — "when it says nothing is waiting on Michael, the structured query
 * must actually be empty" — turned into something that can fail.
 */
test('#485 an EMPTY panel means empty — a directed blocker with no 🚧 post must not read as silence', async () => {
  const oneBlocker = {
    cards: [card('a', 21, 'Needs a human', {
      blockers: [{ person: 'michael', status: 'open', note: 'one bounded decision' }],
    })],
    columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
    conversations: [],
    nextShortId: 22,
  };
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => / · 1$/.test(document.getElementById('blocked-toggle').textContent),
      { timeout: 5000 },
    );
    await page.evaluate(() => document.getElementById('blocked-toggle').click());
    await page.waitForSelector('#blocked-panel.visible', { timeout: 3000 });

    const empty = await page.$('.blocked-empty');
    assert.equal(empty, null,
      'the panel rendered "no open asks" while a directed blocker was live — this is the silence that reads as safety');
  }, { server: { board: oneBlocker }, launch: { headless: 'new' } });
});

/**
 * ⭐ And the legacy mechanism must survive. #485's own history is a rename that
 * broke nothing; this slice adds a source and must not remove one.
 */
test('#485 legacy 🚧 raises still count alongside person-blockers', async () => {
  const mixed = {
    cards: [
      card('a', 31, 'Directed', { blockers: [{ person: 'michael', status: 'open', note: 'decide' }] }),
      card('b', 32, 'Raised the old way'),
    ],
    columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
    conversations: [
      { id: 'r1', body: '🚧 need the budget number', author: 'ada', attachedTo: 'b', createdAt: ts(2), mentions: [] },
    ],
    nextShortId: 33,
  };
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => / · 2$/.test(document.getElementById('blocked-toggle').textContent),
      { timeout: 5000 },
    );
    await page.evaluate(() => document.getElementById('blocked-toggle').click());
    await page.waitForSelector('#blocked-panel.visible .blocked-item', { timeout: 3000 });
    const refs = await page.$$eval('.blocked-item .blocked-ref', (els) => els.map((e) => e.textContent).sort());
    assert.deepEqual(refs, ['#31', '#32'], 'both mechanisms feed the same panel');
  }, { server: { board: mixed }, launch: { headless: 'new' } });
});
