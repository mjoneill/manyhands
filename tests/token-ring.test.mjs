/**
 * Board-suite tests for the TokenRing ring/lease state machine (#410).
 * Runs the accepted spike's invariants against the ported core in
 * core/token-ring.mjs, so the anti-collision proof lives inside
 * `npm run test:server` (node --test tests/*.test.mjs), not just the workspace.
 *
 * Invariants: I1 single lease · I2 holder-only append · I3 append-only ·
 * I4 liveness/TIMEOUT · I5 bounded frozen delivery · I6 quiescence · I7 wake ·
 * leaseId fencing (ABA / stale-late-event / duplicate-retry).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce, delivery, leaseCount } from '../core/token-ring.mjs';

// Helpers: scheduled events must carry the CURRENT lease's fencing id + holder.
const respond = (s, body) => reduce(s, { type: 'RESPOND', holder: s.lease.holder, leaseId: s.lease.id, body });
const pass = (s) => reduce(s, { type: 'PASS', holder: s.lease.holder, leaseId: s.lease.id });
const timeout = (s) => reduce(s, { type: 'TIMEOUT', holder: s.lease.holder, leaseId: s.lease.id });
const interject = (s, author, body) => reduce(s, { type: 'INTERJECT', author, body });
const nudge = (s, author, body) => reduce(s, { type: 'NUDGE', author, body });

// Fold events, asserting I1 (single lease) at every step.
function invariantI1(s) {
  assert.ok(leaseCount(s) <= 1, 'I1: never more than one lease');
  return s;
}

test('init: quiescent, no lease, cursors at 0', () => {
  const s = initialState(['a', 'b', 'c']);
  assert.equal(s.status, 'QUIESCENT');
  assert.equal(s.lease, null);
  assert.deepEqual(s.cursors, { a: 0, b: 0, c: 0 });
});

test('seed wakes the ring and grants the first lease (I7)', () => {
  let s = initialState(['a', 'b']);
  s = interject(s, 'alex', 'seed');
  assert.equal(s.status, 'ACTIVE');
  assert.equal(s.lease.holder, 'a');
  assert.equal(s.lease.snapshot, 1);
  assert.equal(s.lease.id, 1);
});

test('I2 / collision: only the current-lease holder may append; a rival RESPOND is rejected', () => {
  let s = initialState(['a', 'b']);
  s = interject(s, 'alex', 'seed'); // a holds lease
  const before = s;
  const rejected = reduce(s, { type: 'RESPOND', holder: 'b', leaseId: s.lease.id, body: 'race!' });
  assert.deepEqual(rejected, before, 'non-holder append is a no-op');
  const ok = respond(s, 'mine');
  assert.equal(ok.log.at(-1).body, 'mine');
});

test('interjection worked-example: mid-lease interject bundles with the response for the next seat; holder cursor stays at snapshot', () => {
  let s = initialState(['nova', 'sage']);
  s = interject(s, 'alex', 'seed');       // seq1; nova leases, snapshot=1
  assert.equal(s.lease.holder, 'nova');
  s = interject(s, 'alex', 'mid-turn');   // seq2; appended, lease untouched
  assert.equal(s.lease.holder, 'nova', 'interjection does not steal the active turn');
  s = respond(s, 'nova-reply');              // seq3; lease -> sage
  assert.deepEqual(delivery(s, 'sage').map((m) => m.body), ['seed', 'mid-turn', 'nova-reply']);
  assert.equal(s.cursors.nova, 1, "nova's cursor advanced only to snapshot");
});

test('nudge is append-only: advances neither the author ring cursor nor the ring pointer', () => {
  let s = initialState(['nova', 'sage']);
  s = interject(s, 'alex', 'seed');       // nova leases
  const ringPosBefore = s.ringPos;
  s = nudge(s, 'sage', 'chorus');            // a human nudges sage
  assert.equal(s.cursors.sage, 0, 'nudge does NOT advance the ring cursor');
  assert.equal(s.ringPos, ringPosBefore, 'nudge does NOT advance the ring pointer');
  assert.equal(s.lease.holder, 'nova', 'nudge does NOT steal the active turn');
  s = respond(s, 'nova-reply');
  assert.equal(s.lease.holder, 'sage', "sage's scheduled ring turn survived the nudge");
  assert.deepEqual(delivery(s, 'sage').map((m) => m.body), ['seed', 'chorus', 'nova-reply'],
    'scheduled payload = everything since sage last ring turn, incl. its own chorus post');
});

test('gap#2 / no-silent-skip: PASS advances only to snapshot, so a mid-lease interjection re-queues', () => {
  let s = initialState(['a', 'b']);
  s = interject(s, 'alex', 'seed');       // seq1; a leases, snapshot=1
  s = interject(s, 'alex', 'mid-lease');  // seq2; during a's lease
  s = pass(s);                               // a passes
  assert.equal(s.cursors.a, 1, 'cursor advanced only to snapshot (1), not live HWM (2)');
  assert.ok(delivery(s, 'a').map((m) => m.body).includes('mid-lease'), 'mid-lease interjection is NOT silently skipped');
});

test('gap#3 / stable-object: a holder delivery is frozen at its lease snapshot', () => {
  let s = initialState(['a', 'b']);
  s = interject(s, 'alex', 'seed');        // seq1; a leases, snapshot=1
  s = interject(s, 'alex', 'after-grant'); // seq2; lands during a's lease
  assert.deepEqual(delivery(s, 'a').map((m) => m.body), ['seed'], 'holder sees only through snapshot');
});

test('I6 quiescence: PASS/round-robin reaches QUIESCENT in finite steps', () => {
  let s = initialState(['a', 'b', 'c']);
  s = interject(s, 'alex', 'seed');
  let guard = 0;
  while (s.status === 'ACTIVE' && guard++ < 100) s = invariantI1(pass(s));
  assert.equal(s.status, 'QUIESCENT');
  assert.ok(guard < 100, 'quiescence reached in finite steps');
  assert.ok(['a', 'b', 'c'].every((p) => s.cursors[p] === s.log.length), 'every cursor caught up');
});

test('wake from quiescence: a new post re-dispatches (I7)', () => {
  let s = initialState(['a', 'b']);
  s = interject(s, 'alex', 'seed');
  let guard = 0;
  while (s.status === 'ACTIVE' && guard++ < 100) s = pass(s);
  assert.equal(s.status, 'QUIESCENT');
  s = interject(s, 'alex', 'wake');
  assert.equal(s.status, 'ACTIVE');
  assert.ok(s.lease);
});

test('I4 liveness: TIMEOUT releases a stuck holder and advances the ring', () => {
  let s = initialState(['a', 'b']);
  s = interject(s, 'alex', 'seed');
  assert.equal(s.lease.holder, 'a');
  s = timeout(s);
  assert.equal(s.lease.holder, 'b');
});

test('I3 append-only: existing log entries are never mutated across events', () => {
  let s = initialState(['a', 'b']);
  s = interject(s, 'alex', 'seed');
  const firstEntry = { ...s.log[0] };
  s = respond(s, 'x');
  s = interject(s, 'alex', 'y');
  assert.deepEqual(s.log[0], firstEntry, 'seq-1 entry unchanged');
  assert.equal(s.log.length, 3, 'log only grew');
});

// ---- fencing / stale-event protection (async-correctness) ------------------

test('fencing: a stale RESPOND from an earlier lease (same seat) is rejected', () => {
  let s = initialState(['a']);               // single-seat ring
  s = interject(s, 'alex', 'seed');       // a leases id=1
  const staleLeaseId = s.lease.id;           // 1
  s = respond(s, 'first');                   // a responds on lease 1; one-seat ring quiesces (self-echo fix)
  assert.equal(s.status, 'QUIESCENT', 'a is not re-granted its own echo');
  s = interject(s, 'alex', 'more');       // foreign content re-queues a -> a leases id=2
  assert.equal(s.lease.id, 2, 'a holds a fresh lease');
  const logLen = s.log.length;
  const after = reduce(s, { type: 'RESPOND', holder: 'a', leaseId: staleLeaseId, body: 'STALE' });
  assert.deepEqual(after, s, 'stale response from lease 1 is a no-op against lease 2');
  assert.equal(after.log.length, logLen, 'no stale append');
});

test('fencing: a stale TIMEOUT from an earlier lease cannot cancel a healthy new turn', () => {
  let s = initialState(['a']);
  s = interject(s, 'alex', 'seed');       // a leases id=1
  const staleLeaseId = s.lease.id;
  s = respond(s, 'first');                   // one-seat ring quiesces (self-echo fix)
  s = interject(s, 'alex', 'more');       // foreign content re-queues a -> a leases id=2 (healthy)
  const healthy = s.lease;
  const after = reduce(s, { type: 'TIMEOUT', holder: 'a', leaseId: staleLeaseId });
  assert.deepEqual(after.lease, healthy, 'stale timeout did NOT cancel the new lease');
});

// ---- self-echo / quiescence (reducer cases a/b/c) --------------------------

test('self-echo (a): one-seat ring with no external append QUIESCES after responding (no self-regrant)', () => {
  let s = initialState(['a']);
  s = interject(s, 'alex', 'seed');       // a leases
  s = respond(s, 'my-reply');                // a responds — its own POST is the only new entry
  assert.equal(s.status, 'QUIESCENT', 'ring quiesces; a is not re-granted its own response');
  assert.equal(s.lease, null);
});

test('self-echo (b): after a mid-lease human interjection, the seat is re-granted ONLY the interjection, not its own POST', () => {
  let s = initialState(['a']);
  s = interject(s, 'alex', 'seed');       // a leases (snapshot 1)
  s = interject(s, 'alex', 'mid');        // lands during a's lease (seq2)
  s = respond(s, 'a-reply');                 // a responds (seq3, own POST)
  assert.equal(s.lease.holder, 'a', 'a is re-granted because the foreign "mid" is unread');
  assert.deepEqual(delivery(s, 'a').map((m) => m.body), ['mid'],
    'a sees only the human interjection, NOT its own a-reply');
});

test('self-echo (c): multi-seat rotation delivers other seats responses but never echoes a seat own POST', () => {
  let s = initialState(['a', 'b']);
  s = interject(s, 'alex', 'seed');       // a leases
  s = respond(s, 'a-reply');                 // a responds -> b's turn
  assert.equal(s.lease.holder, 'b');
  assert.deepEqual(delivery(s, 'b').map((m) => m.body), ['seed', 'a-reply'], 'b sees seed + a-reply');
  s = respond(s, 'b-reply');                 // b responds -> back to a
  assert.equal(s.lease.holder, 'a', 'a re-granted because b-reply is foreign');
  assert.deepEqual(delivery(s, 'a').map((m) => m.body), ['b-reply'],
    'a sees b-reply, NOT its own a-reply echoed back');
});

// The load-bearing property Robin needs for the two-endpoint case (robin.sb +
// robin.cs, same author): self-echo authority is BOARD-side, so a delivered
// envelope never carries the recipient seat's own scheduled POST — presence must
// NOT filter by author (author is non-injective). Proven across a real rotation.
test('self-echo INVARIANT: no delivered envelope ever carries the recipient seat own scheduled POST', () => {
  let s = initialState(['a', 'b']);
  s = interject(s, 'alex', 'seed');
  s = interject(s, 'alex', 'topic');
  let rounds = 0;
  while (s.lease && rounds++ < 12) {                 // a<->b keep responding (an active conversation)
    const h = s.lease.holder;
    assert.ok(
      delivery(s, h).every((m) => !(m.author === h && m.kind === 'POST')),
      `round ${rounds}: envelope to ${h} must not carry its own scheduled POST`,
    );
    s = respond(s, `${h}-reply-${rounds}`);
  }
  assert.ok(rounds >= 10, 'exercised a multi-round rotation without ever echoing a seat own POST');
});

test('fencing: a retried/duplicate RESPOND after its lease is consumed does not append twice', () => {
  let s = initialState(['a']);
  s = interject(s, 'alex', 'seed');       // a leases id=1
  const usedLeaseId = s.lease.id;
  s = respond(s, 'once');                    // appends once; lease 1 consumed; a now on lease 2
  const dup = reduce(s, { type: 'RESPOND', holder: 'a', leaseId: usedLeaseId, body: 'once' });
  assert.deepEqual(dup, s, 'retry with the consumed lease id is a no-op');
  assert.equal(dup.log.filter((m) => m.body === 'once').length, 1, 'exactly one append, no duplicate');
});
