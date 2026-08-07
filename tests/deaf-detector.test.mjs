/**
 * #726 — detect deafness directly, at the request that proves the seat is alive.
 *
 * BACKGROUND, because the design is the interesting part and it cost two seats a
 * day to find. Deafness (#624) is: a session whose SSE stream is gone while the
 * client is still running — it receives nothing, with no queue and no replay, and
 * cannot detect this from the inside.
 *
 * Two inference-based attempts failed, for DIFFERENT reasons:
 *
 *   aggregate deltas   `receivers` fell while `sessions` held → "deafness".
 *                      But REAP_IDLE_MS (300000) equals the watch tick (300s), so
 *                      an ordinary disconnect produces that exact signature for
 *                      one tick while its session lingers as a ghost. The label
 *                      was decided by PHASE.
 *
 *   log forensics      "stream closed and the session was never reaped" → alive.
 *                      But a session exits by TWO paths and only the reaper was
 *                      enumerated; `transport.onclose` (:1230) deletes silently.
 *                      All five "confirmed" events had their session close 1–47ms
 *                      BEFORE the stream: clean disconnects.
 *
 * The direct test has no inference chain: a non-GET request arriving on a session
 * that HELD a stream and now holds none is a client that is provably ALIVE (it is
 * asking for something right now) and provably NOT RECEIVING.
 *
 * Why the request site and not `res.on('close')`: at close, a DEPARTING client
 * also has openStreamCount→0 and is also still in `transports`, for the 1–47ms
 * before onclose runs. At the request site there is no window — onclose deletes
 * sessionMeta, so a departed session 404s at :1258 and never reaches the check.
 * Absence from the map does the work an ordering check would have to do.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPair, mcpSession, openChannelStream } from './helpers/harness.mjs';

const DEAF = /\[#726\] DEAF/;
const deafLines = (s) => s.split('\n').filter((l) => DEAF.test(l));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll the captured stdout until `re` appears, or give up. */
async function waitFor(mcp, re, timeoutMs = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (re.test(mcp.stdoutText())) return true;
    await sleep(50);
  }
  return false;
}

test('#726 a live session that LOST its stream is reported deaf on its next request', async (t) => {
  const { rest, mcp } = await startPair();
  t.after(async () => { await mcp.stop(); await rest.stop(); });

  const s = await mcpSession(mcp.mcpUrl);
  const stream = await openChannelStream(mcp.mcpUrl, s.sessionId);
  await sleep(150);

  // While the stream is held, tool calls must NOT be reported deaf.
  await s.callTool('board_status', {});
  await sleep(150);
  assert.equal(deafLines(mcp.stdoutText()).length, 0, 'a session holding a stream is not deaf');

  // Lose the stream, keep the session: this is exactly #624.
  stream.close();
  await sleep(300);

  await s.callTool('board_status', {});
  assert.ok(await waitFor(mcp, DEAF), 'a request on a stream-less live session must report deaf');
  const line = deafLines(mcp.stdoutText())[0];
  assert.match(line, new RegExp(s.sessionId), 'the report must name the session');
});

test('#726 the report LATCHES — one episode logs once, not once per call', async (t) => {
  const { rest, mcp } = await startPair();
  t.after(async () => { await mcp.stop(); await rest.stop(); });

  const s = await mcpSession(mcp.mcpUrl);
  const stream = await openChannelStream(mcp.mcpUrl, s.sessionId);
  await sleep(150);
  stream.close();
  await sleep(300);

  for (let i = 0; i < 4; i++) await s.callTool('board_status', {});
  await sleep(300);
  assert.equal(deafLines(mcp.stdoutText()).length, 1,
    'four calls while deaf are ONE episode — alert fatigue killed the last watch (#666)');
});

test('#726 recovery clears the latch, so a SECOND deafening is reported', async (t) => {
  const { rest, mcp } = await startPair();
  t.after(async () => { await mcp.stop(); await rest.stop(); });

  const s = await mcpSession(mcp.mcpUrl);
  const a = await openChannelStream(mcp.mcpUrl, s.sessionId);
  await sleep(150);
  a.close(); await sleep(300);
  await s.callTool('board_status', {});          // episode 1
  await waitFor(mcp, DEAF);

  const b = await openChannelStream(mcp.mcpUrl, s.sessionId);   // recovered
  await sleep(200);
  b.close(); await sleep(300);
  await s.callTool('board_status', {});          // episode 2

  const t0 = Date.now();
  while (Date.now() - t0 < 3000 && deafLines(mcp.stdoutText()).length < 2) await sleep(50);
  assert.equal(deafLines(mcp.stdoutText()).length, 2, 'a new deafening after recovery is new news');
});

// ── NEGATIVE CONTROLS ───────────────────────────────────────────────────────
// Without these, an implementation that logs DEAF unconditionally passes
// everything above.

test('#726 NEGATIVE: a tool-only client that never opens a stream is NOT deaf', async (t) => {
  const { rest, mcp } = await startPair();
  t.after(async () => { await mcp.stop(); await rest.stop(); });

  // This is `healthcheck`: it makes tool calls and never opens a GET stream —
  // 0 appearances across 512 stream-holding sessions in the production log. It
  // is not deaf, it never asked to listen. A detector keyed only on "no stream
  // + making requests" flags it on every single call, forever.
  const s = await mcpSession(mcp.mcpUrl);
  for (let i = 0; i < 3; i++) await s.callTool('board_status', {});
  await sleep(400);

  assert.equal(deafLines(mcp.stdoutText()).length, 0,
    'never having held a stream is not the same as having lost one');
});

test('#726 NEGATIVE: a client that disconnects cleanly is not reported', async (t) => {
  const { rest, mcp } = await startPair();
  t.after(async () => { await mcp.stop(); await rest.stop(); });

  // The five events that fooled the log-forensics pass: session closed 1–47ms
  // BEFORE the stream. Nothing follows a real goodbye, so nothing can reach the
  // check — and any request on the dead session 404s at :1258.
  const s = await mcpSession(mcp.mcpUrl);
  const stream = await openChannelStream(mcp.mcpUrl, s.sessionId);
  await sleep(150);
  stream.close();
  await sleep(400);
  // No further requests — the client is gone.
  assert.equal(deafLines(mcp.stdoutText()).length, 0,
    'a departed client is silent; silence must not be reported as deafness');
});

test('#726 ANTI-VACUITY: the harness can actually observe a DEAF line', async (t) => {
  const { rest, mcp } = await startPair();
  t.after(async () => { await mcp.stop(); await rest.stop(); });

  const s = await mcpSession(mcp.mcpUrl);
  const stream = await openChannelStream(mcp.mcpUrl, s.sessionId);
  await sleep(150);
  stream.close(); await sleep(300);
  await s.callTool('board_status', {});
  assert.ok(await waitFor(mcp, DEAF),
    'if this fails, every negative control above passes for the wrong reason');
});
