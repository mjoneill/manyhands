/**
 * #1025 — a save gave no feedback, so the only human who uses this board could
 * not tell whether it had worked.
 *
 *   "another second or two to save the card (long enough for me to not be sure
 *    if it was going to save or not)"
 *
 * ⛔ THE DEFECT WAS NEVER THE LATENCY. `saveToJSONFile` already computed
 * `response.ok` correctly on both the HTTP and the network-failure path, and
 * returned it — and all eleven call sites called it bare. The success signal
 * was DEAD CODE. A 90ms save with no indicator has the same defect, smaller,
 * so making it faster would have hidden this rather than fixed it.
 *
 * ⚠️ AND THE SILENCE HAS A COST BEYOND CONFUSION. The reasonable human response
 * to "did that work?" is to click again — and `saveToJSONFile` POSTs the WHOLE
 * BOARD. A second click during an in-flight save is a second whole-board write
 * from the same snapshot, which is #237/#534's clobber path reached by a user
 * doing the obvious thing.
 *
 * ⇒ These tests assert on the WIRE and on what is VISIBLE, never on internal
 *   state. Acceptance is explicit that a disabled-LOOKING button that still
 *   fires would be this card's own defect in a new place, so the double-save
 *   control counts actual HTTP requests rather than inspecting the DOM.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withBrowserServer } from './helpers/harness.mjs';

const ts = '2026-05-01T00:00:00.000Z';
const board = {
  cards: [{
    id: 'c1', shortId: 1, title: 'A card', description: '', type: 'task',
    assignees: ['sage'], labels: [], for: '', priority: null, column: 'backlog',
    order: 0, createdAt: ts, updatedAt: ts, relationships: { relatedTo: [], blockedBy: [] },
  }],
  columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
  conversations: [],
  nextShortId: 2,
};

/** Count real POSTs to the save endpoint. The wire, not the widget. */
const countSaves = (page) => {
  const seen = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/api\/save/.test(r.url())) seen.push(r.url());
  });
  return seen;
};

const openBoard = async (server, browser) => {
  const page = await browser.newPage();
  await page.goto(`${server.baseUrl}/`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => typeof window.saveToJSONFile === 'function', { timeout: 8000 });
  return page;
};

test('#1025 ⛔ two saves of an UNCHANGED board produce ONE whole-board write', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await openBoard(server, browser);
    const saves = countSaves(page);

    // ⭐ ANTI-VACUITY FIRST: one save must produce exactly one POST. Without
    // this, a guard that suppressed EVERYTHING would pass the real assertion
    // below — "no second write" and "no writes at all" are the same number.
    await page.evaluate(() => window.saveToJSONFile());
    assert.equal(saves.length, 1, 'precondition: a single save writes exactly once');

    // The defect: the user clicks again because nothing told them anything.
    await page.evaluate(() => Promise.all([window.saveToJSONFile(), window.saveToJSONFile()]));
    assert.equal(saves.length, 2,
      `a second click during an in-flight save must not post the whole board again — `
      + `expected 2 total (1 precondition + 1 coalesced), got ${saves.length}`);
  }, { server: { board }, launch: { headless: 'new' } });
});

test('#1025 ⭐ THE CONTROL — a board that genuinely CHANGED mid-flight is still written', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await openBoard(server, browser);
    const saves = countSaves(page);

    // ⛔ THE ASSERTION THAT KEEPS THE FIX HONEST. Blindly returning the
    // in-flight promise would pass the test above and SILENTLY DROP this
    // edit — trading a visible double-write for invisible data loss, which
    // is the same defect wearing the remedy's clothes.
    const TITLE = 'changed while the first save was on the wire';
    // Drive the REAL path: addCard mutates the board and fires its own save,
    // which is exactly the sequence a person produces by editing during a save.
    await page.evaluate((t) => {
      window.saveToJSONFile();
      window.addCard(t, '', 'task', 'sage', [], 'backlog', null);
      return null;
    }, TITLE);

    // Verify AT THE BENEFICIARY — the server, not the page's own belief.
    const deadline = Date.now() + 8000;
    let stored = null;
    while (Date.now() < deadline) {
      const r = await fetch(`${server.baseUrl}/api/cards?limit=50`);
      const body = await r.json();
      stored = (body.cards || []).find((c) => c.title === TITLE);
      if (stored) break;
      await new Promise((res) => setTimeout(res, 120));
    }
    assert.ok(stored, 'the edit made during an in-flight save must reach the server, not be swallowed by the guard');
    assert.equal(saves.length, 2, `a real change must be its own write, got ${saves.length}`);
  }, { server: { board }, launch: { headless: 'new' } });
});

test('#1025 a FAILED save is visible on screen, without devtools', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await openBoard(server, browser);

    // The network-failure path: today its only trace is a console.warn.
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/api\/save/.test(r.url())) r.abort().catch(() => {});
      else r.continue().catch(() => {});
    });

    await page.evaluate(() => window.saveToJSONFile().catch(() => {}));
    await page.waitForFunction(
      () => document.querySelector('.save-status[data-state="failed"][data-shown="1"]'),
      { timeout: 6000 },
    );
    const text = await page.$eval('.save-status', (e) => e.textContent);
    assert.match(text, /not saved/i, `the failure must say so in words. Got: ${text}`);
    assert.match(text, /still on screen/i,
      'it must tell the user their edit is not lost — otherwise the remedy is a guess');
  }, { server: { board }, launch: { headless: 'new' } });
});

test('#1025 ⭐ NEGATIVE CONTROL — a successful save does not nag, and a FAST one never says "Saving…"', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await openBoard(server, browser);

    // ⚠️ "Reports failure" must not become "reports constantly". The room has
    // shipped that trade twice through disclosure features.
    const sawSaving = await page.evaluate(async () => {
      let seen = false;
      const obs = new MutationObserver(() => {
        const el = document.querySelector('.save-status');
        if (el && el.dataset.state === 'saving' && el.dataset.shown === '1') seen = true;
      });
      obs.observe(document.body, { subtree: true, childList: true, attributes: true });
      await window.saveToJSONFile();
      obs.disconnect();
      return seen;
    });
    assert.equal(sawSaving, false,
      'a local save completes well under the announce threshold — flashing a '
      + 'spinner would make a fast write FEEL slower than it is');

    // Success acknowledges, then leaves. Only failure persists.
    await page.waitForFunction(
      () => document.querySelector('.save-status[data-state="saved"][data-shown="1"]'),
      { timeout: 6000 },
    );
    await page.waitForFunction(
      () => document.querySelector('.save-status[data-shown="0"]'),
      { timeout: 6000 },
    );
  }, { server: { board }, launch: { headless: 'new' } });
});
