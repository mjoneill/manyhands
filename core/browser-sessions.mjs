/**
 * core/browser-sessions.mjs — #1906: a human's browser signs in with a one-time code minted at the terminal, and holds an
 * HttpOnly session cookie, so a write from the board's pages is recorded as that human's seat from proof.
 *
 *   CODE     16 random bytes (128 bits) as Crockford base32: 26 characters, shown grouped 5-5-5-5-6. Typed, never a link:
 *            #1343's "theater to refuse" list forbids a secret in a URL. Valid 10 minutes, single use. Stored as its SHA-256.
 *   SESSION  32 random bytes (256 bits), base64url, 43 characters: the cookie's value. Stored as its SHA-256, with the seat,
 *            when it started, when it expires (30 days), when it was last used, and when and how it ended. Revocable.
 *   STORE    one JSON file, 0600, beside the seat credentials (the data folder): { codes: [...], sessions: [...] }. The mint
 *            script and the server both write it, under a lock file, by temp + rename. Hashes only: 128 and 256 random bits
 *            need no salt. `reference, never value`, as core/credentials.mjs.
 *   EVENTS   an append-only JSONL beside the store: each mint, each session start and end, each refused exchange, each
 *            revoke. An event names the seat and the time, never a code, a session id or a hash.
 *   HUMAN    a seat is a human person when its roster entry says `kind: "human"`. The roster's `kind` is the field it already
 *            carries per seat (#600's `kind: "system"`, #1380); no other field marks a person, and no seat is named in code.
 *
 * THE HONEST LIMIT (written on the settings page and in the script's --help): anyone with a shell on this machine can run the
 * mint script, and that includes the AI seats. That is the boundary seat-tokens.json has today: a rule, not a mechanism.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { hostAllowed } from './host-guard.mjs';

export const COOKIE_NAME = 'mh_session';
export const CODE_TTL_MS = 10 * 60_000;
export const SESSION_TTL_MS = 30 * 24 * 3600_000;
const KEEP_ENDED_MS = 30 * 24 * 3600_000;   // ended rows stay a month (the listing's history), then are pruned
const LAST_USED_EVERY_MS = 10 * 60_000;     // lastUsedAt is written at most this often per session

export const HONEST_LIMIT = 'Anyone with a shell on this machine can run the mint script, and that includes the AI seats. '
  + 'This is the same boundary seat-tokens.json has today: a rule, not a mechanism. '
  + 'The rule: seats never run it; only the person whose seat it signs in does. '
  + 'Every mint is recorded as an event, and that record is how a breach of the rule would be seen.';

const README = [
  '#1906 browser sign-in — codes and sessions, as SHA-256 HASHES only; never a code or a session id.',
  'Written by scripts/browser-signin-code.mjs (mint, revoke-all) and by the board (exchange, sign out). 0600.',
  'The events beside this file name seats and times, never a value.',
];

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   // Crockford: no I, L, O, U

export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

/** 128 random bits → 26 Crockford base32 characters (the top two bits of the first are zero). */
export function mintCode() {
  const b = randomBytes(16);
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let s = '';
  for (let i = 0; i < 26; i++) { s = B32[Number(n & 31n)] + s; n >>= 5n; }
  return s;
}
/** The grouped form shown at the terminal: 5-5-5-5-6. */
export const groupCode = (c) => `${c.slice(0, 5)}-${c.slice(5, 10)}-${c.slice(10, 15)}-${c.slice(15, 20)}-${c.slice(20)}`;
/**
 * What a person typed → the canonical 26 characters, or null. Spaces and dashes are ignored, case is folded, and the
 * characters a reader confuses are read as Crockford reads them (O→0, I and L→1).
 */
export function normalizeCode(input) {
  if (typeof input !== 'string' || input.length > 80) return null;
  const s = input.replace(/[\s-]/g, '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(s) ? s : null;
}
export const mintSessionId = () => randomBytes(32).toString('base64url');
const SESSION_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** The store's path: an explicit one, else SCRUM_BROWSER_SESSIONS, else the data folder's browser-sessions.json, else null. */
export function sessionsPath({ file, env = process.env } = {}) {
  if (file) return file;
  if (env.SCRUM_BROWSER_SESSIONS) return env.SCRUM_BROWSER_SESSIONS;
  if (env.SCRUM_DATA_DIR) return path.join(env.SCRUM_DATA_DIR, 'browser-sessions.json');
  return null;
}
export const eventsPathFor = (store) => store.replace(/\.json$/, '') + '-events.jsonl';

/** A roster seat is a human person when its entry says kind: "human" (any case). An agent record never is. */
export function isHumanSeat(roster, seat) {
  const s = roster && typeof roster === 'object' && Object.prototype.hasOwnProperty.call(roster, seat) ? roster[seat] : null;
  return !!(s && !s.agent && typeof s.kind === 'string' && s.kind.trim().toLowerCase() === 'human');
}

// ── the file ──────────────────────────────────────────────────────────────────────────────────────────────────────
function emptyDoc() { return { _README: README, codes: [], sessions: [] }; }
export function readStore(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return emptyDoc(); throw e; }
  const d = JSON.parse(raw);
  return { _README: README, codes: Array.isArray(d.codes) ? d.codes : [], sessions: Array.isArray(d.sessions) ? d.sessions : [] };
}
function writeStore(file, doc) {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/**
 * Read-modify-write under `<file>.lock` (O_EXCL). Two writers exist — the script and the server — and the store is small,
 * so the lock is held for one read and one rename. A lock older than 10 s is a crashed writer's and is broken. Gives up
 * after ~2 s with an error rather than writing unlocked.
 */
export function updateStore(file, fn, { now = Date.now() } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  let fd = null;
  for (let i = 0; i < 200 && fd === null; i++) {
    try { fd = fs.openSync(lock, 'wx', 0o600); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) { fs.unlinkSync(lock); continue; } } catch { continue; }
      sleepSync(10);
    }
  }
  if (fd === null) throw new Error(`browser sessions: ${lock} is held; try again`);
  try {
    const doc = readStore(file);
    const out = fn(doc);
    prune(doc, now);
    writeStore(file, doc);
    return out;
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(lock); } catch { /* gone */ }
  }
}
function prune(doc, now) {
  const old = (at) => at && now - Date.parse(at) > KEEP_ENDED_MS;
  doc.codes = doc.codes.filter((c) => !(Date.parse(c.expiresAt) < now - 24 * 3600_000));
  doc.sessions = doc.sessions.filter((s) => !(old(s.endedAt) || old(s.expiresAt)));
}

/** One event, appended (O_APPEND, one line). Only the fields named here are written, so a caller cannot pass a value in. */
export function appendSessionEvent(store, { op, seat = null, at = new Date().toISOString(), reason = null, expiresAt = null, via = null, count = null, fromTerminal = null }) {
  const ev = { at, op, seat, ...(reason ? { reason } : {}), ...(expiresAt ? { expiresAt } : {}), ...(via ? { via } : {}), ...(count != null ? { count } : {}), ...(fromTerminal != null ? { fromTerminal } : {}) };
  fs.appendFileSync(eventsPathFor(store), JSON.stringify(ev) + '\n', { mode: 0o600 });
  return ev;
}
export function readSessionEvents(store, { limit = 50 } = {}) {
  let raw;
  try { raw = fs.readFileSync(eventsPathFor(store), 'utf8'); } catch { return []; }
  return raw.split('\n').filter(Boolean).slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ── the operations (each on a doc, inside updateStore) ───────────────────────────────────────────────────────────────
export function addCode(doc, seat, { now = Date.now() } = {}) {
  const code = mintCode();
  const issuedAt = new Date(now).toISOString(), expiresAt = new Date(now + CODE_TTL_MS).toISOString();
  doc.codes.push({ codeHash: sha256(code), seat, issuedAt, expiresAt, usedAt: null });
  return { code, expiresAt };
}
/** Burn a code: { ok, seat } or { ok:false, reason: 'CODE_UNKNOWN'|'CODE_USED'|'CODE_EXPIRED', seat? }. A found code is burned whatever the answer. */
export function redeemCode(doc, typed, { now = Date.now() } = {}) {
  const c = normalizeCode(typed);
  if (!c) return { ok: false, reason: 'CODE_UNKNOWN' };
  const row = doc.codes.find((r) => r.codeHash === sha256(c));
  if (!row) return { ok: false, reason: 'CODE_UNKNOWN' };
  if (row.usedAt) return { ok: false, reason: 'CODE_USED', seat: row.seat };
  row.usedAt = new Date(now).toISOString();
  if (Date.parse(row.expiresAt) <= now) return { ok: false, reason: 'CODE_EXPIRED', seat: row.seat };
  return { ok: true, seat: row.seat };
}
export function addSession(doc, seat, { now = Date.now() } = {}) {
  const id = mintSessionId();
  const row = { sessionHash: sha256(id), seat, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + SESSION_TTL_MS).toISOString(), lastUsedAt: null, endedAt: null, endedBy: null };
  doc.sessions.push(row);
  return { id, row };
}
export function endSession(doc, sessionHash, how, { now = Date.now() } = {}) {
  const row = doc.sessions.find((s) => s.sessionHash === sessionHash && !s.endedAt);
  if (!row) return null;
  row.endedAt = new Date(now).toISOString(); row.endedBy = how;
  return row;
}
export function revokeAll(doc, seat, { now = Date.now() } = {}) {
  let n = 0;
  for (const s of doc.sessions) if (s.seat === seat && !s.endedAt) { s.endedAt = new Date(now).toISOString(); s.endedBy = 'revoke-all'; n++; }
  for (const c of doc.codes) if (c.seat === seat && !c.usedAt) { c.usedAt = new Date(now).toISOString(); }   // an unused code is burned too
  return n;
}
const live = (s, now) => s && !s.endedAt && Date.parse(s.expiresAt) > now;
/** The live session a cookie value names, or null. */
export function findSession(doc, id, { now = Date.now() } = {}) {
  if (typeof id !== 'string' || !SESSION_SHAPE.test(id)) return null;
  const h = sha256(id);
  const row = doc.sessions.find((s) => s.sessionHash === h);
  return live(row, now) ? row : null;
}
/** The listing: live sessions per seat, never an id or a hash. */
export function listSessions(doc, { now = Date.now() } = {}) {
  return doc.sessions.filter((s) => live(s, now)).map((s) => ({ seat: s.seat, createdAt: s.createdAt, expiresAt: s.expiresAt, lastUsedAt: s.lastUsedAt }));
}

// ── the server's reader: the store re-read when it changes on disk, so a revoke by the script is live at the next request ──
export function createSessionReader(file) {
  let doc = null, key = null;
  const lastUsed = new Map();   // sessionHash → ms last written
  function current() {
    let k = 'absent';
    try { const st = fs.statSync(file); k = `${st.mtimeMs}:${st.size}:${st.ino}`; } catch { /* absent */ }
    if (k !== key || !doc) {
      key = k;
      try { doc = readStore(file); } catch (e) { console.warn(`[#1906] browser sessions store unreadable (${e.message}); every cookie is anonymous`); doc = emptyDoc(); }
    }
    return doc;
  }
  return {
    file,
    /** cookie value → { seat, scope: 'act', expiresAt, via: 'session', sessionHash, createdAt } or null */
    resolve(id, { now = Date.now() } = {}) {
      const row = findSession(current(), id, { now });
      if (!row) return null;
      return { seat: row.seat, scope: 'act', heartbeat_s: null, expiresAt: row.expiresAt, via: 'session', sessionHash: row.sessionHash, createdAt: row.createdAt };
    },
    /** Record use, at most every LAST_USED_EVERY_MS per session. Never throws. */
    touch(sessionHash, { now = Date.now() } = {}) {
      const prev = lastUsed.get(sessionHash) ?? 0;
      if (now - prev < LAST_USED_EVERY_MS) return;
      lastUsed.set(sessionHash, now);
      try {
        updateStore(file, (d) => { const r = d.sessions.find((s) => s.sessionHash === sessionHash); if (r && !r.endedAt) r.lastUsedAt = new Date(now).toISOString(); }, { now });
      } catch (e) { console.warn(`[#1906] could not record a session's use: ${e.message}`); }
    },
    current,
  };
}

// ── the cookie and the origin ────────────────────────────────────────────────────────────────────────────────────
/** The value of one cookie from a Cookie header, or null. */
export function cookieValue(header, name = COOKIE_NAME) {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null;
  }
  return null;
}
export const sessionCookie = (id, maxAgeS = Math.floor(SESSION_TTL_MS / 1000)) =>
  `${COOKIE_NAME}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeS}`;   // no Secure: plain http on loopback (#1906 design 2)
export const clearedCookie = () => `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

/**
 * #1906 design 4 — the second wall behind SameSite=Strict. The request's Origin (or, when the browser sent none, its Referer's
 * origin) must name THIS board: an http(s) origin whose host and EXPLICIT port pass #1338's Host guard. The port is always
 * made explicit (80/443 when the URL has none), because SameSite does not separate ports — a page on another loopback port
 * is the same site — so the port is the line. `null`, an unparseable value, or neither header present is refused.
 */
export function originAllowed(headers, { port, extra = [] }) {
  const fromUrl = (v) => {
    if (typeof v !== 'string' || !v || v === 'null') return null;
    let u; try { u = new URL(v); } catch { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const p = u.port || (u.protocol === 'https:' ? '443' : '80');
    return `${u.hostname}:${p}`;
  };
  const o = headers.origin !== undefined ? fromUrl(headers.origin) : fromUrl(headers.referer);
  return !!o && hostAllowed(o, { port, extra });
}
