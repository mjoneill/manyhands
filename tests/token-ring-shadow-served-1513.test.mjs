/**
 * #1513 — the SHADOW lines reach the served log, and the server behaves exactly
 * as it did before them. Two measured defects, reproduced through the real MCP
 * server (not the engine alone), so the wiring is what is proven:
 *   C — a holder evicted mid-lease because ANOTHER seat spoke inside the live window;
 *   B — a holder's unrelated post counted as the RESPOND to its lease, by author alone.
 * Isolated: throwaway ports + temp board/config, never touches the live board.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort, startRestServer, startMcpServer, mcpSession, openChannelStream } from './helpers/harness.mjs';

const RING = { mode: 'token-ring', soft: { minMs: 30000, maxMs: 60000 }, hard: { timeoutMs: 300000 }, tokenRing: { timeoutMs: 300000 } };
async function pair(extraEnv = {}) {
  const restPort = await freePort();
  const mcpPort = await freePort();
  const cfgFile = path.join(os.tmpdir(), `ring-1513-${process.pid}-${restPort}.json`);
  fs.writeFileSync(cfgFile, JSON.stringify(RING));
  const rest = await startRestServer({ port: restPort, mcpNotifyUrl: `http://127.0.0.1:${mcpPort}/internal/notify` });
  const mcp = await startMcpServer({ port: mcpPort, restApiBase: rest.baseUrl, env: { SCRUM_CHANNEL_STAGGER: '', SCRUM_CHANNEL_CONFIG_FILE: cfgFile, ...extraEnv } });
  return { rest, mcp, async stop() { await mcp.stop(); await rest.stop(); try { fs.unlinkSync(cfgFile); } catch { /* */ } } };
}
const post = (base, body, author = 'alex') => fetch(`${base}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body, author }) });
async function poll(fn, timeoutMs = 5000, stepMs = 50) { const d = Date.now() + timeoutMs; for (;;) { if (fn()) return true; if (Date.now() > d) return false; await new Promise((r) => setTimeout(r, stepMs)); } }
const shadow = (log, kind) => [...log.matchAll(new RegExp(`\\[#1513 shadow\\] ${kind} (\\{.*\\})`, 'g'))].map((m) => JSON.parse(m[1]));

test('#1513 — a mid-lease eviction and an author-bound RESPOND are both logged by the served ring, and both still happen', async () => {
  const p = await pair({ SCRUM_TOKEN_RING_TIMEOUT_MS: '300000', SCRUM_LIVE_WINDOW_MS: '600' });
  const a = await mcpSession(p.mcp.mcpUrl);
  const aStream = await openChannelStream(p.mcp.mcpUrl, a.sessionId);
  const b = await mcpSession(p.mcp.mcpUrl);
  const bStream = await openChannelStream(p.mcp.mcpUrl, b.sessionId);
  const log = () => p.mcp.stdoutText();
  try {
    assert.equal((await a.rpc('scrum/session/register', { seatId: 'a.sb', author: 'aa' })).result.ok, true);
    assert.equal((await b.rpc('scrum/session/register', { seatId: 'b.sb', author: 'bb' })).result.ok, true);
    await new Promise((r) => setTimeout(r, 800));   // both idle past the window ⇒ tier 2: a is granted the seed
    await post(p.rest.baseUrl, 'seed-one');
    const first = await Promise.race([aStream.next('notifications/claude/channel'), bStream.next('notifications/claude/channel')]);
    assert.equal(first.params.meta.token_ring_seat, 'a.sb', 'control: a holds lease 1');

    // b speaks inside the window; a stays quiet. An UNRELATED post now re-tests the held lease.
    await b.rpc('ping', {}).catch(() => {});
    await post(p.rest.baseUrl, 'unrelated-chatter');
    const second = await bStream.next('notifications/claude/channel');
    assert.equal(second.params.meta.token_ring_seat, 'b.sb', 'BEHAVIOUR UNCHANGED: the unrelated post still took the lease from a');

    assert.ok(await poll(() => shadow(log(), 'mid-lease-eviction').length >= 1), `the eviction is logged: ${log().slice(-500)}`);
    const ev = shadow(log(), 'mid-lease-eviction')[0];
    assert.equal(ev.holder, 'a.sb');
    assert.equal(ev.leaseId, 1);
    assert.equal(ev.inputs.activeContender, 'b.sb', 'names the seat whose speech evicted her');
    assert.equal(ev.inputs.liveWindowMs, 600);
    assert.ok(ev.inputs.msSinceLastRequest > 600, 'and the age that made her "inactive"');

    // B — b (the holder now) writes something that never saw the envelope: the author alone counts it.
    await post(p.rest.baseUrl, 'b-writes-something-unrelated', 'bb');
    assert.ok(await poll(() => shadow(log(), 'respond').length >= 1), `the RESPOND is logged: ${log().slice(-500)}`);
    const r = shadow(log(), 'respond')[0];
    assert.equal(r.holder, 'b.sb');
    assert.equal(r.boundBy, 'author', 'no session is passed at this call site: identity by author label');
    assert.equal(r.carriedEnvelopeId, null);
    assert.equal(r.echoed, false);
    assert.equal(r.currentEnvelopeId, second.params.meta.token_ring_envelope_id, 'names the envelope it was supposed to answer');
  } finally { aStream.close(); bStream.close(); await p.stop(); }
});
