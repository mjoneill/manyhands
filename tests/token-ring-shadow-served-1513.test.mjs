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

// ── the RESIDENT path: a slot that expires over a live turn, and one that closes on time ──
const api = async (base, method, p, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* empty */ }
  return { status: r.status, body: j };
};
const RESIDENT = (seatKey) => ({ seatKey, name: seatKey, emoji: '🤖', prompt: 'Answer only from what you are handed.', model: { model: 'test-model', protocol: 'ollama-native', baseUrl: 'http://127.0.0.1:1' }, toolGrants: ['conversation_post'], budgetPerDay: 0.5, by: 'owner' });
async function inviteResident(base, seatKey) {
  assert.equal((await api(base, 'POST', '/api/agents', RESIDENT(seatKey))).status, 201);
  assert.equal((await api(base, 'PATCH', `/api/agents/${seatKey}`, { deliveryMode: 'channel', by: 'owner' })).status, 200);
}
const deliveriesTo = async (base, seat) => (await api(base, 'GET', `/api/deliveries?to=${seat}`)).body.deliveries ?? [];
const event = (base, d, state, by) => api(base, 'POST', `/api/deliveries/${encodeURIComponent(d.id)}/events`, { state, source: 'guest-runner', by });
const residentLines = (log) => [...log.matchAll(/\[#1513 shadow\] resident-slot (\{.*\})/g)].map((m) => JSON.parse(m[1]));

// Bring the ring to the point where the residents' slot opens: a stream seat holds, then RESPONDs.
async function openResidentSlot(p, resident) {
  await inviteResident(p.rest.baseUrl, resident);
  const holder = await mcpSession(p.mcp.mcpUrl);
  const stream = await openChannelStream(p.mcp.mcpUrl, holder.sessionId);
  await holder.rpc('scrum/session/register', { seatId: 'tester.sb', author: 'tester' });
  await post(p.rest.baseUrl, 'hello, room', 'owner');
  await new Promise((r) => setTimeout(r, 400));
  await post(p.rest.baseUrl, 'holder answers', 'tester');
  const offers = await (async () => { for (let i = 0; i < 60; i++) { const d = await deliveriesTo(p.rest.baseUrl, resident); if (d.length >= 2) return d; await new Promise((r) => setTimeout(r, 100)); } return null; })();
  assert.ok(offers, 'the resident was offered both posts');
  return { offers, stream };
}

test('#1513 — a resident slot that EXPIRES over a live turn is logged as timeout with the turn still running', async () => {
  const p = await pair({ SCRUM_TOKEN_RING_TIMEOUT_MS: '1500', SCRUM_DIRECT_SLOT_FLOOR_MS: '1500', MCP_DIRECT_TICK_MS: '250' });
  let stream;
  try {
    const opened = await openResidentSlot(p, 'lin');
    stream = opened.stream;
    // the runner claims and STARTS the turn, then never finishes inside the slot
    for (const d of opened.offers) { await event(p.rest.baseUrl, d, 'claimed', 'lin'); await event(p.rest.baseUrl, d, 'turn-started', 'lin'); }
    assert.ok(await poll(() => residentLines(p.mcp.stdoutText()).some((l) => l.outcome === 'timeout'), 8000), `a timeout line was logged: ${p.mcp.stdoutText().slice(-700)}`);
    const l = residentLines(p.mcp.stdoutText()).find((x) => x.outcome === 'timeout');
    assert.equal(l.seat, 'lin');
    assert.equal(l.turnRunningAtClose, true, 'the slot ended over a live turn — the receipt existed and the slot ignored it');
    assert.ok(l.turnRunMsAtClose > 0);
    assert.equal(l.publishedAt, null);
    assert.equal(l.deliveryCount, 2);
    assert.equal(l.slotMs, 1500);
  } finally { stream?.close(); await p.stop(); }
});

test('#1513 — a resident slot that closes on a published turn is logged with the turn length, and the slot still advances on terminal', async () => {
  const p = await pair({ SCRUM_TOKEN_RING_TIMEOUT_MS: '300000', MCP_DIRECT_TICK_MS: '250' });
  let stream;
  try {
    const opened = await openResidentSlot(p, 'ada');
    stream = opened.stream;
    for (const d of opened.offers) { await event(p.rest.baseUrl, d, 'claimed', 'ada'); await event(p.rest.baseUrl, d, 'turn-started', 'ada'); await event(p.rest.baseUrl, d, 'published', 'ada'); }
    assert.ok(await poll(() => residentLines(p.mcp.stdoutText()).some((l) => l.outcome === 'published'), 6000), `a published line was logged: ${p.mcp.stdoutText().slice(-700)}`);
    const l = residentLines(p.mcp.stdoutText()).find((x) => x.outcome === 'published');
    assert.equal(l.seat, 'ada');
    assert.equal(l.turnRunningAtClose, false);
    assert.equal(l.publishedAfterClose, false);
    assert.ok(l.turnMs >= 0 && l.claimToTurnStartMs >= 0);
    assert.ok(await poll(() => /\[#1362 direct\] ada published \(\d+ record\(s\)\) → slot advanced: terminal/.test(p.mcp.stdoutText()), 3000), 'BEHAVIOUR UNCHANGED: the slot still advanced on the terminal state');
  } finally { stream?.close(); await p.stop(); }
});

// ── a turn that OUTLIVES its slot: the censored case, at exactly the bound being sized ──
const lateLines = (log) => [...log.matchAll(/\[#1513 shadow\] resident-turn-late (\{.*\})/g)].map((m) => JSON.parse(m[1]));
const unfinishedLines = (log) => [...log.matchAll(/\[#1513 shadow\] resident-turn-unfinished (\{.*\})/g)].map((m) => JSON.parse(m[1]));

test('#1513 — a resident turn that outlives its slot is logged with its length when it finally publishes', async () => {
  const p = await pair({ SCRUM_TOKEN_RING_TIMEOUT_MS: '1500', SCRUM_DIRECT_SLOT_FLOOR_MS: '1500', MCP_DIRECT_TICK_MS: '250' });
  let stream;
  try {
    const opened = await openResidentSlot(p, 'lin');
    stream = opened.stream;
    for (const d of opened.offers) { await event(p.rest.baseUrl, d, 'claimed', 'lin'); await event(p.rest.baseUrl, d, 'turn-started', 'lin'); }
    assert.ok(await poll(() => residentLines(p.mcp.stdoutText()).some((l) => l.outcome === 'timeout'), 8000), 'the slot timed out over the live turn');
    assert.equal(lateLines(p.mcp.stdoutText()).length, 0, 'control: nothing is late while the turn is still running');
    // the turn outlives the slot, then finishes: its length must still be recorded
    for (const d of opened.offers) await event(p.rest.baseUrl, d, 'published', 'lin');
    assert.ok(await poll(() => lateLines(p.mcp.stdoutText()).length >= 1, 6000), `a late line was logged: ${p.mcp.stdoutText().slice(-800)}`);
    const l = lateLines(p.mcp.stdoutText())[0];
    assert.equal(l.seat, 'lin');
    assert.equal(l.outcome, 'late');
    assert.equal(l.publishedAfterClose, true);
    assert.ok(l.turnMs > 0, 'the length of the turn that outlived the slot — the censored figure');
    assert.equal(l.turnRunningAtClose, true, 'and at the moment the slot closed it was still running');
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(lateLines(p.mcp.stdoutText()).length, 1, 'logged once, then off the watch list');
  } finally { stream?.close(); await p.stop(); }
});

test('#1513 — a resident turn that NEVER finishes is reported as unfinished, so a censored turn is visible as censored', async () => {
  const p = await pair({ SCRUM_TOKEN_RING_TIMEOUT_MS: '1500', SCRUM_DIRECT_SLOT_FLOOR_MS: '1500', MCP_DIRECT_TICK_MS: '250', SCRUM_LATE_WATCH_MAX_MS: '1200' });
  let stream;
  try {
    const opened = await openResidentSlot(p, 'lin');
    stream = opened.stream;
    for (const d of opened.offers) { await event(p.rest.baseUrl, d, 'claimed', 'lin'); await event(p.rest.baseUrl, d, 'turn-started', 'lin'); }
    assert.ok(await poll(() => unfinishedLines(p.mcp.stdoutText()).length >= 1, 10000), `an unfinished line was logged: ${p.mcp.stdoutText().slice(-800)}`);
    const u = unfinishedLines(p.mcp.stdoutText())[0];
    assert.equal(u.seat, 'lin');
    assert.ok(u.watchedMs >= 1200);
    assert.equal(lateLines(p.mcp.stdoutText()).length, 0);
  } finally { stream?.close(); await p.stop(); }
});
