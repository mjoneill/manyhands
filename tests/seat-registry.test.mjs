/**
 * #410 — the abstract seat registry (three-layer identity: seatId / author /
 * sessionId). Covers the bijection, non-injective authors, reconnect supersede,
 * and the fenced-release case (a stale close from a reconnected-away session
 * must not unbind the fresh one) that review required.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSeatRegistry } from '../core/seat-registry.mjs';

test('register binds seatId <-> sessionId and both lookups resolve', () => {
  const r = createSeatRegistry();
  const res = r.register({ seatId: 'robin.sb', sessionId: 'S1', author: 'robin' });
  assert.equal(res.ok, true);
  assert.equal(res.supersededSession, null);
  assert.equal(r.sessionForSeat('robin.sb'), 'S1');
  assert.equal(r.seatForSession('S1'), 'robin.sb');
  assert.equal(r.authorForSeat('robin.sb'), 'robin');
  assert.deepEqual(r.seats(), ['robin.sb']);
  assert.equal(r.isLive('robin.sb'), true);
});

test('register requires both seatId and sessionId', () => {
  const r = createSeatRegistry();
  assert.equal(r.register({ seatId: 'x' }).ok, false);
  assert.equal(r.register({ sessionId: 'S1' }).ok, false);
});

test('author is non-injective: two distinct seats may share an author, each resolves independently', () => {
  const r = createSeatRegistry();
  r.register({ seatId: 'robin.sb', sessionId: 'S1', author: 'robin' });
  r.register({ seatId: 'robin.cs', sessionId: 'S2', author: 'robin' });
  // Same author, genuinely different seats/sessions — never merged.
  assert.equal(r.sessionForSeat('robin.sb'), 'S1');
  assert.equal(r.sessionForSeat('robin.cs'), 'S2');
  assert.equal(r.seatForSession('S1'), 'robin.sb');
  assert.equal(r.seatForSession('S2'), 'robin.cs');
  assert.deepEqual(r.seats().sort(), ['robin.cs', 'robin.sb']);
});

test('reconnect: a new session claiming an existing seat supersedes the old transport', () => {
  const r = createSeatRegistry();
  r.register({ seatId: 'robin.sb', sessionId: 'S1', author: 'robin' });
  const res = r.register({ seatId: 'robin.sb', sessionId: 'S2', author: 'robin' });
  assert.equal(res.ok, true);
  assert.equal(res.supersededSession, 'S1', 'names the superseded transport so the caller can drop it');
  assert.equal(r.sessionForSeat('robin.sb'), 'S2', 'seat now points at the fresh session');
  assert.equal(r.seatForSession('S1'), null, 'the old session is no longer bound');
  assert.equal(r.seatForSession('S2'), 'robin.sb');
});

test('FENCED release: a late close from a superseded session does NOT unbind the fresh one', () => {
  const r = createSeatRegistry();
  r.register({ seatId: 'robin.sb', sessionId: 'S1' });
  r.register({ seatId: 'robin.sb', sessionId: 'S2' }); // reconnect; S1 superseded
  const released = r.release({ sessionId: 'S1' });      // S1's close arrives LATE
  assert.equal(released, null, 'stale close is a no-op');
  assert.equal(r.sessionForSeat('robin.sb'), 'S2', 'the fresh session survived the stale close');
  assert.equal(r.isLive('robin.sb'), true);
});

test('release of the current session unbinds the seat', () => {
  const r = createSeatRegistry();
  r.register({ seatId: 'robin.sb', sessionId: 'S1' });
  assert.equal(r.release({ sessionId: 'S1' }), 'robin.sb');
  assert.equal(r.sessionForSeat('robin.sb'), null);
  assert.equal(r.seatForSession('S1'), null);
  assert.equal(r.isLive('robin.sb'), false);
  assert.deepEqual(r.seats(), []);
});

test('one session, one seat: a session already bound to a seat cannot re-declare a different persona', () => {
  const r = createSeatRegistry();
  r.register({ seatId: 'robin.sb', sessionId: 'S1' });
  const res = r.register({ seatId: 'nova.sb', sessionId: 'S1' }); // same session, different seat
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'session-already-bound');
  assert.equal(res.heldBy, 'robin.sb');
  // Original binding untouched, and nova.sb never came into existence.
  assert.equal(r.sessionForSeat('robin.sb'), 'S1');
  assert.equal(r.sessionForSeat('nova.sb'), null);
});

test('re-registering the SAME seat+session is idempotent (bumps epoch, no supersede)', () => {
  const r = createSeatRegistry();
  r.register({ seatId: 'robin.sb', sessionId: 'S1' });
  const e1 = r.epochForSeat('robin.sb');
  const res = r.register({ seatId: 'robin.sb', sessionId: 'S1' });
  assert.equal(res.ok, true);
  assert.equal(res.supersededSession, null, 'same session is not superseding itself');
  assert.ok(r.epochForSeat('robin.sb') > e1, 'epoch is monotonic across (re)binds');
  assert.equal(r.sessionForSeat('robin.sb'), 'S1');
});

test('epoch is monotonic and distinct across seats and rebinds', () => {
  const r = createSeatRegistry();
  r.register({ seatId: 'a.sb', sessionId: 'S1' });
  r.register({ seatId: 'b.sb', sessionId: 'S2' });
  r.register({ seatId: 'a.sb', sessionId: 'S3' }); // a reconnects
  assert.ok(r.epochForSeat('a.sb') > r.epochForSeat('b.sb'), 'a rebound after b registered');
});
