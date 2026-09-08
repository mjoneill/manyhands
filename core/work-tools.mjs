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

import { declare, bid, nobid, contest, grant, withdraw, stateAt, settle } from './work-auction.mjs';
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
 *
 * ⭐ #1284 — THE ANCHOR IS REQUIRED; THE CARD IS ONE OF TWO WAYS TO BE ONE.
 *
 * This layer used to demand an integer `card`, and that requirement was NOT
 * the state machine's: `declare()` has defaulted `card` to null since #755
 * slice 2e, with a comment saying in its own words that a bid may name a
 * source message instead when no card exists yet. The store round-trips both
 * fields; the gate skips a window with no card. Only this line and the MCP
 * inputSchema forbade what every layer beneath them already modelled.
 *
 * ⇒ And the forbidden case is the ONE #1284 is about. Every collision on that
 *   card began with an ask broadcast to the room, which has no card when it
 *   arrives — so the rail could not address the population it was built for.
 *
 * ⛔ An object with NEITHER anchor is still refused. A work object carries no
 * title and no description on purpose (that is what keeps PII structurally out
 * of this log), so the pointer is the only thing it says about what it is for.
 * With no pointer it says nothing at all, and could never be recognised by the
 * seat it exists to warn.
 */
export function workDeclare(fields) {
  only(fields, ['dir', 'id', 'by', 'card', 'required', 'replyByMinutes', 'sourceMessageId', 'now'], 'workDeclare');
  const { dir, id, by, card, required, replyByMinutes, sourceMessageId = null, now } = fields;
  requireNow(now, 'workDeclare');
  if (!Number.isFinite(replyByMinutes) || replyByMinutes <= 0) {
    throw new Error('workDeclare: replyByMinutes is required and must be a positive number — a bid without a deadline is not a window');
  }
  // Presence, then shape. An empty string is not an anchor: a guard that only
  // tested for a key would persist an object pointing at nothing, and it would
  // read back as a real anchor in every listing.
  const hasCard = card !== undefined && card !== null;
  const hasSource = sourceMessageId !== undefined && sourceMessageId !== null && sourceMessageId !== '';
  // ⛔⛔ THE SHAPE IS THE PII GUARD, AND IT DOES NOT LIVE ONLY IN THE SCHEMA.
  //
  // This surface has no free-text field by design: that is what makes "no PII
  // reaches the work-object log" structural rather than a habit. A bare string
  // anchor would be a "just a short note" field with a respectable name.
  //
  // The MCP schema pins the same pattern, but a guard that exists at exactly
  // one boundary is a property of WHERE IT SITS, not a rule — and this module
  // has other callers. So the shape is checked here too, where the value is
  // about to be persisted.
  if (hasSource && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(sourceMessageId))) {
    throw new Error('workDeclare: sourceMessageId must be a commons message id (uuid) — this surface carries no free text');
  }
  if (!hasCard && !hasSource) {
    throw new Error('workDeclare: card or sourceMessageId is required — a work object is a POINTER, '
      + 'and one that names neither a card nor the message it answers cannot be recognised by anyone');
  }
  if (hasCard && !Number.isInteger(card)) throw new Error('workDeclare: card must be an integer shortId');

  const replyBy = new Date(new Date(now).getTime() + replyByMinutes * 60_000).toISOString();
  const wo = declare({ id, by, at: now, replyBy, required, sourceMessageId, card });
  return persistAndDerive(dir, wo, now);
}

/**
 * ⭐⭐ #797 — THE WRITE BOUNDARY. EVERY writer verb goes through here.
 *
 * A window that closed to a deterministic grant becomes a RECORDED fact before
 * the caller's action is validated, so the auction's own guard refuses a late
 * answer instead of letting it rewrite a settled outcome.
 *
 * ⛔ workGrant BYPASSED THIS in 34af4fa. The design said "on every writer verb"
 * and the implementation wired only bid/nobid/contest, so a post-timeout human
 * grant replaced the protocol's closure provenance (grantedBy: timeout became
 * grantedBy: <person>) instead of being refused. Caught in review. The fix is
 * this function existing at all — a boundary that one caller can skip is a
 * convention, not a boundary.
 *
 * ⚠️ THE REJECTED COMMAND STILL SETTLES. If a caller's action throws and the
 * settlement dies with it, the grant stays derived through exactly the traffic
 * that proves the window is closed.
 */
function settleThenApply(dir, id, what, now, apply) {
  const loaded = load(dir, id, what);
  const settled = settle(loaded, now);
  try {
    return persistAndDerive(dir, apply(settled), now);
  } catch (e) {
    if (settled !== loaded) appendTransitions(dir, settled);
    throw e;
  }
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
  return settleThenApply(dir, id, what, now, (wo) => fn(wo, { by, at: now }));
};

export const workBid = answer(bid, 'workBid', ['dir', 'id', 'by', 'now']);
export const workNobid = answer(nobid, 'workNobid', ['dir', 'id', 'by', 'now']);
export const workContest = answer(contest, 'workContest', ['dir', 'id', 'by', 'now']);

/**
 * #886 — the declarer closes her own window.
 *
 * ⛔ IT SHARES `answer()` WITH BID/NOBID/CONTEST ON PURPOSE, because it shares
 * their critical section: load → append with no yield between. A withdraw
 * written as its own function would have been the second writer that comment
 * warns about, and the loss would have been silent.
 *
 * ⚠️ Not an answer in the auction sense — `withdraw()` guards on
 * `wo.declaredBy`, not on membership — but identical in SHAPE, and shape is
 * what `answer` abstracts.
 */
export const workWithdraw = answer(withdraw, 'workWithdraw', ['dir', 'id', 'by', 'now']);

export function workGrant(fields) {
  only(fields, ['dir', 'id', 'by', 'to', 'now'], 'workGrant');
  const { dir, id, by, to, now } = fields;
  requireNow(now, 'workGrant');
  return settleThenApply(dir, id, 'workGrant', now, (wo) => grant(wo, { by, to, at: now }));
}

/**
 * What is in play, and what has settled — both DERIVED at `now`.
 *
 * A seat about to act reads `open` to see whether it holds a window. A reader
 * asking what happened reads `settled`. Neither is stored; both are computed
 * from the log, which is why a restart changes nothing.
 *
 * ⭐ #1284 — THE POINTERS TRAVEL WITH THE STATE. This listing used to project
 * `id` and `replyBy` and drop both anchors, so a second seat could read that
 * SOMEONE held a window and not what it was about. For a card-anchored object
 * that was a nuisance you could resolve by hand; for an ask-anchored one it is
 * fatal, because the message id is the ONLY handle the ask has — the whole
 * point is that a seat reading the same request recognises it here.
 *
 * ⚠️ `card` and `sourceMessageId` are pointers, in the same class as `id` and
 * `replyBy`, and are taken off the OBJECT. They are deliberately not added to
 * `stateAt`, which answers what the auction says is true and owns no pointers.
 */
export function workList(fields) {
  only(fields, ['dir', 'now'], 'workList');
  const { dir, now } = fields;
  requireNow(now, 'workList');
  const view = (wo) => ({
    id: wo.id,
    card: wo.card ?? null,
    sourceMessageId: wo.sourceMessageId ?? null,
    replyBy: wo.replyBy,
    ...stateAt(wo, now),
  });
  const open = openWorkObjectsAt(dir, now).map(view);
  const openIds = new Set(open.map((o) => o.id));
  const settled = readWorkObjects(dir).filter((wo) => !openIds.has(wo.id)).map(view);
  return { open, settled };
}
