/**
 * #410 — token-ring engine: maps commons posts onto the ring reducer and computes
 * delivery intents. Proves the load-bearing behaviors against a populated
 * registry with ZERO live sessions:
 *   - inert when the registry is unpopulated (the safety gate)
 *   - exactly ONE holder is delivered per grant; non-holders get nothing
 *   - holder RESPOND advances the ring; non-holder posts are additive
 *   - a REST reply (no session) is attributed to the holder by author-match only
 *   - dead holder (no live session) → needsTimeout, not a push into the void
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSeatRegistry } from '../core/seat-registry.mjs';
import { createTokenRingEngine } from '../core/token-ring-engine.mjs';

function makeEngine() {
  const registry = createSeatRegistry();
  let n = 0;
  const engine = createTokenRingEngine({ registry, genEnvelopeId: () => `E${++n}` });
  return { registry, engine };
}

test('INERT when the registry is unpopulated: a post delivers to nobody, stays quiescent', () => {
  const { engine } = makeEngine();
  const r = engine.handlePost({ author: 'alex', body: 'anyone home?' });
  assert.deepEqual(r.deliveries, [], 'no seats registered ⇒ zero deliveries');
  assert.equal(r.needsTimeout, null);
  assert.equal(engine.snapshot().status, 'QUIESCENT');
});

test('seed wakes the ring and delivers ONE frozen envelope to the first holder only', () => {
  const { registry, engine } = makeEngine();
  registry.register({ seatId: 'a', sessionId: 'S1', author: 'aa' });
  registry.register({ seatId: 'b', sessionId: 'S2', author: 'bb' });

  const r = engine.handlePost({ author: 'alex', body: 'seed' });
  assert.equal(r.deliveries.length, 1, 'exactly one seat is invoked');
  const d = r.deliveries[0];
  assert.equal(d.seatId, 'a');
  assert.equal(d.sessionId, 'S1');
  assert.equal(d.envelope.kind, 'scheduled-turn');
  assert.equal(d.envelope.leaseId, 1);
  assert.equal(d.envelope.envelopeId, 'E1');
  assert.deepEqual(d.envelope.payload.map((m) => m.body), ['seed'], 'frozen payload = seed only');
  // b (the non-holder) is dormant: nothing addressed to it.
  assert.ok(!r.deliveries.some((x) => x.seatId === 'b'), 'non-holder receives nothing');
});

test('holder RESPOND (via its session) advances the ring and delivers the next envelope with the interlude folded in', () => {
  const { registry, engine } = makeEngine();
  registry.register({ seatId: 'a', sessionId: 'S1', author: 'aa' });
  registry.register({ seatId: 'b', sessionId: 'S2', author: 'bb' });
  engine.handlePost({ author: 'alex', body: 'seed' });          // a holds
  // a mid-lease human interjection lands (additive, no new delivery)
  const mid = engine.handlePost({ author: 'alex', body: 'mid' });
  assert.deepEqual(mid.deliveries, [], 'interjection during a lease delivers nothing new');
  assert.equal(engine.snapshot().lease.holder, 'a', 'interjection did not steal the turn');

  const r = engine.handlePost({ author: 'aa', body: 'a-reply', originSessionId: 'S1' });
  assert.equal(r.deliveries.length, 1);
  assert.equal(r.deliveries[0].seatId, 'b', 'ring advanced to b');
  assert.deepEqual(r.deliveries[0].envelope.payload.map((m) => m.body), ['seed', 'mid', 'a-reply'],
    "b's turn bundles everything since it last had the ring");
});

test('a non-holder post during a lease is additive: no ring advance, no new delivery', () => {
  const { registry, engine } = makeEngine();
  registry.register({ seatId: 'a', sessionId: 'S1', author: 'aa' });
  registry.register({ seatId: 'b', sessionId: 'S2', author: 'bb' });
  engine.handlePost({ author: 'alex', body: 'seed' });          // a holds
  const r = engine.handlePost({ author: 'bb', body: 'chorus', originSessionId: 'S2' });
  assert.deepEqual(r.deliveries, [], 'b posting out of turn triggers no delivery');
  assert.equal(engine.snapshot().lease.holder, 'a', 'lease stays with a');
});

test('REST reply (no session) is attributed to the holder by author-match — and only the holder', () => {
  const { registry, engine } = makeEngine();
  registry.register({ seatId: 'a', sessionId: 'S1', author: 'aa' });
  registry.register({ seatId: 'b', sessionId: 'S2', author: 'bb' });
  engine.handlePost({ author: 'alex', body: 'seed' });          // a holds

  // A post authored 'bb' (a non-holder's label) with NO session must NOT be read
  // as a's turn — it is additive only.
  const notTurn = engine.handlePost({ author: 'bb', body: 'rest-chorus' });
  assert.deepEqual(notTurn.deliveries, [], 'non-holder author cannot advance the ring via REST');
  assert.equal(engine.snapshot().lease.holder, 'a');

  // The holder's own REST reply (author 'aa', no session) IS its RESPOND.
  const turn = engine.handlePost({ author: 'aa', body: 'a-rest-reply' });
  assert.equal(turn.deliveries.length, 1);
  assert.equal(turn.deliveries[0].seatId, 'b', "holder's REST reply advanced the ring");
});

test('dead holder (no live session at grant) yields needsTimeout, not a push into the void', () => {
  const { registry, engine } = makeEngine();
  registry.register({ seatId: 'a', sessionId: 'S1', author: 'aa' });
  registry.register({ seatId: 'b', sessionId: 'S2', author: 'bb' });
  engine.handlePost({ author: 'alex', body: 'seed' });          // a holds, ring=[a,b] frozen
  registry.release({ sessionId: 'S2' });                           // b's transport drops mid-lease

  const r = engine.handlePost({ author: 'aa', body: 'a-reply', originSessionId: 'S1' }); // advance to b
  assert.deepEqual(r.deliveries, [], 'no envelope pushed to a seat with no live session');
  assert.deepEqual(r.needsTimeout, { seatId: 'b', leaseId: 2 });

  // recovering: a valid TIMEOUT for b advances the ring off the dead seat.
  const t = engine.handleTimeout(r.needsTimeout);
  assert.notEqual(engine.snapshot().lease?.holder, 'b', 'ring advanced past the dead seat');
});

test('reaches quiescence (holder with nothing to add times out), and a later-registered seat joins on wake', () => {
  const { registry, engine } = makeEngine();
  registry.register({ seatId: 'a', sessionId: 'S1', author: 'aa' });
  const seed = engine.handlePost({ author: 'alex', body: 'seed' }); // a holds, lease 1
  // a has nothing to add: no post, the lease TTL fires (PASS = TIMEOUT). Nobody
  // else is queued, so the ring quiesces.
  engine.handleTimeout({ seatId: 'a', leaseId: seed.deliveries[0].envelope.leaseId });
  assert.equal(engine.snapshot().status, 'QUIESCENT', 'no queued seat ⇒ quiescent');

  // b registers during the quiet, then a new post wakes the ring.
  registry.register({ seatId: 'b', sessionId: 'S2', author: 'bb' });
  const r = engine.handlePost({ author: 'alex', body: 'wake' });
  assert.ok(engine.snapshot().ring.includes('b'), 'b joined the ring on wake');
  assert.equal(r.deliveries.length, 1, 'the wake grants exactly one lease');
});
