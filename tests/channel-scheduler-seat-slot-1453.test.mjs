/**
 * #1453 slice 1 — the fan-out SLOT is keyed on the SEAT, not the connection.
 *
 * Measured 09-24: one seat held three connections (a chat lane, a probe lane and
 * a tool connection), so hard mode gave her THREE serial slots and her chat lane
 * heard a post up to 20 minutes late. The receive-set stays per connection
 * (every open stream still gets the post); the SLOT-set is per seat (#298's
 * split). A connection that declares `surfaces: false` (a probe) still receives,
 * but outside the stagger, and never holds a slot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChannelScheduler } from '../core/channel-scheduler.mjs';

function fakeClock() {
  let t = 0; let seq = 0; const scheduled = [];
  return {
    now: () => t,
    schedule: (fn, ms) => { scheduled.push({ at: t + Math.max(0, ms), order: seq++, fn }); },
    advance: (ms) => {
      const target = t + ms;
      for (;;) {
        const due = scheduled.filter((s) => s.at <= target).sort((a, b) => a.at - b.at || a.order - b.order);
        if (!due.length) break;
        const n = due[0]; scheduled.splice(scheduled.indexOf(n), 1); t = n.at; n.fn();
      }
      t = target;
    },
  };
}
const seq = (vals) => { let i = 0; return () => vals[i++ % vals.length]; };
const HARD = { mode: 'hard', hard: { timeoutMs: 300000 } };

function run(targets, cfg = HARD, rng = () => 0) {
  const clock = fakeClock();
  const at = {};
  const s = createChannelScheduler({ getConfig: () => cfg, rng, now: clock.now, schedule: clock.schedule,
    deliver: (sid) => { at[sid] = clock.now(); } });
  s.dispatch(targets, { id: 'm1' });
  clock.advance(10 * 300000);
  return at;
}

test('#1453 hard mode: a seat with THREE connections holds ONE slot, and all three get it at the same time', () => {
  const at = run([
    { sessionId: 'ada-chat', seat: 'ada' },
    { sessionId: 'ada-tool', seat: 'ada' },
    { sessionId: 'ada-probe2', seat: 'ada' },
    { sessionId: 'grace-1', seat: 'grace' },
    { sessionId: 'hopper-1', seat: 'hopper' },
  ]);
  assert.equal(Object.keys(at).length, 5, 'every connection still receives');
  assert.equal(at['ada-chat'], at['ada-tool']);
  assert.equal(at['ada-chat'], at['ada-probe2']);
  const slots = new Set(Object.values(at));
  assert.equal(slots.size, 3, `three seats ⇒ three slots, got ${[...slots]}`);
  assert.equal(Math.max(...Object.values(at)), 2 * 300000, 'the tail is (seats-1)*timeout, not (connections-1)*timeout');
});

test('#1453 a connection that declares surfaces:false RECEIVES, immediately, and holds no slot', () => {
  const at = run([
    { sessionId: 'ada-chat', seat: 'ada' },
    { sessionId: 'ada-probe', seat: 'ada', surfaces: false },
    { sessionId: 'grace-1', seat: 'grace' },
  ], HARD, () => 0.99);
  assert.equal(at['ada-probe'], 0, 'the probe lane gets it at once, outside the stagger');
  const slotted = [at['ada-chat'], at['grace-1']].sort((a, b) => a - b);
  assert.deepEqual(slotted, [0, 300000], 'two seats ⇒ two slots; the probe added none');
});

test('#1453 soft mode is per seat too: a seat\'s connections share one delay', () => {
  const at = run([
    { sessionId: 'a1', seat: 'a' }, { sessionId: 'a2', seat: 'a' }, { sessionId: 'b1', seat: 'b' },
  ], { mode: 'soft', soft: { minMs: 30000, maxMs: 60000 } }, seq([0, 0.1, 0.9]));
  // A varying rng, so per-connection delays WOULD differ: a constant rng gives
  // every delayed connection the same delay and passes this vacuously.
  assert.equal(at.a1, at.a2);
  assert.notEqual(at.a1, at.b1, 'and the two seats still get different delays');
});

test('#1453 unchanged: bare session ids (and targets with no seat) are one slot each, as before', () => {
  const bare = run(['s1', 's2', 's3']);
  assert.equal(new Set(Object.values(bare)).size, 3);
  const noSeat = run([{ sessionId: 'x1' }, { sessionId: 'x2' }]);
  assert.equal(new Set(Object.values(noSeat)).size, 2, 'no seat ⇒ keyed on the session, never merged');
});

// ── the seam: a live pair, stagger ON, one seat holding TWO connections ───────
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startPair, mcpSession, openChannelStream, makeBoardFixture } from './helpers/harness.mjs';

test('#1453 THROUGH THE SERVER: two connections of ONE seat receive a post together, not a slot apart', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-slot-'));
  const tokens = path.join(dir, 'tokens.json');
  fs.writeFileSync(tokens, JSON.stringify({ tokens: { 'tok-ada': { seat: 'ada', heartbeat_s: 60 } } }));
  // Soft mode with a 20 s floor: one SLOT gets the post at once, every other
  // slot waits 20 s. Before #1453 each connection was its own slot, so of ada's
  // two connections exactly one had it at once and the other 20 s later. That's
  // deterministic, because the post's author (bo) has no connection here, so
  // ada's two connections are the only targets.
  const cfg = path.join(dir, 'channel-config.json');
  fs.writeFileSync(cfg, JSON.stringify({ mode: 'soft', soft: { minMs: 20000, maxMs: 20000 }, hard: { timeoutMs: 300000 } }));
  const { rest, mcp, stop } = await startPair({
    board: makeBoardFixture({ cards: [], conversations: [] }),
    mcpEnv: { SCRUM_SEAT_TOKENS: tokens, SCRUM_CHANNEL_STAGGER: 'on', SCRUM_CHANNEL_CONFIG_FILE: cfg },
  });
  try {
    const a1 = await mcpSession(mcp.mcpUrl, { headers: { Authorization: 'Bearer tok-ada' } });
    const a2 = await mcpSession(mcp.mcpUrl, { headers: { Authorization: 'Bearer tok-ada' } });
    const s1 = await openChannelStream(mcp.mcpUrl, a1.sessionId);
    const s2 = await openChannelStream(mcp.mcpUrl, a2.sessionId);
    try {
      await fetch(`${rest.baseUrl}/api/conversations`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ author: 'bo', body: 'one seat, one slot' }),
      });
      await new Promise((r) => setTimeout(r, 2000));
      const got = (s) => s.messages.some((n) => n.method === 'notifications/claude/channel' && /one seat, one slot/.test(String(n.params?.content ?? '')));
      assert.ok(got(s1) || got(s2), 'anti-vacuity: the stagger delivered to the seat at all');
      assert.equal(got(s1), got(s2), 'both of the seat\'s connections have it together (same slot), not one now and one in 20 s');
    } finally { s1.close(); s2.close(); }
  } finally { await stop(); }
});
