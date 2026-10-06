/**
 * #1610 — a tripwire as TWO cheap reads compared here, for claims the engine cannot answer as one fast ASK.
 *
 * Why: one authored ASK joining two one-row aggregates took 4.4–7.6 s on the live shape (each half 9–12 ms alone), and
 * an ASK is one synchronous engine call: it froze the REST main thread for its whole length, once a minute.
 *
 * Narrow on purpose (the contract owner's scoping, 2026-10-06): xsd:dateTime only, operators `<` and `>` only.
 *   - each side is a SELECT returning exactly ONE row with exactly ONE bound value; zero rows, two rows, two variables
 *     or an UNBOUND value (what MAX over nothing returns) is an error, never a coerced verdict;
 *   - both values must be xsd:dateTime with an explicit timezone and at most millisecond precision, compared as
 *     INSTANTS, never as strings; anything else is an error (no permissive Date.parse).
 *   - ⚠️ queryGraph hands back row values as plain strings: the literal's datatype is not visible here, so the type is
 *     enforced by the strict lexical form above. A plain string literal spelled exactly like a dateTime would pass.
 * ⚠️ An intentional difference from the ASK it replaces: where the ASK answered false because a premise was absent
 * (an unbound aggregate), this answers error, because a missing premise is not a verdict.
 */
export const COMPARE_OPS = new Set(['<', '>']);
const XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
// YYYY-MM-DDThh:mm:ss(.fff)? then Z or ±hh:mm — timezone REQUIRED, at most three fractional digits
const DT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-](\d{2}):(\d{2}))$/;

/** The instant (ms since epoch) of a strict xsd:dateTime lexical form, or null if it is not one. */
export function dateTimeInstant(lex) {
  const m = DT.exec(String(lex));
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac, tz, tzh, tzm] = m;
  const Y = +y, M = +mo, D = +d, H = +h, MI = +mi, S = +s;
  if (M < 1 || M > 12 || H > 23 || MI > 59 || S > 59) return null;
  const dim = new Date(Date.UTC(Y, M, 0)).getUTCDate();
  if (D < 1 || D > dim) return null;
  if (tz !== 'Z' && (+tzh > 14 || +tzm > 59)) return null;
  const ms = frac ? +frac.padEnd(3, '0') : 0;
  const off = tz === 'Z' ? 0 : (tz[0] === '-' ? -1 : 1) * (+tzh * 60 + +tzm);
  return Date.UTC(Y, M - 1, D, H, MI, S, ms) - off * 60000;
}

/** A validation message for a `compare` object, or null when it is well-formed. */
export function validateCompare(cmp) {
  if (!cmp || typeof cmp !== 'object' || Array.isArray(cmp)) return '`compare` must be an object {left, op, right}';
  for (const side of ['left', 'right']) {
    if (typeof cmp[side] !== 'string' || !cmp[side].trim()) return `\`compare.${side}\` must be a SPARQL SELECT`;
    const head = cmp[side].replace(/#[^\n]*/g, ' ').replace(/\bPREFIX\s+[^\s:]*:\s*<[^>]*>/gi, ' ').trim();
    if (!/^SELECT\b/i.test(head)) return `\`compare.${side}\` must be a SPARQL SELECT returning one value (got ${JSON.stringify(head.slice(0, 24))})`;
  }
  if (!COMPARE_OPS.has(cmp.op)) return `\`compare.op\` must be one of ${[...COMPARE_OPS].map((o) => JSON.stringify(o)).join(', ')}`;
  return null;
}

/** One side's single value as an instant, or {error}. `r` is queryGraph's result. */
function sideInstant(r, side) {
  const rows = Array.isArray(r?.rows) ? r.rows : null;
  if (!rows) return { error: `${side}: the query returned no row set` };
  if (rows.length !== 1) return { error: `${side}: expected exactly one row, got ${rows.length}` };
  const vars = Object.keys(rows[0] || {});
  if (vars.length !== 1) return { error: `${side}: expected exactly one bound value, got ${vars.length} (an unbound aggregate — MAX over nothing — is a missing premise, not a value)` };
  const v = rows[0][vars[0]];
  const lex = typeof v === 'string' ? v : v?.value;
  const dt = typeof v === 'object' && v ? (v.datatype?.value ?? v.datatype) : undefined;
  if (dt !== undefined && dt !== XSD_DATETIME) return { error: `${side}: value is not an xsd:dateTime (datatype ${dt})` };
  const t = dateTimeInstant(lex);
  if (t === null) return { error: `${side}: ${JSON.stringify(lex)} is not an xsd:dateTime with an explicit timezone and at most millisecond precision` };
  return { t };
}

/** Evaluate a compare tripwire: {ok:true, value:boolean, left, right} or {ok:false, error}. */
export function evaluateCompare(query, cmp) {
  const bad = validateCompare(cmp);
  if (bad) return { ok: false, error: bad };
  const l = sideInstant(query(cmp.left), 'left');
  if (l.error) return { ok: false, error: l.error };
  const r = sideInstant(query(cmp.right), 'right');
  if (r.error) return { ok: false, error: r.error };
  const value = cmp.op === '<' ? l.t < r.t : l.t > r.t;
  return { ok: true, value, left: new Date(l.t).toISOString(), right: new Date(r.t).toISOString() };
}
