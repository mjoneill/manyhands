/**
 * #1129 slice 1 — `/channel/status` stops lying twice, WITHOUT reaping anything.
 *
 * (a) A seat's row separates LIVE streams from STALE ones. Today `streams`
 *     counts every open SSE stream the server holds under a seat token —
 *     reconnect churn included — so one seat read `streams: 12` on 09-13, and
 *     "streams=1 reads healthy" through a dead client cost the room twelve
 *     hours on 09-10. `liveStreams` = open streams whose client has spoken
 *     within the live window; `staleStreams` = the rest. `streams` stays
 *     (readers depend on it) and is the SUM of the two.
 * (b) The payload names what it cannot see: `blindTo[]`. A seat that talks to
 *     the board only through REST never appears in `seats{}`; its absence was
 *     byte-identical to a dead stream and two readers misread it in 60 s.
 *
 * ⛔ Nothing here reaps. A reap that guesses wrong is a deafness (#182, #664);
 * slice 2 owns that question. This slice makes the numbers honest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRestServer, startMcpServer, mcpSession, openChannelStream, makeBoardFixture } from './helpers/harness.mjs';

const tmpTokens = (obj) => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seat1129-')), 'seat-tokens.json');
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
};
const status = async (mcp) => (await fetch(`${new URL(mcp.mcpUrl).origin}/channel/status`)).json();

test('#1129 two sessions under ONE seat token, one gone quiet: streams=2 still, liveStreams=1, staleStreams=1 — the churn is counted, not hidden', async () => {
  const tokensFile = tmpTokens({ tokens: { 'tok-alpha': { seat: 'alpha', heartbeat_s: 60 } } });
  const rest = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  // A 2-second live window so the test can let one client go stale in real time.
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl, env: { SCRUM_SEAT_TOKENS: tokensFile, SCRUM_LIVE_WINDOW_MS: '2000' } });
  try {
    const a = await mcpSession(mcp.mcpUrl, { headers: { Authorization: 'Bearer tok-alpha' } });
    const b = await mcpSession(mcp.mcpUrl, { headers: { Authorization: 'Bearer tok-alpha' } });
    const sa = await openChannelStream(mcp.mcpUrl, a.sessionId);
    const sb = await openChannelStream(mcp.mcpUrl, b.sessionId);
    // both spoke just now (initialize is a request)
    let s = await status(mcp);
    assert.equal(s.seats.alpha.streams, 2, 'the legacy count is unchanged: two open streams');
    assert.equal(s.seats.alpha.liveStreams, 2);
    assert.equal(s.seats.alpha.staleStreams, 0);
    assert.equal(s.seats.alpha.streams, s.seats.alpha.liveStreams + s.seats.alpha.staleStreams, 'streams is the SUM, so old readers keep their number');

    // let the window pass, then only A speaks
    await new Promise((r) => setTimeout(r, 2300));
    await a.callTool('board_status', {});
    s = await status(mcp);
    assert.equal(s.seats.alpha.streams, 2, 'B still holds its stream open — nothing was reaped');
    assert.equal(s.seats.alpha.liveStreams, 1, 'only A has spoken inside the window');
    assert.equal(s.seats.alpha.staleStreams, 1, 'B is the churn: open, silent');
    assert.equal(typeof s.liveWindowMs, 'number', 'the window the split was measured against is on the payload');

    sa.close(); sb.close();
  } finally { await mcp.stop(); await rest.stop(); }
});

test('#1129 NEGATIVE CONTROL — a seat with one stream and a fresh request reads live=1 stale=0; a tool-only seat (no stream) reads 0/0 and is not called stale', async () => {
  const tokensFile = tmpTokens({ tokens: { 'tok-alpha': { seat: 'alpha' }, 'tok-hc': { seat: 'healthcheck' } } });
  const rest = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl, env: { SCRUM_SEAT_TOKENS: tokensFile } });
  try {
    const a = await mcpSession(mcp.mcpUrl, { headers: { Authorization: 'Bearer tok-alpha' } });
    const sa = await openChannelStream(mcp.mcpUrl, a.sessionId);
    await mcpSession(mcp.mcpUrl, { headers: { Authorization: 'Bearer tok-hc' } });   // tool-only, like the real healthcheck
    const s = await status(mcp);
    assert.deepEqual([s.seats.alpha.streams, s.seats.alpha.liveStreams, s.seats.alpha.staleStreams], [1, 1, 0]);
    assert.deepEqual([s.seats.healthcheck.streams, s.seats.healthcheck.liveStreams, s.seats.healthcheck.staleStreams], [0, 0, 0], 'no stream ⇒ nothing to be stale');
    sa.close();
  } finally { await mcp.stop(); await rest.stop(); }
});

test('#1129 the payload NAMES what it cannot see — blindTo lists the transports outside seats{}, with why', async () => {
  const rest = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const s = await status(mcp);
    assert.ok(Array.isArray(s.blindTo) && s.blindTo.length >= 2, 'blindTo is a list, never absent');
    for (const b of s.blindTo) { assert.equal(typeof b.transport, 'string'); assert.ok(b.why && b.why.length > 20, `${b.transport} says why`); }
    const transports = s.blindTo.map((b) => b.transport);
    assert.ok(transports.includes('rest-only'), 'a seat that only writes through REST is named as invisible here');
    assert.ok(transports.includes('resident-inbox'), 'channel-mode residents are pointed at residents{} rather than read as absent');
  } finally { await mcp.stop(); await rest.stop(); }
});
