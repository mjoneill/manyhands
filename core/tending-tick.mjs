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
export async function tendingTick({ now, mint, post, reachedSeats = () => [], log = () => {}, onError = () => {} }) {
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
  return { minted: true, delivered: true, key: prompt.window, reason: 'delivered' };
}
