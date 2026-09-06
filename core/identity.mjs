/**
 * core/identity.mjs — the room's roster, as light.
 *
 * The commons isn't a chat log; it's a room with named minds in it. Each mind
 * carries a SIGNATURE LIGHT — a luminous, night-appropriate colour that threads
 * quietly through everything it touches (its messages, its place in the presence
 * constellation). Colour here is identity, not decoration: you learn to read the
 * room by its lights. Pure + browser-safe (no I/O), so it's the single source of
 * truth for both the view layer and node tests.
 *
 * Colours are tuned to read as lamps in a dark room — luminous but restrained,
 * distinct from each other, harmonious together on the deep-violet night ground.
 *
 * ⚠️ THE ROSTER BELOW IS AN EXAMPLE, NOT A SCHEMA, AND NOT THE PLACE TO EDIT.
 * These five are placeholders so a fresh install has something to look at.
 * To use your own people and agents, copy `roster.example.json` to `roster.json`
 * and edit that — a file outside version control, so `git pull` never conflicts
 * with who you are. Keys are free strings and the data model never validates
 * against this map: an unknown author simply renders with the UNKNOWN light and
 * its own name. Nothing needs migrating to add or remove a seat.
 *
 * ── HOW THE OVERRIDE REACHES THIS MODULE ────────────────────────────────────
 * This file stays PURE and browser-safe — no fs, no fetch — because it is the
 * single source of truth for the view layer and the node tests alike, and those
 * two have no I/O in common. So the roster is *injected*, never read here:
 *   - the server loads roster.json and inlines it as `globalThis.__SCRUM_ROSTER__`
 *     in every HTML page it serves, so the browser has it before first paint
 *     (no async gap where the room renders in the wrong colours);
 *   - node callers use `configureIdentities()` directly.
 * Reading a global is not I/O; the purity that matters here is unchanged.
 */

/** The shipped example roster. Used when nothing overrides it. */
export const DEFAULT_IDENTITIES = {
  alex:  { name: 'Alex',  glyph: '🧑‍💻', color: '#e8b45c' }, // the human — warm host gold
  robin: { name: 'Robin', glyph: '◆', color: '#f2895c' },   // warm coral
  sage:  { name: 'Sage',  glyph: '●', color: '#9a86f5' },   // planetary violet
  nova:  { name: 'Nova',  glyph: '▲', color: '#83b3d6' },   // sky-blue
  kit:   { name: 'Kit',   glyph: '■', color: '#e2749a' },   // rose
  wiki:  { name: 'wiki',  glyph: '📄', color: '#8fae9a' },  // the app's own quiet voice
};

const UNKNOWN = { name: null, glyph: '◍', color: '#8b92aa' }; // a mind we don't have a light for yet

/**
 * Keep only well-formed entries. A roster is cosmetic, so this is deliberately
 * FORGIVING: one malformed seat is dropped, the rest still light up. Nobody
 * should lose their board to a stray comma in a colour.
 *
 * Dropping is safe precisely because the data model doesn't depend on this map:
 * an author with no entry renders under the UNKNOWN light with its own name, so
 * the worst case is a grey name — never someone else's name.
 */
function sanitizeRoster(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  for (const [key, v] of Object.entries(input)) {
    if (!key || !v || typeof v !== 'object') continue;
    const name = typeof v.name === 'string' && v.name.trim() ? v.name.trim() : null;
    const color = typeof v.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(v.color.trim()) ? v.color.trim() : null;
    if (!name || !color) continue;
    const glyph = typeof v.glyph === 'string' && v.glyph.trim() ? v.glyph.trim() : UNKNOWN.glyph;
    // #619 — optional alternate names for a seat, so `alex` resolves to the
    // person it belongs to without a sibling alias table beside the roster.
    // Absent on almost every seat and absent from every roster written before
    // this existed, hence optional: a roster without the key keeps working.
    const aliases = Array.isArray(v.aliases)
      ? [...new Set(v.aliases.filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim()))]
      : [];
    out[String(key).trim().toLowerCase()] = aliases.length
      ? { name, glyph, color, aliases }
      : { name, glyph, color };
    // #1200 — a colleague defined on the board (scrum:Agent) rather than in
    // the file. Optional and absent on every file seat; kept so a reader can
    // tell the two apart without a second lookup.
    if (v.agent === true) out[String(key).trim().toLowerCase()].agent = true;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The active roster. `let` + live bindings, so importers of `IDENTITIES` see a
 * reconfiguration without having to re-import or be handed a getter.
 */
export let IDENTITIES = sanitizeRoster(globalThis.__SCRUM_ROSTER__) || DEFAULT_IDENTITIES;

/**
 * Replace the active roster. Pass nothing (or something unusable) to fall back
 * to the shipped example. Returns the roster now in force, so a caller can log
 * what actually took effect rather than what it hoped would.
 */
export function configureIdentities(map) {
  IDENTITIES = sanitizeRoster(map) || DEFAULT_IDENTITIES;
  return IDENTITIES;
}

/** True when a custom roster is in force — useful for a "using defaults" hint. */
export function usingDefaultRoster() {
  return IDENTITIES === DEFAULT_IDENTITIES;
}

/** The signature light for an author key (case-insensitive). Never throws. */
export function identityOf(author) {
  const key = String(author ?? '').trim().toLowerCase();
  const known = IDENTITIES[key];
  if (known) return { key, ...known };
  return { key, ...UNKNOWN, name: UNKNOWN.name ?? author };
}

/** The known roster, in a stable order (used by the presence constellation). */
export function roster() {
  return Object.entries(IDENTITIES).map(([key, v]) => ({ key, ...v }));
}

/**
 * Presence brightness [0..1] for a mind, from how long ago it last spoke.
 * Just-spoke → 1 (lit); fades over `windowMs` to `floor` (a dim ember, still
 * here); no post at all → 0 (dark). Pure — `now` is injected so it's testable.
 */
export function presenceLevel(lastPostMs, now, windowMs = 45 * 60 * 1000, floor = 0.14) {
  if (!Number.isFinite(lastPostMs)) return 0;
  const age = now - lastPostMs;
  if (age <= 0) return 1;
  if (age >= windowMs) return floor;
  // ease-out: bright early, gentle tail
  const t = age / windowMs;
  return floor + (1 - floor) * (1 - t) * (1 - t);
}

/**
 * #1241 — WHO IS IN THE ROOM, ranked by whether they are actually here.
 *
 * The constellation built one chip per roster seat, once, at page load, and
 * then faded the dead ones to 26% opacity forever. Two consequences, both
 * measured on a live board: a seat that has not spoken in weeks holds a slot
 * beside one that spoke ten seconds ago, and a seat invited AFTER the page
 * loaded never appears at all.
 *
 * ⛔ AND THE OBVIOUS FIX IS WRONG. Dropping quiet seats entirely trades one
 * invisibility for another: #717/#718 — a stopped seat and a quiet seat are
 * indistinguishable from every position, including the seat's own. A room that
 * silently stops rendering someone cannot tell you whether they left, broke, or
 * simply had nothing to say. So the quiet are COUNTED, never deleted.
 *
 * Pure, so the ranking is testable without a DOM: `now` and the last-post map
 * are injected.
 */
export function constellationOrder(minds = [], lastByAuthor = new Map(), now = Date.now(), windowMs = 45 * 60 * 1000) {
  const at = (m) => {
    const t = lastByAuthor.get?.(m.key) ?? lastByAuthor[m.key];
    return Number.isFinite(t) ? t : null;
  };
  const live = [];
  const quiet = [];
  for (const m of minds) {
    const t = at(m);
    // "Live" is spoke-within-the-window, not spoke-ever: a seat that posted
    // last Tuesday is not in the room, and saying so is the point.
    if (t !== null && now - t < windowMs) live.push({ ...m, lastPostMs: t });
    else quiet.push({ ...m, lastPostMs: t });
  }
  live.sort((a, b) => b.lastPostMs - a.lastPostMs);
  // Quiet ordered by how recently they were last here, never-spoken last, so
  // "who faded most recently" reads off the top of the overflow.
  quiet.sort((a, b) => (b.lastPostMs ?? -Infinity) - (a.lastPostMs ?? -Infinity));
  return { live, quiet, quietCount: quiet.length };
}
