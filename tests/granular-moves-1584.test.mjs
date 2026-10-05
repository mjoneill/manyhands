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

// ── Review round ────────────────────────────────────────────────────────────

const setValue = (page, selector, text) => page.evaluate((sel, t) => {
  const el = document.querySelector(sel);
  if (!el) throw new Error('no element for ' + sel);
  el.value = t;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, selector, text);

const SEAT_TITLE = 'retitled by a seat';

test('#1584 shifted neighbour: a seat edits N, a browser move shifts N, a browser edit of N then KEEPS the seat\'s change (never a silent overwrite)', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await openBoard(browser, server.baseUrl);
    const writes = recordWrites(page);
    const seat = await api(server.baseUrl, 'PATCH', '/api/cards/k5', { by: 'bob', title: SEAT_TITLE });
    assert.equal(seat.status, 200);

    await drag(page, 'k1', 'planned', 'k5');   // k5 is pushed down by the move
    await settle(page);
    const k5 = (await api(server.baseUrl, 'GET', '/api/cards/k5')).body;
    assert.equal(k5.order, 3, 'precondition: the move shifted k5');

    // The user edits k5's BODY only. The title field is whatever the tab holds.
    await page.evaluate(() => document.querySelector('.card[data-id="k5"] .card-edit-btn').click());
    await page.waitForSelector('.card[data-id="k5"] .edit-desc', { timeout: 8000 });
    await setValue(page, '.card[data-id="k5"] .edit-desc', 'a body written by the user');
    await page.evaluate(() => document.querySelector('.card[data-id="k5"] .btn-save-edit').click());
    await settle(page);

    const stored = (await api(server.baseUrl, 'GET', '/api/cards/k5')).body;
    const status = await page.$eval('.save-status', (e) => e.textContent).catch(() => '');
    const refusedVisibly = /changed elsewhere/i.test(status);
    assert.equal(stored.title, SEAT_TITLE, `the seat's title survives (status: ${status}) wire: ${wire(writes)}`);
    assert.ok(refusedVisibly || stored.description === 'a body written by the user',
      'either the edit landed on top of the seat\'s version, or it was refused visibly');
  }, { server: { board: fixture() }, launch: { headless: 'new' } });
});

test('#1584 shifted neighbour OPEN IN THE EDITOR: the move does not hand it a new version, so its save is refused visibly and the seat\'s change survives', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await openBoard(browser, server.baseUrl);
    await page.evaluate(() => document.querySelector('.card[data-id="k5"] .card-edit-btn').click());
    await page.waitForSelector('.card[data-id="k5"] .edit-title', { timeout: 8000 });
    const seat = await api(server.baseUrl, 'PATCH', '/api/cards/k5', { by: 'bob', title: SEAT_TITLE });
    assert.equal(seat.status, 200);

    await drag(page, 'k1', 'planned', 'k5');
    await settle(page);
    assert.equal(await page.evaluate(() => cards.find((c) => c.id === 'k5').version), 1,
      'the card open in the editor keeps the version it was opened at');

    await setValue(page, '.card[data-id="k5"] .edit-title', 'the user\'s draft title');
    await page.evaluate(() => document.querySelector('.card[data-id="k5"] .btn-save-edit').click());
    await page.waitForFunction(() => document.querySelector('.save-status[data-state="failed"][data-shown="1"]'), { timeout: 8000 });
    const msg = await page.$eval('.save-status', (e) => e.textContent);
    assert.match(msg, /changed elsewhere/i, msg);
    await settle(page);
    const stored = (await api(server.baseUrl, 'GET', '/api/cards/k5')).body;
    assert.equal(stored.title, SEAT_TITLE, 'the seat\'s change survives');
    assert.equal(stored.order, 3, 'and the move\'s shift stands');
  }, { server: { board: fixture() }, launch: { headless: 'new' } });
});

const tiedFixture = () => makeBoardFixture({
  cards: [
    card(1, 'backlog', 5), card(2, 'backlog', 5), card(3, 'backlog', 5),
    card(4, 'planned', 1), card(5, 'planned', 2),
  ],
  nextShortId: 6,
});

test('#1584 ties: a drop BETWEEN TWO TIED cards lands between them, on screen and after reload; so does a reorder inside the tie', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await openBoard(browser, server.baseUrl);
    const writes = recordWrites(page);
    assert.deepEqual(await columnOrder(page, 'backlog'), ['k1', 'k2', 'k3'], 'precondition: a three-way tie at order 5');

    await drag(page, 'k4', 'backlog', 'k2');   // between k1 and k2
    await settle(page);
    const first = writes.filter((w) => w.method === 'PATCH')[0];
    assert.equal(first.body.after, 'k1', 'the move names the card it goes after');
    let before = await assertSurvivesReload(page, ['backlog', 'planned']);
    assert.deepEqual(before.backlog, ['k1', 'k4', 'k2', 'k3']);

    const w2 = recordWrites(page);
    await drag(page, 'k3', 'backlog', 'k4');   // inside what was the tie: between k1 and k4
    await settle(page);
    assert.equal(w2.filter((w) => w.method === 'PATCH').length, 1, wire(w2));
    before = await assertSurvivesReload(page, ['backlog']);
    assert.deepEqual(before.backlog, ['k1', 'k3', 'k4', 'k2']);
    noSave(writes);
  }, { server: { board: tiedFixture() }, launch: { headless: 'new' } });
});

/**
 * A man-in-the-middle for the move PATCH of `cardId`: the request is sent to
 * the server from here (so it COMMITS), and the browser gets either a network
 * failure ('drop') or a 200 whose body is cut off ('garble'). While
 * `blockReads` is set, every board read the page makes fails too, so the tab
 * cannot learn the outcome until the test heals it.
 */
async function loseMoveReply(page, baseUrl, cardId, mode) {
  const state = { committed: 0, browserPatches: 0, blockReads: true };
  await page.setRequestInterception(true);
  page.on('request', async (r) => {
    const u = new URL(r.url());
    const isMove = r.method() === 'PATCH' && u.pathname === `/api/cards/${cardId}`;
    const isRead = r.method() === 'GET' && (u.pathname.startsWith('/api/cards') || u.pathname === '/api/load' || u.pathname === '/api/board/status');
    if (isMove) {
      state.browserPatches += 1;
      if (state.committed === 0) {
        const fwd = await fetch(`${baseUrl}${u.pathname}${u.search}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: r.postData() });
        state.committed += fwd.ok ? 1 : 0;
        if (mode === 'garble') { r.respond({ status: 200, contentType: 'application/json', body: '{"id":"' + cardId + '","vers' }).catch(() => {}); return; }
        r.abort('failed').catch(() => {});
        return;
      }
      r.continue().catch(() => {});
      return;
    }
    if (isRead && state.blockReads) { r.abort('failed').catch(() => {}); return; }
    r.continue().catch(() => {});
  });
  return state;
}

for (const mode of ['drop', 'garble']) {
  const what = mode === 'drop' ? 'a DROPPED reply' : 'an UNREADABLE 2xx';
  test(`#1584 unconfirmed move (${what}): never re-sent; not reported as saved or as local-only; whole-board saves blocked until read; the move and its shifts survive, each neighbour shifted once`, async () => {
    await withBrowserServer(async ({ server, browser }) => {
      const page = await openBoard(browser, server.baseUrl);
      const lost = await loseMoveReply(page, server.baseUrl, 'k1', mode);
      const writes = recordWrites(page);

      await drag(page, 'k1', 'planned', 'k5');
      await settle(page);
      assert.equal(lost.committed, 1, 'precondition: the move committed on the server');

      const msg = await page.$eval('.save-status', (e) => e.textContent).catch(() => '');
      assert.doesNotMatch(msg, /^saved/i, 'an unconfirmed move is not reported as saved: ' + msg);
      assert.doesNotMatch(msg, /on this screen only/i, 'nor as existing only on this screen: ' + msg);
      assert.match(msg, /not confirmed|not known/i, msg);

      // A whole-board caller while the outcome is unknown.
      await page.evaluate(() => { saveToJSONFile(); });
      await settle(page);
      assert.equal(writes.filter((w) => w.path === '/api/save').length, 0, 'the whole-board save was BLOCKED: ' + wire(writes));
      assert.match(await page.$eval('.save-status', (e) => e.textContent), /not saved/i);

      // Heal the reads; the next whole-board caller reconciles by READING, then saves.
      lost.blockReads = false;
      await page.evaluate(() => { saveToJSONFile(); });
      await settle(page);

      assert.equal(lost.browserPatches, 1, 'the move was never re-sent or replayed');
      const k1 = (await api(server.baseUrl, 'GET', '/api/cards/k1')).body;
      const k5 = (await api(server.baseUrl, 'GET', '/api/cards/k5')).body;
      const k4 = (await api(server.baseUrl, 'GET', '/api/cards/k4')).body;
      assert.deepEqual([k1.column, k1.order], ['planned', 2], 'the committed move survived the whole-board save');
      assert.equal(k5.order, 3, 'its shift survived, and happened exactly once (not 4)');
      assert.equal(k4.order, 1);
      assert.equal(await page.evaluate(() => cards.find((c) => c.id === 'k1').version), k1.version, 'the tab converged on the server card');
      const before = await assertSurvivesReload(page, ['planned', 'backlog']);
      assert.deepEqual(before.planned, ['k4', 'k1', 'k5']);
    }, { server: { board: fixture() }, launch: { headless: 'new' } });
  });
}

// ── Round 3: the guard survives a reload; a 5xx is not a refusal ─────────────

/** Open the board with a status-line recorder that survives reloads. */
async function openRecorded(browser, baseUrl) {
  const page = await browser.newPage();
  page.on('dialog', (d) => (d.type() === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => {}));
  await page.evaluateOnNewDocument(() => {
    window.__statusLog = [];
    const note = () => {
      const t = document.querySelector('.save-status')?.textContent;
      if (t && window.__statusLog[window.__statusLog.length - 1] !== t) window.__statusLog.push(t);
    };
    new MutationObserver(note).observe(document, { subtree: true, childList: true, characterData: true });
  });
  await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.card[data-id="k1"]', { timeout: 8000 });
  return page;
}
const statusLog = (page) => page.evaluate(() => window.__statusLog.slice());

/**
 * The move PATCH of `cardId` is forwarded to the server (so it COMMITS); the
 * browser gets a network failure ('drop') or a 500 with a JSON error body
 * ('500'). While `blockReads` is set every board read fails.
 */
async function interceptMove(page, baseUrl, cardId, mode) {
  const state = { committed: 0, browserPatches: 0, requestId: null, blockReads: true };
  await page.setRequestInterception(true);
  page.on('request', async (r) => {
    const u = new URL(r.url());
    const isMove = r.method() === 'PATCH' && u.pathname === `/api/cards/${cardId}`;
    const isRead = r.method() === 'GET' && (u.pathname.startsWith('/api/cards') || u.pathname === '/api/load' || u.pathname === '/api/board/status');
    if (isMove) {
      state.browserPatches += 1;
      if (state.committed === 0) {
        try { state.requestId = JSON.parse(r.postData()).requestId; } catch { /* asserted below */ }
        const fwd = await fetch(`${baseUrl}${u.pathname}${u.search}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: r.postData() });
        state.committed += fwd.ok ? 1 : 0;
        if (mode === '500') { r.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Failed to update card' }) }).catch(() => {}); return; }
        r.abort('failed').catch(() => {});
        return;
      }
      r.continue().catch(() => {});
      return;
    }
    if (isRead && state.blockReads) { r.abort('failed').catch(() => {}); return; }
    r.continue().catch(() => {});
  });
  return state;
}

const moveRecord = (page) => page.evaluate(() => localStorage.getItem('manyhands-unresolved-moves'));
const reloadOffline = async (page) => {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof cards !== 'undefined' && cards.some((c) => c.id === 'k1') && typeof _pendingSaves !== 'undefined', { timeout: 10000 });
  await new Promise((res) => setTimeout(res, 800));   // initBoard's fallback has run (and, if unguarded, saved)
  await settle(page);
};

test('#1584 (a) a committed move with a lost reply, then RELOADS with the board unreadable: the record survives every reload, every whole-board save is refused; once readable it reconciles by requestId and saves; neighbours shifted once', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await openRecorded(browser, server.baseUrl);
    const lost = await interceptMove(page, server.baseUrl, 'k1', 'drop');
    const writes = recordWrites(page);

    await drag(page, 'k1', 'planned', 'k5');
    await settle(page);
    assert.equal(lost.committed, 1, 'precondition: the move committed');
    assert.match(String(lost.requestId), /^[0-9a-f-]{36}$/, 'the move carried a requestId');

    for (const round of [1, 2]) {
      await reloadOffline(page);   // includes initBoard's offline-bootstrap whole-board save
      assert.ok(String(await moveRecord(page)).includes(lost.requestId), `reload ${round}: the unresolved record survived`);
      await page.evaluate(() => { saveToJSONFile(); });
      await settle(page);
      assert.equal(writes.filter((w) => w.path === '/api/save').length, 0, `reload ${round}: no whole-board save: ` + wire(writes));
      assert.match(await page.$eval('.save-status', (e) => e.textContent), /not saved/i, `reload ${round}: the refusal is visible`);
      assert.ok(String(await moveRecord(page)).includes(lost.requestId), `reload ${round}: a FAILED re-read leaves the record in place`);
    }

    lost.blockReads = false;
    await page.evaluate(() => { saveToJSONFile(); });
    await settle(page);
    assert.equal(lost.browserPatches, 1, 'never re-sent');
    assert.ok((await statusLog(page)).some((t) => /confirmed on the server/i.test(t)), 'reconciled and said so: ' + JSON.stringify(await statusLog(page)));
    assert.equal(await moveRecord(page), null, 'the record is cleared once the outcome is known');
    assert.ok(writes.some((w) => w.path === '/api/save'), 'and the whole-board save is allowed again');
    const k1 = (await api(server.baseUrl, 'GET', '/api/cards/k1')).body;
    const k5 = (await api(server.baseUrl, 'GET', '/api/cards/k5')).body;
    assert.equal(k1.lastMoveRequestId, lost.requestId);
    assert.deepEqual([k1.column, k1.order], ['planned', 2], 'the committed move survived');
    assert.equal(k5.order, 3, 'its shift survived, exactly once');
  }, { server: { board: fixture() }, launch: { headless: 'new' } });
});

test('#1584 (b) a committed move answered with a 500 is UNKNOWN, not "Not moved": saves blocked while the board is unreadable; once readable it is confirmed', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await openRecorded(browser, server.baseUrl);
    const lost = await interceptMove(page, server.baseUrl, 'k1', '500');
    const writes = recordWrites(page);

    await drag(page, 'k1', 'planned', 'k5');
    await settle(page);
    assert.equal(lost.committed, 1, 'precondition: the move committed');
    const log = await statusLog(page);
    assert.ok(!log.some((t) => /not moved/i.test(t)), 'a 5xx is never reported as a refusal: ' + JSON.stringify(log));
    assert.match(log[log.length - 1] || '', /not known|not confirmed/i, JSON.stringify(log));

    await page.evaluate(() => { saveToJSONFile(); });
    await settle(page);
    assert.equal(writes.filter((w) => w.path === '/api/save').length, 0, 'no whole-board save: ' + wire(writes));

    lost.blockReads = false;
    await page.waitForFunction(() => window.__statusLog.some((t) => /confirmed on the server/i.test(t)), { timeout: 15000 });
    await settle(page);
    assert.equal(lost.browserPatches, 1, 'never re-sent');
    const k5 = (await api(server.baseUrl, 'GET', '/api/cards/k5')).body;
    assert.equal(k5.order, 3, 'shifted exactly once');
    await page.evaluate(() => { saveToJSONFile(); });
    await settle(page);
    assert.ok(writes.some((w) => w.path === '/api/save'), 'saves are allowed once it is confirmed');
    const k1 = (await api(server.baseUrl, 'GET', '/api/cards/k1')).body;
    assert.deepEqual([k1.column, k1.order], ['planned', 2]);
  }, { server: { board: fixture() }, launch: { headless: 'new' } });
});

test('#1584 (c) valid twin: a GENUINE 409 says "Not moved", is never "not confirmed", re-adopts the server\'s state, and the whole-board save that follows carries the server\'s columns and the seat\'s change', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await openRecorded(browser, server.baseUrl);
    const writes = recordWrites(page);
    const seat = await api(server.baseUrl, 'PATCH', '/api/cards/k1', { by: 'bob', title: SEAT_TITLE });
    assert.equal(seat.status, 200);

    await drag(page, 'k1', 'planned', 'k5');
    await settle(page);
    const log = await statusLog(page);
    assert.ok(log.some((t) => /not moved/i.test(t)), JSON.stringify(log));
    assert.ok(!log.some((t) => /not confirmed|not known/i.test(t)), 'a definite refusal is not an unknown: ' + JSON.stringify(log));
    assert.equal(await moveRecord(page), null, 'nothing left unresolved');

    const server_ = (await api(server.baseUrl, 'GET', '/api/cards?limit=50')).body.cards;   // the truth BEFORE the save
    await page.evaluate(() => { saveToJSONFile(); });
    await settle(page);
    const saves = writes.filter((w) => w.path === '/api/save');
    assert.equal(saves.length, 1, 'the whole-board save is NOT blocked: ' + wire(writes));
    const sent = saves[0].body.cards;
    const byOrder = (list, col) => list.filter((c) => c.column === col).sort((a, b) => a.order - b.order).map((c) => [c.id, c.order]);
    for (const col of ['backlog', 'planned']) {
      assert.deepEqual(byOrder(sent, col), byOrder(server_, col), `${col}: the saved board is the server's, not the tab's preview`);
    }
    const sentK1 = sent.find((c) => c.id === 'k1');
    assert.equal(sentK1.title, SEAT_TITLE, 'the seat\'s change is in what the tab saved');
    assert.equal(sentK1.version, server_.find((c) => c.id === 'k1').version, 'under the server\'s version');
  }, { server: { board: fixture() }, launch: { headless: 'new' } });
});
