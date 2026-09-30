/**
 * #1510 — an open board tab learns the UI was redeployed. Browser test on the
 * SERVED pages (the card's own test, and the Value Steward's banana test):
 *
 *   load a page → change the served DEPLOYED-SHA → on the next poll a
 *   non-blocking banner says the board was updated → an unsent draft in the
 *   page is untouched, nothing reloaded → the same SHA, poll after poll,
 *   shows no banner.
 *
 * The watcher is injected by the SERVER into every HTML page, like the roster
 * (#1200), so a new page cannot forget it; that is asserted on two pages.
 * Sabotage: remove the comparison → the "banner appears" test goes red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBoardFixture, withBrowserServer } from './helpers/harness.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const ts = '2026-09-14T00:00:00.000Z';
const card = (shortId, title) => ({
  id: `c${shortId}`, shortId, title, description: '', type: 'task', column: 'backlog', order: shortId,
  assignees: ['unassigned'], labels: [], priority: null, createdAt: ts, updatedAt: ts,
});
const ROOT = new URL('..', import.meta.url).pathname;

/** A throwaway static root holding the real pages and a DEPLOYED-SHA we control. */
function staticRoot(sha) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-watch-static-'));
  for (const f of ['index.html', 'commons.html']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  const set = (s) => (s === null ? fs.rmSync(path.join(dir, 'DEPLOYED-SHA'), { force: true }) : fs.writeFileSync(path.join(dir, 'DEPLOYED-SHA'), `${s}\n`));
  set(sha);
  return { dir, set };
}
// 'load', not 'networkidle0': a 250 ms poll never leaves the 500 ms of quiet networkidle0 waits for.
const runOpts = (dir) => ({ server: { staticDir: dir, env: { SCRUM_DEPLOY_WATCH_MS: '250' } } });
const banner = (page) => page.$('[data-deploy-banner]');
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await settle(100); } }

test('#1510 /api/version reports the served sha, read fresh on every call', async () => {
  const root = staticRoot(SHA_A);
  await withBrowserServer(async ({ server }) => {
    const get = async () => (await (await fetch(`${server.baseUrl}/api/version`)).json());
    assert.deepEqual(await get(), { sha: SHA_A });
    root.set(SHA_B);
    assert.deepEqual(await get(), { sha: SHA_B }, 'a deploy that replaces the file is seen without a restart');
    root.set(null);
    assert.deepEqual(await get(), { sha: null }, 'no file (a dev tree) is null, not an error');
    fs.writeFileSync(path.join(root.dir, 'DEPLOYED-SHA'), 'not-a-sha\n');
    assert.deepEqual(await get(), { sha: null }, 'a file that is not a 40-hex sha is not a version');
  }, runOpts(root.dir));
});

for (const [name, url] of [['the board page', '/index.html'], ['the commons page', '/commons.html?node=c1']]) {
  test(`#1510 ${name}: same sha → no banner; a NEW sha → the banner, and an unsent draft is untouched`, async () => {
    const root = staticRoot(SHA_A);
    const board = makeBoardFixture({ cards: [card(1, 'first card')], conversations: [], nextShortId: 2 });
    await withBrowserServer(async ({ server, browser }) => {
      const page = await browser.newPage();
      await page.goto(`${server.baseUrl}${url}`, { waitUntil: 'load' });
      // an unsent draft, plus a marker that proves the page was not reloaded under it
      await page.evaluate(() => {
        const ta = document.createElement('textarea');
        ta.id = 'draft-under-test';
        document.body.appendChild(ta);
        ta.value = 'half a thought, not sent';
        window.__notReloaded = 'still-here';
      });

      // control: the SAME sha across several polls is silence
      await settle(1200);
      assert.equal(await banner(page), null, 'an unchanged sha must not show the banner');

      // a deploy: the served sha changes
      root.set(SHA_B);
      const shown = await until(() => banner(page));
      assert.ok(shown, 'the banner appears on a later poll once the sha differs');
      const text = await page.evaluate((el) => el.textContent, shown);
      assert.match(text, /The board was updated/i);
      assert.match(text, /reload/i);
      assert.ok(await shown.$('button'), 'a Reload button is offered');

      // the whole point: NOTHING was done to the page or the draft
      assert.equal(await page.evaluate(() => window.__notReloaded), 'still-here', 'no auto-reload');
      assert.equal(await page.$eval('#draft-under-test', (t) => t.value), 'half a thought, not sent', 'the unsent draft is intact');
      await settle(1200);   // several more polls: an announcement is made once, not once per poll
      assert.equal((await page.$$('[data-deploy-banner]')).length, 1, 'one banner, not one per poll');
    }, { ...runOpts(root.dir), server: { ...runOpts(root.dir).server, board } });
  });
}

test('#1510 reloading picks the new sha up as the baseline: the banner is gone and stays gone', async () => {
  const root = staticRoot(SHA_A);
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/index.html`, { waitUntil: 'load' });
    root.set(SHA_B);
    assert.ok(await until(() => banner(page)), 'stale tab sees the banner');
    await page.reload({ waitUntil: 'load' });
    await settle(1200);
    assert.equal(await banner(page), null, 'the fresh page carries the new sha; nothing to announce');
  }, runOpts(root.dir));
});

test('#1510 a deploy that lands BETWEEN page load and the first poll still shows the banner (the baseline is the sha the page was served with)', async () => {
  const root = staticRoot(SHA_A);
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/index.html`, { waitUntil: 'load' });
    root.set(SHA_B);   // the deploy: after the page was served, well before its first poll (1.5 s)
    assert.equal(await banner(page), null, 'control: nothing has polled yet');
    assert.ok(await until(() => banner(page), 6000), 'a baseline taken from the first poll would adopt the NEW sha and never warn; the served sha must be the baseline');
  }, { server: { staticDir: root.dir, env: { SCRUM_DEPLOY_WATCH_MS: '1500' } } });
});

test('#1510 a tree with no DEPLOYED-SHA is inert: no banner, no page error', async () => {
  const root = staticRoot(null);
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${server.baseUrl}/index.html`, { waitUntil: 'load' });
    root.set(SHA_B);   // a file appearing later is not a "change" from an unknown baseline
    await settle(1200);
    assert.equal(await banner(page), null);
    assert.deepEqual(errors, []);
  }, runOpts(root.dir));
});
