/**
 * #1513 — SHADOW logging for the ring's three measured defects. LOG ONLY: nothing
 * here may change who holds the token, who is skipped, or what is delivered.
 * These tests pin two things:
 *   1. the shadow record says what happened (a mid-lease eviction with the inputs
 *      that caused it; how a RESPOND was bound and whether it echoed the envelope);
 *   2. the behaviour the record describes is STILL the current behaviour — the
 *      eviction still evicts. A shadow that quietly fixed the defect would look
 *      like a clean trial and prove nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSeatRegistry } from '../core/seat-registry.mjs';
import { createTokenRingEngine } from '../core/token-ring-engine.mjs';

function makeEngine({ isDeliverable = null } = {}) {
  const registry = createSeatRegistry();
  let n = 0;
  const engine = createTokenRingEngine({ registry, genEnvelopeId: () => `E${++n}`, isDeliverable });
  registry.register({ seatId: 'a', sessionId: 'S1', author: 'aa' });
  registry.register({ seatId: 'b', sessionId: 'S2', author: 'bb' });
  return { registry, engine };
}

test('a holder evicted MID-LEASE by an unrelated post is recorded with the inputs that decided it, and is STILL evicted', () => {
  // a is deliverable at the grant; by the time an unrelated post arrives it is not
  // (the measured case: another seat spoke inside the live window). b stays deliverable.
  let aOk = true;
  const isDeliverable = (seat, ctx = {}) => {
    const ok = seat === 'b' ? true : aOk;
    if (ctx.explain) Object.assign(ctx.explain, { seat, lastClientRequestAt: 1000, activeContender: seat === 'a' && !aOk ? 'b' : null });
    return ok;
  };
  const { engine } = makeEngine({ isDeliverable });
  const seed = engine.handlePost({ author: 'alex', body: 'seed' });
  assert.equal(seed.telemetry.holder, 'a');
  assert.equal(seed.telemetry.shadow.midLeaseEvictions.length, 0, 'a fresh grant is not an eviction');

  aOk = false;
  const r = engine.handlePost({ author: 'alex', body: 'unrelated' });
  // the defect, unchanged: the holder lost the lease to an unrelated post
  assert.deepEqual(r.telemetry.skipped, ['a']);
  assert.equal(r.telemetry.holder, 'b');
  // the shadow record
  assert.equal(r.telemetry.shadow.midLeaseEvictions.length, 1);
  const ev = r.telemetry.shadow.midLeaseEvictions[0];
  assert.equal(ev.holder, 'a');
  assert.equal(ev.leaseId, 1);
  assert.equal(ev.envelopeId, 'E1', 'names the envelope the evicted holder had been given');
  assert.deepEqual(ev.inputs, { seat: 'a', lastClientRequestAt: 1000, activeContender: 'b' });
});

test('a NEW grant that is skipped at once is not reported as a mid-lease eviction', () => {
  const isDeliverable = (seat) => seat !== 'a'; // a is never deliverable
  const { engine } = makeEngine({ isDeliverable });
  const r = engine.handlePost({ author: 'alex', body: 'seed' });
  assert.deepEqual(r.telemetry.skipped, ['a'], 'skipped at the grant, as before');
  assert.equal(r.telemetry.holder, 'b');
  assert.equal(r.telemetry.shadow.midLeaseEvictions.length, 0, 'it never held a lease that a later post took away');
});

test('a holder RESPOND by author-match, carrying no envelope id, is recorded as unbound and unechoed', () => {
  const { engine } = makeEngine();
  engine.handlePost({ author: 'alex', body: 'seed' }); // a holds, envelope E1
  const r = engine.handlePost({ author: 'aa', body: 'a wrote something unrelated' });
  assert.equal(r.telemetry.event, 'RESPOND', 'behaviour unchanged: identity alone still counts');
  assert.deepEqual(r.telemetry.shadow.respond, {
    holder: 'a', leaseId: 1, currentEnvelopeId: 'E1',
    carriedEnvelopeId: null, echoed: false, boundBy: 'author',
  });
});

test('a RESPOND bound by session, and one that echoes the current envelope, are told apart', () => {
  const { engine } = makeEngine();
  engine.handlePost({ author: 'alex', body: 'seed' });
  const r = engine.handlePost({ author: 'aa', body: 'reply', originSessionId: 'S1', carriedEnvelopeId: 'E1' });
  assert.equal(r.telemetry.shadow.respond.boundBy, 'session');
  assert.equal(r.telemetry.shadow.respond.echoed, true);
});

test('an echo of an OLD lease\'s envelope is not an echo of the current one', () => {
  const { engine } = makeEngine();
  engine.handlePost({ author: 'alex', body: 'seed' });                       // a holds, E1
  engine.handlePost({ author: 'aa', body: 'r1', originSessionId: 'S1' });    // b holds now, E2
  const r = engine.handlePost({ author: 'bb', body: 'r2', originSessionId: 'S2', carriedEnvelopeId: 'E1' });
  assert.equal(r.telemetry.shadow.respond.currentEnvelopeId, 'E2');
  assert.equal(r.telemetry.shadow.respond.carriedEnvelopeId, 'E1');
  assert.equal(r.telemetry.shadow.respond.echoed, false);
});

test('an INTERJECT carries no respond record, and the shadow never alters the grant it rode along with', () => {
  const { engine } = makeEngine();
  engine.handlePost({ author: 'alex', body: 'seed' });
  const r = engine.handlePost({ author: 'alex', body: 'chatter' });
  assert.equal(r.telemetry.event, 'INTERJECT');
  assert.equal(r.telemetry.shadow.respond, null);
  assert.deepEqual(r.deliveries, []);
  assert.equal(engine.snapshot().lease.holder, 'a');
});
