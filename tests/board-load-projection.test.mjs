/**
 * #209 conditions 1, 3 and 5 — the board must draw its LIST from a projection
 * that carries no card bodies, and must do it without silently losing a card,
 * a body, or a search hit.
 *
 * WHAT ALREADY SHIPPED IS NOT THIS. The 2026-09-02 render cap
 * (`DESC_RENDER_CAP`, 077cfd1/fa49749) capped what becomes MARKUP and moved
 * the beneficiary's reported draw from 5+ s to 1-2 s. It moved ZERO BYTES: `/api/load` still
 * ships every description on every load — measured post-deploy, tile characters
 * 7,076,786 -> 498,599 while the payload did not move at all. Condition 1 is
 * about bytes on the wire and is entirely open.
 *
 * ⚠️ READ THIS BEFORE ASSUMING THESE TESTS ARE RED-FIRST. Only ONE of them
 * fails today (`no card body reaches the browser during a cold load`). The
 * other four PASS against the current `/api/load` build, because a page that
 * downloads everything trivially has everything. They are written now, before
 * the change, because they are the falsifiers for the four ways this build
 * breaks the product SILENTLY — and a guard written afterwards is a guard
 * written by someone who already knows which way the code went:
 *
 *   COVERAGE     `/api/cards` caps at 500. A naive single-call swap renders
 *                500 of N cards with no error and no empty state (#209 cond 5).
 *                Assert rendered == cardsTotal, never "cards rendered".
 *   THE BODY     `openCardDetail` renders from `card.description` IN MEMORY.
 *                A projection-hydrated model has none, so the pop-out goes
 *                EMPTY — condition 2's negative control, live again. The
 *                remedy must be LAZY-LOADING, never deletion of the data path.
 *   SEARCH       `cardMatchesSearchTerm` (index.html:1970) matches against
 *                `card.description`. Hydrate without bodies and description
 *                search STOPS FINDING THINGS — no error, no empty state, a
 *                search box that quietly answers a narrower question. This
 *                coupling is not written down anywhere else on the card.
 *   THE SAVE     `/api/save` takes the cards array WHOLESALE. #1039 made an
 *                ABSENT key mean "no opinion" server-side and proved it
 *                (tests/save-projection-blank.test.mjs). What that cannot
 *                prove is the CLIENT half: that this browser, after hydrating
 *                a projection, actually omits the key rather than sending
 *                `description: ''`. An empty string is a REAL CLEAR under
 *                #1039's rule, so a client-side default of '' walks straight
 *                through the server guard and blanks every body on the board.
 *
 * ⇒ So the value of this file is entirely in the four that are green. If a
 * projection lands and they stay green, the build is safe. If one goes red,
 * it went red for the exact reason named above its assertion.
 *
 * Fixture identities are ada/bex/cy per #808 — never real seat names.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBoardFixture, withBrowserServer } from './helpers/harness.mjs';

const ts = '2026-05-01T00:00:00.000Z';

/**
 * ⚠️ FRESH `updatedAt`, and it is load-bearing. #303-4 folds a BACKLOG card
 * untouched for 30+ days behind a "show N older" expander once five of them
 * pile up (`STALE_MIN_TO_FOLD = 5`, index.html:3394). A fixture dated in the
 * past therefore renders ZERO cards at N>=5 — the column count still says 501,
 * nothing errors, and every assertion below fails for a reason that has
 * nothing to do with #209. That is exactly how this file first ran: four of
 * five red, and the cause was my own fixture, not the board.
 */
const FRESH = new Date().toISOString();

/** Text that exists ONLY in a body — never in a title, never in a label. A
 *  search for this can only be answered from `description`. */
const BODY_ONLY = 'QQ-BODY-ONLY-MARKER-209';

/** Placed at the END of a long body: a marker that survives means nothing was
 *  truncated on the way to the pop-out. */
const BODY_TAIL = 'QQ-TAIL-MARKER-209';

/**
 * ⚠️ CORRECTED 2026-09-02, AFTER THIS TEST FAILED THE IMPLEMENTATION AND THE
 * IMPLEMENTATION WAS RIGHT. Recorded rather than quietly rewritten.
 *
 * The first version asserted that NO load-path response contains the string
 * `"description"` or any body text at all. That is stronger than the product
 * allows: the tile renders about four lines of body, capped at
 * DESC_RENDER_CAP, and a board whose tiles are blank is a regression the
 * #209(d) render-cap tests catch by name ("no description box on card #2").
 * So the projection carries `descriptionExcerpt` — a CAP, under its own key,
 * with `description` still absent so the editor cannot mistake it for a body.
 *
 * ⇒ The condition was never "no bytes of any body" — it is "the board no
 * longer transfers card DESCRIPTIONS", i.e. no FULL body crosses the wire to
 * draw a list. The assertions below now test that, and they are STRICTER
 * where it counts: both markers are placed PAST the cap, so a response
 * carrying either one is carrying body text it had no need for. A fixture
 * whose body fits inside the cap could not tell a projection from a payload.
 */
const FILLER = 'filler that the tile may legitimately preview. '.repeat(30); // ~1,350 chars, well past any cap
const bodyFor = (shortId) => [
  `Body of card ${shortId}. This text is the 85% of the payload the board`,
  'downloads on every load to render a list of titles.',
  FILLER,
  shortId === 7 ? BODY_ONLY : 'ordinary filler that no search will ask for',
  'x'.repeat(400),
  shortId === 7 ? BODY_TAIL : 'end',
].join('\n');

function card(shortId, { column = 'backlog' } = {}) {
  return {
    id: `card-${shortId}`,
    shortId,
    title: `Card ${shortId}`,
    description: bodyFor(shortId),
    type: 'task',
    assignees: [], labels: [], for: '', priority: null, column, order: shortId,
    createdAt: ts, updatedAt: FRESH,
    relationships: { relatedTo: [], blockedBy: [] },
    version: 3,
  };
}

/**
 * 501 cards — ONE past `/api/cards`'s 500-row cap, which is the whole point.
 * A fixture of 500 or fewer passes a single-call implementation and would
 * certify exactly the defect condition 5 names.
 */
const CARD_COUNT = 501;
const board = () => makeBoardFixture({
  cards: Array.from({ length: CARD_COUNT }, (_, i) => card(i + 1)),
  nextShortId: CARD_COUNT + 1,
});

/** Every shortId the board has drawn, as the DOM holds it. */
const renderedShortIds = (page) => page.evaluate(() => [...document.querySelectorAll('.card')]
  .map((c) => c.querySelector('.card-shortid')?.textContent.trim())
  .filter(Boolean));

const gotoBoard = async (browser, server) => {
  const page = await browser.newPage();
  await page.setViewport({ width: 1442, height: 900 });
  return page;
};

test('#209 cond 5 — the board draws EVERY card, not the first page of them', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await gotoBoard(browser, server);
    await page.goto(server.baseUrl + '/', { waitUntil: 'networkidle0' });
    await page.waitForSelector('.card', { timeout: 8000 });

    const ids = await renderedShortIds(page);
    const distinct = new Set(ids);

    // The server's own count — never a literal, so this keeps meaning the same
    // thing if the fixture grows.
    const { cardsTotal } = await (await fetch(`${server.baseUrl}/api/board/status`)).json();
    assert.equal(cardsTotal, CARD_COUNT, 'fixture precondition: the board holds 501 cards');

    // ⇒ COVERAGE, not "it returned rows". A single-call projection renders 500
    // of 501 here and every other assertion in this file still passes.
    assert.equal(
      distinct.size, cardsTotal,
      `drew ${distinct.size} of ${cardsTotal} cards — a partial board with no error and no empty state`,
    );
    assert.equal(ids.length, distinct.size, 'a card was drawn twice — a paging cursor that overlaps');

    // The boundary itself, named: 500 is where a single call stops.
    assert.ok(distinct.has('#501'), 'card #501 — the one past the 500-row cap — was not drawn');
  }, { server: { board: board() }, launch: { headless: 'new' } });
});

test('#209 cond 1 — no card body reaches the browser during a cold load', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await gotoBoard(browser, server);

    // Measured at the WIRE, from the browser's own responses — not argued from
    // which endpoint the code calls. An implementation that swaps the URL and
    // still receives bodies fails here.
    const bodies = [];
    page.on('response', async (res) => {
      const url = res.url();
      if (!url.startsWith(server.baseUrl)) return;
      if (!/\/api\//.test(url)) return;
      try { bodies.push({ url, text: await res.text() }); } catch { /* redirect/no body */ }
    });

    await page.goto(server.baseUrl + '/', { waitUntil: 'networkidle0' });
    await page.waitForSelector('.card', { timeout: 8000 });

    // Both markers sit PAST the render cap, so either one on the wire means a
    // response carried body text the list view cannot display.
    const carrying = bodies.filter((b) => b.text.includes(BODY_ONLY) || b.text.includes(BODY_TAIL));
    // `"description":` with the colon — `"descriptionExcerpt"` is the capped
    // preview the tile renders and is expected; the full-body key is not.
    const full = bodies.filter((b) => b.text.includes('"description":'));
    const total = bodies.reduce((n, b) => n + b.text.length, 0);

    assert.deepEqual(
      carrying.map((b) => b.url), [],
      `these load-path responses carry body text past the render cap: ${carrying.map((b) => b.url).join(', ')}`,
    );
    assert.deepEqual(
      full.map((b) => b.url), [],
      `these load-path responses carry a full \`description\` field: ${full.map((b) => b.url).join(', ')}`,
    );

    // An absolute bound, not "smaller than before". 501 cards x ~500-char
    // bodies is ~250 KB of description alone; a projection of 501 title-shaped
    // rows is well under 200 KB. A build that shaved 10% would pass a relative
    // assertion and fail this one.
    // The bound admits the capped preview (501 x up to ~600 chars) and nothing
    // like the full corpus: these fixture bodies total ~950 KB, and /api/load
    // would ship every byte of them.
    const FULL_CORPUS = CARD_COUNT * bodyFor(1).length;
    assert.ok(
      total < 500_000 && total < FULL_CORPUS / 2,
      `cold load transferred ${total} bytes across ${bodies.length} API responses (full corpus ~${FULL_CORPUS})`,
    );
  }, { server: { board: board() }, launch: { headless: 'new' } });
});

test('#209 cond 2 (live again) — opening a card still shows its WHOLE body', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await gotoBoard(browser, server);
    await page.goto(server.baseUrl + '/?card=7', { waitUntil: 'networkidle0' });

    // The pop-out may fetch the body lazily, so wait for the text rather than
    // asserting on the first paint — lazy-loading is the SANCTIONED remedy.
    await page.waitForFunction(
      (tail) => document.body.innerText.includes(tail),
      { timeout: 8000 },
      BODY_TAIL,
    );

    const shown = await page.evaluate(() => document.body.innerText);
    assert.ok(shown.includes(BODY_ONLY), 'the middle of the body is missing from the pop-out');
    assert.ok(shown.includes(BODY_TAIL), 'the END of the body is missing — the pop-out was truncated');
  }, { server: { board: board() }, launch: { headless: 'new' } });
});

test('#209 — searching text that exists ONLY in a body still finds the card', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await gotoBoard(browser, server);
    await page.goto(server.baseUrl + '/', { waitUntil: 'networkidle0' });
    await page.waitForSelector('.card', { timeout: 8000 });

    await page.click('#board-search-input');
    await page.keyboard.type(BODY_ONLY);
    await new Promise((r) => setTimeout(r, 400));

    const visible = await page.evaluate(() => [...document.querySelectorAll('.card')]
      .filter((c) => c.getBoundingClientRect().height > 0)
      .map((c) => c.querySelector('.card-shortid')?.textContent.trim()));

    // ⇒ THE COUPLING NOBODY WROTE DOWN. `cardMatchesSearchTerm` reads
    // `card.description` from the MODEL. Hydrate without bodies and this
    // returns [] — no error, no empty state, a search box that has quietly
    // stopped answering the question it appears to answer.
    assert.deepEqual(
      visible, ['#7'],
      'a search for body-only text must still find #7 — description search is part of the product',
    );
  }, { server: { board: board() }, launch: { headless: 'new' } });
});

test('#209 cond 3 — a save made from a projection-hydrated board must not blank a body', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await gotoBoard(browser, server);
    await page.goto(server.baseUrl + '/', { waitUntil: 'networkidle0' });
    await page.waitForSelector('.card', { timeout: 8000 });

    // Drive a REAL save through the page's own path, the way any edit does.
    // Renaming a column touches no card and saves the whole board — which is
    // precisely the shape that erases bodies: nothing about a card changed,
    // and every card is rewritten from what the client happens to hold.
    const saved = await page.evaluate(async () => {
      columnNames.backlog = 'Backlog renamed by the test';
      return saveToJSONFile();
    });
    assert.ok(saved !== false, 'the board could not save — the test never reached its subject');

    // Read back from the SERVER, not from the page's own copy. The page
    // believing the body is fine is the failure mode, not the evidence.
    const after = await (await fetch(`${server.baseUrl}/api/cards/7`)).json();
    assert.equal(
      after.description, bodyFor(7),
      'the stored body changed after a save that touched no card',
    );

    // The specific failure #1039 cannot catch: a client that sends '' rather
    // than omitting the key. '' is a REAL CLEAR under the server's rule, so it
    // passes every server-side guard and destroys the body anyway.
    assert.notEqual(after.description, '', 'the body was CLEARED — the client sent an empty string');

    // ⇒ AND THE STORE MUST NOT HAVE LEARNED THE PROJECTION'S OWN FIELDS.
    //
    // Review asked for a tripwire on the SAVE path rather than only on the
    // projection, on the grounds that the excerpt key is only safe while
    // nothing treats it as a body. That was right, and the leak turned out to
    // be one layer earlier: /api/save merges the client's card array wholesale,
    // so an unstripped `descriptionExcerpt` becomes DURABLE STATE on every
    // card at the first save — a cap living in the store, one rename away from
    // being read as a body.
    const all = await (await fetch(`${server.baseUrl}/api/load`)).json();
    const storedKeys = new Set();
    for (const c of all.cards) for (const k of Object.keys(c)) storedKeys.add(k);
    assert.equal(storedKeys.has('descriptionExcerpt'), false,
      'the store learned `descriptionExcerpt` — a derived cap is now durable state');
    assert.equal(storedKeys.has('legacyArrayIndex'), false,
      'the store learned `legacyArrayIndex` — a shim became data');

    // And the whole board, not just the card we looked at: one intact body is
    // not evidence that 501 survived.
    const blank = all.cards.filter((c) => !c.description);
    assert.deepEqual(
      blank.map((c) => c.shortId), [],
      `${blank.length} of ${all.cards.length} bodies are empty after one save`,
    );
  }, { server: { board: board() }, launch: { headless: 'new' } });
});
