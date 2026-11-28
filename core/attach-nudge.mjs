/**
 * #695 — a post that names exactly one card and attaches to nothing is almost
 * certainly a comment that missed its target. It reads fine in the stream and
 * is invisible to every traversal of that card.
 *
 * This says so in the write's ANSWER. It never blocks the post and never
 * attaches it: the author decides, and an author who meant the commons is
 * right to ignore it.
 *
 * ⭐ THE PRECISION OF THE TRIGGER IS THE WHOLE FEATURE. Board-wide on
 * 2026-08-12, 10,933 floating posts named several cards or none, and those
 * are correctly floating. A nudge that fires on them teaches every seat to
 * skip it. So the rule is deliberately the quiet one:
 *
 *   - exactly ONE distinct `#NNN` in the body (the same number twice is one);
 *   - that number resolves to a real card;
 *   - nothing is attached.
 *
 * ⚠️ "Two `#NNN`" counts TOKENS, not resolved cards. "#12 and #99999" stays
 * silent even though only one resolves: the card's rows say two references
 * are silent and an unresolvable number is not a reference, and where those
 * meet the quieter reading wins.
 *
 * The reference pattern is the renderer's (core/render.mjs CHAT_CARD_REF_RE):
 * a `#NNN` counts only where a reader would see it as a card link. A nudge
 * that disagreed with the page would point at links nobody can see.
 */

const CARD_REF_RE = /(?<![\w&;])#(\d+)/g;

/**
 * @param {{ body: unknown, attachedTo: string|null, cards: Array<{id: string, shortId: number}> }} p
 *        `attachedTo` is the RESOLVED value (a card uuid, or null for a board-level post).
 * @returns {null | { card: number, cardId: string, hint: string }}
 */
export function attachNudge({ body, attachedTo, cards }) {
  if (attachedTo != null) return null;
  if (typeof body !== 'string' || !body) return null;
  const nums = new Set();
  for (const m of body.matchAll(CARD_REF_RE)) {
    nums.add(Number(m[1]));
    if (nums.size > 1) return null;
  }
  if (nums.size !== 1) return null;
  const [n] = nums;
  const card = (Array.isArray(cards) ? cards : []).find((c) => c && Number(c.shortId) === n);
  if (!card) return null;
  return {
    card: n,
    cardId: card.id,
    hint: `this post names #${n} only and is attached to nothing, so it can't be found from that card. `
      + `If it's about #${n}, post it with attachedTo: "${n}". If it's for the whole room, ignore this.`,
  };
}
