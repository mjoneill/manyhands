/**
 * core/work-gate.mjs — #755 slice 2b: the enforced adapter's DECISION.
 *
 * The pure half of the rail. It takes an actor, the work objects in play, and
 * a `now`, and answers one question: may this seat take a covered action?
 *
 * ── WHAT IT REFUSES, and why it is exactly this narrow ──────────────────────
 * Signal 2 (v2): "any covered action by a seat HOLDING AN OPEN WORK OBJECT,
 * taken without a recorded grant." So:
 *
 *   ⇒ a seat whose own bid window is still open may not take a covered action.
 *
 * ⛔ It does NOT require a work object to exist before acting. A gate that
 *    refused every seat who never bid would break the board the instant it
 *    armed — and it would assert far more than the evidence supports. The
 *    measured failure was the protocol's own author taking a covered action
 *    INSIDE her own open window, thirty seconds after publishing the rule,
 *    with two seats watching. That is the thing this refuses, and no more.
 *
 * ── TWO STRUCTURAL PROPERTIES, both deliberately not runtime checks ─────────
 *
 * 1. THE HUMAN PATH IS EXEMPT BY CONSTRUCTION.
 *    The board UI posts to server.js:3141. Only agents reach the board through
 *    mcp-server.mjs. This module is imported by the MCP server ONLY, so a
 *    browser request cannot arrive here. There is no `if (actor === null)` to
 *    invert, because the owner's requests are not in this code path at all.
 *    (`decideCoveredAction` still allows an absent actor as a belt; the braces
 *    are the test asserting server.js never references this file.)
 *
 * 2. FLAG-OFF MEANS NOT INSTALLED.
 *    `isGateArmed()` is read ONCE, at tool-registration time, to choose which
 *    handler is registered — never inside a request. `if (!flagOn) return
 *    next()` would put the gate permanently in the path and make one inverted
 *    boolean the entire safety story, while the suite stayed green because
 *    tests run with the flag ON.
 *
 *    ⚠️ It matters more than it looks: neither prod service has restarted
 *    since Aug 7/8, so an UNRELATED restart is when this code first loads in
 *    production. With absence that restart is a non-event. With a branch it is
 *    a live arming nobody scheduled and nobody witnessed — the flip happening
 *    without a flipper, which the card names as a precondition.
 */

import { stateAt, STATES } from './work-auction.mjs';

/** The one environment variable that can arm this. Named here so the test can assert on it. */
export const GATE_ENV = 'SCRUM_WORK_GATE';

/**
 * Is the rail armed? Read ONCE at registration, never per request.
 *
 * Exact string match on purpose. A config read that defaults truthy — `!== 'off'`,
 * or a bare `Boolean(env)` — is precisely how a rail arms itself at 3am because
 * someone exported an empty variable.
 */
export function isGateArmed(env = process.env) {
  return env[GATE_ENV] === 'on';
}

/**
 * May `actor` take a covered action right now?
 *
 * @param {object}   arg
 * @param {?string}  arg.actor        seat key, or null/absent for the human path
 * @param {object[]} arg.workObjects  work objects in play (any state)
 * @param {string}   arg.now          ISO timestamp. Required, never defaulted.
 * @returns {{allow: boolean, reason?: string, workObjectId?: string}}
 */
export function decideCoveredAction({ actor, workObjects = [], now }) {
  if (!now) throw new Error('decideCoveredAction: now is required — this gate never reads the wall clock');

  // The human path. Structurally unreachable (see the header); allowed anyway,
  // because a gate whose failure mode is "refuses the owner in his own board"
  // is worse than one that occasionally under-refuses an agent.
  if (!actor) return { allow: true };

  for (const wo of workObjects) {
    const s = stateAt(wo, now);

    // Not the actor's window ⇒ not the actor's problem. The window is a mutex
    // on the WORK, not on a seat's whole existence.
    const involved = s.bidders.includes(actor);
    if (!involved) continue;

    if (s.state === STATES.OPEN || s.state === STATES.BIDDING) {
      return {
        allow: false,
        workObjectId: wo.id,
        reason:
          `${actor} holds an open work object (${wo.id}) whose window closes at ${wo.replyBy}. ` +
          `Wait for the grant, or withdraw the bid.`,
      };
    }

    if (s.state === STATES.ARBITRATION_DUE) {
      return {
        allow: false,
        workObjectId: wo.id,
        reason:
          `${actor}'s work object (${wo.id}) closed contested and awaits arbitration. ` +
          `A recorded grant is required before acting.`,
      };
    }
  }

  return { allow: true };
}
