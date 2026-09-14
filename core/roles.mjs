/**
 * core/roles.mjs — #1368 / #1379: who holds a role NOW, read from the server.
 *
 * "Groom this" mentions the Product Owner by default, and the seat that holds
 * that role changes (re-granted 09-13). Hardcoding a name would be wrong the
 * next time it changed and nobody would notice until the wrong seat was woken.
 *
 * Today the answer is the roster's `roles.po` (settings → The room). #915 is
 * building the real thing — a Role node held by an OPEN seat declaration — and
 * when it lands, this function grows a first branch that asks /api/roles and
 * the roster becomes the fallback. Callers never change: one seam, one
 * question, one answer.
 *
 * Browser-safe: no node imports.
 */
/**
 * #1379 (#915 slice 2) — the FULL answer: who holds the role, and WHICH source
 * said so. Two sources exist on the server and the day they disagree nothing
 * else would notice:
 *   declaration  the OPEN scrum:SeatDeclaration carrying scrum:role (#915),
 *                read through /api/seats/state (a live row with `role`;
 *                UNKNOWN/expired rows never hold one). The graph's answer.
 *   roster       roles[role] from /api/roster (#1368) — the Settings select,
 *                the fallback, and the override for a room with no declarations. (#1379)
 * The declaration wins. Both ride the answer so a reader sees a disagreement
 * as two names, not one. A dead endpoint is a null on that side, never a throw.
 */
export async function resolveRole(role, { baseUrl = '', fetchImpl = (...a) => fetch(...a) } = {}) {
  let declaration = null;
  try {
    const r = await fetchImpl(`${baseUrl}/api/seats/state`);
    if (r.ok) {
      const j = await r.json();
      const rows = Array.isArray(j?.seats) ? j.seats : [];
      const live = rows.find((s) => s && s.role === role && s.mode && s.mode !== 'unknown' && !s.expired);
      declaration = live && typeof live.seat === 'string' && live.seat.trim() ? live.seat.trim() : null;
    }
  } catch { declaration = null; }
  let roster = null;
  try {
    const r = await fetchImpl(`${baseUrl}/api/roster`);
    if (r.ok) {
      const j = await r.json();
      const v = j && j.roles && typeof j.roles[role] === 'string' ? j.roles[role].trim() : '';
      roster = v || null;
    }
  } catch { roster = null; }
  const seat = declaration ?? roster ?? null;
  return { seat, source: declaration ? 'declaration' : roster ? 'roster' : null, declaration, roster };
}

/** The seat holding `role`, or null — the string the pages call for. Same rule as resolveRole. */
export async function resolveRoleHolder(role, opts = {}) {
  return (await resolveRole(role, opts)).seat;
}
