/**
 * #449 session 2 — THE BANANA TEST, rehearsed in a real browser on the real commons page against a real executor:
 * a reader reacts to a seat's post, sees whose reactions are whose, and sees a reaction made ELSEWHERE (by a seat,
 * through the API) arrive on an OLD post without reloading and without any new post being written.
 *
 *   E1  REACT FROM THE PAGE: ☺+ → 👍 on a seat's post; the chip shows, marked as yours, and the server holds it.
 *   E2  ANOTHER'S REACTION ARRIVES: a seat reacts through REST; the page shows the chip within a poll tick, names it, no reload.
 *   E3  TAKE YOURS BACK: clicking your own chip removes your reaction, on screen and on the server.
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

      // E1 — react from the page
      await page.click(`${msg} .cv-reaction-add`);
      await page.$$eval(`${msg} .cv-reaction-pick`, (bs) => bs.find((b) => b.dataset.emoji === '👍').click());
      const mine = await until(() => page.$$eval(`${msg} .cv-reaction`, (bs) => bs.filter((b) => b.dataset.emoji === '👍' && b.getAttribute('aria-pressed') === 'true').length), 10000);
      assert.equal(mine, 1, 'E1: the 👍 chip shows, marked as yours');
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
    }, { server: { board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1' } } });
  } finally { await killExecutor(exec); fs.rmSync(store, { recursive: true, force: true }); }
});
