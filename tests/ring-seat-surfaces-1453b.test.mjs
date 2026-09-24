/**
 * #1453 slice 1b — the TOKEN RING counts a SEAT once, on the lane that surfaces.
 *
 * Measured 09-24 00:35Z: one seat had three ring members (a chat lane
 * `x.sb`, a probe lane `x.cs`, and a tool connection registered under the bare
 * key `x`). Her turns went to the tool connection, whose pushes never reach her
 * chat, and her chat lane was skipped. The card's rule: pick the lane by a
 * DECLARED property, never by recency or by whichever lane bound last.
 *
 * So a lane may declare `surfaces` at registration. Once any lane of a seat
 * (its `author`) declares `surfaces: true`, that lane is the seat's ONLY ring
 * member, and its siblings (a probe, a bare-key tool connection) leave the
 * ring. A seat whose lanes declare nothing is unchanged: every lane stays a
 * member, exactly as before. Nothing moves until a client opts in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSeatRegistry } from '../core/seat-registry.mjs';
import { createTokenRingEngine } from '../core/token-ring-engine.mjs';

function room({ declare = true } = {}) {
  const r = createSeatRegistry();
  r.register({ seatId: 'x.sb', sessionId: 's-sb', author: 'x', ...(declare ? { surfaces: true } : {}) });
  r.register({ seatId: 'x.cs', sessionId: 's-cs', author: 'x', ...(declare ? { surfaces: false } : {}) });
  r.register({ seatId: 'x', sessionId: 's-tool', author: 'x' });   // bearer-style tool connection
  r.register({ seatId: 'ada', sessionId: 's-ada', author: 'ada' });
  r.register({ seatId: 'grace', sessionId: 's-grace', author: 'grace' });
  return r;
}

test('#1453b ringSeats: a seat with a surfacing lane is ONE member, that lane; its siblings leave the ring', () => {
  const r = room();
  assert.deepEqual(r.ringSeats().sort(), ['ada', 'grace', 'x.sb']);
  assert.deepEqual(r.seats().sort(), ['ada', 'grace', 'x', 'x.cs', 'x.sb'], 'registration (receive) is untouched: every lane is still registered');
});

test('#1453b ringSeats: with NO declarations the ring is every lane, exactly as before', () => {
  const r = room({ declare: false });
  assert.deepEqual(r.ringSeats().sort(), r.seats().sort());
});

test('#1453b surfacesForSeat reads back the declaration; undeclared is null, not false', () => {
  const r = room();
  assert.equal(r.surfacesForSeat('x.sb'), true);
  assert.equal(r.surfacesForSeat('x.cs'), false);
  assert.equal(r.surfacesForSeat('x'), null);
});

test('#1453b the surfacing lane leaving hands the seat back to its remaining lanes (no seat is dropped from the ring by a departure)', () => {
  const r = room();
  r.release({ sessionId: 's-sb' });
  const ring = r.ringSeats().sort();
  assert.ok(ring.includes('x') || ring.includes('x.cs'), `the seat is still reachable: ${ring}`);
});

test('#1453b ENGINE: the seat\'s turn is granted to the surfacing lane, and the tool connection never holds a lease', () => {
  const r = room();
  const eng = createTokenRingEngine({ registry: r });
  const granted = [];
  let out = eng.handlePost({ author: 'alex', body: 'hello room', id: 'p1' });
  for (let i = 0; i < 6; i++) {
    if (out.deliveries.length) granted.push(out.deliveries[0].seatId);
    const lease = eng.snapshot().lease;
    if (!lease) break;
    out = eng.handleTimeout({ seatId: lease.holder, leaseId: lease.id });
  }
  assert.ok(granted.includes('x.sb'), `the seat was granted on its chat lane: ${granted}`);
  assert.ok(!granted.includes('x') && !granted.includes('x.cs'), `no turn went to the tool connection or the probe: ${granted}`);
  assert.equal(eng.snapshot().ring.filter((s) => s.startsWith('x')).length, 1, 'one ring member for the seat');
});

// ── the seam: a live pair in token-ring mode, one seat with two lanes ─────────
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort, startRestServer, startMcpServer, mcpSession, openChannelStream } from './helpers/harness.mjs';

const RING = { mode: 'token-ring', soft: { minMs: 30000, maxMs: 60000 }, hard: { timeoutMs: 300000 }, tokenRing: { timeoutMs: 300000 } };
async function pair() {
  const restPort = await freePort(); const mcpPort = await freePort();
  const cfgFile = path.join(os.tmpdir(), `ring-1453b-${process.pid}-${restPort}.json`);
  fs.writeFileSync(cfgFile, JSON.stringify(RING));
  const rest = await startRestServer({ port: restPort, mcpNotifyUrl: `http://127.0.0.1:${mcpPort}/internal/notify` });
  const mcp = await startMcpServer({ port: mcpPort, restApiBase: rest.baseUrl, env: { SCRUM_CHANNEL_STAGGER: '', SCRUM_CHANNEL_CONFIG_FILE: cfgFile } });
  return { rest, mcp, async stop() { await mcp.stop(); await rest.stop(); try { fs.unlinkSync(cfgFile); } catch { /* */ } } };
}
const envelope = (st) => st.messages.find((m) => m.method === 'notifications/claude/channel' && m.params?.meta?.token_ring_lease_id);

test('#1453b SEAM: in token-ring mode the seat\'s turn reaches its SURFACING lane, the probe lane holds no turn, and status says so', { timeout: 30000 }, async () => {
  const p = await pair();
  const chat = await mcpSession(p.mcp.mcpUrl);
  const probe = await mcpSession(p.mcp.mcpUrl);
  const chatStream = await openChannelStream(p.mcp.mcpUrl, chat.sessionId);
  const probeStream = await openChannelStream(p.mcp.mcpUrl, probe.sessionId);
  try {
    // the probe registers FIRST, so neither bind order nor recency can be what picks the lane
    assert.equal((await probe.rpc('scrum/session/register', { seatId: 'xx.cs', author: 'xx', surfaces: false })).result.ok, true);
    assert.equal((await chat.rpc('scrum/session/register', { seatId: 'xx.sb', author: 'xx', surfaces: true })).result.ok, true);
    await fetch(`${p.rest.baseUrl}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'turn for the seat', author: 'alex' }) });
    const deadline = Date.now() + 5000;
    while (!envelope(chatStream) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(envelope(chatStream), 'the surfacing lane was granted the ring turn');
    assert.ok(!envelope(probeStream), 'the probe lane never holds a ring turn');
    const st = await (await fetch(`${p.mcp.mcpUrl.replace(/\/mcp$/, '')}/channel/status`)).json();
    assert.deepEqual(st.ring.members, ['xx.sb'], 'one ring member for the seat');
    assert.deepEqual([...st.ring.registered].sort(), ['xx.cs', 'xx.sb'], 'both lanes still registered (receive-set)');
  } finally { chatStream.close(); probeStream.close(); await p.stop(); }
});

test('#1453b review: a SECOND lane of the same seat declaring surfaces:true is NOT silently picked by bind order; it is refused as a conflict and stays undeclared', () => {
  const r = createSeatRegistry();
  const a = r.register({ seatId: 'x.sb', sessionId: 's1', author: 'x', surfaces: true });
  assert.equal(a.ok, true);
  const b = r.register({ seatId: 'x.sb2', sessionId: 's2', author: 'x', surfaces: true });
  assert.equal(b.ok, true, 'the lane still registers (it still receives)');
  assert.equal(b.surfacesConflict, 'x.sb', 'the conflict is named, so the caller can log it loudly');
  assert.equal(r.surfacesForSeat('x.sb2'), null, 'the second declaration is not recorded');
  assert.deepEqual(r.ringSeats(), ['x.sb'], 'the seat keeps its FIRST declared surfacing lane, and the conflict is reported, not decided by order silently');
});

test('#1453b review: a re-register of the same lane WITHOUT `surfaces` keeps its earlier declaration (a reconnect does not reset it)', () => {
  const r = createSeatRegistry();
  r.register({ seatId: 'x.sb', sessionId: 's1', author: 'x', surfaces: true });
  r.register({ seatId: 'x.sb', sessionId: 's1b', author: 'x' });
  assert.equal(r.surfacesForSeat('x.sb'), true);
});
