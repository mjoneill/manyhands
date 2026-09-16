/**
 * #1396 — THE THIRD REGISTRATION PATH: an MCP session bound by bearer joins
 * the ring when it holds a stream, and leaves when it goes deaf.
 *
 * Until now the ring knew one registration path (the presence lane's
 * `scrum/session/register`), so token-ring mode could never work for every
 * participant — the Claude Code seats (bearer-bound MCP sessions) were never
 * members. Decision 5ece8067: the ring is wanted on the condition it works for
 * ALL participants. This is the membership half; the supervised trial is the
 * card's slice 2.
 *
 * Read from the running adapter, not the reducer:
 *   1. bound + stream open  ⇒ registered; /channel/status says ring:true
 *   2. bound, NO stream     ⇒ not registered (a registered seat with no stream
 *                             is a dead seat for one TTL)
 *   3. deaf (no stream past the grace, then a request) ⇒ released; a new
 *                             stream ⇒ back in (supersede, new epoch)
 *   4. a bound seat NOT in tokenRing.bearerSeats ⇒ never registered, and the
 *                             presence lane's own register still works for it
 *   5. the ring actually delivers to the bearer seat in token-ring mode
 *
 * Sabotages, each failing a different case: drop the bearerSeats gate →
 * case 4; register without the stream condition → case 2; never release on
 * deaf → case 3; drop the status flag → case 1.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRestServer, startMcpServer, mcpSession, openChannelStream, makeBoardFixture, freePort } from './helpers/harness.mjs';

const GRACE_MS = 400;
const tmpFile = (name, obj) => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ring1396-')), name);
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
};
const status = async (mcp) => (await fetch(`${new URL(mcp.mcpUrl).origin}/channel/status`)).json();
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000, every = 50) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await settle(every); }
}

async function boot({ mode = 'off', bearerSeats = ['alpha'] } = {}) {
  const tokens = tmpFile('seat-tokens.json', { tokens: { 'tok-alpha': { seat: 'alpha' }, 'tok-beta': { seat: 'beta' } } });
  const cfg = tmpFile('channel-config.json', { mode, soft: { minMs: 60000, maxMs: 120000 }, hard: { timeoutMs: 300000 }, tokenRing: { timeoutMs: 90000, bearerSeats } });
  const restPort = await freePort();
  const mcpPort = await freePort();
  const rest = await startRestServer({ port: restPort, board: makeBoardFixture({ cards: [], conversations: [] }), mcpNotifyUrl: `http://127.0.0.1:${mcpPort}/internal/notify` });
  const mcp = await startMcpServer({ port: mcpPort, restApiBase: rest.baseUrl, env: {
    SCRUM_SEAT_TOKENS: tokens, SCRUM_CHANNEL_STAGGER: '', SCRUM_CHANNEL_CONFIG_FILE: cfg, MCP_DEAF_GRACE_MS: String(GRACE_MS),
  } });
  return { rest, mcp, async stop() { await mcp.stop(); await rest.stop(); } };
}

test('#1396 a bearer-bound seat with an open stream is IN the ring; without a stream it is not; status says which', async () => {
  const s = await boot();
  try {
    const a = await mcpSession(s.mcp.mcpUrl, { headers: { Authorization: 'Bearer tok-alpha' } });
    let st = await status(s.mcp);
    assert.equal(st.seats.alpha.ring, false, 'bound but no stream ⇒ not a member (a lease it could not answer)');
    assert.deepEqual(st.ring.members, [], 'nobody in the ring yet');
    assert.deepEqual(st.ring.bearerSeats, ['alpha'], 'who MAY join by bearer is on the payload');

    const stream = await openChannelStream(s.mcp.mcpUrl, a.sessionId);
    st = await until(async () => { const x = await status(s.mcp); return x.seats.alpha.ring ? x : null; });
    assert.ok(st, 'bound + stream ⇒ registered');
    assert.deepEqual(st.ring.members, ['alpha']);
    stream.close();
  } finally { await s.stop(); }
});

test('#1396 a seat that goes DEAF leaves the ring; a new stream brings it back with a new epoch', async () => {
  const s = await boot();
  try {
    const a = await mcpSession(s.mcp.mcpUrl, { headers: { Authorization: 'Bearer tok-alpha' } });
    const stream = await openChannelStream(s.mcp.mcpUrl, a.sessionId);
    assert.ok(await until(async () => (await status(s.mcp)).seats.alpha.ring), 'in');
    stream.close();
    await settle(GRACE_MS + 200);
    await a.callTool('board_status', {});   // a request with no stream past the grace ⇒ the #726 deaf latch
    let st = await until(async () => { const x = await status(s.mcp); return x.seats.alpha.ring ? null : x; });
    assert.ok(st, 'deaf ⇒ released: the ring must not grant a lease to a seat that cannot hear');
    assert.deepEqual(st.ring.members, []);
    const again = await openChannelStream(s.mcp.mcpUrl, a.sessionId);
    st = await until(async () => { const x = await status(s.mcp); return x.seats.alpha.ring ? x : null; });
    assert.ok(st, 'a new stream ⇒ back in');
    again.close();
  } finally { await s.stop(); }
});

test('#1396 NEGATIVE CONTROL — a bound seat NOT listed in bearerSeats never joins by bearer, and the presence lane\'s own register still works on that session', async () => {
  const s = await boot({ bearerSeats: ['alpha'] });
  try {
    const b = await mcpSession(s.mcp.mcpUrl, { headers: { Authorization: 'Bearer tok-beta' } });
    const stream = await openChannelStream(s.mcp.mcpUrl, b.sessionId);
    await settle(300);
    let st = await status(s.mcp);
    assert.equal(st.seats.beta.ring, false, 'beta is bearer-bound with a stream but not listed ⇒ not registered by this path');
    // the presence lane registers itself under a lane-qualified id — must not be refused as session-already-bound
    const reg = await b.rpc('scrum/session/register', { seatId: 'beta.sb', author: 'beta' });
    assert.equal(reg.result?.ok, true, `presence register on a bearer-bound session must succeed: ${JSON.stringify(reg)}`);
    st = await status(s.mcp);
    assert.equal(st.seats.beta.ring, true, 'now in, by the presence lane (lane-qualified id counts for the seat)');
    assert.deepEqual(st.ring.members, ['beta.sb']);
    stream.close();
  } finally { await s.stop(); }
});

test('#1396 in token-ring mode the ring DELIVERS to the bearer seat: a post from elsewhere arrives as its turn envelope', async () => {
  const s = await boot({ mode: 'token-ring' });
  try {
    const a = await mcpSession(s.mcp.mcpUrl, { headers: { Authorization: 'Bearer tok-alpha' } });
    const stream = await openChannelStream(s.mcp.mcpUrl, a.sessionId);
    assert.ok(await until(async () => (await status(s.mcp)).seats.alpha.ring), 'registered');
    const envelope = stream.next('notifications/claude/channel', 8000);
    const r = await fetch(`${s.rest.baseUrl}/api/conversations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'bo', body: 'the stick comes round' }),
    });
    assert.equal(r.status, 201);
    const msg = await envelope;
    assert.ok(msg, 'the bearer seat received the ring\'s turn envelope — the third path is a real member');
    assert.equal(msg.params?.meta?.token_ring_seat, 'alpha', `a token-ring envelope addressed to alpha: ${JSON.stringify(msg.params?.meta)}`);
    assert.match(msg.params?.content ?? '', /the stick comes round/);
    stream.close();
  } finally { await s.stop(); }
});
