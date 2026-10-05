/**
 * #1584 — #118 Slice 2: card MOVES (drag across columns, the ◀ ▶ arrows,
 * reorder within a column, undo) go through `PATCH /api/cards/:id
 * { column, order, makeRoom, ifVersion }`, never the whole-board save.
 *
 * Driven against a REAL server and asserted on the WIRE (which writes went
 * out) and at the BENEFICIARY (what the server stored, and what a fresh load
 * of the page renders). For every touched column the order on screen after
 * the move must equal the order after a reload — a move that only the tab
 * believes in is the failure this slice exists to remove.
 *
 * The drag is driven with synthetic DragEvents through the page's own
 * dragstart/drop handlers (real coordinates, real insertion maths); an OS
 * mouse drag is not exercised here.
 *
 *   concurrency → a seat PATCHes the card after the tab loaded it; the drag
 *   is refused (409) VISIBLY, the server keeps the seat's change, and the tab
 *   re-reads the touched columns so nothing on screen claims a move that did
 *   not happen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBoardFixture, withBrowserServer } from './helpers/harness.mjs';

const ts = '2026-09-01T00:00:00.000Z';
const card = (shortId, column, order, extra = {}) => ({
  id: `k${shortId}`, shortId, title: `card ${shortId}`, description: `body of ${shortId}`, type: 'task',
  column, order, assignees: ['unassigned'], labels: [], priority: null,
  for: '', createdAt: ts, updatedAt: ts, version: 1,
  relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [], supersededBy: [] },
  ...extra,
});

const fixture = () => makeBoardFixture({
  cards: [
    card(1, 'backlog', 1), card(2, 'backlog', 2), card(3, 'backlog', 3),
    card(4, 'planned', 1), card(5, 'planned', 2),
  ],
  nextShortId: 6,
});

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
const wire = (writes) => JSON.stringify(writes.map((w) => `${w.method} ${w.path} ${JSON.stringify(w.body)}`));

const openBoard = async (browser, baseUrl) => {
  const page = await browser.newPage();
  page.on('dialog', (d) => (d.type() === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => {}));
  await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.card[data-id="k1"]', { timeout: 8000 });
  return page;
};

const api = async (baseUrl, method, path, body) => {
  const r = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const settle = (page) => page.waitForFunction(() => _pendingSaves.length === 0, { timeout: 8000 });

const columnOrder = (page, col) => page.$$eval(`#${col}-body .card`, (els) => els.map((e) => e.dataset.id));

/** Drag `id` into `col`, dropped just above `beforeId` (or below the last card). */
async function drag(page, id, col, beforeId = null) {
  await page.evaluate((k) => {
    const tile = document.querySelector(`.card[data-id="${k}"]`);
    window.__dt = new DataTransfer();
    tile.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__dt }));
  }, id);
  // handleDragStart marks the tile .dragging on the next frame; the drop's
  // insertion maths excludes it only once that has happened.
  await page.waitForSelector(`.card.dragging[data-id="${id}"]`, { timeout: 3000 });
  await page.evaluate((k, c, b) => {
    const body = document.getElementById(`${c}-body`);
    const others = [...body.querySelectorAll('.card')].filter((e) => !e.classList.contains('dragging'));
    let y;
    if (b) y = document.querySelector(`.card[data-id="${b}"]`).getBoundingClientRect().top + 1;
    else y = others.length ? others[others.length - 1].getBoundingClientRect().bottom + 2 : body.getBoundingClientRect().top + 4;
    const x = body.getBoundingClientRect().left + 20;
    body.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt, clientX: x, clientY: y }));
    document.querySelector(`.card[data-id="${k}"]`)?.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
  }, id, col, beforeId);
}

/** The order on screen must survive a reload, for every touched column. */
async function assertSurvivesReload(page, cols) {
  const before = {};
  for (const c of cols) before[c] = await columnOrder(page, c);
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('.card[data-id="k1"]', { timeout: 8000 });
  for (const c of cols) {
    assert.deepEqual(await columnOrder(page, c), before[c], `${c}: order after the move == order after reload`);
  }
  return before;
}

const noSave = (writes) => assert.equal(writes.filter((w) => w.path === '/api/save').length, 0, 'no /api/save: ' + wire(writes));

test('#1584 drag to another column: one PATCH {column, order, ifVersion}, no /api/save, survives reload', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await openBoard(browser, server.baseUrl);
    const writes = recordWrites(page);
    await drag(page, 'k1', 'planned', 'k5');   // between k4 and k5
    await settle(page);

    noSave(writes);
    const moves = writes.filter((w) => w.method === 'PATCH');
    assert.equal(moves.length, 1, 'exactly one write — the server renumbers neighbours: ' + wire(writes));
    assert.equal(moves[0].path, '/api/cards/k1');
    assert.equal(moves[0].body.column, 'planned');
    assert.equal(moves[0].body.order, 2, 'just after k4 (order 1)');
    assert.equal(moves[0].body.ifVersion, 1, 'the version the tab read');

    const stored = (await api(server.baseUrl, 'GET', '/api/cards/k1')).body;
    assert.equal(stored.column, 'planned');
    const before = await assertSurvivesReload(page, ['planned', 'backlog']);
    assert.deepEqual(before.planned, ['k4', 'k1', 'k5']);
    assert.deepEqual(before.backlog, ['k2', 'k3']);
  }, { server: { board: fixture() }, launch: { headless: 'new' } });
});

test('#1584 arrow-move: ▶ sends one PATCH to the end of the next column, no /api/save, survives reload', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await openBoard(browser, server.baseUrl);
    const writes = recordWrites(page);
    await page.evaluate(() => document.querySelector('.card[data-id="k2"] .card-move-right').click());
    await settle(page);

    noSave(writes);
    const moves = writes.filter((w) => w.method === 'PATCH');
    assert.equal(moves.length, 1, wire(writes));
    assert.equal(moves[0].path, '/api/cards/k2');
    assert.deepEqual([moves[0].body.column, moves[0].body.order, moves[0].body.ifVersion], ['planned', 3, 1]);
    const before = await assertSurvivesReload(page, ['planned', 'backlog']);
    assert.deepEqual(before.planned, ['k4', 'k5', 'k2']);
    assert.deepEqual(before.backlog, ['k1', 'k3']);
  }, { server: { board: fixture() }, launch: { headless: 'new' } });
});

test('#1584 reorder within a column: one PATCH; the server renumbers the neighbours; the tab adopts their versions; survives reload', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await openBoard(browser, server.baseUrl);
    const writes = recordWrites(page);
    await drag(page, 'k3', 'backlog', 'k1');   // to the top
    await settle(page);

    noSave(writes);
    const moves = writes.filter((w) => w.method === 'PATCH');
    assert.equal(moves.length, 1, wire(writes));
    assert.equal(moves[0].path, '/api/cards/k3');
    assert.equal(moves[0].body.column, 'backlog');
    const k1 = (await api(server.baseUrl, 'GET', '/api/cards/k1')).body;
    assert.equal(k1.version, 2, 'the shifted neighbour\'s version advanced on the server');
    // The tab took that version: a following edit-free move of k1 is accepted.
    assert.equal(await page.evaluate(() => cards.find((c) => c.id === 'k1').version), 2, 'the tab adopted the neighbour\'s new version');
    const before = await assertSurvivesReload(page, ['backlog']);
    assert.deepEqual(before.backlog, ['k3', 'k1', 'k2']);
  }, { server: { board: fixture() }, launch: { headless: 'new' } });
});

test('#1584 undo: restores the prior {column, order} through PATCH with the CURRENT version, no /api/save, survives reload', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await openBoard(browser, server.baseUrl);
    const writes = recordWrites(page);
    await drag(page, 'k1', 'planned', 'k5');
    await settle(page);
    await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true })));
    await settle(page);

    noSave(writes);
    const moves = writes.filter((w) => w.method === 'PATCH');
    assert.equal(moves.length, 2, wire(writes));
    assert.equal(moves[1].path, '/api/cards/k1');
    assert.deepEqual([moves[1].body.column, moves[1].body.order, moves[1].body.ifVersion], ['backlog', 1, 2],
      'back to backlog, order 1, under the version the move produced');
    const stored = (await api(server.baseUrl, 'GET', '/api/cards/k1')).body;
    assert.equal(stored.column, 'backlog');
    const before = await assertSurvivesReload(page, ['planned', 'backlog']);
    assert.deepEqual(before.backlog, ['k1', 'k2', 'k3']);
    assert.deepEqual(before.planned, ['k4', 'k5']);
  }, { server: { board: fixture() }, launch: { headless: 'new' } });
});

test('#1584 concurrency: a seat changes the card after the tab loaded it → the drag is refused VISIBLY, no silent reorder, the seat\'s change survives', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await openBoard(browser, server.baseUrl);
    const writes = recordWrites(page);
    const seat = await api(server.baseUrl, 'PATCH', '/api/cards/k1', { by: 'bob', title: 'retitled by a seat' });
    assert.equal(seat.status, 200);
    assert.equal(seat.body.version, 2);

    await drag(page, 'k1', 'planned', 'k5');
    await page.waitForFunction(
      () => document.querySelector('.save-status[data-state="failed"][data-shown="1"]'),
      { timeout: 8000 },
    );
    const msg = await page.$eval('.save-status', (e) => e.textContent);
    assert.match(msg, /changed elsewhere/i, msg);
    assert.match(msg, /reload/i, msg);
    await settle(page);

    noSave(writes);
    const moves = writes.filter((w) => w.method === 'PATCH');
    assert.equal(moves.length, 1, 'one refused PATCH, never retried or forced: ' + wire(writes));
    assert.equal(moves[0].body.ifVersion, 1);

    const stored = (await api(server.baseUrl, 'GET', '/api/cards/k1')).body;
    assert.equal(stored.column, 'backlog', 'the server did not move it');
    assert.equal(stored.title, 'retitled by a seat', 'the seat\'s change survives');
    assert.equal(stored.version, 2);
    const k5 = (await api(server.baseUrl, 'GET', '/api/cards/k5')).body;
    assert.deepEqual([k5.order, k5.version], [2, 1], 'no neighbour was renumbered');

    // No silent reorder: the tab shows the SERVER's columns, not its own guess.
    await page.waitForFunction(() => document.querySelector('#backlog-body .card[data-id="k1"]'), { timeout: 8000 });
    const before = await assertSurvivesReload(page, ['planned', 'backlog']);
    assert.deepEqual(before.planned, ['k4', 'k5']);
    assert.deepEqual(before.backlog, ['k1', 'k2', 'k3']);
  }, { server: { board: fixture() }, launch: { headless: 'new' } });
});
