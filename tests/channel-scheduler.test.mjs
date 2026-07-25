/**
 * #263/#265/#266 — config-driven channel delivery scheduler. One scheduler,
 * two modes, chosen live from getConfig() (re-read every dispatch, so a settings
 * flip applies with no restart):
 *   - soft (#265): one random seat immediate, the rest random [min,max].
 *   - hard (#266): strict one-at-a-time — random order, serial slots `timeout` apart.
 * Both share the per-seat order-clamp. Delay assignment is pure (softDelays /
 * hardDelays); the timer glue is injectable → tested against a fake clock.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChannelScheduler, softDelays, hardDelays } from '../core/channel-scheduler.mjs';

const seqRng = (vals) => { let i = 0; return () => vals[i++ % vals.length]; };

function fakeClock() {
  let t = 0;
  let seq = 0;
  const scheduled = [];
  return {
    now: () => t,
    schedule: (fn, ms) => { scheduled.push({ at: t + Math.max(0, ms), order: seq++, fn }); },
    advance: (ms) => {
      const target = t + ms;
      for (;;) {
        const due = scheduled.filter((s) => s.at <= target).sort((a, b) => a.at - b.at || a.order - b.order);
        if (!due.length) break;
        const n = due[0];
        scheduled.splice(scheduled.indexOf(n), 1);
        t = n.at;
        n.fn();
      }
      t = target;
    },
  };
}
function recorder() {
  const calls = [];
  return { deliver: (sid, msg) => calls.push({ sid, msg }), calls };
}

// ── pure delay assignment ────────────────────────────────────────────────

test('softDelays: one seat immediate, the rest within [min,max]', () => {
  const d = softDelays(4, 30000, 60000, seqRng([0, 0.5, 0.5, 0.5]));
  assert.equal(d.filter((x) => x === 0).length, 1, 'exactly one immediate');
  for (const x of d) assert.ok(x >= 0 && x <= 60000, `${x} within [0,max]`);
});

test('softDelays: the immediate index follows the rng (rotates, not fixed)', () => {
  assert.equal(softDelays(3, 30000, 60000, () => 0)[0], 0, 'rng 0 → index 0 immediate');
  const d = softDelays(3, 30000, 60000, seqRng([0.9, 0.5, 0.5]));
  assert.equal(d[2], 0, 'rng 0.9 → index 2 immediate');
});

test('hardDelays: serial slots spaced by timeout, max = (n-1)*timeout', () => {
  const d = hardDelays(4, 300000, () => 0);
  assert.deepEqual([...d].sort((a, b) => a - b), [0, 300000, 600000, 900000], 'four serial slots');
  assert.equal(Math.max(...d), 900000, '(n-1)*timeout ceiling');
});

test('hardDelays: turn order is randomized (first seat not automatically slot 0)', () => {
  const d = hardDelays(3, 1000, () => 0);
  assert.notEqual(d[0], 0, 'shuffled, so seat 0 is not the immediate slot here');
  assert.deepEqual([...d].sort((a, b) => a - b), [0, 1000, 2000]);
});

// ── dispatch reads config LIVE ───────────────────────────────────────────

test('dispatch uses the mode from getConfig, re-read every call (live switch)', () => {
  const clock = fakeClock();
  const rec = recorder();
  let cfg = { mode: 'soft', soft: { minMs: 30000, maxMs: 60000 }, hard: { timeoutMs: 300000 } };
  const s = createChannelScheduler({ getConfig: () => cfg, rng: () => 0, now: clock.now, schedule: clock.schedule, deliver: rec.deliver });

  s.dispatch(['s1', 's2'], 'a'); // soft, rng 0 → s1 immediate
  clock.advance(0);
  assert.deepEqual(rec.calls.map((c) => c.sid), ['s1'], 'soft: one immediate');
  clock.advance(60000);
  rec.calls.length = 0;

  cfg = { mode: 'hard', soft: { minMs: 30000, maxMs: 60000 }, hard: { timeoutMs: 300000 } }; // flip LIVE
  s.dispatch(['s1', 's2'], 'b');
  clock.advance(0);
  assert.equal(rec.calls.length, 1, 'hard: exactly one seat at slot 0');
  clock.advance(300000);
  assert.equal(rec.calls.length, 2, 'hard: second seat one timeout later');
});

test('off mode → all seats immediate, in order', () => {
  const clock = fakeClock();
  const rec = recorder();
  const s = createChannelScheduler({ getConfig: () => ({ mode: 'off' }), rng: () => 0.5, now: clock.now, schedule: clock.schedule, deliver: rec.deliver });
  s.dispatch(['s1', 's2', 's3'], 'm');
  assert.deepEqual(rec.calls.map((c) => c.sid), ['s1', 's2', 's3']);
});

test('per-seat order-clamp holds (a later message cannot overtake an earlier one to a seat)', () => {
  const clock = fakeClock();
  const rec = recorder();
  // soft, rng 0.5 → for n=2 immediateIdx = floor(0.5*2)=1 (s2); s1 delayed.
  const cfg = { mode: 'soft', soft: { minMs: 30000, maxMs: 60000 }, hard: { timeoutMs: 300000 } };
  const s = createChannelScheduler({ getConfig: () => cfg, rng: seqRng([0.5, 0.5, 0, 0.5]), now: clock.now, schedule: clock.schedule, deliver: rec.deliver });
  s.dispatch(['s1', 's2'], 'm1'); // s2 immediate, s1 delayed ~45000
  clock.advance(5000);
  s.dispatch(['s1', 's2'], 'm2'); // rng 0 → s1 immediate now, but clamp holds it behind m1
  clock.advance(100000);
  const s1msgs = rec.calls.filter((c) => c.sid === 's1').map((c) => c.msg);
  assert.deepEqual(s1msgs, ['m1', 'm2'], 's1 keeps m1 before m2 despite m2 being its immediate pick');
});

// ── #303-7: pending() counts staggered deliveries still in flight ──────────

test('pending(): hard mode — starts at the tail count, drains to 0 as slots fire', () => {
  const clock = fakeClock();
  const rec = recorder();
  const cfg = { mode: 'hard', hard: { timeoutMs: 120000 } };
  // rng identity → hardDelays gives order [0,1,2]: s1 immediate, s2 @120s, s3 @240s.
  const s = createChannelScheduler({ getConfig: () => cfg, rng: seqRng([0, 0, 0]), now: clock.now, schedule: clock.schedule, deliver: rec.deliver });
  s.dispatch(['s1', 's2', 's3'], 'm');
  // s1 fired immediately (delay 0 → no in-flight); s2 + s3 are pending.
  assert.equal(s.pending(), 2, 'two staggered deliveries in flight right after dispatch');
  clock.advance(120000);
  assert.equal(s.pending(), 1, 'one drains after the first slot');
  clock.advance(120000);
  assert.equal(s.pending(), 0, 'all delivered → nothing pending');
});

test('pending(): off mode delivers immediately → never in flight', () => {
  const clock = fakeClock();
  const rec = recorder();
  const s = createChannelScheduler({ getConfig: () => ({ mode: 'off' }), now: clock.now, schedule: clock.schedule, deliver: rec.deliver });
  s.dispatch(['a', 'b', 'c'], 'm');
  assert.equal(s.pending(), 0, 'off mode is synchronous — nothing pending');
  assert.equal(rec.calls.length, 3, 'all delivered immediately');
});
