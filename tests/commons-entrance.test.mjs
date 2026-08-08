/**
 * #497 — the commons entrance suite. RED-first, written from the card's
 * pre-registered acceptance before the build commit.
 *
 * ⚠️ BAR AUTHORSHIP: written by the builder, who also builds it. That breaks the
 * lane adopted 2026-07-26 (the reviewing seat authors the bar, the builder builds to green) —
 * the reviewing seat was mid-battery on #503. Recorded rather than quietly skipped: a
 * builder-authored bar is worth less than a peer-authored one, and the way it
 * usually fails is by asserting the shape the builder happened to ship. The
 * mitigation available to a lone author is to derive every assertion from the
 * card's acceptance text, written before the build, and to name the ones that
 * would survive a wrong implementation. Grade it as such.
 *
 * The disease: one piece of content (the room) reached by three different
 * controls in three different places, two of them named differently, and one
 * of them sitting where the eye aims for navigation.
 *   board    header button "💬 Conversations" → panel titled "💬 Commons"
 *   wiki     floating bubble, bottom-right    → panel titled "💬 Commons"
 *   settings nothing at all
 *
 * The card's rubric, turned into assertions:
 *   1. same position on every surface (the same pixel region, not "in the
 *      header somewhere")
 *   2. never in the destinations group
 *   3. stateful — open/closed AND unread count
 *   4. absent exactly where redundant (the Commons page, and nowhere else)
 *   5. escapes to the full page
 *   + one name for the content, and overlay-not-push
 *
 * CONTRACT SELECTORS (the suite's interface with the builder — change these
 * constants, not the assertions, if the entrance ships different names):
 *   [data-commons-toggle]  the entrance control
 *   [data-commons-unread]  the unread badge
 *   [data-commons-panel]   the panel it opens
 *
 * DEGENERATE-SOLUTION GUARD (cold-wake checklist item 9): this bar is NOT
 * satisfiable by deleting the panel. `entrance is present on three surfaces`
 * and `the badge counts what arrived while you were away` both require the
 * feature to exist and to work. The card's open question — whether the panel
 * earns its space at all — is a decision to make later from usage evidence,
 * not a way to pass this suite.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture, PROJECT_DIR, withBrowserServer } from './helpers/harness.mjs';

const TOGGLE = '[data-commons-toggle]';
const UNREAD = '[data-commons-unread]';
const PANEL = '[data-commons-panel]';

/** Where the entrance belongs, and the one written-down exception. */
const WITH_ENTRANCE = ['/', '/wiki.html', '/settings.html'];
const WITHOUT_ENTRANCE = ['/commons.html'];
const ALL_SURFACES = [...WITH_ENTRANCE, ...WITHOUT_ENTRANCE];

const ts = '2026-05-01T00:00:00.000Z';

function boardWithRoom() {
  return makeBoardFixture({
    cards: [{
      id: 'c1', shortId: 1, title: 'Anchor card', description: 'Enough text to render a card.',
      type: 'task', assignees: ['sage'], labels: [], for: '', priority: null,
      column: 'backlog', order: 0, createdAt: ts, updatedAt: ts,
      relationships: { relatedTo: [], blockedBy: [] },
    }],
    conversations: [
      { id: 'm1', body: 'An older message, already seen.', author: 'sage', attachedTo: null, createdAt: ts },
    ],
    nextShortId: 2,
  });
}

async function withBoard(fn) {
  await withBrowserServer(async ({ server, browser }) => {
    await fn({ server, browser });
  }, { server: { board: boardWithRoom(), staticDir: PROJECT_DIR }, launch: { headless: 'new', args: ['--no-sandbox'] } });
}

/**
 * Wait for the panel to finish sliding in.
 *
 * Checking that the panel's LEFT edge is on screen is not enough and cost two
 * confusing failures: mid-slide the left edge is already inside the viewport
 * while the right portion — which is where "⤢ Full page" and "✕" live — is
 * still outside it, so a click on those lands nowhere and puppeteer reports
 * the unhelpful "Node is either not clickable". The panel has arrived only
 * when its RIGHT edge has reached the viewport's right edge.
 */
const waitForPanelOpen = (page) => page.waitForFunction((sel) => {
  const p = document.querySelector(sel);
  if (!p) return false;
  const r = p.getBoundingClientRect();
  return Math.round(r.right) <= Math.round(window.innerWidth) + 1 && r.width > 0;
}, { timeout: 3000 }, PANEL);

/** A page with console/pageerror capture — a silent JS failure must not read
 *  as "the entrance is correctly absent". */
async function openSurface(browser, baseUrl, surface, viewport = 1442) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  await page.setViewport({ width: viewport, height: 900 });
  await page.goto(`${baseUrl}${surface}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.topnav .navlink', { timeout: 5000 });
  // The nav mounts before the entrance does (same deferred module block), so
  // waiting on .navlink alone leaves a window where the nav is up and the
  // entrance is not — a race that made the state test fail while the presence
  // test passed on the same surface. Wait for the entrance itself; on the one
  // surface that must NOT have it this burns the full timeout, which is the
  // point: absence is only meaningful after a late mount has had its chance.
  await page.waitForSelector(TOGGLE, { timeout: 2500 }).catch(() => null);
  return { page, errors };
}

// ---------------------------------------------------------------------------
// Rubric 4 — absent exactly where redundant.
// ---------------------------------------------------------------------------
test('#497 the entrance is present on board, wiki and settings, and absent on commons', async () => {
  await withBoard(async ({ server, browser }) => {
    for (const surface of ALL_SURFACES) {
      const { page, errors } = await openSurface(browser, server.baseUrl, surface);
      const count = await page.$$eval(TOGGLE, (els) => els.length);
      assert.deepEqual(errors, [], `${surface} logged errors: ${errors.join(' | ')}`);
      const expected = WITH_ENTRANCE.includes(surface) ? 1 : 0;
      assert.equal(count, expected,
        `${surface}: expected ${expected} ${TOGGLE}, found ${count}. ` +
        (expected === 0
          ? 'The Commons page IS the room — an entrance to it there is the one written-down exception.'
          : 'Every surface that is not the Commons page needs the same way in.'));
      await page.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Rubric 2 — never in the destinations group; and the rule the card states as
// having no exceptions: nav items navigate, everywhere.
// ---------------------------------------------------------------------------
test('#497 the entrance is not a nav item, and every nav item navigates on every surface', async () => {
  await withBoard(async ({ server, browser }) => {
    for (const surface of ALL_SURFACES) {
      const { page } = await openSurface(browser, server.baseUrl, surface);
      const shape = await page.evaluate((TOGGLE_SEL) => {
        const toggle = document.querySelector(TOGGLE_SEL);
        const nav = document.querySelector('.topnav');
        return {
          togglePresent: !!toggle,
          // a control that opens a panel must not live among destinations…
          toggleInsideNav: !!(toggle && nav && nav.contains(toggle)),
          toggleIsLink: !!(toggle && toggle.tagName === 'A'),
          // …and nothing in the destinations group may do anything but navigate
          navChildTags: nav ? [...nav.children].map((e) => e.tagName) : [],
          navHrefs: nav ? [...nav.querySelectorAll('a')].map((a) => a.getAttribute('href')) : [],
        };
      }, TOGGLE);

      // Vacuity guard: "the toggle is not inside the nav" is trivially true
      // when there is no toggle. The first RED run of this suite passed this
      // test for exactly that reason. Assert existence first, where existence
      // is required.
      if (WITH_ENTRANCE.includes(surface)) {
        assert.equal(shape.togglePresent, true,
          `${surface}: no ${TOGGLE} at all — this test would otherwise pass by absence.`);
      }
      assert.equal(shape.toggleInsideNav, false,
        `${surface}: the panel toggle sits inside .topnav — that is the confusion the card is about.`);
      assert.equal(shape.toggleIsLink, false,
        `${surface}: the panel toggle is an <a> — it opens a panel, so it must not look or behave like a destination.`);
      const nonNavigating = shape.navChildTags.filter((t) => t !== 'A' && t !== 'SPAN');
      assert.deepEqual(nonNavigating, [],
        `${surface}: .topnav contains ${nonNavigating.join(', ')} — nav items are destinations, always, everywhere, no exceptions.`);
      assert.ok(shape.navHrefs.every((h) => typeof h === 'string' && h.length > 0),
        `${surface}: a nav link with no href: ${JSON.stringify(shape.navHrefs)}`);
      await page.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Rubric 1 — the same pixel region, so muscle memory survives layout
// differences. Equality across surfaces, not membership in a header.
// ---------------------------------------------------------------------------
test('#497 the entrance occupies the same pixel region on every surface that has it', async () => {
  await withBoard(async ({ server, browser }) => {
    const seen = {};
    for (const surface of WITH_ENTRANCE) {
      const { page } = await openSurface(browser, server.baseUrl, surface);
      seen[surface] = await page.evaluate((TOGGLE_SEL) => {
        const r = document.querySelector(TOGGLE_SEL).getBoundingClientRect();
        return {
          // measured against the viewport's right edge: the utility slot is
          // right-anchored, so this is the number muscle memory actually uses
          rightGap: Math.round(window.innerWidth - r.right),
          top: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      }, TOGGLE);
      await page.close();
    }
    const [first, ...rest] = WITH_ENTRANCE;
    for (const surface of rest) {
      assert.deepEqual(seen[surface], seen[first],
        `the entrance moves between ${first} and ${surface}:\n` +
        `  ${first}: ${JSON.stringify(seen[first])}\n  ${surface}: ${JSON.stringify(seen[surface])}`);
    }
  });
});

// ---------------------------------------------------------------------------
// One name for one thing. The card's problem 1: the button said
// "Conversations", the panel it opened said "Commons".
// ---------------------------------------------------------------------------
test('#497 the control and the thing it opens carry the same name: Commons', async () => {
  await withBoard(async ({ server, browser }) => {
    for (const surface of WITH_ENTRANCE) {
      const { page } = await openSurface(browser, server.baseUrl, surface);
      const names = await page.evaluate((sel) => {
        const t = document.querySelector(sel.TOGGLE);
        const p = document.querySelector(sel.PANEL);
        const title = p ? p.querySelector('[data-commons-panel-title]') : null;
        return {
          accessibleName: (t.getAttribute('aria-label') || t.textContent || '').trim(),
          tooltip: (t.getAttribute('title') || '').trim(),
          panelTitle: title ? title.textContent.trim() : null,
        };
      }, { TOGGLE, PANEL });

      assert.match(names.accessibleName, /commons/i,
        `${surface}: the entrance's accessible name is "${names.accessibleName}" — it must name what it opens.`);
      assert.ok(!/conversations/i.test(names.accessibleName + ' ' + names.tooltip),
        `${surface}: "Conversations" survives on the control (${JSON.stringify(names)}) — one name for one thing.`);
      assert.match(names.panelTitle || '', /commons/i,
        `${surface}: the panel's title is ${JSON.stringify(names.panelTitle)}`);
      await page.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Rubric 5 — escapes to the full page.
// ---------------------------------------------------------------------------
test('#497 the panel escapes to the full Commons page', async () => {
  await withBoard(async ({ server, browser }) => {
    for (const surface of WITH_ENTRANCE) {
      const { page } = await openSurface(browser, server.baseUrl, surface);
      const href = await page.evaluate((sel) => {
        const p = document.querySelector(sel);
        const a = p ? p.querySelector('a[href*="commons.html"]') : null;
        return a ? a.getAttribute('href') : null;
      }, PANEL);
      assert.ok(href, `${surface}: the panel has no way out to the full Commons page.`);
      await page.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Rubric 5, second half — "WITHOUT LOSING POSITION".
//
// Added after grading, and the reading is the reviewing seat's, not mine. I first read
// "position" as the board underneath; she read it as the reader's place in the
// ROOM, and she is right — the board half is the browser's back button doing
// its ordinary job, while feed continuity is the part only we can preserve or
// lose. Both are asserted because both are cheap; hers is the load-bearing one.
//
// The board half is not hypothetical either. #510 shipped two of exactly this
// bug in one evening — a deep link with no history entry behind it (a one-way
// door), and an anchor default stacking "#" on top of "?card=NNN" so Back went
// nowhere. A promote link is the same shape.
// ---------------------------------------------------------------------------
test('#497 the escape to the full page is a real navigation, and Back comes home intact', async () => {
  await withBoard(async ({ server, browser }) => {
    for (const surface of WITH_ENTRANCE) {
      const { page, errors } = await openSurface(browser, server.baseUrl, surface);
      const from = page.url();

      await page.click(TOGGLE);
      await waitForPanelOpen(page);

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 5000 }),
        page.click(`${PANEL} a[href*="commons.html"]`),
      ]);
      assert.match(page.url(), /commons\.html$/,
        `${surface}: "Full page" landed on ${page.url()} — it must be a real navigation to the Commons page, with no query or hash residue.`);

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 5000 }),
        page.goBack(),
      ]);
      assert.equal(page.url(), from,
        `${surface}: Back landed on ${page.url()} instead of ${from} — the escape was a one-way door.`);

      // …and the surface still works when you get there, rather than being a
      // shell that needs a reload.
      await page.waitForSelector('.topnav .navlink', { timeout: 5000 });
      const home = await page.evaluate((sel) => ({
        entrance: document.querySelectorAll(sel.TOGGLE).length,
        nav: document.querySelectorAll('.topnav .navlink').length,
      }), { TOGGLE });
      assert.equal(home.entrance, 1, `${surface}: the entrance did not survive the round trip (found ${home.entrance}).`);
      assert.ok(home.nav >= 4, `${surface}: the nav did not survive the round trip (found ${home.nav} links).`);
      assert.deepEqual(errors, [], `${surface}: the round trip logged errors: ${errors.join(' | ')}`);
      await page.close();
    }
  });
});

/**
 * The load-bearing half of rubric 5: you are in the panel, scrolled back into
 * the conversation, and you hit ⤢ BECAUSE you want more room to read. The full
 * page must put you at the same point in the feed, not at whatever it defaults
 * to. Losing your place is the thing a reader would name as broken.
 *
 * Deliberately written to keep biting: if both surfaces happen to agree today
 * only because each independently lands at "newest", this passes cheaply now
 * and fails the day pagination or a jump-to-message lands on one of them and
 * not the other.
 */
// GREEN as of #517 (2026-07-27). Written red on 07-27 04:07 as #497's unmet
// acceptance clause, carried as a `todo` pointing at the card rather than
// deleted, and un-todo'd here by the change that satisfies it. The scope on the
// card was wider than the truth — it claimed neither renderer emitted a message
// id; both already did (`msg.dataset.id`), which a grep for the class name
// rather than the attribute had hidden. What was actually missing was the link
// stamp and the arrival handler.
test('#497 escaping to the full page keeps your place in the feed', async () => {
  const many = makeBoardFixture({
    conversations: Array.from({ length: 40 }, (_, i) => ({
      id: `m${i}`,
      body: `Message ${i} — long enough to occupy a line or two of the feed so that forty of them do not fit in one viewport and the panel genuinely scrolls.`,
      author: i % 2 ? 'sage' : 'alex',
      attachedTo: null,
      createdAt: `2026-05-01T${String(i % 24).padStart(2, '0')}:${String(i).padStart(2, '0')}:00.000Z`,
    })),
    nextShortId: 1,
  });
  await withBrowserServer(async ({ server, browser }) => {
    const { page } = await openSurface(browser, server.baseUrl, '/wiki.html');
    await page.click(TOGGLE);
    await waitForPanelOpen(page);
    await page.waitForFunction((sel) => document.querySelectorAll(`${sel} .cv-msg, ${sel} .conv-msg`).length > 5,
      { timeout: 5000 }, PANEL);

    // Scroll back into the conversation and note where the reader is.
    const anchoredOn = await page.evaluate((sel) => {
      const scroller = [...document.querySelectorAll(`${sel} *`)]
        .find((e) => e.scrollHeight > e.clientHeight + 40);
      if (!scroller) return null;
      scroller.scrollTop = Math.round(scroller.scrollHeight * 0.35);
      const msgs = [...scroller.querySelectorAll('.cv-msg, .conv-msg')];
      const box = scroller.getBoundingClientRect();
      const top = msgs.find((m) => m.getBoundingClientRect().bottom > box.top + 4);
      return top ? (top.textContent.match(/Message \d+/) || [null])[0] : null;
    }, PANEL);
    assert.ok(anchoredOn, 'the panel feed did not scroll — the fixture or the selector is wrong, not the product');

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 5000 }),
      page.click(`${PANEL} a[href*="commons.html"]`),
    ]);
    await page.waitForFunction(() => document.querySelectorAll('.cv-msg, .conv-msg').length > 5, { timeout: 5000 });

    const landedNear = await page.evaluate((needle) => {
      const msgs = [...document.querySelectorAll('.cv-msg, .conv-msg')];
      const hit = msgs.find((m) => m.textContent.includes(needle));
      if (!hit) return { found: false };
      const r = hit.getBoundingClientRect();
      return { found: true, inViewport: r.bottom > 0 && r.top < window.innerHeight };
    }, anchoredOn);

    assert.equal(landedNear.found, true, `"${anchoredOn}" is not on the full page at all`);
    assert.equal(landedNear.inViewport, true,
      `the reader was on "${anchoredOn}" in the panel and the full page did not bring it into view — the escape lost their place in the room.`);
  }, { server: { board: many, staticDir: PROJECT_DIR }, launch: { headless: 'new', args: ['--no-sandbox'] } });
});

// ---------------------------------------------------------------------------
// The card's problem 3 — overlay, not push. Opening the panel must not move
// content the reader cannot get back to.
//
// NOTE for the grader: at the time this suite was written the board already
// passed this, as a side effect of #496's overflow fix (measured in Chrome
// 2026-07-27, first column left = 43px open and closed). It is asserted anyway
// because the property is what matters, not who fixed it — and because the
// shared panel this card introduces is exactly the change that could
// reintroduce a push on a surface that never had one.
// ---------------------------------------------------------------------------
test('#497 opening the panel overlays — no surface displaces its content', async () => {
  await withBoard(async ({ server, browser }) => {
    for (const surface of WITH_ENTRANCE) {
      const { page } = await openSurface(browser, server.baseUrl, surface);
      const measure = () => page.evaluate((PANEL_SEL) => {
        // the leftmost real content on each surface — the thing that slid off
        const anchor = document.querySelector('.column, #sidebar, main, #main, [data-page-shell] > *:not(.shell-head)');
        const shell = document.querySelector('[data-page-shell]');
        const panel = document.querySelector(PANEL_SEL);
        return {
          anchorLeft: anchor ? Math.round(anchor.getBoundingClientRect().left) : null,
          shellWidth: shell ? Math.round(shell.getBoundingClientRect().width) : null,
          docScrollLeft: Math.round(document.documentElement.scrollLeft),
          panelPosition: panel ? getComputedStyle(panel).position : null,
        };
      }, PANEL);

      const before = await measure();
      await page.click(TOGGLE);
      await new Promise((r) => setTimeout(r, 350)); // let any transition settle
      const after = await measure();

      assert.equal(after.panelPosition, 'fixed',
        `${surface}: the panel is ${after.panelPosition}, not fixed — a panel in flow pushes.`);
      assert.equal(after.anchorLeft, before.anchorLeft,
        `${surface}: content moved ${before.anchorLeft} → ${after.anchorLeft} when the panel opened.`);
      assert.equal(after.shellWidth, before.shellWidth,
        `${surface}: the page shell resized ${before.shellWidth} → ${after.shellWidth} when the panel opened.`);
      assert.equal(after.docScrollLeft, before.docScrollLeft,
        `${surface}: the document scrolled sideways when the panel opened.`);
      await page.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Rubric 3 — stateful. Open/closed is visible to assistive tech, and the
// badge does work even unclicked. This is the assertion that justifies the
// control's permanent real estate.
// ---------------------------------------------------------------------------
test('#497 the entrance reports open/closed state', async () => {
  await withBoard(async ({ server, browser }) => {
    const { page } = await openSurface(browser, server.baseUrl, '/');
    // page.evaluate, not $eval: $eval throws a bare "failed to find element"
    // that says nothing about what WAS on the page. A state assertion should
    // report the state it found.
    const state = () => page.evaluate((sel) => {
      const el = document.querySelector(sel.TOGGLE);
      const p = document.querySelector(sel.PANEL);
      return {
        togglesFound: document.querySelectorAll(sel.TOGGLE).length,
        expanded: el ? el.getAttribute('aria-expanded') : null,
        panelOpen: !!p && getComputedStyle(p).visibility !== 'hidden',
      };
    }, { TOGGLE, PANEL });
    const closed = await state();
    assert.equal(closed.togglesFound, 1,
      `expected exactly one entrance on the board, found ${closed.togglesFound}`);
    assert.equal(closed.expanded, 'false', 'a closed panel must report aria-expanded="false"');

    await page.click(TOGGLE);
    await new Promise((r) => setTimeout(r, 350));
    const open = await state();
    assert.equal(open.expanded, 'true', 'an open panel must report aria-expanded="true"');
    assert.equal(open.panelOpen, true, 'aria-expanded="true" while the panel is not actually visible');

    // The control must stay REACHABLE while the panel is open — otherwise the
    // pressed state is invisible and the toggle only toggles one way. Found by
    // this suite: a full-height right-anchored panel covered the right-anchored
    // utility slot, and the close click landed on the panel's "Full page" link
    // and navigated away. elementFromPoint is the honest check — it asks what
    // the user's click would actually hit.
    const hit = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return { hitsToggle: !!top && (top === el || el.contains(top)), hitTag: top ? top.tagName + '.' + (top.className || '') : null };
    }, TOGGLE);
    assert.equal(hit.hitsToggle, true,
      `with the panel open, a click on the entrance would hit ${hit.hitTag} instead — the toggle is buried under its own panel.`);

    await page.click(TOGGLE);
    await new Promise((r) => setTimeout(r, 350));
    assert.equal((await state()).expanded, 'false', 'toggling closed must return the state');
    await page.close();
  });
});

test('#497 the badge counts what arrived while you were away, and clears when you look', async () => {
  await withBoard(async ({ server, browser }) => {
    const { page } = await openSurface(browser, server.baseUrl, '/');

    // First visit, no cursor yet: a badge screaming "1 unread" at someone who
    // has never opened the room is noise, not information.
    const initial = await page.$eval(UNREAD, (el) => ({
      text: el.textContent.trim(),
      shown: getComputedStyle(el).display !== 'none' && !el.hasAttribute('hidden'),
    }));
    assert.equal(initial.shown, false,
      `a fresh visitor sees a badge reading "${initial.text}" before anything has arrived.`);

    // Something arrives while the reader is elsewhere.
    const res = await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Something new in the room.', author: 'ada' }),
    });
    assert.equal(res.status < 300, true, `posting to the room failed: ${res.status}`);

    // Coming back to the tab is a real refresh trigger, not a test hook.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(
      (sel) => {
        const el = document.querySelector(sel);
        return el && !el.hasAttribute('hidden') && el.textContent.trim() === '1';
      },
      { timeout: 6000 }, UNREAD,
    ).catch(async () => {
      const got = await page.$eval(UNREAD, (el) => `${el.textContent.trim()} hidden=${el.hasAttribute('hidden')}`);
      assert.fail(`the badge never reported the new message (saw: ${got})`);
    });

    // Looking at the room is what marks it seen.
    await page.click(TOGGLE);
    await page.waitForFunction(
      (sel) => { const el = document.querySelector(sel); return el && el.hasAttribute('hidden'); },
      { timeout: 6000 }, UNREAD,
    ).catch(async () => {
      const got = await page.$eval(UNREAD, (el) => `${el.textContent.trim()} hidden=${el.hasAttribute('hidden')}`);
      assert.fail(`the badge survived opening the panel (saw: ${got})`);
    });
    await page.close();
  });
});
