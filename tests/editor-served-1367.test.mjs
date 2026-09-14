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

    await clickWhenOnTop(page, '.mh-editor:has(#card-desc) [data-editor-preview]');
    const refs = await page.$$eval('.mh-editor:has(#card-desc) .mh-editor-preview a[data-shortid]',
      (els) => els.map((a) => [a.dataset.shortid, a.title]));
    assert.deepEqual(refs, [['1', 'first card'], ['2', 'second card'], ['3', 'third card']],
      'preview renders the three refs with their titles');
    await clickWhenOnTop(page, '.mh-editor:has(#card-desc) [data-editor-write]');

    await clickWhenOnTop(page, '#btn-add-card');
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 4, { timeout: 5000 });

    // saved whole — read from the API, not the DOM
    const res = await fetch(`${server.baseUrl}/api/cards/4`);
    assert.equal(res.status, 200);
    const saved = await res.json();
    assert.equal(saved.description.length, text.length, 'saved length equals typed length');
    assert.equal(saved.description, text, 'saved byte-for-byte');

    // ── column edit form: mounted, reopens the same text without loss ──
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
