/**
 * #1140 — freePort() is a TOCTOU: it binds port 0, reads the number, CLOSES
 * the socket, and returns. The port is unheld from that close until the
 * caller's own listen(), so under a parallel runner two workers can be handed
 * the same port and whichever binds second dies with EADDRINUSE.
 *
 * Measured in production, CI run 33667372290 attempt 1 on 63638df:
 *
 *   not ok 1486 - #1025 NEGATIVE CONTROL — a FAST save never says "Saving…"
 *     tests/save-feedback.test.mjs:133 · duration_ms 8006.9
 *     REST server failed to start: timed out waiting for
 *     http://127.0.0.1:32985/api/board
 *     stderr: Port 32985 is already in use.
 *
 * Two separate defects live in that one failure and each gets its own test:
 *
 *   1. DIAGNOSIS. The child already knew, instantly — server.js prints "Port N
 *      is already in use" and exits 1 (server.js:6348). The harness ignored the
 *      exit and sat out the full 8 s waitForHttp deadline, then reported a
 *      TIMEOUT. "Timed out waiting for a URL" and "the port was taken" invite
 *      completely different investigations, and the room spent an evening on
 *      the first reading. A bind conflict must fail FAST and say so.
 *
 *   2. CURE. When the harness allocated the port itself, nobody asked for that
 *      particular number — it is an implementation detail, so losing the race
 *      should cost a retry, not a run. When the CALLER passed an explicit port
 *      it is not an implementation detail: they meant that port, and quietly
 *      moving them to another one would break the intent of the tests that do
 *      it (stranger-second-instance asserts on WHICH board an adapter attaches
 *      to). So: retry only what we allocated, and never what was asked for.
 *
 * ⚠️ WHY THESE TESTS FORCE THE WINDOW INSTEAD OF RACING FOR IT. A green suite
 * is this bug's normal state — the collision is probabilistic and a rerun goes
 * green because the race did not fire, which is indistinguishable from a cure.
 * So no test here spawns N workers and hopes. Each one OCCUPIES the port first
 * and then asks the harness to start on it, which is the losing side of the
 * race made deterministic. A test that passes on a machine where nothing is
 * listening is a test that never ran the bug.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { freePort, startRestServer, startMcpServer } from './helpers/harness.mjs';

/**
 * Take a real port and HOLD it — this is the worker that won the race.
 *
 * ⚠️ The squatter ACCEPTS connections and never answers, which is what a
 * half-open peer looks like and is the point. That also means `close()` alone
 * hangs forever waiting on the sockets waitForHttp opened against it, so every
 * accepted socket is tracked and destroyed on release. Without this the whole
 * FILE dies with "Promise resolution is still pending but the event loop has
 * already resolved" and reports `cancelled 5 / fail 0` — an ERRORED suite that
 * reads exactly like a failing one in the summary line.
 */
async function occupy() {
  const port = await freePort();
  const sockets = new Set();
  const squatter = net.createServer((s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve, reject) => {
    squatter.once('error', reject);
    squatter.listen(port, '127.0.0.1', resolve);
  });
  return {
    port,
    release: () => new Promise((r) => {
      for (const s of sockets) s.destroy();
      squatter.close(r);
    }),
  };
}

/**
 * An allocator that hands out `first` once, then delegates to freePort.
 *
 * ⛔ IT COUNTS ITS CALLS, AND THE TESTS ASSERT THE COUNT. Without that these
 * tests are vacuous and I wrote them that way first: `startRestServer` ignores
 * options it does not know, so passing `allocatePort` to the unfixed harness
 * changed nothing — it allocated a fresh port, started cleanly in 118 ms, and
 * the test PASSED without ever meeting the contended port. A green that never
 * ran the bug is the failure mode this whole card is about, so the seam has to
 * prove it was used.
 */
function countingAllocator(first) {
  const state = { calls: 0, handed: [] };
  const fn = async () => {
    state.calls += 1;
    const p = state.calls === 1 ? first : await freePort();
    state.handed.push(p);
    return p;
  };
  fn.state = state;
  return fn;
}

test('#1140 an explicitly-requested port that is TAKEN fails fast and names the conflict — not an 8s timeout', async () => {
  const { port, release } = await occupy();
  try {
    const t0 = Date.now();
    let err = null;
    try {
      const s = await startRestServer({ port });
      await s.stop();
      assert.fail('expected startRestServer to reject on an occupied port');
    } catch (e) {
      err = e;
    }
    const elapsed = Date.now() - t0;

    // The DIAGNOSIS, which is the half that cost the room an evening.
    //
    // ⚠️ Matching /already in use/ alone is VACUOUS here: the harness appends
    // the child's stderr to its message, so the conflict text is present even
    // in the broken version — buried under a headline that says the wrong
    // thing. The defect is the HEADLINE. CI reported "timed out waiting for
    // http://127.0.0.1:32985/api/board" and the room read a starved runner off
    // it for an evening, with the real cause sitting two lines below.
    assert.doesNotMatch(
      err.message,
      /timed out waiting/i,
      `a bind conflict must not be reported as a URL timeout. Got: ${err.message}`,
    );
    assert.match(
      err.message,
      /already in use|EADDRINUSE|port conflict/i,
      `the failure must name the port conflict. Got: ${err.message}`,
    );
    // The child exits within milliseconds; anything near the 8 s waitForHttp
    // deadline means we are still waiting on the URL rather than on the child.
    assert.ok(
      elapsed < 4000,
      `a bind conflict is known at once (server.js:6348 exits 1); took ${elapsed}ms, which is the waitForHttp deadline, not the child`,
    );
  } finally {
    await release();
  }
});

test('#1140 an explicitly-requested port is NEVER silently swapped — the caller meant that port', async () => {
  const { port, release } = await occupy();
  try {
    let baseUrl = null;
    try {
      const s = await startRestServer({ port });
      baseUrl = s.baseUrl;
      await s.stop();
    } catch {
      /* rejecting is the correct behaviour; asserted by the test above */
    }
    // ⛔ ANTI-VACUITY. If the retry logic ever grows to cover explicit ports,
    // stranger-second-instance's "which board did the adapter attach to?"
    // assertions become untestable — the harness would move the board out from
    // under the very question being asked.
    assert.equal(
      baseUrl,
      null,
      `an explicit port must not be reassigned; got ${baseUrl} after asking for ${port}`,
    );
  } finally {
    await release();
  }
});

test('#1140 CURE — a port the HARNESS allocated and then lost is retried, and the server comes up', async () => {
  const { port, release } = await occupy();
  const alloc = countingAllocator(port);
  try {
    const t0 = Date.now();
    const s = await startRestServer({ allocatePort: alloc });
    try {
      // ⛔ ANTI-VACUITY FIRST. If the harness ignored the seam, everything below
      // is a test of a fresh uncontended port — which passes and proves nothing.
      assert.ok(alloc.state.calls >= 1, 'the harness must allocate through the injected allocator');
      assert.equal(alloc.state.handed[0], port, 'attempt 1 must have been the contended port');
      assert.ok(alloc.state.calls >= 2, 'losing the race must cost a SECOND allocation, i.e. a retry');

      const got = Number(new URL(s.baseUrl).port);
      assert.notEqual(got, port, 'the harness must have moved off the contended port');
      const res = await fetch(`${s.baseUrl}/api/board`);
      assert.equal(res.ok, true, 'the retried server is a real server, not just a different number');
      assert.ok(Date.now() - t0 < 15000, 'the retry is a delay, not a second deadline');
    } finally {
      await s.stop();
    }
  } finally {
    await release();
  }
});

test('#1140 CURE — the same retry protects the MCP adapter', async () => {
  const { port, release } = await occupy();
  const alloc = countingAllocator(port);
  try {
    const s = await startMcpServer({ allocatePort: alloc });
    try {
      assert.equal(alloc.state.handed[0], port, 'attempt 1 must have been the contended port');
      assert.ok(alloc.state.calls >= 2, 'losing the race must cost a retry in the adapter too');
    } finally {
      await s.stop();
    }
  } finally {
    await release();
  }
});

test('#1140 ⛔ NEGATIVE CONTROL — the retry is BOUNDED: an always-contended port gives up and names the conflict', async () => {
  // The cure's own hazard, inverted. A retry loop that never gives up turns a
  // deterministic failure into a hang — which is a worse version of the defect
  // this card is about: the 8 s timeout at least ended. So when EVERY port the
  // allocator hands back is occupied, the harness must stop, and it must still
  // say what went wrong rather than reporting a URL timeout.
  const { port, release } = await occupy();
  const alwaysContended = async () => port;
  try {
    const t0 = Date.now();
    await assert.rejects(
      startRestServer({ allocatePort: alwaysContended }),
      (e) => {
        assert.match(
          e.message,
          /already in use|EADDRINUSE|port conflict/i,
          `giving up must still name the cause. Got: ${e.message}`,
        );
        return true;
      },
    );
    assert.ok(
      Date.now() - t0 < 20000,
      'the retry must be bounded — an unbounded loop is a hang wearing a fix\'s clothes',
    );
  } finally {
    await release();
  }
});
