/**
 * #1583 — #118 Slice 1: the board's card ADD and card EDIT go through the
 * granular API, not the whole-board save.
 *
 * Before this slice every browser change persisted through `POST /api/save`:
 * the whole board, no write lock, a client-allocated shortId, and the server
 * taking the client's `nextShortId`. These tests drive the REAL UI against a
 * REAL server and assert on the WIRE (which requests went out) and at the
 * BENEFICIARY (what the server stored), never on the page's own belief.
 *
 *   add   → exactly one POST /api/cards, no /api/save; the shortId on screen is
 *           the one the SERVER allocated, even when the tab's own counter is
 *           stale; every form field lands; the card takes an end-of-column
 *           order (no duplicate (column, order) pair) and renders last.
 *   edit  → PATCH /api/cards/:id carrying ifVersion = the version the tab read;
 *           no /api/save; a second edit without reload also lands (the tab
 *           took the server's new version).
 *   409   → a seat edits the card after the tab loaded it; the browser edit is
 *           refused, says so on screen, the server keeps the seat's edit, and
 *           the user's exact draft (title AND description) is still in the
 *           editor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBoardFixture, withBrowserServer } from './helpers/harness.mjs';

const ts = '2026-09-01T00:00:00.000Z';
const card = (shortId, title, extra = {}) => ({
  id: `k${shortId}`, shortId, title, description: `body of ${shortId}`, type: 'task',
  column: 'backlog', order: shortId, assignees: ['unassigned'], labels: [], priority: null,
  for: '', createdAt: ts, updatedAt: ts, version: 1,
  relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [], supersededBy: [] },
  ...extra,
});

const fixture = () => makeBoardFixture({
  cards: [card(1, 'alpha'), card(2, 'beta'), card(3, 'gamma', { column: 'planned', order: 0 })],
  nextShortId: 4,
});

/** Every API write the page makes, in order: the wire, not the widget. */
const recordWrites = (page) => {
  const seen = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith('/api/')) return;
    if (r.method() === 'GET' || r.method() === 'HEAD') return;
    let body = null;
    try { body = JSON.parse(r.postData() || 'null'); } catch { body = r.postData(); }
    seen.push({ method: r.method(), path: u.pathname, body });
  });
  return seen;
};

const openBoard = async (browser, baseUrl) => {
  const page = await browser.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.card[data-id="k1"]', { timeout: 8000 });
  return page;
};

const setValue = (page, selector, text) => page.evaluate((sel, t) => {
  const el = document.querySelector(sel);
  if (!el) throw new Error('no element for ' + sel);
  el.value = t;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, selector, text);

// The add form animates open; a click that lands mid-transition hits whatever
// is on top (#1393's lesson). Click only once the button IS the top element.
async function clickWhenOnTop(page, selector) {
  await page.waitForFunction((sel) => {
    const b = document.querySelector(sel);
    if (!b) return false;
    b.scrollIntoView({ block: 'nearest' });
    const r = b.getBoundingClientRect();
    return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b;
  }, { timeout: 5000 }, selector);
  await page.click(selector);
}

const api = async (baseUrl, method, path, body) => {
  const r = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const until = async (fn, ms = 8000) => {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((res) => setTimeout(res, 100));
  }
  return last;
};

test('#1583 add: the form creates through POST /api/cards (never /api/save); the server allocates the shortId; every field lands; end-of-column order', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await openBoard(browser, server.baseUrl);
    const writes = recordWrites(page);

    // ⭐ THE STALE COUNTER. A seat creates a card AFTER the tab loaded, so the
    // tab's own nextShortId (4) is now wrong — the server's next is 5. A client
    // that allocates would show #4; only the server's answer can show #5.
    const seat = await api(server.baseUrl, 'POST', '/api/cards', { title: 'filed by a seat', by: 'bob', column: 'planned' });
    assert.equal(seat.status, 201);
    assert.equal(seat.body.shortId, 4, 'precondition: the seat took #4');

    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.click('#btn-expand-form');
    await page.waitForSelector('#add-card-form-wrapper.expanded', { timeout: 5000 });
    await page.waitForSelector('#card-title', { visible: true, timeout: 5000 });
    await page.evaluate(() => { const m = document.getElementById('card-more'); if (m) m.open = true; });
    await setValue(page, '#card-title', 'born in the browser');
    await setValue(page, '#card-desc', 'a description\nwith two lines');
    await page.select('#card-type', 'idea');
    await page.select('#card-priority', 'p2');
    await setValue(page, '#card-labels', 'one, two');
    await setValue(page, '#card-for', 'the reader');
    await setValue(page, '#card-supersedes', '#1');
    await setValue(page, '#card-blocked-by', '#2');
    await page.evaluate(() => {
      const box = document.querySelector('#card-assignees-group input[type="checkbox"]');
      box.checked = true;
      window.__assignee = box.value;
    });
    const assignee = await page.evaluate(() => window.__assignee);
    await clickWhenOnTop(page, '#btn-add-card');

    // The SERVER's record, by title.
    const stored = await until(async () => {
      const r = await api(server.baseUrl, 'GET', '/api/cards?limit=50');
      return (r.body.cards || []).find((c) => c.title === 'born in the browser');
    });
    if (!stored) {
      const status = await page.evaluate(() => document.querySelector('.save-status')?.textContent || '(no status)');
      assert.fail('the new card never reached the server. writes: '
        + JSON.stringify(writes.map((w) => `${w.method} ${w.path}`)) + ' · status line: ' + status + ' · page errors: ' + JSON.stringify(pageErrors));
    }
    assert.equal(stored.shortId, 5, 'the server allocated #5 (the tab\'s stale counter said #4)');

    // The tile on screen carries the SERVER's shortId, not the tab's guess.
    const shown = await until(() => page.evaluate(() => {
      const tile = [...document.querySelectorAll('.card')].find((c) => c.textContent.includes('born in the browser'));
      return tile ? tile.querySelector('.card-shortid')?.textContent.trim() : null;
    }).then((t) => (t === '#5' ? t : null)));
    assert.equal(shown, '#5', 'the shortId shown is the server\'s');
    const tileId = await page.evaluate(() => [...document.querySelectorAll('.card')]
      .find((c) => c.textContent.includes('born in the browser'))?.dataset.id);
    assert.equal(tileId, stored.id, 'the tile is keyed by the SERVER\'s id');

    // Every field the form offers landed.
    const full = (await api(server.baseUrl, 'GET', `/api/cards/${stored.id}`)).body;
    assert.equal(full.description, 'a description\nwith two lines');
    assert.equal(full.type, 'idea');
    assert.equal(full.priority, 'p2');
    assert.deepEqual(full.labels, ['one', 'two']);
    assert.equal(full.for, 'the reader');
    assert.equal(full.column, 'backlog');
    assert.deepEqual(full.assignees, [assignee]);
    assert.deepEqual(full.relationships.supersedes, [1]);
    assert.deepEqual(full.relationships.blockedBy, [2]);
    assert.equal(full.version, 1, 'born at version 1 by the server');
    const target = (await api(server.baseUrl, 'GET', '/api/cards/1')).body;
    assert.deepEqual(target.relationships.supersededBy, [5], 'the maintained inverse names the SERVER\'s shortId');

    // ORDER: end of its column, and no duplicate (column, order) pair.
    const all = (await api(server.baseUrl, 'GET', '/api/cards?limit=50&column=backlog')).body.cards;
    const others = all.filter((c) => c.id !== stored.id).map((c) => c.order);
    assert.ok(others.every((o) => o < full.order), `end-of-column order: ${full.order} vs ${JSON.stringify(others)}`);
    const tiles = await page.$$eval('#backlog-body .card', (els) => els.map((e) => e.dataset.id));
    assert.equal(tiles[tiles.length - 1], stored.id, 'and it renders LAST in its column: ' + tiles.join(','));

    // THE WIRE: one create, no whole-board save.
    assert.equal(writes.filter((w) => w.path === '/api/save').length, 0,
      'no /api/save: ' + JSON.stringify(writes.map((w) => `${w.method} ${w.path}`)));
    const creates = writes.filter((w) => w.method === 'POST' && w.path === '/api/cards');
    assert.equal(creates.length, 1, 'exactly one POST /api/cards');
    assert.equal(creates[0].body.shortId, undefined, 'the client does not propose a shortId');
    assert.equal(creates[0].body.nextShortId, undefined, 'nor a nextShortId');
  }, { server: { board: fixture() }, launch: { headless: 'new' } });
});

test('#1583 edit: the column editor saves through PATCH /api/cards/:id with ifVersion (never /api/save); a second edit without reload also lands', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await openBoard(browser, server.baseUrl);
    const writes = recordWrites(page);

    const editOnce = async (title, desc) => {
      await page.click('.card[data-id="k2"] .card-edit-btn');
      await page.waitForSelector('.card[data-id="k2"] .edit-title', { timeout: 5000 });
      await setValue(page, '.card[data-id="k2"] .edit-title', title);
      await setValue(page, '.card[data-id="k2"] .edit-desc', desc);
      await page.click('.card[data-id="k2"] .btn-save-edit');
      const landed = await until(async () => {
        const c = (await api(server.baseUrl, 'GET', '/api/cards/k2')).body;
        return c.title === title && c.description === desc ? c : null;
      });
      // The tab finishes with the response (adopts the version, re-renders the
      // tile) after the server has stored it; let that settle before the next
      // click, or the click lands on a tile being replaced.
      await page.waitForFunction(() => _pendingSaves.length === 0, { timeout: 8000 });
      return landed;
    };

    const first = await editOnce('beta, edited', 'new body');
    assert.ok(first, 'the first edit reached the server');
    assert.equal(first.version, 2);
    const second = await editOnce('beta, edited twice', 'newer body');
    assert.ok(second, 'a second edit without reload also reached the server (the tab took version 2)');
    assert.equal(second.version, 3);

    assert.equal(writes.filter((w) => w.path === '/api/save').length, 0,
      'no /api/save: ' + JSON.stringify(writes.map((w) => `${w.method} ${w.path}`)));
    const patches = writes.filter((w) => w.method === 'PATCH' && w.path === '/api/cards/k2');
    assert.equal(patches.length, 2, 'two PATCHes: ' + JSON.stringify(writes.map((w) => `${w.method} ${w.path}`)));
    assert.equal(patches[0].body.ifVersion, 1, 'the first edit declares the version the tab read');
    assert.equal(patches[1].body.ifVersion, 2, 'the second declares the version the server returned');

    // The edited card did not move: same column, same order, same slot.
    const after = (await api(server.baseUrl, 'GET', '/api/cards/k2')).body;
    assert.equal(after.column, 'backlog');
    assert.equal(after.order, 2);
    const tiles = await page.$$eval('#backlog-body .card', (els) => els.map((e) => e.dataset.id));
    assert.deepEqual(tiles, ['k1', 'k2'], 'render position unchanged');
  }, { server: { board: fixture() }, launch: { headless: 'new' } });
});

test('#1583 409: a seat edits after the tab loaded → the browser edit is refused visibly, the seat\'s edit survives, the user\'s exact draft stays in the editor', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await openBoard(browser, server.baseUrl);
    const writes = recordWrites(page);

    // The seat moves the card on (v1 → v2) behind the tab's back.
    const seat = await api(server.baseUrl, 'PATCH', '/api/cards/k1', { by: 'bob', title: 'alpha by the seat', description: 'seat body' });
    assert.equal(seat.status, 200);
    assert.equal(seat.body.version, 2);

    const DRAFT_TITLE = 'alpha by the user';
    const DRAFT_DESC = 'the user\'s draft\nline two';
    await page.click('.card[data-id="k1"] .card-edit-btn');
    await page.waitForSelector('.card[data-id="k1"] .edit-title', { timeout: 5000 });
    await setValue(page, '.card[data-id="k1"] .edit-title', DRAFT_TITLE);
    await setValue(page, '.card[data-id="k1"] .edit-desc', DRAFT_DESC);
    await page.click('.card[data-id="k1"] .btn-save-edit');

    // Visible: the status line says it was not saved and why.
    await page.waitForFunction(
      () => document.querySelector('.save-status[data-state="failed"][data-shown="1"]'),
      { timeout: 8000 },
    );
    const msg = await page.$eval('.save-status', (e) => e.textContent);
    assert.match(msg, /not saved/i, msg);
    assert.match(msg, /changed elsewhere/i, msg);
    assert.match(msg, /reload/i, msg);

    // The PATCH went out with the stale version and was refused.
    const patches = writes.filter((w) => w.method === 'PATCH' && w.path === '/api/cards/k1');
    assert.equal(patches.length, 1);
    assert.equal(patches[0].body.ifVersion, 1, 'the edit declared the version the tab read');
    assert.equal(writes.filter((w) => w.path === '/api/save').length, 0, 'and no whole-board save tried to force it');

    // The server keeps the SEAT's edit.
    const stored = (await api(server.baseUrl, 'GET', '/api/cards/k1')).body;
    assert.equal(stored.title, 'alpha by the seat');
    assert.equal(stored.description, 'seat body');
    assert.equal(stored.version, 2);

    // The user's exact draft is still in the editor.
    await page.waitForSelector('.card[data-id="k1"] .edit-title', { timeout: 5000 });
    assert.equal(await page.$eval('.card[data-id="k1"] .edit-title', (e) => e.value), DRAFT_TITLE);
    assert.equal(await page.$eval('.card[data-id="k1"] .edit-desc', (e) => e.value), DRAFT_DESC);
  }, { server: { board: fixture() }, launch: { headless: 'new' } });
});

test('#1583 a whole-board save fired while a create is still on the wire does not delete the new card', async () => {
  // /api/save replaces the stored card list with the tab's. A provisional card
  // is (rightly) kept out of that list — so a save serialized before the
  // create's 201 is adopted would wipe the card the server just made. The
  // remaining whole-board callers (moves, columns) can fire in that window.
  await withBrowserServer(async ({ server, browser }) => {
    const page = await openBoard(browser, server.baseUrl);
    await page.evaluate(() => {
      addCard('created during a save', '', 'task', 'unassigned', [], 'backlog', null);
      saveToJSONFile();   // e.g. a drag landing in the same tick
    });
    await page.waitForFunction(() => _pendingSaves.length === 0, { timeout: 8000 });
    const all = (await api(server.baseUrl, 'GET', '/api/cards?limit=50')).body.cards;
    const made = all.filter((c) => c.title === 'created during a save');
    assert.equal(made.length, 1, 'the new card exists exactly once on the server: ' + JSON.stringify(all.map((c) => c.title)));
    assert.equal(all.length, 4, 'and nothing else was lost or duplicated');
  }, { server: { board: fixture() }, launch: { headless: 'new' } });
});
