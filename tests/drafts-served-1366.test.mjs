/**
 * #1366 — the card's own TEST (browser), on the served pages:
 *
 *   Type in a card comment → click a #NNN link → come back → the text is
 *   there. Type → reload → there. Post → gone. Type on the commons page →
 *   leaving asks (the beforeunload handler is armed and returns a value).
 *   Sabotage: unmount the watch on one surface → its test fails, the others
 *   pass — so every surface is asserted BY NAME below.
 *
 * "Click a #NNN link" from a card thread on commons.html navigates to
 * index.html?card=N — a real unload, the exact misclick the card describes.
 * The in-app ask is answered "leave" here (puppeteer accepts the dialog), the
 * draft must survive the trip regardless.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBoardFixture, withBrowserServer } from './helpers/harness.mjs';

const ts = '2026-09-14T00:00:00.000Z';
const card = (shortId, title, description = '') => ({
  id: `c${shortId}`, shortId, title, description, type: 'task', column: 'backlog', order: shortId,
  assignees: ['unassigned'], labels: [], priority: null, createdAt: ts, updatedAt: ts,
});
const msg = (id, body, attachedTo) => ({ id, body, author: 'alex', attachedTo, createdAt: ts, attachments: [] });

async function typeInto(page, selector, text) {
  await page.waitForSelector(selector, { timeout: 5000 });
  await page.evaluate((sel, t) => {
    const ta = document.querySelector(sel);
    ta.value = t;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, selector, text);
}

test('#1366 served: a card-thread comment survives a #NNN misclick and a reload, and is released only by the post', async () => {
  const board = makeBoardFixture({
    cards: [card(1, 'first card'), card(2, 'second card')],
    conversations: [msg('m1', 'earlier, see #2', 'c1')],
    nextShortId: 3,
  });
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    // Every in-app ask is answered "leave": the draft must survive WITHOUT the guard's help.
    const dialogs = [];
    page.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept(); });

    // ── commons page, a card's thread ──
    await page.goto(`${server.baseUrl}/commons.html?node=c1`, { waitUntil: 'networkidle0' });
    await typeInto(page, '.cv-input', 'half a thought about #1');
    // the misclick: a #NNN ref in the thread → index.html?card=2 (a real navigation)
    await page.waitForSelector('.cv-msg-body a[data-shortid="2"]', { timeout: 5000 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle0' }),
      page.click('.cv-msg-body a[data-shortid="2"]'),
    ]);
    assert.ok(dialogs.length >= 1, 'leaving the thread with unsent text ASKED');
    assert.match(dialogs[0], /unsent comment/, 'and the ask named the surface: ' + dialogs[0]);
    assert.match(page.url(), /index\.html\?card=2/);

    // come back
    await page.goto(`${server.baseUrl}/commons.html?node=c1`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.cv-input', { timeout: 5000 });
    assert.equal(await page.$eval('.cv-input', (e) => e.value), 'half a thought about #1', 'SURFACE commons thread: draft restored after the misclick');

    // reload
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('.cv-input', { timeout: 5000 });
    assert.equal(await page.$eval('.cv-input', (e) => e.value), 'half a thought about #1', 'SURFACE commons thread: draft restored after a reload');

    // a DIFFERENT thread does not see it
    await page.goto(`${server.baseUrl}/commons.html?node=c2`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.cv-input', { timeout: 5000 });
    assert.equal(await page.$eval('.cv-input', (e) => e.value), '', 'a draft is per target');

    // post releases it
    await page.goto(`${server.baseUrl}/commons.html?node=c1`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.cv-input', { timeout: 5000 });
    await page.click('.cv-send');
    await page.waitForFunction(() => document.querySelector('.cv-input')?.value === '', { timeout: 5000 });
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('.cv-input', { timeout: 5000 });
    assert.equal(await page.$eval('.cv-input', (e) => e.value), '', 'posted ⇒ the draft is gone');
    const stored = await fetch(`${server.baseUrl}/api/conversations?attachedTo=c1`).then((r) => r.json());
    assert.ok((Array.isArray(stored) ? stored : stored.conversations || []).some((c) => c.body === 'half a thought about #1'), 'and the post landed');
  }, { server: { board } });
});

test('#1366 served: every other composer keeps its draft by name — board commons box, new-card description, edit description (base-checked), wiki editor, retreat', async () => {
  const board = makeBoardFixture({
    cards: [card(1, 'first card', 'v1 body'), { ...card(2, 'a retreat thread'), labels: ['retreat'] }],
    nextShortId: 3,
  });
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    page.on('dialog', async (d) => { await d.accept(); });

    // ── board: commons box + new-card description ──
    await page.goto(`${server.baseUrl}/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.board-header', { timeout: 5000 });
    await typeInto(page, '#convs-body', 'board commons draft');
    await page.click('.btn-expand-form');
    await page.waitForSelector('#add-card-form-wrapper.expanded', { timeout: 5000 });
    await page.evaluate(() => { document.getElementById('card-more').open = true; });
    await typeInto(page, '#card-desc', 'new card description draft');
    // ── board: edit description, prefilled with the server's text ──
    await page.evaluate(() => { document.querySelector('.card[data-id="c1"] [data-action="edit"]').click(); });
    await page.waitForSelector('.edit-desc', { timeout: 5000 });
    assert.equal(await page.$eval('.edit-desc', (e) => e.value), 'v1 body');
    await typeInto(page, '.edit-desc', 'v1 body — and my half-typed change');
    // the guard is ARMED while something is dirty: beforeunload is cancelled
    const armed = await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
    assert.equal(armed, true, 'beforeunload is guarded while a composer is dirty');

    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('.board-header', { timeout: 5000 });
    assert.equal(await page.$eval('#convs-body', (e) => e.value), 'board commons draft', 'SURFACE board commons box: restored');
    await page.click('.btn-expand-form');
    await page.waitForSelector('#add-card-form-wrapper.expanded', { timeout: 5000 });
    assert.equal(await page.$eval('#card-desc', (e) => e.value), 'new card description draft', 'SURFACE new-card description: restored');
    await page.evaluate(() => { document.querySelector('.card[data-id="c1"] [data-action="edit"]').click(); });
    await page.waitForSelector('.edit-desc', { timeout: 5000 });
    assert.equal(await page.$eval('.edit-desc', (e) => e.value), 'v1 body — and my half-typed change', 'SURFACE edit description: restored over the same base');

    // someone else edits the card meanwhile ⇒ the stale draft is DROPPED, never restored over v2
    const patched = await fetch(`${server.baseUrl}/api/cards/1`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ by: 'alex', description: 'v2 body by someone else' }) });
    assert.equal(patched.status, 200);
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('.board-header', { timeout: 5000 });
    await page.evaluate(() => { document.querySelector('.card[data-id="c1"] [data-action="edit"]').click(); });
    await page.waitForSelector('.edit-desc', { timeout: 5000 });
    assert.equal(await page.$eval('.edit-desc', (e) => e.value), 'v2 body by someone else', 'a draft written on v1 does not overwrite v2');

    // ── wiki editor ──
    await page.goto(`${server.baseUrl}/wiki.html?node=c1`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Edit')), { timeout: 5000 });
    await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Edit')).click(); });
    await typeInto(page, '.edit-body', 'v2 body by someone else\n\nwiki draft line');
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Edit')), { timeout: 5000 });
    await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Edit')).click(); });
    await page.waitForSelector('.edit-body', { timeout: 5000 });
    assert.equal(await page.$eval('.edit-body', (e) => e.value), 'v2 body by someone else\n\nwiki draft line', 'SURFACE wiki editor: restored');

    // ── retreat ──
    await page.goto(`${server.baseUrl}/retreat.html?t=c2`, { waitUntil: 'networkidle0' });
    await typeInto(page, '#say', 'retreat draft');
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('#say', { timeout: 5000 });
    assert.equal(await page.$eval('#say', (e) => e.value), 'retreat draft', 'SURFACE retreat: restored through the shared mechanism');
    assert.equal(await page.evaluate(() => localStorage.getItem('manyhands.retreat.draft.c2')), 'retreat draft', 'and on the SAME key the retreat used before #1366, so pre-existing drafts still restore');
  }, { server: { board } });
});
