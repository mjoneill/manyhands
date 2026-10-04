/**
 * #782 — Decision 5b43edcd amends #642 for PUSH delivery: when the scheduler has
 * actually written a conversation notification to a session's open stream, the
 * server records that conversation's event seq for the session's lane.
 *
 * ⛔ #1576 AMENDS the ack half of 5b43edcd: a resolved stream write is a
 * server-side "sent" event (the class of res.end's callback, which Node 22 fires
 * for a socket the client destroyed), so it is reported as `last_pushed_seq` and
 * is NEVER an ack — nor is the lane's next inbound call. The cursor advances only
 * on an explicit ack: replay_pull acks the page it received.
 *
 * Measured 2026-08-30 before this: `served: null` on all five production lanes,
 * `acked` frozen at registration for 19 days, head 15,533 — nothing had ever
 * pulled, so the cursor described nothing and a reconnect would have hit
 * CURSOR_TOO_OLD.
 *
 * ⭐ THE ASSERTION #782 DEMANDED: "the fix's acceptance must contain a lane that
 * reads reachable while another reads deaf, in the same snapshot." The first
 * test below is that snapshot — a served-and-acked seat beside a never-served
 * one, on one report.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startPair, mcpSession, openChannelStream, makeBoardFixture } from './helpers/harness.mjs';

function tmpTokens(obj) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seat-tokens-')), 'tokens.json');
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}
const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));
const lanes = async (rest) => {
  const r = await (await fetch(`${rest.baseUrl}/api/cursors`)).json();
  return { head: r.head_seq, by: Object.fromEntries(r.lanes.map((l) => [l.identity, l])) };
};

async function withRoom(run) {
  const tokensFile = tmpTokens({ tokens: { 'tok-ada': { seat: 'ada' }, 'tok-bo': { seat: 'bo' }, 'tok-cy': { seat: 'cy' } } });
  const { rest, mcp, stop } = await startPair({
    board: makeBoardFixture({ cards: [], conversations: [] }),
    mcpEnv: { SCRUM_SEAT_TOKENS: tokensFile },
  });
  try {
    const ada = await mcpSession(mcp.mcpUrl, { headers: { Authorization: 'Bearer tok-ada' } });
    const bo = await mcpSession(mcp.mcpUrl, { headers: { Authorization: 'Bearer tok-bo' } });
    const cy = await mcpSession(mcp.mcpUrl, { headers: { Authorization: 'Bearer tok-cy' } });
    // A lane exists once the session has made ONE inbound call (it adopts at head).
    await ada.callTool('column_list', {});
    await bo.callTool('column_list', {});
    await cy.callTool('column_list', {});
    // ada and bo listen; cy has a lane and NO stream — the contrast lane.
    const adaStream = await openChannelStream(mcp.mcpUrl, ada.sessionId);
    const boStream = await openChannelStream(mcp.mcpUrl, bo.sessionId);
    try { await run({ rest, mcp, ada, bo, cy, adaStream, boStream }); }
    finally { adaStream.close(); boStream.close(); }
  } finally { await stop(); }
}

test('#782/#1576 a push written to an open stream is REPORTED (last_pushed_seq), never acked by it or by the next inbound; replay_pull\'s explicit ack is what moves the cursor — one snapshot', async () => {
  await withRoom(async ({ rest, bo, adaStream, boStream }) => {
    const before = await lanes(rest);
    for (const k of ['bearer:ada', 'bearer:bo', 'bearer:cy']) {
      assert.ok(before.by[k], `lane ${k} adopted: ${JSON.stringify(before)}`);
      assert.equal(before.by[k].last_pushed_seq, null, 'nothing pushed yet');
    }

    // A fourth voice posts through REST, so nobody's self-echo suppression applies:
    // both open streams receive it; cy, with no stream, cannot.
    await fetch(`${rest.baseUrl}/api/conversations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'dee', body: 'hello room' }),
    });
    await settle();
    const got = (st) => st.messages.some((m) => /hello room/.test(String(m.params?.content ?? '')));
    assert.ok(got(boStream) && got(adaStream), 'anti-vacuity: both open streams actually received the push');

    const pushed = await lanes(rest);
    const seq = pushed.by['bearer:bo'].last_pushed_seq;
    assert.ok(Number.isInteger(seq) && seq > before.head, `bo's lane records the pushed event: ${JSON.stringify(pushed.by['bearer:bo'])}`);
    assert.equal(pushed.by['bearer:ada'].last_pushed_seq, seq, 'ada, who also received it, records the same seq');
    assert.equal(pushed.by['bearer:bo'].last_served_seq, null, 'a push is not a pull serve');
    assert.equal(pushed.by['bearer:bo'].last_acked_seq, before.by['bearer:bo'].last_acked_seq, 'the cursor does not move on the write');
    assert.equal(pushed.by['bearer:cy'].last_pushed_seq, null, 'the lane with no stream received nothing');

    // bo comes back with an ordinary call: NOT an ack (#1576).
    await bo.callTool('column_list', {});
    await settle(300);
    const alive = await lanes(rest);
    assert.equal(alive.by['bearer:bo'].last_acked_seq, before.by['bearer:bo'].last_acked_seq, 'the next inbound call is liveness, not delivery');

    // bo pulls: the tool acks the page it received, and only that moves the cursor.
    const res = await bo.callTool('replay_pull', {});
    const page = JSON.parse(res.result.content[0].text);
    assert.equal(page.ack?.advanced, true, JSON.stringify(page.ack));
    const after = await lanes(rest);
    assert.ok(after.by['bearer:bo'].last_acked_seq >= seq, `bo's explicit ack covers the pushed event: ${JSON.stringify(after.by['bearer:bo'])}`);
    assert.equal(after.by['bearer:bo'].state, 'reachable', `bo reads reachable: ${JSON.stringify(after.by['bearer:bo'])}`);
    assert.equal(after.by['bearer:ada'].last_acked_seq, before.by['bearer:ada'].last_acked_seq, 'ada was pushed to but never acked: not acked');
    assert.ok(after.by['bearer:cy'].lag >= 1 && after.by['bearer:cy'].state !== 'reachable',
      `cy is behind and reads so in the SAME snapshot: ${JSON.stringify(after.by['bearer:cy'])}`);
  });
});

test('#782 ⛔ CONTROL — a session that holds NO stream is never marked served by a post it did not receive', async () => {
  const tokensFile = tmpTokens({ tokens: { 'tok-ada': { seat: 'ada' } } });
  const { rest, mcp, stop } = await startPair({ board: makeBoardFixture({ cards: [], conversations: [] }), mcpEnv: { SCRUM_SEAT_TOKENS: tokensFile } });
  try {
    const ada = await mcpSession(mcp.mcpUrl, { headers: { Authorization: 'Bearer tok-ada' } });
    await ada.callTool('column_list', {});
    await fetch(`${rest.baseUrl}/api/conversations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'bo', body: 'nobody is listening' }),
    });
    await settle();
    const l = await lanes(rest);
    assert.equal(l.by['bearer:ada'].last_pushed_seq, null, 'no stream ⇒ no write ⇒ nothing recorded — #642\'s fear, still refused');
    await ada.callTool('column_list', {});
    await settle(300);
    const l2 = await lanes(rest);
    assert.ok(l2.by['bearer:ada'].lag >= 1, 'and her inbound call cannot ack past what was never served');
  } finally { await stop(); }
});
