/**
 * #613 — the seat-state contract, tested where it lives.
 *
 * ⛔ The defect these guard against is not a crash; it is a scheduler acting on
 * a state nobody declared. Every assertion below is about the difference
 * between ABSENCE and A STATEMENT, because that difference is the whole card:
 * "declining" and "gone" are indistinguishable today, and a stored row that
 * blurs them would reproduce the problem inside the fix.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateDeclaration, seatState, eligibleSeats, tendingEligibility,
  isLive, UNKNOWN, MAX_DECLARATION_HOURS,
} from '../core/seat-state.mjs';

const NOW = '2026-08-30T12:00:00.000Z';
const IN_1H = '2026-08-30T13:00:00.000Z';
const ROSTER = ['ada', 'bo', 'cy'];
const resting = (seat, expiresAt = IN_1H) => ({
  seat, mode: 'resting', acceptsRoutineWork: false, constraints: [], note: null,
  declaredAt: NOW, expiresAt,
});

test('#613 UNKNOWN is absence: it cannot be written, and it is what no declaration reports', () => {
  assert.equal(seatState([], 'ada', NOW).mode, UNKNOWN);
  assert.throws(
    () => validateDeclaration('ada', { mode: 'unknown', acceptsRoutineWork: true, expiresAt: IN_1H }, { now: NOW }),
    (e) => e.code === 'UNKNOWN_NOT_WRITABLE',
    'storing UNKNOWN would make "nobody has said" indistinguishable from "somebody said they do not know"',
  );
  // ⭐ AND THE CONTROL: a real mode IS writable, or the assertion above would
  // pass against a function that refused everything.
  const ok = validateDeclaration('ada', { mode: 'resting', acceptsRoutineWork: false, expiresAt: IN_1H }, { now: NOW });
  assert.equal(ok.mode, 'resting');
  assert.equal(ok.seat, 'ada');
});

test('#613 the seat comes from the session, never from the payload', () => {
  // #1106 is today's card about a tool that dropped `by` and silently signed
  // every write with the owner's name. This function cannot make that mistake:
  // it does not read a seat from its input at all.
  const d = validateDeclaration(
    'ada',
    { seat: 'bo', by: 'bo', mode: 'resting', acceptsRoutineWork: false, expiresAt: IN_1H },
    { now: NOW },
  );
  assert.equal(d.seat, 'ada', 'a seat name in the payload must be ignored, not honoured');
  assert.throws(() => validateDeclaration('', { mode: 'resting', acceptsRoutineWork: false, expiresAt: IN_1H }, { now: NOW }),
    (e) => e.code === 'NO_SEAT');
});

test('#613 acceptsRoutineWork is explicit, and the mode label may not contradict it', () => {
  const base = { mode: 'degraded', constraints: ['no-writes'], expiresAt: IN_1H };
  assert.throws(() => validateDeclaration('ada', base, { now: NOW }), (e) => e.code === 'ACCEPTS_REQUIRED',
    'a scheduler must never infer willingness from the word "degraded"');
  // Both directions of the conflict, because a guard that only checked one
  // would let the opposite nonsense through.
  assert.throws(
    () => validateDeclaration('ada', { mode: 'resting', acceptsRoutineWork: true, expiresAt: IN_1H }, { now: NOW }),
    (e) => e.code === 'MODE_CONFLICT');
  assert.throws(
    () => validateDeclaration('ada', { mode: 'available', acceptsRoutineWork: false, expiresAt: IN_1H }, { now: NOW }),
    (e) => e.code === 'MODE_CONFLICT');
  // ⭐ CONTROL: degraded may go EITHER way, which is the point of it being explicit.
  for (const accepts of [true, false]) {
    const d = validateDeclaration('ada', { ...base, acceptsRoutineWork: accepts }, { now: NOW });
    assert.equal(d.acceptsRoutineWork, accepts);
  }
});

test('#613 degraded must NAME its constraints, from a closed vocabulary', () => {
  assert.throws(
    () => validateDeclaration('ada', { mode: 'degraded', acceptsRoutineWork: false, constraints: [], expiresAt: IN_1H }, { now: NOW }),
    (e) => e.code === 'CONSTRAINTS_REQUIRED');
  assert.throws(
    () => validateDeclaration('ada', { mode: 'degraded', acceptsRoutineWork: false, constraints: ['tired'], expiresAt: IN_1H }, { now: NOW }),
    (e) => e.code === 'UNKNOWN_CONSTRAINT',
    'a constraint no scheduler can match is a promise nothing keeps');
  const d = validateDeclaration('ada',
    { mode: 'degraded', acceptsRoutineWork: false, constraints: ['reads-unreliable', 'no-writes'], expiresAt: IN_1H }, { now: NOW });
  assert.deepEqual(d.constraints, ['reads-unreliable', 'no-writes']);
});

test('#613 a declaration is finite, in the future, and bounded', () => {
  assert.throws(() => validateDeclaration('ada', { mode: 'resting', acceptsRoutineWork: false }, { now: NOW }),
    (e) => e.code === 'EXPIRY_REQUIRED', 'no end means a permanent opt-out wearing an expiry\'s clothes');
  assert.throws(
    () => validateDeclaration('ada', { mode: 'resting', acceptsRoutineWork: false, expiresAt: '2026-08-30T11:00:00.000Z' }, { now: NOW }),
    (e) => e.code === 'EXPIRY_PAST');
  const tooFar = new Date(Date.parse(NOW) + (MAX_DECLARATION_HOURS + 1) * 3600_000).toISOString();
  assert.throws(() => validateDeclaration('ada', { mode: 'resting', acceptsRoutineWork: false, expiresAt: tooFar }, { now: NOW }),
    (e) => e.code === 'EXPIRY_TOO_FAR');
  // ⭐ CONTROL: just inside the ceiling is accepted, so the bound is a bound and
  // not a refusal of everything long.
  const justInside = new Date(Date.parse(NOW) + (MAX_DECLARATION_HOURS - 1) * 3600_000).toISOString();
  assert.equal(
    validateDeclaration('ada', { mode: 'resting', acceptsRoutineWork: false, expiresAt: justInside }, { now: NOW }).expiresAt,
    justInside);
});

test('#613 expiry returns to UNKNOWN, and activity never renews it', () => {
  const decls = [resting('ada', '2026-08-30T12:30:00.000Z')];
  assert.equal(seatState(decls, 'ada', NOW).mode, 'resting');
  assert.ok(isLive(decls[0], NOW));

  const after = '2026-08-30T12:30:00.001Z';
  const state = seatState(decls, 'ada', after);
  assert.equal(state.mode, UNKNOWN, 'an expired declaration reports UNKNOWN, not its last value');
  assert.equal(state.acceptsRoutineWork, null);
  assert.equal(state.expired, true, 'and the row is kept, so "she once declared" stays answerable');
  // ⛔ THE ANTI-RENEWAL CONTROL. Nothing in this module takes activity as an
  // input, so there is no argument that could renew it — asserted rather than
  // assumed, because a later refactor could quietly add one.
  assert.equal(seatState(decls, 'ada', after).mode, UNKNOWN);
});

test('#613 eligibility: UNKNOWN is ELIGIBLE, and only a stated no removes a seat', () => {
  // ⭐⭐ THE CONTROL THAT MATTERS MOST. If absence read as a "no", shipping this
  // would opt the entire room out of tending on day one — the failure that
  // looks like a working feature.
  assert.deepEqual(eligibleSeats(ROSTER, [], NOW), ROSTER);

  const decls = [resting('bo')];
  assert.deepEqual(eligibleSeats(ROSTER, decls, NOW), ['ada', 'cy'], 'one stated no removes exactly one seat');

  // An AVAILABLE declaration is not required to be eligible, and does not change it.
  const withAvailable = [...decls, {
    seat: 'ada', mode: 'available', acceptsRoutineWork: true, constraints: [], note: null,
    declaredAt: NOW, expiresAt: IN_1H,
  }];
  assert.deepEqual(eligibleSeats(ROSTER, withAvailable, NOW), ['ada', 'cy']);
});

test('#613 the tick asks one question and gets an honest skip when nobody is available', () => {
  const some = tendingEligibility(ROSTER, [resting('bo')], NOW);
  assert.equal(some.anyEligible, true);
  assert.deepEqual(some.eligible, ['ada', 'cy']);
  assert.deepEqual(some.declining, ['bo']);
  assert.equal(some.reason, null, 'the ordinary case names no reason, because nothing was skipped');

  const none = tendingEligibility(ROSTER, ROSTER.map((s) => resting(s)), NOW);
  assert.equal(none.anyEligible, false);
  assert.equal(none.reason, 'no-eligible-seats',
    'the room must record that it sent nothing, rather than reporting a delivery that did not happen');
  assert.deepEqual(none.eligible, []);

  // ⭐ AND ONE SEAT IS ENOUGH: a single declining seat must never suppress the
  // room. This is the card's own line-stop condition, as an assertion.
  const one = tendingEligibility(ROSTER, [resting('ada'), resting('bo')], NOW);
  assert.equal(one.anyEligible, true);
  assert.deepEqual(one.eligible, ['cy']);
});

test('#613 seat state is not authority — this module cannot express one', () => {
  // ⚠️ A NEGATIVE CONTROL ON THE SHAPE ITSELF. #466's fencing needs
  // claimAuthority to stay deterministic; availability being three-valued must
  // not leak into it. The cheapest durable guarantee is that no function here
  // returns or accepts anything authority-shaped, asserted so a future field
  // named `claimAuthority` fails this test instead of shipping.
  const d = validateDeclaration('ada', { mode: 'resting', acceptsRoutineWork: false, expiresAt: IN_1H }, { now: NOW });
  for (const forbidden of ['claimAuthority', 'permissions', 'lease', 'claims', 'canWrite']) {
    assert.ok(!(forbidden in d), `a declaration must not carry ${forbidden}: availability is not authority`);
  }
  assert.deepEqual(Object.keys(d).sort(),
    ['acceptsRoutineWork', 'constraints', 'declaredAt', 'expiresAt', 'mode', 'note', 'seat']);
});
