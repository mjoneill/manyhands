/**
 * #736 (related defect) — waitForHttp's timeout must actually bound the wait.
 *
 * THE DEFECT. The loop evaluated its deadline only BETWEEN attempts:
 *
 *   while (Date.now() < deadline) {
 *     try { await fetch(url); return; } catch (e) { lastErr = e; }
 *     await new Promise((r) => setTimeout(r, 50));
 *   }
 *
 * `await fetch(url)` had no per-request bound, so a peer that ACCEPTS the
 * connection and never answers parks inside the try block and the while
 * condition is never re-tested. The stated bound silently does not apply.
 *
 * MEASURED before the fix, node v22.23.1:
 *
 *   single fetch to a silent listener   → threw after 301.0s (UND_ERR_HEADERS_TIMEOUT)
 *   waitForHttp(url, 8000) against one  → returned after 301.1s
 *
 * So the real ceiling was undici's ~300s header timeout, not the 8000 the caller
 * asked for — a 37.6x overrun. It is exactly ONE attempt: after a 301s fetch the
 * 8s deadline is long past, so the loop exits. (900/301 = 3.0 looks like "three
 * attempts fill the watcher's 15-minute kill", and the code cannot do that. The
 * arithmetic is a coincidence and was nearly taken as confirmation.)
 *
 * Note the distinction the artifact turns on: a REFUSED connection fails fast and
 * loudly. Only connect-and-hang defeats a deadline that ticks between attempts.
 * These tests use a silent listener for that reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { waitForHttp } from './helpers/harness.mjs';

/** A listener that completes the handshake and then says nothing, ever. */
async function silentListener() {
  const server = net.createServer(() => { /* accept; never write, never end */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => server.close() };
}

test('#736 waitForHttp BOUNDS a connect-and-hang peer at its stated timeout', async () => {
  const l = await silentListener();
  const t0 = Date.now();
  try {
    await assert.rejects(
      waitForHttp(`http://127.0.0.1:${l.port}/api/board`, 1500),
      /timed out waiting/,
      'it must fail with its own timeout message, not undici\'s 300s one');
  } finally {
    l.close();
  }
  const elapsed = Date.now() - t0;

  // Generous ceiling: the point is 1.5s-ish vs 301s, not millisecond accuracy.
  assert.ok(elapsed < 15_000,
    `waitForHttp(url, 1500) took ${elapsed}ms. Pre-fix this was 301,100ms — the ` +
    'deadline was only checked between attempts, so a single unbounded fetch ' +
    'sat inside the try for undici\'s full header timeout. An 8s bound that ' +
    'permits 301s is not a loose bound, it is a bound that does not exist.');
});

test('#736 the bound does not come at the cost of the happy path', async () => {
  // A guard that made every successful wait slow, or broke success entirely,
  // would pass the test above while wrecking all 743 tests that depend on this.
  const http = await import('node:http');
  const srv = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const t0 = Date.now();
    await waitForHttp(`http://127.0.0.1:${port}/`, 8000);   // must RESOLVE
    assert.ok(Date.now() - t0 < 5000, 'a live server must still be detected promptly');
  } finally {
    srv.close();
  }
});

test('#736 ANTI-VACUITY: the silent listener really does accept and withhold', async () => {
  // If it refused connections instead, the test above would pass for the wrong
  // reason — refusal fails fast even with the original unbounded fetch, so it
  // could not distinguish fixed from broken.
  const l = await silentListener();
  try {
    let settled = 'pending';
    const p = fetch(`http://127.0.0.1:${l.port}/`, { signal: AbortSignal.timeout(700) })
      .then(() => { settled = 'resolved'; }, (e) => { settled = e.name; });
    await p;
    assert.equal(settled, 'TimeoutError',
      'the peer must ACCEPT and hang; a refused connection would abort instantly ' +
      'with ECONNREFUSED and prove nothing about the deadline');
  } finally {
    l.close();
  }
});
