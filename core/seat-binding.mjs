/**
 * core/seat-binding.mjs — #703: connection identity, from a token file.
 *
 * Room-vetted design (unanimous, 2026-08-05): per-seat bearer tokens in each
 * MCP client's config bind connections to seats at the door. FAIL-OPEN by
 * ruling — "fail-closed is right when a control PREVENTS; fail-open when it
 * OBSERVES. A diagnostic that refuses converts a naming problem into an
 * outage." An unbound connection is admitted and COUNTED where the room
 * looks (the fanout watch), never silently.
 *
 * The token file lives in the PRIVATE data tree beside the board (never this
 * repo): { "tokens": { "<token>": { "seat": "ada", "heartbeat_s": 60 } } }.
 * An absent or unreadable file means the feature is DORMANT: every connection
 * unbound, zero behavior change — rollout can proceed seat by seat.
 *
 * Q3 ruling: an authenticated-seat vs declared-author mismatch is LOGGED,
 * never refused — filing-on-behalf-of is indistinguishable from impersonation
 * at this layer, and it is the operation the room needs exactly when a seat
 * is stranded (#696/#702 precedent). Refusal requires an explicit
 * on-behalf-of mechanism to ship FIRST; that is a design constraint, not a
 * preference.
 */

import { readFileSync, existsSync } from 'node:fs';

export const DEFAULT_HEARTBEAT_S = 60;

/**
 * Load the token map. Absent file → dormant (empty map), by design.
 * A malformed file WARNS and goes dormant rather than crashing the server —
 * a broken token file must never take the room's channel down with it.
 */
export function loadSeatTokens(filePath, warn = (m) => console.warn(m)) {
  const dormant = { byToken: new Map(), dormant: true };
  if (!filePath || !existsSync(filePath)) return dormant;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (e) {
    warn(`seat-binding: ${filePath} unreadable (${e.message}) — running DORMANT, all connections unbound`);
    return dormant;
  }
  const byToken = new Map();
  for (const [token, entry] of Object.entries(parsed?.tokens ?? {})) {
    if (!token || typeof entry?.seat !== 'string' || !entry.seat) continue;
    byToken.set(token, {
      seat: entry.seat,
      heartbeat_s: Number(entry.heartbeat_s) > 0 ? Number(entry.heartbeat_s) : DEFAULT_HEARTBEAT_S,
    });
  }
  return { byToken, dormant: byToken.size === 0 };
}

/**
 * Resolve an Authorization header to a seat binding, or null (unbound).
 * Accepts "Bearer <token>" (case-insensitive scheme). Unknown tokens are
 * unbound-with-reason — a wrong token and a missing one are both admitted
 * (fail-open) but distinguishable in the log.
 */
export function bindFromAuthHeader(header, tokens) {
  if (!header || typeof header !== 'string') return null;
  if (tokens?.dormant) return null;   // feature off: no tokens configured, nothing to mismatch against
  const m = header.match(/^\s*Bearer\s+(\S+)\s*$/i);
  if (!m) return null;
  const entry = tokens?.byToken?.get(m[1]);
  return entry ? { ...entry } : { seat: null, unknownToken: true };
}
