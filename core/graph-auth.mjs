/**
 * #1559 — WHO may write to the graph. Authorized by the owner 2026-10-04 12:43Z,
 * to the room's pinned design (#1559 04:17Z–04:18Z, reviewers):
 *
 *   AUTHENTICATED means `req.auth.enforced === true` with a seat. In observe
 *   mode a seat value may be present from a recorded-but-unchecked bearer, so
 *   it is treated as NOT authenticated (a reviewer #1).
 *
 *   An authenticated seat's write must name `urn:ex:seat/<seat>` as its actor.
 *   There is no exception: the trial bypass never lets a bound seat speak as
 *   another (a reviewer).
 *
 *   An unauthenticated write is refused, unless the TRIAL BYPASS is active.
 *   That needs the flag AND evidence of launcher isolation, checked when the
 *   server starts (a reviewer #3, a reviewer).
 *
 *   Grant and rule creation needs the AUTHENTICATED seat to be listed in
 *   SCRUM_GRAPH_GRANT_ADMINS. The submitted actor never counts (a reviewer). With
 *   no list, nobody may create grants: deny by default. On a bypassed trial
 *   board, unauthenticated seeding may create them.
 *
 * Refusals are validation REJECTED: return-only, no receipt, nothing
 * dispatched. This allowlist is bootstrap policy, not graph-backed authority.
 *
 * LIMIT (a reviewer's review, stated so nobody reads more into it): the bypass
 * evidence is PROCESS-LOCAL. TRIAL_DIR, the flag, the store path and the
 * fence's global are all set by whoever launches the process. The check stops
 * the bypass being enabled BY ACCIDENT in a service. It does not stop a
 * hostile launcher, who could just as well run its own server.
 */
import fs from 'node:fs';
import path from 'node:path';

export const SEAT_NS = 'urn:ex:seat/';
export const seatActor = (seat) => `${SEAT_NS}${seat}`;

export function parseAdmins(raw) {
  return new Set(String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

/**
 * Decide whether the trial bypass may be active. Throws, so the server refuses
 * to START, when the flag is set without launcher isolation: a flag that only
 * the launcher "sets" is a convention until startup checks it.
 */
export function trialBypassFromEnv(env = process.env, { guardRoot = globalThis.__TRIAL_FS_GUARD_ROOT__ ?? null, realpath = fs.realpathSync } = {}) {
  if (env.SCRUM_GRAPH_TRIAL_UNBOUND_ACTORS !== '1') return { active: false };
  const why = [];
  const trialDir = env.TRIAL_DIR ? (() => { try { return realpath(env.TRIAL_DIR); } catch { return null; } })() : null;
  if (!trialDir) why.push('TRIAL_DIR unset or missing');
  if (!guardRoot) why.push('the trial write fence (scripts/trial-fs-guard.mjs) is not loaded');
  else if (trialDir && guardRoot !== trialDir) why.push(`the write fence guards ${guardRoot}, not TRIAL_DIR ${trialDir}`);
  const store = env.SCRUM_TRIAL_EXECUTOR_STORE ? (() => { try { return realpath(env.SCRUM_TRIAL_EXECUTOR_STORE); } catch { return null; } })() : null;
  if (!store) why.push('no server-owned trial executor store (SCRUM_TRIAL_EXECUTOR_STORE)');
  else if (trialDir && !(store === trialDir || store.startsWith(trialDir + path.sep))) why.push('the trial executor store is outside TRIAL_DIR');
  if (why.length) {
    throw new Error(`REFUSED: SCRUM_GRAPH_TRIAL_UNBOUND_ACTORS=1 without launcher isolation evidence: ${why.join('; ')}`);
  }
  return { active: true, trialDir };
}

/**
 * Pure decision for one write. Returns null (allowed) or a refusal reason.
 *   auth     req.auth as the server set it: { seat, scope, enforced }
 *   kind     the route's intention kind
 *   actor    the intention's actor IRI as submitted
 */
export function authorizeWrite({ auth, kind, actor, admins = new Set(), trialBypass = false }) {
  const authenticated = !!(auth && auth.enforced === true && auth.seat);
  if (authenticated) {
    if (actor !== seatActor(auth.seat)) return `actor-not-authenticated-seat: an authenticated write by ${auth.seat} must name ${seatActor(auth.seat)} as its actor`;
    if ((kind === 'grant' || kind === 'rule') && !admins.has(auth.seat)) return `not-a-grant-admin: ${auth.seat} is not in SCRUM_GRAPH_GRANT_ADMINS`;
    return null;
  }
  if (trialBypass) return null;
  return 'unauthenticated: graph writes need an enforced, bound seat (SCRUM_AUTH=required with a bearer)';
}

/**
 * #1561 launch (the owner 2026-10-04 18:40Z; reviewers 18:41–18:45Z) — the
 * routes whose writes the log-born unit takes. On a board that is NOT in
 * SCRUM_AUTH=required, these alone are judged as required mode would judge them
 * (a matched, unexpired, unrevoked key with the route's scope), and the request
 * then carries the ENFORCED context, so the body assertion and #1569's seat-self
 * rule run too. Every other route keeps observe's answer.
 */
const LOGBORN_WRITE_ROUTES = [
  ['POST', /^\/api\/memories$/],
  ['PATCH', /^\/api\/memories\/[^/]+$/],
  ['POST', /^\/api\/decisions$/],
  ['POST', /^\/api\/decisions\/[^/]+\/relations$/],
  ['PUT', /^\/api\/seats\/[^/]+\/state$/],
  ['DELETE', /^\/api\/seats\/[^/]+\/state$/],
];
export function isLogbornWriteRoute(method, urlPath) {
  const m = String(method).toUpperCase();
  return LOGBORN_WRITE_ROUTES.some(([rm, re]) => rm === m && re.test(urlPath));
}
