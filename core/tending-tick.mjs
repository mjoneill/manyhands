/**
 * core/tending-tick.mjs — the scheduled half of board-owned tending (#802/#804).
 *
 * Extracted from mcp-server.mjs because that module exports nothing, so the
 * FAIL-SILENT contract below had no surface a test could discriminate on. It
 * was described in a comment instead, and the comment was false — see below.
 * Same reason core/card-comments.mjs exists.
 *
 * ── THE FAIL-SILENT CONTRACT (product decision, 2026-08-14) ────────────────
 *
 *   A delivery failure BURNS that offer. There is no retry. The window is
 *   consumed at MINT time, before delivery is attempted, so a post that throws
 *   loses that offer permanently.
 *
 * ⚠️ THIS IS A DELIBERATE TRADE, not an accident of ordering:
 *
 *   fail-silent   one missed offer, never a duplicate one
 *   retry         needs a state transition distinguishing MINTED from DURABLY
 *                 DELIVERED, plus a proof the retry cannot duplicate
 *
 * A duplicate whisper is worse than a missed one, and retry's machinery is
 * real. It is acceptable ONLY because the record is required to make the
 * missed offer visible — while the gap was silent it was not acceptable.
 *
 * ⛔ THE COMMENT THIS REPLACES WAS FALSE, and that is the more useful half of
 * the story. It read:
 *
 *     "the next tick re-tries and the window guard makes the retry safe"
 *
 * There is no retry and there never was — mintOnce commits before delivery, so
 * four subsequent ticks all return null. Independent review refuted it
 * in twelve lines against the real module. The behaviour was defensible; the
 * because it told the next reader that a missing hour could not have
 * originated here, which sends the investigation somewhere else. On a card
 * whose entire subject is missing hours.
 *
 * ⭐ A comment asserting a RUNTIME property is a test case written in prose.
 * The vocabulary — retries, recovers, self-heals, is idempotent, cannot race —
 * marks exactly the claims that should have been tests. Hence this file.
 */

/**
 * One tick of the tending schedule. Everything it touches is injected, so the
 * failure path is reachable from a test without breaking a real server.
 *
 * @param {{
 *   now: string,                                  // canonical UTC instant
 *   mint: (args: {now: string}) => object|null,   // window-idempotent minter
 *   post: (body: {author: string, body: string}) => Promise<unknown>,
 *   reachedSeats?: () => string[],                // open streams at SEND time
 *   log?: (line: string) => void,
 *   onError?: (line: string) => void,
 * }} deps
 * @returns {Promise<{minted: boolean, delivered: boolean, key?: string, reason?: string}>}
 */
/**
 * #953 — WHO COUNTS AS THE ROOM BEING AWAKE.
 *
 * ⛔ THIS IS THE SEMANTIC CHOICE THE VALUE STEWARD SAID A BUILDER MUST NOT MAKE
 * INVISIBLY, so it is one named, exported, tested function rather than a
 * filter buried in a call site.
 *
 * Decided by the operator 2026-08-20 ("agree. proceed"):
 *
 *   COUNT      human comments · agent/seat comments
 *   DO NOT     tending posts · board/system notices
 *
 * ⭐⭐⭐ The exclusion is the load-bearing half. THE WHISPER'S OWN POST IS A
 * MESSAGE, authored `board`. If it counted, every whisper would reset the very
 * timer that governs the next whisper — silence-reset would collapse back into
 * a fixed hourly clock while still passing a casual demo, because at an hour
 * boundary the two are indistinguishable.
 *
 * ⚠️ Returns null for "no qualifying activity in what I was shown", which the
 * gate reads as QUIET. That is the safe direction: the caller passes a bounded
 * recent slice, and a window containing only board posts genuinely is a quiet
 * room.
 */
export const NON_ACTIVITY_AUTHORS = Object.freeze(['board', 'system']);

export function lastQualifyingActivity(messages) {
  let latest = null;
  for (const m of messages || []) {
    const author = String(m?.author ?? '').toLowerCase();
    if (!author || NON_ACTIVITY_AUTHORS.includes(author)) continue;
    const at = m?.createdAt;
    if (typeof at !== 'string') continue;
    if (latest == null || at > latest) latest = at;
  }
  return latest;
}

export async function tendingTick({
  now, mint, post, reachedSeats = () => [], log = () => {}, onError = () => {}, onMinted = null,
  quietAfterMinutes = null, lastActivityAt = null, eligibility = null,
}) {
  // #953 — THE SILENCE GATE. Before #953 this function took NO room-state
  // input at all, so there was no parameter a policy could change: the whisper
  // fired when the WINDOW opened, which is #802's clock design. The owner
  // reported it as "it just emits regardless" and he was right — there was no
  // gate to be broken.
  //
  // ⭐ ACTIVITY POLICY, decided by the operator 2026-08-20 ("agree. proceed") and
  // NOT chosen here: human and agent/seat comments COUNT; tending posts and
  // board/system notices DO NOT. That second half is load-bearing — the
  // whisper's own post is a message, and if it counted the timer would re-arm
  // forever and silence-reset would collapse back into the hourly clock while
  // still passing a casual demo. This function does not classify: it asks its
  // caller for the last QUALIFYING activity and trusts that contract.
  //
  // ⚠️ FAILS OPEN, deliberately. An un-wired caller passes neither argument and
  // keeps its old behaviour. A gate that read "I was told nothing" as "the room
  // is busy" would silence tending everywhere it had not yet been wired — the
  // emitter-breaking failure the control test exists to catch, arriving through
  // a default instead of through a bug.
  if (quietAfterMinutes != null && typeof lastActivityAt === 'function') {
    const last = lastActivityAt();
    if (last) {
      const quietMs = Date.parse(now) - Date.parse(last);
      const thresholdMs = Number(quietAfterMinutes) * 60_000;
      if (Number.isFinite(quietMs) && Number.isFinite(thresholdMs) && quietMs < thresholdMs) {
        // ⛔ Return BEFORE mint. Minting is window-idempotent, so minting and
        // then discarding would burn the offer for the whole window and the
        // room would go untended once it fell quiet — suppressing exactly the
        // whisper this gate exists to time correctly.
        return {
          minted: false,
          delivered: false,
          reason: `room-active:${Math.round(quietMs / 1000)}s-quiet-of-${quietAfterMinutes}m`,
        };
      }
    }
  }

  // #613 — THE STORED NO, CONSULTED BEFORE THE OFFER IS MINTED.
  //
  // A seat may declare "present, not taking routine work". If NO seat on the
  // roster is eligible, the room sends nothing and RECORDS that — it does not
  // report a delivery that did not happen, and it does not replay the window
  // later when the declarations expire.
  //
  // ⚠️ BEFORE MINT, for the reason the silence gate above already documents:
  // minting is window-idempotent, so minting and then discarding burns the
  // offer for the whole window and the room goes untended.
  //
  // ⛔ AND IT FAILS OPEN, like the gate above and for the same reason: a caller
  // that passes no `eligibility` keeps today's behaviour exactly. A tick that
  // read "I was told nothing" as "nobody is available" would silence tending
  // everywhere it had not yet been wired — the emitter-breaking failure, this
  // time arriving through a default rather than a bug.
  if (typeof eligibility === 'function') {
    const el = eligibility();
    if (el && el.anyEligible === false) {
      return {
        minted: false, delivered: false,
        reason: el.reason || 'no-eligible-seats',
        declining: el.declining ?? [],
      };
    }
  }

  let prompt;
  try {
    prompt = mint({ now });
  } catch (e) {
    onError(`[#804] tending mint failed: ${e?.message ?? e}`);
    return { minted: false, delivered: false, reason: 'mint-threw' };
  }
  // Already minted for this window, or the pool is empty. Not an error, and
  // the overwhelmingly common case — the tick is deliberately faster than the
  // window so a missed tick self-heals on the next one.
  if (!prompt) return { minted: false, delivered: false, reason: 'nothing-to-mint' };

  // Measured at SEND time, and named for exactly what it is. `reached` was the
  // previous name and it overclaimed: an open stream is not an awake seat, so
  // this field reports a seat at full confidence during precisely the kind of
  // ten-hour block this feature exists to survive. Transport telemetry only —
  // never delivery, wakefulness, tending or health evidence.
  const seatNamesWithOpenStreamsAtSend = [...new Set(reachedSeats())];

  try {
    // The key travels IN the message: a seat receiving this hours late can
    // still tell which offer it was for, and the claim path refuses it.
    await post({ author: 'board', body: `[tending ${prompt.window}] ${prompt.body}` });
  } catch (e) {
    // ⇒ FAIL-SILENT. The offer is already burned; we do NOT re-mint, and the
    // next tick will not either. Named, not swallowed: the whole point of the
    // chosen contract is that a lost offer leaves a trace.
    onError(
      `[#804] tending DELIVERY FAILED key=${prompt.window} offer BURNED, no retry`
      + ` (fail-silent, chosen 2026-08-14): ${e?.message ?? e}`,
    );
    return { minted: true, delivered: false, key: prompt.window, reason: 'delivery-failed' };
  }

  log(
    `[#804] tending minted key=${prompt.window}`
    + ` seatNamesWithOpenStreamsAtSend=[${seatNamesWithOpenStreamsAtSend.join(',')}]`,
  );
  // #1189 — the firing becomes a graph fact. AFTER delivery and deliberately
  // not awaited: the whisper reaching the room is the deliverable, and a
  // recording failure must never suppress or delay it. It is also NOT in the
  // failure path above — an undelivered mint is not a firing, and recording one
  // would make the graph claim the room was tended when it was not.
  if (typeof onMinted === 'function') {
    try { onMinted(prompt, seatNamesWithOpenStreamsAtSend); }
    catch (e) { onError(`[#1189] mint recording threw: ${e?.message ?? e}`); }
  }

  return { minted: true, delivered: true, key: prompt.window, reason: 'delivered' };
}
