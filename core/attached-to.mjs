/**
 * #761 — resolve a conversation's `attachedTo` to a card's canonical id.
 *
 * The field has accepted two key formats and reconciled neither. Measured on
 * the live board 2026-09-08 across all 25,722 conversations:
 *
 *   1395 card-attached posts
 *     1265  a UUID that resolves
 *       18  a UUID that resolves to NOTHING   — typos and fabrications
 *      110  a shortId naming a real card      — unreachable under the UUID join
 *        2  malformed (one of them a redaction marker, `…-aa***`)
 *
 * ⭐ THE TWO HALVES HAVE DIFFERENT LIFECYCLES, and that is what sets the
 * policy. shortId-keyed writes ran 33 in July, 77 in August and ZERO in
 * September — a closed population. Dangling UUIDs are still arriving: 8, 7,
 * and 3 so far this month.
 *
 * ⇒ So a resolvable shortId is COERCED, not rejected: coercion breaks no
 *   caller and closes the split, while rejecting a format nobody still writes
 *   would only convert silent loss into a loud stop for no one's benefit.
 * ⇒ A value that names nothing in EITHER format is refused. That is the only
 *   kind still being written, and it is the only kind a reader can never
 *   recover — the comment exists and reads back perfectly; it is the EDGE
 *   that points nowhere, and the edge has no reader.
 *
 * ⚠️ The literal string "null" stays a client's serialised absence (#688 — 42
 * live posts proved this path stores it verbatim). It is not a bad reference
 * and must never become a refusal.
 */

// ⛔ THERE IS NO SHAPE CHECK HERE, AND THAT IS THE POINT.
//
// The first version of this file matched `attachedTo` against a UUID regex
// before looking anything up. It refused `'bk'` — a perfectly real card id in
// the commons fixtures — and broke the one path #761's own body warned about:
// clearing a raised hand posts a resolution attached to the card, and a raise
// on an ORPHAN must stay clearable. The card said so in as many words: "do not
// 'fix' that path into requiring a resolved card, or orphans become
// unclearable." The suite caught it; the warning did not.
//
// ⭐ The lesson is the same one that cost me twice today: I encoded an
// ASSUMPTION ABOUT THE SURFACE ("ids look like uuids") in place of the
// QUESTION ("does this name a card?"). The card list is right here and it
// answers the question exactly. So: resolve, never recognise.

/**
 * @param {unknown} raw            the caller's attachedTo, as sent
 * @param {Array<{id: string, shortId: number}>} cards
 * @returns {{ok: true, value: string|null} | {ok: false, id: string}}
 *          `value` is the canonical card UUID, or null for a board-level post.
 *          `id` on a refusal is the unresolvable value, for the error message.
 */
export function resolveAttachedTo(raw, cards) {
  // Absence, in every spelling a caller has actually used.
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw === 'string' && (raw.length === 0 || raw === 'null')) return { ok: true, value: null };

  const asText = typeof raw === 'number' ? String(raw) : raw;
  if (typeof asText !== 'string') return { ok: false, id: String(raw) };

  // 1. Does it name a card by id? Any id, whatever it looks like.
  //    Checked FIRST so an id can never be shadowed by a shortId collision —
  //    the canonical key wins over the printed one.
  if (cards.some((c) => c.id === asText)) return { ok: true, value: asText };

  // 2. Does it name a card by shortId? That is the number printed on every
  //    card, so it is what a human or an agent reaching for "the card" types.
  //    Stored as the id, which is what makes the thread findable afterwards.
  //
  // ⛔ THE DIGIT GUARD IS LOad-BEARING. This was `Number.isInteger(Number(x))`,
  // which accepts far more than a card number: `0x1F` → 31, `0b11111` → 31,
  // `1e3` → 1000, and `31.` / `12.0` / `+12` / `\n12` / ` 12 ` all coerce too.
  // Every one of those resolved to a REAL card — silently, and to the WRONG
  // one.
  //
  // ⭐ That is strictly worse than the defect this file fixes. A dangling edge
  // is detectable: a sweep over every post finds all of them, which is how the
  // 20 on the live board were found. A wrong edge resolves, renders and reads
  // back perfectly, and no sweep can ever distinguish it from a correct one.
  //
  // ⚠️ AND THIS IS NOT THE SHAPE-CHECK MISTAKE MADE ABOVE, though it looks
  // like one. That check tested the shape of a CARD ID, which has no
  // guaranteed shape — `bk` is a real one — so it could only ever be wrong.
  // This tests the shape of a SHORTID, which is decimal digits by schema. It
  // is the key's own domain, not a guess about it, and the lookup still
  // decides. The guard only limits which strings get read as a number at all.
  if (/^\d+$/.test(asText)) {
    const card = cards.find((c) => c.shortId === Number(asText));
    if (card) return { ok: true, value: card.id };
  }

  // 3. It names nothing. Twenty such posts are already stranded on the live
  //    board, including one whose id is a redaction marker.
  return { ok: false, id: asText };
}
