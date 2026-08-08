/**
 * #736 — the browser/server lifecycle helper.
 *
 * THE DEFECT THIS EXISTS TO MAKE UNWRITABLE. Every puppeteer test file had:
 *
 *   const server  = await startRestServer({...});   // spawns server.js
 *   const browser = await puppeteer.launch({...});  // <- OUTSIDE the try
 *   try { ... } finally { await browser.close(); await server.stop(); }
 *
 * If `launch()` hangs or throws, `finally` is never entered, `server.stop()` is
 * never called, and the spawned server.js is abandoned. An unkilled child pins
 * its parent's event loop open (measured by a second seat: still alive at 8s with an
 * unref'd watchdog), so the test FILE never exits. `node --test` releases output
 * per file in sort order, so every later file's output is withheld behind it:
 * silence, zero `not ok`, past the watcher's 900s kill. That is the 2026-08-08
 * artifact, and it needs no port collision anywhere.
 *
 * ⚠️ WHY MOVING launch() INSIDE THE try IS NOT THE FIX (a peer seat). `finally` is not
 * entered until the awaited promise SETTLES. A launch that hangs never settles, so
 * it strands the server whether or not it sits inside a try. Try-placement only
 * repairs launches that THROW. The fix is BOUNDED ACQUISITION.
 *
 * ⚠️ WHY p.kill() IS NOT ENOUGH (a peer seat). Puppeteer spawns Chrome `detached: true`
 * on POSIX precisely so the tree can be group-killed. Killing the bare pid leaves
 * renderers behind — trading a server-orphan class for a browser-orphan class,
 * which would look exactly like success.
 *
 * ⚠️ WHY Promise.race([close, timeout]) IS NOT ENOUGH. It converts a hang into a
 * failure while preserving the orphan the fix exists to prevent. The server must
 * be stopped on EVERY settled path, including the timeout path.
 *
 * A convention would not have held: the card's own author wrote two fresh
 * instances of this defect an hour after describing it, by matching the
 * surrounding file. So the helper has to make the correct shape the only
 * reachable one, not the remembered one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withBrowserServer } from './helpers/harness.mjs';

/** A server double that records whether it was stopped. */
const fakeServer = () => {
  const rec = { stopped: 0, baseUrl: 'http://127.0.0.1:0' };
  rec.stop = async () => { rec.stopped += 1; };
  return rec;
};

/** A browser double; `closeBehaviour` lets a test make close() hang. */
const fakeBrowser = (closeBehaviour) => {
  const rec = { closed: 0, killedGroup: [], killedPid: [] };
  rec.close = async () => { rec.closed += 1; if (closeBehaviour) await closeBehaviour(); };
  rec.process = () => ({ pid: 424242 });
  return rec;
};

const never = () => new Promise(() => {});

test('#736 happy path: body runs, then BOTH browser and server are torn down', async () => {
  const server = fakeServer();
  const browser = fakeBrowser();
  let ran = 0;
  await withBrowserServer(async (ctx) => {
    ran += 1;
    assert.equal(ctx.server, server, 'body receives the server');
    assert.equal(ctx.browser, browser, 'body receives the browser');
  }, { _startServer: async () => server, _launch: async () => browser });

  assert.equal(ran, 1);
  assert.equal(browser.closed, 1, 'browser closed');
  assert.equal(server.stopped, 1, 'server stopped');
});

test('#736 a launch that HANGS is bounded, and the server is STILL stopped', async () => {
  // The load-bearing case. Pre-fix this stranded server.js forever and pinned
  // the test process open; the whole 08-08 silence follows from it.
  const server = fakeServer();
  let threw;
  try {
    await withBrowserServer(async () => { assert.fail('body must not run'); }, {
      _startServer: async () => server,
      _launch: never,               // never settles
      launchTimeoutMs: 150,
    });
  } catch (e) { threw = e; }

  assert.ok(threw, 'a hanging launch must fail, not hang');
  assert.match(threw.message, /launch/i);
  assert.equal(server.stopped, 1,
    'THE defect: an unbounded launch left server.js running and pinned the process open');
});

test('#736 a launch that THROWS also stops the server', async () => {
  const server = fakeServer();
  await assert.rejects(
    withBrowserServer(async () => {}, {
      _startServer: async () => server,
      _launch: async () => { throw new Error('chrome missing'); },
    }),
    /chrome missing/);
  assert.equal(server.stopped, 1, 'the throwing path must not strand the server either');
});

test('#736 a close() that HANGS is bounded, the process GROUP is killed, and the server still stops', async () => {
  const server = fakeServer();
  const browser = fakeBrowser(never);      // close() never settles
  const kills = [];
  await withBrowserServer(async () => {}, {
    _startServer: async () => server,
    _launch: async () => browser,
    closeTimeoutMs: 150,
    _kill: (target, sig) => kills.push([target, sig]),
  });

  assert.equal(server.stopped, 1,
    'criterion 5: server.stop() must be reachable on the timeout path, not only the clean one');
  assert.deepEqual(kills, [[-424242, 'SIGKILL']],
    'criterion 4: NEGATIVE pid — a bare pid leaves renderers and trades one orphan class for another');
});

test('#736 a body that throws still tears both down, and the error reaches the caller', async () => {
  const server = fakeServer();
  const browser = fakeBrowser();
  await assert.rejects(
    withBrowserServer(async () => { throw new Error('assertion failed'); }, {
      _startServer: async () => server, _launch: async () => browser,
    }),
    /assertion failed/);
  assert.equal(browser.closed, 1);
  assert.equal(server.stopped, 1, 'a failing test must not leak a server');
});

test('#736 a server.stop() that itself throws does not mask the body error', async () => {
  const server = fakeServer();
  server.stop = async () => { throw new Error('stop exploded'); };
  await assert.rejects(
    withBrowserServer(async () => { throw new Error('the real failure'); }, {
      _startServer: async () => server, _launch: async () => fakeBrowser(),
    }),
    /the real failure/,
    'teardown noise must not replace the diagnosis');
});

test('#736 ANTI-VACUITY: the doubles can actually record, so the assertions above are not empty', async () => {
  const server = fakeServer();
  const browser = fakeBrowser();
  assert.equal(server.stopped, 0);
  await server.stop(); await browser.close();
  assert.equal(server.stopped, 1, 'if this fails every "stopped === 1" above is meaningless');
  assert.equal(browser.closed, 1);
});

test('#736 INTEGRATION: real puppeteer + real server.js — it works, and it leaves nothing behind', async () => {
  // The doubles above prove the lifecycle logic. This proves the helper actually
  // drives the real things it will be wrapping, and — the part that matters for
  // this card — that the real server child is gone afterwards rather than
  // orphaned. A green unit suite over fakes would not have shown that.
  const { makeBoardFixture, PROJECT_DIR } = await import('./helpers/harness.mjs');
  let seenTitle, baseUrl;

  await withBrowserServer(async ({ server, browser }) => {
    baseUrl = server.baseUrl;
    const page = await browser.newPage();
    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    seenTitle = await page.title();
  }, {
    server: { board: makeBoardFixture(), staticDir: PROJECT_DIR },
    launch: { headless: 'new', args: ['--no-sandbox'] },
  });

  assert.ok(typeof seenTitle === 'string' && seenTitle.length > 0,
    'the body really drove a real browser against a real server');

  // "leaves nothing behind" has to be CHECKED, not just claimed in the title —
  // a name asserting a guarantee the body never tests is the #711 defect class.
  // The observable is that the abandoned-server symptom is absent: nothing is
  // still serving on that port.
  let stillServing = false;
  try {
    await fetch(`${baseUrl}/api/board`, { signal: AbortSignal.timeout(2000) });
    stillServing = true;
  } catch { /* refused/aborted — the child is gone, which is the point */ }
  assert.equal(stillServing, false,
    `${baseUrl} still answers after teardown — the server.js child was orphaned, ` +
    'which is precisely the leak this helper exists to prevent');
});
