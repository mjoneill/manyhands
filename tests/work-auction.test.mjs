/**
 * #755 slice 1 — the bid/grant transition core.
 *
 * SCOPE, written before the tests (the steward's requirement): a pure module and
 * its tests. Derived state, no timer, no persistence, no adapter, no
 * enforcement.
 *
 * ⛔ EVIDENCE VALUE OF THIS FILE GOING GREEN: ZERO toward #755's four
 *    demonstrations. It proves the state machine is internally coherent and
 *    NOTHING about whether a rail fires without being remembered — which is
 *    #755's entire question. A green suite on a COMPLEX card is not Done.
 *
 * DESIGN B — derived expiry (contested into shape by a second seat, 2026-08-09). Nothing fires at replyBy.
 * EXPIRED/GRANTED-by-timeout is a FUNCTION of stored (replyBy, now), computed
 * by the next actor to look. The alternative (A: a live timer writes the
 * transition) needs a daemon in the mcp-server process, and a restart silently
 * drops every pending window — core/channel-scheduler.mjs's in-memory map is
 * the local precedent for exactly that failure.
 *
 * ⚠️ THE TEST THAT DECIDES A vs B IS `stateAt survives a JSON round-trip`.
 *    An injected-clock expiry test is green under BOTH designs — it has no
 *    input that makes it fail. The round-trip does: it throws away every
 *    in-process reference and re-derives from stored fields alone.
 *
 * ⚠️ AND `stateAt refuses to read the wall clock` is what keeps B from
 *    decaying back into A by accident. `now` is required, never defaulted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  declare,
  bid,
  nobid,
  grant,
  start,
  complete,
  release,
  withdraw,
  contest,
  stateAt,
  STATES,
} from '../core/work-auction.mjs';

const T0 = '2026-08-10T02:00:00.000Z';
const REPLY_BY = '2026-08-10T02:20:00.000Z';
const BEFORE = '2026-08-10T02:10:00.000Z';
const AFTER = '2026-08-10T02:30:00.000Z';

/** The roster of seats present when the window opened. Early-close is arithmetic over it. */
const REQUIRED = ['ada', 'bo', 'cy'];

function open(overrides = {}) {
  return declare({
    id: 'wo-1',
    by: 'ada',
    at: T0,
    replyBy: REPLY_BY,
    required: REQUIRED,
    ...overrides,
  });
}

// ── the shape of a work object ──────────────────────────────────────────────

test('#755 a declaration puts its declarer in BIDDING, not OPEN', () => {
  const wo = open();
  assert.equal(stateAt(wo, BEFORE).state, STATES.BIDDING);
  assert.deepEqual(stateAt(wo, BEFORE).bidders, ['ada']);
});

test('#755 a work object with no claimant is OPEN until someone bids', () => {
  const wo = declare({ id: 'wo-2', by: null, at: T0, replyBy: REPLY_BY, required: REQUIRED });
  assert.equal(stateAt(wo, BEFORE).state, STATES.OPEN);
  assert.equal(stateAt(bid(wo, { by: 'bo', at: BEFORE }), BEFORE).state, STATES.BIDDING);
});

test('#755 transitions are append-only and never mutate their input', () => {
  const wo = open();
  const before = JSON.stringify(wo);
  const after = bid(wo, { by: 'bo', at: BEFORE });
  assert.equal(JSON.stringify(wo), before, 'declare() result was mutated by bid()');
  assert.equal(after.transitions.length, wo.transitions.length + 1);
  assert.deepEqual(after.transitions.slice(0, wo.transitions.length), wo.transitions);
});

// ── ⛔ PII: the free-text surface does not exist yet, and cannot be smuggled in ──

test('#755 declare() REFUSES unknown fields — no free text before the #523 guard exists', () => {
  // The persistence slice is where scrub-by-default lands. Until then the
  // safest description field is the one that does not exist. A permissive
  // object spread here would let a title/description ride in ahead of the
  // guard, and "we'll scrub it later" is exactly what #523 is the receipt
  // against.
  assert.throws(
    () => declare({ id: 'wo-3', by: 'ada', at: T0, replyBy: REPLY_BY, required: REQUIRED, description: 'any free text at all' }),
    /unknown field: description/,
  );
  assert.throws(
    () => declare({ id: 'wo-3', by: 'ada', at: T0, replyBy: REPLY_BY, required: REQUIRED, title: 'anything' }),
    /unknown field: title/,
  );
});

test('#755 bid()/nobid() refuse unknown fields too — the guard is on every writer', () => {
  const wo = open();
  assert.throws(() => bid(wo, { by: 'bo', at: BEFORE, note: 'freeform' }), /unknown field: note/);
  assert.throws(() => nobid(wo, { by: 'bo', at: BEFORE, reason: 'freeform' }), /unknown field: reason/);
});

// ── ⭐ DESIGN B: derived expiry ─────────────────────────────────────────────

test('#755 stateAt REFUSES to read the wall clock — `now` is required, never defaulted', () => {
  const wo = open();
  assert.throws(() => stateAt(wo), /now is required/);
  // And it must not reach for Date.now() internally: a module that does would
  // pass the line above and still be design A in disguise.
  const realNow = Date.now;
  Date.now = () => {
    throw new Error('stateAt read the wall clock');
  };
  try {
    stateAt(wo, BEFORE);
  } finally {
    Date.now = realNow;
  }
});

test('#755 a window past replyBy with ONE bidder grants by timeout — nothing had to fire', () => {
  const wo = open();
  const s = stateAt(wo, AFTER);
  assert.equal(s.state, STATES.GRANTED);
  assert.equal(s.grantedTo, 'ada');
  assert.equal(s.grantedBy, 'timeout');
});

test('#755 ⭐⭐ stateAt survives a JSON round-trip — THE test that separates B from A', () => {
  // Simulates the restart #755's trial-measures list names: serialize, throw
  // away every in-process reference (no module state, no timers, no closures),
  // re-derive from stored fields alone. Under design A there would be nothing
  // left to fire and the window would hang pending forever.
  const wo = open();
  const rehydrated = JSON.parse(JSON.stringify(wo));
  assert.deepEqual(stateAt(rehydrated, AFTER), stateAt(wo, AFTER));
  assert.equal(stateAt(rehydrated, AFTER).state, STATES.GRANTED);
  assert.equal(stateAt(rehydrated, AFTER).grantedBy, 'timeout');
});

test('#755 stateAt is pure — same stored object and same now, same answer, repeatedly', () => {
  const wo = bid(open(), { by: 'bo', at: BEFORE });
  const a = stateAt(wo, BEFORE);
  const b = stateAt(wo, BEFORE);
  assert.deepEqual(a, b);
  assert.notEqual(a, b, 'stateAt handed back a shared mutable object');
});

// ── ⚠️ where timeout-⇒-GRANT and "the board randomises" collide ─────────────

test('#755 ⚠️ expiry with TWO bidders does NOT silently grant — it is ARBITRATION_DUE', () => {
  // #755 says "claimant declares → others contest → board randomises". A
  // randomised winner cannot live inside a derived function: two readers would
  // derive DIFFERENT winners from identical stored bytes, and the restart
  // property above would be false. So a contested window that expires needs an
  // explicit, recorded GRANT — a write, by an actor, auditable.
  //
  // ⛔ THIS IS A DESIGN GAP SURFACED BY THE BUILD, NOT A DECISION TAKEN HERE.
  //    Recording it as a distinct state means it cannot be mistaken for a
  //    grant. The room chooses: deterministic tiebreak from stored data, or
  //    arbitration as an explicit transition.
  const wo = bid(open(), { by: 'bo', at: BEFORE });
  const s = stateAt(wo, AFTER);
  assert.equal(s.state, STATES.ARBITRATION_DUE);
  assert.deepEqual(s.bidders.slice().sort(), ['ada', 'bo']);
  assert.equal(s.grantedTo, null);
});

test('#755 a contested window resolved by an explicit grant is GRANTED, and expiry does not move it', () => {
  const wo = grant(bid(open(), { by: 'bo', at: BEFORE }), { by: 'cy', to: 'bo', at: BEFORE });
  for (const now of [BEFORE, AFTER]) {
    const s = stateAt(wo, now);
    assert.equal(s.state, STATES.GRANTED);
    assert.equal(s.grantedTo, 'bo');
    assert.equal(s.grantedBy, 'cy');
  }
});

// ── ⭐ early close, and the refusal that must be a token ────────────────────

test('#755 EARLY-CLOSE: once every rostered seat has answered, the window closes before replyBy', () => {
  let wo = open(); // the declarer answered by declaring
  wo = nobid(wo, { by: 'bo', at: BEFORE });
  assert.equal(stateAt(wo, BEFORE).state, STATES.BIDDING, 'closed while a required seat was still pending');
  wo = nobid(wo, { by: 'cy', at: BEFORE });
  const s = stateAt(wo, BEFORE);
  assert.equal(s.state, STATES.GRANTED);
  assert.equal(s.grantedBy, 'early-close');
  assert.equal(s.grantedTo, 'ada');
});

test('#755 ⚠️ SILENCE IS NOT A REFUSAL — an unanswered seat keeps the window open', () => {
  // The finding from the room's own run: a seat's standing boilerplate line
  // ("Nothing to add on my side") is a sentence she posts regardless of any
  // question, and it is indistinguishable from a refusal. So the module counts
  // only RECORDED nobid transitions. A seat that never answers is pending, and
  // the window rides to its deadline rather than closing on an inference.
  const wo = nobid(open(), { by: 'bo', at: BEFORE });
  assert.equal(stateAt(wo, BEFORE).state, STATES.BIDDING);
  assert.deepEqual(stateAt(wo, BEFORE).pending, ['cy']);
});

test('#755 a seat off the roster may still answer, but cannot close the window', () => {
  let wo = nobid(open(), { by: 'bo', at: BEFORE });
  wo = nobid(wo, { by: 'dee', at: BEFORE });
  assert.equal(stateAt(wo, BEFORE).state, STATES.BIDDING);
  assert.deepEqual(stateAt(wo, BEFORE).pending, ['cy']);
});

test('#755 a seat may not answer twice, and may not bid after refusing', () => {
  const wo = nobid(open(), { by: 'bo', at: BEFORE });
  assert.throws(() => nobid(wo, { by: 'bo', at: BEFORE }), /bo has already answered/);
  assert.throws(() => bid(wo, { by: 'bo', at: BEFORE }), /bo has already answered/);
});

// ── the granted lane ────────────────────────────────────────────────────────

test('#755 GRANTED → RUNNING → COMPLETE', () => {
  let wo = grant(open(), { by: 'cy', to: 'ada', at: BEFORE });
  wo = start(wo, { by: 'ada', at: BEFORE });
  assert.equal(stateAt(wo, BEFORE).state, STATES.RUNNING);
  wo = complete(wo, { by: 'ada', at: AFTER });
  assert.equal(stateAt(wo, AFTER).state, STATES.COMPLETE);
});

test('#755 a grantee may RELEASE — grants are releasable, and release is terminal for this object', () => {
  let wo = start(grant(open(), { by: 'cy', to: 'ada', at: BEFORE }), { by: 'ada', at: BEFORE });
  wo = release(wo, { by: 'ada', at: AFTER });
  assert.equal(stateAt(wo, AFTER).state, STATES.RELEASED);
  assert.throws(() => complete(wo, { by: 'ada', at: AFTER }), /cannot complete from released/);
});

test('#755 only the grantee may start, complete, or release', () => {
  const granted = grant(open(), { by: 'cy', to: 'ada', at: BEFORE });
  assert.throws(() => start(granted, { by: 'bo', at: BEFORE }), /bo is not the grantee/);
  const running = start(granted, { by: 'ada', at: BEFORE });
  assert.throws(() => complete(running, { by: 'bo', at: AFTER }), /bo is not the grantee/);
  assert.throws(() => release(running, { by: 'bo', at: AFTER }), /bo is not the grantee/);
});

test('#755 work cannot start before it is granted', () => {
  assert.throws(() => start(open(), { by: 'ada', at: BEFORE }), /cannot start from bidding/);
});

// ── withdraw ────────────────────────────────────────────────────────────────

test('#755 the declarer may WITHDRAW their own object while the window is open', () => {
  const wo = withdraw(open(), { by: 'ada', at: BEFORE });
  assert.equal(stateAt(wo, BEFORE).state, STATES.WITHDRAWN);
  // ⭐ and a withdrawn object does not later spring back to life at replyBy
  assert.equal(stateAt(wo, AFTER).state, STATES.WITHDRAWN);
});

test('#755 a seat cannot withdraw work it did not declare', () => {
  assert.throws(() => withdraw(open(), { by: 'bo', at: BEFORE }), /bo did not declare/);
});

// ── the log is the record ───────────────────────────────────────────────────

test('#755 every transition records actor and time, and the log reads in order', () => {
  let wo = open();
  wo = nobid(wo, { by: 'bo', at: BEFORE });
  wo = grant(wo, { by: 'cy', to: 'ada', at: BEFORE });
  assert.deepEqual(
    wo.transitions.map((t) => [t.type, t.by]),
    [
      ['declare', 'ada'],
      ['bid', 'ada'],
      ['nobid', 'bo'],
      ['grant', 'cy'],
    ],
  );
  for (const t of wo.transitions) {
    assert.ok(t.at, `transition ${t.type} has no timestamp`);
    assert.ok('by' in t, `transition ${t.type} has no actor`);
  }
});

test('#755 an out-of-order timestamp is refused — the log must not lie about sequence', () => {
  assert.throws(() => bid(open(), { by: 'bo', at: '2026-08-10T01:00:00.000Z' }), /before the previous transition/);
});

// ── SLICE 2a — contest(): the transition for pure dissent ────────────────────
//
// Found by USING slice 1, not by designing it. A live window carried two items;
// a steward's honest answer was "I don't want to build this, and it should not
// proceed" — and there was no way to say it. `bid` means you want the work,
// `nobid` means you don't care. The one shape that is pure dissent had no token,
// so dissent read as consent and the module would have auto-granted over the
// only objection on record.
//
// ⚠️ THE SEMANTIC IS WHAT MAKES IT A RAIL RATHER THAN A FIELD:
//    contests.length > 0  →  ARBITRATION_DUE, regardless of bidder count.
//    Without that, contest() is a token nobody's arithmetic reads — the same
//    defect one layer in: a refusal the instrument can see but does not act on.
//
// ⛔ EVIDENCE VALUE TOWARD #755's FOUR DEMONSTRATIONS: ZERO, exactly as slice 1.
//    A contest() that nothing loads discharges a design defect. It is not
//    progress toward a rail.

test('#755-2a a contest is recorded, and a contester is NOT a bidder', () => {
  const wo = contest(open(), { by: 'bo', at: BEFORE });
  const s = stateAt(wo, BEFORE);
  assert.deepEqual(s.bidders, ['ada']);
  assert.deepEqual(s.contesters, ['bo']);
});

test('#755-2a ⭐⭐ ONE contest suspends the automatic grant — one bidder, past replyBy, ARBITRATION_DUE', () => {
  // The deciding test. Without the contest check this returns GRANTED-by-timeout,
  // which is the module silently overriding the only objection on record.
  const wo = contest(open(), { by: 'bo', at: BEFORE });
  const s = stateAt(wo, AFTER);
  assert.equal(s.state, STATES.ARBITRATION_DUE);
  assert.equal(s.grantedTo, null);
  assert.equal(s.grantedBy, null);
});

test('#755-2a a contest suspends EARLY-CLOSE too, not just the timeout path', () => {
  let wo = contest(open(), { by: 'bo', at: BEFORE });
  wo = nobid(wo, { by: 'cy', at: BEFORE });
  const s = stateAt(wo, BEFORE);
  assert.deepEqual(s.pending, [], 'every required seat has answered');
  assert.equal(s.state, STATES.ARBITRATION_DUE);
});

test('#755-2a ⭐ a QUIET room still grants — the anti-deadlock property survives contest()', () => {
  // #755 rests on "timeout defaults to ACT". contest() must suspend the grant
  // only when someone actually objected, never merely by existing.
  const s = stateAt(open(), AFTER);
  assert.equal(s.state, STATES.GRANTED);
  assert.equal(s.grantedBy, 'timeout');
});

test('#755-2a a contest COUNTS AS ANSWERING — it must not hold the window open too', () => {
  // Otherwise a contester both blocks the grant and keeps the window pending,
  // which is two penalties for one objection and makes dissent expensive.
  let wo = contest(open(), { by: 'bo', at: BEFORE });
  assert.deepEqual(stateAt(wo, BEFORE).pending, ['cy']);
});

test('#755-2a an explicit grant OVERRIDES a contest — the room can still rule', () => {
  // ARBITRATION_DUE means "a human decision is required", not "blocked forever".
  const wo = grant(contest(open(), { by: 'bo', at: BEFORE }), { by: 'cy', to: 'ada', at: BEFORE });
  assert.equal(stateAt(wo, AFTER).state, STATES.GRANTED);
  assert.equal(stateAt(wo, AFTER).grantedTo, 'ada');
  assert.equal(stateAt(wo, AFTER).grantedBy, 'cy');
});

test('#755-2a a seat may not contest twice, nor contest after answering', () => {
  const wo = contest(open(), { by: 'bo', at: BEFORE });
  assert.throws(() => contest(wo, { by: 'bo', at: BEFORE }), /bo has already answered/);
  assert.throws(() => bid(wo, { by: 'bo', at: BEFORE }), /bo has already answered/);
  assert.throws(() => contest(nobid(open(), { by: 'bo', at: BEFORE }), { by: 'bo', at: BEFORE }), /bo has already answered/);
});

test('#755-2a contest() refuses unknown fields — the free-text guard is on every writer', () => {
  assert.throws(() => contest(open(), { by: 'bo', at: BEFORE, because: 'freeform' }), /unknown field: because/);
});

test('#755-2a a contest cannot be recorded after the work is granted or running', () => {
  const granted = grant(open(), { by: 'cy', to: 'ada', at: BEFORE });
  assert.throws(() => contest(granted, { by: 'bo', at: BEFORE }), /cannot contest from granted/);
  assert.throws(() => contest(start(granted, { by: 'ada', at: BEFORE }), { by: 'bo', at: AFTER }), /cannot contest from running/);
});

test('#755-2a contests survive the JSON round-trip like everything else', () => {
  const wo = contest(open(), { by: 'bo', at: BEFORE });
  const rehydrated = JSON.parse(JSON.stringify(wo));
  assert.deepEqual(stateAt(rehydrated, AFTER), stateAt(wo, AFTER));
  assert.equal(stateAt(rehydrated, AFTER).state, STATES.ARBITRATION_DUE);
});
