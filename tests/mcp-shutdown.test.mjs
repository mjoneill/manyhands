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
import { startRestServer, startMcpServer, mcpSession, openChannelStream } from './helpers/harness.mjs';

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
