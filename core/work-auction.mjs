/**
 * core/work-auction.mjs — #755 slice 1: the bid/grant transition core.
 *
 * A work object is a plain, serializable record: an id, a window deadline, an
 * immutable REQUIRED set, and an append-only transition log. Nothing else. It
 * carries no free text (see the guard below), holds no timers, and knows no
 * transport.
 *
 * ── DESIGN B: DERIVED EXPIRY ────────────────────────────────────────────────
 * Nothing fires at `replyBy`. The window's outcome is a FUNCTION of stored
 * (required, transitions, replyBy) and the `now` handed in by whoever looks.
 *
 * The rejected alternative (A) has something write EXPIRE when the deadline
 * passes. That needs a live timer inside the mcp-server process, and a restart
 * silently drops every pending window — core/channel-scheduler.mjs's in-memory
 * `nextAvailable` map is the local precedent for exactly that. #755's trial
 * measures already name "restart behaviour"; B survives it by construction,
 * which is why `stateAt` is a pure read and there is no `tick()` in this file.
 *
 * ⚠️ `now` is a REQUIRED argument, never defaulted to Date.now(). That is what
 *    keeps B from decaying back into A the first time someone finds the
 *    parameter inconvenient.
 *
 * ── WHAT THIS MODULE DELIBERATELY IS NOT ────────────────────────────────────
 * ⛔ It enforces nothing. It is a state machine, not a rail. #755's whole
 *    question is whether a rail fires WITHOUT being remembered, and a module
 *    nobody is obliged to call cannot answer it. The enforced adapter is a
 *    later slice; this file going green is zero evidence toward it.
 */

export const STATES = Object.freeze({
  OPEN: 'open',                       // declared, nobody has bid
  BIDDING: 'bidding',                 // window live, at least one bidder
  GRANTED: 'granted',                 // one actor holds it
  ARBITRATION_DUE: 'arbitration_due', // window closed, >1 bidder OR a contest
  RUNNING: 'running',
  COMPLETE: 'complete',
  RELEASED: 'released',
  EXPIRED: 'expired',                 // window closed with nobody willing
  WITHDRAWN: 'withdrawn',
});

/**
 * ⛔ THE FREE-TEXT GUARD (#523's shape, applied at the earliest possible point).
 *
 * Every writer below validates its argument keys against an explicit allowlist
 * and throws on anything else. There is no object spread anywhere in this file.
 *
 * The point is not tidiness. A work object is a NEW persisted text surface —
 * a new place room content accumulates and a new path out of the room. The
 * scrub-by-default guard lands with the persistence slice; until it exists,
 * the safest description field is the one that does not exist. A permissive
 * writer would let a title or a description ride in ahead of the guard, and
 * "we'll scrub it later" is the thing #523 is the receipt against.
 */
function only(fields, allowed, what) {
  for (const key of Object.keys(fields)) {
    if (!allowed.includes(key)) throw new Error(`${what}: unknown field: ${key}`);
  }
}

function lastAt(wo) {
  return wo.transitions.length ? wo.transitions[wo.transitions.length - 1].at : null;
}

/** Append a transition, refusing one that would make the log lie about order. */
function append(wo, entry) {
  const prev = lastAt(wo);
  if (prev && entry.at < prev) {
    throw new Error(`transition ${entry.type} at ${entry.at} is before the previous transition at ${prev}`);
  }
  return {
    id: wo.id,
    sourceMessageId: wo.sourceMessageId,
    declaredBy: wo.declaredBy,
    replyBy: wo.replyBy,
    required: wo.required,
    transitions: [...wo.transitions, entry],
  };
}

/**
 * Fold the log into the facts that were RECORDED. Deliberately clock-free:
 * writers guard on recorded facts only, so no transition function needs a
 * `now` either. Time enters the system in exactly one place — stateAt().
 */
function recorded(wo, asOf = null) {
  // ⛔ NEVER SEE THE FUTURE.
  //
  // This folded EVERY transition regardless of its `at`, and stateAt used
  // `now` only for the expiry comparison. So at any PAST timestamp a work
  // object reported its FINAL bidder set — and anyone who ever bid appeared to
  // hold an open window before the object existed.
  //
  // ⚠️ The live gate never saw it: it always asks at the real present, where
  // every transition is genuinely <= now. The defect fired ONLY on
  // retrospective queries — which is exactly and only what the review
  // instrument does. A bug that cannot occur in production and occurs every
  // time you MEASURE production is the worst kind to have on a card about
  // measurement, and it produced this sprint's first non-zero signal-2
  // numerator: 2/64, both false, both twenty seconds before the window opened.
  //
  // `asOf === null` means "everything recorded" and is what the WRITERS use —
  // they guard on recorded facts and have no clock.
  const visible = asOf === null ? wo.transitions : wo.transitions.filter((t) => t.at <= asOf);

  const bidders = [];
  const contesters = [];
  const answered = [];
  let granted = null;
  let running = false;
  let terminal = null; // complete | released | withdrawn

  for (const t of visible) {
    switch (t.type) {
      case 'declare':
        break;
      case 'bid':
        bidders.push(t.by);
        answered.push(t.by);
        break;
      case 'nobid':
        answered.push(t.by);
        break;
      case 'contest':
        contesters.push(t.by);
        answered.push(t.by);
        break;
      case 'grant':
        granted = { to: t.to, by: t.by, at: t.at };
        break;
      case 'start':
        running = true;
        break;
      case 'complete':
        terminal = STATES.COMPLETE;
        break;
      case 'release':
        terminal = STATES.RELEASED;
        break;
      case 'withdraw':
        terminal = STATES.WITHDRAWN;
        break;
      default:
        throw new Error(`unknown transition type: ${t.type}`);
    }
  }
  return { bidders, contesters, answered, granted, running, terminal };
}

/** The coarse phase a WRITER guards on — no clock, so no expiry in here. */
function recordedPhase(wo) {
  const r = recorded(wo);
  if (r.terminal) return r.terminal;
  if (r.running) return STATES.RUNNING;
  if (r.granted) return STATES.GRANTED;
  return r.bidders.length ? STATES.BIDDING : STATES.OPEN;
}

// ── writers ─────────────────────────────────────────────────────────────────

/**
 * Declare a work object. `by` is the claimant; pass null for work posted
 * without one (then it sits OPEN until someone bids).
 *
 * `required` is the set of seats whose answer the window WAITS FOR, fixed here
 * and never edited afterwards. It is stored rather than computed because
 * early-close has to be arithmetic — required minus answered is empty — and not
 * a judgement, made by the seat who wants to start, about who counts as
 * present. That judgement would need a liveness oracle the room does not have
 * (#455 §3), and it is exactly the discretion the rail exists to remove.
 */
export function declare(fields) {
  only(fields, ['id', 'by', 'at', 'replyBy', 'required', 'sourceMessageId'], 'declare');
  const { id, by = null, at, replyBy, required, sourceMessageId = null } = fields;
  if (!id) throw new Error('declare: id is required');
  if (!at) throw new Error('declare: at is required');
  if (!replyBy) throw new Error('declare: replyBy is required');
  if (!Array.isArray(required)) throw new Error('declare: required must be an array of seats');

  const wo = {
    id,
    sourceMessageId,
    declaredBy: by,
    replyBy,
    required: Object.freeze([...required]),
    transitions: [{ type: 'declare', by, at }],
  };
  // A claimant declaring IS a bidder — our inverted Contract Net has the
  // claimant declare and others contest, so the declaration is the first bid.
  return by ? append(wo, { type: 'bid', by, at }) : wo;
}

function assertNotAnswered(wo, who) {
  if (recorded(wo).answered.includes(who)) throw new Error(`${who} has already answered`);
}

function assertWindowLive(wo, verb) {
  const phase = recordedPhase(wo);
  if (phase !== STATES.OPEN && phase !== STATES.BIDDING) {
    throw new Error(`cannot ${verb} from ${phase}`);
  }
}

export function bid(wo, fields) {
  only(fields, ['by', 'at'], 'bid');
  assertWindowLive(wo, 'bid');
  assertNotAnswered(wo, fields.by);
  return append(wo, { type: 'bid', by: fields.by, at: fields.at });
}

/**
 * A REFUSAL, recorded as a token.
 *
 * ⚠️ Silence is not a refusal and this module will never read one out of prose.
 * The room's live receipt: a seat's harness re-emitted "Nothing to add on my
 * side" nine times in 35 minutes, including seven seconds after the post that
 * wondered whether it was a refusal — a string that keeps firing after the
 * question is closed is not an answer to the question. So only a recorded
 * `nobid` counts, and an unanswered seat keeps the window open to its deadline.
 */
export function nobid(wo, fields) {
  only(fields, ['by', 'at'], 'nobid');
  assertWindowLive(wo, 'nobid');
  assertNotAnswered(wo, fields.by);
  return append(wo, { type: 'nobid', by: fields.by, at: fields.at });
}

/**
 * A CONTEST: "this work should not proceed" — recorded, and it BITES.
 *
 * ⚠️ The gap this closes was found by USING the module, not designing it. A
 * live window carried two items; a steward's honest answer was "I don't want
 * to build this, and it should not proceed" — and there was no way to say it.
 * `bid` means you want the work; `nobid` means you don't care. The one shape
 * that is pure dissent had no token, so dissent read as CONSENT and the module
 * would have auto-granted over the only objection on record.
 *
 * ⭐ The semantic in stateAt is what makes this a rail rather than a field:
 * one recorded contest suspends the automatic grant, regardless of bidder
 * count. Without that, contest() would be a token nobody's arithmetic reads —
 * the same defect one layer in.
 *
 * A contest COUNTS AS ANSWERING. It must not both block the grant and hold the
 * window open: that is two penalties for one objection, and it makes dissent
 * expensive at exactly the moment we want it cheap.
 */
export function contest(wo, fields) {
  only(fields, ['by', 'at'], 'contest');
  assertWindowLive(wo, 'contest');
  assertNotAnswered(wo, fields.by);
  return append(wo, { type: 'contest', by: fields.by, at: fields.at });
}

export function grant(wo, fields) {
  only(fields, ['by', 'to', 'at'], 'grant');
  assertWindowLive(wo, 'grant');
  if (!recorded(wo).bidders.includes(fields.to)) {
    throw new Error(`cannot grant to ${fields.to}: they did not bid`);
  }
  return append(wo, { type: 'grant', by: fields.by, to: fields.to, at: fields.at });
}

function assertGrantee(wo, who, verb) {
  const { granted } = recorded(wo);
  if (!granted) throw new Error(`cannot ${verb} from ${recordedPhase(wo)}`);
  if (granted.to !== who) throw new Error(`${who} is not the grantee`);
}

export function start(wo, fields) {
  only(fields, ['by', 'at'], 'start');
  const phase = recordedPhase(wo);
  if (phase !== STATES.GRANTED) throw new Error(`cannot start from ${phase}`);
  assertGrantee(wo, fields.by, 'start');
  return append(wo, { type: 'start', by: fields.by, at: fields.at });
}

export function complete(wo, fields) {
  only(fields, ['by', 'at'], 'complete');
  const phase = recordedPhase(wo);
  if (phase !== STATES.RUNNING && phase !== STATES.GRANTED) {
    throw new Error(`cannot complete from ${phase}`);
  }
  assertGrantee(wo, fields.by, 'complete');
  return append(wo, { type: 'complete', by: fields.by, at: fields.at });
}

/** Grants are releasable — #755's shape. Releasing ends THIS object's life. */
export function release(wo, fields) {
  only(fields, ['by', 'at'], 'release');
  const phase = recordedPhase(wo);
  if (phase !== STATES.RUNNING && phase !== STATES.GRANTED) {
    throw new Error(`cannot release from ${phase}`);
  }
  assertGrantee(wo, fields.by, 'release');
  return append(wo, { type: 'release', by: fields.by, at: fields.at });
}

export function withdraw(wo, fields) {
  only(fields, ['by', 'at'], 'withdraw');
  assertWindowLive(wo, 'withdraw');
  if (wo.declaredBy !== fields.by) throw new Error(`${fields.by} did not declare this work`);
  return append(wo, { type: 'withdraw', by: fields.by, at: fields.at });
}

// ── the single reader ───────────────────────────────────────────────────────

/**
 * Derive the current state. The ONLY place time enters this module.
 *
 * @param {object} wo   a work object (or anything JSON.parse gave back — this
 *                      must work on rehydrated bytes with no live references)
 * @param {string} now  ISO timestamp. Required. Never defaulted.
 */
export function stateAt(wo, now) {
  if (!now) throw new Error('stateAt: now is required — this module never reads the wall clock');
  const { bidders, contesters, answered, granted, running, terminal } = recorded(wo, now);
  const pending = wo.required.filter((seat) => !answered.includes(seat));

  const view = (state, extra = {}) => ({
    state,
    bidders: [...bidders],
    contesters: [...contesters],
    pending: [...pending],
    grantedTo: null,
    grantedBy: null,
    ...extra,
  });

  if (terminal) return view(terminal, granted ? { grantedTo: granted.to, grantedBy: granted.by } : {});
  if (running) return view(STATES.RUNNING, { grantedTo: granted.to, grantedBy: granted.by });
  if (granted) return view(STATES.GRANTED, { grantedTo: granted.to, grantedBy: granted.by });

  // The window. It closes for one of two reasons, and both are arithmetic:
  //   EARLY-CLOSE  every required seat has answered
  //   TIMEOUT      now has reached replyBy
  const closedBy = pending.length === 0 ? 'early-close' : now >= wo.replyBy ? 'timeout' : null;
  if (!closedBy) return view(bidders.length ? STATES.BIDDING : STATES.OPEN);

  // Nobody wanted it. Expiry here is not a failure of the protocol — it is the
  // protocol reporting that the work has no taker.
  if (bidders.length === 0) return view(STATES.EXPIRED);

  // ⭐ ONE RECORDED CONTEST SUSPENDS THE AUTOMATIC GRANT, regardless of bidder
  // count. The anti-deadlock property is that a QUIET room grants — and a room
  // with a recorded objection is not quiet. Without this line contest() would
  // be a token nobody's arithmetic reads, which is the defect it exists to fix.
  if (contesters.length > 0) return view(STATES.ARBITRATION_DUE);

  // The uncontested case, which is #755's anti-deadlock property: a quiet room
  // GRANTS rather than hanging, and nothing had to fire for it to happen.
  if (bidders.length === 1) return view(STATES.GRANTED, { grantedTo: bidders[0], grantedBy: closedBy });

  // ⚠️ CONTESTED, AND UNRESOLVED — a design gap this build surfaced.
  //
  // #755 says "claimant declares → others contest → board randomises". A
  // randomised winner cannot live inside a derived read: two readers would
  // compute DIFFERENT winners from identical stored bytes, and the restart
  // property this whole design rests on would be false.
  //
  // So a contested window that closes needs an explicit, recorded grant — a
  // write, by an actor, auditable. Returning a distinct state (rather than
  // picking) means it cannot be mistaken for a grant, and the choice
  // (deterministic tiebreak from stored data vs arbitration as a transition)
  // stays with the room instead of being settled here by whoever typed first.
  return view(STATES.ARBITRATION_DUE);
}
