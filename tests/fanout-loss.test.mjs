/**
 * #624/#726 — count the loss at the point of loss.
 *
 * A day of work established that this is not a detection problem and not an
 * alarm problem. The candidate alarms all failed on BASE RATE, not on
 * discrimination:
 *
 *   writableEnded=false alone                     ~1,175/day   unusable
 *   …AND no reopen within the grace window          ~165/day   still unusable
 *   request-site "live session lost its stream"     0 in 4 wks  fires on nothing
 *
 * Meanwhile the fault with actual cost is small and specific: 17 messages, over
 * ~11 weeks, were broadcast while a given session held no stream. #624 means
 * they were never queued and never replayed — those sessions simply never saw
 * them. Establishing that took two seats a day of log archaeology, and it can
 * only ever be answered retrospectively.
 *
 * broadcastFanout already computes the answer and throws it away: it filters
 * `transports` down to sessions with an open stream, and returns only
 * `targets.length`. The complement of that filter IS the loss.
 *
 * So this logs an accounting line, not a warning. No threshold, no cooldown, no
 * latch — the lesson of the day is that every threshold we picked was wrong, and
 * a count needs none. If the rate turns out to matter, the rate will say so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPair, mcpSession, openChannelStream } from './helpers/harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOSS = /\[#624\] fanout/;
const lossLines = (s) => s.split('\n').filter((l) => LOSS.test(l));

function post(baseUrl, body, author) {
  return fetch(`${baseUrl}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body, author }),
  });
}

test('#624 a broadcast reports how many registered sessions it could NOT reach', async (t) => {
  const { rest, mcp } = await startPair();
  t.after(async () => { await mcp.stop(); await rest.stop(); });

  const listening = await mcpSession(mcp.mcpUrl);
  const stream = await openChannelStream(mcp.mcpUrl, listening.sessionId);
  // Must have HELD a stream to count as loss — a session that never asked to
  // listen is toolOnly, not missed (see the floor-problem test below).
  const deaf = await mcpSession(mcp.mcpUrl);
  const deafStream = await openChannelStream(mcp.mcpUrl, deaf.sessionId);
  await sleep(200);
  deafStream.close();                          // asked to listen, then lost it
  await sleep(250);

  await post(rest.baseUrl, 'hello the room', 'test-author');
  await sleep(600);

  const lines = lossLines(mcp.stdoutText());
  assert.equal(lines.length, 1, 'every broadcast accounts for itself, exactly once');
  assert.match(lines[0], /delivered=1/, 'one session held a stream');
  assert.match(lines[0], /missed=1/, 'one registered session could not be reached');
  assert.match(lines[0], new RegExp(deaf.sessionId), 'the missed session is NAMED, not counted');

  stream.close();
});

test('#624 a fully-reachable broadcast reports missed=0 and stays quiet about it', async (t) => {
  const { rest, mcp } = await startPair();
  t.after(async () => { await mcp.stop(); await rest.stop(); });

  const s = await mcpSession(mcp.mcpUrl);
  const stream = await openChannelStream(mcp.mcpUrl, s.sessionId);
  await sleep(250);

  await post(rest.baseUrl, 'everyone is here', 'test-author');
  await sleep(600);

  const lines = lossLines(mcp.stdoutText());
  assert.equal(lines.length, 1, 'the healthy case is still accounted for — a rate needs a denominator');
  assert.match(lines[0], /missed=0/);
  // NEGATIVE CONTROL: this is an accounting line, never a warning. Every
  // alarm-shaped thing built today failed on base rate; a count that shouts is
  // an alarm with extra steps.
  assert.doesNotMatch(lines[0], /⚠️|WARN|DEAF/, 'accounting, not alarm');
});

test('#624 a tool-only client is toolOnly, NOT missed — the floor problem', async (t) => {
  const { rest, mcp } = await startPair();
  t.after(async () => { await mcp.stop(); await rest.stop(); });

  // ⚠️ THIS TEST ASSERTED THE OPPOSITE UNTIL A REVIEW CAUGHT IT, and the
  // original was wrong in the way that has cost the most today: the code comment
  // correctly said "a tool-only client is registered, unreachable, and perfectly
  // healthy" — and the NUMBER counted it as loss anyway.
  //
  // Live measurement at review time: 12 sessions, 7 receivers, and all 5 of the
  // "missed" were one tool-only healthcheck fleet holding 5 sessions and 0
  // streams. Every fanout line would have read missed=5 forever, ~350-500 times
  // a day, so `missed=0` could never occur and the healthy reading was
  // indistinguishable from the unhealthy one. A floor of 100% benign traffic
  // destroys the denominator argument that justifies logging the healthy path.
  //
  // The discriminator is `everHadStream`, already built one file over for
  // exactly this: asked to listen vs never asked.
  await mcpSession(mcp.mcpUrl);      // registers, never opens a stream
  await sleep(250);

  await post(rest.baseUrl, 'anyone?', 'test-author');
  await sleep(600);

  const lines = lossLines(mcp.stdoutText());
  assert.equal(lines.length, 1);
  assert.match(lines[0], /delivered=0/);
  assert.match(lines[0], /missed=0/, 'never asked to listen is NOT loss');
  assert.match(lines[0], /toolOnly=1/, 'but it is still real information about who is connected');
});

test('#624 ANTI-VACUITY: the harness can observe an accounting line at all', async (t) => {
  const { rest, mcp } = await startPair();
  t.after(async () => { await mcp.stop(); await rest.stop(); });

  const s = await mcpSession(mcp.mcpUrl);
  const stream = await openChannelStream(mcp.mcpUrl, s.sessionId);
  await sleep(250);
  await post(rest.baseUrl, 'ping', 'test-author');
  await sleep(600);

  assert.ok(lossLines(mcp.stdoutText()).length > 0,
    'if this fails, every assertion above passes over an empty array');
  stream.close();
});

/**
 * #784 — THE COUNTER IS BLIND TO THE LARGEST CAUSE OF LOSS.
 *
 * `missed` is computed from `[...transports.keys()]` — sessions that STILL
 * EXIST with no open stream. But `transport.onclose` deletes a departed session
 * from `transports` before any later fanout classifies it:
 *
 *   stream dies, session survives   → counted as missed         ✅ visible
 *   session dies entirely           → counted as NOTHING        ⛔ invisible
 *
 * And the destroyed-session case is the ORDINARY one: every gateway restart,
 * every MCP restart, every client reconnect, every spec-DELETE. Measured live
 * on 2026-08-11 — an anonymous session held a stream, was DELETEd, and the four
 * following fanouts all printed `missed=0`.
 *
 * ⇒ So the instrument named for the loss cannot see the largest cause of it,
 *   and reads HEALTHY while doing so. That is why the #624 accounting has
 *   looked quiet through incidents the room knows happened.
 *
 * The discriminator is the same one `missed` already uses — `everHadStream`.
 * A session that never asked to listen and then departed is not loss, exactly
 * as a tool-only session that stays is not loss (the floor problem, #624).
 */
test('#784 a session that HELD a stream and then DEPARTED is counted, not vanished', async (t) => {
  const { rest, mcp } = await startPair();
  t.after(async () => { await mcp.stop(); await rest.stop(); });

  const listening = await mcpSession(mcp.mcpUrl);
  const stream = await openChannelStream(mcp.mcpUrl, listening.sessionId);

  // A seat that asked to listen, then had its whole SESSION destroyed —
  // a gateway restart, a reconnect, or the MCP spec's own DELETE.
  const leaving = await mcpSession(mcp.mcpUrl);
  const leavingStream = await openChannelStream(mcp.mcpUrl, leaving.sessionId);
  await sleep(200);
  leavingStream.close();
  await fetch(mcp.mcpUrl, {
    method: 'DELETE',
    headers: { 'mcp-session-id': leaving.sessionId, 'MCP-Protocol-Version': '2025-06-18' },
  });
  await sleep(250);

  await post(rest.baseUrl, 'who is still here', 'test-author');
  await sleep(600);

  const lines = lossLines(mcp.stdoutText());
  assert.equal(lines.length, 1, 'every broadcast accounts for itself, exactly once');
  assert.match(lines[0], /delivered=1/, 'one session held a stream');

  // ⛔ The defect: today this reads missed=0 and says nothing else. A departed
  // listener must not be silently absent from the accounting.
  assert.match(lines[0], /departed=1/,
    'a session that held a stream and was destroyed must be COUNTED');
  assert.match(lines[0], new RegExp(leaving.sessionId),
    'the departed session is NAMED, not merely counted — a scalar cannot be investigated (#727)');

  stream.close();
});

test('#784 a session that NEVER held a stream and departs is NOT loss — the floor problem again', async (t) => {
  const { rest, mcp } = await startPair();
  t.after(async () => { await mcp.stop(); await rest.stop(); });

  const listening = await mcpSession(mcp.mcpUrl);
  const stream = await openChannelStream(mcp.mcpUrl, listening.sessionId);

  // Tool-only: initialised, used, departed. It never asked to listen, so its
  // departure is not a delivery failure — the same reasoning that keeps a
  // resident tool-only client out of `missed`. Without this, every healthcheck
  // reconnect would inflate `departed` forever and the number would be as
  // useless as `missed=5` was before `everHadStream` existed.
  const toolOnly = await mcpSession(mcp.mcpUrl);
  await fetch(mcp.mcpUrl, {
    method: 'DELETE',
    headers: { 'mcp-session-id': toolOnly.sessionId, 'MCP-Protocol-Version': '2025-06-18' },
  });
  await sleep(250);

  await post(rest.baseUrl, 'still only one listener', 'test-author');
  await sleep(600);

  const lines = lossLines(mcp.stdoutText());
  assert.equal(lines.length, 1);
  assert.match(lines[0], /departed=0/, 'never asked to listen is NOT loss, departed or not');

  stream.close();
});
