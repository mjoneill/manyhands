/**
 * core/roles.mjs — #1368: who holds a role NOW, read from the board.
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
export async function resolveRoleHolder(role, { baseUrl = '', fetchImpl = (...a) => fetch(...a) } = {}) {
  try {
    const r = await fetchImpl(`${baseUrl}/api/roster`);
    if (!r.ok) return null;
    const j = await r.json();
    const v = j && j.roles && typeof j.roles[role] === 'string' ? j.roles[role].trim() : '';
    return v || null;
  } catch { return null; }
}
