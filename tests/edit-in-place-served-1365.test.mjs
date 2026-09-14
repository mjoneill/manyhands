/**
 * #1365 — the big card view can write. The card's own TEST (browser):
 *
 *   Open a card big → edit description → save → the column card and the wiki
 *   page show the new text; a concurrent PATCH from the API between open and
 *   save yields the conflict message WITH A DIFF and keeps the user's text on
 *   screen — never a silent overwrite. Esc with unsaved changes asks; it does
 *   not discard. Negative control: shortId and createdAt stay read-only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBoardFixture, withBrowserServer } from './helpers/harness.mjs';

const ts = '2026-09-14T00:00:00.000Z';
const card = (shortId, title, description = '') => ({
  id: `c${shortId}`, shortId, title, description, type: 'task', column: 'backlog', order: shortId,
  assignees: ['unassigned'], labels: [], priority: null, createdAt: ts, updatedAt: ts, version: 1,
});

async function setValue(page, selector, text) {
  await page.waitForSelector(selector, { timeout: 5000 });
  await page.evaluate((sel, t) => {
    const el = document.querySelector(sel);
    el.value = t;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, selector, text);
}
const openBig = async (page, base, n) => {
  await page.goto(`${base}/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.board-header', { timeout: 5000 });
  await page.evaluate((k) => { const t = document.querySelector(`.card[data-id="c${k}"]`); t.click(); }, n);   // the tile opens the pop-out (#510)
  await page.waitForSelector('#card-detail-backdrop:not([hidden]) #card-detail', { timeout: 5000 });
};

test('#1365 served: edit in the pop-out → column card and wiki page show it; a concurrent PATCH → conflict + diff, text kept; Esc asks; read-only fields stay read-only', async () => {
  const board = makeBoardFixture({ cards: [card(1, 'first card', 'v1 line\nshared line')], nextShortId: 2 });
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    page.on('dialog', async (d) => { await d.dismiss(); });   // any stray browser dialog: answer "stay"

    // ── happy path ──
    await openBig(page, server.baseUrl, 1);
    assert.ok(await page.$('#card-detail [data-action="edit-card-detail"]'), 'the pop-out has an Edit control');
    await page.click('#card-detail [data-action="edit-card-detail"]');
    await page.waitForSelector('#card-detail .edit-desc', { timeout: 5000 });
    // negative control: identity fields are displayed, not editable
    assert.ok(await page.$('#card-detail .shortid-display'), 'shortId is a display, not an input');
    assert.equal(await page.$('#card-detail input.edit-shortid, #card-detail input.edit-created'), null, 'no input for shortId/createdAt');
    assert.ok(await page.$('#card-detail .mh-editor .edit-desc'), 'the SAME editor component (#1367) wraps the description here');
    assert.equal(await page.$eval('#card-detail .edit-desc', (e) => e.value), 'v1 line\nshared line');

    await setValue(page, '#card-detail .edit-desc', 'v2 by me\nshared line');
    await setValue(page, '#card-detail .edit-title', 'first card, renamed');
    await page.click('#card-detail [data-action="save-edit"]');
    // back to the read view with the new text
    await page.waitForFunction(() => document.querySelector('#card-detail .card-detail-body')?.textContent.includes('v2 by me'), { timeout: 5000 });
    assert.equal(await page.$eval('#card-detail .card-detail-title', (e) => e.textContent), 'first card, renamed');
    // the column card shows it
    const col = await page.$eval('.card[data-id="c1"] .card-description', (e) => e.textContent);
    assert.ok(col.includes('v2 by me'), 'column card shows the new text: ' + col);
    // the wiki page shows it (it reads the server, so the save must have LANDED)
    await page.waitForFunction(async () => (await (await fetch('/api/cards/1')).json()).description === 'v2 by me\nshared line', { timeout: 5000 });
    const p2 = await browser.newPage();
    await p2.goto(`${server.baseUrl}/wiki.html?node=c1`, { waitUntil: 'networkidle0' });
    await p2.waitForFunction(() => document.body.textContent.includes('v2 by me'), { timeout: 5000 });
    await p2.close();

    // ── conflict path ──
    await openBig(page, server.baseUrl, 1);
    await page.click('#card-detail [data-action="edit-card-detail"]');
    await page.waitForSelector('#card-detail .edit-desc', { timeout: 5000 });
    await setValue(page, '#card-detail .edit-desc', 'v3 by me\nshared line');
    // someone else saves in between
    const r = await fetch(`${server.baseUrl}/api/cards/1`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ by: 'alex', description: 'v3 by them\nshared line' }) });
    assert.equal(r.status, 200);
    await page.click('#card-detail [data-action="save-edit"]');
    await page.waitForSelector('#card-detail .edit-conflict:not([hidden])', { timeout: 8000 });
    const conflict = await page.$eval('#card-detail .edit-conflict', (e) => e.textContent);
    assert.match(conflict, /changed this while you were editing/i, conflict);
    assert.equal(await page.$eval('#card-detail .edit-desc', (e) => e.value), 'v3 by me\nshared line', 'the user\'s text is still on screen');
    const diff = await page.$$eval('#card-detail .edit-conflict .diff-line', (els) => els.map((e) => e.className.replace('diff-line ', '') + ':' + e.textContent.trim()));
    assert.ok(diff.some((l) => l.startsWith('add:') && l.includes('v3 by them')), 'the diff shows THEIR line as added: ' + JSON.stringify(diff));
    assert.ok(diff.some((l) => l.startsWith('del:') && l.includes('v3 by me')), 'and mine as what it would replace');
    assert.ok(diff.some((l) => l.startsWith('same:') && l.includes('shared line')), 'and the untouched line as same');
    // not overwritten silently: the server still has theirs
    assert.equal((await (await fetch(`${server.baseUrl}/api/cards/1`)).json()).description, 'v3 by them\nshared line');

    // ── Esc with unsaved changes asks, and does NOT discard on "no" ──
    // The ask is window.confirm in the product; here it is driven through the
    // injectable seam (window._detailAsk) because a confirm() raised from a
    // CDP-dispatched keydown does not surface as a puppeteer dialog — and the
    // fail-safe in _detailAsk keeps the editor open in that case anyway.
    await page.evaluate(() => { window.__asks = []; window._detailAsk = (m) => { window.__asks.push(m); return false; }; });
    await page.keyboard.press('Escape');
    await new Promise((res) => setTimeout(res, 300));
    const asks = await page.evaluate(() => window.__asks);
    assert.equal(asks.length, 1, 'Esc asked');
    assert.match(asks[0], /#1/, 'and named the card');
    assert.ok(await page.$('#card-detail-backdrop:not([hidden]) #card-detail .edit-desc'), 'declined ⇒ the editor stays');
    assert.equal(await page.$eval('#card-detail .edit-desc', (e) => e.value), 'v3 by me\nshared line');

    // an explicit, informed overwrite is allowed — after the diff was seen
    await page.click('#card-detail [data-action="save-edit-anyway"]');
    await page.waitForFunction(async () => (await (await fetch('/api/cards/1')).json()).description === 'v3 by me\nshared line', { timeout: 8000 });
    await page.waitForFunction(() => document.querySelector('#card-detail .card-detail-body')?.textContent.includes('v3 by me'), { timeout: 5000 });
  }, { server: { board } });
});
