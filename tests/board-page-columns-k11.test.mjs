/**
 * #1598 K11 (cards move to the graph; the board PAGE leaves the whole-board save first). The page's whole-board save has four callers left (column rename, column add, column delete, and the load-time fallback that pushes the
 * browser's cached board to the server), and `POST /api/save` is the last live caller of `handleSave`, which cannot be retired while the page uses it. The scope on the card (the builder 21:50Z, the reviewer 21:46Z): the page uses
 * `POST/PATCH/DELETE /api/columns` for those three, the load fallback never writes (it renders the cache and says it is offline), and `/api/save` answers 410 naming the routes to use. Written by the separate test author BEFORE the build.
 * Driven the way #1584's rows drive the page (a REAL server, a real headless browser, the page's own handlers) and asserted on the WIRE (which writes went out) and at the BENEFICIARY (what the server stored and what a fresh load
 * of the page renders). No executor is needed: this slice touches no graph.
 *
 * Each column operation has TWO rows: one on PERSISTENCE (it survives a reload; green today and must stay green) and one on the WIRE (no `/api/save`, the column route instead; RED today). A single row that mixes them would hide
 * whether the behaviour regressed or only the route changed.
 *
 *   C1p/C1w  RENAME a column (double-click its header, type, Enter): persists across a reload / goes out as `PATCH /api/columns/<id>` with the name and no `/api/save`.
 *   C2p/C2w  ADD a column (the + button, then name it): persists / goes out as `POST /api/columns` then `PATCH` for the name, no `/api/save`.
 *   C3p/C3w  DELETE a column that holds a card: no card is lost and every card sits in a column that exists, and the board renders after a reload / goes out as `DELETE /api/columns/<id>`, no `/api/save`. WHICH column the cards
 *            land in (the server's first column, or the page's old Orphanage) is the board owner's call and is NOT pinned here.
 *   C4       THE LOAD FALLBACK NEVER WRITES: a stale cached board in the browser and every read of the server failing (the card projection the page tries first, then `GET /api/load`): the page sends no write of any kind, the server's cards are unchanged, and the cached card is shown. (The "offline" wording is
 *            from the scope note; the row asserts the page says the word.)
 *   C5       /api/save IS REFUSED: a whole-board POST answers 410, the body names `/api/cards` or `/api/columns`, and the board is unchanged.
 *   C6       A CARD MOVE AND A CARD EDIT STILL PERSIST WITH /api/save REFUSED: one drag between columns (the page's own dragstart/drop handlers) and one title edit, each on the wire as a per-card PATCH, neither as `/api/save`, both there after
 *            a reload. (#1584 already pins moves with a no-save assertion; this row repeats it on the same page after the refusal, with an edit beside it.)
 *
 * NOT COVERED, by name: a real OS mouse drag (synthetic DragEvents through the page's handlers, as #1584 does); the empty-server-board variant of the fallback (the same branch, a board with zero cards and a stale cache) and a failing
 * `/api/save` response while the page is open (what the page shows then); concurrent tabs; the exact text of the 410 and of the offline notice beyond the words named above; column ORDER semantics beyond "the page's order survives
 * a reload"; the cards contract itself (the differential file).
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
const fixture = () => makeBoardFixture({ cards: [card(1, 'backlog', 1), card(2, 'backlog', 2), card(3, 'planned', 1)], nextShortId: 4 });
const server = () => ({ server: { board: fixture() } });

const api = async (baseUrl, method, path, body) => {
  const r = await fetch(`${baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: r.status, body: json, text };
};
const recordWrites = (page) => {
  const seen = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith('/api/') || r.method() === 'GET' || r.method() === 'HEAD') return;
    let body = null; try { body = JSON.parse(r.postData() || 'null'); } catch { body = r.postData(); }
    seen.push({ method: r.method(), path: u.pathname, body });
  });
  return seen;
};
const wire = (writes) => JSON.stringify(writes.map((w) => `${w.method} ${w.path} ${JSON.stringify(w.body)}`));
const noSave = (writes) => assert.equal(writes.filter((w) => w.path === '/api/save').length, 0, `no /api/save on the wire: ${wire(writes)}`);
const openBoard = async (browser, baseUrl, ready = '.card[data-id="k1"]') => {
  const page = await browser.newPage();
  page.on('dialog', (d) => (d.type() === 'beforeunload' ? d.accept() : d.accept()).catch(() => {}));
  await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector(ready, { timeout: 8000 });
  return page;
};
const settle = async (page) => { await page.waitForFunction(() => _pendingSaves.length === 0, { timeout: 8000 }).catch(() => {}); await page.waitForNetworkIdle({ idleTime: 600, timeout: 8000 }).catch(() => {}); };
const columnsOnServer = async (base) => (await api(base, 'GET', '/api/columns')).body;
const names = (cols) => Object.fromEntries((cols ?? []).map((c) => [c.id, c.name]));
const headerText = (page, id) => page.$eval(`.column-header[data-column-id="${id}"] .column-name-text`, (e) => e.textContent.trim()).catch(() => null);

async function rename(page, id, newName) {
  await page.click(`.column-header[data-column-id="${id}"] .column-name-text`, { clickCount: 2 });
  await page.waitForSelector(`.column-header[data-column-id="${id}"] .column-rename-input`, { timeout: 4000 });
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
  await page.$eval(`.column-header[data-column-id="${id}"] .column-rename-input`, (el) => { el.value = ''; });
  await page.type(`.column-header[data-column-id="${id}"] .column-rename-input`, newName);
  await page.keyboard.press('Enter');
  await settle(page);
}
async function addColumn(page, newName) {
  const before = await page.$$eval('.column-header[data-column-id]', (els) => els.map((e) => e.dataset.columnId));
  await page.click('#btn-add-column');
  await page.waitForFunction((b) => [...document.querySelectorAll('.column-header[data-column-id]')].some((e) => !b.includes(e.dataset.columnId)), { timeout: 4000 }, before);
  const id = await page.evaluate((b) => [...document.querySelectorAll('.column-header[data-column-id]')].map((e) => e.dataset.columnId).find((x) => !b.includes(x)), before);
  await page.waitForSelector(`.column-header[data-column-id="${id}"] .column-rename-input`, { timeout: 4000 });
  await page.$eval(`.column-header[data-column-id="${id}"] .column-rename-input`, (el) => { el.value = ''; });
  await page.type(`.column-header[data-column-id="${id}"] .column-rename-input`, newName);
  await page.keyboard.press('Enter');
  await settle(page);
  return id;
}

test('C1p RENAME persists: a column renamed in the page is renamed on the server and after a reload', { timeout: 120000 }, async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await openBoard(browser, server.baseUrl);
    await rename(page, 'planned', 'Next Up');
    assert.equal(names(await columnsOnServer(server.baseUrl)).planned, 'Next Up', 'the server holds the new name');
    await page.reload({ waitUntil: 'networkidle0' }); await page.waitForSelector('.card[data-id="k1"]', { timeout: 8000 });
    assert.match(String(await headerText(page, 'planned')), /next up/i, 'and the page shows it after a reload (the header carries an emoji and is upper-cased by CSS, so the match is on the words)');
  }, server());
});

test('C1w RENAME on the wire: PATCH /api/columns/<id> with the name, and no /api/save', { timeout: 120000 }, async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await openBoard(browser, server.baseUrl); const writes = recordWrites(page);
    await rename(page, 'planned', 'Next Up');
    noSave(writes);
    const patch = writes.find((w) => w.method === 'PATCH' && w.path === '/api/columns/planned');
    assert.ok(patch, `a PATCH /api/columns/planned went out: ${wire(writes)}`);
    assert.equal(patch.body?.name, 'Next Up', 'carrying the new name');
  }, server());
});

test('C2p ADD persists: a column added and named in the page is on the server and after a reload', { timeout: 120000 }, async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await openBoard(browser, server.baseUrl);
    const id = await addColumn(page, 'Parked');
    assert.equal(names(await columnsOnServer(server.baseUrl))[id], 'Parked', 'the server holds the new column under its new name');
    await page.reload({ waitUntil: 'networkidle0' }); await page.waitForSelector('.card[data-id="k1"]', { timeout: 8000 });
    assert.match(String(await headerText(page, id)), /parked/i, 'and the page shows it after a reload (matched on the words: the header carries an emoji)');
  }, server());
});

test('C2w ADD on the wire: POST /api/columns, the name set by a column write, and no /api/save', { timeout: 120000 }, async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await openBoard(browser, server.baseUrl); const writes = recordWrites(page);
    await addColumn(page, 'Parked');
    noSave(writes);
    assert.ok(writes.some((w) => w.method === 'POST' && w.path === '/api/columns'), `a POST /api/columns went out: ${wire(writes)}`);
    assert.ok(writes.some((w) => (w.method === 'POST' || w.method === 'PATCH') && w.path.startsWith('/api/columns') && JSON.stringify(w.body).includes('Parked')), `and a column write carried the name: ${wire(writes)}`);
  }, server());
});

const deleteColumn = async (page, id) => { await page.evaluate((c) => deleteColumn(c), id); await settle(page); };
async function assertNoCardLost(base, expected) {
  const cards = (await api(base, 'GET', '/api/cards')).body; const cols = new Set((await columnsOnServer(base)).map((c) => c.id));
  assert.equal(cards.length, expected, `no card was lost (${cards.length} of ${expected})`);
  for (const c of cards) assert.ok(cols.has(c.column), `card ${c.shortId} sits in a column that exists (${c.column})`);
}

test('C3p DELETE persists: a column with a card is deleted in the page; no card is lost, each sits in an existing column, and the board renders after a reload', { timeout: 120000 }, async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await openBoard(browser, server.baseUrl);
    await deleteColumn(page, 'planned');
    assert.ok(!names(await columnsOnServer(server.baseUrl)).planned, 'the column is gone on the server');
    await assertNoCardLost(server.baseUrl, 3);
    await page.reload({ waitUntil: 'networkidle0' }); await page.waitForSelector('.card[data-id="k3"]', { timeout: 8000 });
    assert.equal(await page.$('.column-header[data-column-id="planned"]'), null, 'and it is gone from the page after a reload, with the card still shown');
  }, server());
});

test('C3w DELETE on the wire: DELETE /api/columns/<id>, and no /api/save', { timeout: 120000 }, async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await openBoard(browser, server.baseUrl); const writes = recordWrites(page);
    await deleteColumn(page, 'planned');
    noSave(writes);
    assert.ok(writes.some((w) => w.method === 'DELETE' && w.path === '/api/columns/planned'), `a DELETE /api/columns/planned went out: ${wire(writes)}`);
  }, server());
});

test('C4 THE LOAD FALLBACK NEVER WRITES: a stale cached board and every read of the server failing (the card projection and /api/load): no write goes out, the server keeps its card titles, the cached board is shown and the page says offline', { timeout: 120000 }, async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    page.on('dialog', (d) => d.accept().catch(() => {}));
    // the cache holds ALL THREE real cards, the first with an OLD title: a save of it drops no card, so the server's own #230 guard (which refuses a save that vanishes more than two cards) would not stop it. (A first draft cached one unrelated card; the guard refused that push, so the row measured the guard and not the hazard.)
    const stale = [card(1, 'backlog', 1, { title: 'STALE CACHED TITLE' }), card(2, 'backlog', 2), card(3, 'planned', 1)];
    await page.evaluateOnNewDocument((s) => { try { if (!window.__seeded) { localStorage.setItem('manyhands', JSON.stringify(s)); window.__seeded = true; } } catch { /* none */ } }, stale);
    await page.setRequestInterception(true);
    const writes = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      // the page tries the card PROJECTION first (/api/board/status, /api/cards?...) and /api/load only after: a server that cannot be read fails ALL of them
      if (u.pathname.startsWith('/api/') && r.method() === 'GET') return r.respond({ status: 500, contentType: 'application/json', body: '{"error":"down"}' }).catch(() => {});
      if (u.pathname.startsWith('/api/') && r.method() !== 'GET' && r.method() !== 'HEAD') writes.push(`${r.method()} ${u.pathname}`);
      r.continue().catch(() => {});
    });
    await page.goto(`${server.baseUrl}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.card[data-id="k1"]', { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 2500));
    assert.deepEqual(writes, [], `the cached board pushed nothing to the server: ${JSON.stringify(writes)}`);
    const titles = (await api(server.baseUrl, 'GET', '/api/cards')).body.map((c) => c.title).sort();   // a direct fetch from the test, not through the page's interception
    assert.deepEqual(titles, ['card 1', 'card 2', 'card 3'], `the server's cards are unchanged, the stale title did not overwrite card 1 (${JSON.stringify(titles)})`);
    assert.match(await page.$eval('.card[data-id="k1"]', (e) => e.textContent), /STALE CACHED TITLE/, 'and the page shows the cached card (read only)');
    assert.match(await page.evaluate(() => document.body.innerText), /offline/i, 'and the page says it is offline');
  }, server());
});

test('C5 /api/save IS REFUSED: a whole-board POST answers 410 naming the routes to use, and the board is unchanged', { timeout: 120000 }, async () => {
  await withBrowserServer(async ({ server }) => {
    const before = (await api(server.baseUrl, 'GET', '/api/cards')).body.map((c) => `${c.shortId}:${c.title}:${c.column}`).sort();
    const r = await api(server.baseUrl, 'POST', '/api/save', { cards: [card(1, 'backlog', 1, { title: 'OVERWRITE' })], columns: [{ id: 'backlog', name: 'Backlog', order: 0 }], nextShortId: 2 });
    assert.equal(r.status, 410, `a whole-board save is gone (${r.status} ${r.text.slice(0, 160)})`);
    assert.match(r.text, /\/api\/(cards|columns)/, 'and the refusal names the routes to use');
    const after = (await api(server.baseUrl, 'GET', '/api/cards')).body.map((c) => `${c.shortId}:${c.title}:${c.column}`).sort();
    assert.deepEqual(after, before, 'the board is unchanged');
  }, server());
});

test('C6 A CARD MOVE AND A CARD EDIT STILL PERSIST: one drag and one title edit go out as per-card PATCHes, never /api/save, and are there after a reload', { timeout: 120000 }, async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await openBoard(browser, server.baseUrl); const writes = recordWrites(page);
    // the drag: synthetic DragEvents through the page's own handlers, as #1584 does
    await page.evaluate(() => { const tile = document.querySelector('.card[data-id="k1"]'); window.__dt = new DataTransfer(); tile.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__dt })); });
    await page.waitForSelector('.card.dragging[data-id="k1"]', { timeout: 3000 });
    await page.evaluate(() => {
      const body = document.getElementById('planned-body'); const others = [...body.querySelectorAll('.card')].filter((e) => !e.classList.contains('dragging'));
      const y = others.length ? others[others.length - 1].getBoundingClientRect().bottom + 2 : body.getBoundingClientRect().top + 4; const x = body.getBoundingClientRect().left + 20;
      body.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt, clientX: x, clientY: y }));
      document.querySelector('.card[data-id="k1"]')?.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
    });
    await settle(page);
    assert.equal((await api(server.baseUrl, 'GET', '/api/cards/1')).body.column, 'planned', 'the moved card is in its new column on the server');
    // the edit: the page's own column editor, as #1583's row drives it (click edit, set the field, click save)
    const setValue = (sel, t) => page.evaluate((q, v) => { const el = document.querySelector(q); if (!el) throw new Error('no element for ' + q); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, sel, t);
    await page.click('.card[data-id="k2"] .card-edit-btn');
    await page.waitForSelector('.card[data-id="k2"] .edit-title', { timeout: 5000 });
    await setValue('.card[data-id="k2"] .edit-title', 'card 2 EDITED');
    await page.click('.card[data-id="k2"] .btn-save-edit');
    await settle(page);
    assert.equal((await api(server.baseUrl, 'GET', '/api/cards/2')).body.title, 'card 2 EDITED', 'the edit is stored on the server');
    noSave(writes);
    assert.ok(writes.some((w) => w.method === 'PATCH' && /^\/api\/cards\/[^/]+$/.test(w.path)), `the move went out as a per-card PATCH: ${wire(writes)}`);
    await page.reload({ waitUntil: 'networkidle0' }); await page.waitForSelector('.card[data-id="k1"]', { timeout: 8000 });
    assert.ok(await page.$('#planned-body .card[data-id="k1"]'), 'the moved card is in its new column after a reload');
    assert.equal(await page.$eval('.card[data-id="k2"] .card-title, .card[data-id="k2"] h3', (e) => e.textContent.trim()).catch(() => 'no title element'), 'card 2 EDITED', 'and the edited title is shown after a reload');
  }, server());
});
