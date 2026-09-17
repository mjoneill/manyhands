/**
 * #1400 — a role is a bounded interval on a seat declaration, and a NEW
 * declaration ends the previous one. So a re-declaration made for some other
 * reason (a note, an availability change) with a shorter expiry silently
 * shortens the role it carries. On 2026-09-16 the scrum-master grant went
 * from day 7 to three hours that way, lapsed at 19:00Z, and nothing said so
 * for ten hours while the holder kept acting.
 *
 * Two pure readers, both handed their inputs so a test can lie to them:
 *   roleShortening  — at the WRITE: does this declaration shorten the role the
 *                     open one holds? Never a refusal (a short window is
 *                     sometimes meant) — a line in the write's own result.
 *   roleExpiryRows  — the STANDING CHECK: roles expiring within `soonMs`, and
 *                     roles that lapsed within `lapsedWindowMs` whose holder
 *                     has written since (acting on a dead grant). A lapsed
 *                     role nobody is acting on is not a row: it simply ended.
 */

const H = 3600_000;

/**
 * @param {{prior: {role?:string|null, expiresAt?:string}|null, next: {role?:string|null, expiresAt?:string}}} a
 * @returns {{role:string, from:string, to:string, warning:string}|null}
 */
export function roleShortening({ prior, next }) {
  if (!prior || !prior.role || !next || !next.role) return null;
  if (next.role !== prior.role) return null;
  const from = Date.parse(prior.expiresAt), to = Date.parse(next.expiresAt);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to >= from) return null;
  return {
    role: prior.role, from: prior.expiresAt, to: next.expiresAt,
    warning: `this shortens your ${prior.role} from ${prior.expiresAt} to ${next.expiresAt} — re-declare with the longer expiry if that was not meant`,
  };
}

/**
 * @param {object} a
 * @param {Array<{seat:string, role?:string|null, expiresAt?:string}>} a.decls   the OPEN declarations (no endedAt); expired ones included
 * @param {Array<{author:string, createdAt:string}>} a.conversations              the board's posts — "has written since"
 * @param {string} a.now
 * @param {number} [a.soonMs]          default 24 h
 * @param {number} [a.lapsedWindowMs]  default 7 d
 */
export function roleExpiryRows({ decls, conversations = [], now, soonMs = 24 * H, lapsedWindowMs = 7 * 24 * H }) {
  const t = Date.parse(now);
  if (!Number.isFinite(t)) throw new Error('role-expiry: now is not a date');
  const rows = [];
  for (const d of decls || []) {
    if (!d || !d.role || !d.seat) continue;
    const exp = Date.parse(d.expiresAt);
    if (!Number.isFinite(exp)) continue;
    if (exp > t) {
      if (exp - t <= soonMs) rows.push({ seat: d.seat, role: d.role, state: 'expiring', expiresAt: d.expiresAt, inHours: Math.round((exp - t) / H) });
      continue;
    }
    if (t - exp > lapsedWindowMs) continue;
    let lastWriteAt = null;
    for (const c of conversations) {
      if (!c || c.author !== d.seat) continue;
      const w = Date.parse(c.createdAt);
      if (Number.isFinite(w) && w > exp && (lastWriteAt === null || w > Date.parse(lastWriteAt))) lastWriteAt = c.createdAt;
    }
    if (lastWriteAt) rows.push({ seat: d.seat, role: d.role, state: 'lapsed-but-acting', expiresAt: d.expiresAt, lapsedHours: Math.round((t - exp) / H), lastWriteAt });
  }
  return rows;
}
