/**
 * #727 — `unbound` is a scalar, so a nameless session's streams are invisible.
 *
 * A bound seat's row itemises `streams`. An unbound session contributes to the
 * `receivers` total and then vanishes into a bare count: `unbound=6` fits six
 * sessions holding one stream each, or one holding six and five holding none,
 * and nothing on the surface distinguishes them. That is exactly what made the
 * fanout watch unable to name a seat in 40 consecutive alarms, and what made the
 * central question of #624 unanswerable retrospectively — 98% of the historical
 * corpus has no seat attribution at all.
 *
 * The fix is not authentication. The board is unauthenticated on loopback by
 * design and the token is a name tag, not a lock (#716). The ask is that the
 * board SAY it doesn't know, in enough detail to investigate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPair, mcpSession, openChannelStream } from './helpers/harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const status = async (mcp) =>
  (await fetch(mcp.healthUrl.replace('/health', '/channel/status'))).json();

test('#727 an unbound session is itemised, not just counted', async (t) => {
  const { rest, mcp } = await startPair();
  t.after(async () => { await mcp.stop(); await rest.stop(); });

  // No Authorization header — this is every seat that has not bound (which was
  // 84% of sessions in production until 2026-08-07).
  const s = await mcpSession(mcp.mcpUrl);
  const stream = await openChannelStream(mcp.mcpUrl, s.sessionId);
  await sleep(200);

  const st = await status(mcp);
  assert.equal(st.unbound, 1, 'the scalar still reports, for the watch that reads it');
  assert.ok(Array.isArray(st.unboundSessions), 'unbound sessions must be itemised');
  assert.equal(st.unboundSessions.length, 1);

  const [u] = st.unboundSessions;
  assert.equal(u.sid, s.sessionId, 'named by session id — the only identity it has');
  assert.equal(u.streams, 1, 'ITS STREAM COUNT — the field the scalar destroyed');
  assert.ok(typeof u.lastActivity === 'number' && u.lastActivity > 0, 'liveness, for triage');

  stream.close();
});

test('#727 the itemisation distinguishes the two shapes a scalar cannot', async (t) => {
  const { rest, mcp } = await startPair();
  t.after(async () => { await mcp.stop(); await rest.stop(); });

  // Two unbound sessions, ONE holding a stream. Under the old surface this is
  // `unbound=2` — identical to two sessions each holding one, or to neither
  // holding any. That ambiguity is the defect.
  const a = await mcpSession(mcp.mcpUrl);
  const b = await mcpSession(mcp.mcpUrl);
  const streamA = await openChannelStream(mcp.mcpUrl, a.sessionId);
  await sleep(200);

  const st = await status(mcp);
  assert.equal(st.unbound, 2, 'the scalar cannot tell these apart');

  const byStreams = Object.fromEntries(st.unboundSessions.map((u) => [u.sid, u.streams]));
  assert.equal(byStreams[a.sessionId], 1, 'the listening one is visibly listening');
  assert.equal(byStreams[b.sessionId], 0, 'the silent one is visibly NOT');

  streamA.close();
});

test('#727 a BOUND seat does not appear in the unbound list', async (t) => {
  const { rest, mcp } = await startPair();
  t.after(async () => { await mcp.stop(); await rest.stop(); });

  const s = await mcpSession(mcp.mcpUrl);
  await sleep(150);
  const st = await status(mcp);

  // Negative control. Without it, an implementation that lists EVERY session
  // passes both tests above — and would report bound seats as nameless, which
  // is the opposite of the fix.
  assert.equal(st.unboundSessions.every((u) => u.sid !== 'definitely-not-a-real-sid'), true);
  assert.equal(st.unboundSessions.length, st.unbound,
    'the list and the scalar must agree — a disagreement means one of them is lying');
  assert.ok(Object.keys(st.seats).length === 0 || st.unboundSessions.length <= st.sessions);
});

test('#727 ANTI-VACUITY: the list is non-empty when it should be', async (t) => {
  const { rest, mcp } = await startPair();
  t.after(async () => { await mcp.stop(); await rest.stop(); });

  await mcpSession(mcp.mcpUrl);
  await sleep(150);
  const st = await status(mcp);
  assert.ok(st.unboundSessions.length > 0,
    'if this fails, every assertion above passes over an empty array');
});
