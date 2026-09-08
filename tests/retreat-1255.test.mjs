/**
 * #1255 — THE RETREAT ROOM, end to end.
 *
 * The card is a brief for a calm one-to-one writing surface, and its acceptance
 * is written from the reasons the commons is the wrong place for long writing:
 *
 *   the room moves too fast to follow · composing long text in it is hard ·
 *   the writing area is too short · it takes too much scrolling ·
 *   AND IT IS FRAGILE — a misclick navigates away and the draft is gone
 *
 * ⭐ The last one is what raised this card to p1, and it is the one these tests
 * are mostly about. A pretty page that loses a paragraph has failed the card.
 *
 * ── ⛔ WHAT IS DELIBERATELY ABSENT, and is asserted below ──────────────────
 * IT IS EXPECTED TO BE USED SELDOM, and SELDOM IS A REQUIREMENT. A room
 * that must be attended to stay useful has become another surface to maintain,
 * so there are no unread badges, no activity counts and no polling refresh —
 * and a test says so, because every one of those is easy to add later without
 * anyone remembering it was a decision.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withBrowserServer, PROJECT_DIR } from './helpers/harness.mjs';

const ts = (n) => `2026-09-0${n}T00:00:00.000Z`;
const card = (id, shortId, title, extra = {}) => ({
  id, shortId, title, description: '', type: 'task', assignees: ['unassigned'],
  labels: [], for: '', priority: null, column: 'backlog', order: 0,
  createdAt: ts(1), updatedAt: ts(1), relationships: { relatedTo: [], blockedBy: [] }, ...extra,
});

const board = {
  cards: [
    card('r1', 1, 'A room with a door you close', { labels: ['retreat'], description: 'the opening words' }),
    card('r2', 2, 'Another retreat', { labels: ['retreat'] }),
    card('n1', 3, 'An ordinary card', { labels: ['manyhands'] }),
  ],
  columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
  conversations: [
    { id: 'm1', body: 'said slowly, in the room', author: 'sage', attachedTo: 'r1', createdAt: ts(2), mentions: [] },
    { id: 'm2', body: 'not in any retreat', author: 'alex', attachedTo: null, createdAt: ts(3), mentions: [] },
  ],
  nextShortId: 4,
};

const opts = { server: { board } };

// ── the room opens ─────────────────────────────────────────────────────────

test('#1255 the retreat lists ONLY retreat-labelled cards, and opens one', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/retreat.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.rooms a', { timeout: 5000 });
    const titles = await page.$$eval('.rooms a', (els) => els.map((e) => e.textContent));
    assert.deepEqual(titles.sort(), ['A room with a door you close', 'Another retreat']);
    // ⛔ NEGATIVE CONTROL: without this, "list every card" passes the assertion above.
    assert.ok(!titles.includes('An ordinary card'), 'an unlabelled card is not a room');

    await page.goto(`${server.baseUrl}/retreat.html?t=r1`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.turn-body', { timeout: 5000 });
    const bodies = await page.$$eval('.turn-body', (els) => els.map((e) => e.textContent));
    assert.ok(bodies.some((b) => b.includes('the opening words')), 'the card body is the first turn');
    assert.ok(bodies.some((b) => b.includes('said slowly, in the room')), 'the attached comment is a turn');
    assert.ok(!bodies.some((b) => b.includes('not in any retreat')), 'a floating commons post is NOT in this room');
  }, opts);
});

// ── ⭐ THE DRAFT, which is the card's actual defect ────────────────────────

test('#1255 ⭐⭐ A DRAFT SURVIVES LEAVING THE PAGE — the loss that raised this to p1', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/retreat.html?t=r1`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#say', { timeout: 5000 });

    const LONG = 'a paragraph that took a while to write, and then a misclick';
    await page.type('#say', LONG);

    // The misclick: away, and back.
    await page.goto(`${server.baseUrl}/retreat.html`, { waitUntil: 'networkidle0' });
    await page.goto(`${server.baseUrl}/retreat.html?t=r1`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#say', { timeout: 5000 });
    const restored = await page.$eval('#say', (e) => e.value);
    assert.equal(restored, LONG, 'the draft came back');
  }, opts);
});

test('#1255 ⭐⭐⭐ THE DRAFT OUTLIVES THE SEND UNTIL THE SEND IS CONFIRMED', async () => {
  // This is what makes Enter-to-post safe on a surface built for long writing.
  // A stray Return posts early; the words must still be there to finish. A
  // composer that cleared optimistically would reproduce the exact loss this
  // card exists to fix, in a new place — and it would pass every other test here.
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/retreat.html?t=r1`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#say', { timeout: 5000 });

    // Make the write fail, the way a dropped connection would.
    await page.evaluate(() => {
      const real = window.fetch;
      window.fetch = (url, opts) => (opts && opts.method === 'POST' && String(url).includes('/api/conversations'))
        ? Promise.resolve(new Response(JSON.stringify({ error: 'nope' }), { status: 500, headers: { 'Content-Type': 'application/json' } }))
        : real(url, opts);
    });

    const WORDS = 'words that must not be thrown away';
    await page.type('#say', WORDS);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /not saved/.test(document.querySelector('.composer-state')?.textContent || ''), { timeout: 5000 });

    const still = await page.$eval('#say', (e) => e.value);
    assert.equal(still, WORDS, 'a failed post does not eat the words');
    const stored = await page.evaluate(() => localStorage.getItem('manyhands.retreat.draft.r1'));
    assert.equal(stored, WORDS, 'and the saved draft is still on disk');
  }, opts);
});

test('#1255 enter posts, shift+enter makes a newline', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/retreat.html?t=r1`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#say', { timeout: 5000 });

    // ⛔ CONTROL FIRST: shift+enter must NOT post. Without this, a composer that
    // posts on every Enter regardless of the modifier passes the half below.
    await page.type('#say', 'line one');
    await page.keyboard.down('Shift');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Shift');
    await page.type('#say', 'line two');
    const twoLines = await page.$eval('#say', (e) => e.value);
    assert.equal(twoLines, 'line one\nline two', 'shift+enter inserted a newline and did not post');

    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => [...document.querySelectorAll('.turn-body')].some((e) => e.textContent.includes('line two')),
      { timeout: 8000 },
    );
    const cleared = await page.$eval('#say', (e) => e.value);
    assert.equal(cleared, '', 'a CONFIRMED post clears the composer');
    const gone = await page.evaluate(() => localStorage.getItem('manyhands.retreat.draft.r1'));
    assert.ok(!gone, 'and clears the saved draft — but only now');
  }, opts);
});

// ── ⛔ what the room refuses to become ─────────────────────────────────────

test('#1255 ⛔ NO BADGES, NO COUNTS, NO POLLING — "seldom" is a requirement', async () => {
  // Every one of these is easy to add and would quietly convert a retreat into
  // another surface that asks to be visited. Asserted so that adding one is a
  // decision someone has to argue for, rather than a Tuesday afternoon.
  //
  // ⛔ AND THE GREP MUST NOT READ THE COMMENTS. The first version of this test
  // failed on retreat.html's own sentence explaining that there are no
  // notification dots — i.e. the rule forbidding the word erased the reason the
  // word was written down. Comments are stripped before the scan, so the file
  // can keep saying WHY while the code is what gets checked.
  const raw = fs.readFileSync(path.join(PROJECT_DIR, 'retreat.html'), 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // A control on the stripper: it must not have eaten the file.
  assert.ok(code.includes('function composer'), 'the comment stripper left the code intact');
  assert.ok(!/setInterval|setTimeout\([^)]*\d{4,}/.test(code), 'no polling refresh');
  assert.ok(!/unread/i.test(code), 'no unread state');
  assert.ok(!/new Notification|badge/i.test(code), 'no notifications or badges');
});

test('#1255 ⚠️ the nav is ABSENT ON PURPOSE, and there is still a door', async () => {
  // #303-2 mounts ONE cross-surface nav on every surface so the links cannot
  // drift apart, and this page deliberately breaks that — removing everything
  // that is not the conversation is the requirement, and a five-item navbar is
  // the distraction. Recorded as an assertion rather than left as an omission,
  // because an unasserted exception is indistinguishable from an oversight and
  // the next person to run the parity suite will otherwise "fix" it.
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/retreat.html?t=r1`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#say', { timeout: 5000 });
    assert.equal(await page.$$eval('.topnav', (e) => e.length), 0, 'no cross-surface nav here');
    // ⭐ But a room with a door you close still has to have a door.
    const out = await page.$eval('.leave', (e) => ({ href: e.getAttribute('href'), text: e.textContent }));
    assert.equal(out.href, '/', 'there is exactly one way out and it goes to the board');
    assert.match(out.text, /leave/i);
  }, opts);
});
