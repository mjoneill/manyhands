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
  const deaf = await mcpSession(mcp.mcpUrl);   // registered, no stream — the loss
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

test('#624 a tool-only client counts as missed — it is registered and unreachable', async (t) => {
  const { rest, mcp } = await startPair();
  t.after(async () => { await mcp.stop(); await rest.stop(); });

  // healthcheck's shape: makes calls, never opens a stream. It is NOT deaf —
  // it never asked to listen — but a broadcast genuinely does not reach it, and
  // this line measures reach, not deafness. Conflating those two is what made
  // three previous designs wrong; keeping them separate is why this one counts
  // instead of warning.
  await mcpSession(mcp.mcpUrl);
  await sleep(250);

  await post(rest.baseUrl, 'anyone?', 'test-author');
  await sleep(600);

  const lines = lossLines(mcp.stdoutText());
  assert.equal(lines.length, 1);
  assert.match(lines[0], /delivered=0/);
  assert.match(lines[0], /missed=1/);
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
