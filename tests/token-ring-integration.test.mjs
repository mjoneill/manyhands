/**
 * #410 — token-ring delivery WIRING guard (integration).
 *
 * Proves the live path AND its fail-safe: with the MCP server in `token-ring` mode
 * but no seats registered (no registration seam yet), a commons post routes
 * through broadcastTokenRing, which falls back to normal fan-out rather than
 * silencing the room. Flipping the mode before the seam ships is therefore
 * safe — it's a no-op, never a deafening. The serialized dormancy gate only
 * engages once real seats register (covered by the engine unit tests).
 *
 * off/soft/hard are proven byte-for-byte unchanged by the existing
 * channel.test.mjs suite; this file only covers the new branch.
 *
 * Isolated: throwaway ports + temp board/config, never touches live :3001/:3141.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  freePort, startRestServer, startMcpServer, mcpSession, openChannelStream,
} from './helpers/harness.mjs';

// Bring up an isolated REST+MCP pair with the MCP server in token-ring mode.
async function startTokenRingPair(extraEnv = {}) {
  const restPort = await freePort();
  const mcpPort = await freePort();
  const cfgFile = path.join(os.tmpdir(), `token-ring-int-${process.pid}-${restPort}.json`);
  fs.writeFileSync(cfgFile, JSON.stringify(TOKEN_RING_CONFIG));
  const rest = await startRestServer({
    port: restPort,
    mcpNotifyUrl: `http://127.0.0.1:${mcpPort}/internal/notify`,
  });
  const mcp = await startMcpServer({
    port: mcpPort,
    restApiBase: rest.baseUrl,
    env: { SCRUM_CHANNEL_STAGGER: '', SCRUM_CHANNEL_CONFIG_FILE: cfgFile, ...extraEnv },
  });
  return {
    rest, mcp,
    async stop() {
      await mcp.stop();
      await rest.stop();
      try { fs.unlinkSync(cfgFile); } catch { /* best effort */ }
    },
  };
}

const TOKEN_RING_CONFIG = {
  mode: 'token-ring',
  soft: { minMs: 30000, maxMs: 60000 },
  hard: { timeoutMs: 300000 },
  tokenRing: { timeoutMs: 300000 },
};

async function poll(fn, timeoutMs = 5000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

test('token-ring mode with no registered seats fails SAFE to fan-out (never deafens the room)', async () => {
  const pair = await startTokenRingPair();
  const session = await mcpSession(pair.mcp.mcpUrl);
  const stream = await openChannelStream(pair.mcp.mcpUrl, session.sessionId);
  try {
    const res = await fetch(`${pair.rest.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'ring, are you there?', author: 'alex' }),
    });
    assert.equal(res.status, 201, 'the conversation was created');

    // The token-ring branch ran and recognised the empty ring — proving the
    // mode-switch routed here and chose the fail-safe.
    const loggedFallback = await poll(() => pair.mcp.stdoutText().includes('falling back to parallel fan-out'));
    assert.ok(loggedFallback, `expected the fail-safe fallback log; got:\n${pair.mcp.stdoutText()}`);

    // ...and the session STILL received the post (fan-out), not silence.
    const notif = await stream.next('notifications/claude/channel');
    assert.ok(notif.params.content.includes('ring, are you there?'), 'the room still heard the post');

    // Server is still healthy — the branch did not crash the process.
    const health = await fetch(pair.mcp.healthUrl);
    assert.equal(health.status, 200, 'MCP server healthy after a token-ring post');
  } finally {
    stream.close();
    await pair.stop();
  }
});

test('registration seam: a registered seat receives the turn-envelope; a non-registrant stays dormant', async () => {
  const pair = await startTokenRingPair();
  const holder = await mcpSession(pair.mcp.mcpUrl);     // will register as a ring seat
  const bystander = await mcpSession(pair.mcp.mcpUrl);  // connects but never registers
  const holderStream = await openChannelStream(pair.mcp.mcpUrl, holder.sessionId);
  const bystanderStream = await openChannelStream(pair.mcp.mcpUrl, bystander.sessionId);
  try {
    // GET-established-before-register (the required ordering), then the control-plane
    // registration request — NOT a tool call.
    const reg = await holder.rpc('scrum/session/register', { seatId: 'tester.sb', author: 'tester' });
    assert.equal(reg.result.ok, true, `register succeeded: ${JSON.stringify(reg)}`);
    assert.equal(reg.result.seatId, 'tester.sb');
    assert.equal(reg.result.epoch, 1);
    assert.equal(reg.result.supersededSession, null);

    // A commons post now wakes the (single-seat) ring and grants the lease to
    // tester.sb. The envelope must reach ONLY the holder's session.
    const res = await fetch(`${pair.rest.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'seed for the ring', author: 'alex' }),
    });
    assert.equal(res.status, 201);

    const env = await holderStream.next('notifications/claude/channel');
    assert.equal(env.params.meta.token_ring_seat, 'tester.sb', 'envelope addressed to the ring holder');
    assert.ok(env.params.meta.token_ring_envelope_id, 'envelope carries an envelopeId for dedup');
    assert.equal(env.params.meta.token_ring_lease_id, '1', 'first lease');
    assert.ok(env.params.content.includes('seed for the ring'), 'frozen payload carries the post');

    // The bystander (registered nothing) is dormant — no fan-out, no envelope.
    await new Promise((r) => setTimeout(r, 600));
    const bystanderNotifs = bystanderStream.messages.filter((m) => m.method === 'notifications/claude/channel');
    assert.equal(bystanderNotifs.length, 0, 'a non-registrant receives nothing in token-ring mode (dormant)');

    // The board logged the binding.
    assert.match(pair.mcp.stdoutText(), /\[#410 register\] seat tester\.sb/, 'registration was logged');
  } finally {
    holderStream.close();
    bystanderStream.close();
    await pair.stop();
  }
});

test('fenced timer: a silent holder times out, the ring RECOVERS (no wedge), lifecycle telemetry emits schema v1', async () => {
  const pair = await startTokenRingPair({ SCRUM_TOKEN_RING_TIMEOUT_MS: '400' }); // short TTL for the test
  const holder = await mcpSession(pair.mcp.mcpUrl);
  const stream = await openChannelStream(pair.mcp.mcpUrl, holder.sessionId);
  try {
    const reg = await holder.rpc('scrum/session/register', { seatId: 'solo.sb', author: 'solo' });
    assert.equal(reg.result.ok, true, `register: ${JSON.stringify(reg)}`);

    // Post 1 → the holder is granted an envelope; it stays SILENT (never responds).
    await fetch(`${pair.rest.baseUrl}/api/conversations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'nonce-one', author: 'alex' }),
    });
    const env1 = await stream.next('notifications/claude/channel');
    assert.ok(env1.params.content.includes('nonce-one'), 'holder received the first envelope');
    assert.equal(env1.params.meta.token_ring_lease_id, '1');

    const log = () => pair.mcp.stdoutText();
    // schema-v1 lifecycle: grant + timer scheduled for lease 1.
    assert.ok(await poll(() => /\[#410 lifecycle\] .*"stage":"board\.grant".*"leaseId":"1"/.test(log())), 'board.grant lease 1');
    assert.ok(await poll(() => /\[#410 lifecycle\] .*"stage":"board\.send\.complete".*"leaseId":"1"/.test(log())), 'board.send.complete lease 1');
    assert.ok(await poll(() => /\[#410 lifecycle\] .*"stage":"board\.timeout\.scheduled".*"leaseId":"1"/.test(log())), 'board.timeout.scheduled lease 1');
    // The silent holder's lease fires (~400ms) — the recovery rail.
    assert.ok(await poll(() => /\[#410 lifecycle\] .*"stage":"board\.timeout\.fired".*"leaseId":"1"/.test(log()), 3000), 'board.timeout.fired lease 1');

    // NOT WEDGED: a fresh post is delivered as a NEW lease (the ring recovered).
    await fetch(`${pair.rest.baseUrl}/api/conversations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'nonce-two', author: 'alex' }),
    });
    const isTwo = (m) => m.method === 'notifications/claude/channel' && m.params?.content?.includes('nonce-two');
    assert.ok(await poll(() => stream.messages.some(isTwo)), 'ring recovered — the second post was delivered');
    const env2 = stream.messages.find(isTwo);
    assert.notEqual(env2.params.meta.token_ring_lease_id, '1', 'a fresh lease, not the timed-out one');

    // Every lifecycle line is well-formed schema v1 (parseable JSON, required fields).
    const lines = log().split('\n').filter((l) => l.includes('[#410 lifecycle] '));
    assert.ok(lines.length > 0, 'lifecycle stream is non-empty');
    for (const l of lines) {
      const rec = JSON.parse(l.slice(l.indexOf('[#410 lifecycle] ') + '[#410 lifecycle] '.length));
      assert.ok(typeof rec.stage === 'string' && !rec.stage.includes(' '), `stage is a token: ${rec.stage}`);
      assert.ok('leaseId' in rec && 'envelopeId' in rec && typeof rec.ts === 'string', 'required correlation fields present');
      if (rec.leaseId !== null) assert.equal(typeof rec.leaseId, 'string', 'leaseId serialized as string');
    }
  } finally {
    stream.close();
    await pair.stop();
  }
});

// #712 — the third state, and the one with no coverage until now.
//
// broadcastTokenRing has three behaviours. Two were pinned; this one — armed,
// then the ring empties — was not, and it is the one that STOPS DELIVERY
// (mcp-server.mjs: R2 fail-closed, returns 0, nobody receives). Reconnect churn
// empties a ring routinely, so this is not an exotic state.
//
// The trap this test is written against, recorded on #712: adding a test here
// is easy, and adding a SECOND test that manufactures its own precondition is
// just as easy. The file's :66 test asserts a fallback under a world where nothing
// ever registers — it cannot fail. So this one carries a POSITIVE CONTROL: it
// first proves a populated ring DOES deliver, through the same observation path,
// before asserting that an emptied one does not. Without that, "nothing arrived"
// is indistinguishable from "this harness never observes arrivals at all."
test('armed, then the ring EMPTIES: delivery holds (fail-closed) — with a positive control that delivery is observable at all', async () => {
  const pair = await startTokenRingPair();
  const holder = await mcpSession(pair.mcp.mcpUrl);
  const observer = await mcpSession(pair.mcp.mcpUrl);   // never registers — the fan-out detector
  const holderStream = await openChannelStream(pair.mcp.mcpUrl, holder.sessionId);
  const observerStream = await openChannelStream(pair.mcp.mcpUrl, observer.sessionId);
  const post = (body) => fetch(`${pair.rest.baseUrl}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body, author: 'alex' }),
  });
  try {
    const reg = await holder.rpc('scrum/session/register', { seatId: 'tester.sb', author: 'tester' });
    assert.equal(reg.result.ok, true, `register succeeded: ${JSON.stringify(reg)}`);

    // ── POSITIVE CONTROL ──────────────────────────────────────────────────
    // Armed AND populated: a post must arrive. This is what makes the negative
    // assertion below meaningful rather than vacuous.
    assert.equal((await post('control post — the ring is populated')).status, 201);
    const env = await holderStream.next('notifications/claude/channel');
    assert.ok(env.params.content.includes('control post'),
      'POSITIVE CONTROL: an armed, populated ring delivers — so this harness can observe delivery');

    // ── empty the ring ────────────────────────────────────────────────────
    // A DELETE closes the session, which fires transport.onclose, which releases
    // the seat. Abandoning the stream would NOT do it — the session map only
    // shrinks on a clean close.
    await fetch(pair.mcp.mcpUrl, { method: 'DELETE', headers: { 'Mcp-Session-Id': holder.sessionId } });
    assert.ok(await poll(() => /released on close/.test(pair.mcp.stdoutText())),
      'the holder’s seat was released — the ring is now armed AND empty');

    // ── the state under test ──────────────────────────────────────────────
    assert.equal((await post('post into an emptied ring')).status, 201);
    await new Promise((r) => setTimeout(r, 800));
    const leaked = observerStream.messages.filter((m) => m.method === 'notifications/claude/channel');
    assert.equal(leaked.length, 0,
      'armed + empty ring must NOT fall back to fan-out — a transient empty ring would wake every seat during recovery');
    assert.match(pair.mcp.stdoutText(), /R2 fail-closed/,
      'and it took the fail-closed path specifically, not merely a silent drop');
  } finally {
    holderStream.close();
    observerStream.close();
    await pair.stop();
  }
});
