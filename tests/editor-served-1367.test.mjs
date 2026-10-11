/**
 * #1367 — the editor on the served page, the card's own TEST (browser):
 *
 *   Create a card with a 20 KB description containing three #NNN references →
 *   saved whole → preview renders the links (with titles) → the same text
 *   opens in the edit form without loss.
 *
 * And the sabotage clause: "revert one surface to a bare textarea → its
 * preview test fails" — so EVERY wired surface is asserted by name here:
 * the create form, the column edit form, the board's inline commons composer,
 * and the commons page composer. Removing the mount from any one of them
 * fails exactly its assertion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBoardFixture, withBrowserServer } from './helpers/harness.mjs';
import { openPreview } from './helpers/preview-ready.mjs';   // #1445

const ts = '2026-09-14T00:00:00.000Z';

// The add-card form slides open over 0.3 s (grid-template-rows) with
// overflow hidden, so a click dispatched mid-slide lands on the board behind
// the clipped button — the same class as #1131's seven reds in commons-e2e.
// Click only once the button is the element under its own centre.
async function clickWhenOnTop(page, selector) {
  await page.waitForFunction((sel) => {
    const b = document.querySelector(sel);
    if (!b) return false;
    b.scrollIntoView({ block: 'nearest' });
    const r = b.getBoundingClientRect();
    return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b;
  }, { timeout: 5000 }, selector);
  await page.click(selector);
}
const card = (shortId, title) => ({
  id: `c${shortId}`, shortId, title, description: '', type: 'task', column: 'backlog', order: shortId,
  assignees: ['unassigned'], labels: [], priority: null, createdAt: ts, updatedAt: ts,
});

// 20 KB with three refs spread through it — the size #40 hit a wall at.
function bigDescription() {
  const para = 'A long description paragraph that goes on for a while. ';
  let s = 'Start #1 here.\n';
  while (s.length < 10_000) s += para;
  s += '\nMiddle #2 here.\n';
  while (s.length < 20_000 - 20) s += para;
  s += '\nEnd #3 here.';
  return s;
}

test('#1367 served: 20 KB + three refs create → saved whole → preview links titled → edit form reopens it whole', async () => {
  const board = makeBoardFixture({
    cards: [card(1, 'first card'), card(2, 'second card'), card(3, 'third card')],
    nextShortId: 4,
  });
  const text = bigDescription();
  assert.ok(text.length >= 20_000 - 20 && text.length < 20_100, `fixture is ~20 KB (${text.length})`);

  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    // #1674 — passive observers only (no waits, no assertions), so a miss names its state instead of failing as a bare timeout
    const pageErrors = []; page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e).slice(0, 300)));
    // the create's own fate, observed from outside the page: sent, answered (with its status) or failed. An absent API card can be an unfinished or failed save, not only a lost click
    const creates = [];
    const isCreate = (r) => r.method() === 'POST' && /\/api\/cards(\?|$)/.test(new URL(r.url()).pathname + new URL(r.url()).search);
    page.on('request', (r) => { if (isCreate(r)) creates.push({ state: 'pending', url: r.url(), status: null, failure: null, req: r }); });
    page.on('response', (res) => { const c = creates.find((x) => x.req === res.request()); if (c) { c.state = 'answered'; c.status = res.status(); } });
    page.on('requestfailed', (r) => { const c = creates.find((x) => x.req === r); if (c) { c.state = 'failed'; c.failure = (r.failure() || {}).errorText || 'failed'; } });
    await page.goto(`${server.baseUrl}/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.board-header', { timeout: 5000 });

    // ── create form: mounted, previews, submits whole ──
    await page.click('.btn-expand-form');
    await page.waitForSelector('#add-card-form-wrapper.expanded', { timeout: 5000 });
    await page.evaluate(() => { document.getElementById('card-more').open = true; });
    assert.ok(await page.$('#card-desc'), 'the create textarea still exists by id');
    assert.ok(await page.$('.mh-editor #card-desc'), 'SURFACE create form: #card-desc is wrapped by the editor');

    await page.type('#card-title', 'the long one');
    await page.evaluate((t) => {
      const ta = document.getElementById('card-desc');
      ta.value = t;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);

    // it grew: taller than the 120px the stylesheet used to cap it at
    const h = await page.$eval('#card-desc', (el) => el.getBoundingClientRect().height);
    assert.ok(h > 120, `create textarea grew past the old 120px cap (got ${h})`);

    // #1445 — the preview opens when the PAGE says so (the editor gets `previewing` and the preview is unhidden), never when a clock runs out. The first activation is the coordinate click
    // (clickWhenOnTop: the button must be the element under its own centre); if that produces no signal in 1.5 s a second, geometry-free `button.click()` is made, because the handler is
    // synchronous and a click that did not open the preview did not reach it (see helpers/preview-ready.mjs). "Preview never opens" still fails: at 30 s, with the attempts and the state.
    const opened = await openPreview(page, {
      buttonSelector: '.mh-editor:has(#card-desc) [data-editor-preview]',
      editorSelector: '.mh-editor:has(#card-desc)',
      clickFirst: () => clickWhenOnTop(page, '.mh-editor:has(#card-desc) [data-editor-preview]'),
    });
    if (opened.attempts > 1) console.log(`#1445 the first click did not open the preview; attempt ${opened.attempts} did (${opened.ms} ms)`);
    // the three-ref assertion is retained: once the preview is open the refs are rendered by the same synchronous call
    await page.waitForFunction(
      () => document.querySelectorAll('.mh-editor:has(#card-desc) .mh-editor-preview:not([hidden]) a[data-shortid]').length === 3,
      { timeout: 30_000, polling: 100 },
    );
    const refs = await page.$$eval('.mh-editor:has(#card-desc) .mh-editor-preview a[data-shortid]',
      (els) => els.map((a) => [a.dataset.shortid, a.title]));
    assert.deepEqual(refs, [['1', 'first card'], ['2', 'second card'], ['3', 'third card']],
      'preview renders the three refs with their titles');
    await clickWhenOnTop(page, '.mh-editor:has(#card-desc) [data-editor-write]');

    // #1674 — record, passively, which element the add click reaches and when the 4th card appears; the bound below is unchanged (5 s)
    await page.evaluate(() => {
      window.__1674 = { clicks: [], fourthAt: null, clickAt: null };
      document.addEventListener('click', (e) => { const t = e.target; window.__1674.clicks.push({ id: (t && t.id) || '', cls: String((t && t.className) || '').slice(0, 60) }); if (t && t.id === 'btn-add-card') window.__1674.clickAt = performance.now(); }, true);
      new MutationObserver(() => { if (window.__1674.fourthAt === null && document.querySelectorAll('.card').length >= 4) window.__1674.fourthAt = performance.now(); })
        .observe(document.body, { childList: true, subtree: true });
    });
    await clickWhenOnTop(page, '#btn-add-card');
    try {
      await page.waitForFunction(() => document.querySelectorAll('.card').length === 4, { timeout: 5000 });
    } catch (e) {
      // each read is bounded: a page whose main thread is blocked would otherwise hang the dump for puppeteer's protocol timeout, and "did not answer" is itself the specimen
      const bounded = (pr, what) => Promise.race([pr, new Promise((r) => setTimeout(() => r({ unreadable: `${what} did not answer in 3 s` }), 3000))]);
      const state = await bounded(page.evaluate(() => ({
        cardsInDom: document.querySelectorAll('.card').length,
        observed: window.__1674,
        formExpanded: !!document.querySelector('#add-card-form-wrapper.expanded'),
        titleValue: (document.getElementById('card-title') || {}).value,
      })), 'the page').catch((err) => ({ unreadable: String(err) }));
      // what the server holds next to what the DOM shows: this records what was observed at that moment. An absent card can be an unfinished or failed save; a present one with no DOM card is a mismatch at that moment, not its cause
      const api = await fetch(`${server.baseUrl}/api/cards`, { signal: AbortSignal.timeout(3000) }).then(async (r) => { const j = await r.json(); const list = Array.isArray(j) ? j : (j.cards || []); return { status: r.status, shortIds: list.map((c) => c.shortId) }; }).catch((err) => ({ unreadable: String(err) }));
      throw new Error(`#1674 the 4th card did not render within 5 s of the add click (bound unchanged): ${JSON.stringify({ ...state, api, creates: creates.map(({ req, ...c }) => c), pageErrors })} — original: ${e.message}`);
    }
    const seen = await page.evaluate(() => window.__1674);
    console.log(`#1674 add click → 4th card in ${seen.fourthAt !== null && seen.clickAt !== null ? Math.round(seen.fourthAt - seen.clickAt) : '?'} ms; clicks: ${JSON.stringify(seen.clicks.map((c) => c.id || c.cls))}; creates: ${JSON.stringify(creates.map((c) => `${c.state}${c.status ? ' ' + c.status : ''}`))}; page errors: ${pageErrors.length}`);

    // saved whole — read from the API, not the DOM
    const res = await fetch(`${server.baseUrl}/api/cards/4`);
    assert.equal(res.status, 200);
    const saved = await res.json();
    assert.equal(saved.description.length, text.length, 'saved length equals typed length');
    assert.equal(saved.description, text, 'saved byte-for-byte');

    // ── column edit form: mounted, reopens the same text without loss ──
    // #1583 — the tile is re-keyed to the server's id when the create's 201 is
    // adopted, which can land a beat after the server has stored it.
    await page.waitForSelector(`.card[data-id="${saved.id}"] [data-action="edit"]`, { timeout: 5000 });
    await page.evaluate((id) => {
      document.querySelector(`.card[data-id="${id}"] [data-action="edit"]`).click();
    }, saved.id);
    await page.waitForSelector('.edit-desc', { timeout: 5000 });
    assert.ok(await page.$('.mh-editor .edit-desc'), 'SURFACE edit form: .edit-desc is wrapped by the editor');
    const reopened = await page.$eval('.edit-desc', (el) => el.value);
    assert.equal(reopened, text, 'edit form holds the whole description');

    // ── board inline commons composer ──
    assert.ok(await page.$('.mh-editor #convs-body'), 'SURFACE board commons panel: #convs-body is wrapped by the editor');

    // ── commons page composer ──
    const p2 = await browser.newPage();
    await p2.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
    await p2.waitForSelector('.cv-input', { timeout: 5000 });
    assert.ok(await p2.$('.mh-editor .cv-input'), 'SURFACE commons page: .cv-input is wrapped by the editor');
    // and its preview goes through the chat renderer (bold → <strong>)
    await p2.evaluate(() => {
      const ta = document.querySelector('.cv-input');
      ta.value = 'a **bold** word and #2';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await clickWhenOnTop(p2, '.mh-editor:has(.cv-input) [data-editor-preview]');
    const strong = await p2.$eval('.mh-editor:has(.cv-input) .mh-editor-preview strong', (e) => e.textContent).catch(() => null);
    assert.equal(strong, 'bold', 'commons preview renders chat markdown');
  }, { server: { board } });
});
