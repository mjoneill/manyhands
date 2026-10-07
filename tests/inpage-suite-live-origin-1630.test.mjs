/**
 * #1630 — THE IN-PAGE TEST SUITE MUST NEVER RUN ON THE LIVE ORIGIN. Since #1585 the board page's column functions write through `/api/columns`, so the suite in `tests.js` (which drives those production code paths) edits whatever board the page was served from. index.html has TWO doors to it:
 *   (1) the URL: `?test` auto-loads and runs the suite (it used to be a substring match, so any query containing "test" counted);
 *   (2) the keyboard: Ctrl+Shift+T loads tests.js and `showTestRunner()` calls `runTests()` at once; it needs no `?test`.
 * Written by the separate test author. The first build fixed (1) (exact `has('test')`, and not on port 3141); this file exists because (2) was read in the source and has no such refusal.
 *
 * ⛔ NOTHING HERE EVER REACHES THE REAL LIVE PORT. The "live origin" is SIMULATED: the page is navigated to `http://127.0.0.1:3141/...`, but request interception is switched on BEFORE the navigation and EVERY request to port 3141 is answered from a FIXTURE server (never `continue()`d); any other host is aborted. A row
 * fails loudly if a single request to 3141 was not answered by the interceptor.
 *
 *   P0  CONTROL: on a fixture origin `?test` runs the suite (tests.js is requested and the runner is shown), and Ctrl+Shift+T on a fixture origin shows the runner: developing the suite still works away from the live board.
 *   P1  EXACT MATCH: on a fixture origin `?contest=1` and `?x=test` do NOT load tests.js or show the runner (a substring is not the flag).
 *   P2  THE URL DOOR, SIMULATED LIVE ORIGIN: `/?test` on the simulated :3141 does not request tests.js, does not show the runner, and makes no write (no POST, PATCH, PUT or DELETE).
 *   P3  THE KEYBOARD DOOR, SIMULATED LIVE ORIGIN: Ctrl+Shift+T on the simulated :3141 does not request tests.js, does not show the runner, and makes no write.
 *
 * NOT COVERED, by name: which in-page tests would write to a live board (this shows the suite is not loaded or run there, not what it would have done); other origins that reach the live board (a LAN address on port 3141 is the same port and is refused, but a reverse proxy on another port would not be recognised by a port check); any other
 * way of loading `tests.js` by hand from the console.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBoardFixture, withBrowserServer } from './helpers/harness.mjs';

const LIVE_PORT = '3141';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Open `path` on the SIMULATED live origin (127.0.0.1:3141): every request to that port is answered from the fixture server; anything else is aborted. Returns the request log. */
async function openSimulatedLive(page, fixtureBase, pathAndQuery) {
  const seen = []; let liveRequests = 0; let answered = 0;
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const u = new URL(req.url());
    if (u.port === LIVE_PORT && u.hostname === '127.0.0.1') {
      liveRequests++;
      seen.push({ method: req.method(), path: u.pathname + u.search });
      try {
        const init = { method: req.method(), headers: Object.fromEntries(Object.entries(req.headers()).filter(([k]) => !['host', 'content-length', 'connection'].includes(k.toLowerCase()))) };
        if (!['GET', 'HEAD'].includes(req.method())) init.body = req.postData();
        const res = await fetch(`${fixtureBase}${u.pathname}${u.search}`, init); const body = Buffer.from(await res.arrayBuffer());
        answered++; await req.respond({ status: res.status, headers: { 'content-type': res.headers.get('content-type') || 'text/plain' }, body });
      } catch { answered++; await req.abort(); }
    } else { await req.abort(); }
  });
  await page.goto(`http://127.0.0.1:${LIVE_PORT}${pathAndQuery}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  return { seen, check: () => assert.equal(answered, liveRequests, `EVERY request to port ${LIVE_PORT} was answered by the interceptor, none reached the real server (${answered} of ${liveRequests})`) };
}
const runnerVisible = (page) => page.evaluate(() => !!document.getElementById('test-runner')?.classList.contains('visible'));
const ctrlShiftT = async (page) => { await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('T'); await page.keyboard.up('Shift'); await page.keyboard.up('Control'); };
const writes = (seen) => seen.filter((r) => !['GET', 'HEAD'].includes(r.method));
const loadedTests = (seen) => seen.some((r) => /\/tests\.js/.test(r.path));

test('P0 CONTROL: on a fixture origin ?test runs the suite and Ctrl+Shift+T shows the runner', { timeout: 180000 }, async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const a = await browser.newPage(); const reqs = []; a.on('request', (r) => reqs.push(r.url()));
    await a.goto(`${server.baseUrl}/?test`, { waitUntil: 'domcontentloaded' });
    await a.waitForFunction(() => document.getElementById('test-runner')?.classList.contains('visible'), { timeout: 30000 });
    assert.ok(reqs.some((u) => /\/tests\.js/.test(u)), 'tests.js was requested'); await a.close();
    const b = await browser.newPage(); await b.goto(`${server.baseUrl}/`, { waitUntil: 'domcontentloaded' }); await sleep(500); await ctrlShiftT(b);
    await b.waitForFunction(() => document.getElementById('test-runner')?.classList.contains('visible'), { timeout: 30000 }); assert.ok(await runnerVisible(b), 'Ctrl+Shift+T shows the runner on a fixture origin'); await b.close();
  }, { server: { board: makeBoardFixture() } });
});

test('P1 EXACT MATCH: ?contest=1 and ?x=test do not load tests.js or show the runner', { timeout: 120000 }, async () => {
  await withBrowserServer(async ({ server, browser }) => {
    for (const q of ['?contest=1', '?x=test']) {
      const p = await browser.newPage(); const reqs = []; p.on('request', (r) => reqs.push(r.url())); await p.goto(`${server.baseUrl}/${q}`, { waitUntil: 'domcontentloaded' }); await sleep(2500);
      assert.equal(reqs.some((u) => /\/tests\.js/.test(u)), false, `${q}: tests.js was NOT requested`); assert.equal(await runnerVisible(p), false, `${q}: the runner is not shown`); await p.close();
    }
  }, { server: { board: makeBoardFixture() } });
});

test('P2 THE URL DOOR, SIMULATED LIVE ORIGIN: /?test requests no tests.js, shows no runner, makes no write', { timeout: 120000 }, async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const p = await browser.newPage(); const live = await openSimulatedLive(p, server.baseUrl, '/?test'); await sleep(3000);
    try { assert.equal(loadedTests(live.seen), false, 'tests.js was NOT requested on the simulated live origin'); assert.equal(await runnerVisible(p), false, 'the runner is not shown'); assert.deepEqual(writes(live.seen), [], 'no write was made'); } finally { live.check(); await p.close(); }
  }, { server: { board: makeBoardFixture() } });
});

test('P3 THE KEYBOARD DOOR, SIMULATED LIVE ORIGIN: Ctrl+Shift+T requests no tests.js, shows no runner, makes no write', { timeout: 120000 }, async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const p = await browser.newPage(); const live = await openSimulatedLive(p, server.baseUrl, '/'); await sleep(1500); await ctrlShiftT(p); await sleep(4000);
    try { assert.equal(loadedTests(live.seen), false, `tests.js was NOT requested on the simulated live origin after Ctrl+Shift+T (requests: ${JSON.stringify(live.seen.filter((r) => /tests/.test(r.path)))})`); assert.equal(await runnerVisible(p), false, 'the runner is not shown'); assert.deepEqual(writes(live.seen), [], `no write was made (${JSON.stringify(writes(live.seen).slice(0, 4))})`); } finally { live.check(); await p.close(); }
  }, { server: { board: makeBoardFixture() } });
});
