/**
 * core/credentials.mjs — #1343 slice 2: the agent-token scheme, built.
 *
 * The scheme (slice 1, reviewed on the card 2026-09-17) extends #703's seat
 * binding (core/seat-binding.mjs) and keeps its ruling — FAIL-OPEN by default,
 * an unknown token admitted unbound and COUNTED where the room looks — while
 * adding what a network-reachable board needs:
 *
 *   FORMAT   an opaque 32-byte random value, base64url, prefixed `mh_` so a
 *            scanner can recognise a leaked one (`mh_` + 43 chars). Stored as
 *            its SHA-256 in `seat-tokens.json`; the plaintext exists only in
 *            the holder's client config / Keychain / 0600 runner file and is
 *            shown once at mint. 256 bits of entropy needs no salt.
 *   RECORD   per seat, several (rotation overlap):
 *            { tokenHash, scope, issuedAt, expiresAt, issuedBy, revokedAt, note }
 *            — the credential's identity is its hash; the secret never enters
 *            the file, the graph, or a log. `reference, never value`.
 *   SCOPE    read < act < admin. Checked from the credential, never the body.
 *   MODE     SCRUM_AUTH, per PROCESS, read at boot, reported on /api/health:
 *              observe   bind if known, admit everyone (today; the loopback default)
 *              required  absent / unknown / expired / revoked → 401 with a reason;
 *                        scope enforced; the actor asserted from the credential
 *            A misspelt mode THROWS at boot — a typo must not run open.
 *   RECOVERY by SCRIPT at the box (scripts/credential.mjs); no HTTP path is
 *            exempt in `required`, loopback included.
 *
 * Everything here is pure or file-read; the servers own the sockets and the
 * counters. Never log a bearer: nothing in this module prints a header, and
 * `redactSecrets` exists so a caller that must quote a body can.
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';

export const DEFAULT_HEARTBEAT_S = 60;
export const SCOPES = ['read', 'act', 'admin'];
export const AUTH_MODES = ['observe', 'required'];
const RANK = { read: 0, act: 1, admin: 2 };
const H = 3600_000;

/** The value shape — mirrored by server.js SECRET_SHAPES and the push gate's scan. */
export const TOKEN_SHAPE = /\bmh_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/;

export function mintToken() {
  return 'mh_' + randomBytes(32).toString('base64url');   // 32 bytes → 43 chars, no padding
}

export function hashToken(plain) {
  return createHash('sha256').update(String(plain)).digest('hex');
}

export function redactSecrets(s) {
  return typeof s === 'string' ? s.replace(new RegExp(TOKEN_SHAPE.source, 'g'), 'mh_[REDACTED]') : s;
}

/**
 * SCRUM_AUTH → mode. Unset/empty is `observe` (the #703 default); anything
 * that is not exactly a mode throws, because "require" silently running as
 * observe is the one misconfiguration this file must make unmakeable.
 */
export function readAuthMode(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === '') return 'observe';
  if (AUTH_MODES.includes(v)) return v;
  throw new Error(`SCRUM_AUTH must be one of ${AUTH_MODES.join('|')}, got "${raw}"`);
}

/**
 * Load the credential file. Absent → DORMANT (every bearer unbound, zero
 * behaviour change — the rollout precondition). Malformed → warn + dormant: a
 * broken file must never take the room's channel down with it.
 *
 * Shapes read:
 *   seat-keyed, hashed   { seats: { ada: { heartbeat_s, credentials: [ {tokenHash, scope, …} ] } } }
 *   seat-keyed, LEGACY   { seats: { ada: { token, heartbeat_s } } }        (#703 — plaintext; hashed in memory, warned, listed in `legacy`)
 *   token-keyed, LEGACY  { tokens: { <token>: { seat, heartbeat_s } } }    (older still)
 * A legacy row binds with scope `act` and no expiry — exactly what the seat
 * does today — so the migration is a file edit that changes no behaviour.
 */
export function loadCredentials(filePath, { warn = (m) => console.warn(m) } = {}) {
  const dormant = { byHash: new Map(), seats: new Map(), legacy: [], dormant: true, path: filePath ?? null };
  if (!filePath || !existsSync(filePath)) return dormant;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (e) {
    warn(`credentials: ${filePath} unreadable (${e.message}) — running DORMANT, every bearer unbound`);
    return dormant;
  }
  const byHash = new Map(), seats = new Map(), legacy = [];
  const seatEntry = (seat, entry) => {
    const heartbeat_s = Number(entry?.heartbeat_s) > 0 ? Number(entry.heartbeat_s) : DEFAULT_HEARTBEAT_S;
    if (!seats.has(seat)) seats.set(seat, { heartbeat_s, credentials: [] });
    return seats.get(seat);
  };
  const add = (seat, c, heartbeat_s) => {
    if (!c || typeof c.tokenHash !== 'string' || c.tokenHash.length !== 64) return;
    const scope = SCOPES.includes(c.scope) ? c.scope : 'act';
    const row = { seat, scope, heartbeat_s, tokenHash: c.tokenHash, issuedAt: c.issuedAt ?? null, expiresAt: c.expiresAt ?? null, revokedAt: c.revokedAt ?? null, issuedBy: c.issuedBy ?? null, note: c.note ?? null };
    byHash.set(c.tokenHash, row);
    seatEntry(seat, { heartbeat_s }).credentials.push(row);
  };
  for (const [seat, entry] of Object.entries(parsed?.seats ?? {})) {
    if (!seat || !entry || typeof entry !== 'object') continue;
    const s = seatEntry(seat, entry);
    for (const c of Array.isArray(entry.credentials) ? entry.credentials : []) add(seat, c, s.heartbeat_s);
    if (typeof entry.token === 'string' && entry.token) {
      legacy.push(seat);
      add(seat, { tokenHash: hashToken(entry.token), scope: 'act', issuedBy: 'legacy' }, s.heartbeat_s);
    }
  }
  for (const [token, entry] of Object.entries(parsed?.tokens ?? {})) {
    if (!token || typeof entry?.seat !== 'string' || !entry.seat) continue;
    legacy.push(entry.seat);
    const s = seatEntry(entry.seat, entry);
    add(entry.seat, { tokenHash: hashToken(token), scope: 'act', issuedBy: 'legacy' }, s.heartbeat_s);
  }
  if (legacy.length) warn(`credentials: ${filePath} holds PLAINTEXT tokens for ${legacy.join(', ')} — they bind (scope act, no expiry) but the file should hold hashes: run scripts/credential.mjs migrate --file ${filePath} --by <you>`);
  return { byHash, seats, legacy, dormant: byHash.size === 0, path: filePath };
}

/**
 * Authorization header → binding, or null (no bearer presented).
 *   { seat, scope, heartbeat_s, expiresAt }                    bound
 *   { seat: null, reason: 'unknown' }                          a bearer we do not hold
 *   { seat: null, reason: 'expired'|'revoked', seatHint, … }   a bearer we hold that no longer binds — names the seat so the refusal can
 * A dormant file resolves everything to null: nothing to mismatch against.
 */
export function resolveBearer(header, creds, { now = new Date().toISOString() } = {}) {
  if (!header || typeof header !== 'string') return null;
  if (!creds || creds.dormant) return null;
  const m = header.match(/^\s*Bearer\s+(\S+)\s*$/i);
  if (!m) return null;
  const row = creds.byHash.get(hashToken(m[1]));
  if (!row) return { seat: null, reason: 'unknown' };
  const t = Date.parse(now);
  if (row.revokedAt && Date.parse(row.revokedAt) <= t) return { seat: null, reason: 'revoked', seatHint: row.seat, revokedAt: row.revokedAt };
  if (row.expiresAt && Date.parse(row.expiresAt) <= t) return { seat: null, reason: 'expired', seatHint: row.seat, expiresAt: row.expiresAt };
  return { seat: row.seat, scope: row.scope, heartbeat_s: row.heartbeat_s, expiresAt: row.expiresAt };
}

/**
 * What a route needs. null = the liveness door (/api/health): it carries no
 * board content and a proxy's health probe must reach it without a secret.
 * Reads are `read`; a mutation is `act`; the roster, roles, channel config and
 * the credentials themselves are `admin` — the switches an owner flips.
 */
export function needFor(method, urlPath) {
  const m = String(method || 'GET').toUpperCase();
  if (m === 'GET' && urlPath === '/api/health') return null;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return 'read';
  if (/^\/api\/(roles|agents|config|credentials)(\/|$)/.test(urlPath)) return 'admin';
  return 'act';
}

/**
 * The decision. `observe` never refuses (enforced:false, the seat carried if
 * bound); `required` refuses with a status + code + a sentence that names the
 * seat when it can, and enforces scope by rank. `need` null admits anyone.
 */
export function authDecision({ binding, mode, need }) {
  const m = readAuthMode(mode);
  const seat = binding?.seat ?? null, scope = binding?.scope ?? null;
  if (m === 'observe') return { ok: true, seat, scope, enforced: false };
  if (need === null || need === undefined) return { ok: true, seat, scope, enforced: true };
  if (!binding) return { ok: false, status: 401, code: 'AUTH_REQUIRED', error: 'a credential is required: send Authorization: Bearer <token> (SCRUM_AUTH=required)' };
  if (!binding.seat) {
    if (binding.reason === 'expired') return { ok: false, status: 401, code: 'TOKEN_EXPIRED', error: `credential for seat ${binding.seatHint} EXPIRED at ${binding.expiresAt} — mint a new one (scripts/credential.mjs mint --seat ${binding.seatHint})` };
    if (binding.reason === 'revoked') return { ok: false, status: 401, code: 'TOKEN_REVOKED', error: `credential for seat ${binding.seatHint} was REVOKED at ${binding.revokedAt}` };
    return { ok: false, status: 401, code: 'TOKEN_UNKNOWN', error: 'unknown credential — not in this board\'s seat-tokens file' };
  }
  if ((RANK[scope] ?? -1) < (RANK[need] ?? 99)) {
    return { ok: false, status: 403, code: 'SCOPE_INSUFFICIENT', error: `seat ${seat} holds scope ${scope}; this needs ${need}` };
  }
  return { ok: true, seat, scope, enforced: true };
}

/**
 * In `required` the SERVER sets the actor from the credential. An agreeing
 * body is untouched; a disagreeing `author`/`by` is kept as `onBehalfOf` (a
 * relay is a real act — #125's criterion 4b, the way conversation_post already
 * records it); a missing one is filled. Not called in `observe`.
 */
export function assertActor(body, seat) {
  if (!seat || !body || typeof body !== 'object' || Array.isArray(body)) return body;
  const field = Object.prototype.hasOwnProperty.call(body, 'author') ? 'author' : 'by';
  const declared = body[field];
  if (declared === seat) return body;
  if (typeof declared === 'string' && declared.length > 0) return { ...body, [field]: seat, onBehalfOf: declared };
  return { ...body, [field]: seat };
}

/**
 * The `credential-expiry` standing check (#1400 gave the shape): a credential
 * within `soonMs` of lapsing is `expiring`; one that lapsed within
 * `lapsedWindowMs` and was NOT revoked is `expired` (a seat about to go silent,
 * or already gone, that nobody retired on purpose). Revoked = retired: no row.
 * Rows name the seat + note, never the hash.
 */
export function credentialExpiryRows({ credentials, now, soonMs = 72 * H, lapsedWindowMs = 7 * 24 * H }) {
  const t = Date.parse(now);
  if (!Number.isFinite(t)) throw new Error('credential-expiry: now is not a date');
  const rows = [];
  if (!credentials || credentials.dormant) return rows;
  for (const c of credentials.byHash.values()) {
    if (c.revokedAt || !c.expiresAt) continue;
    const exp = Date.parse(c.expiresAt);
    if (!Number.isFinite(exp)) continue;
    if (exp > t) {
      if (exp - t <= soonMs) rows.push({ seat: c.seat, scope: c.scope, note: c.note, state: 'expiring', expiresAt: c.expiresAt, inHours: Math.round((exp - t) / H) });
      continue;
    }
    if (t - exp <= lapsedWindowMs) rows.push({ seat: c.seat, scope: c.scope, note: c.note, state: 'expired', expiresAt: c.expiresAt, lapsedHours: Math.round((t - exp) / H) });
  }
  return rows;
}

export const README = [
  '#1343 seat credentials — the file holds SHA-256 HASHES, never a token value.',
  'SEAT-KEYED: listing the keys of "seats" shows names only — that is the safe operation.',
  'Mint / list / revoke / migrate with scripts/credential.mjs (the plaintext is printed ONCE at mint, or written 0600 to a runner file).',
  'Scopes: read < act < admin. Mode: SCRUM_AUTH=observe|required on each server process, reported on /api/health.',
];

/**
 * Rewrite a #703 plaintext document as hashes: each legacy row becomes one
 * credential (scope act, `days` expiry — 90 by default, the resident figure,
 * because a 30-day cliff for every existing seat at once would be a bad first
 * move), heartbeat kept, the README replaced. Idempotent: a hashed document
 * comes back unchanged with migrated:[].
 */
export function migrateCredentialsDoc(doc, { now = new Date().toISOString(), issuedBy, days = 90 } = {}) {
  if (!issuedBy) throw new Error('migrateCredentialsDoc: issuedBy is required');
  const out = { ...(doc && typeof doc === 'object' ? doc : {}) };
  out._README = README;
  const seats = {};
  for (const [seat, entry] of Object.entries(out.seats ?? {})) seats[seat] = { ...entry, credentials: Array.isArray(entry?.credentials) ? [...entry.credentials] : [] };
  const migrated = [];
  const expiresAt = new Date(Date.parse(now) + days * 24 * H).toISOString();
  const mk = (plain, note) => ({ tokenHash: hashToken(plain), scope: 'act', issuedAt: now, expiresAt, issuedBy, revokedAt: null, note });
  for (const [seat, entry] of Object.entries(seats)) {
    if (typeof entry.token === 'string' && entry.token) {
      entry.credentials.push(mk(entry.token, 'migrated from #703 plaintext'));
      delete entry.token;
      migrated.push(seat);
    }
  }
  for (const [token, entry] of Object.entries(out.tokens ?? {})) {
    if (!token || typeof entry?.seat !== 'string') continue;
    const s = seats[entry.seat] ?? (seats[entry.seat] = { credentials: [] });
    if (Number(entry.heartbeat_s) > 0 && s.heartbeat_s === undefined) s.heartbeat_s = Number(entry.heartbeat_s);
    s.credentials.push(mk(token, 'migrated from #703 token-keyed plaintext'));
    migrated.push(entry.seat);
  }
  delete out.tokens;
  out.seats = seats;
  return { doc: out, migrated: [...new Set(migrated)] };
}
