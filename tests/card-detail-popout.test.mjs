/**
 * #510 — the card detail pop-out: ONE reading affordance at reading width.
 * RED-first, non-author bar (the reviewing seat), from the card's acceptance + the builder's
 * posted design (overlay above the board · `?card=NNN` address via pushState ·
 * `.prose` measure · four scriptable exits · deletes `.desc-toggle` same
 * commit). The design is the builder's; these teeth are the contract.
 *
 * Named cheats this bar refuses (builder handed them over herself):
 *   - an overlay that satisfies "moves no other card" by rendering off-screen
 *     or at zero size → visibility + area + in-viewport asserted
 *   - deleting .desc-toggle while leaving long descriptions unreadable → the
 *     FULL description text must be present inside the overlay, tail included
 *   - a modal in DOM clothing → every exit must be scriptable; the
 *     no-blocking-modals REASONING outranks its source-scan rule ("a modal is
 *     an outage for half the room")
 *
 * CONTRACT SELECTOR: [data-card-detail] = the overlay root (backdrop);
 * a close control inside it carries a data-action. Change the constants if
 * the build ships different names.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startRestServer, makeBoardFixture, PROJECT_DIR, withBrowserServer } from './helpers/harness.mjs';

const DETAIL = '[data-card-detail]';
const ts = '2026-05-01T00:00:00.000Z';

const TAIL = 'THE-FINAL-SENTENCE-SENTINEL proves the whole text is reachable.';
const LONG_DESC = 'Opening paragraph of a long description. '
  + 'Middle filler sentence repeated to force any collapse threshold. '.repeat(30)
  + TAIL;

function boardFixture() {
  return makeBoardFixture({
    cards: [{
      id: 'c1', shortId: 1, title: 'Long card', description: LONG_DESC,
      type: 'task', assignees: ['sage'], labels: [], for: '', priority: null,
      column: 'backlog', order: 0, createdAt: ts, updatedAt: ts,
      relationships: { relatedTo: [], blockedBy: [] },
    }, {
      id: 'c2', shortId: 2, title: 'Citing card', description: 'This card cites #1 in running prose.',
      type: 'task', assignees: ['sage'], labels: [], for: '', priority: null,
      column: 'planned', order: 0, createdAt: ts, updatedAt: ts,
      relationships: { relatedTo: [], blockedBy: [] },
    }],
    nextShortId: 3,
  });
}

async function detailState(page) {
  return page.evaluate((DETAIL_SEL) => {
    const el = document.querySelector(DETAIL_SEL);
    if (!el || el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return { open: false };
    const r = el.getBoundingClientRect();
    const visible = r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0
      && r.left < window.innerWidth && r.top < window.innerHeight
      && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
    return { open: visible, w: +r.width.toFixed(0), h: +r.height.toFixed(0), text: el.textContent };
  }, DETAIL);
}

test('#510 address: loading ?card=NNN opens a visible, non-empty overlay carrying the FULL description at reading width', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1442, height: 900 });
    await page.goto(`${server.baseUrl}/?card=1`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 300));

    const d = await detailState(page);
    assert.ok(d.open, `no visible ${DETAIL} overlay on ?card=1 — the address either scrolls (old behavior) or opens nothing`);
    assert.ok(d.w >= 320 && d.h >= 240,
      `overlay is ${d.w}×${d.h} — a zero/tiny box satisfies "moves no other card" and reads nothing`);
    assert.ok(d.text.includes(TAIL),
      'the description TAIL is missing from the overlay — the full text is not reachable through the one affordance');

    // Reading width: the overlay's prose respects the #496 measure band.
    const measure = await page.evaluate((DETAIL_SEL) => {
      const el = document.querySelector(`${DETAIL_SEL} .prose`) || document.querySelector(DETAIL_SEL);
      const cs = getComputedStyle(el);
      const probe = document.createElement('span');
      probe.textContent = '0'.repeat(80);
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;';
      el.appendChild(probe);
      const ch80 = probe.getBoundingClientRect().width;
      probe.remove();
      return { contentWidth: el.getBoundingClientRect().width, ch80 };
    }, DETAIL);
    assert.ok(measure.contentWidth <= measure.ch80,
      `overlay text runs ${measure.contentWidth.toFixed(0)}px, wider than 80ch (${measure.ch80.toFixed(0)}px) — the 300px-ribbon complaint answered with an unreadable slab`);
  }, { server: { board: boardFixture() }, launch: { headless: 'new' } });
});

test('#510 citation + board integrity: clicking a #NNN citation opens the overlay and moves no other card', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1442, height: 900 });
    await page.goto(server.baseUrl + '/', { waitUntil: 'networkidle0' });
    await page.waitForSelector('.card', { timeout: 5000 });

    const before = await page.$$eval('.card', (els) => els.map((e) => {
      const r = e.getBoundingClientRect();
      return `${e.dataset.id}@${r.left.toFixed(0)},${r.top.toFixed(0)}`;
    }));

    // The 543-citation behavior: a #NNN reference in prose opens the card.
    const clicked = await page.evaluate(() => {
      const link = document.querySelector('.card[data-id="c2"] a.shortid-link, .card[data-id="c2"] a[href*="card=1"], .card[data-id="c2"] a[href*="#1"]');
      if (!link) return false;
      link.click();
      return true;
    });
    assert.ok(clicked, 'no citation link rendered for #1 inside card c2 — citations have not become links');
    await new Promise((r) => setTimeout(r, 300));

    const d = await detailState(page);
    assert.ok(d.open, 'clicking the citation did not open the overlay (old scroll-to behavior survives)');

    const after = await page.$$eval('.card', (els) => els.map((e) => {
      const r = e.getBoundingClientRect();
      return `${e.dataset.id}@${r.left.toFixed(0)},${r.top.toFixed(0)}`;
    }));
    assert.deepEqual(after, before, 'opening the overlay moved cards behind it — acceptance #1 of the card');
  }, { server: { board: boardFixture() }, launch: { headless: 'new' } });
});

test('#510 exits: Escape, close control, backdrop, and browser Back all close it — every state scriptable', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1442, height: 900 });

    const openFresh = async () => {
      await page.goto(`${server.baseUrl}/?card=1`, { waitUntil: 'networkidle0' });
      await new Promise((r) => setTimeout(r, 250));
      const d = await detailState(page);
      assert.ok(d.open, 'overlay must open on ?card=1 before an exit can be tested');
    };
    const assertClosed = async (exitName) => {
      await new Promise((r) => setTimeout(r, 250));
      const d = await detailState(page);
      assert.ok(!d.open, `${exitName} did not close the overlay — a trapped state is an outage for half the room`);
    };

    await openFresh();
    await page.keyboard.press('Escape');
    await assertClosed('Escape');

    await openFresh();
    const hasClose = await page.evaluate((DETAIL_SEL) => {
      const btn = document.querySelector(`${DETAIL_SEL} [data-action]`);
      if (!btn) return false;
      btn.click();
      return true;
    }, DETAIL);
    assert.ok(hasClose, `no [data-action] close control inside ${DETAIL}`);
    await assertClosed('the close control');

    await openFresh();
    // Backdrop: the overlay root itself, clicked at its top-left corner,
    // outside any centered panel.
    await page.evaluate((DETAIL_SEL) => {
      const el = document.querySelector(DETAIL_SEL);
      const r = el.getBoundingClientRect();
      const ev = new MouseEvent('click', { bubbles: true, clientX: r.left + 4, clientY: r.top + 4 });
      document.elementFromPoint(r.left + 4, r.top + 4).dispatchEvent(ev);
    }, DETAIL);
    await assertClosed('the backdrop');

    // Back: open IN-PAGE via the citation so pushState ran, then go back.
    await page.goto(server.baseUrl + '/', { waitUntil: 'networkidle0' });
    await page.waitForSelector('.card', { timeout: 5000 });
    await page.evaluate(() => {
      document.querySelector('.card[data-id="c2"] a.shortid-link, .card[data-id="c2"] a[href*="card=1"], .card[data-id="c2"] a[href*="#1"]')?.click();
    });
    await new Promise((r) => setTimeout(r, 250));
    assert.ok((await detailState(page)).open, 'citation must open the overlay before Back can be tested');
    await page.goBack();
    await assertClosed('browser Back');
  }, { server: { board: boardFixture() }, launch: { headless: 'new' } });
});

// ---------------------------------------------------------------------------
// Pair tooth (#509+#510, pre-registered on both cards): the condemned control
// is DELETED from SHIPPED CODE, verified by command, not assumed.
// Command of record: rg 'desc-toggle' index.html core/ → 0
//
// NARROWED from the original all-files zero-count (builder's catch, ruling
// (a), 2026-07-27): a test that asserts a thing's ABSENCE has to name the
// thing, so the original scope forbade the only guards that would catch the
// ribbon coming back — passing it would have meant deleting the regression
// protection to prove the deletion. Same shape as the #496 max-width
// refinement: a mechanical zero-count satisfied by making the product worse
// gets narrowed, with the reason in place. Tests may name desc-toggle in
// absence assertions; shipped code may not carry it at all.
// ---------------------------------------------------------------------------
test('#510 pair tooth: rg desc-toggle returns zero in shipped code — gone, not renamed', () => {
  const offenders = [];
  const scan = (file) => {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (line.includes('desc-toggle')) offenders.push(`${path.relative(PROJECT_DIR, file)}:${i + 1}`);
    });
  };
  scan(path.join(PROJECT_DIR, 'index.html'));
  for (const f of fs.readdirSync(path.join(PROJECT_DIR, 'core'))) {
    const full = path.join(PROJECT_DIR, 'core', f);
    if (fs.statSync(full).isFile()) scan(full);
  }
  assert.deepEqual(offenders, [],
    `desc-toggle survives in shipped code (rg 'desc-toggle' index.html core/ should be empty):\n${offenders.join('\n')}`);
});
