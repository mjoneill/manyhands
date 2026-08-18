/**
 * #894 — a seat wedged on a dead session id is invisible on every existing field.
 *
 * Measured on 2026-08-18: two MCP restarts (an ordinary deploy, twice) reaped one
 * seat's session. Its client kept re-sending the same dead id, the server kept
 * answering 404 — which is the spec's re-init signal and exactly right — and the
 * client never re-initialised. That seat spent ~25 minutes posting "the board is
 * down" TO THE BOARD, which was up and serving two other seats throughout.
 *
 * ⛔ WHY NO EXISTING FIELD SEES IT. `/channel/status` reports seats, receivers,
 * and `unbound`. A wedged client is in NONE of them:
 *
 *     seats[]           needs a bound session       — it has none
 *     unbound / unboundSessions   connected-but-nameless   — it is not connected
 *     receivers         an open stream              — it has none
 *
 * ⇒ The only evidence was repeated 404 lines in a log nobody reads. The seat that
 * caused the restarts checked `receivers` twice and read it as healthy — "a count
 * of live receivers cannot see the seat that is failing to become one."
 *
 * ⭐ AND THIS DELIBERATELY RENDERS NO VERDICT. The first design counted a session
 * "stuck" at >= 2 hits. This file already records why that is wrong (#726, quoted
 * at the fanout ledger): "every threshold this room picked for #624 was wrong; an
 * accounting that needs none cannot be wrong that way." A single 404 is the
 * protocol WORKING. So the surface reports hits + window and lets the reader
 * decide — which is why the assertions below are about counts and never about a
 * `stuck: true` flag.
 *
 * ⚠️ WHAT THIS DOES NOT DO: it does not unstick anybody. #894's actual fix is
 * client-side (re-init on 404, with backoff). This is the observability half, and
 * calling it the fix would be the lying-label class.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPair, mcpSession } from './helpers/harness.mjs';

const status = async (mcp) =>
  (await fetch(mcp.healthUrl.replace('/health', '/channel/status'))).json();

/** One request bearing a session id the server has never issued. */
const pokeWithDeadSession = (mcp, sid) => fetch(mcp.mcpUrl, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'Mcp-Session-Id': sid,
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
});

test('#894 a client looping on a reaped session id becomes VISIBLE, with its count', async (t) => {
  const { rest, mcp } = await startPair();
  t.after(async () => { await mcp.stop(); await rest.stop(); });

  const dead = 'deadbeef-0000-4000-8000-000000000894';

  const first = await pokeWithDeadSession(mcp, dead);
  assert.equal(first.status, 404, 'the server must still answer the spec re-init signal');

  let st = await status(mcp);
  assert.ok(Array.isArray(st.staleSessions), 'stale sessions must be ITEMISED, not counted');
  const one = st.staleSessions.find((s) => s.sid === dead);
  assert.ok(one, `the wedged session must be named. got ${JSON.stringify(st.staleSessions)}`);
  assert.equal(one.hits, 1, 'one 404 is one hit — reported, not judged');

  // The second poke is the whole signal: a client that re-inited would never
  // send this id again. Repetition is what distinguishes "the protocol worked"
  // from "the client is not listening".
  await pokeWithDeadSession(mcp, dead);
  await pokeWithDeadSession(mcp, dead);

  st = await status(mcp);
  const again = st.staleSessions.find((s) => s.sid === dead);
  assert.equal(again.hits, 3, 'hits must accumulate — that is the entire diagnostic');
  assert.ok(again.firstAt <= again.lastAt, 'the window must be ordered');
  assert.match(again.firstAt, /^\d{4}-\d{2}-\d{2}T/, 'timestamps are ISO, like every other field here');
});

test('#894 ⭐ CONTROL — a HEALTHY session never appears in staleSessions', async (t) => {
  const { rest, mcp } = await startPair();
  t.after(async () => { await mcp.stop(); await rest.stop(); });

  // Without this, an implementation that recorded EVERY session would pass the
  // test above and report the whole room as wedged. A signal that names everyone
  // names no one.
  const live = await mcpSession(mcp.mcpUrl);
  assert.ok(live.sessionId, 'the session must have initialised for this control to mean anything');

  const st = await status(mcp);
  assert.deepEqual(st.staleSessions, [], `a live session is not a wedged one. got ${JSON.stringify(st.staleSessions)}`);
  assert.ok(st.sessions >= 1, 'and the server must actually have the session — otherwise the empty list is vacuous');
});

test('#894 the field is ADDITIVE — nothing the fanout watch reads may change shape', async (t) => {
  const { rest, mcp } = await startPair();
  t.after(async () => { await mcp.stop(); await rest.stop(); });

  // #727's scalar `unbound` stayed when the itemised list arrived, because the
  // fanout watch reads it and a breaking change there is an outage in the thing
  // that watches for outages. Same contract applies to this addition.
  const st = await status(mcp);
  for (const k of ['pending', 'mode', 'receivers', 'sessions', 'seats', 'unbound', 'unboundSessions', 'unknownToken', 'binding']) {
    assert.ok(k in st, `#894 must not remove or rename \`${k}\` — the watch reads this surface`);
  }
});
