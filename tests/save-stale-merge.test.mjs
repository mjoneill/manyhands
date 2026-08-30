/**
 * #466 condition 2, the CLIENT half — what the board does when its save is
 * refused as stale.
 *
 * The server half (tests/save-stale-refused.test.mjs) makes a stale
 * whole-board save a 409. Measured before this was built, that alone costs
 * the only human on the board his edit at the room's PATCH rate: a seat
 * PATCHes ANY card after his tab loads ⇒ his next save is refused ⇒ the only
 * remedy is reload ⇒ what is on screen is gone. Control 7, 2026-08-30.
 *
 * So the page now keeps a BASELINE (id → cardContentKey at hydrate) and on a
 * 409 does the one merge that has no silent path in either direction:
 *   · a stale card this tab never touched  ⇒ take the server's copy, retry ONCE
 *   · a stale card this tab DID edit       ⇒ a real conflict: name it, keep the
 *                                              edit on screen, do not retry
 * and after a 200 applies the server's returned versions, so the next edit of
 * the same card is not mistaken for a stale one.
 *
 * ⚠️ These drive the REAL page (puppeteer) and verify at the SERVER, never at
 * the page's belief about itself. The wire is counted: a merge is exactly one
 * extra POST, never a loop.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withBrowserServer, startRestServer, makeBoardFixture } from './helpers/harness.mjs';
import { cardContentKey } from '../core/card-content-key.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function api(baseUrl, method, p, body) {
  const res = await fetch(`${baseUrl}${p}`, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Two server-versioned cards, X and Y, then a page hydrated on them. */
async function openWithXY(server, browser) {
  const x = (await api(server.baseUrl, 'POST', '/api/cards', { title: 'X', createdBy: 'ada' })).body;
  const y = (await api(server.baseUrl, 'POST', '/api/cards', { title: 'Y', createdBy: 'ada' })).body;
  const page = await browser.newPage();
  await page.goto(`${server.baseUrl}/`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => typeof window.saveToJSONFile === 'function' && typeof window.cardContentKey === 'function', { timeout: 8000 });
  return { page, x, y };
}
const countSaves = (page) => {
  const seen = [];
  page.on('request', (r) => { if (r.method() === 'POST' && /\/api\/save/.test(r.url())) seen.push(1); });
  return seen;
};
const editInPage = (page, id, title) => page.evaluate((id, t) => {
  const c = cards.find((k) => k.id === id); c.title = t; c.updatedAt = new Date().toISOString();
  return window.saveToJSONFile();
}, id, title);
const statusText = (page) => page.$eval('.save-status', (e) => ({ state: e.dataset.state, text: e.textContent }));

test('#466 ⭐ CONTROL 7, resolved — a seat PATCHes X after hydrate; the tab edits Y; the save MERGES and lands', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const { page, x, y } = await openWithXY(server, browser);
    const saves = countSaves(page);

    await api(server.baseUrl, 'PATCH', `/api/cards/${x.id}`, { title: 'X moved by a seat' });
    const ok = await editInPage(page, y.id, 'Y edited in the tab');
    assert.equal(ok, true, 'the save must report success after the merge');
    assert.equal(saves.length, 2, `exactly one refused POST + one retry, got ${saves.length}`);

    // AT THE BENEFICIARY: the seat's write survived, the tab's edit landed.
    const after = (await api(server.baseUrl, 'GET', '/api/load')).body;
    assert.equal(after.cards.find((c) => c.id === x.id).title, 'X moved by a seat', "the seat's PATCH must survive");
    assert.equal(after.cards.find((c) => c.id === y.id).title, 'Y edited in the tab', "the tab's edit must land");
    // and the page shows the server's X, not its stale copy
    const shownX = await page.evaluate((id) => cards.find((c) => c.id === id).title, x.id);
    assert.equal(shownX, 'X moved by a seat');
    assert.equal((await statusText(page)).state, 'saved');
  }, { launch: { headless: 'new' } });
});

test('#466 ⛔ a REAL conflict — the seat and the tab both edited Y — is named, kept on screen, and NOT retried', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const { page, y } = await openWithXY(server, browser);
    const saves = countSaves(page);

    await api(server.baseUrl, 'PATCH', `/api/cards/${y.id}`, { title: 'Y moved by a seat' });
    const ok = await editInPage(page, y.id, 'Y edited in the tab');
    assert.equal(ok, false);
    assert.equal(saves.length, 1, 'a conflict must not be retried — the retry would only 409 again');

    const after = (await api(server.baseUrl, 'GET', '/api/load')).body;
    assert.equal(after.cards.find((c) => c.id === y.id).title, 'Y moved by a seat', 'nothing written');
    const onScreen = await page.evaluate((id) => cards.find((c) => c.id === id).title, y.id);
    assert.equal(onScreen, 'Y edited in the tab', 'the edit must stay on screen — losing it is the defect this closes');
    const st = await statusText(page);
    assert.equal(st.state, 'failed');
    assert.match(st.text, new RegExp(`#${y.shortId}\\b`), `the message must NAME the card. Got: ${st.text}`);
    assert.match(st.text, /still on screen/i);
  }, { launch: { headless: 'new' } });
});

test('#466 after a successful save, editing the SAME card again is not mistaken for a stale tab', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const { page, y } = await openWithXY(server, browser);
    const saves = countSaves(page);
    assert.equal(await editInPage(page, y.id, 'first edit'), true);
    assert.equal(await editInPage(page, y.id, 'second edit'), true, 'the second edit must not be refused as stale');
    assert.equal(saves.length, 2, 'two clean saves, no retries');
    const after = (await api(server.baseUrl, 'GET', '/api/load')).body;
    const stored = after.cards.find((c) => c.id === y.id);
    assert.equal(stored.title, 'second edit');
    assert.equal(stored.version, 3, 'v1 create → v2 first save → v3 second save');
  }, { launch: { headless: 'new' } });
});

test('#466 ⛔⛔ an edit made WHILE a save is on the wire is a conflict with the tab itself — never merged away', async () => {
  // Review finding on the first cut, code-read before it was run: a queued
  // save serializes its body BEFORE awaiting the in-flight one, so it declares
  // versions that are stale by construction; and the baseline after a 200 was
  // taken from the LIVE array, which by then held the second edit. So the merge
  // saw "not dirty", took the server's copy, retried, and reported Saved —
  // with the second edit gone. #466's own defect, arriving through the fix.
  await withBrowserServer(async ({ server, browser }) => {
    const { page, y } = await openWithXY(server, browser);
    const saves = countSaves(page);
    const results = await page.evaluate((id) => {
      const c = cards.find((k) => k.id === id);
      c.title = 'C1'; c.updatedAt = new Date().toISOString();
      const a = window.saveToJSONFile();               // on the wire, not awaited
      c.title = 'C2'; c.updatedAt = new Date().toISOString();
      const b = window.saveToJSONFile();               // queued behind it
      return Promise.all([a, b]);
    }, y.id);
    assert.deepEqual(results, [true, false], 'A lands; B must be REFUSED as a conflict, not merged away');
    const onScreen = await page.evaluate((id) => cards.find((c) => c.id === id).title, y.id);
    assert.equal(onScreen, 'C2', 'the second edit must still be on screen');
    const after = (await api(server.baseUrl, 'GET', '/api/load')).body;
    assert.equal(after.cards.find((c) => c.id === y.id).title, 'C1', 'the server holds what it accepted');
    const st = await statusText(page);
    assert.equal(st.state, 'failed');
    assert.match(st.text, new RegExp(`#${y.shortId}\\b`));
    assert.equal(saves.length, 2, 'A, then B refused — no merge retry for a conflict');
  }, { launch: { headless: 'new' } });
});

// ── the shared definition ───────────────────────────────────────────────────

test('#466 a 200 from /api/save carries the settled version of EVERY card', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const a = (await api(s.baseUrl, 'POST', '/api/cards', { title: 'A', createdBy: 'ada' })).body;
    const tab = (await api(s.baseUrl, 'GET', '/api/load')).body;
    const payload = { cards: tab.cards.map((c) => ({ ...c })), columns: tab.columns, nextShortId: tab.nextShortId, lastUpdated: new Date().toISOString() };
    payload.cards[0].title = 'A edited';
    const r = await api(s.baseUrl, 'POST', '/api/save', payload);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.versions, [{ id: a.id, version: 2 }]);
  } finally { await s.stop(); }
});

test('#466 server.js has NO private cardContentKey — the browser and the handler share core/card-content-key.mjs', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(src, /^\s*function cardContentKey\b/m, 'a second definition is how the two sides drift');
  assert.match(src, /import \{ cardContentKey \} from '\.\/core\/card-content-key\.mjs'/);
  const html = fs.readFileSync(path.join(HERE, '..', 'index.html'), 'utf8');
  assert.match(html, /import \{ cardContentKey \} from '\.\/core\/card-content-key\.mjs'/);
  // and the definition still excludes the version, which is the whole point
  assert.equal(cardContentKey({ id: 1, version: 5, t: 'x' }), cardContentKey({ id: 1, version: 9, t: 'x' }));
  assert.notEqual(cardContentKey({ id: 1, t: 'x' }), cardContentKey({ id: 1, t: 'y' }));
});
