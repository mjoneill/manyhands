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
