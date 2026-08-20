/**
 * #730 — `startPair` must not abandon a started server when its SIBLING
 * acquisition fails or hangs.
 *
 * ⛔ THE LIVE SPECIMEN, preserved 31 hours (pgid 1337, captured on the card):
 *
 *   3394  node --test tests/channel.test.mjs        ppid 1, 1d 02:51 elapsed
 *   3403    node tests/channel.test.mjs
 *   3527      node server.js  127.0.0.1:52420 (LISTEN)
 *
 *   3403 fd 15u  unix 0xe938…310 -> 0x6d41…643
 *   3527 fd  1u  unix 0x6d41…643 -> 0xe938…310      ⇐ THE SAME SOCKET PAIR
 *
 * ⇒ The test process holds the server child's STDOUT. `startRestServer` spawns
 * with `stdio: ['ignore','pipe','pipe']` so it can offer `stderr()` and
 * `waitForStderr()`. An open child-stdio stream is an ACTIVE HANDLE: it keeps
 * the parent's event loop alive with nothing left to do, forever. The test
 * process had NO sockets of its own — it was not waiting on a read.
 *
 * ⚠️ WHAT THE SPECIMEN DOES NOT PROVE (@minimo's correction, taken): MCP's
 * absence NOW does not establish that `startMcpServer` never completed — it may
 * have started and exited later. The specimen is CONSISTENT WITH a failed
 * second acquisition; it is the leading mechanism, not established history.
 *
 * ⭐ The cleanup hole, however, is provable without that history, and that is
 * what these tests pin. #736 solved exactly this for the BROWSER path with
 * `withBrowserServer` — bounded acquisition, teardown on the timeout path,
 * "because `finally` waits for the promise to SETTLE, and a hang never
 * settles." `startPair` kept the unbounded shape.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startPair, makeBoardFixture } from './helpers/harness.mjs';

/** Is anything accepting connections on this port? The orphan's signature. */
const isListening = (port) => new Promise((resolve) => {
  const sock = net.connect({ host: '127.0.0.1', port });
  const done = (v) => { sock.destroy(); resolve(v); };
  sock.on('connect', () => done(true));
  sock.on('error', () => done(false));
  setTimeout(() => done(false), 1500);
});

/**
 * ⚠️ STOPPING IS ASYNCHRONOUS. `stop()` sends SIGKILL and returns; the kernel
 * closes the listening socket a moment later. A single probe fired immediately
 * after therefore races the OS and reports a live port for a server that is
 * already dying — which reads exactly like the orphan this suite exists to
 * detect. (It caught me: the first version of this file failed the HAPPY PATH
 * for this reason and I nearly went looking for the bug in the fix.)
 *
 * So the assertion is "gone within a bound", not "gone this instant". The bound
 * is short enough that a genuine orphan — which survives indefinitely — still
 * fails it.
 */
const waitForClosed = async (port, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await isListening(port))) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

/**
 * ⭐ ACCEPTANCE 1 — the second startup REJECTS after the first has started.
 * The already-started REST server must be stopped.
 */
test('#730 a REJECTING second acquisition must not strand the first server', async () => {
  let restPort = null;
  const boom = new Error('injected: MCP acquisition failed');

  await assert.rejects(
    () => startPair({
      board: makeBoardFixture(),
      _startMcp: async ({ restApiBase }) => {
        restPort = Number(new URL(restApiBase).port);
        throw boom;
      },
    }),
    (e) => e === boom || /injected/.test(e.message),
    'startPair must surface the sibling failure, not swallow it',
  );

  // Vacuity guard: if the injection never ran, the assertion below is vacuous.
  assert.ok(restPort, 'the injected MCP starter never ran — REST was not started, so this proves nothing');

  assert.equal(await waitForClosed(restPort), true,
    `REST server on :${restPort} is STILL LISTENING after startPair threw — this is the orphan that pins a `
    + 'test process open forever (pgid 1337 ran 31 hours in exactly this state)');
});

/**
 * ⭐⭐ ACCEPTANCE 2 — the second startup NEVER SETTLES. A deadline must fire,
 * and the already-started REST server must still be stopped.
 *
 * ⛔ This is the case a plain try/finally cannot reach: `finally` waits for the
 * promise to settle, and a hang never settles. It is the difference between a
 * fix and a fix-shaped comment, and it is the actual 31-hour failure.
 */
test('#730 a HANGING second acquisition must be bounded, and must not strand the first server', async () => {
  let restPort = null;

  await assert.rejects(
    () => startPair({
      board: makeBoardFixture(),
      acquireTimeoutMs: 400,
      // Never resolves. No timer, no handle — exactly what a wedged spawn looks like.
      _startMcp: async ({ restApiBase }) => {
        restPort = Number(new URL(restApiBase).port);
        return new Promise(() => {});
      },
    }),
    /timed out|exceeded|deadline/i,
    'a never-settling acquisition must FAIL on a deadline, not hang the caller',
  );

  assert.ok(restPort, 'the injected MCP starter never ran — this proves nothing');
  assert.equal(await waitForClosed(restPort), true,
    `REST server on :${restPort} survived a bounded-out acquisition — a Promise.race that turns a hang into a `
    + 'failure while keeping the orphan is the defect wearing the fix\'s clothes (#736\'s point 3)');
});

/**
 * ⛔⛔ ACCEPTANCE 2b — THE HOLE IN THE FIRST VERSION OF THIS FIX, found by the
 * Value Steward within minutes of it landing:
 *
 *   "Promise.race does not cancel its losing acquisition. If _startMcp resolves
 *    AFTER the deadline, that late-created server must be stopped rather than
 *    orphaned after the test already failed."
 *
 * ⇒ She is right, and it is this card's own defect one level down: the remedy
 * for an orphaned server, orphaning a server. A race abandons the loser, and an
 * abandoned loser that later succeeds has spawned a real child nobody holds.
 *
 * ⭐ So the deadline path must ADOPT the late arrival rather than discard it.
 */
test('#730 a LATE-RESOLVING acquisition is adopted and stopped, not orphaned by the race', async () => {
  let stopped = false;
  let resolveLate;
  const late = new Promise((res) => { resolveLate = res; });

  await assert.rejects(
    () => startPair({
      board: makeBoardFixture(),
      acquireTimeoutMs: 200,
      _startMcp: () => late,
    }),
    /timed out|exceeded|deadline/i,
    'the deadline must still fire',
  );

  // The acquisition succeeds AFTER the caller has already given up — a real
  // spawn that won the race against nothing.
  resolveLate({ mcpUrl: 'http://127.0.0.1:1/', stop: async () => { stopped = true; } });

  // Give the adoption handler a turn.
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(stopped, true,
    'the late-resolving MCP server was never stopped — Promise.race discarded it, so its child process '
    + 'is orphaned exactly like the one this card exists to remove');
});

/**
 * ⭐ ACCEPTANCE 4 — the happy path is unchanged. A fix that breaks normal
 * startup trades one outage for another; every pair test depends on this.
 */
test('#730 the successful pair still starts and stops cleanly', async () => {
  const pair = await startPair({ board: makeBoardFixture() });
  const restPort = Number(new URL(pair.rest.baseUrl).port);
  const mcpPort = Number(new URL(pair.mcp.mcpUrl).port);

  assert.equal(await isListening(restPort), true, 'REST should be up on the happy path');
  assert.equal(await isListening(mcpPort), true, 'MCP should be up on the happy path');

  await pair.stop();

  assert.equal(await waitForClosed(restPort), true, 'REST must be down after stop()');
  assert.equal(await waitForClosed(mcpPort), true, 'MCP must be down after stop()');
});
