/**
 * #1762 S3 — xsd:dateTime instants at FULL precision, with no npm dependency (server.js imports this).
 *
 * `Date.parse` keeps milliseconds only, so `.0005Z` and `.000Z` read as one instant, and a `since` cutoff between them
 * changes window membership. The store keeps microseconds. Here the whole-second part goes through Date (offsets
 * included), and the fraction is kept as its own digit string.
 */
const INSTANT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

/** A key that sorts like the instant (fixed width, so lexical order is time order), or null if the text is not an instant. */
export function instantKey(v) {
  const m = INSTANT.exec(String(v ?? ''));
  if (!m) return null;
  const ms = Date.parse(`${m[1]}${m[3]}`);
  if (!Number.isFinite(ms)) return null;
  const sec = ms / 1000 + 1e11;                                  // positive and fixed width for any realistic year
  return `${String(sec).padStart(12, '0')}.${(m[2] ?? '').padEnd(12, '0').slice(0, 12)}`;
}

/** -1 / 0 / 1 by instant; text that is not an instant falls back to string order (today's behaviour for odd values). */
export function compareInstants(a, b) {
  const x = instantKey(a), y = instantKey(b);
  if (x == null || y == null) return a < b ? -1 : a > b ? 1 : 0;
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * The public `at`: UTC, at least millisecond digits, and every further digit the store holds. For a value already in the
 * log's millisecond form this returns it unchanged, so rows read as they always have.
 */
export function isoAtFull(v) {
  const m = INSTANT.exec(String(v ?? ''));
  if (!m) return String(v);
  const ms = Date.parse(`${m[1]}${m[3]}`);
  if (!Number.isFinite(ms)) return String(v);
  const whole = new Date(ms).toISOString().slice(0, 19);
  let frac = (m[2] ?? '').replace(/0+$/, '');
  if (frac.length < 3) frac = frac.padEnd(3, '0');
  return `${whole}.${frac}Z`;
}
