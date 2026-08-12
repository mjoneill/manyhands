/**
 * core/work-tools.mjs — #755 slice 2e: the INPUT PATH.
 *
 * The gate is armed, the store is live, and the state machine has been
 * complete since slice 1 — but a bid is still a commons post. The only work
 * object that has ever existed was hand-built with `node -e` during the 2c
 * verification.
 *
 * ⇒ So signal 1 is not "unmeasured pending effort". It is unmeasurable BY
 *   CONSTRUCTION: no bid record can be created, so no bid can be counted. And
 *   signal 2's numerator can only count actions taken while holding an object
 *   nobody has a way to make. Boring days cannot produce evidence when the
 *   instrument has no inlet.
 *
 * ── THIS IS A SHELL, NOT A SECOND STATE MACHINE ─────────────────────────────
 * ⚠️ Every rule — who may answer, what closes a window, when a timeout grants,
 * whether a contest suspends — belongs to core/work-auction.mjs. This file
 * validates arguments, persists, and returns derived state. Nothing else.
 *
 * The room has spent a full day on what happens when two things that should
 * agree can disagree (a denominator vs a gate, a tracked plist vs a live one,
 * a card thread vs a card body). A tool layer that re-implemented one rule
 * would be the same defect with a friendlier surface, so a test asserts the
 * absence of those rules in this source.
 *
 * ── ⚠️ WHAT THIS DOES NOT DO, and it is the honest limit ────────────────────
 * These tools make a bid POSSIBLE. They do not make it REQUIRED.
 *
 *   decideCoveredAction: a seat holding no open work object is ALLOWED.
 *
 * ⇒ A seat who never declares is never gated — not rarely, never, by
 *   construction. So this is a volunteer button, and the rail sits downstream
 *   of the volunteering. #755's own collapse question — "does it fire without
 *   being remembered?" — still answers NO.
 *
 * ⇒ The card's own evidence predicts the outcome: the duplicate check is free,
 *   documented, demonstrated to work, and was reached for TWICE IN 91 DAYS.
 *   A low bid count therefore falsifies the VOLUNTARY FORM, not bid/grant.
 *   That distinction is pre-registered on #755 before this shipped.
 */

import { declare, bid, nobid, contest, grant, stateAt, settle } from './work-auction.mjs';
import { appendTransitions, readWorkObjects, openWorkObjectsAt } from './work-store.mjs';

/** Argument allowlist. There is no free-text field anywhere in this surface. */
function only(fields, allowed, what) {
  for (const key of Object.keys(fields)) {
    if (!allowed.includes(key)) throw new Error(`${what}: unknown field: ${key}`);
  }
}

function requireNow(now, what) {
  if (!now) throw new Error(`${what}: now is required — this layer never reads the wall clock`);
}

/** Load one object by id, or refuse. Never creates on a miss. */
function load(dir, id, what) {
  const found = readWorkObjects(dir).find((o) => o.id === id);
  if (!found) throw new Error(`${what}: no work object "${id}"`);
  return found;
}

/** Persist, then return what the auction says is true at `now`. */
function persistAndDerive(dir, wo, now) {
  appendTransitions(dir, wo);
  return { id: wo.id, replyBy: wo.replyBy, required: [...wo.required], ...stateAt(wo, now) };
}

/**
 * Declare work and open a window.
 *
 * `replyByMinutes` is REQUIRED and there is no default. The first hand-run's
 * own recorded defect was a bid with no deadline — "not a window, an intention
 * that resolves when the bidder decides it has." A caller cannot forget it.
 */
export function workDeclare(fields) {
  only(fields, ['dir', 'id', 'by', 'card', 'required', 'replyByMinutes', 'sourceMessageId', 'now'], 'workDeclare');
  const { dir, id, by, card, required, replyByMinutes, sourceMessageId = null, now } = fields;
  requireNow(now, 'workDeclare');
  if (!Number.isFinite(replyByMinutes) || replyByMinutes <= 0) {
    throw new Error('workDeclare: replyByMinutes is required and must be a positive number — a bid without a deadline is not a window');
  }
  if (!Number.isInteger(card)) throw new Error('workDeclare: card must be an integer shortId');

  const replyBy = new Date(new Date(now).getTime() + replyByMinutes * 60_000).toISOString();
  const wo = declare({ id, by, at: now, replyBy, required, sourceMessageId, card });
  return persistAndDerive(dir, wo, now);
}

const answer = (fn, what, allowed) => (fields) => {
  only(fields, allowed, what);
  const { dir, id, by, now } = fields;
  requireNow(now, what);
  // ⛔⛔ #797 — CRITICAL SECTION. DO NOT INSERT AN `await` BETWEEN THESE LINES.
  //
  // The store's transition identity is POSITIONAL: appendTransitions() computes
  // how much is already persisted from the transition COUNT, and the fold keys
  // on `transitions.length === rec.seq`. So two callers who both loaded before
  // either appended write "the same" next transition as far as the store can
  // tell, and one answer is dropped with success reported to its caller.
  //
  // That cannot happen today ONLY because load() and appendTransitions() are
  // both synchronous and adjacent — a single-threaded event loop runs this pair
  // to completion before another caller starts. The safety is a property of
  // this line's shape, not of the store.
  //
  // ⚠️ Adding a yield point here, or introducing a second writing process,
  // makes the loss live and silent. The durable fix is an atomic store boundary
  // over load → validate → assign identity → append; until then this comment is
  // the only thing standing between a refactor and a lost bid.
  // Property encoded as a `{ todo: true }` test at tests/work-store.test.mjs.
  const loaded = load(dir, id, what);

  // ⭐⭐ #797 — SETTLE BEFORE VALIDATING. A window that closed to a deterministic
  // grant becomes a RECORDED fact here, so the guard below refuses a late answer
  // instead of letting it rewrite a settled outcome.
  const settled = settle(loaded, now);

  try {
    return persistAndDerive(dir, fn(settled, { by, at: now }), now);
  } catch (e) {
    // ⚠️ THE REJECTED COMMAND STILL SETTLES. If the caller's action throws and we
    // let the settlement die with it, the grant stays derived and the defect
    // survives every rejection — which is precisely the traffic that proves the
    // window is closed. So a refused late bid legitimately materialises the grant
    // as a side effect, and the caller still gets its error.
    if (settled !== loaded) appendTransitions(dir, settled);
    throw e;
  }
};

export const workBid = answer(bid, 'workBid', ['dir', 'id', 'by', 'now']);
export const workNobid = answer(nobid, 'workNobid', ['dir', 'id', 'by', 'now']);
export const workContest = answer(contest, 'workContest', ['dir', 'id', 'by', 'now']);

export function workGrant(fields) {
  only(fields, ['dir', 'id', 'by', 'to', 'now'], 'workGrant');
  const { dir, id, by, to, now } = fields;
  requireNow(now, 'workGrant');
  const wo = load(dir, id, 'workGrant');
  return persistAndDerive(dir, grant(wo, { by, to, at: now }), now);
}

/**
 * What is in play, and what has settled — both DERIVED at `now`.
 *
 * A seat about to act reads `open` to see whether it holds a window. A reader
 * asking what happened reads `settled`. Neither is stored; both are computed
 * from the log, which is why a restart changes nothing.
 */
export function workList(fields) {
  only(fields, ['dir', 'now'], 'workList');
  const { dir, now } = fields;
  requireNow(now, 'workList');
  const open = openWorkObjectsAt(dir, now).map((wo) => ({ id: wo.id, replyBy: wo.replyBy, ...stateAt(wo, now) }));
  const openIds = new Set(open.map((o) => o.id));
  const settled = readWorkObjects(dir)
    .filter((wo) => !openIds.has(wo.id))
    .map((wo) => ({ id: wo.id, replyBy: wo.replyBy, ...stateAt(wo, now) }));
  return { open, settled };
}
