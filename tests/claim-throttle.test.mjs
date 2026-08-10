/**
 * #755 BRANCH E — the claim throttle. the board owner's design, 2026-08-10.
 *
 * ── WHY THIS EXISTS WHEN A, B AND C DID NOT SURVIVE ─────────────────────────
 * Measured against three real collisions and a 21-incident corpus:
 *
 *   A enforcement   needs a declaration to exist  ⇒ 3 of 3 had none
 *   B visibility    needs a declaration to exist  ⇒ empty list, 3 of 3
 *   C action-as-declaration  needs both attempts to share a KEY ⇒ 0 of 3
 *   E throttle      needs NEITHER. Fires on TIME and the ATTEMPT alone.
 *
 * ⭐ It never has to decide whether two pieces of work are "the same" — the
 * question that killed C and that the S3 detector produces false positives on.
 * And it fires on the attempt rather than on remembering, which is the property
 * every other variant lacked: the moment of action does not pause to consult a
 * rule, so the rule has to be in the path.
 *
 * ⇒ It does not PREVENT the duplicate. It converts an invisible collision into
 *   a visible one: the second seat is delayed until the first seat's card
 *   exists, so the retry happens in a world where there is something to see.
 *
 * ── THE HUMAN PATH IS EXEMPT BY CONSTRUCTION, AND THAT IS NOT DECORATION ────
 * ⚠️ 375 of 500 cards carry `createdBy: null` — the browser path, the owner.
 * "Same seat" requires knowing the seat, and null is not a seat, so two
 * consecutive human filings are indistinguishable from two strangers racing.
 * Without an explicit exemption the owner is throttled in his own board, with a
 * message about claims and bids. Same class as the 2c precondition, arriving in
 * a mechanism designed after it.
 *
 * ── FAIL OPEN, DELIBERATELY ─────────────────────────────────────────────────
 * Throttling requires establishing that two DIFFERENT named seats acted inside
 * the window. Anything unknown — no previous action, an unknown previous actor,
 * a missing clock reading — allows. A rail whose failure mode is "the board
 * stops accepting cards" is worse than the problem it solves, and the published
 * cost table (5 delays across the board's history at 60s) was computed under
 * exactly this rule.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideThrottle, COOLDOWN_MS } from '../core/claim-throttle.mjs';

const T = (s) => new Date(Date.parse('2026-08-10T12:00:00.000Z') + s * 1000).toISOString();
const prev = (actor, s) => ({ actor, at: T(s) });

// ── the core behaviour ──────────────────────────────────────────────────────

test('#755-E ⭐⭐ a DIFFERENT seat inside the cooldown is REFUSED', () => {
  const d = decideThrottle({ actor: 'bo', previous: prev('ada', 0), now: T(4) });
  assert.equal(d.allow, false);
  assert.equal(d.retryAfterSeconds, 56);
});

test('#755-E the refusal carries the ASK, not just a denial', () => {
  // The question is the visibility layer: it arrives where the seat already is,
  // instead of on a surface someone has to go and read. It is the part of
  // the owner's design with no code in it and it is the point.
  const d = decideThrottle({ actor: 'bo', previous: prev('ada', 0), now: T(4) });
  assert.match(d.message, /cooldown/i);
  assert.match(d.message, /already been (claimed|acknowledged)|already/i);
  assert.match(d.message, /56/, 'the message must say how long is left, not just that time remains');
});

test('#755-E outside the cooldown it ALLOWS', () => {
  assert.equal(decideThrottle({ actor: 'bo', previous: prev('ada', 0), now: T(61) }).allow, true);
});

test('#755-E at exactly the boundary it ALLOWS — the window is closed, not half-open', () => {
  assert.equal(decideThrottle({ actor: 'bo', previous: prev('ada', 0), now: T(60) }).allow, true);
});

// ── ⛔ THE EXEMPTIONS, each of which is a measured requirement ───────────────

test('#755-E ⛔ THE HUMAN PATH IS NEVER THROTTLED — actor null always allows', () => {
  // 375 of 500 cards are createdBy:null. Without this the owner is refused in
  // his own board by a rail built to protect his agents from each other.
  const d = decideThrottle({ actor: null, previous: prev('ada', 0), now: T(1) });
  assert.equal(d.allow, true);
  assert.equal(decideThrottle({ actor: undefined, previous: prev('ada', 0), now: T(1) }).allow, true);
});

test('#755-E ⛔ THE SAME SEAT IS NEVER THROTTLED — one seat cannot race itself', () => {
  // 8 of 13 in-window pairs on the measurable subset are one seat filing a
  // batch. Bulk filing is not a collision and delaying it buys nothing.
  assert.equal(decideThrottle({ actor: 'ada', previous: prev('ada', 0), now: T(1) }).allow, true);
});

test('#755-E ⛔ an UNKNOWN previous actor allows — the throttle fails OPEN', () => {
  // It cannot be established that a different seat acted, so it is not
  // established that this is a race. `createdBy` postdates #631, so most of the
  // board's history has no author; refusing on unknown would throttle the past.
  assert.equal(decideThrottle({ actor: 'bo', previous: { actor: null, at: T(0) }, now: T(1) }).allow, true);
});

test('#755-E no previous action at all allows', () => {
  assert.equal(decideThrottle({ actor: 'bo', previous: null, now: T(1) }).allow, true);
});

// ── the clock is never read here ────────────────────────────────────────────

test('#755-E ⛔ it REFUSES without a clock, like every other module in this design', () => {
  assert.throws(() => decideThrottle({ actor: 'bo', previous: prev('ada', 0) }), /now is required/);
});

test('#755-E the cooldown is a parameter, and its default is the MEASURED one', () => {
  // 60s caught 16/21 incidents for 5 delays across the board's whole history —
  // the efficiency peak, on a table whose author argued against this branch.
  assert.equal(COOLDOWN_MS, 60_000);
  const d = decideThrottle({ actor: 'bo', previous: prev('ada', 0), now: T(4), cooldownMs: 10_000 });
  assert.equal(d.retryAfterSeconds, 6);
});

// ── ⭐ the property the whole branch rests on ───────────────────────────────

test('#755-E ⭐⭐ IT NEEDS NO DECLARATION — the case that killed A, B and C', () => {
  // Neither seat declared anything. There is no work object, no window, no
  // shared key, no notice board. The throttle still fires, because it reads
  // only the clock and the attempt.
  const d = decideThrottle({ actor: 'bo', previous: prev('ada', 0), now: T(3) });
  assert.equal(d.allow, false);
  assert.equal(d.reason, '#755 claim cooldown');
});

test('#755-E ⚠️ IT DOES NOT CLAIM THE TWO ACTIONS ARE THE SAME WORK', () => {
  // Deliberate, and the source of its false positives: the throttle delays a
  // genuinely unrelated second card too. The cost is a delay, never a denial —
  // which is why the false-positive rate is affordable where a refusal's would
  // not be. The retryAfter is what makes that true and it must always be > 0.
  const d = decideThrottle({ actor: 'bo', previous: prev('ada', 59), now: T(59.5) });
  assert.equal(d.allow, false);
  assert.ok(d.retryAfterSeconds >= 1, 'a refusal must always name a finite, positive wait');
});
