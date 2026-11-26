/**
 * #449 session 2 — THE BANANA TEST, rehearsed in a real browser on the real commons page against a real executor:
 * a reader reacts to a seat's post, sees whose reactions are whose, and sees a reaction made ELSEWHERE (by a seat,
 * through the API) arrive on an OLD post without reloading and without any new post being written.
 *
 *   E1  REACT FROM THE PAGE: ☺+ → 👍 on a seat's post; the chip shows, marked as yours, and the server holds it.
 *   E2  ANOTHER'S REACTION ARRIVES: a seat reacts through REST; the page shows the chip within a poll tick, names it, no reload.
 *   E3  TAKE YOURS BACK: clicking your own chip removes your reaction, on screen and on the server.
 *   E4  ANY EMOJI, BY NAME (#2026): ☺+ → ⋯ opens the full set; typing "croc" leaves only 🐊 on screen; a pick reacts.
 *   E5  THE ROOM'S TOP SIX (#2026): the picker's first row leads with the room's own most-used emoji.
 *   E0  AN UNTOUCHED POST SHOWS NO EMOJI: before anyone reacts, the palette is NOT on screen (computed style, not the
 *       `hidden` flag): only the faded ☺+ shows. ☺+ opens it; a pick closes it again. At the 2026-11-22 demo the
 *       open palette under every post read as six reactions already applied, because a `display` rule beat `hidden`.
 *
 * NOT COVERED, by name: the board's own embedded panel (index.html; it is not this view yet), touch, a 503 mid-click.
 * Without a python with pyoxigraph these rows are SKIPPED, and a skip is NOT a pass.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBoardFixture, withBrowserServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const DSID = 'x449-commons';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROSTER_FILE = path.join(os.tmpdir(), `x449-commons-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, gizmo: { name: 'Gizmo', glyph: 'g', color: '#c4a07c' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
after(() => { try { fs.unlinkSync(ROSTER_FILE); } catch { /* gone */ } });
async function until(fn, ms, step = 200) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await sleep(step); } }
const json = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

test('E1–E3 the banana test, rehearsed: react from the page, see another seat\'s reaction arrive, take yours back', { skip: SKIP, timeout: 180000 }, async () => {
  const store = tmpStore('x449-commons-');
  const exec = await startExecutor({ store, datasetId: DSID, create: true });
  try {
    await withBrowserServer(async ({ server, browser }) => {
      const base = server.baseUrl;
      const made = await json(await fetch(`${base}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ author: 'gizmo', body: 'x449 a sea shanty, verse one' }) }));
      assert.ok(made.id, `the seat's post exists: ${JSON.stringify(made)}`);
      const page = await browser.newPage();
      await page.goto(`${base}/commons.html`, { waitUntil: 'domcontentloaded' });
      const msg = `.cv-msg[data-id="${made.id}"]`;
      await page.waitForSelector(`${msg} .cv-reaction-add`, { timeout: 30000 });
      const me = await page.$eval('.cv-who', (s) => s.value);
      assert.ok(me, 'the page has a "post as" identity to react as');

      // E0 — an untouched post shows no emoji: the palette is closed ON SCREEN, not just flagged hidden
      const shown = (sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return getComputedStyle(el).display !== 'none' && r.width > 0 && r.height > 0; });
      assert.equal(await shown(`${msg} .cv-reaction-picker`), false, 'E0: the palette is not on screen before ☺+');
      assert.equal(await page.$$eval(`${msg} .cv-reaction`, (bs) => bs.length), 0, 'E0: no chips on an untouched post');
      assert.equal(await shown(`${msg} .cv-reaction-add`), true, 'E0: the ☺+ button is there');
      const height = () => page.$eval(msg, (el) => el.getBoundingClientRect().height);
      const closedHeight = await height();
      await page.click(`${msg} .cv-reaction-add`);
      assert.equal(await shown(`${msg} .cv-reaction-picker`), true, 'E0: ☺+ opens the palette');
      assert.equal(await height(), closedHeight, 'E0: the open palette floats over the page; it does not sit in the post like a row of reactions');
      await page.click(`${msg} .cv-reaction-add`);
      assert.equal(await shown(`${msg} .cv-reaction-picker`), false, 'E0: ☺+ again closes it');

      // E1 — react from the page
      await page.click(`${msg} .cv-reaction-add`);
      await page.$$eval(`${msg} .cv-reaction-pick`, (bs) => bs.find((b) => b.dataset.emoji === '👍').click());
      const mine = await until(() => page.$$eval(`${msg} .cv-reaction`, (bs) => bs.filter((b) => b.dataset.emoji === '👍' && b.getAttribute('aria-pressed') === 'true').length), 10000);
      assert.equal(mine, 1, 'E1: the 👍 chip shows, marked as yours');
      assert.equal(await shown(`${msg} .cv-reaction-picker`), false, 'E1: a pick leaves the palette closed on screen');
      const held = await json(await fetch(`${base}/api/conversations/${made.id}`));
      assert.deepEqual(held.reactions, [{ emoji: '👍', by: [me] }], 'E1: the server holds it');

      // E2 — ANOTHER seat (never the page's own identity) reacts elsewhere; the page shows it with no reload and no new post
      const other = ['ada', 'gizmo'].find((k) => k !== me);
      const otherName = { ada: 'Ada', gizmo: 'Gizmo' }[other];
      const r = await fetch(`${base}/api/conversations/${made.id}/reactions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ by: other, emoji: '😂' }) });
      assert.equal(r.status, 200);
      const title = await until(() => page.$$eval(`${msg} .cv-reaction`, (bs) => (bs.find((b) => b.dataset.emoji === '😂') || {}).title || ''), 15000);
      assert.equal(title, `${otherName} reacted with 😂`, 'E2: the chip arrived within a poll tick and names the reactor');

      // E3 — take yours back
      await page.$$eval(`${msg} .cv-reaction`, (bs) => bs.find((b) => b.dataset.emoji === '👍').click());
      const gone = await until(() => page.$$eval(`${msg} .cv-reaction`, (bs) => !bs.some((b) => b.dataset.emoji === '👍')), 10000);
      assert.ok(gone, 'E3: your chip is gone from the page');
      const after3 = await json(await fetch(`${base}/api/conversations/${made.id}`));
      assert.deepEqual(after3.reactions, [{ emoji: '😂', by: [other] }], 'E3: and from the server; the other seat\'s stays');

      // E4 (#2026) — ANY EMOJI, BY NAME: ☺+ → ⋯ opens a search over the full set; typing narrows what is ON SCREEN; a pick reacts
      await page.click(`${msg} .cv-reaction-add`);
      assert.equal(await shown(`${msg} .cv-reaction-browse`), false, 'E4: the full set stays closed until ⋯');
      await page.click(`${msg} .cv-reaction-more`);
      const visiblePicks = () => page.$$eval(`${msg} .cv-reaction-grid .cv-reaction-pick`, (bs) => bs.filter((b) => {
        const r = b.getBoundingClientRect(); return getComputedStyle(b).display !== 'none' && r.width > 0 && r.height > 0;
      }).map((b) => b.dataset.emoji));
      assert.ok(await until(async () => (await visiblePicks()).length > 1000, 10000), 'E4: ⋯ shows the full set');
      // reachable, not merely rendered: the search box sits inside the feed's visible box (a popover that grew upward out
      // of the scrolling feed was cut off at its top edge, where no scrolling can reach)
      const inFeed = await page.$eval(`${msg} .cv-reaction-search`, (el) => {
        const feed = el.closest('.cv-feed'); const r = el.getBoundingClientRect(); const f = feed.getBoundingClientRect();
        return r.top >= f.top - 1 && r.bottom <= f.bottom + 1 && r.height > 0;
      });
      assert.equal(inFeed, true, 'E4: the search box is inside the feed\'s visible area, so it can be typed in');
      assert.equal(await page.$eval(`${msg} .cv-reaction-grid .cv-reaction-pick`, (b) => b.dataset.emoji), '😀', 'E4: the full set opens on faces, not symbols');
      await page.type(`${msg} .cv-reaction-search`, 'croc');
      assert.deepEqual(await visiblePicks(), ['🐊'], 'E4: typing "croc" leaves only 🐊 on screen');
      await page.$$eval(`${msg} .cv-reaction-grid .cv-reaction-pick`, (bs) => bs.find((b) => b.dataset.emoji === '🐊').click());
      assert.ok(await until(() => page.$$eval(`${msg} .cv-reaction-mine`, (bs) => bs.some((b) => b.dataset.emoji === '🐊')), 10000), 'E4: the 🐊 chip shows, marked as yours');
      assert.equal(await shown(`${msg} .cv-reaction-picker`), false, 'E4: a pick closes the picker');
      const after4 = await json(await fetch(`${base}/api/conversations/${made.id}`));
      assert.deepEqual(after4.reactions.map((c) => c.emoji), ['😂', '🐊'], 'E4: the server holds an emoji from beyond the six');

      // E5 (#2026) — THE ROOM'S TOP SIX: 😂 and 🐊 are the room's only live reactions, one each; the tie goes to 🐊, used last
      const topRow = () => page.$$eval(`${msg} .cv-reaction-top .cv-reaction-pick`, (bs) => bs.map((b) => b.dataset.emoji));
      assert.ok(await until(async () => (await topRow()).join('') === '🐊😂👍❤️🤷👏', 10000),
        `E5: the first row leads with the room's own emoji, padded from the default six (got ${(await topRow()).join('')})`);
    }, { server: { board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1' } } });
  } finally { await killExecutor(exec); fs.rmSync(store, { recursive: true, force: true }); }
});
