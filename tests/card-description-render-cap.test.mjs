/**
 * #209 option (d) — the board renders 7.5 MB of description text into tiles
 * that display four lines of it.
 *
 * MEASURED (2026-09-01, live board, 1,009 cards): `/api/load` transfer 0.227 s,
 * `JSON.parse` 14.6 ms — together ~4% of the ~6 s wait @michael feels. The rest
 * is DOM construction. `renderCard` (index.html:2763-2769) already COMPUTES
 * `isLong` from the app's own constants and then renders the whole body anyway,
 * adding only a CSS class; `.card-description.collapsed { max-height: 6em }`
 * hides ~95% of what it just built. 976 of 1,009 bodies exceed 300 chars;
 * #755 alone is 107,155 characters rendered into a four-line box.
 *
 * ⚠️ THE BEHAVIOUR UNDER TEST IS NOT "THE TILE IS SMALLER" — that is the
 * mechanism, and a cap chosen to maximise the saving is a REGRESSION. The
 * behaviour is: **the board draws the same page from less markup.** So every
 * test here pairs a shrink assertion with a no-loss assertion, and the no-loss
 * side is measured at the rendered box, not argued from character arithmetic.
 *
 * Truncation is safe HERE and nowhere else because #510 removed the in-column
 * expander: `.collapsed` is set at render and never cleared, so text past 6em
 * can never be revealed in place. The full body is read through the detail
 * pop-out, which renders from `card.description` in memory — the model, which
 * this change must leave untouched. Test 4 is that falsifier.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBoardFixture, withBrowserServer } from './helpers/harness.mjs';

const ts = '2026-05-01T00:00:00.000Z';
const VIEWPORTS = [480, 768, 1024, 1442, 2560];

/** Unique, and placed at the very END of the long body: a marker that survives
 *  truncation would mean nothing was truncated. */
const TAIL = 'ZZ-TAIL-MARKER-209';

/** ~20,000 chars over 400 lines — past any plausible cap by a wide margin, so
 *  this fixture keeps failing a cap that is merely raised. */
const LONG = Array.from({ length: 400 }, (_, i) =>
  `Line ${String(i + 1).padStart(3, '0')}: this body is rendered into a four-line box.`).join('\n')
  + `\n${TAIL}`;

/** Under BOTH collapse thresholds (3 newlines / 200 chars), so it is rendered
 *  UNCOLLAPSED with `max-height: none` — every character of it is on screen and
 *  must survive byte-for-byte. */
const SHORT = 'A short body that is fully visible on the tile and must not change.';

/** The WORST case for the cap: no newlines at all, so the four visible lines
 *  are as wide as the column allows. A cap validated only against a body with
 *  a newline every 60 chars is validated against the easy case. */
const UNBROKEN = 'unbroken '.repeat(560);

function card(id, shortId, title, description, column = 'backlog') {
  return {
    id, shortId, title, description, type: 'task',
    assignees: [], labels: [], for: '', priority: null, column, order: shortId,
    createdAt: ts, updatedAt: ts, relationships: { relatedTo: [], blockedBy: [] },
  };
}

const board = () => makeBoardFixture({
  cards: [
    card('c1', 1, 'Short body', SHORT),
    card('c2', 2, 'Long body', LONG),
    card('c3', 3, 'Unbroken body', UNBROKEN),
  ],
  nextShortId: 4,
});

const descText = (page, shortId) => page.evaluate((sid) => {
  const el = [...document.querySelectorAll('.card')]
    .find((c) => c.querySelector('.card-shortid')?.textContent.trim() === `#${sid}`);
  const d = el?.querySelector('.card-description');
  return d ? { text: d.textContent, collapsed: d.classList.contains('collapsed') } : null;
}, shortId);

test('#209(d): a long body does not reach the tile in full, a short body is unchanged, and the model keeps both', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1442, height: 900 });
    await page.goto(server.baseUrl + '/', { waitUntil: 'networkidle0' });
    await page.waitForSelector('.card', { timeout: 5000 });

    const long = await descText(page, 2);
    assert.ok(long, 'the long card rendered a description');
    assert.ok(long.collapsed, 'the long body is collapsed — otherwise this card is not the case under test');

    // THE SHRINK. Bounded by an absolute number, not by "less than before":
    // an implementation that shaved 10% would pass a relative assertion.
    assert.ok(
      long.text.length < 1200,
      `tile carries ${long.text.length} of ${LONG.length} chars — the whole body is still being built into a 6em box`,
    );
    assert.ok(
      !long.text.includes(TAIL),
      'the END of a 20,000-char body is present in a tile that displays four lines',
    );

    // THE NO-LOSS SIDE, part 1: an uncollapsed body is byte-identical. A cap
    // applied unconditionally would truncate visible text and fail HERE.
    const short = await descText(page, 1);
    assert.ok(short, 'the short card rendered a description');
    assert.equal(short.collapsed, false, 'a short body is not collapsed');
    assert.equal(short.text, SHORT, 'a fully-visible body must survive byte-for-byte');

    // THE MODEL IS UNTOUCHED. This is what makes truncating the render safe;
    // an implementation that trimmed `card.description` on load would pass
    // every assertion above and silently destroy data on the next save.
    const served = await (await fetch(`${server.baseUrl}/api/cards/2`)).json();
    assert.equal(served.description.length, LONG.length, 'the stored body is not shortened');
    // The client's OWN copy, asked through the surface that reads it: search
    // matches on `card.description` (index.html:1970 — the MODEL, not the DOM).
    // Searching for text that is no longer anywhere in the markup must still
    // find the card. An implementation that trimmed the model instead of the
    // render passes every assertion above and fails here.
    await page.click('#board-search-input');
    await page.keyboard.type(TAIL);
    await new Promise((r) => setTimeout(r, 300));
    const visibleIds = await page.evaluate(() => [...document.querySelectorAll('.card')]
      .filter((c) => c.getBoundingClientRect().height > 0)
      .map((c) => c.querySelector('.card-shortid')?.textContent.trim()));
    assert.deepEqual(
      visibleIds, ['#2'],
      'searching the truncated tail must still find card #2 (and only it) — the model must be whole',
    );
  }, { server: { board: board() }, launch: { headless: 'new' } });
});

test('#209(d): the visible box stays FULL at every viewport, and the full body is still readable in the pop-out', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    const offenses = [];

    for (const vw of VIEWPORTS) {
      await page.setViewport({ width: vw, height: 900 });
      await page.goto(server.baseUrl + '/', { waitUntil: 'networkidle0' });
      await page.waitForSelector('.card', { timeout: 5000 });
      await page.evaluate(() => Promise.race([
        Promise.allSettled(document.getAnimations().map((a) => a.finished)),
        new Promise((r) => setTimeout(r, 1200)),
      ]));

      for (const sid of ['2', '3']) {
      const probe = await page.evaluate((s) => {
        const el = [...document.querySelectorAll('.card')]
          .find((c) => c.querySelector('.card-shortid')?.textContent.trim() === `#${s}`);
        const d = el?.querySelector('.card-description');
        if (!d) return null;
        const before = { scrollH: d.scrollHeight, clientH: d.clientHeight };
        // The control, in the same element and the same probe: empty it and the
        // overflow must go away. Without this, "scrollHeight > clientHeight"
        // could be a property of the probe rather than of the content, and a
        // too-small cap would read as a pass.
        const keep = d.textContent;
        d.textContent = 'x';
        const emptied = { scrollH: d.scrollHeight, clientH: d.clientHeight };
        d.textContent = keep;
        return { before, emptied };
      }, sid);
      if (!probe) { offenses.push(`@${vw}px: no description box on card #${sid}`); continue; }

      // The truncated content must STILL overflow the 6em clip. If it does not,
      // the cap cut into text the reader could see — the regression this cap
      // exists to avoid.
      if (probe.before.scrollH <= probe.before.clientH + 1) {
        offenses.push(
          `@${vw}px card #${sid}: the clip box is no longer full: scrollHeight ${probe.before.scrollH} ` +
          `<= clientHeight ${probe.before.clientH} — the cap cut VISIBLE text`,
        );
      }
      if (probe.emptied.scrollH > probe.emptied.clientH + 1) {
        offenses.push(`@${vw}px card #${sid}: BROKEN PROBE: an emptied box still reports overflow — the assertion above proves nothing`);
      }
      }
    }
    assert.deepEqual(offenses, [], `visible-loss offenses (${offenses.length}):\n${offenses.join('\n')}`);

    // #510's reading path: the pop-out renders from the model, so the text the
    // tile no longer carries is still one click away, in full.
    await page.setViewport({ width: 1442, height: 900 });
    await page.goto(`${server.baseUrl}/?card=2`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.card-detail-body', { timeout: 5000 });
    const detail = await page.evaluate(() => document.querySelector('.card-detail-body')?.textContent ?? '');
    assert.ok(detail.includes(TAIL), 'the detail pop-out must still show the END of the body — the whole reading path');
    assert.ok(detail.length >= LONG.length - 5, `pop-out shows ${detail.length} of ${LONG.length} chars`);
  }, { server: { board: board() }, launch: { headless: 'new' } });
});
