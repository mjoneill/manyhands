/**
 * #886 — the work gate is a mutex on the WORK, not on the seat.
 *
 * ⭐ THE GATE'S OWN COMMENT ALREADY STATES THE RULE, and the implementation
 * contradicts it:
 *
 *   "Not the actor's window ⇒ not the actor's problem. The window is a mutex on
 *    the WORK, not on a seat's whole existence."
 *
 * ⇒ It then refuses EVERY covered action by a seat holding ANY open window,
 *   which makes it a mutex on the seat's whole existence.
 *
 * ⛔ WHAT THE GATE WAS BUILT TO CATCH, from its header: "the protocol's own
 * author taking a covered action INSIDE her own open window, thirty seconds
 * after publishing the rule." That is acting on the DECLARED work without a
 * grant. It is not "filing an unrelated card about a production outage" — which
 * is what it refused live on 2026-08-18, blocking a seat from reporting an
 * outage because she had asked the room a question forty minutes earlier.
 *
 * ⚠️ THE NARROWING MUST NOT WEAKEN THE MEASURED CASE. Every test below that
 * proves the gate lets unrelated work through is paired with one proving it
 * still refuses the thing it exists for. A narrowing with only permissive tests
 * would pass against a gate that refuses nothing at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideCoveredAction } from '../core/work-gate.mjs';

// ⚠️ A STRING, not a Date. `assertInstant` refuses anything that is not the
// canonical toISOString() form, because every comparison downstream is
// lexicographic — and a Date stringifies to "Tue Aug 18 2026 …", which sorts
// nowhere near an ISO instant. The first draft of this file passed a Date and
// two tests went green by returning BEFORE the throw, which is the shape of a
// pass that proves nothing.
// Seats are SYNTHETIC (ada · bo · grace) — fixtures in this repo never carry a
// real seat or person name, and the pre-push gate enforces it on what a push ADDS.
const NOW = '2026-08-18T12:00:00.000Z';
// ⚠️ Shape taken from `declare()` in core/work-auction.mjs, not invented: a work
// object is a transition LOG, and `card` is the pointer at what the work is for.
// The first fixture here guessed an `events` array and failed four tests for a
// reason that had nothing to do with the code under test.
const OPEN_WINDOW = {
  id: 'w-881-practice-shape',
  sourceMessageId: null,
  card: 881,
  declaredBy: 'ada',
  replyBy: '2026-08-18T12:45:00.000Z',
  required: ['bo', 'grace'],
  transitions: [
    { type: 'declare', by: 'ada', at: '2026-08-18T11:59:00.000Z' },
    { type: 'bid', by: 'ada', at: '2026-08-18T11:59:00.000Z' },
  ],
};

test('#886 the gate still REFUSES action on the card its window covers', async () => {
  // ⛔ THE MEASURED FAILURE. If this ever passes, the narrowing has removed the
  // only thing the gate was built for and the rest of this file is decoration.
  const r = decideCoveredAction({
    actor: 'ada', workObjects: [OPEN_WINDOW], now: NOW, card: 881,
  });
  assert.equal(r.allow, false, 'acting on your own declared card inside your own open window');
  assert.equal(r.workObjectId, 'w-881-practice-shape');
});

test('#886 the gate ALLOWS action on an UNRELATED card', async () => {
  // The live refusal: blocked from filing #884, a production-outage report,
  // because a window on #881 was open. Different card, different work.
  const r = decideCoveredAction({
    actor: 'ada', workObjects: [OPEN_WINDOW], now: NOW, card: 884,
  });
  assert.equal(r.allow, true,
    'a window on #881 must not block work on #884 — the mutex is on the WORK');
});

test('#886 an action with NO card is allowed — the gate cannot claim what it cannot see', async () => {
  // ⚠️ Fail-open, deliberately, and it matches the module's own posture:
  // "a rail whose failure mode is 'the board stops accepting cards' is worse
  // than the problem it solves." If a covered action carries no card, the gate
  // has no basis to say it is the declared work, and guessing would re-create
  // the whole-seat mutex through the back door.
  const r = decideCoveredAction({
    actor: 'ada', workObjects: [OPEN_WINDOW], now: NOW,
  });
  assert.equal(r.allow, true, 'no card on the action ⇒ no basis to refuse');
});

test('#886 another seat\'s open window never blocks this seat', async () => {
  // Pre-existing behaviour, pinned so the narrowing does not disturb it.
  const r = decideCoveredAction({
    actor: 'grace', workObjects: [OPEN_WINDOW], now: NOW, card: 881,
  });
  assert.equal(r.allow, true, 'grace is not a bidder on this window');
});

test('#886 the human path stays exempt', async () => {
  const r = decideCoveredAction({ workObjects: [OPEN_WINDOW], now: NOW, card: 881 });
  assert.equal(r.allow, true, 'an absent actor is the owner in his own board');
});

test('#886 the refusal no longer names a remedy that does not exist', async () => {
  // ⛔ The message said "Wait for the grant, or withdraw the bid." There is no
  // withdraw: the tools are declare · bid · nobid · contest · grant · list.
  // A refusal teaching a caller to do something the surface cannot do is the
  // #837 class — and it cost a real seat a self-grant that recorded a
  // settlement which never happened.
  const r = decideCoveredAction({
    actor: 'ada', workObjects: [OPEN_WINDOW], now: NOW, card: 881,
  });
  assert.equal(r.allow, false);
  assert.ok(!/withdraw/i.test(r.reason) || /work_withdraw/.test(r.reason),
    `the refusal offers "withdraw" with no such tool: ${r.reason}`);
  assert.match(r.reason, /881/, 'and it should name the card it is protecting');
});

/**
 * ⛔⛔ THE HOLE THIS FIX OPENS, pinned rather than left silent.
 *
 * The narrowing above is correct and it has a consequence I did not see until
 * after the suite went green: `ENFORCED_OPS` is `['create']`, and the only
 * wrapped tool is `card_create` — which BRINGS a card into existence and
 * therefore never targets one. A gate scoped to the declared card can never
 * match a create.
 *
 * ⇒ Scoped + create-only = a gate that refuses NOTHING in production.
 *
 * ⚠️ Both halves of that are true and neither is the bug:
 *   unscoped  → 3 refusals in one afternoon, 0 of them the measured failure
 *   scoped    → 0 refusals, because the enforced op cannot carry a card
 * The real defect is UPSTREAM of both: `create` is the wrong op to enforce.
 * The declared work happens on a card that already exists, so the covered
 * actions that ARE the declared work are update · move · claim.
 *
 * ⭐ This test exists so the inertness is an ASSERTION with a card number on
 * it instead of a property nobody wrote down. If someone wraps a
 * card-targeting op, this test fails and points at the follow-up.
 */
test('#886 RESIDUAL — with create as the only enforced op, the scoped gate is INERT', async () => {
  const { ENFORCED_OPS } = await import('../core/work-gate.mjs');
  assert.deepEqual([...ENFORCED_OPS], ['create'],
    'if this changed, the residual below may no longer hold — re-read it');

  // A create carries no target card. This is the production call shape.
  const r = decideCoveredAction({ actor: 'ada', workObjects: [OPEN_WINDOW], now: NOW });
  assert.equal(r.allow, true,
    'PINNED, NOT ENDORSED: the gate cannot refuse the one op it wraps. '
    + 'Fixing this means enforcing a card-targeting op, which is a separate card.');
});
