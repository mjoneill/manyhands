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
 * ✅ SLICE 0 LANDED 2026-08-24. This suite DID go red first — tests 2 and 3
 * failed the moment cards began sorting by `order` — and was then INVERTED
 * rather than deleted, per the correction below. The paragraph above is kept
 * in the past tense on purpose: it is the record of what this file proved, and
 * a reader who finds the inverted assertions needs to know they were earned by
 * a real red rather than written green.
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
 * ✅ INVERTED 2026-08-24, when Slice 0 landed. It read "TODAY cards render in
 * ARRAY position — this must FAIL after Slice 0", and it did fail, which is
 * what the control was for.
 *
 * ⛔ NOT DELETED. The handoff's original instruction was "delete the file in
 * the commit that turns it red"; that was corrected on the card before anyone
 * acted on it, because deleting removes the ONLY test that ever proved
 * array-order and order-order are distinguishable — the feature would ship
 * having destroyed its own evidence.
 */
test('#923 cards render by `order` within their column, NOT by array position', async () => {
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

    const byOrder = [...FIXTURE].sort((a, b) => a.order - b.order).map((f) => f.key);
    assert.deepEqual(dom, byOrder,
      'cards must render in `order` sequence within the column');

    // And say the other half out loud, so a failure names which hypothesis won
    // rather than only that they differ.
    assert.notDeepEqual(dom, FIXTURE.map((f) => f.key),
      'cards have reverted to rendering in array position — Slice 0 has regressed');
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
test('#923 the rendered sequence is DECOUPLED from the global `cards[]` sequence', async () => {
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
    assert.notDeepEqual(dom, arrayIds,
      'render order still tracks `cards[]` — the ordering did not reach the render layer');

    // ⭐ AND NAME WHERE THE ORDERING LIVES. A builder could have sorted
    // `cards[]` itself at load time and left the renderer untouched: that
    // passes "decoupled from array position" for a DATA-layer reason while the
    // render layer is unchanged. Asserting the array is STILL in fixture order
    // is what distinguishes the two.
    assert.deepEqual(arrayIds, FIXTURE.map((f) => f.key),
      'the global `cards[]` was itself re-sorted — Slice 0 belongs in the render '
      + 'path, and a data-layer sort would silently change what a whole-board save writes');
  }, { server: { board: reversedOrderBoard() }, launch: { headless: 'new' } });
});

/**
 * ⭐ THE RERENDER PATH — named by the handoff: "a sort applied on load and not
 * on rerender passes an initial-render-only test." Both tests above measure the
 * first paint only, so this drives a second render explicitly.
 */
test('#923 ordering survives a RERENDER, not just the initial paint', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 900 });
    await page.goto(server.baseUrl + '/', { waitUntil: 'networkidle0' });
    await page.waitForSelector('#column-planned .card', { timeout: 5000 });

    await page.evaluate(() => renderBoard());
    const dom = await renderedIds(page, 'planned');

    assert.equal(dom.length, FIXTURE.length,
      `expected ${FIXTURE.length} cards after rerender, found ${dom.length} — selector drift, not a passing test`);
    const byOrder = [...FIXTURE].sort((a, b) => a.order - b.order).map((f) => f.key);
    assert.deepEqual(dom, byOrder,
      'a second render dropped the ordering — the sort is on the load path only');
  }, { server: { board: reversedOrderBoard() }, launch: { headless: 'new' } });
});

/**
 * ⭐⭐ THE PROPERTY THAT MAKES THIS SLICE SAFE TO DEPLOY, and it is the one the
 * implementation comment claims: on a board where every `order` TIES, the sort
 * is a NO-OP and rendering is unchanged.
 *
 * Every card on the live board currently carries order 0, so Slice 0 changes
 * nothing a user sees until a backfill gives the field meaning — which is a
 * separate decision (#923 acceptance 3), deliberately not taken here.
 *
 * ⛔ THIS IS ALSO THE TIEBREAK GUARD. Adding a `shortId` tiebreak to the sort
 * would look tidier and would silently re-sequence all ~516 zero-order cards on
 * the next load — a render slice becoming an unannounced board-wide reshuffle.
 * This test fails if anyone adds one.
 */
test('#923 equal `order` preserves array position — the live board is unchanged until a backfill', async () => {
  // ⛔⛔ THE shortId VALUES ARE DELIBERATELY OUT OF STEP WITH ARRAY POSITION.
  // Caught by mutation: with shortIds 1,2,3 in array order, "stable sort" and
  // "sort with a shortId tiebreak" predict the SAME DOM, so this test passed
  // against the very mutant it exists to catch. A fixture whose two hypotheses
  // agree is not a control — it is a green light with nothing behind it.
  const FLAT = [
    { key: 'delta', shortId: 3 },
    { key: 'echo', shortId: 1 },
    { key: 'foxtrot', shortId: 2 },
  ];
  // Asserted, not assumed — the same guard test 1 applies to `order`.
  assert.notDeepEqual(
    FLAT.map((f) => f.key),
    [...FLAT].sort((a, b) => a.shortId - b.shortId).map((f) => f.key),
    'the fixture no longer distinguishes a stable sort from a shortId tiebreak — this test is vacuous',
  );

  const flat = makeBoardFixture({
    cards: FLAT.map((f) => ({
      id: f.key, shortId: f.shortId, title: f.key, description: '', type: 'task',
      assignees: [], labels: [], for: '', priority: null, column: 'planned',
      order: 0,                       // ⇐ every card ties, exactly like production
      createdAt: ts, updatedAt: ts,
      relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [], supersededBy: [] },
    })),
    nextShortId: 4,
  });

  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 900 });
    await page.goto(server.baseUrl + '/', { waitUntil: 'networkidle0' });
    await page.waitForSelector('#column-planned .card', { timeout: 5000 });

    const dom = await renderedIds(page, 'planned');
    assert.equal(dom.length, 3, `expected 3 cards, found ${dom.length} — selector drift, not a passing test`);
    assert.deepEqual(dom, ['delta', 'echo', 'foxtrot'],
      'cards with equal `order` must keep their array position — a stable sort with '
      + 'no tiebreak is what keeps this slice invisible on the live board');
  }, { server: { board: flat }, launch: { headless: 'new' } });
});
