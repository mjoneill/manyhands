/**
 * #703 — connection identity + heartbeats: the room-vetted contract.
 * Fail-open by ruling · dormant-by-absence · watch-visible unbound counts ·
 * heartbeats that clients silently drop · mismatch logs, never refuses.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSeatTokens, bindFromAuthHeader, DEFAULT_HEARTBEAT_S } from '../core/seat-binding.mjs';

const tmpTokens = (obj) => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seat703-')), 'seat-tokens.json');
  fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return p;
};

test('absent file → DORMANT: every connection unbound, nothing crashes (rollout precondition)', () => {
  const t = loadSeatTokens('/nonexistent/seat-tokens.json');
  assert.equal(t.dormant, true);
  assert.equal(bindFromAuthHeader('Bearer whatever', t), null, 'no header match without tokens... ');
});

test('malformed file WARNS and goes dormant — a broken token file must never down the channel', () => {
  let warned = '';
  const t = loadSeatTokens(tmpTokens('{not json'), (m) => { warned = m; });
  assert.equal(t.dormant, true);
  assert.match(warned, /DORMANT/);
});

test('binding resolves Bearer tokens to seats with per-seat cadence; unknown tokens are unbound-with-reason', () => {
  const t = loadSeatTokens(tmpTokens({ tokens: {
    'tok-ada': { seat: 'ada', heartbeat_s: 15 },
    'tok-bex': { seat: 'bex' },
  } }));
  assert.equal(t.dormant, false);
  assert.deepEqual(bindFromAuthHeader('Bearer tok-ada', t), { seat: 'ada', heartbeat_s: 15 });
  assert.equal(bindFromAuthHeader('bearer tok-bex', t).heartbeat_s, DEFAULT_HEARTBEAT_S, 'scheme case-insensitive; default cadence');
  assert.equal(bindFromAuthHeader(undefined, t), null, 'no header = unbound, admitted (fail-open)');
  assert.deepEqual(bindFromAuthHeader('Bearer tok-nobody', t), { seat: null, unknownToken: true },
    'a WRONG token is distinguishable from a missing one, and still admitted');
});

// ── the wire: bound sessions surface by seat; unbound are counted ──────────
import { startRestServer, startMcpServer, mcpSession, openChannelStream, makeBoardFixture } from './helpers/harness.mjs';

test('bound and unbound sessions both work (fail-open), and /channel/status names seats + counts unbound', async () => {
  const tokensFile = tmpTokens({ tokens: { 'tok-ada': { seat: 'ada', heartbeat_s: 15 } } });
  const rest = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl, env: { SCRUM_SEAT_TOKENS: tokensFile } });
  try {
    const bound = await mcpSession(mcp.mcpUrl, { headers: { Authorization: 'Bearer tok-ada' } });
    const unbound = await mcpSession(mcp.mcpUrl);
    // both sessions fully functional — the entire point of fail-open
    for (const s of [bound, unbound]) {
      const r = await s.callTool('board_status', {});
      assert.ok(r.result, 'tool call succeeds regardless of binding');
    }
    const status = await (await fetch(`${new URL(mcp.mcpUrl).origin}/channel/status`)).json();
    assert.ok(status.seats, 'status carries the per-seat table');
    assert.ok(status.seats.ada, 'the bound seat appears BY NAME');
    assert.equal(typeof status.unbound, 'number', 'unbound sessions are COUNTED where the room looks');
    assert.ok(status.unbound >= 1, 'the unbound session is visible, not silent');
  } finally {
    await mcp.stop();
    await rest.stop();
  }
});

test('heartbeats arrive as notifications on a bound stream, and the status table records the beat', async () => {
  const tokensFile = tmpTokens({ tokens: { 'tok-ada': { seat: 'ada', heartbeat_s: 1 } } });
  const rest = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  const mcp = await startMcpServer({
    restApiBase: rest.baseUrl,
    env: { SCRUM_SEAT_TOKENS: tokensFile, SCRUM_HEARTBEAT_SWEEP_MS: '200' },
  });
  try {
    const session = await mcpSession(mcp.mcpUrl, { headers: { Authorization: 'Bearer tok-ada' } });
    const stream = await openChannelStream(mcp.mcpUrl, session.sessionId);
    // wait for at least one sweep past the 1s cadence
    await new Promise((r) => setTimeout(r, 1800));
    const status = await (await fetch(`${new URL(mcp.mcpUrl).origin}/channel/status`)).json();
    assert.ok(status.seats.ada, 'bound seat present');
    assert.ok(status.seats.ada.lastBeatAt, 'a heartbeat was sent and recorded');
    assert.equal(status.seats.ada.lastBeatOk, true, 'the beat write succeeded on the live stream');
    // the notification method is one clients silently drop — never the channel
    // method, which would inject context-burning noise every cadence (#206 kin)
    const hb = stream.messages.filter((n) => n.method === 'notifications/claude/heartbeat');
    assert.ok(hb.length >= 1, 'heartbeat rode the stream as a droppable notification');
    assert.equal(stream.messages.some((n) => n.method === 'notifications/claude/channel' && /heartbeat/i.test(JSON.stringify(n))), false,
      'heartbeats NEVER ride the channel method — that would inject context noise per cadence');
    stream.close();
  } finally {
    await mcp.stop();
    await rest.stop();
  }
});
