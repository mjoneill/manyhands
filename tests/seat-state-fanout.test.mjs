/**
 * #613 — "NOT WOKEN", which is the half a selection-time check cannot deliver.
 *
 * Slice 1 stopped the tick from MINTING when nobody was eligible. That answers
 * "not targeted" and leaves the promise unmet for the ordinary case: with one
 * seat resting and another available, the offer is still minted and still fans
 * out to every open stream — including the resting seat's. A seat that asked
 * not to be woken would be woken by the very message it declined.
 *
 * ⚠️ SCOPE IS THE ASSERTION. Seat state suppresses the ROUTINE OFFER and
 * nothing else. The second test is the one that keeps this honest: an ordinary
 * post still reaches a resting seat, because the promise is "present, not
 * taking this" — not "gone", and never "unreachable".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPair, mcpSession, openChannelStream, makeBoardFixture } from './helpers/harness.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function tmpTokens(obj) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seat-tokens-')), 'tokens.json');
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}

const IN_1H = () => new Date(Date.now() + 3600_000).toISOString();
const channelMessages = (stream) => stream.messages.filter((n) => n.method === 'notifications/claude/channel');
const bodies = (stream) => channelMessages(stream).map((n) => String(n.params?.content ?? ''));

async function withRoom(run) {
  const tokensFile = tmpTokens({
    tokens: { 'tok-ada': { seat: 'ada', heartbeat_s: 60 }, 'tok-bo': { seat: 'bo', heartbeat_s: 60 } },
  });
  // ⚠️ startPair, NOT two servers by hand: `startRestServer` defaults
  // mcpNotifyUrl to '' — notifications DISABLED — so a hand-wired pair delivers
  // nothing and every "the resting seat saw nothing" assertion passes for the
  // wrong reason. The anti-vacuity check below is what caught that.
  const { rest, mcp, stop } = await startPair({
    board: makeBoardFixture({ cards: [], conversations: [] }),
    mcpEnv: { SCRUM_SEAT_TOKENS: tokensFile },
  });
  try {
    const ada = await mcpSession(mcp.mcpUrl, { headers: { Authorization: 'Bearer tok-ada' } });
    const bo = await mcpSession(mcp.mcpUrl, { headers: { Authorization: 'Bearer tok-bo' } });
    const adaStream = await openChannelStream(mcp.mcpUrl, ada.sessionId);
    const boStream = await openChannelStream(mcp.mcpUrl, bo.sessionId);
    try {
      await run({ rest, mcp, ada, bo, adaStream, boStream });
    } finally { adaStream.close(); boStream.close(); }
  } finally { await stop(); }
}

test('#613 a resting seat is not woken by the tending offer, and an available one still is', async () => {
  await withRoom(async ({ rest, ada, adaStream, boStream }) => {
    // ada declares through the tool, which takes her seat from the BOUND
    // SESSION — there is no seat parameter to get wrong.
    const declared = await ada.callTool('seat_declare', {
      mode: 'resting', acceptsRoutineWork: false, expiresAt: IN_1H(),
    });
    assert.ok(declared.result, JSON.stringify(declared));
    const state = await (await fetch(`${rest.baseUrl}/api/seats/state`)).json();
    assert.ok(state.declining.includes('ada'), 'the declaration is stored and read back');

    // ⭐ ANTI-VACUITY FIRST: an ordinary post reaches BOTH streams. Without
    // this, "ada saw nothing" would be satisfied by a broken stream.
    await fetch(`${rest.baseUrl}/api/conversations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'bo', body: 'an ordinary message' }),
    });
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(bodies(adaStream).some((b) => /an ordinary message/.test(b)),
      'a RESTING seat still receives ordinary posts — "present, not taking this", never "gone"');

    const beforeAda = channelMessages(adaStream).length;
    const beforeBo = channelMessages(boStream).length;

    // The tending offer, in the shape the tick writes it.
    await fetch(`${rest.baseUrl}/api/conversations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'board', body: '[tending 2026-08-30T15] tend the room' }),
    });
    await new Promise((r) => setTimeout(r, 400));

    assert.ok(bodies(boStream).some((b) => /\[tending /.test(b)),
      'the ELIGIBLE seat is still offered the work — one declining seat must never silence the room');
    assert.ok(!bodies(adaStream).some((b) => /\[tending /.test(b)),
      'the RESTING seat is NOT woken by the offer she declined');
    assert.equal(channelMessages(adaStream).length, beforeAda, 'and nothing at all arrived for her');
    assert.ok(channelMessages(boStream).length > beforeBo, 'while the room carried on');
  });
});

test('#613 clearing the declaration restores the offer, so suppression is not a one-way door', async () => {
  // ⛔ THE CONTROL THAT WOULD CATCH A STALE SUPPRESSION SET. If the declining
  // set were cached and never refreshed, this test would fail — a seat would
  // stay silenced after saying it was ready again, which is this card's own
  // defect arriving from the other side.
  await withRoom(async ({ rest, ada, adaStream }) => {
    await ada.callTool('seat_declare', { mode: 'resting', acceptsRoutineWork: false, expiresAt: IN_1H() });
    await fetch(`${rest.baseUrl}/api/conversations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'board', body: '[tending w1] first offer' }),
    });
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(!bodies(adaStream).some((b) => /first offer/.test(b)), 'withheld while resting');

    await ada.callTool('seat_clear', {});
    const after = await (await fetch(`${rest.baseUrl}/api/seats/state`)).json();
    // ⚠️ NOT `eligible.includes('ada')`. The population is the roster PLUS any
    // seat carrying a declaration, so once ada's row is gone she leaves the
    // listing entirely — she is not on this fixture's default roster. Absent
    // from `declining` is the assertion that means what it says.
    assert.ok(!after.declining.includes('ada'), 'cleared back to UNKNOWN, which is not a stated no');

    // ⭐ AND THE ONE THAT ACTUALLY TESTS THE DOOR: the next offer is delivered.
    await fetch(`${rest.baseUrl}/api/conversations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'board', body: '[tending w2] second offer' }),
    });
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(bodies(adaStream).some((b) => /second offer/.test(b)),
      'after clearing, the offer reaches her again — suppression is not a one-way door');
  });
});
