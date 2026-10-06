/**
 * #1445 — WHY THE PREVIEW STAYS CLOSED, AND WHAT IT TAKES TO OPEN IT: fault injection on the real board page (a real headless browser, a real REST server, the real editor module).
 * Written by the separate test author. The CI failure is `previewing:false, previewHidden:true, previewLinks:0` five seconds after the click. The editor's toggle handler is
 * synchronous, so that state means the handler never ran, not that it was slow. These rows inject each candidate cause into the real page and show what the old wait and the
 * new `openPreview` (helpers/preview-ready.mjs) do with it. A fault is injected by a capture-phase listener on the document, which runs before the editor's own handler.
 *
 *   F0  CONTROL: no fault. `openPreview` opens it on the first activation.
 *   F1  THE MECHANISM: the FIRST click on the preview button never reaches its handler (what a layout shift between measuring the position and dispatching the mouse event does).
 *       The old shape (one click, then wait 5 s) fails with EXACTLY the CI state `previewing:false, previewHidden:true, previewLinks:0`; a longer wait would not change it (checked:
 *       the old shape with a 12 s wait fails the same way). The new helper opens it on the second activation and reports attempts = 2.
 *   F2  A SLOW HANDLER: the first click is held back and delivered 7 s later (past the old 5 s). The old shape fails; the new helper opens it, waiting on the page's signal; and once the late original
 *       click HAS arrived (after the retry already opened it) the preview is still open with its three refs, because the Preview button opens, it does not toggle (core/editor.mjs: click -> showPreview(true)).
 *   F3  THE SABOTAGE CLAUSE: no click ever reaches the button. `openPreview` THROWS at its ceiling (6 s here), names `never opened`, the attempt count and the editor's state, and the
 *       attempts are more than one (it did not give up after the first).
 *
 * NOT COVERED, by name: the real cause in CI (this shows a lost click reproduces the exact state and that waiting longer cannot help it, not that a layout shift is what happened on those
 * runners); the product's geometry itself (a button that moves under a user's finger is a separate question); the other surfaces' previews.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBoardFixture, withBrowserServer } from './helpers/harness.mjs';
import { openPreview } from './helpers/preview-ready.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ts = '2026-09-14T00:00:00.000Z';
const card = (shortId, title) => ({ id: `c${shortId}`, shortId, title, description: '', type: 'task', column: 'backlog', order: shortId, assignees: ['unassigned'], labels: [], priority: null, createdAt: ts, updatedAt: ts });
const BTN = '.mh-editor:has(#card-desc) [data-editor-preview]';
const ED = '.mh-editor:has(#card-desc)';

async function withForm(fault, body) {
  const board = makeBoardFixture({ cards: [card(1, 'first card'), card(2, 'second card'), card(3, 'third card')], nextShortId: 4 });
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.board-header', { timeout: 30_000 });
    await page.click('.btn-expand-form');
    await page.waitForSelector('#add-card-form-wrapper.expanded', { timeout: 30_000 });
    await page.evaluate(() => { document.getElementById('card-more').open = true; });
    await page.waitForSelector(BTN, { timeout: 30_000 });
    await page.evaluate(() => {
      const ta = document.getElementById('card-desc');
      ta.value = 'Start #1 here, middle #2, end #3.';
      ta.dispatchEvent(new Event('input'));
    });
    // wait for the slide-open to finish so the control is not about geometry
    await page.waitForFunction((sel) => { const b = document.querySelector(sel); b.scrollIntoView({ block: 'nearest' }); const r = b.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b; }, { timeout: 30_000 }, BTN);
    if (fault) await page.evaluate(fault);
    await body({ page });
  }, { server: { board } });
}
const clickFirst = (page) => async () => { await page.click(BTN); };
const stateOf = (page) => page.evaluate((sel) => {
  const ed = document.querySelector(sel); const pv = ed?.querySelector('.mh-editor-preview');
  return { previewing: ed?.classList.contains('previewing') ?? null, previewHidden: pv?.hidden ?? null, previewLinks: pv?.querySelectorAll('a[data-shortid]').length ?? null };
}, ED);
/** The shape of the wait BEFORE this change: one coordinate click, then poll for three refs for `ms`. Reproduced from the old test, for comparison only. */
async function oldShape(page, ms) {
  await page.click(BTN);
  try {
    await page.waitForFunction(() => document.querySelectorAll('.mh-editor:has(#card-desc) .mh-editor-preview:not([hidden]) a[data-shortid]').length === 3, { timeout: ms, polling: 100 });
    return { opened: true };
  } catch { return { opened: false, state: await stateOf(page) }; }
}

const SWALLOW_FIRST = () => { let n = 0; document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('[data-editor-preview]') && n++ === 0) { e.stopImmediatePropagation(); e.preventDefault(); } }, true); };
const SWALLOW_ALL = () => { document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('[data-editor-preview]')) { e.stopImmediatePropagation(); e.preventDefault(); } }, true); };
const DELAY_FIRST_7S = () => {
  let n = 0;
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-editor-preview]');
    if (b && n++ === 0) { e.stopImmediatePropagation(); e.preventDefault(); setTimeout(() => { n = 99; b.click(); }, 7000); }
  }, true);
};

test('F0 CONTROL: with no fault, openPreview opens the preview on the first activation', { timeout: 120_000 }, async () => {
  await withForm(null, async ({ page }) => {
    const r = await openPreview(page, { buttonSelector: BTN, editorSelector: ED, clickFirst: clickFirst(page) });
    assert.equal(r.attempts, 1, `one activation was enough (${JSON.stringify(r)})`);
    assert.equal((await stateOf(page)).previewLinks, 3, 'and the three refs are rendered');
  });
});

test('F1 THE MECHANISM: when the first click never reaches the handler, the old shape fails with the exact CI state and waiting longer does not help; openPreview opens it on the second activation', { timeout: 180_000 }, async () => {
  await withForm(SWALLOW_FIRST, async ({ page }) => {
    const old5 = await oldShape(page, 5000);
    assert.equal(old5.opened, false, 'the old shape (one click, 5 s) does not open it');
    assert.deepEqual(old5.state, { previewing: false, previewHidden: true, previewLinks: 0 }, 'and the state is exactly the one CI reported: previewing:false, previewHidden:true, previewLinks:0');
  });
  await withForm(SWALLOW_FIRST, async ({ page }) => {
    const old12 = await oldShape(page, 12_000);
    assert.equal(old12.opened, false, 'WAITING LONGER DOES NOT HELP: one click and a 12 s wait fails the same way');
    assert.equal(old12.state.previewing, false);
  });
  await withForm(SWALLOW_FIRST, async ({ page }) => {
    const r = await openPreview(page, { buttonSelector: BTN, editorSelector: ED, clickFirst: clickFirst(page) });
    assert.equal(r.attempts, 2, `openPreview opened it on the second activation (${JSON.stringify(r)})`);
    assert.equal((await stateOf(page)).previewLinks, 3);
  });
});

test('F2 A SLOW HANDLER: a first click delivered 7 s late fails the old 5 s shape and opens under openPreview, which waits on the page\'s signal', { timeout: 180_000 }, async () => {
  await withForm(DELAY_FIRST_7S, async ({ page }) => {
    const old5 = await oldShape(page, 5000);
    assert.equal(old5.opened, false, 'the old 5 s shape gives up before the late handler runs');
  });
  await withForm(DELAY_FIRST_7S, async ({ page }) => {
    const r = await openPreview(page, { buttonSelector: BTN, editorSelector: ED, clickFirst: clickFirst(page) });
    assert.ok(r.ms < 20_000, `it opened (${JSON.stringify(r)})`);
    assert.equal((await stateOf(page)).previewLinks, 3);
    // THE LATE ORIGINAL CLICK: the held-back first click is delivered at 7 s, AFTER the retry already opened the preview. The Preview button calls showPreview(true), it is not a toggle, so a late click
    // must leave the preview open with its three refs. Wait past the delivery and check.
    await sleep(Math.max(0, 8000 - r.ms));
    assert.deepEqual(await stateOf(page), { previewing: true, previewHidden: false, previewLinks: 3 }, 'after the late original click arrived, the preview is still open with its three refs');
  });
});

test('F3 THE SABOTAGE CLAUSE: if no click ever reaches the button, openPreview throws at its ceiling naming `never opened`, the attempts and the state', { timeout: 120_000 }, async () => {
  await withForm(SWALLOW_ALL, async ({ page }) => {
    const t0 = Date.now();
    await assert.rejects(
      () => openPreview(page, { buttonSelector: BTN, editorSelector: ED, clickFirst: clickFirst(page), ceilingMs: 6000 }),
      (err) => {
        const m = String(err.message);
        assert.match(m, /never opened/, m);
        assert.match(m, /previewing":false/, `the state is in the message: ${m}`);
        const attempts = Number(/and (\d+) activation/.exec(m)?.[1]);
        assert.ok(attempts >= 2, `it did not give up after the first activation (${attempts})`);
        return true;
      },
    );
    assert.ok(Date.now() - t0 >= 5900 && Date.now() - t0 < 15_000, `it failed at its ceiling, not at once and not never (${Date.now() - t0} ms)`);
  });
});
