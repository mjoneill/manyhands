/**
 * #923 acceptance 1 — THE CONTROL, and it is deliberately a test of the
 * CURRENT behaviour rather than the wanted one.
 *
 * ⛔ THE PROBLEM IT EXISTS TO SOLVE. Slice 0's acceptance is "cards render
 * sorted by `order` within their column." On the live board every card's
 * `order` already agrees with its position in the global `cards[]` array — so
 * a build that changes NOTHING passes that acceptance, and so does a build
 * that implements it perfectly. The criterion cannot fail, which means it
 * cannot pass either: green tells you nothing.
 *
 * ⇒ So this file pins the behaviour that must GO AWAY:
 *
 *     TODAY   a card's position is its index in the global `cards[]` array,
 *             and `order` is not consulted for cards at all.
 *     AFTER   cards sort by `order` within their column.
 *
 * ⭐ THIS SUITE PASSES TODAY AND MUST FAIL ONCE SLICE 0 LANDS. A builder who
 * implements ordering and sees these tests still green has NOT implemented it
 * — the red is the deliverable.
 *
 * ⛔⛔ BUT DO NOT DELETE THIS FILE WHEN IT GOES RED. INVERT IT.
 * (@minimo's correction to my handoff, 2026-08-20T21:15Z — I had written
 * "delete it in the commit that turns it red", and that is wrong: deleting it
 * removes the ONLY regression test that ever proved array-order and
 * order-order are distinguishable. The feature would ship having destroyed
 * its own evidence.)
 *
 *   KEEP    test 1 exactly as it is — the fixture guard is orientation-free.
 *           It must keep proving `order` disagrees with array position, or
 *           the inverted assertions become as vacuous as the originals.
 *   INVERT  tests 2 and 3 — flip them to assert rendering BY `order`
 *           permanently, rather than removing them.
 *   KEEP    whatever render paths these exercise. Today that is initial
 *           render; if Slice 0 adds a rerender path, the inverted suite
 *           covers both, because a sort applied on load and not on rerender
 *           passes an initial-render-only test.
 *
 * ── WHY THE FIXTURE LOOKS PERVERSE ──────────────────────────────────────────
 * Three cards whose `order` values are the exact REVERSE of their array
 * positions. That disagreement is the whole instrument: with it, array-order
 * and order-order are distinguishable; without it, the two hypotheses predict
 * the same DOM and no assertion can separate them.
 *
 * ⚠️ So the disagreement is itself asserted, before anything is measured. A
 * fixture edited into coincidence would otherwise keep passing while having
 * quietly stopped discriminating — a green that means "I looked" when it means
 * "I can no longer see."
 *
 * Column is `planned`, not `backlog`, on purpose: the backlog folds cards
 * untouched 30+ days behind a "show N older" expander (#303-4), which reorders
 * the DOM for reasons that have nothing to do with this card.
 *
 * Verified against the source it pins, 2026-08-20:
 *   index.html:3242  const colCards = cardsByColumn[col.id] || []
 *   index.html:3259  colCards.forEach(c => body.appendChild(renderCardOrEdit(c)))
 *   ⇒ no sort. `cardsByColumn` is filled by walking `cards[]` in array order.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBoardFixture, withBrowserServer } from './helpers/harness.mjs';

const ts = '2026-08-01T00:00:00.000Z';

// Array position 0,1,2 ↔ order 30,20,10. Reversed, so the two hypotheses
// predict opposite DOM sequences.
const FIXTURE = [
  { key: 'alpha', order: 30 },
  { key: 'bravo', order: 20 },
  { key: 'charlie', order: 10 },
];

function reversedOrderBoard() {
  return makeBoardFixture({
    cards: FIXTURE.map((f, i) => ({
      id: f.key,
      shortId: i + 1,
      title: f.key,
      description: '',
      type: 'task',
      assignees: [],
      labels: [],
      for: '',
      priority: null,
      column: 'planned',
      order: f.order,
      createdAt: ts,
      updatedAt: ts,
      relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [], supersededBy: [] },
    })),
    nextShortId: FIXTURE.length + 1,
  });
}

/** DOM sequence of card ids inside one column, top to bottom. */
const renderedIds = (page, columnId) => page.$$eval(
  `#column-${columnId} .card`,
  (els) => els.map((e) => e.dataset.id),
);

/**
 * ⭐ THE GUARD, and it runs before any measurement. If the fixture's `order`
 * ever agrees with its array position, every assertion below becomes
 * unfalsifiable while still passing.
 */
test('#923 control fixture actually discriminates — order DISAGREES with array position', () => {
  const byArray = FIXTURE.map((f) => f.key);
  const byOrder = [...FIXTURE].sort((a, b) => a.order - b.order).map((f) => f.key);
  assert.notDeepEqual(byArray, byOrder,
    'the fixture no longer distinguishes array-order from order-order — every other test in this file is now vacuous');
});

/**
 * ⛔ THE CONTROL. Passes today. MUST FAIL once cards render by `order`.
 */
test('#923 TODAY cards render in ARRAY position, ignoring `order` — this must FAIL after Slice 0', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 900 });
    await page.goto(server.baseUrl + '/', { waitUntil: 'networkidle0' });
    await page.waitForSelector('#column-planned .card', { timeout: 5000 });

    const dom = await renderedIds(page, 'planned');

    // Vacuity guard: a selector drift that finds nothing must fail loudly
    // rather than deepEqual an empty list against an empty list.
    assert.equal(dom.length, FIXTURE.length,
      `expected ${FIXTURE.length} rendered cards, found ${dom.length} — selector drift, not a passing test`);

    assert.deepEqual(dom, FIXTURE.map((f) => f.key),
      'cards no longer render in array position — if Slice 0 has landed, DELETE THIS FILE; if it has not, something else changed the render order');

    // And say the other half out loud: the DOM is NOT the `order` sequence.
    // Stated separately so the failure message names which hypothesis won.
    const byOrder = [...FIXTURE].sort((a, b) => a.order - b.order).map((f) => f.key);
    assert.notDeepEqual(dom, byOrder,
      'cards ARE rendering by `order` — Slice 0 is implemented and this control has done its job');
  }, { server: { board: reversedOrderBoard() }, launch: { headless: 'new' } });
});

/**
 * ⭐ The same fact stated as a MECHANISM rather than a symptom: the rendered
 * sequence equals the page's own `cards[]` array, filtered to the column.
 *
 * ⚠️ Worth its own test because the two can come apart. A builder could sort
 * `cards[]` itself at load time and leave the renderer untouched — the test
 * above would go red (correctly), but for a reason that is a data-layer change
 * rather than a render-layer one. This one names where the ordering lives.
 */
test('#923 TODAY the rendered sequence IS the global `cards[]` sequence', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 900 });
    await page.goto(server.baseUrl + '/', { waitUntil: 'networkidle0' });
    await page.waitForSelector('#column-planned .card', { timeout: 5000 });

    const arrayIds = await page.evaluate(
      () => cards.filter((c) => c.column === 'planned').map((c) => c.id),
    );
    assert.equal(arrayIds.length, FIXTURE.length,
      'the page global `cards` no longer holds the fixture — the test lost its subject');

    const dom = await renderedIds(page, 'planned');
    assert.deepEqual(dom, arrayIds,
      'render order has decoupled from `cards[]` — that decoupling is exactly what Slice 0 is for');
  }, { server: { board: reversedOrderBoard() }, launch: { headless: 'new' } });
});
