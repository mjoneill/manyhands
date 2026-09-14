/**
 * core/roster-config.mjs — reads the optional roster.json from disk.
 *
 * Exists so that `core/identity.mjs` never has to. That module is imported by
 * the browser as well as by node, so it cannot touch `fs`; this one is the
 * node-side half of the pair and is never loaded in a page.
 *
 * The file is OPTIONAL by design. A fresh clone has no roster.json and must
 * still boot and render — the shipped example roster covers that. Configuring
 * your own people should be something you do when you want to, not a step
 * standing between you and a working board.
 *
 * The file lives OUTSIDE version control (see .gitignore). That is the whole
 * point: who your team is should never conflict with a `git pull`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Where the roster lives. Overridable so tests and multiple instances don't collide. */
export function rosterFilePath() {
  return process.env.SCRUM_ROSTER_FILE || path.join(PROJECT_DIR, 'roster.json');
}

/**
 * Load the roster, or null when there isn't a usable one.
 *
 * Never throws. A missing file is the normal case, and a corrupt file must not
 * take the board down — a broken roster costs you colours, and that is not
 * worth a server that won't start. `onWarn` is called with a human-readable
 * reason so the caller can say something out loud instead of failing silently:
 * a config that is quietly ignored is a config you will debug twice.
 */
export function loadRoster(file = rosterFilePath(), onWarn = () => {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // ENOENT is the expected, unremarkable case — say nothing about it.
    if (err.code !== 'ENOENT') onWarn(`could not read ${file}: ${err.message}`);
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    onWarn(`${file} is not valid JSON (${err.message}) — using the example roster`);
    return null;
  }

  // Allow either a bare map or { seats: {...} }, since both read naturally and
  // guessing wrong shouldn't cost anyone twenty minutes.
  const seats = parsed && typeof parsed === 'object' && parsed.seats ? parsed.seats : parsed;
  if (!seats || typeof seats !== 'object' || Array.isArray(seats)) {
    onWarn(`${file} should be an object of seats — using the example roster`);
    return null;
  }
  return seats;
}

/**
 * #506 — write the roster back, so a human can edit their own room.
 *
 * Until this existed, the roster was configurable by anyone with filesystem
 * access and by nobody else: the room's identity was ours to set and the
 * deployment's own humans' to be stuck with. That is the same class of defect as #504's picker — a
 * deployment's own people unreachable through its own interface.
 *
 * Validation is deliberately narrow rather than clever. Keys become object keys
 * and DOM attribute values; colours land in inline styles. Anything outside a
 * conservative shape is refused with a reason the operator can act on, because
 * a config that is quietly ignored is a config you will debug twice — the same
 * reasoning loadRoster already applies in the other direction.
 *
 * Atomic tmp+rename, mirroring channel-config: a reader must never see a
 * half-written roster, least of all the boot path that repaints the whole room.
 */
const SEAT_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function validateRoster(input) {
  const seats = input && typeof input === 'object' && input.seats ? input.seats : input;
  if (!seats || typeof seats !== 'object' || Array.isArray(seats)) {
    throw new Error('roster must be an object of seats');
  }
  const keys = Object.keys(seats);
  if (keys.length === 0) throw new Error('a roster with no seats would empty the room — add at least one');
  if (keys.length > 64) throw new Error('more than 64 seats is almost certainly a mistake');

  const clean = {};
  for (const key of keys) {
    if (!SEAT_KEY_RE.test(key)) {
      throw new Error(`seat key "${key}" must be letters, digits, dash or underscore (max 32)`);
    }
    const seat = seats[key];
    if (!seat || typeof seat !== 'object') throw new Error(`seat "${key}" must be an object`);
    // #1380 — a seat the API MERGED from an agent record (`agent: true`) is not
    // the file's to keep: written here it would shadow the record and outlive
    // its deletion. Dropped, and named by droppedAgentSeats() so the save can
    // say so; never silently absorbed.
    if (seat.agent === true) continue;
    const name = String(seat.name ?? '').trim();
    if (!name) throw new Error(`seat "${key}" needs a name`);
    if (name.length > 64) throw new Error(`seat "${key}" name is too long (max 64)`);
    const color = String(seat.color ?? '').trim();
    if (!HEX_COLOR_RE.test(color)) {
      throw new Error(`seat "${key}" needs a hex colour like #7cc4a0 (got "${color}")`);
    }
    const glyph = String(seat.glyph ?? '').trim().slice(0, 8);
    // #619 — carry `aliases` through.
    //
    // Without this the field is destroyed by any settings-UI save, silently and
    // with nothing in the diff to explain it: alias resolution would simply stop
    // working one afternoon. That is precisely the lesson writeRoster records
    // below about `_README` — "rebuilding the file from only the fields you know
    // about is indistinguishable from deleting the rest" — which was learned at
    // the FILE level while the same defect sat one level down, per SEAT, in the
    // function that comment's own writer calls.
    const aliases = Array.isArray(seat.aliases)
      ? [...new Set(seat.aliases
          .filter((a) => typeof a === 'string' && a.trim())
          .map((a) => a.trim().slice(0, 64)))]
      : [];
    if (aliases.length > 16) throw new Error(`seat "${key}" has more than 16 aliases`);
    // #1380 — carry `kind` through. It is the history gate's ONLY opt-out
    // (#600: `kind: system` on `board` and `wiki`); a save that dropped it
    // armed the gate on the words "board" and "wiki" and refused every push.
    // A string rides verbatim; anything else is not a kind and is not smuggled.
    const kind = typeof seat.kind === 'string' && seat.kind.trim() ? seat.kind.trim() : null;
    clean[key] = {
      name,
      ...(glyph ? { glyph } : {}),
      color,
      ...(aliases.length ? { aliases } : {}),
      ...(kind ? { kind } : {}),
    };
  }
  if (Object.keys(clean).length === 0) throw new Error('a roster with no seats of its own would empty the room — every seat sent was an agent record');
  return clean;
}

/** #1380 — the seat keys a save will leave out because they are merged agent records, so the caller can say so. */
export function droppedAgentSeats(input) {
  const seats = input && typeof input === 'object' && input.seats ? input.seats : input;
  if (!seats || typeof seats !== 'object' || Array.isArray(seats)) return [];
  return Object.entries(seats).filter(([, v]) => v && typeof v === 'object' && v.agent === true).map(([k]) => k);
}

/**
 * #1368 — ROLES beside seats. `roles.po` names the seat holding the Product
 * Owner grant, so "Groom this" can mention the PO by READING the board rather
 * than hardcoding a name. Interim by design: #915's Role entity replaces it
 * when it lands; until then this is the one place the grant is queryable.
 * Closed vocabulary — an unknown role key is refused, not stored.
 */
export const ROLE_KEYS = new Set(['po']);

export function validateRoles(input, seats) {
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('roles must be an object like { "po": "seatKey" }');
  const clean = {};
  for (const [role, seat] of Object.entries(input)) {
    if (!ROLE_KEYS.has(role)) throw new Error(`unknown role "${role}" — the roster knows: ${[...ROLE_KEYS].join(', ')}`);
    const key = String(seat ?? '').trim();
    if (!key) continue;   // an empty value clears the role
    if (!seats || !Object.prototype.hasOwnProperty.call(seats, key)) throw new Error(`role ${role} names "${key}", which is not a seat in this roster`);
    clean[role] = key;
  }
  return clean;
}

/** The roles in the file, or {} — never a throw; a roster without roles is the normal case. */
export function loadRosterRoles(file = rosterFilePath()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const roles = parsed && typeof parsed === 'object' ? parsed.roles : null;
    if (!roles || typeof roles !== 'object' || Array.isArray(roles)) return {};
    const out = {};
    for (const [k, v] of Object.entries(roles)) if (ROLE_KEYS.has(k) && typeof v === 'string' && v.trim()) out[k] = v.trim();
    return out;
  } catch { return {}; }
}

/**
 * Validate, then write atomically. Returns the cleaned seats (and, when the
 * caller passed `roles`, writes those too — a save that says nothing about
 * roles keeps the file's; an explicit empty value clears one).
 */
export function writeRoster(input, file = rosterFilePath()) {
  const clean = validateRoster(input);
  const rolesGiven = input && typeof input === 'object' && Object.prototype.hasOwnProperty.call(input, 'roles');
  const roles = rolesGiven ? validateRoles(input.roles, clean) : null;

  // Preserve everything in the file we did not come here to change.
  //
  // The first version wrote `{ seats: clean }` and nothing else, which silently
  // destroyed the file's `_README` block — nineteen lines explaining what the
  // file is, why it lives outside version control, and that an unlisted author
  // still renders. One save from the settings UI and the documentation was gone,
  // with no error and nothing in the diff to suggest it was unintentional.
  //
  // The general rule, which matters more than this one block: a writer that
  // round-trips a config file owns the whole file, including the parts it does
  // not understand. Rebuilding the file from only the fields you know about is
  // indistinguishable from deleting the rest.
  let existing = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
  } catch { /* no file yet, or unreadable — a fresh write is the right outcome */ }

  const { seats: _dropped, roles: _oldRoles, ...carried } = existing;
  const keptRoles = roles ?? loadRosterRoles(file);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...carried, ...(Object.keys(keptRoles).length ? { roles: keptRoles } : {}), seats: clean }, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return clean;
}
