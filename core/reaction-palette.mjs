/**
 * #449 / #2026 — what a reaction may be, in ONE browser-safe module shared by the server, the MCP tools and the page.
 *
 * #449 shipped a fixed six. #2026 accepts ANY single RGI emoji (skin tones, flags and ZWJ sequences included): the check
 * is the engine's own `\p{RGI_Emoji}`, so no emoji table is needed to VALIDATE. The six remain the default first row of
 * the picker until the room has history; after that the first row is the room's most-used six over a rolling window
 * (decided 2026-11-22).
 */
export const REACTION_PALETTE = Object.freeze(['👍', '❤️', '😂', '🤷', '👏', '👀']);
/** The most posts one batch read may name (GET /api/reactions?posts=…). */
export const REACTION_BATCH_MAX = 200;
/** The rolling window, in days, of the room's top six (GET /api/reactions/top), and the most it may be asked for. */
export const TOP_DAYS = 30;
export const TOP_DAYS_MAX = 365;

const ONE_EMOJI = /^\p{RGI_Emoji}$/v;

/** True for exactly one RGI emoji; false for a letter, an empty string, two emoji, or an emoji with text around it. */
export function isReactionEmoji(s) {
  return typeof s === 'string' && ONE_EMOJI.test(s);
}

/**
 * The emoji to STORE for what was sent, or null. A symbol sent without its emoji selector (a bare ❤, as a keyboard or a
 * seat may type it) becomes the U+FE0F form the picker sends, so one heart cannot split into two chips.
 */
export function normalizeReactionEmoji(s) {
  if (isReactionEmoji(s)) return s;
  if (typeof s === 'string' && isReactionEmoji(s + '️')) return s + '️';
  return null;
}

/**
 * The room's most-used emoji: `reactions` is [{emoji, at}] (live reactions of the window). Most used first; a tie goes
 * to the one used more recently. Anything that is not a reaction emoji is not counted.
 */
export function topEmoji(reactions, n = 6) {
  const tally = new Map();
  for (const r of Array.isArray(reactions) ? reactions : []) {
    if (!r || !isReactionEmoji(r.emoji)) continue;
    const t = tally.get(r.emoji) || { emoji: r.emoji, count: 0, last: '' };
    t.count += 1;
    if (String(r.at || '') > t.last) t.last = String(r.at || '');
    tally.set(r.emoji, t);
  }
  return [...tally.values()]
    .sort((a, b) => b.count - a.count || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0))
    .slice(0, n)
    .map(({ emoji, count }) => ({ emoji, count }));
}

/** The picker's first row: the room's top emoji, padded from the default six, six in all, none twice. */
export function topRow(top, size = 6) {
  const row = [];
  for (const e of [...(Array.isArray(top) ? top : []), ...REACTION_PALETTE]) {
    if (row.length >= size) break;
    if (isReactionEmoji(e) && !row.includes(e)) row.push(e);
  }
  return row;
}

/** Emoji whose name holds every word of the query (any case). An empty query is the whole table, in table order. */
export function searchEmoji(table, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const rows = Array.isArray(table) ? table : [];
  return rows.filter(([, name]) => words.every((w) => String(name).toLowerCase().includes(w))).map(([e]) => e);
}
