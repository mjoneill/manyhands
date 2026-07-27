/**
 * #525 — every custom property a surface uses is actually defined.
 *
 * Four were not: `--sage` (14 uses across settings.html and wiki.html), and
 * `--text`, `--bg-tertiary`, `--accent-blue` on the board. Twenty uses, eighteen
 * with no fallback.
 *
 * ── What an invalid var() actually does, because I got this wrong ──────────
 * It does NOT drop the declaration. A property containing an invalid `var()`
 * substitution is *invalid at computed-value time*: it computes to the
 * property's INHERITED value if the property inherits, otherwise its INITIAL
 * value. So the damage depends entirely on which property it lands on:
 *
 *   color             → inherited        wrong colour, still visible
 *   border-color      → currentColor     wrong colour, still visible
 *   background-color  → transparent      genuinely missing
 *
 * I filed this as a WCAG 2.4.7 failure — "the board search has no focus
 * indicator" — and it was false. The ring was there, painted in currentColor
 * (near-white) instead of the accent. **The failure mode is not silence, it is
 * a plausible wrong value**, which is harder to see and easier to overstate.
 *
 * ── The probe technique, documented because it lied to two seats ───────────
 * Calling `element.focus()` and reading `getComputedStyle()` inside the SAME
 * `page.evaluate()` returns the pre-focus values — the style pass has not
 * re-run. My first probe did this and reported "focus changes nothing." A
 * second seat confirmed it from their own machine using the same technique, and
 * we both read the agreement as the finding getting stronger. It was one broken
 * instrument run twice.
 *
 * So: focus in one call, read in another. The helper below is the only way this
 * suite is allowed to measure interaction state.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startRestServer, makeBoardFixture, PROJECT_DIR } from './helpers/harness.mjs';

const FILES = [
  'index.html', 'wiki.html', 'commons.html', 'settings.html',
  'core/theme.css', 'core/header.css', 'core/conversation-view.css',
];

test('#525 mechanical: every var(--x) in shipped CSS is defined, or carries a fallback', () => {
  const defined = new Set();
  for (const f of FILES) {
    const src = fs.readFileSync(path.join(PROJECT_DIR, f), 'utf8');
    for (const m of src.matchAll(/(--[a-z0-9-]+)\s*:/gi)) defined.add(m[1]);
  }

  const offenders = [];
  for (const f of FILES) {
    const src = fs.readFileSync(path.join(PROJECT_DIR, f), 'utf8');
    for (const m of src.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,)?/gi)) {
      const [, name, hasFallback] = m;
      if (!defined.has(name) && !hasFallback) offenders.push(`${f}: var(${name})`);
    }
  }

  assert.deepEqual(
    [...new Set(offenders)], [],
    'undefined custom properties with no fallback. These do not error — the property computes to its\n'
    + 'inherited or initial value, so the page renders a PLAUSIBLE WRONG VALUE and nothing complains:\n'
    + `${[...new Set(offenders)].join('\n')}`,
  );
});

/**
 * Read a computed property, then trigger an interaction, then read again —
 * each in its own evaluation, so the style pass runs in between.
 * This separation is the whole point; see the header.
 */
async function beforeAfter(page, selector, prop, interact) {
  const before = await page.$eval(selector, (el, p) => getComputedStyle(el)[p], prop);
  await interact();
  await new Promise((r) => setTimeout(r, 120));
  const after = await page.$eval(selector, (el, p) => getComputedStyle(el)[p], prop);
  return { before, after, changed: before !== after };
}

test('#525 the surfaces paint what they meant to: backgrounds present, focus and hover the intended colour', async () => {
  const server = await startRestServer({
    board: makeBoardFixture({
      cards: [{
        id: 'c1', shortId: 1, title: 'Anchor', description: 'Body.', type: 'task',
        assignees: [], labels: [], for: '', priority: null, column: 'backlog', order: 0,
        createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z',
        relationships: { relatedTo: [], blockedBy: [] },
      }],
      nextShortId: 2,
    }),
    staticDir: PROJECT_DIR,
  });
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const TRANSPARENT = 'rgba(0, 0, 0, 0)';
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1442, height: 900 });
    await page.goto(server.baseUrl, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.board-search-input');

    // background-color's initial value is transparent, so an undefined var here
    // really does vanish — this is the half of the bug that was genuinely real.
    const searchBg = await page.$eval('.board-search-input', (el) => getComputedStyle(el).backgroundColor);
    assert.notEqual(searchBg, TRANSPARENT,
      'the board search input has no background — an undefined var() on background-color computes to transparent');

    // Focus must change the border AND land on the house accent, not on
    // currentColor. Asserting only "it changed" would have passed throughout
    // the bug, because currentColor is itself a change.
    // Asserted as "not currentColor" rather than an exact triple, and that is
    // deliberate twice over. First, exact RGB is brittle: the same accent
    // measured rgb(123,108,239) in one run and rgb(118,103,227) in another
    // under different colour management, so an equality assertion would flake.
    // Second, "it changed" alone would have passed throughout the entire bug —
    // currentColor IS a change. The discriminating question is whether the
    // border landed on the accent or fell back to the text colour, so compare
    // it against the element's own `color`, which is exactly what currentColor
    // resolves to.
    const textColour = await page.$eval('.board-search-input', (el) => getComputedStyle(el).color);
    const focus = await beforeAfter(page, '.board-search-input', 'borderTopColor',
      () => page.click('.board-search-input'));
    assert.equal(focus.changed, true, 'focusing the board search changes nothing about its border');
    assert.notEqual(focus.after, textColour,
      `focus border resolved to currentColor (${focus.after}) — that is the signature of an undefined var(), `
      + 'not an intended colour. The ring is visible either way, which is why this needs asserting.');

    await page.goto(`${server.baseUrl}/settings.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#save');
    const saveBg = await page.$eval('#save', (el) => getComputedStyle(el).backgroundColor);
    assert.notEqual(saveBg, TRANSPARENT,
      'the Settings Save button has no background — the primary action on the page is unpainted');
  } finally {
    await browser.close();
    await server.stop();
  }
});
