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
  settle,
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

// ── ⛔ stateAt MUST NOT SEE THE FUTURE ───────────────────────────────────────
//
// Found by running the review instrument on real data the morning the gate
// went live. It reported its first non-zero signal-2 numerator — 2/64 — and
// both "bypasses" were false: the two actions PRECEDED the work object's
// declaration by twenty seconds.
//
// `recorded()` folded EVERY transition regardless of its `at`, and stateAt used
// `now` only for the expiry comparison. So at any PAST timestamp a work object
// reported its FINAL bidder set, and anyone who ever bid appeared to hold an
// open window before the object existed.
//
// ⚠️ The live gate was unaffected — it always asks at the real present, where
// every transition is genuinely <= now. The defect manifests ONLY on
// retrospective queries, which is exactly and only what the instrument does.
// A bug that cannot fire in production and fires every time you measure
// production is the worst kind to have in a card about measurement.

test('#755 ⛔ stateAt at a time BEFORE the declaration sees nothing — no future transitions', () => {
  const wo = open();
  const s = stateAt(wo, '2026-08-10T01:00:00.000Z'); // before T0
  assert.deepEqual(s.bidders, [], 'a bidder appeared before they bid');
  assert.equal(s.state, STATES.OPEN);
});

test('#755 ⛔⛔ THE REGRESSION — the real events that produced a false 2/64', () => {
  // Verbatim from the event log and the live store, 2026-08-10.
  const wo = declare({
    id: '2c-demo-1',
    by: 'bo',
    at: '2026-08-10T12:47:53.772Z',
    replyBy: '2026-08-10T12:49:53.773Z',
    required: ['bo', 'ada'],
  });
  // Two covered actions by that same seat, TWENTY SECONDS EARLIER.
  const s = stateAt(wo, '2026-08-10T12:47:33.212Z');
  assert.equal(s.bidders.includes('bo'), false, 'the actor held a window that did not exist yet');
  assert.equal(s.state, STATES.OPEN);
});

test('#755 a transition is visible from the instant it happens, not one tick later', () => {
  const wo = open();
  assert.deepEqual(stateAt(wo, T0).bidders, ['ada'], 'the declaring bid must count AT its own timestamp');
});

test('#755 later transitions stay invisible until their own time arrives', () => {
  const wo = nobid(bid(open(), { by: 'bo', at: BEFORE }), { by: 'cy', at: AFTER });
  // At BEFORE: ada + bo have bid, cy has not yet answered.
  const mid = stateAt(wo, BEFORE);
  assert.deepEqual(mid.bidders.slice().sort(), ['ada', 'bo']);
  assert.deepEqual(mid.pending, ['cy']);
  // At AFTER: cy's nobid is visible, so nobody is pending.
  assert.deepEqual(stateAt(wo, AFTER).pending, []);
});

test('#755 a GRANT is invisible before it is given', () => {
  const wo = grant(open(), { by: 'cy', to: 'ada', at: AFTER });
  assert.equal(stateAt(wo, BEFORE).grantedTo, null, 'granted before the grant happened');
  assert.equal(stateAt(wo, AFTER).grantedTo, 'ada');
});

// ── #797 ⛔ A NON-STRING `now` RETURNED A CONFIDENT EMPTY WORLD ──────────────

test('#797 stateAt REFUSES a non-string `now` — a number silently hid every transition', () => {
  // MEASURED 2026-08-12. recorded() filters `t.at <= asOf`, where `t.at` is an
  // ISO string. Passing milliseconds makes every comparison string-vs-number,
  // which coerces to NaN and is therefore FALSE for every transition.
  //
  // ⚠️ The function did not fail. It reported a work object with no bidders,
  // nobody having answered, and state OPEN — a fully-formed, entirely wrong
  // answer. A repro built on it produced a refutation of a correct source
  // reading, and the only tell was `pending` listing a seat that had just
  // recorded a nobid.
  //
  // ⭐ `if (!now)` accepted it because a number is truthy. The guard tested
  // for PRESENCE and the failure was TYPE.
  const wo = open();
  assert.throws(
    () => stateAt(wo, Date.parse(BEFORE)),
    /canonical/,
    'a millisecond timestamp must be refused, not answered with an empty world',
  );
});

test('#797 stateAt REFUSES a string that is not a timestamp', () => {
  const wo = open();
  assert.throws(() => stateAt(wo, 'yesterday'), /canonical/);
});

test('#797 ⭐⭐ CANONICAL form only — valid ISO-8601 is a WIDER set than comparable ISO', () => {
  // The first version of this guard used a regex with an optional fraction and
  // an alternation for offsets. Both are valid ISO-8601 and neither is
  // lexicographically comparable against a canonical instant, so the check
  // admitted values that break the exact property it exists to protect.
  //
  // ⭐ Optionality in a validator is the tell: it means a FAMILY was accepted
  // where one representation was required.
  const wo = open();
  const rejected = [
    '2026-08-12T18:00:00Z',           // no fraction — '.100Z' would sort BEFORE it
    '2026-08-12T13:00:00.000-05:00',  // same instant as 18:00Z, sorts five hours early
    '2026-02-30T18:00:00.000Z',       // February 30th — normalises to March
  ];
  for (const bad of rejected) {
    assert.throws(() => stateAt(wo, bad), /canonical/, `must reject ${bad}`);
  }

  // ⇒ POSITIVE CONTROLS: canonical instants must still be accepted, including a
  // non-zero fraction. A guard that rejects everything also passes the loop above.
  for (const good of ['2026-08-12T18:00:00.000Z', '2026-08-12T18:00:00.100Z']) {
    assert.doesNotThrow(() => stateAt(wo, good), `must accept ${good}`);
  }
});

test('#797 ⭐ an unparseable value is REFUSED by the guard, not leaked as a RangeError', () => {
  // `new Date('not-a-date').toISOString()` THROWS RangeError rather than
  // returning a mismatch. A bare round-trip check therefore turns a validation
  // failure into an uncaught exception from inside a guard whose entire job is
  // to produce a clear refusal.
  //
  // ⚠️ Asserting merely "it threw" cannot see this — a RangeError satisfies
  // assert.throws just as well as the guard's own error does. The assertion has
  // to be on the MESSAGE.
  const wo = open();
  assert.throws(() => stateAt(wo, 'not-a-date'), /canonical/,
    'an unparseable string must produce the guard\'s refusal, not a RangeError from Date');
  assert.throws(() => stateAt(wo, ''), /now is required/,
    'the empty string is absence, and must be refused as such');
});

test('#797 a Date object is refused too — it stringifies to a non-comparable form', () => {
  // new Date().toString() is "Wed Aug 12 2026 ..." which sorts nowhere near an
  // ISO string. Accepting it would reintroduce the same silent wrongness.
  const wo = open();
  assert.throws(() => stateAt(wo, new Date(BEFORE)), /canonical/);
});

// ── #797 ⭐⭐ SETTLEMENT — the derived grant becomes a recorded fact ──────────

test('#797 settle() MATERIALISES a timeout grant as a recorded transition', () => {
  const wo = open();
  assert.equal(stateAt(wo, AFTER).state, STATES.GRANTED, 'precondition: derived grant');
  assert.equal(wo.transitions.filter((t) => t.type === 'settlement').length, 0, 'precondition: none recorded');

  const settled = settle(wo, AFTER);
  const grants = settled.transitions.filter((t) => t.type === 'settlement');
  assert.equal(grants.length, 1, 'settlement must record the grant, not merely compute it');
  assert.equal(grants[0].to, 'ada');
});

test('#797 ⭐⭐ THE DEFECT: after settlement a LATE answer is REFUSED, so the grant cannot evaporate', () => {
  // Before this fix: bid() saw recordedPhase BIDDING (no clock in the writer
  // guard), accepted a day-late bid, and the object left the granted family
  // entirely — granted → arbitration_due, with nothing withdrawn or contested.
  const wo = settle(open(), AFTER);
  assert.throws(
    () => bid(wo, { by: 'cy', at: '2026-08-11T09:00:00.000Z' }),
    /cannot bid from granted/,
    'a late bid must be refused once the grant is a recorded fact',
  );
  assert.equal(stateAt(wo, '2026-08-11T09:00:01.000Z').state, STATES.GRANTED, 'and the grant still stands');
  assert.equal(stateAt(wo, '2026-08-11T09:00:01.000Z').grantedTo, 'ada');
});

test('#797 ⭐ SETTLEMENT DOES NOT CHANGE THE ANSWER — only its durability', () => {
  // The safety property. If settling altered what the object reports, every
  // existing settled object would shift the moment someone touched it.
  const wo = open();
  assert.deepEqual(stateAt(settle(wo, AFTER), AFTER), stateAt(wo, AFTER),
    'the settled object must derive to exactly what the unsettled one did');
});

test('#797 settle() PRESERVES PROVENANCE — closure reason is not an actor', () => {
  // A recorded grant's `by` is an ACTOR; derived `grantedBy` is 'timeout' or
  // 'early-close'. Collapsing them makes an automatic settlement indistinguishable
  // from a human arbitration, which is the one thing the grant log exists to show.
  const auto = settle(open(), AFTER);
  const [g] = auto.transitions.filter((t) => t.type === 'settlement');
  assert.equal(g.actor, 'protocol', 'the protocol settled this — not a person');
  assert.equal(g.by, undefined, 'an automatic settlement has no human actor at all');
  assert.equal(g.closureReason, 'timeout', 'the closure REASON belongs in its own field');
  assert.equal(stateAt(auto, AFTER).grantedBy, 'timeout');

  // …and an explicit human grant is still reported by its actor.
  const human = grant(bid(open(), { by: 'bo', at: BEFORE }), { by: 'cy', to: 'bo', at: BEFORE });
  assert.equal(stateAt(human, AFTER).grantedBy, 'cy', 'a human arbitration must not be relabelled');
});

test('#797 settle() records WHEN the grant became derivable, not just when it was written', () => {
  const settled = settle(open(), AFTER);
  const [g] = settled.transitions.filter((t) => t.type === 'settlement');
  assert.equal(g.at, AFTER, 'the log-ordering timestamp IS the materialisation time');
  assert.equal(g.effectiveAt, REPLY_BY, 'effective time — when the window actually closed');
});

test('#797 settle() is IDEMPOTENT — touching twice does not record two grants', () => {
  const once = settle(open(), AFTER);
  const twice = settle(once, '2026-08-10T03:00:00.000Z');
  assert.equal(twice.transitions.filter((t) => t.type === 'settlement').length, 1);
  assert.deepEqual(twice, once, 'a second settlement must be a no-op, not an append');
});

// ── ⭐ NEGATIVE CONTROLS: settlement must not fire where the outcome is undecided ──

test('#797 settle() does NOT settle a window that is still OPEN', () => {
  const wo = open();
  assert.deepEqual(settle(wo, BEFORE), wo, 'the window has not closed — nothing is decided yet');
});

test('#797 ⛔ settle() does NOT settle a CONTESTED window — arbitration is not automatic', () => {
  // Two bidders at close is ARBITRATION_DUE precisely because a derived function
  // must not pick a winner. Settlement writing one would be worse: it would make
  // the arbitrary choice PERMANENT.
  const contested = bid(open(), { by: 'bo', at: BEFORE });
  assert.equal(stateAt(contested, AFTER).state, STATES.ARBITRATION_DUE, 'precondition');
  assert.deepEqual(settle(contested, AFTER), contested, 'settlement must refuse to arbitrate');
});

test('#797 settle() does NOT re-settle an object granted explicitly, or one already terminal', () => {
  const human = grant(bid(open(), { by: 'bo', at: BEFORE }), { by: 'cy', to: 'bo', at: BEFORE });
  assert.deepEqual(settle(human, AFTER), human);
  const done = complete(start(settle(open(), AFTER), { by: 'ada', at: AFTER }), { by: 'ada', at: AFTER });
  assert.deepEqual(settle(done, '2026-08-11T00:00:00.000Z'), done);
});

test('#797 ⭐⭐⭐ a settlement CARRIES ITS OWN CAVEAT — pendingAtClosure is frozen on the fact', () => {
  // The room questioned three live grants of exactly this shape: grantedBy
  // timeout with a required seat still pending. One of them was handed to me
  // and I declined it — "a timeout grant produced by a rail that cannot hear
  // one of three seats is not authority to act alone."
  //
  // ⛔ A derived value can be re-read with today's understanding. A transition
  // cannot. So settling naively would convert a grant the room has explicitly
  // questioned into an immutable endorsement.
  //
  // ⭐ Recording `pendingAtClosure` ON the fact means the immutable statement is
  // "the protocol granted despite cy remaining pending" — NOT "the room
  // consented." #795's fix can then read the caveat instead of arguing with it.
  const wo = nobid(open(), { by: 'bo', at: BEFORE }); // ada declared, bo answered, cy silent
  const settled = settle(wo, AFTER);
  const [s] = settled.transitions.filter((t) => t.type === 'settlement');

  assert.deepEqual(s.pendingAtClosure, ['cy'],
    'the seats that never answered must be frozen onto the settlement itself');
  assert.equal(s.closureReason, 'timeout');

  // ⚠️ And a later answer must NOT rewrite history. The caveat is a fact about
  // the moment of closure, not a live query.
  assert.throws(() => bid(settled, { by: 'cy', at: '2026-08-11T00:00:00.000Z' }), /cannot bid from granted/);
  const [after] = settled.transitions.filter((t) => t.type === 'settlement');
  assert.deepEqual(after.pendingAtClosure, ['cy'], 'pendingAtClosure must be immutable');
});

test('#797 an unambiguous early-close settlement records an EMPTY caveat, not an absent one', () => {
  // total:0 vs absent, again: "nobody was pending" and "we did not record who
  // was pending" must not look alike on an immutable fact.
  const all = nobid(nobid(open(), { by: 'bo', at: BEFORE }), { by: 'cy', at: BEFORE });
  const settled = settle(all, BEFORE);
  const [s] = settled.transitions.filter((t) => t.type === 'settlement');
  assert.equal(s.closureReason, 'early-close');
  assert.deepEqual(s.pendingAtClosure, [], 'an empty caveat is a claim; an absent one is silence');
});

// ── #797 ⛔⛔ POLLUTED HISTORY — an object that ALREADY took a late answer ────

test('#797 ⭐⭐⭐ settlement records the EARLIEST closure, not the state at first touch', () => {
  // The case every pre-fix object can be in. Before settlement existed, a late
  // answer was ACCEPTED — that is the defect this card is about. So when such an
  // object is finally touched:
  //
  //   stateAt(now) says   every required seat has answered ⇒ early-close, pending []
  //   the truth is        the window closed at replyBy as a TIMEOUT with bo pending
  //
  // ⛔ Settling from `now` would write the late answer INTO the historical fact
  // and erase the caveat — an immutable record asserting a closure that never
  // happened. A settlement is the one place a wrong derivation cannot be re-read
  // later, so it must be derived AS OF CLOSURE, never as of the touch.
  const polluted = nobid(open({ required: ['ada', 'bo'] }), { by: 'bo', at: AFTER }); // AFTER > REPLY_BY
  const settled = settle(polluted, '2026-08-11T00:00:00.000Z');
  const [s] = settled.transitions.filter((t) => t.type === 'settlement');

  assert.equal(s.closureReason, 'timeout',
    'an answer accepted AFTER the deadline cannot convert a timeout into an early-close');
  assert.deepEqual(s.pendingAtClosure, ['bo'],
    'bo was pending when the window actually shut — a later answer must not erase that');
  assert.equal(s.effectiveAt, REPLY_BY, 'the window closed at its deadline, not when bo eventually spoke');
});

test('#797 a GENUINE pre-deadline early-close is still recorded as early-close', () => {
  // The positive control: deriving as-of-closure must not turn every early-close
  // into a timeout. An object where everyone genuinely answered in time closes
  // when the last of them did.
  const intime = nobid(open({ required: ['ada', 'bo'] }), { by: 'bo', at: BEFORE }); // BEFORE < REPLY_BY
  const [s] = settle(intime, AFTER).transitions.filter((t) => t.type === 'settlement');
  assert.equal(s.closureReason, 'early-close');
  assert.equal(s.effectiveAt, BEFORE, 'closure is when the last required seat answered');
  assert.deepEqual(s.pendingAtClosure, []);
});

test('#797 a late BID on a polluted object settles to the TRUE single-bidder grant', () => {
  // Worse variant: the late answer was a BID, so `now` shows two bidders and
  // reads ARBITRATION_DUE — a window that was never contested before it closed.
  // Deriving as-of-closure restores the grant the protocol actually made.
  const polluted = bid(open({ required: ['ada', 'bo'] }), { by: 'bo', at: AFTER });
  assert.equal(stateAt(polluted, AFTER).state, STATES.ARBITRATION_DUE, 'precondition: it reads contested NOW');

  const [s] = settle(polluted, '2026-08-11T00:00:00.000Z').transitions.filter((t) => t.type === 'settlement');
  assert.equal(s.to, 'ada', 'the only seat that bid before the deadline');
  assert.equal(s.closureReason, 'timeout');
  assert.deepEqual(s.pendingAtClosure, ['bo']);
});

test('#797 early-close time is the LAST required seat to answer, chronologically', () => {
  // A review edge: closure must be the moment the last pending required seat
  // FIRST answered, not merely the last answer transition in array order.
  //
  // closureOf() keeps the FIRST answer per seat and takes the maximum of those,
  // sorted as ISO strings. Three seats answering at staggered times pins it.
  //
  // ⭐ And the two orders cannot diverge in a well-formed log: append() refuses
  // a transition whose `at` precedes the previous one, so array order IS
  // chronological order. The property is enforced upstream rather than assumed
  // here — which is worth knowing, because it means a hand-built object is the
  // only way to violate it.
  const t1 = '2026-08-10T02:02:00.000Z';
  const t2 = '2026-08-10T02:07:00.000Z';
  const wo = nobid(nobid(open(), { by: 'bo', at: t1 }), { by: 'cy', at: t2 });
  const [s] = settle(wo, AFTER).transitions.filter((t) => t.type === 'settlement');
  assert.equal(s.closureReason, 'early-close');
  assert.equal(s.effectiveAt, t2, 'closure is when the LAST required seat answered, not the first');

  assert.throws(
    () => nobid(wo, { by: 'dee', at: '2026-08-10T02:03:00.000Z' }),
    /before the previous transition/,
    'append() refuses out-of-order transitions, so array order cannot diverge from chronological order',
  );
});
