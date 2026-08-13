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
    card: wo.card ?? null,
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
      // #797 — AUTOMATIC settlement, deliberately a distinct shape from `grant`.
      // A human arbitration and a protocol closure must never be the same
      // record: one is an endorsement, the other is arithmetic. `by` carries the
      // closure REASON here so the derived view keeps today's semantics
      // (grantedBy: timeout | early-close), while the stored transition keeps
      // actor, reason and caveat in separate fields.
      case 'settlement':
        granted = {
          to: t.to,
          by: t.closureReason,
          at: t.at,
          // #795 — the caveat travels WITH the grant. Read off the FROZEN
          // transition, never recomputed from current `pending`: a later answer
          // must not be able to change what the window closed despite.
          settlement: {
            closureReason: t.closureReason,
            pendingAtClosure: t.pendingAtClosure,
            effectiveAt: t.effectiveAt,
          },
        };
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
/**
 * #797 — every timestamp comparison in this module is a STRING comparison.
 *
 * `recorded()` filters `t.at <= asOf`. That is correct and fast for ISO-8601 UTC
 * instants, which sort lexicographically in chronological order. It is silently
 * WRONG for anything else:
 *
 *   a number      string <= number coerces to NaN ⇒ FALSE for every transition
 *                 ⇒ an object with a full history reports OPEN, no bidders,
 *                   nobody having answered. A confident, fully-formed lie.
 *   a Date        stringifies to "Wed Aug 12 2026 …" — sorts nowhere near ISO
 *   a local ISO   no Z or offset ⇒ compares against UTC instants as text
 *
 * ⚠️ The previous guard was `if (!now)`. It tested for PRESENCE, and every one
 * of the failures above is a TYPE. A number is truthy, so it passed.
 *
 * MEASURED 2026-08-12: a probe built on a numeric `now` produced a refutation of
 * a correct source reading, sourced to a run in which no transition was visible
 * at all. The only tell was an impossible value in a field nobody was examining.
 */
export function assertInstant(now, fnName) {
  if (!now) throw new Error(`${fnName}: now is required — this module never reads the wall clock`);

  // ⭐ Compare against the CANONICAL FORM rather than enumerating valid shapes.
  // A regex here admitted a family when the requirement was one representation:
  // it allowed an optional fraction and UTC offsets, both of which are valid
  // ISO-8601 and neither of which is lexicographically comparable to the rest.
  //
  //   '…18:00:00.100Z' < '…18:00:00Z'  lexicographically  TRUE   ('.' < 'Z')
  //   '…18:00:00.100Z' < '…18:00:00Z'  chronologically    FALSE
  //   ⇒ a LATER instant sorting as EARLIER, which is the empty-world bug
  //     wearing a subtler costume: not "no transitions" but "the wrong ones".
  //
  // This one check subsumes the shape, the offsets, the variable fraction, AND
  // invalid calendar dates — '2026-02-30T…' normalises to March and so differs
  // from its own canonical form. Production already writes toISOString().
  let canonical = false;
  try {
    canonical = typeof now === 'string' && new Date(now).toISOString() === now;
  } catch {
    canonical = false; // an unparseable string throws inside toISOString
  }

  if (!canonical) {
    throw new Error(
      `${fnName}: now must be a canonical UTC instant as produced by toISOString() `
      + `(e.g. 2026-08-12T18:00:00.000Z), received ${typeof now} `
      + `${JSON.stringify(String(now)).slice(0, 40)} — comparisons here are lexicographic, `
      + 'and any other representation silently reads the wrong set of transitions',
    );
  }
}

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
  only(fields, ['id', 'by', 'at', 'replyBy', 'required', 'sourceMessageId', 'card'], 'declare');
  const { id, by = null, at, replyBy, required, sourceMessageId = null, card = null } = fields;
  if (!id) throw new Error('declare: id is required');
  if (!at) throw new Error('declare: at is required');
  if (!replyBy) throw new Error('declare: replyBy is required');
  if (!Array.isArray(required)) throw new Error('declare: required must be an array of seats');

  const wo = {
    id,
    sourceMessageId,
    // #755 slice 2e — the POINTER, and the only thing a work object says about
    // WHAT it is for. No title, no description: the prose lives on the card,
    // which is already a guarded surface. Optional, because a bid may name a
    // source message instead when no card exists yet.
    card,
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
/**
 * #797 — turn a DERIVED grant into a RECORDED one.
 *
 * The defect: the auto-grant path returns a grant and appends nothing, while
 * the writer guard consults recorded transitions only. So a window that reads
 * `granted` still accepts a late bid, and a second bidder collapses the
 * single-bidder branch that was producing the grant — the object leaves the
 * granted family with nothing withdrawn, contested or released.
 *
 * ⭐ Recording the grant closes that BY CONSTRUCTION rather than by a new guard:
 * recordedPhase() then returns GRANTED and assertWindowLive() refuses the late
 * answer with no clock added anywhere.
 *
 * ⚠️ CALL THIS AT A WRITE BOUNDARY, BEFORE VALIDATING THE CALLER'S ACTION —
 * including when that action is about to be REJECTED. If validation throws
 * first the grant stays derived and the defect survives, so a rejected command
 * legitimately settles as a side effect.
 *
 * ⛔ stateAt() must NEVER call this. A pure derivation that mutates its inputs
 * is a worse defect than the one being fixed.
 *
 * ⭐⭐ WHY THE CAVEAT IS ON THE FACT. Three live objects are `timeout` grants
 * with a required seat still pending, and the room has questioned exactly that
 * shape — one was declined by the seat it was granted to. A derived value can be
 * re-read with today's understanding; a transition cannot. So the settlement
 * freezes `pendingAtClosure` onto itself, making the immutable statement "the
 * protocol granted despite these seats remaining pending" rather than "the room
 * consented."
 */
export function settle(wo, now) {
  assertInstant(now, 'settle');
  // Idempotence keys on the SETTLEMENT itself, not on `granted`. A recorded
  // grant is no longer proof the window was decided legitimately — see below.
  if (wo.transitions.some((t) => t.type === 'settlement')) return wo;

  const r = recorded(wo, now);

  // ⛔ NO EARLY RETURN ON running/terminal. A late grant whose grantee then began
  // work kept false provenance forever, because settle() bailed out here before
  // deriving closure at all. Starting work is DOWNSTREAM of the grant — it says
  // nothing about whether the grant was the protocol's decision.
  //
  // ⭐ Settlement corrects WHO GRANTED IT, never what happened to the work
  // afterwards: the settlement is appended after the lifecycle transitions, so
  // `terminal`/`running` still win the state and only `grantedBy` changes.

  // ⛔⛔ A RECORDED GRANT DOES NOT MEAN THE WINDOW WAS DECIDED BY ONE.
  //
  // grant() guards on recordedPhase, which reads BIDDING while a grant is only
  // DERIVED — so before this fix a human could grant a window the protocol had
  // already closed by timeout, and settle() returning early on `r.granted` left
  // grantedBy = that person permanently. Same post-closure pollution class as
  // the workGrant bypass, arriving through history rather than a live call.
  //
  // ⭐ The discriminator is WHEN the grant was recorded, not that it exists:
  //   at or before closure  ⇒ it decided the window. Legitimate. Leave it.
  //   after closure         ⇒ the protocol had already decided. Settlement
  //                           supersedes it — appended AFTER, so the log keeps
  //                           both what someone did and what actually happened.

  // ⛔⛔ DERIVE AS OF CLOSURE, NEVER AS OF `now`.
  //
  // Every object that predates settlement may already carry a LATE answer,
  // because accepting one is the defect this function exists to stop. For such
  // an object stateAt(now) reports "every required seat answered ⇒ early-close,
  // pending []" — and the window actually shut at replyBy as a timeout with that
  // seat pending. Settling from `now` would write the late answer into the
  // historical fact and erase the caveat.
  //
  // ⚠️ A settlement is the one derivation that cannot be re-read later with
  // better understanding. Getting the moment wrong is not a stale view; it is a
  // permanent false record.
  const closure = closureOf(wo);
  if (now < closure.at) return wo; // the window has not shut yet
  if (r.granted && r.granted.at <= closure.at) return wo; // a grant that predates closure decided it

  const s = stateAt(wo, closure.at);
  if (s.state !== STATES.GRANTED) return wo; // EXPIRED, or genuinely contested before it closed

  const closureReason = closure.reason;
  const effectiveAt = closure.at;

  return append(wo, {
    type: 'settlement',
    to: s.grantedTo,
    // The protocol is not a person. An automatic settlement carries no `by`,
    // so it can never be mistaken for a human grant in the log.
    actor: 'protocol',
    closureReason,
    // Frozen at CLOSURE, not at materialisation — a later answer must not be
    // able to rewrite who was silent when the window shut.
    pendingAtClosure: stateAt(wo, effectiveAt).pending,
    effectiveAt,
    // `at` is the log-ordering timestamp and IS the materialisation time: when
    // the first later touch wrote this down. Kept as `at` rather than a separate
    // `materializedAt` so every transition orders on the same field.
    at: now,
  });
}

/**
 * WHEN the window actually shut, and why — computed from answers that arrived
 * BEFORE the deadline only.
 *
 * ⭐ The `t.at <= wo.replyBy` filter is the whole fix. An answer accepted after
 * the deadline cannot retroactively convert a timeout into an early-close, and
 * cannot remove its author from the pending set as of closure.
 */
/**
 * ⭐⭐ #797 — THE ONE DEFINITION OF THE REQUIRED SET.
 *
 * `required` is described as a set and stored as an unconstrained array:
 * declare() accepts duplicates, and nothing between the MCP schema and the
 * store dedupes. stateAt() filtered it (so ['bo','bo'] with bo answered gave
 * pending []) while closureOf() compared unique answerers against the raw
 * length — two derivations of one fact, disagreeing.
 *
 * ⛔ Both now consume this. Not an agreement TEST but a shared CONSTRUCTION:
 * a check proves they agree today, this makes disagreement unrepresentable.
 *
 * ⚠️ What is deliberately NOT unified is the as-of question. stateAt() asks
 * "is this window closed at `now`"; closureOf() asks "when did it actually
 * close, ignoring answers accepted after the deadline". On a polluted history
 * those give different answers, and that difference is the fix — not a drift.
 */
const requiredSet = (wo) => [...new Set(wo.required)];

function closureOf(wo) {
  // ⛔ `required` is DESCRIBED as a set and STORED as an unconstrained array.
  // declare() accepts duplicates, and the MCP schema's min(1) blocks an empty
  // array there but nothing dedupes anywhere. stateAt() filters, so it treats
  // ['bo','bo'] with bo answered as satisfied — and this function compared one
  // unique answerer against a raw length of two and called it a timeout.
  //
  // ⚠️ Two derivations of the same fact disagreeing is the defect. Mirror
  // stateAt() here rather than tightening declare(): tightening the writer
  // leaves the direct API and legacy bytes unfixed, and foldLines() does not
  // re-check on read.
  const required = requiredSet(wo);

  // Nobody to wait for ⇒ the window was shut the moment it opened. Without this
  // the maximum of an empty set of answer times is `undefined`, which settle()
  // then handed to stateAt() — a window stateAt() reads perfectly well made
  // settlement CRASH.
  if (required.length === 0) {
    return { at: wo.transitions[0]?.at ?? wo.replyBy, reason: 'early-close' };
  }

  const firstAnswerAt = new Map();
  for (const t of wo.transitions) {
    if (!['bid', 'nobid', 'contest'].includes(t.type)) continue;
    if (!required.includes(t.by)) continue;
    if (t.at > wo.replyBy) continue; // ⇐ a late answer does not close anything
    // ⭐ MIN, not first-encountered. append() enforces monotonicity so array
    // order IS chronological order for anything this system wrote — but
    // foldLines() does not re-check ordering on READ, so a hand-written or
    // legacy log could arrive out of order. Taking the minimum makes closure
    // deterministic on those bytes instead of array-order dependent.
    const prev = firstAnswerAt.get(t.by);
    if (prev === undefined || t.at < prev) firstAnswerAt.set(t.by, t.at);
  }
  if (firstAnswerAt.size === required.length) {
    const last = [...firstAnswerAt.values()].sort().pop();
    return { at: last, reason: 'early-close' };
  }
  return { at: wo.replyBy, reason: 'timeout' };
}

export function stateAt(wo, now) {
  assertInstant(now, 'stateAt');
  const { bidders, contesters, answered, granted, running, terminal } = recorded(wo, now);
  const pending = requiredSet(wo).filter((seat) => !answered.includes(seat));

  const view = (state, extra = {}) => ({
    state,
    bidders: [...bidders],
    contesters: [...contesters],
    pending: [...pending],
    grantedTo: null,
    grantedBy: null,
    // #795 — null means NO PROTOCOL SETTLEMENT IS RECORDED, which covers a human
    // grant AND a derived-but-untouched grant. An empty `pendingAtClosure`
    // inside a settlement object means the protocol closed it with nobody
    // pending — a different and stronger claim. Present on every view so a
    // reader never has to distinguish absent from null.
    settlement: null,
    ...extra,
  });

  if (terminal) return view(terminal, granted ? { grantedTo: granted.to, grantedBy: granted.by, settlement: granted.settlement ?? null } : {});
  if (running) return view(STATES.RUNNING, { grantedTo: granted.to, grantedBy: granted.by, settlement: granted.settlement ?? null });
  if (granted) return view(STATES.GRANTED, { grantedTo: granted.to, grantedBy: granted.by, settlement: granted.settlement ?? null });

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
