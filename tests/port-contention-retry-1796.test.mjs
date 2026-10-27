/**
 * #1796 — a test that must choose its server's port UP FRONT (so a sibling can be told the URL before the server exists) has an
 * unbounded window between choosing the port and the server binding it, and a stranger that takes the port in that window fails
 * the test with no retry: `#1396 s2` died that way on CI (run 40446872058), in setup, before any assertion.
 *
 * The harness already retries an UNSPECIFIED port (#1140) and a REST+MCP PAIR (#1377), and deliberately never retries an explicit
 * port inside one start (the caller chose it). What was missing is the same rule for a caller that owns the whole sequence:
 * `retryOnPortContention(attemptFn)` runs the whole sequence again, with fresh ports, when and only when the failure is the
 * harness's own lost-the-allocation-race error.
 *
 *   P1  a contended attempt is retried; the next attempt gets its number and its value is what the caller gets
 *   P2  an attempt that succeeds first time runs once
 *   P3  any OTHER failure is rethrown at once, unchanged, and never retried (a real assertion must not be run three times)
 *   P4  it is BOUNDED: always contended, it stops, and the error keeps the harness's text and names the attempts
 *   P5  the contention is REAL here, not simulated: a stranger takes the chosen port before the server binds, the first attempt
 *       fails with the harness's actual error, and the second attempt (a fresh port) starts a working server. This is the card's
 *       RED recipe made deterministic.
 *   P6  through `withBrowserServer`: a contended start inside its body reaches the retry with the message intact, and the
 *       teardown (server stopped, browser closed) ran on each failed attempt, so a retry leaks nothing
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as H from './helpers/harness.mjs';

const have = () => assert.equal(typeof H.retryOnPortContention, 'function', 'PRECONDITION: tests/helpers/harness.mjs exports retryOnPortContention (#1796) — it does not yet');
const contended = (n = 1) => new Error(`MCP server failed to start: port ${40000 + n} was answered by a server I did not start (#1259) — lost the allocation race (#1140) (port was requested explicitly, so it is not retried)\nstderr: `);

test('#1796 P1 — a contended attempt is retried with the next attempt number, and the retry\'s value is returned', async () => {
  have();
  const seen = [];
  const v = await H.retryOnPortContention(async (attempt) => { seen.push(attempt); if (attempt === 1) throw contended(); return `value-${attempt}`; });
  assert.deepEqual(seen, [1, 2], 'the whole sequence ran twice, numbered');
  assert.equal(v, 'value-2');
});

test('#1796 P2 — an attempt that succeeds runs ONCE', async () => {
  have();
  let n = 0;
  assert.equal(await H.retryOnPortContention(async () => { n++; return 'ok'; }), 'ok');
  assert.equal(n, 1);
});

test('#1796 P3 — any other failure is rethrown at once, unchanged: a real assertion is never run again', async () => {
  have();
  let n = 0;
  const original = new assert.AssertionError({ message: 'the seat is in the ring', actual: false, expected: true });
  await assert.rejects(H.retryOnPortContention(async () => { n++; throw original; }), (e) => e === original);
  assert.equal(n, 1, 'one attempt only');
  n = 0;
  await assert.rejects(H.retryOnPortContention(async () => { n++; throw new Error('port 41234 is already in use but the harness text is absent'); }), /already in use but the harness text is absent/);
  assert.equal(n, 1, 'and an error that merely mentions a port is not contention unless it carries the harness\'s own words');
});

test('#1796 P4 — it is BOUNDED: always contended, it stops, keeps the harness\'s text and names the attempts', async () => {
  have();
  let n = 0;
  const err = await H.retryOnPortContention(async () => { n++; throw contended(n); }, { attempts: 3 }).then(() => null, (e) => e);
  assert.ok(err, 'it rejected');
  assert.equal(n, 3, 'exactly the bound, not one more');
  assert.match(err.message, /lost the allocation race/, 'the harness\'s own text survives, so the failure still reads as what it is');
  assert.match(err.message, /3\/3/, 'and it names the attempts');
});

test('#1796 P5 — REAL contention: a stranger takes the chosen port before the server binds; attempt 1 fails with the harness\'s actual error, attempt 2 (a fresh port) starts a working server', async () => {
  have();
  const errors = [];
  const mcp = await H.retryOnPortContention(async (attempt) => {
    const port = await H.freePort();
    let stranger = null;
    if (attempt === 1) {
      stranger = http.createServer((q, r) => r.end('stranger'));
      await new Promise((res, rej) => { stranger.once('error', rej); stranger.listen(port, '127.0.0.1', res); });
    }
    try {
      return await H.startMcpServer({ port });
    } catch (e) { errors.push(e); throw e; } finally {
      if (stranger) await new Promise((res) => stranger.close(res));
    }
  });
  try {
    assert.equal(errors.length, 1, 'exactly one attempt was lost');
    assert.match(errors[0].message, /lost the allocation race/, 'to the harness\'s own contention error (the text the retry keys on)');
    const r = await fetch(mcp.healthUrl);
    assert.equal(r.status, 200, 'and the second attempt\'s server answers');
  } finally { await mcp.stop(); }
});

test('#1796 P6 — through withBrowserServer: the contended start reaches the retry with its message intact, and each failed attempt tore its server and browser down', async () => {
  have();
  const events = [];
  const fakeServer = (id) => ({ baseUrl: `http://127.0.0.1:1/${id}`, stop: async () => { events.push(`server ${id} stopped`); } });
  const fakeBrowser = (id) => ({ close: async () => { events.push(`browser ${id} closed`); }, process: () => null });
  let launches = 0;
  const v = await H.retryOnPortContention(async (attempt) => H.withBrowserServer(async () => {
    if (attempt === 1) throw contended();
    return 'done';
  }, { _startServer: async () => fakeServer(++launches), _launch: async () => fakeBrowser(launches) }));
  assert.equal(v, 'done');
  assert.equal(launches, 2, 'the whole sequence, REST and browser included, ran again');
  assert.deepEqual(events.filter((e) => e.endsWith('stopped') || e.endsWith('closed')).sort(),
    ['browser 1 closed', 'browser 2 closed', 'server 1 stopped', 'server 2 stopped'], 'every attempt stopped what it started');
});
