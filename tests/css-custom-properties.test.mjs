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
import { startRestServer, makeBoardFixture, PROJECT_DIR, withBrowserServer } from './helpers/harness.mjs';

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
 * Read a computed property until it stops moving.
 *
 * THE THIRD TRAP, found by the reviewing seat grading this suite (2026-07-27): the first
 * version of this helper slept a flat 120ms. `.board-search-input` carries
 * `transition: border-color 0.15s`. So the read landed MID-FLIGHT, on an
 * interpolated colour equal to neither endpoint — which meant
 * `assert.notEqual(after, textColour)` passed **vacuously in the exact case it
 * exists to catch**. Planting `border-color: currentColor` on the focus rule
 * left the suite green. A 30ms gap defeated the discriminator the header spends
 * two paragraphs explaining.
 *
 * This is the lesson already banked in #509's suite comment — *a box measured
 * mid-flight is the same corrupt number as one measured frozen* — arriving in a
 * new costume. Geometry there, colour here. **Lessons banked in one suite's
 * comments do not propagate to the next suite by default.**
 *
 * Polling for a stable value rather than raising the sleep is deliberate: a
 * bigger number is correct only until someone changes a transition duration,
 * and it would fail silently again when they do. Three consecutive identical
 * reads is not reachable mid-transition at this sample rate.
 */
async function settled(page, selector, prop, { interval = 30, stableReads = 3, maxMs = 2000 } = {}) {
  const read = () => page.$eval(selector, (el, p) => getComputedStyle(el)[p], prop);
  let last = null;
  let same = 0;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const v = await read();
    same = v === last ? same + 1 : 0;
    last = v;
    if (same >= stableReads - 1) return v;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`${selector} ${prop} never settled within ${maxMs}ms (last: ${last}) — `
    + 'a value still moving after two seconds is a finding, not a timeout to raise');
}

/**
 * Read a settled value, trigger an interaction, WAIT FOR IT TO CHANGE, then
 * read the settled value — each read in its own evaluation, so the style pass
 * runs in between.
 *
 * ⛔ 2026-08-12 — THE AFTER-READ USED TO BE A BARE `settled()` AND THAT IS A RACE.
 *
 * `page.click()` resolves when the click is DISPATCHED, not when `:focus` has
 * been applied and the style recalculated. So the old code could start polling
 * before the transition began, read three identical OLD values, and return them
 * as "settled" — reporting `changed: false` on a border that was about to move.
 *
 * ⚠️ The helper could not distinguish STABLE BECAUSE IT FINISHED from STABLE
 * BECAUSE IT NEVER STARTED. And the failure was CHEAPER than the success: the
 * suite watch's red runs were ~1000ms FASTER on this very test than three green
 * runs, because returning early is exactly what returning early costs. ⚠️ That
 * refutes SUSTAINED suite-wide load (which predicts slower); a LOCALISED
 * transient on this one page remains viable and is not refuted.
 *
 * ⇒ The fix is to wait for the value to DIFFER (with a deadline), and only then
 *   let it settle. A deadline expiry means NO CHANGE WAS OBSERVED WITHIN
 *   changeDeadlineMs — NOT that the value never moved. That is a reportable
 *   result rather than a silent false negative, and the distinction is the
 *   whole point of this fix.
 *
 * ── THE MARGIN, MEASURED, so the next reader sees the cushion rather than
 *    re-deriving it (dates and denominators, per the same day's lesson) ──────
 *
 *   settled() floor      66ms median (63–67 over 10 runs, 2026-08-12)
 *                        NOT 90ms: the loop sleeps TWICE, not three times —
 *                        read, 30ms, read, 30ms, read, return. Page-independent;
 *                        it is the loop plus three CDP round-trips.
 *   change onset, REAL page  ~43ms median (n=15, 2026-08-12, @wren)
 *   cushion              ≈ 1.5×
 *
 * ⚠️ Do NOT re-derive the onset number from a synthetic fixture. Measured
 * against a 6-line stub page it is ~4ms, which would report a ~16× cushion —
 * right mechanism, wrong population. The denominator has to come from the real
 * board page, because that is what this test loads.
 *
 * ⇒ 1.5× is a MARGIN, not an explanation. It says a ~53% localised slowdown
 *   would be enough to cross the floor — it does NOT establish that this is what
 *   happens at 04:45. Attribution to the production failures stays PROVISIONAL
 *   until a recurrence window passes clean, or a firing arrives without the
 *   early-return signature and falsifies it.
 */
async function beforeAfter(page, selector, prop, interact, { changeDeadlineMs = 2000 } = {}) {
  const read = () => page.$eval(selector, (el, p) => getComputedStyle(el)[p], prop);
  const before = await settled(page, selector, prop);
  await interact();

  const deadline = Date.now() + changeDeadlineMs;
  let changed = false;
  while (Date.now() < deadline) {
    if (await read() !== before) { changed = true; break; }
    await new Promise((r) => setTimeout(r, 15));
  }
  // No change within the deadline is a RESULT, not an exception: the caller
  // asserts on `changed`, and its message is more useful than a throw here.
  const after = changed ? await settled(page, selector, prop) : before;
  return { before, after, changed };
}

test('#525 the surfaces paint what they meant to: backgrounds present, focus and hover the intended colour', async () => {
  const TRANSPARENT = 'rgba(0, 0, 0, 0)';
  await withBrowserServer(async ({ server, browser }) => {
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
  }, { server: {
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
  }, launch: { headless: 'new', args: ['--no-sandbox'] } });
});

// ── #525's flake, made deterministic ────────────────────────────────────────
//
// The suite watch fired on css-custom-properties on 2026-08-11 and 08-12, and
// flagged it as a flake on 08-05, 08-06 and 08-09. The failing assertion was
// `focus.changed === true` — a border that did move, reported as unmoved.
//
// ⭐ This test does not reproduce the WILD failure; it reproduces the MECHANISM
// that makes the wild failure possible, on demand, with no timing luck. It
// defers the CHANGE ONSET past settled()'s measured ~66ms floor by giving the
// border a transition-delay, which holds the computed value at its OLD value
// while the poller runs.
//
// ⚠️ TERMINOLOGY (@minimo): transition-delay defers the computed-value
// TRANSITION, not necessarily style recalculation itself. What the poller sees
// is a value that has not STARTED MOVING yet — which is the property this test
// needs, and is a narrower claim than "recalc was delayed."
//
// ⚠️ VERIFIED BEFORE RELYING ON IT (@minimo's pre-check, and it was not safe to
// assume): during `transition-delay`, getComputedStyle().borderTopColor really
// does report the pre-transition value — measured, with a no-delay control that
// confirmed focus moves the value at all. Had the computed value jumped
// immediately with only the PAINT deferred, this test would have gone green
// while proving nothing, which is worse than not having it.
//
// ⛔ It fails against the pre-2026-08-12 `beforeAfter` (a bare `settled()` for
// the after-read) and passes against the wait-for-change version. That red→green
// is the whole point; a version of this test that passes both ways is decoration.
test('#525 the change detector survives a DELAYED CHANGE ONSET — the mechanism behind the flake', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1442, height: 900 });
    await page.goto(server.baseUrl, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.board-search-input');

    // 400ms >> the ~66ms floor, so the old helper polls three identical OLD
    // values and returns them as settled. Deterministic, not load-dependent.
    await page.addStyleTag({
      content: '.board-search-input { transition: border-color 1ms !important;'
        + ' transition-delay: 400ms !important; }',
    });

    const focus = await beforeAfter(page, '.board-search-input', 'borderTopColor',
      () => page.click('.board-search-input'));

    assert.equal(focus.changed, true,
      'the border DID change and the helper reported it unchanged — it polled the pre-recalc '
      + 'value three times and could not tell "stable because it finished" from "stable '
      + 'because it never started"');
    assert.notEqual(focus.after, focus.before,
      'the after-read must be the settled NEW value, not the before value handed back');
  }, { server: {
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
  }, launch: { headless: 'new', args: ['--no-sandbox'] } });
});
