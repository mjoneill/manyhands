/**
 * #717 — A STOPPED SEAT IS NAMED, AND AN IDLE ONE IS NOT.
 *
 * The card's four controls, each written so it can fail:
 *   POSITIVE     open stream + stale client request + a claim → named STOPPED,
 *                and NOT named deaf.
 *   REFUTED-SHAPE the heartbeat fields stay TRUE and FRESH throughout a stall;
 *                a decision that consulted them would call the seat healthy.
 *                Ours does not consult them — fed fresh beats, it still names.
 *   HOLE-SPECIFIC closing a stream bumps lastActivity and must NOT move
 *                lastClientRequestAt (through a real MCP server).
 *   RAIL         a genuinely idle seat — no claim — is NOT reported stopped,
 *                and neither is a seat whose request is recent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, stoppedSeats, staleSeats } from '../scripts/fanout-decide.mjs';
import fs from 'node:fs';
import { startMcpServer, startRestServer, mcpSession } from './helpers/harness.mjs';

const MIN = 60_000;
const T0 = 1_757_060_000_000;
const iso = (ms) => new Date(ms).toISOString();
const base = { floor: 3, cooldownMs: 6 * 3600 * 1000, now: T0, receivers: 3, sessions: 4 };
const healthy = { r: 3, s: 4, pendingFrom: null, warned: false, sigTimes: {}, hist: [3, 3, 3, 3, 3, 3] };

// The status as it read during the measured 3h08m stall: stream open, heartbeat
// true and fresh (the server stamping its own writes), and no client request
// for hours.
const STATUS_STALLED = {
  binding: 'active', receivers: 3, sessions: 4, unbound: 1,
  seats: {
    alpha: { streams: 1, sessions: 1, lastBeatAt: iso(T0 - 5_000), lastBeatOk: true, lastClientRequestAt: iso(T0 - 3 * 60 * MIN) },
    beta: { streams: 1, sessions: 1, lastBeatAt: iso(T0 - 5_000), lastBeatOk: true, lastClientRequestAt: iso(T0 - 2 * MIN) },
    gamma: { streams: 1, sessions: 1, lastBeatAt: iso(T0 - 5_000), lastBeatOk: true, lastClientRequestAt: iso(T0 - 4 * 60 * MIN) },
    healthcheck: { streams: 0, sessions: 1, lastBeatAt: null, lastBeatOk: null, lastClientRequestAt: null },
  },
  staleSessions: [],
};
const CLAIMS = { alpha: [717], beta: [1201] };   // gamma holds nothing: she is resting

test('#717 POSITIVE: open stream + stale request + a claim → named STOPPED, and NOT named deaf', () => {
  const stopped = stoppedSeats(STATUS_STALLED, { now: T0, staleMs: 20 * MIN, claimsBySeat: CLAIMS });
  assert.deepEqual(stopped.map((s) => s.seat), ['alpha'], 'alpha only: beta is recent, gamma holds no claim');
  assert.deepEqual(stopped[0].claims, [717]);
  const { warnBody } = decide({ ...base, state: healthy, stoppedSeats: stopped, staleSeats: staleSeats(STATUS_STALLED) });
  assert.ok(warnBody);
  assert.match(warnBody, /SEAT STOPPED/);
  assert.match(warnBody, /alpha/); assert.match(warnBody, /#717/); assert.match(warnBody, /180 min/);
  assert.doesNotMatch(warnBody, /DEAF SEAT|deaf seat named/i, 'stopped is not deaf: the stream is open');
  assert.doesNotMatch(warnBody, /beta|gamma/);
});

test('#717 REFUTED SHAPE: heartbeat fields read TRUE and FRESH through the whole stall — the decision must not consult them', () => {
  // Same seat, same stall, heartbeat stamped ONE SECOND ago: the refuted fix
  // shape would read this as healthy. Ours names it anyway.
  const s = JSON.parse(JSON.stringify(STATUS_STALLED));
  s.seats.alpha.lastBeatAt = iso(T0 - 1_000); s.seats.alpha.lastBeatOk = true;
  const stopped = stoppedSeats(s, { now: T0, staleMs: 20 * MIN, claimsBySeat: CLAIMS });
  assert.deepEqual(stopped.map((x) => x.seat), ['alpha']);
  // and the mirror: a seat with a STALE beat but a RECENT request is fine
  s.seats.beta.lastBeatAt = iso(T0 - 60 * MIN); s.seats.beta.lastBeatOk = false;
  assert.deepEqual(stoppedSeats(s, { now: T0, staleMs: 20 * MIN, claimsBySeat: CLAIMS }).map((x) => x.seat), ['alpha'], 'beat fields are noise here');
});

test('#717 RAIL: an idle seat (no claim) is NOT reported; neither is one whose request is recent; nor one we have never heard from', () => {
  assert.deepEqual(stoppedSeats(STATUS_STALLED, { now: T0, staleMs: 20 * MIN, claimsBySeat: {} }), [], 'no claims anywhere → nobody is stopped, however quiet');
  const s = JSON.parse(JSON.stringify(STATUS_STALLED));
  s.seats.alpha.lastClientRequestAt = null;             // unknown, not stale-since-1970
  assert.deepEqual(stoppedSeats(s, { now: T0, staleMs: 20 * MIN, claimsBySeat: CLAIMS }), []);
  s.seats.alpha.lastClientRequestAt = iso(T0 - 19 * MIN); // under the threshold
  assert.deepEqual(stoppedSeats(s, { now: T0, staleMs: 20 * MIN, claimsBySeat: CLAIMS }), []);
});

test('#717 one stall warns ONCE; a request from the seat ends the episode; a later stall is a new fact', () => {
  const stopped = stoppedSeats(STATUS_STALLED, { now: T0, staleMs: 20 * MIN, claimsBySeat: CLAIMS });
  const t1 = decide({ ...base, state: healthy, stoppedSeats: stopped });
  assert.ok(t1.warnBody);
  const t2 = decide({ ...base, now: T0 + 5 * MIN, state: t1.state, stoppedSeats: stopped });
  assert.equal(t2.warnBody, null);
  const t3 = decide({ ...base, now: T0 + 10 * MIN, state: t2.state, stoppedSeats: [] });   // she made a request
  assert.equal(t3.warnBody, null); assert.deepEqual(t3.state.stoppedEpisodes, {});
  const later = [{ ...stopped[0], lastClientRequestAt: iso(T0 + 10 * MIN) }];
  const t4 = decide({ ...base, now: T0 + 40 * MIN, state: t3.state, stoppedSeats: later });
  assert.ok(t4.warnBody, 'a new stall after a request is a new fact');
});

test('#717 the field MOVES on a client request, through a REAL MCP server', async () => {
  const rest = await startRestServer();
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const status = async () => (await fetch(`${mcp.mcpUrl.replace(/\/mcp\/?$/, '')}/channel/status`)).json();
    const session = await mcpSession(mcp.mcpUrl);
    await session.callTool('board_status', {});                    // a client request
    const s1 = await status();
    const all1 = [...Object.values(s1.seats || {}), ...(s1.unboundSessions || [])];
    const withReq = all1.filter((x) => typeof x.lastClientRequestAt === 'string');
    assert.ok(withReq.length >= 1, `the field MOVED on a request — the build's first act is to observe a field move: ${JSON.stringify(all1).slice(0, 300)}`);
    if (typeof session.close === 'function') await session.close();
  } finally { await mcp.stop(); await rest.stop(); }
});

test('#717 HOLE-SPECIFIC, structural: lastClientRequestAt is written at EXACTLY ONE site and that site is not the stream close handler', () => {
  // The harness cannot make the server observe a stream close inside a test
  // budget (tried: the count never fell within 4 s), so the hole is pinned on
  // the SOURCE instead, where it can actually refuse: put the write back into
  // res.on('close') and this test goes red. A structural tripwire is weaker
  // than a behavioural one and says so; it is not a decoration that passes
  // with the hole present, which the first version of this test was.
  const src = fs.readFileSync(new URL('../mcp-server.mjs', import.meta.url), 'utf8');
  const writes = [...src.matchAll(/m\.lastClientRequestAt = Date\.now\(\)/g)];
  assert.equal(writes.length, 1, `exactly one write site, found ${writes.length}`);
  const closeStart = src.indexOf("res.on('close', () => {");
  assert.ok(closeStart > 0, 'the close handler exists');
  const closeEnd = src.indexOf('});', closeStart);
  const closeBody = src.slice(closeStart, closeEnd);
  assert.doesNotMatch(closeBody, /lastClientRequestAt/, 'the close handler must not touch the client clock — that is the hole this card records');
  assert.match(closeBody, /lastActivity = Date\.now\(\)/, 'and it still bumps the reaper clock, which is correct there');
});
