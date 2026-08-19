/**
 * #726 — the fanout watch's decision, extracted as a pure function.
 *
 * WHY THIS FILE EXISTS. The decision below has been corrected six times in
 * production (#664 #666 #668 #690 #703 #713). Those fixes ARE tested —
 * tests/fanout-watch-cooldown.test.mjs drives the whole script through a stub
 * status server, and it is the better test of the two, because it proves the
 * wiring and not just the arithmetic. (I claimed here in a first draft that no
 * test existed; I had searched for `tests/*fanout*` and read the empty result
 * as an answer. It was the second time in one morning I did that. The file is
 * named for the DEFECT, not for the script.)
 *
 * What this extraction buys is a seam for cases the child-process harness makes
 * expensive: a six-hour cooldown driven in a millisecond, and a replay of 998
 * real production ticks through the decision to compare firing rates before and
 * after. Both harnesses stay — they answer different questions.
 *
 * No I/O, no clock, no state file: `now` and `state` are arguments so a test can
 * drive a six-hour cooldown in a millisecond.
 */

/**
 * @param {object}  a
 * @param {number}  a.receivers   open streams, from /channel/status
 * @param {number}  a.sessions    live sessions, same payload
 * @param {number}  a.floor       total-collapse threshold
 * @param {number}  a.cooldownMs  per-signature mute window
 * @param {number}  a.now         epoch ms (never Date.now() in here)
 * @param {object}  a.state       previous state (from the state file)
 * @returns {{state: object, warnBody: string|null}}
 */
export function decide({ receivers, sessions, floor, cooldownMs, now, state }) {
  // Deep-copy the two containers. A spread alone leaves `sigTimes` and `hist`
  // ALIASED to the caller's objects, so decide() would edit state it was only
  // asked to read — invisible in production (each run reads fresh state off
  // disk) and immediately corrupting anywhere the same state is reused, which
  // is every test and any future caller that drives two scenarios. Caught by
  // the anti-vacuity case: two tests with identical readings disagreed, which
  // can only happen if something persisted between them.
  const st = {
    r: receivers,
    s: sessions,
    pendingFrom: null,
    pendingSessionsFrom: null,
    warned: false,
    ...state,
    sigTimes: { ...(state?.sigTimes ?? {}) },
    hist: [...(state?.hist ?? [])],
  };
  // A state file written before #726 has no `s`. Treating that as 0 would make
  // the very first tick after deploy look like a total session collapse and
  // suppress a real warning — a false negative introduced by the upgrade
  // itself. Absent means "no baseline yet", so adopt the current reading.
  const prevReceivers = st.r;
  const prevSessions = st.s ?? sessions;

  st.sigTimes ??= {};
  // #690 migration: legacy pair keys (`7->4`) become destination keys
  // (`drop:4`). Dropping them would re-fire every muted signature the instant
  // this ships — the mid-incident-deploy trap #666 hit.
  for (const [sig, at] of Object.entries(st.sigTimes)) {
    const pair = sig.match(/^\d+->(\d+)$/);
    if (!pair) continue;
    const key = `drop:${pair[1]}`;
    st.sigTimes[key] = Math.max(st.sigTimes[key] ?? 0, at);
    delete st.sigTimes[sig];
  }
  for (const [sig, at] of Object.entries(st.sigTimes)) {
    if (now - at >= cooldownMs) delete st.sigTimes[sig];
  }

  // #690 — the cooldown's axis is SEVERITY, not identity. An alarm fires only
  // if its destination is below every destination currently muted in its
  // namespace. Repetition and improvement are silent; worsening always speaks.
  const deepestMuted = (prefix) => {
    const depths = Object.keys(st.sigTimes)
      .filter((k) => k.startsWith(prefix))
      .map((k) => Number(k.slice(prefix.length)))
      .filter(Number.isFinite);
    return depths.length ? Math.min(...depths) : null;
  };

  let warnBody = null;

  if (st.pendingFrom != null && receivers >= st.pendingFrom) {
    st.pendingFrom = null; st.pendingSessionsFrom = null; st.warned = false;   // recovered
  } else if (st.pendingFrom != null && receivers < st.pendingFrom) {
    // ── #726, THE DISCRIMINATOR ───────────────────────────────────────────
    // A falling `receivers` has two causes that this watch could not tell
    // apart, and only one of them is the fault it exists to catch:
    //
    //   a client disconnected  → its session AND its stream go away  (benign)
    //   a stream died          → the stream goes, the SESSION REMAINS  ⚠️ #624
    //
    // Measured 2026-08-07: both of that day's firings were the benign shape
    // (11:38Z receivers −1 / sessions −2; 12:48Z receivers −3 / sessions −7).
    //
    // Compared against the ARMED BASELINE, never the previous tick. At the
    // instant of a restart both counts fall together, so a tick-to-tick rule
    // would suppress the exact #624 incident this watch was built for. One
    // tick later the cases separate: clients reconnect, sessions return to
    // baseline, and streams that failed to re-open leave receivers behind.
    const receiversDelta = receivers - st.pendingFrom;
    const sessionsDelta = sessions - (st.pendingSessionsFrom ?? sessions);
    const clientsLeft = sessionsDelta <= receiversDelta;

    const sig = `drop:${receivers}`;
    const deepest = deepestMuted('drop:');
    const inCooldown = deepest != null && receivers >= deepest;
    if (!st.warned && !inCooldown && !clientsLeft) {
      warnBody = `⚠️ fanout watch: receivers dropped ${st.pendingFrom} → ${receivers} and stayed there `
        + `across two ticks while sessions held (${st.pendingSessionsFrom} → ${sessions}) — `
        + `${st.pendingFrom - receivers} stream(s) died under live sessions, which is deafness `
        + `rather than a client leaving (#726). `
        + `mode-independent: seats without a stream receive NOTHING — no queue, no replay (#624). `
        // ⛔ 2026-08-12 — TWO REMEDIES REMOVED, both FALSE. Not scoped wrong: false.
        //
        // 1. "any single MCP tool call re-registers it" — a tool call is a POST;
        //    openStreamCount is incremented in exactly ONE place, mcp-server.mjs:1779,
        //    inside `if (req.method === 'GET')`, and fanout targets sessions with
        //    openStreamCount > 0 (:1268). ⇒ No number of POSTs can ever make a
        //    session a fanout target. A seat followed this for two hours and stayed
        //    push-dead; that was not bad luck, it was impossible.
        // 2. "changes_since covers whatever was missed" — it retrieves stored posts
        //    by PULL. It does not restore push delivery and does not prove complete
        //    replay.
        //
        // ⚠️ Nothing positive replaces them YET, deliberately. The honest state is
        // `unknown` until a probe travels the real PUSH path and gets a
        // sequence-linked acknowledgement back — and that probe does not exist. A
        // remedy we cannot keep is what this edit is removing; writing a second one
        // would be the same defect with newer wording.
        //
        // ⚠️ And the retained line is scoped on purpose: "you can read this" is an
        // EVENT, true at one instant. It is not a health claim, and the old
        // "you're fine" phrased it as one.
        + `If this reached you, delivery worked for THIS message at THIS moment — `
        + `it says nothing about continuing delivery. A seat quiet since the last `
        + `restart may be deaf, and no tool call will fix that. `
        + `(This signature now mutes for ${Math.round(cooldownMs / 3600000)}h; a deeper drop still fires immediately.)`;
      st.warned = true; st.sigTimes[sig] = now;
    } else if (!st.warned && !clientsLeft) {
      st.warned = true;                                   // suppressed by cooldown — still gate once
    } else if (clientsLeft) {
      // Benign turnover: stand down entirely rather than staying armed, so the
      // next genuine drop arms from a current baseline instead of a stale one.
      st.pendingFrom = null; st.pendingSessionsFrom = null; st.warned = false;
    }
  } else if (receivers < prevReceivers) {
    // #668 settle-vs-drop: a drop TO a level held for most of recent history is
    // a post-deploy spike receding, not seats lost. Adopt it silently.
    const hist = st.hist || [];
    const heldCount = hist.filter((r) => r === receivers).length;
    if (heldCount >= Math.ceil(hist.length / 2) && hist.length >= 4) {
      st.r = receivers;                                   // settle: new (old) baseline
    } else {
      st.pendingFrom = prevReceivers;                     // first tick of a drop — arm, don't warn
      st.pendingSessionsFrom = prevSessions;
    }
  }

  // Only HEALTHY readings enter the held-level memory: a level held during an
  // armed or warned incident is a fault's plateau, not a baseline.
  if (st.pendingFrom == null && !st.warned) {
    st.hist = [...(st.hist || []), receivers].slice(-12);
  }

  // #668 — the floor path is the total-collapse backstop and shares the
  // per-signature cooldown. `warned` is deliberately NOT a condition: it
  // belongs to the delta incident, and gating on it muted collapses that
  // deepened mid-incident.
  //
  // #726 note: the floor deliberately does NOT consult the session
  // discriminator. Below the floor, why the streams are gone stops mattering —
  // if only one of twelve sessions can hear the room, that is worth saying even
  // if eleven clients left in an orderly fashion.
  if (receivers < floor) {
    const floorSig = `floor:${receivers}`;
    const floorDeepest = deepestMuted('floor:');
    if (floorDeepest == null || receivers < floorDeepest) {
      warnBody = `⚠️ fanout watch: only ${receivers} of ${sessions} live sessions hold an open stream `
        + `(floor: ${floor}). Seats without a stream receive NOTHING — no queue, no replay (#624). `
        // ⛔ SAME TWO FALSE REMEDIES AS THE DROP BRANCH ABOVE — see the note there
        // for the source proof. Kept in sync because the text a human acts on is
        // duplicated here, and a fix applied to one branch would have left the
        // floor alarm still prescribing a cure that cannot work.
        + `No tool call restores a deaf seat's stream, and a pull does not repair push. `
        + `(This signature now mutes for ${Math.round(cooldownMs / 3600000)}h; a deeper collapse still fires immediately.)`;
      st.sigTimes[floorSig] = now;
    }
    st.warned = true;
  }

  st.r = receivers;
  st.s = sessions;
  return { state: st, warnBody };
}

/**
 * #903 — render the seat list with each seat's OPEN STREAM COUNT.
 *
 * ⛔ WHY. #703 added a bracket naming the bound seats so a reader could infer
 * who vanished. When it was written, every seat in the map held a stream, so
 * "bound" and "receiving" were the same set and the word was exact. #707 then
 * bound the healthcheck as its own seat — a probe that mints a session every
 * 60s and NEVER opens a stream — and the two sets came apart from a different
 * file, with no edit here and nothing to trigger a re-read.
 *
 * The result, measured 2026-08-19T11:18:48Z (seat names generalised; every
 * number is as it fired):
 *
 *   "only 2 of 10 live sessions hold an open stream (floor: 3) …
 *    [#703: bound=[alpha,beta,healthcheck] unbound=3]"
 *
 * ⇒ The headline says 2. The bracket names 3. The floor IS 3. A reader who
 *   takes the bracket as the answer sees a set that exactly meets the floor and
 *   stands down — the alarm prints its own all-clear.
 *
 * ⭐ The fix is the number, not the word. `bound=[healthcheck:0,…]` is TRUE and
 * unambiguous: healthcheck is bound, and it receives nothing. Renaming the key
 * would break every log grep for no gain, and the ambiguity was never in the
 * word alone — it was in a word standing where a measurement belonged.
 *
 * ⚠️ An ABSENT stream count renders `?`, never `0`. This file already learned
 * that once at #713 — `?? 0` would have rendered a missing `pending` as "there
 * is no queue", a measurement that isn't there reading as a healthy one. A seat
 * whose streams we cannot read is not a seat with zero streams.
 *
 * @param {object} seats  status.seats — { [name]: { streams, sessions, … } }
 * @returns {string[]}    e.g. ['healthcheck:0', 'alpha:1', 'beta:1']
 */
export function renderSeats(seats) {
  return Object.keys(seats ?? {}).sort().map((name) => {
    const streams = Number(seats[name]?.streams);
    return `${name}:${Number.isFinite(streams) ? streams : '?'}`;
  });
}

/**
 * #713/#703 — the per-tick log suffix. Empty unless binding is active, because
 * a seat list nobody is binding is noise rather than information.
 */
export function seatSuffix(status) {
  if (status?.binding !== 'active') return '';
  return ` seats=[${renderSeats(status.seats).join(',')}] unbound=${Number(status.unbound ?? 0)}`;
}

/**
 * #703 — the bracket appended to a WARNING, so an alarm that can name seats
 * does. This is the string a human acts on at 06:18 in the morning; #903's
 * acceptance is deliberately written against THIS rendered line and not against
 * the array above, because a test on the intermediate value passes happily
 * while the printed text stays ambiguous.
 */
export function seatBracket(status) {
  if (status?.binding !== 'active') return '';
  return ` [#703: bound=[${renderSeats(status.seats).join(',')}] unbound=${Number(status.unbound ?? 0)}]`;
}
