/**
 * core/card-outline.mjs — #1332: WHERE IS THE CURRENT STATE ON THIS CARD?
 *
 * Measured 2026-09-09 over all 1,204 cards: 341 bodies exceed 5 KB, 85 exceed
 * 20 KB, and the longest is 167 KB. Of the twenty longest, the newest dated
 * block sits in the FIRST quarter 13 times and the LAST quarter 5 times.
 *
 * ⇒ ⭐ So neither end is reliable. A reader who always opens the head is wrong
 *   ~25% of the time; one who always reads the tail — which is what I did on
 *   #1268, re-deriving a finding the head already recorded as shipped — is
 *   wrong ~65% of the time. Nothing in the artifact says which kind it is.
 *
 * ── WHY THE BODY IS NOT CHRONOLOGICAL IN EITHER DIRECTION ───────────────────
 * Both conventions on this board are correct in isolation and point opposite
 * ways: a CORRECTION is prepended, because a retraction buried at the bottom is
 * one nobody reads; a working NOTE is appended, because that is how a log reads.
 * Neither should stop. The missing thing is a way to ASK.
 *
 * ⛔ THIS REPLACES THE BODY, IT DOES NOT ACCOMPANY IT. #794's block on
 * handleGetCard is the precedent and it is explicit: injecting more into a
 * single-card response "moves the size problem from the write path to the read
 * path — the same defect wearing the other shoe." An outline that shipped
 * BESIDE a 33 KB description would cost more than it saved and would still be
 * called a win, because the thing it optimises is invisible in the response.
 *
 * ⭐ RESPONSE LAYER ONLY. Derived, never stored — `cardToNode`/`nodeToCard`
 * round-trip losslessly and domain.test.mjs asserts it. A derived field has no
 * business surviving that round-trip.
 */

/**
 * ⚠️ HEADINGS INSIDE BLOCKQUOTES COUNT, AND THEY ARE THE POINT.
 *
 * This board's correction blocks are prepended as `> # ⛔ CORRECTION …` — a
 * heading nested in a quote. A naive /^#/ would match every ordinary section
 * and MISS every correction, i.e. exactly the content a reader is looking for
 * when they ask where the current state is. The feature would have demoed
 * perfectly and been useless on the cards that motivated it.
 */
const HEADING = /^[ \t]*(?:>[ \t]*)*(#{1,6})[ \t]+(.+?)[ \t]*$/;

/** ISO-ish date, optionally with a time. Board headings carry these by habit,
 *  not by rule — so `at` is present when found and absent otherwise, never
 *  guessed from position. */
const WHEN = /\b(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::\d{2})?)?/;

export const OUTLINE_MAX_SECTIONS = 200;

/**
 * Build a section index for a card body.
 *
 * @returns {{sections: Array, totalChars: number, truncated: boolean, headingsFound: number}}
 *   sections: { level, text, offset, chars, at? } — `chars` is the span to the
 *   next heading, so a reader can see which block is large before fetching it.
 */
export function cardOutline(body, { maxSections = OUTLINE_MAX_SECTIONS } = {}) {
  const text = typeof body === 'string' ? body : '';
  const found = [];
  let pos = 0;
  for (const line of text.split('\n')) {
    const m = HEADING.exec(line);
    if (m) {
      const w = WHEN.exec(m[2]);
      found.push({
        level: m[1].length,
        text: m[2].trim(),
        offset: pos,
        chars: 0,
        ...(w ? { at: w[2] ? `${w[1]}T${w[2]}` : w[1] } : {}),
      });
    }
    pos += line.length + 1; // +1 for the \n split() removed
  }
  // Span of each section = distance to the next heading. Computed over ALL
  // headings BEFORE truncation, so a capped list still reports true sizes
  // rather than sizes that silently absorb the sections we dropped.
  for (let i = 0; i < found.length; i++) {
    found[i].chars = (i + 1 < found.length ? found[i + 1].offset : text.length) - found[i].offset;
  }
  return {
    sections: found.slice(0, maxSections),
    totalChars: text.length,
    headingsFound: found.length,
    truncated: found.length > maxSections,
  };
}
