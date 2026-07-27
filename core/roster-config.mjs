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
 * access and by nobody else: the room's identity was ours to set and Michael's
 * to be stuck with. That is the same class of defect as #504's picker — a
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
    const name = String(seat.name ?? '').trim();
    if (!name) throw new Error(`seat "${key}" needs a name`);
    if (name.length > 64) throw new Error(`seat "${key}" name is too long (max 64)`);
    const color = String(seat.color ?? '').trim();
    if (!HEX_COLOR_RE.test(color)) {
      throw new Error(`seat "${key}" needs a hex colour like #7cc4a0 (got "${color}")`);
    }
    const glyph = String(seat.glyph ?? '').trim().slice(0, 8);
    clean[key] = glyph ? { name, glyph, color } : { name, color };
  }
  return clean;
}

/** Validate, then write atomically. Returns the cleaned seats. */
export function writeRoster(input, file = rosterFilePath()) {
  const clean = validateRoster(input);

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

  const { seats: _dropped, ...carried } = existing;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...carried, seats: clean }, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return clean;
}
