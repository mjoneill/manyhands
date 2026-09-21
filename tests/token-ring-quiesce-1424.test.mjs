/**
 * #1424 — the ring engine honoured neither the delivery mode nor stream
 * liveness. Measured 2026-09-20 during the #1396 supervised trial:
 *   A · the owner flipped TokenRing → off at 14:25:22Z; the timeout handler
 *       granted lease 5 at 14:28:56Z and lease 6 at 14:33:56Z regardless, and
 *       re-delivered ring-held posts to a seat that had them by fan-out already.
 *   B · two registrations whose streams were dead each held a full 300 s lease.
 * Served, one REST + one MCP on a config file the test rewrites mid-lease.
 * Sabotage: (A) the mode read in the timeout path removed ⇒ "no grant after
 * OFF" reads a grant; (B) the deliverable hook detached ⇒ the dead seat holds
 * a lease and the live seat waits it out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort, startRestServer, startMcpServer, mcpSession, openChannelStream } from './helpers/harness.mjs';

const RING = { mode: 'token-ring', soft: { minMs: 30000, maxMs: 60000 }, hard: { timeoutMs: 300000 }, tokenRing: { timeoutMs: 300000 } };
const OFF = { ...RING, mode: 'off' };

async function pair(extraEnv = {}) {
  const restPort = await freePort(); const mcpPort = await freePort();
  const cfgFile = path.join(os.tmpdir(), `ring-1424-${process.pid}-${restPort}.json`);
  fs.writeFileSync(cfgFile, JSON.stringify(RING));
  const rest = await startRestServer({ port: restPort, mcpNotifyUrl: `http://127.0.0.1:${mcpPort}/internal/notify` });
  const mcp = await startMcpServer({ port: mcpPort, restApiBase: rest.baseUrl, env: { SCRUM_CHANNEL_STAGGER: '', SCRUM_CHANNEL_CONFIG_FILE: cfgFile, ...extraEnv } });
  return { rest, mcp, cfgFile, async stop() { await mcp.stop(); await rest.stop(); try { fs.unlinkSync(cfgFile); } catch { /* */ } } };
}
const post = (base, body) => fetch(`${base}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body, author: 'alex' }) });
async function poll(fn, timeoutMs = 5000, stepMs = 50) { const d = Date.now() + timeoutMs; for (;;) { if (fn()) return true; if (Date.now() > d) return false; await new Promise((r) => setTimeout(r, stepMs)); } }
const grants = (log) => [...log.matchAll(/\[#410 lifecycle\] (\{.*"stage":"board\.grant".*\})/g)].map((m) => JSON.parse(m[1]));

test('#1424 A — a lease held when the mode flips OFF quiesces at the next timeout: no further grant, and a stale timeout is inert', async () => {
  const p = await pair({ SCRUM_TOKEN_RING_TIMEOUT_MS: '500' });
  const s = await mcpSession(p.mcp.mcpUrl);
  const stream = await openChannelStream(p.mcp.mcpUrl, s.sessionId);
  try {
    const reg = await s.rpc('scrum/session/register', { seatId: 'a.sb', author: 'aa' });
    assert.equal(reg.result.ok, true);
    await post(p.rest.baseUrl, 'nonce-one');
    const env1 = await stream.next('notifications/claude/channel');
    assert.equal(env1.params.meta.token_ring_lease_id, '1', 'control: lease 1 granted under token-ring');
    // The owner flips the mode OFF while lease 1 is held (the trial's 14:25:22Z).
    fs.writeFileSync(p.cfgFile, JSON.stringify(OFF));
    const log = () => p.mcp.stdoutText();
    assert.ok(await poll(() => /"stage":"board\.timeout\.fired".*"leaseId":"1"/.test(log()), 3000), 'lease 1 times out');
    assert.ok(await poll(() => /"stage":"board\.quiesce".*"reason":"mode-off"/.test(log()), 2000), `the timeout in off mode QUIESCES: ${log().slice(-600)}`);
    await new Promise((r) => setTimeout(r, 1200));   // two more TTLs: a zombie would have granted twice
    const g = grants(log());
    assert.deepEqual(g.map((x) => x.leaseId), ['1'], `no grant after OFF — the pre-fix log had lease 5 and 6 here: ${JSON.stringify(g.map((x) => x.leaseId))}`);
    // and the room still hears: off-mode fan-out delivers a new post at once
    await post(p.rest.baseUrl, 'nonce-two');
    assert.ok(await poll(() => stream.messages.some((m) => m.method === 'notifications/claude/channel' && m.params?.content?.includes('nonce-two'))), 'fan-out delivery after the flip');
    assert.ok(!stream.messages.some((m) => m.params?.meta?.token_ring_lease_id && m.params.meta.token_ring_lease_id !== '1'), 'no ring envelope after OFF');
  } finally { stream.close(); await p.stop(); }
});

test('#1424 B — a registered member with a DEAD stream is skipped at grant: the live seat gets the token at once, no lease is spent on the ghost', async () => {
  const p = await pair({ SCRUM_TOKEN_RING_TIMEOUT_MS: '300000', SCRUM_LIVE_WINDOW_MS: '600' });
  const ghost = await mcpSession(p.mcp.mcpUrl);
  const ghostStream = await openChannelStream(p.mcp.mcpUrl, ghost.sessionId);
  const live = await mcpSession(p.mcp.mcpUrl);
  const liveStream = await openChannelStream(p.mcp.mcpUrl, live.sessionId);
  try {
    assert.equal((await ghost.rpc('scrum/session/register', { seatId: 'g.sb', author: 'gg' })).result.ok, true);
    assert.equal((await live.rpc('scrum/session/register', { seatId: 'l.sb', author: 'll' })).result.ok, true);
    // the ghost's client goes silent past the live window; its stream object stays open (the 2026-09-20 shape)
    await new Promise((r) => setTimeout(r, 800));
    await live.rpc('ping', {}).catch(() => {});   // the live seat speaks inside the window
    await post(p.rest.baseUrl, 'nonce-skip');
    const env = await liveStream.next('notifications/claude/channel');
    assert.ok(env.params.content.includes('nonce-skip'), 'the LIVE seat received the turn');
    assert.equal(env.params.meta.token_ring_seat, 'l.sb', `granted to the live seat, not the ghost: ${JSON.stringify(env.params.meta)}`);
    const log = () => p.mcp.stdoutText();
    assert.ok(await poll(() => /"skipped":\["g\.sb"\]/.test(log()), 2000), `telemetry names the skipped ghost: ${log().slice(-400)}`);
    assert.ok(!ghostStream.messages.some((m) => m.method === 'notifications/claude/channel' && m.params?.content?.includes('nonce-skip')), 'the ghost was not handed the token');
  } finally { ghostStream.close(); liveStream.close(); await p.stop(); }
});

// #1434 — the regression 8b71c01 shipped: when EVERY member is quiet past the
// live window, the lap skipped them all and the ring went silent. On
// 2026-09-21 12:28→12:54Z every post fanned out to zero, the owner's included.
// A seat with an open, non-deaf stream is reachable; when nobody is "active",
// reachable is enough — a lease that may time out beats a post that reaches no one.
test('#1434 — two members, both holding open streams, both silent past the live window: a post is GRANTED (fanned to one of them), not skipped to silence', async () => {
  const p = await pair({ SCRUM_TOKEN_RING_TIMEOUT_MS: '300000', SCRUM_LIVE_WINDOW_MS: '600' });
  const a = await mcpSession(p.mcp.mcpUrl);
  const aStream = await openChannelStream(p.mcp.mcpUrl, a.sessionId);
  const b = await mcpSession(p.mcp.mcpUrl);
  const bStream = await openChannelStream(p.mcp.mcpUrl, b.sessionId);
  try {
    assert.equal((await a.rpc('scrum/session/register', { seatId: 'a.sb', author: 'aa' })).result.ok, true);
    assert.equal((await b.rpc('scrum/session/register', { seatId: 'b.sb', author: 'bb' })).result.ok, true);
    await new Promise((r) => setTimeout(r, 800));   // both idle past the window — the 12:28Z shape
    await post(p.rest.baseUrl, 'nonce-idle');
    const env = await Promise.race([aStream.next('notifications/claude/channel'), bStream.next('notifications/claude/channel')]);
    assert.ok(env.params.content.includes('nonce-idle'), 'an idle-but-listening seat received the turn');
    assert.ok(['a.sb', 'b.sb'].includes(env.params.meta.token_ring_seat), `granted to a member with an open stream: ${JSON.stringify(env.params.meta)}`);
    const log = () => p.mcp.stdoutText();
    assert.ok(await poll(() => grants(log()).length >= 1, 2000), `a board.grant was logged: ${log().slice(-400)}`);
    assert.ok(!/fanned out to 0 session/.test(log().split('nonce-idle').pop() || ''), 'no fan-out-to-zero after the post');
  } finally { aStream.close(); bStream.close(); await p.stop(); }
});

test('#1434 — the tier holds: a member that SPOKE inside the window still wins the grant over a quiet one (the Sunday ghost still loses)', async () => {
  const p = await pair({ SCRUM_TOKEN_RING_TIMEOUT_MS: '300000', SCRUM_LIVE_WINDOW_MS: '600' });
  const quiet = await mcpSession(p.mcp.mcpUrl);
  const quietStream = await openChannelStream(p.mcp.mcpUrl, quiet.sessionId);
  const live = await mcpSession(p.mcp.mcpUrl);
  const liveStream = await openChannelStream(p.mcp.mcpUrl, live.sessionId);
  try {
    assert.equal((await quiet.rpc('scrum/session/register', { seatId: 'q.sb', author: 'qq' })).result.ok, true);   // registered FIRST — ring order favours it
    assert.equal((await live.rpc('scrum/session/register', { seatId: 'l.sb', author: 'll' })).result.ok, true);
    await new Promise((r) => setTimeout(r, 800));
    await live.rpc('ping', {}).catch(() => {});
    await post(p.rest.baseUrl, 'nonce-tier');
    const env = await liveStream.next('notifications/claude/channel');
    assert.equal(env.params.meta.token_ring_seat, 'l.sb', `the active seat is granted over the quiet one: ${JSON.stringify(env.params.meta)}`);
  } finally { quietStream.close(); liveStream.close(); await p.stop(); }
});
