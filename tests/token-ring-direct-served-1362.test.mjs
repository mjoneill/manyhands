/**
 * #1362 slice 2 — THE DIRECT SEGMENT, WIRED. A real REST + a real MCP in
 * token-ring mode, one registered stream seat, two channel-mode residents.
 * The ring runs its stream seat first; when the stream segment goes quiet the
 * residents' slot opens and each gets ONE delivery record per post, source
 * `ring`; the runner's terminal events (through REST, as the real runner
 * writes them) close the records; the slot advances; /channel/status shows
 * all of it under `ring.direct`.
 *
 * Negative control: in never-armed fan-out mode residents are offered through
 * the fan-out (#1346) and the direct segment stays idle — no double offer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort, startRestServer, startMcpServer, mcpSession, openChannelStream } from './helpers/harness.mjs';

const TOKEN_RING_CONFIG = { mode: 'token-ring', soft: { minMs: 30000, maxMs: 60000 }, hard: { timeoutMs: 300000 }, tokenRing: { timeoutMs: 300000 } };
const FANOUT_CONFIG = { mode: 'hard', soft: { minMs: 30000, maxMs: 60000 }, hard: { timeoutMs: 300000 }, tokenRing: { timeoutMs: 300000 } };

async function startPair(config, extraEnv = {}) {
  const restPort = await freePort();
  const mcpPort = await freePort();
  const cfgFile = path.join(os.tmpdir(), `direct-1362-${process.pid}-${restPort}.json`);
  fs.writeFileSync(cfgFile, JSON.stringify(config));
  const rest = await startRestServer({ port: restPort, mcpNotifyUrl: `http://127.0.0.1:${mcpPort}/internal/notify` });
  const mcp = await startMcpServer({ port: mcpPort, restApiBase: rest.baseUrl, env: { SCRUM_CHANNEL_STAGGER: '', SCRUM_CHANNEL_CONFIG_FILE: cfgFile, MCP_DIRECT_TICK_MS: '250', ...extraEnv } });
  return { rest, mcp, async stop() { await mcp.stop(); await rest.stop(); try { fs.unlinkSync(cfgFile); } catch { /* gone */ } } };
}
const api = async (base, method, p, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* empty */ }
  return { status: r.status, body: j };
};
const RESIDENT = (seatKey) => ({ seatKey, name: seatKey, emoji: '🤖', prompt: 'Answer only from what you are handed.', model: { model: 'test-model', protocol: 'ollama-native', baseUrl: 'http://127.0.0.1:1' }, toolGrants: ['conversation_post'], budgetPerDay: 0.5, by: 'owner' });
async function invite(base, seatKey) {
  const c = await api(base, 'POST', '/api/agents', RESIDENT(seatKey));
  assert.equal(c.status, 201, `create ${seatKey}: ${JSON.stringify(c.body)}`);
  const p = await api(base, 'PATCH', `/api/agents/${seatKey}`, { deliveryMode: 'channel', by: 'owner' });
  assert.equal(p.status, 200, `channel mode for ${seatKey}: ${JSON.stringify(p.body)}`);
}
const deliveriesTo = async (base, seat) => (await api(base, 'GET', `/api/deliveries?to=${seat}`)).body.deliveries ?? [];
const status = async (mcp) => (await fetch(`${mcp.baseUrl}/channel/status`)).json();
async function until(fn, ms = 6000, every = 100) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, every)); }
}
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

test('#1362 SEAM — stream seat first, then the residents\' slot: offers with source=ring, terminal events close it, status shows ring.direct', async () => {
  const pair = await startPair(TOKEN_RING_CONFIG);
  const { rest, mcp } = pair;
  try {
    await invite(rest.baseUrl, 'lin');
    await invite(rest.baseUrl, 'ada');
    // One STREAM seat, registered into the ring, with an open channel stream.
    const holder = await mcpSession(mcp.mcpUrl);
    await openChannelStream(mcp.mcpUrl, holder.sessionId);
    const reg = await holder.rpc('scrum/session/register', { seatId: 'tester.sb', author: 'tester' });
    assert.ok(reg?.result?.registered ?? reg?.registered ?? true, 'stream seat registered');

    // A human posts. The stream ring grants the holder a lease → the direct slot must NOT open yet.
    const p1 = (await api(rest.baseUrl, 'POST', '/api/conversations', { author: 'owner', body: 'hello, room' })).body;
    await settle(600);
    let st = await status(mcp);
    assert.equal(st.ring?.direct?.slot ?? null, null, `the direct slot opened while the stream segment held a lease: ${JSON.stringify(st.ring?.direct)}`);
    assert.equal((await deliveriesTo(rest.baseUrl, 'lin')).length, 0, 'no resident offer while the stream seat holds the turn');

    // The holder responds (a REST post under the holder's author is its RESPOND) → the stream ring goes quiet → the direct slot opens.
    const p2 = (await api(rest.baseUrl, 'POST', '/api/conversations', { author: 'tester', body: 'holder answers' })).body;
    const opened = await until(async () => { const s = await status(mcp); return s.ring?.direct?.slot ? s : null; });
    assert.ok(opened, 'the direct slot opened after the stream segment went quiet');
    assert.deepEqual(opened.ring.direct.slot.records.map((r) => r.seat).sort(), ['ada', 'lin']);
    const linOffers = await until(async () => { const d = await deliveriesTo(rest.baseUrl, 'lin'); return d.length >= 2 ? d : null; });
    assert.ok(linOffers, `lin was offered both posts; deliveries=${JSON.stringify(await deliveriesTo(rest.baseUrl, 'lin'))}\nadapter log:\n${(mcp.stdoutText() + mcp.stderrText()).split('\n').filter((l) => /1362|410|1346|deliver/.test(l)).slice(-12).join('\n')}`);
        assert.deepEqual(linOffers.map((d) => d.conversation).sort(), [p1.id, p2.id].sort(), 'one record per post of the cycle');

    // The runner drains: lin publishes, ada declines — the slot advances on terminal, before any timeout.
    for (const d of linOffers) {
      assert.equal((await api(rest.baseUrl, 'POST', `/api/deliveries/${encodeURIComponent(d.id)}/events`, { state: 'claimed', source: 'guest-runner', by: 'lin' })).status, 201);
      assert.equal((await api(rest.baseUrl, 'POST', `/api/deliveries/${encodeURIComponent(d.id)}/events`, { state: 'published', source: 'guest-runner', by: 'lin' })).status, 201);
    }
    for (const d of await deliveriesTo(rest.baseUrl, 'ada')) {
      assert.equal((await api(rest.baseUrl, 'POST', `/api/deliveries/${encodeURIComponent(d.id)}/events`, { state: 'claimed', source: 'guest-runner', by: 'ada' })).status, 201);
      assert.equal((await api(rest.baseUrl, 'POST', `/api/deliveries/${encodeURIComponent(d.id)}/events`, { state: 'declined', source: 'guest-runner', by: 'ada' })).status, 201);
    }
    const closed = await until(async () => { const s = await status(mcp); return s.ring?.direct?.lastCycle?.reason ? s : null; });
    assert.ok(closed, `the slot never advanced; status: ${JSON.stringify((await status(mcp)).ring?.direct)}`);
    assert.equal(closed.ring.direct.lastCycle.reason, 'terminal');
    assert.equal(closed.ring.direct.slot, null);
    assert.deepEqual(closed.ring.direct.lastCycle.records.map((r) => [r.seat, r.state]).sort(), [['ada', 'declined'], ['lin', 'published']]);
    assert.ok(closed.ring.direct.seats.every((x) => x.notAnswering === false), 'nobody latched — everyone answered');
    assert.match(mcp.stderrText() + mcp.stdoutText(), /\[#1362 direct\] slot opened/, 'the adapter logs the slot');
  } finally {
    await pair.stop();
  }
});

test('#1362 NEGATIVE CONTROL — in fan-out mode residents are offered by the fan-out (#1346) and the direct segment stays idle: no double offer', async () => {
  const pair = await startPair(FANOUT_CONFIG);
  const { rest, mcp } = pair;
  try {
    await invite(rest.baseUrl, 'lin');
    await api(rest.baseUrl, 'POST', '/api/conversations', { author: 'owner', body: 'hello, room' });
    const offers = await until(async () => { const d = await deliveriesTo(rest.baseUrl, 'lin'); return d.length ? d : null; });
    assert.ok(offers, 'the fan-out offered the post to the resident');
    await settle(700);
    assert.equal((await deliveriesTo(rest.baseUrl, 'lin')).length, 1, 'exactly one offer — the direct segment did not offer it again');
    const st = await status(mcp);
    assert.equal(st.ring?.direct?.slot ?? null, null, 'no direct slot in fan-out mode');
    assert.equal(st.ring?.direct?.cycles ?? 0, 0);
  } finally {
    await pair.stop();
  }
});
