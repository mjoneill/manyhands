/**
 * #758 — open any card reference without leaving Commons. The card's "done":
 *
 *   a #NNN in chat, or a raised-hand entry, opens the SAME actionable popup:
 *     · the ASK, stated (comments rendered; the label path says its empty case)
 *     · ADD A COMMENT
 *     · edit / links out remain
 *     · closing it restores the exact chat scroll position
 *   and on the board, the pop-out renders the card's thread (Finding C).
 *
 * Demonstration = open a referenced card mid-conversation, comment, close,
 * find your place unchanged. Success metric: the click is cheap.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBoardFixture, withBrowserServer } from './helpers/harness.mjs';

const ts = '2026-09-14T00:00:00.000Z';
const card = (shortId, title, extra = {}) => ({
  id: `c${shortId}`, shortId, title, description: '', type: 'task', column: 'backlog', order: shortId,
  assignees: ['unassigned'], labels: [], priority: null, createdAt: ts, updatedAt: ts, version: 1, ...extra,
});
const msg = (id, body, attachedTo = null, i = 0) => ({ id, body, author: 'alex', attachedTo, createdAt: `2026-09-14T00:00:${String(i).padStart(2, '0')}.000Z`, attachments: [] });

test('#758 served: a #NNN in the commons opens the card in place — ask shown, comment added, place kept; the label path says its empty case; a done card is not a raise', async () => {
  const filler = Array.from({ length: 60 }, (_, i) => msg(`f${i}`, `filler line ${i}`, null, i + 1));
  const board = makeBoardFixture({
    cards: [
      card(1, 'the referenced card', { description: 'body of #1, see also #2' }),
      card(2, 'labelled blocked, backlog', { labels: ['blocked'] }),
      card(3, 'labelled blocked, but done', { labels: ['blocked'], column: 'done' }),
    ],
    conversations: [
      msg('ask1', '🚧 what is the read path here?', 'c1', 0),   // the ASK, on the card
      ...filler,
      msg('ref', 'talking about #1 in the room', null, 90),
    ],
    nextShortId: 4,
  });
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 600 });
    page.on('dialog', async (d) => { await d.dismiss(); });
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.cv-msg-body a[data-shortid="1"]', { timeout: 5000 });

    // ── the raised-hands panel: label path is the empty case; done card absent ──
    const raises = await page.$$eval('.blocked-ask', (els) => els.map((e) => e.textContent));
    assert.ok(raises.some((t) => t === '(no detail given)'), 'the label path admits its gap: ' + JSON.stringify(raises));
    assert.ok(!raises.some((t) => /Labelled as/.test(t)), 'no tautology');
    const refs = await page.$$eval('.blocked-ref', (els) => els.map((e) => e.textContent));
    assert.ok(refs.includes('#2'), 'the backlog card with the label is a raise');
    assert.ok(!refs.includes('#3'), 'a DONE card with the label is not waiting on anyone');

    // ── scroll somewhere specific, then click the #1 in chat ──
    // the reader is looking at the message with the link (as a human would be); that is the place to keep
    await page.evaluate(() => { document.querySelector('.cv-msg[data-id="ref"]').scrollIntoView({ block: 'center' }); });
    const before = await page.evaluate(() => ({ y: window.scrollY, feed: document.querySelector('.cv-feed')?.scrollTop ?? null }));
    assert.ok(before.feed > 0, 'the feed is scrolled somewhere specific (' + before.feed + ')');
    await page.click('.cv-msg[data-id="ref"] .cv-msg-body a[data-shortid="1"]');
    await page.waitForSelector('#card-sheet', { timeout: 5000 });
    assert.match(page.url(), /commons\.html/, 'still on the commons page — no navigation');
    assert.equal(await page.$eval('#card-sheet-title', (e) => e.textContent), 'the referenced card');

    // the ASK is stated: the card's thread renders, with the 🚧 comment
    await page.waitForSelector('#card-sheet .card-sheet-thread .cv-msg[data-id="ask1"]', { timeout: 5000 });
    // a #NNN inside the sheet opens THAT card in the sheet (no navigation)
    assert.ok(await page.$('#card-sheet .card-sheet-body a.cardref[data-shortid="2"]'), 'description refs are links');
    // links out remain, and edit is a NEW TAB (context kept)
    assert.equal(await page.$eval('#card-sheet .card-sheet-link.edit', (a) => a.target), '_blank');
    assert.match(await page.$eval('#card-sheet .card-sheet-link.edit', (a) => a.getAttribute('href')), /index\.html\?card=1$/);

    // ── ADD A COMMENT from the sheet ──
    await page.evaluate(() => { const ta = document.querySelector('#card-sheet .cv-input'); ta.value = 'answered from the sheet'; ta.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click('#card-sheet .cv-send');
    await page.waitForFunction(() => document.querySelector('#card-sheet .cv-input')?.value === '', { timeout: 5000 });
    const thread = await (await fetch(`${server.baseUrl}/api/conversations?attachedTo=c1`)).json();
    const list = Array.isArray(thread) ? thread : thread.conversations;
    assert.ok(list.some((m) => m.body === 'answered from the sheet' && m.attachedTo === 'c1'), 'the comment is on the card');

    // ── close: Esc; the place is RESTORED ──
    // Sabotage 2026-09-15 (#1371 ledger): with restoreScroll removed this test
    // stayed green, because nothing had MOVED the feed while the sheet was open
    // — "unchanged" and "restored" were byte-identical. So move it: the reader
    // (or the thread's own render) scrolls under the overlay, and close must
    // still put the feed back where it was.
    await page.evaluate(() => { const f = document.querySelector('.cv-feed'); if (f) f.scrollTop = 0; window.scrollTo(0, 0); });
    const moved = await page.evaluate(() => document.querySelector('.cv-feed')?.scrollTop ?? null);
    assert.notEqual(moved, before.feed, 'the feed really moved under the overlay (' + moved + ' vs ' + before.feed + ')');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#card-sheet'), { timeout: 5000 });
    const after = await page.evaluate(() => ({ y: window.scrollY, feed: document.querySelector('.cv-feed')?.scrollTop ?? null }));
    assert.deepEqual(after, before, 'closing restores the exact scroll position');
    assert.equal(await page.evaluate(() => document.body.classList.contains('card-sheet-open')), false);

    // ── the raised-hands entry opens the same sheet ──
    await page.evaluate(() => document.querySelector('.blocked-open-card[data-open-card="2"]').click());
    await page.waitForSelector('#card-sheet[data-short-id="2"]', { timeout: 5000 });
    assert.match(page.url(), /commons\.html/, 'still on the commons page');
    await page.click('#card-sheet .card-sheet-close');
    await page.waitForFunction(() => !document.querySelector('#card-sheet'), { timeout: 5000 });
  }, { server: { board } });
});

test('#758 served: the board pop-out renders the card\'s thread and takes a comment (Finding C closed)', async () => {
  const board = makeBoardFixture({
    cards: [card(1, 'a card with a thread')],
    conversations: [msg('ask1', '🚧 the ask, on the card', 'c1', 0)],
    nextShortId: 2,
  });
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    page.on('dialog', async (d) => { await d.dismiss(); });
    await page.goto(`${server.baseUrl}/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.board-header', { timeout: 5000 });
    await page.evaluate(() => document.querySelector('.card[data-id="c1"]').click());
    await page.waitForSelector('#card-detail .card-detail-thread .cv-msg[data-id="ask1"]', { timeout: 5000 });
    assert.ok(await page.$('#card-detail .card-detail-thread .cv-input'), 'somewhere to add a comment TO');
    await page.evaluate(() => { const ta = document.querySelector('#card-detail .cv-input'); ta.value = 'from the pop-out'; ta.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click('#card-detail .cv-send');
    await page.waitForFunction(() => document.querySelector('#card-detail .cv-input')?.value === '', { timeout: 5000 });
    const thread = await (await fetch(`${server.baseUrl}/api/conversations?attachedTo=c1`)).json();
    assert.ok((Array.isArray(thread) ? thread : thread.conversations).some((m) => m.body === 'from the pop-out'));
    // the stale label-click affordance is gone
    const cursor = await page.evaluate(() => { const t = document.querySelector('.label-tag'); return t ? getComputedStyle(t).cursor : 'none-rendered'; });
    assert.notEqual(cursor, 'pointer', 'a label chip no longer promises a click');
  }, { server: { board } });
});
