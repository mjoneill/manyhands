/**
 * #1931 — CLICKING A SEAT'S CHIP SHOWS WHAT THAT SEAT SAID ON THE BOARD, NOT WHAT IT SAID IN THE LAST 50 POSTS. On main 818953a a chip click
 * (commons.html, `view.solo(key)`) filtered the posts the page had loaded (`limit = 50`) and hid "load older" while soloed, so a seat whose
 * last post was more than 50 posts back showed "Nothing from them yet": a whole-board negative drawn from a window check. #1010 fixed exactly
 * this for the search box; the solo was never moved. Found when the owner could not find a seat's song by clicking its chip (2026-11-15).
 *
 *   C1  A quiet seat whose only post is 55 posts back: clicking its chip shows that post, and a line counting the seat's posts on the board.
 *   C2  A seat that has never posted: the empty state says the board holds none of its posts, and never "Nothing from them yet".
 *   C3  A seat with more posts than one page: the line says how many in all and how many are shown, "load older" is offered, and clicking it
 *       brings the rest. Every post shown while soloed is that seat's.
 *   C4  The owner's other path: typing the seat's display name in the search box finds the post (server name match, N1).
 *   C5  Clearing the solo returns the whole room, newest last.
 *   C6  C1 and C4 again with the conversations unit ON (a real executor), the paths production answers from.
 *
 * Must-fail control: C1, C2, C3, C4 and C6 are RED on main 818953a. C5 passes there; it guards the way back.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withBrowserServer, makeBoardFixture } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const ROSTER_FILE = path.join(os.tmpdir(), `commons-solo-1931-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: {
  ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' },
  lodger: { name: 'Marmalade', glyph: 'm', color: '#c2a057' },
  quill: { name: 'Quill', glyph: 'q', color: '#8a7cc4' },
  board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' },
} }));
after(() => { try { fs.unlinkSync(ROSTER_FILE); } catch { /* gone */ } });

const T0 = Date.now() - 6 * 3600_000;   // six hours ago: every seat but the newest is quiet
const iso = (i) => new Date(T0 + i * 60_000).toISOString();
const msg = (id, author, body, i) => ({ id, body, author, attachedTo: null, createdAt: iso(i), mentions: [] });
const boardOf = (convs) => ({ cards: [], columns: [{ id: 'backlog', name: 'Backlog', order: 0 }], conversations: convs, nextShortId: 1 });
/** one lodger post first, then `n` posts by ada: the lodger post is `n` posts back */
const buried = (n) => [msg('song', 'lodger', 'a sea shanty for the crew', 0), ...Array.from({ length: n }, (_, k) => msg(`a${k}`, 'ada', `ada says ${k}`, k + 1))];
const env = { SCRUM_ROSTER_FILE: ROSTER_FILE };

async function openCommons(server, browser) {
  const page = await browser.newPage();
  await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.constellation .mind', { timeout: 5000 });
  return page;
}
/** click a seat's chip by its display name, opening the quiet expander first if the chip is behind it */
async function clickChip(page, name) {
  const find = () => page.evaluate((n) => [...document.querySelectorAll('.constellation .mind')].some((m) => m.title === n), name);
  if (!(await find())) { await page.click('.constellation-quiet'); await page.waitForFunction((n) => [...document.querySelectorAll('.constellation .mind')].some((m) => m.title === n), { timeout: 3000 }, name); }
  await page.evaluate((n) => [...document.querySelectorAll('.constellation .mind')].find((m) => m.title === n).click(), name);
}
const feedText = (page) => page.$eval('.cv-feed', (e) => e.textContent);
const shownIds = (page) => page.$$eval('.cv-feed .cv-msg', (els) => els.map((e) => e.dataset.id));

test('C1 a quiet seat whose only post is 55 back: its chip shows that post and counts its posts on the board', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await openCommons(server, browser);
    assert.ok(!(await shownIds(page)).includes('song'), 'CONTROL: the post is outside the loaded window before the click');
    await clickChip(page, 'Marmalade');
    await page.waitForFunction(() => [...document.querySelectorAll('.cv-feed .cv-msg')].some((e) => e.dataset.id === 'song'), { timeout: 5000 })
      .catch(async () => assert.fail(`the seat's post never appeared; the feed says: ${await feedText(page)}`));
    const head = await page.$eval('.cv-solo-count', (e) => e.textContent);
    assert.match(head, /\b1 post\b/, head);
    assert.doesNotMatch(await feedText(page), /Nothing from them yet/);
  }, { server: { board: boardOf(buried(55)), env }, launch: { headless: 'new' } });
});

test('C2 a seat that never posted: the empty state is the board\'s zero, never "Nothing from them yet"', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await openCommons(server, browser);
    await clickChip(page, 'Quill');
    await page.waitForFunction(() => document.querySelector('.cv-solo-count'), { timeout: 5000 })
      .catch(async () => assert.fail(`no board-wide count was shown; the feed says: ${await feedText(page)}`));
    const head = await page.$eval('.cv-solo-count', (e) => e.textContent);
    assert.match(head, /no posts/i, head);
    assert.doesNotMatch(await feedText(page), /Nothing from them yet/);
    assert.deepEqual(await shownIds(page), []);
  }, { server: { board: boardOf(buried(3)), env }, launch: { headless: 'new' } });
});

test('C3 more posts than one page: the count says how many, "load older" is offered, and it brings the rest, all by that seat', async () => {
  const convs = [];
  for (let i = 0; i < 70; i++) convs.push(msg(`m${i}`, 'lodger', `verse ${i}`, 2 * i), msg(`x${i}`, 'ada', `ada ${i}`, 2 * i + 1));
  await withBrowserServer(async ({ server, browser }) => {
    const page = await openCommons(server, browser);
    await clickChip(page, 'Marmalade');
    await page.waitForFunction(() => /70 posts/.test(document.querySelector('.cv-solo-count')?.textContent || ''), { timeout: 5000 })
      .catch(async () => assert.fail(`no count of 70; the feed says: ${(await feedText(page)).slice(0, 300)}`));
    const head = await page.$eval('.cv-solo-count', (e) => e.textContent);
    assert.match(head, /showing the 50 most recent/, head);
    assert.equal((await shownIds(page)).length, 50);
    assert.ok((await shownIds(page)).every((id) => id.startsWith('m')), 'only the soloed seat\'s posts');
    const older = await page.$('.cv-load-older');
    assert.ok(older && await older.evaluate((b) => b.style.display !== 'none' && !b.hidden), '"load older" is offered while soloed');
    await older.click();
    await page.waitForFunction(() => document.querySelectorAll('.cv-feed .cv-msg').length === 70, { timeout: 5000 })
      .catch(async () => assert.fail(`after load older: ${(await shownIds(page)).length} shown`));
    const all = await shownIds(page);
    assert.ok(all.every((id) => id.startsWith('m')), 'older posts are the seat\'s too');
    assert.ok(all.includes('m0'), 'the oldest verse is reachable');
  }, { server: { board: boardOf(convs), env }, launch: { headless: 'new' } });
});

test('C4 typing the seat\'s display name in the search box finds its post', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await openCommons(server, browser);
    await page.type('.cv-search', 'marmalade');
    await page.waitForFunction(() => document.querySelector('.cv-search-head') && !/Searching/.test(document.querySelector('.cv-search-head').textContent), { timeout: 5000 });
    const ids = await page.$$eval('.cv-result .cv-msg', (els) => els.map((e) => e.dataset.id));
    assert.deepEqual(ids, ['song'], await page.$eval('.cv-search-head', (e) => e.textContent));
  }, { server: { board: boardOf(buried(55)), env }, launch: { headless: 'new' } });
});

test('C5 clearing the solo returns the whole room', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await openCommons(server, browser);
    const before = await shownIds(page);
    await clickChip(page, 'Marmalade');
    await page.waitForSelector('.cv-solo-clear', { timeout: 5000 });
    await page.click('.cv-solo-clear');
    await page.waitForFunction((n) => document.querySelectorAll('.cv-feed .cv-msg').length === n, { timeout: 5000 }, before.length);
    assert.deepEqual(await shownIds(page), before);
  }, { server: { board: boardOf(buried(55)), env }, launch: { headless: 'new' } });
});

// ── C6: the same two paths with the conversations unit ON, as production runs ─────────────────────────────────────────────────────────────
// With the unit on, `?author=&limit=` is answered by the targeted graph read (server.js targetedPosts) and `?q=` by the merged bulk path:
// neither is the path C1-C4 exercise. A real executor; without a python with pyoxigraph the row is SKIPPED, and a skip is NOT a pass.
const UNIT_SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
test('C6 unit ON: a seat whose only post is 55 back is found by its chip (with its count) and by its name in the search box', { skip: UNIT_SKIP }, async () => {
  const DSID = 'commons-solo-1931';
  const store = tmpStore('solo-1931-');
  const exec = await startExecutor({ store, datasetId: DSID, create: true });
  const post = async (base, author, body) => { const r = await fetch(`${base}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ author, body }) }); assert.equal(r.status, 201, `post by ${author}`); return r.json(); };
  try {
    await withBrowserServer(async ({ server, browser }) => {
      const song = await post(server.baseUrl, 'lodger', 'a sea shanty for the crew');
      for (let k = 0; k < 55; k++) await post(server.baseUrl, 'ada', `ada says ${k}`);
      const page = await openCommons(server, browser);
      assert.ok(!(await shownIds(page)).includes(song.id), 'CONTROL: the post is outside the loaded window before the click');
      await clickChip(page, 'Marmalade');
      await page.waitForFunction((id) => [...document.querySelectorAll('.cv-feed .cv-msg')].some((e) => e.dataset.id === id), { timeout: 8000 }, song.id)
        .catch(async () => assert.fail(`unit on: the seat's post never appeared; the feed says: ${await feedText(page)}`));
      assert.match(await page.$eval('.cv-solo-count', (e) => e.textContent), /\b1 post\b/);
      await page.click('.cv-solo-clear');
      await page.type('.cv-search', 'marmalade');
      await page.waitForFunction(() => document.querySelector('.cv-search-head') && !/Searching/.test(document.querySelector('.cv-search-head').textContent), { timeout: 8000 });
      assert.deepEqual(await page.$$eval('.cv-result .cv-msg', (els) => els.map((e) => e.dataset.id)), [song.id], await page.$eval('.cv-search-head', (e) => e.textContent));
    }, { server: { board: makeBoardFixture({ cards: [], postSeqEpoch: '11111111-2222-4333-8444-555555555555', nextPostSeq: 1 }), env: { ...env, SCRUM_GRAPH_DATASET_ID: DSID, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1' } }, launch: { headless: 'new' } });
  } finally { await killExecutor(exec); fs.rmSync(store, { recursive: true, force: true }); }
});
