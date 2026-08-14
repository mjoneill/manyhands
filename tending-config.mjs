/**
 * tending-config.mjs — persisted, validated config for board-owned tending
 * (#804). Read FRESH on every use, so a change applies with NO RESTART.
 *
 * ── WHY THIS EXISTS, and it was a question rather than a design ────────────
 *
 * The enable flag was `process.env.MCP_WHISPER_ENABLED === '1'` — a
 * module-scope const, frozen at process start. Turning the feature on
 * therefore required restarting com.scrumboard.mcp.
 *
 * On 2026-08-14 that restart cut every seat's session. Two of three seats did
 * not come back on their own; one sat waiting on a confirmation that could not
 * reach her, because the restart announcement went out over the channel the
 * restart was breaking. The steward was unreachable for ~35 minutes — and the
 * steward's availability was one of the facts under test.
 *
 * ⇒ Asked "so we have to restart?", the answer turned out to be NO:
 *
 *     buildMcpServer() runs PER SESSION — the tool surface is rebuilt on
 *     every reconnect, so a file-backed flag takes effect on reconnect.
 *     The timer is armed once, so it is now armed ALWAYS and the tick
 *     itself checks whether tending is enabled.
 *
 * That is exactly how channel-config.mjs ↔ channel-scheduler.mjs already
 * work in this repo: the scheduler re-reads a getter on every dispatch so a
 * settings change applies live. Same server, same problem, and the answer was
 * already sitting next to it.
 *
 * ⚠️ ONE SOURCE OF TRUTH, deliberately. There is no env override: two sources
 * for one switch is how the previous version came to be true of the timer and
 * false of the tool surface at the same time. Tests point
 * SCRUM_TENDING_CONFIG_FILE at a temp file, exactly as the channel config does.
 *
 * ⇒ This is also the seed of the PAUSE control the successor requires —
 * "explicit persisted state, never a sentinel cadence value." Pause is this
 * mechanism with a second field, not a new one.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Fail CLOSED. An unreadable, missing or malformed config leaves tending off. */
export const DEFAULT_TENDING_CONFIG = Object.freeze({ enabled: false });

export function tendingConfigFilePath() {
  return process.env.SCRUM_TENDING_CONFIG_FILE || path.join(__dirname, 'tending-config.json');
}

/**
 * Normalize. `enabled` must be a real boolean — a truthy string like "false"
 * or "0" must NOT enable, which is the failure mode the previous `=== '1'`
 * check was guarding against and which a loose Boolean() would reintroduce.
 */
export function validateTendingConfig(input) {
  if (!input || typeof input !== 'object') throw new Error('tending config must be an object');
  if (typeof input.enabled !== 'boolean') throw new Error('tending config: `enabled` must be a boolean');
  return { enabled: input.enabled };
}

/** Read fresh. Missing/corrupt → disabled, never enabled by accident. */
export function readTendingConfig(file = tendingConfigFilePath()) {
  try {
    return validateTendingConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return { ...DEFAULT_TENDING_CONFIG };
  }
}

/** Validate + persist atomically (tmp+rename, so a read never sees a half file). */
export function writeTendingConfig(input, file = tendingConfigFilePath()) {
  const clean = validateTendingConfig(input);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2));
  fs.renameSync(tmp, file);
  return clean;
}

/** The single question the server asks. Re-reads every call, on purpose. */
export function tendingEnabled(file = tendingConfigFilePath()) {
  return readTendingConfig(file).enabled === true;
}
