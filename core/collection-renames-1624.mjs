/**
 * #1624 — identifiers that cannot be graph IRIs, renamed on the way into the graph (owner decision,
 * 2026-10-07T13:0xZ: "Rename it").
 *
 * The one known case: the tending prompt created on 2026-09-06 with the slug "scrum board-clarity" (a SPACE, from
 * before slugs were validated; that slug broke every graph query that day). It is live: in every playlist version
 * since v12 and named by the past whispers that used it. It moves to the graph as "scrum-board-clarity", the form the
 * slug rule itself suggests (core/tending-authoring.mjs slugify), and EVERY reference is rewritten with it: the prompt,
 * its versions, the playlist versions' ordered lists, the whispers' promptVersion. Same words, same history; only the
 * identifier changes. The migration and the retire step use this one map, so the retire check compares like with like.
 */
export const IRI_RENAMES = Object.freeze({
  'https://scrumboard.local/tending/prompt/scrum board-clarity': 'https://scrumboard.local/tending/prompt/scrum-board-clarity',
});
export const SLUG_RENAMES = Object.freeze({ 'scrum board-clarity': 'scrum-board-clarity' });

const renameString = (s) => {
  for (const [from, to] of Object.entries(IRI_RENAMES)) {
    if (s === from) return to;
    if (s.startsWith(`${from}/`)) return `${to}${s.slice(from.length)}`;
  }
  return s;
};

/** A deep copy of `value` with every renamed IRI (exact, or as a prefix followed by "/") and the prompt's own slug
 * (`identifier`) rewritten. Anything else is returned unchanged, value for value. */
export function renameEntity(value, key = null) {
  if (typeof value === 'string') {
    if (key === 'identifier' && Object.prototype.hasOwnProperty.call(SLUG_RENAMES, value)) return SLUG_RENAMES[value];
    return renameString(value);
  }
  if (Array.isArray(value)) return value.map((v) => renameEntity(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renameEntity(v, k)]));
  return value;
}
