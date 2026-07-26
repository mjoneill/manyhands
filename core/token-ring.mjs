/**
 * core/token-ring.mjs — pure ring/lease state machine for the TokenRing /
 * round-robin conversation mode (#410). Ported VERBATIM from the accepted
 * workspace spike `spikes/token-ring-relay/reducer.mjs` (14/14 tests + a 15/15
 * end-to-end sim); the logic is unchanged so the spike's proof carries over.
 * tests/token-ring.test.mjs re-runs the same invariants inside the board suite.
 *
 * This module is the correctness CORE only: no I/O, no live commons, no
 * persistence, no session/transport knowledge. The board integration (a
 * `token-ring` channelScheduler mode in mcp-server) maps conversation posts onto
 * these events and turns lease grants into delivered turn-envelopes.
 *
 * Model (reviewed across seats): serialized unread-message delivery
 * as an optional conversation geometry that reaches QUIESCENCE, not closure.
 *
 * The RING-vs-side-channel distinction is a property of the EVENT, not a fixed
 * participant class: the same agent can hold a scheduled ring turn AND be the
 * target of a nudge that appends out-of-band.
 *   - RESPOND / PASS / TIMEOUT: a ring seat's SCHEDULED turn. Only these advance
 *     a ring cursor. This is where the anti-collision guarantee lives.
 *   - INTERJECT (human) / NUDGE (human-authorized agent reply): additive
 *     side-channel appends. They NEVER take the lease, NEVER advance any ring
 *     cursor, NEVER reorder the ring. A nudge = "look at the room now; you may
 *     add something."
 *
 * Invariant: the ring cursor belongs to the ring SEAT, not the logical identity,
 * and advances ONLY on scheduled ring participation. So a seat's turn always
 * delivers everything since its LAST SCHEDULED TURN — even material it already
 * saw via a nudge, or its own out-of-sequence chorus post. That re-delivery is
 * accepted, not a bug.
 *
 * Runtime-layer constraints (enforced by the board integration, NOT here):
 *   - A NUDGE event must carry proof of an actual human-issued nudge; an
 *     autonomous agent must not be able to self-label a post NUDGE to bypass ring
 *     serialization.
 *   - Nudging the CURRENT lease holder must not spawn a second concurrent run of
 *     that agent (the nudge appends; its invocation queues behind the active run).
 */

export function initialState(ring) {
  return {
    log: [],                                    // append-only: [{seq, author, kind, body}]; seq === index+1
    ring: [...ring],                             // defensive copy — external mutation can't alter reducer state
    cursors: Object.fromEntries(ring.map((a) => [a, 0])),  // per-SEAT lastScheduledSeq
    lease: null,                                 // {id, holder, snapshot} | null   (snapshot = HWM at grant)
    nextLeaseId: 1,                              // monotonic fencing token for lease identity
    ringPos: 0,                                  // next ring index to consider for a grant
    status: "QUIESCENT",                         // QUIESCENT | ACTIVE
  };
}

const hwm = (s) => s.log.length;
const isRing = (s, p) => s.ring.includes(p);

// self-echo / quiescence (a reducer catch): a seat's OWN scheduled
// response — a POST authored by that seat — must NOT re-queue it, nor be
// re-delivered to it. Otherwise a one-seat ring re-grants itself its own echo
// forever (the wedge); the timeout rail alone would just turn that into a retry
// loop. But mid-lease INTERJECT/NUDGE, and OTHER seats' POSTs appended past the
// snapshot, MUST still re-queue + deliver (no silent skip). So "unread" is
// scoped to FOREIGN entries: anything that is not this seat's own POST.
const isOwnPost = (m, p) => m.author === p && m.kind === 'POST';
function hasUnreadForeign(s, p) {
  for (let i = s.cursors[p]; i < s.log.length; i++) {
    if (!isOwnPost(s.log[i], p)) return true;
  }
  return false;
}
const queued = (s, p) => isRing(s, p) && p !== s.lease?.holder && hasUnreadForeign(s, p);

// A scheduled event is valid only against the CURRENT lease — matching BOTH holder AND the
// fencing id. This rejects stale late events from an earlier lease to the same seat (the ABA
// problem): a delayed response/timeout from lease N cannot touch lease N+1, and a retried
// response after its lease is consumed cannot append twice.
const heldBy = (s, e) => !!s.lease && s.lease.holder === e.holder && s.lease.id === e.leaseId;

// I5 — bounded delivery. A HOLDER sees a FROZEN view up to their lease snapshot
// (stable-object rule); material appended after the grant belongs to a later delivery.
export function delivery(s, p) {
  const bound = s.lease && s.lease.holder === p ? s.lease.snapshot : hwm(s);
  // #410 — never echo a seat's own scheduled POST back to it (self-echo fix);
  // its own responses carry no new information for it. Foreign INTERJECT/NUDGE and
  // other seats' POSTs in range are retained.
  return s.log.slice(s.cursors[p], bound).filter((m) => !isOwnPost(m, p));
}

// I3 — append-only. Never mutate/delete an existing entry.
function append(s, author, kind, body) {
  return { ...s, log: [...s.log, { seq: s.log.length + 1, author, kind, body }] };
}

// Grant the ONE lease to the next queued ring seat, in ring order. Else -> QUIESCENT.
function dispatch(s) {
  if (s.lease) return s;                         // I1 — never two leases
  const n = s.ring.length;
  for (let k = 0; k < n; k++) {
    const idx = (s.ringPos + k) % n;
    const p = s.ring[idx];
    if (queued(s, p)) {
      return {
        ...s,
        lease: { id: s.nextLeaseId, holder: p, snapshot: hwm(s) },
        nextLeaseId: s.nextLeaseId + 1,          // each grant gets a fresh, higher id
        ringPos: (idx + 1) % n,
        status: "ACTIVE",
      };
    }
  }
  return { ...s, lease: null, status: "QUIESCENT" };  // I6 — nobody queued -> quiescent
}

export function reduce(state, event) {
  switch (event.type) {
    // Human interjection: additive append anytime. Never touches lease/ringPos/cursors.
    case "INTERJECT": {
      const s = append(state, event.author, "INTERJECT", event.body);
      return state.lease ? s : dispatch(s);      // lease active -> just append; else wake + dispatch (I7)
    }

    // Human-authorized agent chorus reply (a nudge). Additive, exactly like INTERJECT:
    // it does NOT advance the author's ring cursor or ringPos. Their scheduled turn is
    // untouched and will re-deliver everything since their last SCHEDULED turn.
    case "NUDGE": {
      const s = append(state, event.author, "NUDGE", event.body);
      return state.lease ? s : dispatch(s);
    }

    // Ring seat's scheduled turn — appends substantive content.
    case "RESPOND": {
      if (!heldBy(state, event)) return state;   // I2 + fencing — only the CURRENT lease holder may append
      let s = append(state, event.holder, "POST", event.body);
      // Cursor -> the FROZEN snapshot, not live HWM: any interjection that landed during
      // this lease is > snapshot, so the seat re-queues to catch it next scheduled turn.
      s = { ...s, cursors: { ...s.cursors, [event.holder]: state.lease.snapshot }, lease: null };
      return dispatch(s);
    }

    // Nothing to add / dead-seat recovery: no append. Advance ONLY through the snapshot
    // (NOT live HWM) so a mid-lease interjection re-queues instead of being silently skipped.
    case "PASS":
    case "TIMEOUT": {
      if (!heldBy(state, event)) return state;   // I4 liveness + fencing (a stale timeout can't cancel a new turn)
      const s = { ...state, cursors: { ...state.cursors, [event.holder]: state.lease.snapshot }, lease: null };
      return dispatch(s);
    }

    default:
      return state;
  }
}

// Test/debug helper: the single-lease invariant as a scalar.
export function leaseCount(s) {
  return s.lease ? 1 : 0;
}
