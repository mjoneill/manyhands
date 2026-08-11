/**
 * #787 — SIGTERM must actually end this process.
 *
 * `shutdown()` called `httpServer.close(() => process.exit(0))` and nothing
 * else. `close()` stops accepting NEW connections and then waits for EXISTING
 * ones to finish — and this server's entire purpose is held-open SSE streams,
 * which never finish. So the callback never fired, `process.exit(0)` never ran,
 * and the process survived in a state our logs have no name for: listening
 * socket closed, process alive, reaping idle sessions every 60s for nobody.
 *
 * ⚠️ AND IT DEFEATED THE SUPERVISION. launchd's `KeepAlive` restarts a job when
 * its process EXITS. This one did not exit, so launchd saw a healthy job and
 * did nothing. The outage was permanent until a human noticed — on 2026-08-11
 * that took about seven minutes, and only because an unrelated post failed.
 *
 * ⚠️ WHY THE SUITE NEVER CAUGHT IT: the harness's `stop()` sends SIGKILL. Every
 * test in this repo has torn servers down with the one signal that cannot reach
 * `shutdown()`. The defect lived in a path the tests structurally never took.
 *
 * ── The acceptance below is the room's, not mine alone ──────────────────────
 *   1  a held SSE stream cannot prevent exit
 *   2  a reconnect DURING shutdown cannot extend it   ⇐ the race in my own
 *      first proposed fix, caught by @minimo: destroying connections BEFORE
 *      close() leaves a window where a client reconnects and re-arms the hang
 *   3  two signals produce ONE sequence — @minimo, and not hypothetical: two
 *      seats restarted this service within minutes of each other that morning
 *   4  it exits within the bound even if cleanup callbacks NEVER fire
 *   5  POSITIVE CONTROL — with no connections it still exits PROMPTLY, so the
 *      ordinary path does not regress into always waiting for the floor
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startRestServer, startMcpServer, mcpSession, openChannelStream, freePort } from './helpers/harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The hard floor the server promises. Tests allow slack, never less. */
const FLOOR_MS = 5000;
const GRACE_MS = 3000;

async function pair() {
  const rest = await startRestServer();
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  return { rest, mcp };
}

// ── 1 + 4: the defect itself ────────────────────────────────────────────────

test('#787 a HELD SSE STREAM cannot prevent exit — SIGTERM ends the process', async (t) => {
  const { rest, mcp } = await pair();
  t.after(async () => { await mcp.stop(); await rest.stop(); });

  const s = await mcpSession(mcp.mcpUrl);
  const stream = await openChannelStream(mcp.mcpUrl, s.sessionId);
  await sleep(200);                       // the stream is genuinely held

  mcp.signal('SIGTERM');
  const exit = await mcp.waitExit(FLOOR_MS + GRACE_MS);

  assert.ok(exit, `the process did not exit within ${FLOOR_MS + GRACE_MS}ms — `
    + 'a held stream is preventing shutdown, which is the whole defect');
  try { stream.close(); } catch { /* already destroyed by the server */ }
});

test('#787 exit happens even if the close callback never fires — the hard floor', async (t) => {
  // Belt and braces: whatever cleanup does, the process must not outlive the
  // stated bound. A cleanup path that CAN hang must never be the only route out.
  const { rest, mcp } = await pair();
  t.after(async () => { await mcp.stop(); await rest.stop(); });

  const s = await mcpSession(mcp.mcpUrl);
  await openChannelStream(mcp.mcpUrl, s.sessionId);
  const s2 = await mcpSession(mcp.mcpUrl);
  await openChannelStream(mcp.mcpUrl, s2.sessionId);   // two held streams
  await sleep(200);

  mcp.signal('SIGTERM');
  const exit = await mcp.waitExit(FLOOR_MS + GRACE_MS);
  assert.ok(exit, 'two held streams must not outlive the floor either');
});

// ── 2: the race in my own first fix ─────────────────────────────────────────

test('#787 a RECONNECT during shutdown is refused and cannot extend exit', async (t) => {
  // ⚠️ This is the case that would have passed a quiescent-client test and
  // failed in production. Destroying connections before close() leaves the
  // listener open; a seat reconnects into that window and re-arms the hang.
  // Our seats reconnect within seconds, so the window is not theoretical.
  const { rest, mcp } = await pair();
  t.after(async () => { await mcp.stop(); await rest.stop(); });

  const s = await mcpSession(mcp.mcpUrl);
  await openChannelStream(mcp.mcpUrl, s.sessionId);
  await sleep(200);

  mcp.signal('SIGTERM');
  await sleep(150);                        // land inside the shutdown window

  // The listener must already be closed: a new connection is refused, not served.
  let refused = false;
  try {
    const res = await fetch(mcp.healthUrl, { signal: AbortSignal.timeout(1500) });
    refused = !res.ok;
  } catch { refused = true; }              // ECONNREFUSED is the expected shape
  assert.equal(refused, true, 'the listener must stop accepting the moment shutdown begins');

  const exit = await mcp.waitExit(FLOOR_MS + GRACE_MS);
  assert.ok(exit, 'a reconnect attempt during shutdown must not extend the deadline');
});

// ── 3: reentrancy — @minimo's, and it already happened to us ────────────────

test('#787 TWO signals produce ONE shutdown sequence, and it still exits', async (t) => {
  const { rest, mcp } = await pair();
  t.after(async () => { await mcp.stop(); await rest.stop(); });

  const s = await mcpSession(mcp.mcpUrl);
  await openChannelStream(mcp.mcpUrl, s.sessionId);
  await sleep(200);

  mcp.signal('SIGTERM');
  await sleep(50);
  mcp.signal('SIGTERM');                   // crossed operators, for real
  mcp.signal('SIGINT');                    // and a different signal too

  const exit = await mcp.waitExit(FLOOR_MS + GRACE_MS);
  assert.ok(exit, 'repeated signals must not throw, race, or wedge the exit');

  const log = mcp.stdoutText();
  const announcements = (log.match(/shutting down/g) || []).length;
  assert.equal(announcements, 1,
    `shutdown announced ${announcements} times — later signals must be no-ops, `
    + 'not a second sequence with a competing deadline');
});

// ── 5: POSITIVE CONTROL — the ordinary path must not regress ────────────────

test('#787 POSITIVE CONTROL — with NO connections it exits PROMPTLY, not at the floor', async (t) => {
  // Without this, "always wait 5s then die" would pass every test above while
  // making every ordinary restart five seconds slower — a fix that trades a
  // hang for a tax, and nothing would have said so.
  const { rest, mcp } = await pair();
  t.after(async () => { await mcp.stop(); await rest.stop(); });

  mcp.signal('SIGTERM');
  const exit = await mcp.waitExit(FLOOR_MS + GRACE_MS);

  assert.ok(exit, 'an idle server must exit on SIGTERM');
  assert.ok(exit.ms < FLOOR_MS - 1000,
    `idle shutdown took ${exit.ms}ms — it must not wait for the ${FLOOR_MS}ms floor `
    + 'when there is nothing to wait for');
});

/**
 * #787 — THE BOUNDED GRACE. @minimo's ruling, and her argument defeated mine.
 *
 * I argued for immediate `closeAllConnections()` on the grounds that a grace
 * period is one more thing that can hang. ⇒ WRONG, and the reason is exact: a
 * fixed timer is not a hangable step — it waits on DURATION, not on cleanup
 * success.
 *
 * A `setTimeout` cannot wedge. My objection applied to waiting on a CALLBACK
 * and I applied it to waiting on a CLOCK — two different things, and the whole
 * point of the hard floor is that clocks are the safe kind of wait.
 *
 * And the cost of immediate truncation is not politeness, which is how I framed
 * it. Immediate closeAllConnections() guarantees the exact side-effect-landed /
 * ACK-lost ambiguity this server already documents elsewhere.
 *
 * ⇒ A POST whose write LANDED but whose response was destroyed leaves the
 *   caller unable to tell whether it happened. That is the same at-least-once
 *   problem #683 spent two days on, arriving through the shutdown path.
 *
 * ── The sequence, hers ──────────────────────────────────────────────────────
 *   1  close() immediately — stop accepting
 *   2  let existing active requests have a short FIXED grace
 *   3  closeAllConnections() when that timer fires
 *   4  an INDEPENDENT hard floor underneath all of it
 *   5  exit promptly via the close() callback when nothing is active
 */

test('#787 GRACE IS HONOURED — a held stream is not killed instantly', async (t) => {
  const rest = await startRestServer();
  const mcp = await startMcpServer({
    restApiBase: rest.baseUrl,
    env: { MCP_SHUTDOWN_GRACE_MS: '1500', MCP_SHUTDOWN_FLOOR_MS: '5000' },
  });
  t.after(async () => { await mcp.stop(); await rest.stop(); });

  const s = await mcpSession(mcp.mcpUrl);
  await openChannelStream(mcp.mcpUrl, s.sessionId);
  await sleep(200);

  mcp.signal('SIGTERM');
  const exit = await mcp.waitExit(9000);

  assert.ok(exit, 'it must still exit');
  // ⭐ BOTH SIDES. Too fast ⇒ the grace was skipped and in-flight work is
  // truncated unconditionally. Too slow ⇒ the force never fired and only the
  // floor saved it. The window proves the grace ran AND ended.
  assert.ok(exit.ms >= 1200,
    `exited in ${exit.ms}ms — faster than the 1500ms grace, so active requests `
    + 'were truncated with no chance to finish');
  assert.ok(exit.ms < 4500,
    `exited in ${exit.ms}ms — that is the 5000ms FLOOR, not the grace. `
    + 'closeAllConnections() never fired and the held stream was never forced');
});

test('#787 POSITIVE CONTROL — an IDLE server exits before the grace, not through it', async (t) => {
  // Step 5 of the shutdown sequence: with no active connections, exit promptly
  // through the close() callback. Without this test, a fix that simply always
  // waits out the grace would pass every test above while taxing every restart.
  const rest = await startRestServer();
  const mcp = await startMcpServer({
    restApiBase: rest.baseUrl,
    env: { MCP_SHUTDOWN_GRACE_MS: '3000', MCP_SHUTDOWN_FLOOR_MS: '9000' },
  });
  t.after(async () => { await mcp.stop(); await rest.stop(); });

  mcp.signal('SIGTERM');
  const exit = await mcp.waitExit(9000);

  assert.ok(exit, 'an idle server must exit on SIGTERM');
  assert.ok(exit.ms < 2000,
    `idle exit took ${exit.ms}ms with a 3000ms grace — it waited out the grace `
    + 'instead of returning through the close() callback, taxing every restart');
});

/**
 * #787 — THE TWO POST DISCRIMINATORS. @minimo's review of the first grace tests.
 *
 * ⇒ ⭐⭐ The held-SSE timing test proves that the grace starts and ends. It does
 *   NOT prove that an in-flight POST can complete and deliver its ACK. That gap
 *   is exactly the shape this card keeps producing: I tested the MECHANISM (a
 *   timer ran for the stated duration) and called it a test of the BENEFIT (a
 *   write's acknowledgement survives). Those
 *   are different claims and only the second one is why the grace exists. A
 *   grace that runs its full duration while destroying every response in flight
 *   would pass GRACE IS HONOURED and fail the users of this server.
 *
 * ── What the grace is actually for ──────────────────────────────────────────
 * The upstream write LANDS on the REST peer and the ACK travels back over the
 * MCP connection. Destroy that connection between those two events and the
 * caller cannot tell whether their post happened — the side-effect-landed /
 * ACK-lost ambiguity, arriving through the shutdown path.
 *
 * ⚠️ THE STUB IS THE INSTRUMENT. A real REST server answers in single-digit
 * milliseconds, so "in flight when the signal arrives" is not a state a test
 * can reliably enter against one. The stub below records the write the instant
 * the request body ends — unconditionally, before any delay — and only THEN
 * waits before answering. So `writes` is ground truth about the side effect,
 * independent of whether the ACK ever came back, which is the whole distinction
 * under test. Both tests below assert on `writes` for exactly that reason:
 * without it, a truncated POST is indistinguishable from one that never ran,
 * and "the write landed" would be an assumption rather than a measurement.
 */

/** A REST peer that lands the write immediately and answers `delayMs` later. */
async function slowRest(delayMs) {
  const writes = [];
  const port = await freePort();
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      writes.push({ method: req.method, url: req.url, body });   // ⭐ the side effect, committed
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'stub-conversation', body: 'stub', author: 'wren',
          attachedTo: null, attachments: [], mentions: [],
          createdAt: '2026-08-11T00:00:00.000Z',
        }));
      }, delayMs).unref();
    });
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    writes,
    /** Count only the POSTs under test — the MCP server may talk to REST for its own reasons. */
    posts: () => writes.filter((w) => w.method === 'POST' && w.url.startsWith('/api/conversations')),
    async close() {
      srv.closeAllConnections?.();
      await new Promise((r) => srv.close(r));
    },
  };
}

/**
 * Bound any promise so a hang fails as a VALUE, never as a stalled test.
 *
 * ⚠️ CALL THIS AT LAUNCH, NOT AT ASSERTION TIME. These POSTs are *expected* to
 * be destroyed mid-flight, and a rejection with no handler yet attached is an
 * unhandledRejection — which node's test runner reports as a suite failure with
 * a stack pointing into undici. Observed exactly that: the truncation worked,
 * and the test failed anyway with `TypeError: terminated`. Attaching the
 * observer when the request STARTS is what makes the rejection an outcome
 * instead of a crash.
 */
function settled(p, ms) {
  return Promise.race([
    p.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })),
    new Promise((r) => setTimeout(() => r({ ok: false, timedOut: true }), ms)),
  ]);
}

test('#787 ⭐ a POST that FITS the grace still gets its ACK — the write is not orphaned', async (t) => {
  // The benefit itself. A post lands upstream, SIGTERM arrives while the ACK is
  // still in flight, and the caller must still learn that it happened.
  const rest = await slowRest(400);
  const mcp = await startMcpServer({
    restApiBase: rest.baseUrl,
    env: { MCP_SHUTDOWN_GRACE_MS: '2500', MCP_SHUTDOWN_FLOOR_MS: '9000' },
  });
  t.after(async () => { await mcp.stop(); await rest.close(); });

  const s = await mcpSession(mcp.mcpUrl);
  const inFlight = settled(s.callTool('conversation_post', { body: 'fits the grace', author: 'wren' }), 6000);
  await sleep(150);                        // genuinely in flight; the write has landed

  assert.equal(rest.posts().length, 1,
    'precondition: the write must already be upstream when the signal arrives, '
    + 'otherwise this test is about connection setup and not about the grace');

  mcp.signal('SIGTERM');
  const res = await inFlight;

  assert.equal(res.ok, true,
    `the in-flight POST did not deliver its ACK (${res.timedOut ? 'timed out' : res.error?.message}) — `
    + 'its write LANDED upstream, so the caller is left unable to tell whether it happened');
  assert.ok(res.value?.result && !res.value.result.isError,
    `expected a tool result, got ${JSON.stringify(res.value)}`);

  const exit = await mcp.waitExit(9000);
  assert.ok(exit, 'and it must still exit afterwards');
});

test('#787 ⭐ a POST that OUTLIVES the grace is truncated, and the floor is not what saves it', async (t) => {
  // The other side. The grace is BOUNDED: a request that will not finish in
  // time gets cut, and the cut comes from closeAllConnections() at the grace —
  // not from the hard floor underneath it. If the floor were doing the work,
  // every hung upstream would tax every restart by the full floor.
  const GRACE = 800, FLOOR = 4000;
  const rest = await slowRest(15000);      // will not finish, by construction
  const mcp = await startMcpServer({
    restApiBase: rest.baseUrl,
    env: { MCP_SHUTDOWN_GRACE_MS: String(GRACE), MCP_SHUTDOWN_FLOOR_MS: String(FLOOR) },
  });
  t.after(async () => { await mcp.stop(); await rest.close(); });

  const s = await mcpSession(mcp.mcpUrl);
  const inFlight = settled(s.callTool('conversation_post', { body: 'outlives the grace', author: 'wren' }), 20000);
  await sleep(150);
  assert.equal(rest.posts().length, 1, 'precondition: the write is upstream');

  mcp.signal('SIGTERM');
  const exit = await mcp.waitExit(FLOOR + 4000);

  assert.ok(exit, 'a stuck upstream must not keep the process alive');
  assert.ok(exit.ms >= GRACE - 100,
    `exited in ${exit.ms}ms — before the ${GRACE}ms grace, so the grace was skipped entirely`);
  assert.ok(exit.ms < FLOOR - 500,
    `exited in ${exit.ms}ms, at the ${FLOOR}ms FLOOR — closeAllConnections() never fired at the `
    + 'grace and the floor did the work, which would tax every restart with a slow upstream');

  const res = await inFlight;
  assert.equal(res.ok, false,
    'a POST that cannot finish inside the grace must be truncated, not waited out');

  // ⚠️ AND THIS IS THE COST, stated rather than hidden: the write LANDED and the
  // caller will never know. That ambiguity is unavoidable at some deadline —
  // the grace only makes it rare instead of universal, which is precisely the
  // argument that beat my "truncate immediately" proposal.
  assert.equal(rest.posts().length, 1,
    'the side effect is upstream even though the ACK was destroyed — this is the '
    + 'at-least-once boundary, and the grace bounds how often it is reached');
});
