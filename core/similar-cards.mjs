/**
 * #280 — the dup warning at create: "a similar-titled card exists".
 *
 * The pure half. Given the board's cards and a proposed title, return the
 * existing cards whose titles share enough distinctive words to be worth a
 * second look before filing. The adapter attaches the result to the 201 as
 * `similarCards`, non-empty only.
 *
 * ⚠️ DELIBERATE LIMITS, pinned by tests/similar-cards.test.mjs:
 *   - TITLE tokens only. Not the body, not labels, not embeddings, not the
 *     graph. It catches the case that actually happened (#277/#278: same
 *     words, same minute) and cannot catch a rule restated in other words.
 *     A zero here is not evidence nothing similar exists.
 *   - a WARNING, never a refusal. Filing goes ahead; the caller decides.
 *   - DERIVED at response time, never stored: the domain round-trip stays
 *     lossless (domain.test.mjs asserts it).
 *   - bounded rows: shortId, id, title, column, score. Never the description —
 *     a warning that ships five 100KB bodies is the size defect moved to a new
 *     surface (#794's lesson).
 *
 * Score = shared distinctive tokens / distinctive tokens in the PROPOSED
 * title. It asks "how much of what I am about to file is already on the
 * board?", which is the filer's question; a symmetric Jaccard would punish a
 * short new title for matching a long old one.
 *
 * ⚠️ MEASURED BEFORE SHIPPING, 2026-08-30, on the live board (988 cards),
 * against the nine rediscovery pairs the room has already adjudicated
 * (#656's labelled set + the three re-derivations of that night), scoring
 * each new card only against cards that existed when it was filed:
 *
 *     with a score floor of 0.5        0 / 9 in the top five
 *     ranked, ≥ 2 shared tokens        2 / 9 in the top five (#533→#466 rank 1,
 *                                      #534→#466 rank 2) — fires on 97 of the
 *                                      last 100 creates, 4.6 rows on average
 *     ranked, ≥ 3 shared tokens        0 / 9 — fires on 69 of 100
 *
 * ⇒ On this board's long titles, any setting selective enough to be an ALARM
 * catches nothing; the setting that catches the same-words case shows a list
 * on nearly every create. So this is shipped as a LIST, not an alarm: the
 * five nearest titles, for the filer to glance at. The seven misses are
 * re-derivations in different words — the declared limit, not a tuning gap.
 */

const STOP = new Set(`
the a an and or of to in is it be not never always must can if that this those
with for on at as by from what which who when we i my me our your you its than
then so all any are was were do does did have has had only their them they he
she but into out up down over under again more most some such no nor own same
too very just now also how why card cards
`.split(/\s+/).filter(Boolean));

/** Lower-cased distinctive words of a title: no punctuation, no stop words, ≥ 4 chars. */
export function titleTokens(title) {
  const s = String(title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  return new Set(s.split(' ').filter((w) => w.length > 3 && !STOP.has(w)));
}

/** Fewer shared distinctive tokens than this and a card is not a candidate. Measured: 3 catches nothing, 1 is everything. */
export const SIMILAR_MIN_SHARED = 2;
export const SIMILAR_DEFAULT_LIMIT = 5;

export function similarCards(cards, title, { excludeId = null, limit = SIMILAR_DEFAULT_LIMIT } = {}) {
  const want = titleTokens(title);
  if (want.size === 0) return [];
  const rows = [];
  for (const c of cards || []) {
    if (!c || c.id === excludeId) continue;
    const have = titleTokens(c.title);
    let shared = 0;
    for (const w of want) if (have.has(w)) shared++;
    if (shared < SIMILAR_MIN_SHARED) continue;
    const score = shared / want.size;
    rows.push({ shortId: c.shortId, id: c.id, title: c.title, column: c.column, score: Number(score.toFixed(2)) });
  }
  rows.sort((a, b) => b.score - a.score || (a.shortId ?? 0) - (b.shortId ?? 0));
  return rows.slice(0, Math.max(1, Number(limit) || SIMILAR_DEFAULT_LIMIT));
}
