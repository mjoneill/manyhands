/**
 * #1395 — THE #726 DEAFNESS SIGNATURE INSIDE A DECLARED MAINTENANCE WINDOW.
 *
 * 2026-09-15 15:00:22Z: deploy.sh emitted the #1273 marker. 15:09:52Z, inside
 * the 10-minute window, the watch posted the #726 line ("receivers dropped
 * 8 → 3 and stayed there … streams died under live sessions"). #1273's
 * suppressor was never asked: receivers sat AT the floor (3), never below it,
 * so the floor branch did not run, and the #726 branch did not read
 * `maintenance` at all. A restart's real signature IS #726's — the window has
 * to cover it, with the same escape: a drop that DEEPENS past the declared
 * window's first reading still posts.
 *
 * These cases replay the 15:09Z readings against decide() exactly as the
 * state file held them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, maintenanceFrom, MAINTENANCE_MARKER } from '../scripts/fanout-decide.mjs';

const MIN = 60_000;
const T0 = 1_789_484_992_000;                 // ≈ 2026-09-15T15:09:52Z
const iso = (ms) => new Date(ms).toISOString();
const post = (body, at, by = 'ada') => ({ kind: 'conversation', op: 'post', by, at, title: body });
const base = { floor: 3, cooldownMs: 6 * 3600 * 1000 };
// The state after the 15:04:51Z tick: a drop from 8 armed, sessions from 13, not yet warned.
const armed = () => ({ r: 8, s: 13, pendingFrom: 8, pendingSessionsFrom: 13, warned: false, sigTimes: {}, hist: [8, 8, 8, 8, 8, 8] });
// The 15:09:52Z reading: receivers still 3, sessions back to 9 — streams died under live sessions.
const reading = { receivers: 3, sessions: 9, now: T0 };
const marker = (ageMs) => maintenanceFrom([post(`${MAINTENANCE_MARKER} deploy restarting the adapter — streams will drop and recover`, iso(T0 - ageMs), 'board')], { now: T0, windowMs: 10 * MIN });

test('#1395 the 15:09Z readings WITHOUT a declaration post the #726 line — the existing behaviour, unchanged', () => {
  const { warnBody, state } = decide({ ...base, ...reading, state: armed(), maintenance: null });
  assert.ok(warnBody, 'no declaration ⇒ the deafness alarm fires');
  assert.match(warnBody, /receivers dropped 8 → 3/);
  assert.match(warnBody, /#726/);
  assert.ok(!state.maintenanceSuppressed);
});

test('#1395 the SAME readings 9.5 min after a declared restart do NOT post — and the suppression is RECORDED', () => {
  const { warnBody, state } = decide({ ...base, ...reading, state: armed(), maintenance: marker(9.5 * MIN) });
  assert.equal(warnBody, null, 'the room was told the streams would drop; the alarm is noise');
  assert.ok(state.maintenanceSuppressed, 'a watch that decided not to speak is still askable');
  assert.equal(state.maintenanceSuppressed.signature, 'drop:3');
  assert.equal(state.maintenanceSuppressed.receivers, 3);
  assert.equal(state.maintenanceSuppressed.by, 'board');
  assert.ok(state.warned, 'gated once, like a cooldown-suppressed drop: the same episode does not post later either');
});

test('#1395 a drop that DEEPENS inside the window still posts — the declaration covers the expected drop, not a collapse', () => {
  // floor 1 keeps this in the DROP branch (2 is not below 1), so it is the #726
  // text that must post, not the floor's.
  const first = decide({ ...base, floor: 1, ...reading, state: armed(), maintenance: marker(4 * MIN) });
  assert.equal(first.warnBody, null);
  // Next tick, still inside the window: receivers fall further, sessions still held — deeper than the recorded reading.
  const stillInWindow = maintenanceFrom([post(`${MAINTENANCE_MARKER} deploy restarting the adapter`, iso(T0 - 4 * MIN), 'board')], { now: T0 + 5 * MIN, windowMs: 10 * MIN });
  assert.ok(stillInWindow, 'control: the declaration is still inside its window at the second tick');
  const deeper = decide({ ...base, floor: 1, receivers: 2, sessions: 9, now: T0 + 5 * MIN, state: first.state, maintenance: stillInWindow });
  assert.ok(deeper.warnBody, 'a deeper drop under live sessions is a new fact, declaration or not');
  assert.match(deeper.warnBody, /→ 2/);
  assert.match(deeper.warnBody, /#726/);
});

test('#1395 a declared drop that goes on BELOW the floor is the floor branch\'s business, and #1273 still governs it there', () => {
  const first = decide({ ...base, ...reading, state: armed(), maintenance: marker(4 * MIN) });
  assert.equal(first.warnBody, null);
  const stillInWindow = maintenanceFrom([post(`${MAINTENANCE_MARKER} deploy restarting the adapter`, iso(T0 - 4 * MIN), 'board')], { now: T0 + 5 * MIN, windowMs: 10 * MIN });
  const below = decide({ ...base, receivers: 1, sessions: 9, now: T0 + 5 * MIN, state: first.state, maintenance: stillInWindow });
  // The drop branch re-arms (deeper than declared) and the floor branch, entered
  // fresh under a declaration, records rather than posts — #1273's own rule.
  assert.ok(below.state.maintenanceSuppressed, 'recorded, never silent');
  assert.ok(below.state.belowFloor, 'and the watch knows it is below the floor');
});

test('#1395 an EXPIRED declaration suppresses nothing — the window is bounded', () => {
  const { warnBody } = decide({ ...base, ...reading, state: armed(), maintenance: marker(11 * MIN) });
  assert.ok(warnBody, 'eleven minutes after the marker the window has closed');
});

test('#1395 a benign client departure inside the window is still benign — the maintenance branch never reaches the alarm text', () => {
  // sessions fell WITH receivers: a client left. No alarm either way; the state stands down.
  const { warnBody, state } = decide({ ...base, receivers: 3, sessions: 8, now: T0, state: { ...armed(), pendingSessionsFrom: 13 }, maintenance: marker(9 * MIN) });
  assert.equal(warnBody, null);
  assert.equal(state.pendingFrom, null, 'stood down, not suppressed');
  assert.ok(!state.maintenanceSuppressed);
});

test('#1395 the drop-branch record clears on RECOVERY — a later unrelated drop is governed by its cooldown alone', () => {
  // Suppressed inside a declared window, then the streams come back.
  const suppressed = decide({ ...base, ...reading, state: armed(), maintenance: marker(4 * MIN) });
  assert.ok(suppressed.state.maintenanceSuppressed);
  const recovered = decide({ ...base, receivers: 8, sessions: 13, now: T0 + 10 * MIN, state: suppressed.state, maintenance: null });
  assert.equal(recovered.state.pendingFrom, null, 'recovered');
  assert.ok(!recovered.state.maintenanceSuppressed, 'the episode\'s record went with it');
  // Weeks later: a genuine drop (8 → 4) posts once, then a cooldown-gated tick at 2 must NOT post a second time
  // because of a stale "declared at 3" record — there is none.
  const weeks = T0 + 20 * 24 * 3600 * 1000;
  const arm = decide({ ...base, receivers: 4, sessions: 13, now: weeks, state: { ...recovered.state, r: 8, hist: [8, 8, 8, 8, 8, 8] }, maintenance: null });
  const post1 = decide({ ...base, receivers: 4, sessions: 13, now: weeks + 5 * MIN, state: arm.state, maintenance: null });
  assert.ok(post1.warnBody, 'the genuine drop posts');
  const post2 = decide({ ...base, receivers: 2, sessions: 13, now: weeks + 10 * MIN, state: post1.state, maintenance: null });
  // receivers 2 is below floor 3 → the FLOOR branch may speak; the DROP branch must not add a second line on a stale record.
  assert.ok(!post2.warnBody || !/receivers dropped/.test(post2.warnBody), `the drop branch posted again on a stale record: ${post2.warnBody}`);
});
