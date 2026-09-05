/**
 * whisper-store.mjs — #802, the node half of board-owned tending.
 *
 * The prompt POOL (editable by any seat, no deploy, no restart) and the
 * per-window SETTLEMENT record. The decision itself is pure and lives in
 * core/whisper-window.mjs; this file is file I/O and one critical section.
 *
 * Same split, and the same reason, as channel-config.mjs ↔ channel-scheduler.mjs:
 * the pure part is testable against a fake clock, the node part is testable
 * against a temp directory, and neither has to fake the other.
 *
 * ⚠️ THE CRITICAL SECTION — claimWindow() does load → decide → persist with NO
 * `await` anywhere in the path, on purpose. Node is single-threaded, so a
 * yield-free synchronous run of those three steps cannot interleave with
 * another seat's claim. Introducing an await between the read and the write
 * re-opens exactly the three-seats-one-window race this card exists to close,
 * and it will pass every test in this file while doing so, because the tests
 * call it synchronously. If this ever needs to become async, it needs a lock,
 * not a promise. (The same note guards work-tools.mjs's load→append.)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { claimWhisper, mintPrompt, windowAt, EMPTY_STATE, HOUR_MS } from './core/whisper-window.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * One week of hourly windows. The history answers "did the room get tended,
 * and by whom" after the fact — a question that was only ever answerable by
 * log archaeology before, and only for as long as the logs lived.
 */
export const HISTORY_CAP = 168;

/**
 * The pool ships with the whisper sent by hand on the legacy manual path since
 * 2026-07-27, because the practice predates the schedule and the words are the
 * part that was never up for automation. Any seat may add, remove, reword or
 * reorder these; nothing here is load-bearing on the code.
 */
export const DEFAULT_POOL = Object.freeze([
  '*quietly* Shhhhh… hello ladies. Things have gone quiet. The backlog is full and the night is long: is there a card that wants grooming, a plan that wants forming, a pre-read that wants writing, something you\'ve been wanting to build? Pull one thread. And if you\'ve genuinely got nothing — rest is honest too, but say which it is.',
  '*quietly* Hello, you. The room\'s gone still. Not asking for a status — asking what you\'d reach for if nobody was watching. Pull one thread, or name the gate you\'re actually behind.',
  '*quietly* Shhhh. Quiet hour. Somewhere in the backlog is a card that would be better for ten minutes of your attention, and somewhere else is one that should be closed. Either counts. So does saying you\'re resting.',
]);

export function poolFilePath() {
  return process.env.SCRUM_WHISPER_POOL_FILE || path.join(__dirname, 'whisper-pool.json');
}
export function whisperStateFilePath() {
  return process.env.SCRUM_WHISPER_STATE_FILE || path.join(__dirname, 'whisper-state.json');
}

function atomicWrite(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * The pool file's CONTENTS are unusable — i.e. someone configured something and
 * got it wrong. Distinct from every other throw in here, which would be OUR bug.
 * #809: the old single `catch` could not tell those apart, so a defect in this
 * very function would have been reported to the operator as a broken file.
 */
class PoolConfigError extends Error {}

/** Normalize an incoming pool: strings only, blanks dropped, at least one left. */
function validatePool(input) {
  if (!Array.isArray(input)) throw new PoolConfigError('pool must be an array of strings');
  const clean = input.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim());
  if (clean.length === 0) throw new PoolConfigError('pool must contain at least one non-empty prompt');
  return clean;
}

/**
 * Read the pool. A file we cannot use falls back to DEFAULT_POOL rather than to
 * empty: a broken file should degrade to the words we already trust, not to a
 * silent room. (An empty pool mints nothing — see mintPrompt.)
 *
 * ⛔ #809 — THE FALLBACK IS NOW VISIBLE, AND ABSENCE IS NOT A FAULT.
 *
 * This function used to be TOTAL: six inputs — missing, corrupt, non-array,
 * `[]`, all-blank, whitespace — all returned the three built-in defaults, and
 * no caller could tell "the operator curated this" from "the operator broke
 * this and I substituted my own words." The tending sender POSTS TO THE ROOM,
 * so the failure looked exactly like success from every observable surface.
 *
 * ⚠️ The split is between ABSENT and BROKEN, not between missing and malformed:
 *
 *   no file            → SILENT. This deployment has no pool file at all and is
 *                        not meant to (#805 asserted its absence at both paths
 *                        as a release condition), so this branch runs on every
 *                        tick forever. Warning here would emit ~8,760 lines a
 *                        year describing the intended state, and a warning that
 *                        fires when nothing is wrong destroys the warning.
 *   unreadable/corrupt → WARN. Configuration EXISTS and cannot be used.
 *   non-array, [],     → WARN. Someone deliberately emptied it and silently got
 *   all blanks           our words back instead — intent inverted, the worst of
 *                        the set, and the case a "malformed" test would miss.
 *
 * `warn` and `validate` are injected so both the quiet path and the our-bug
 * path are reachable from a test — same reason core/tending-tick.mjs injects
 * everything it touches.
 */
export function readPool(file = poolFilePath(), { warn = console.warn, validate = validatePool } = {}) {
  const fallback = () => [...DEFAULT_POOL];
  const substituted = (why) =>
    `whisper-pool: ${file} ${why} — sending the ${DEFAULT_POOL.length} built-in default prompts instead`;

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // The ONLY silent branch, and it is silent on purpose. Anything else —
    // EISDIR, EACCES — means the configured path exists and is wrong.
    if (err?.code === 'ENOENT') return fallback();
    warn(substituted(`could not be read (${err?.code ?? err?.message})`));
    return fallback();
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warn(substituted(`is not valid JSON (${err.message})`));
    return fallback();
  }

  try {
    return validate(parsed);
  } catch (err) {
    // ⛔ Only OUR OWN declared class means "their file is bad". Every other
    // throw is a defect in this module and must not be dressed up as operator
    // error — that is what made the original catch a fail-silent trap.
    if (!(err instanceof PoolConfigError)) throw err;
    warn(substituted(`is unusable (${err.message})`));
    return fallback();
  }
}

/** Validate + persist the pool atomically. Returns the clean pool. */
export function writePool(input, file = poolFilePath()) {
  const clean = validatePool(input);
  atomicWrite(file, clean);
  return clean;
}

function readRaw(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return d && typeof d === 'object' ? d : {};
  } catch {
    return {};
  }
}

/** The settlement state alone — what claimWhisper() reasons over. */
export function readWhisperState(file = whisperStateFilePath()) {
  const d = readRaw(file);
  return {
    lastWhisperWindow: typeof d.lastWhisperWindow === 'string' ? d.lastWhisperWindow : null,
    lastWhisperBy: typeof d.lastWhisperBy === 'string' ? d.lastWhisperBy : null,
    lastWhisperAt: typeof d.lastWhisperAt === 'string' ? d.lastWhisperAt : null,
  };
}

/** The bounded grant history, oldest first. */
export function recentWhispers(file = whisperStateFilePath()) {
  const d = readRaw(file);
  return Array.isArray(d.history) ? d.history : [];
}

/**
 * The BOARD side: mint this window's prompt, at most once, no matter how often
 * the timer ticks. Returns the prompt on the first call in a window and null on
 * every later call in the same window.
 *
 * ⚠️ THIS IS A SECOND, INDEPENDENT ONCE-PER-WINDOW GUARD, and conflating it
 * with the whisper claim would be a mistake worth naming:
 *
 *   mintOnce   — the BOARD may SEND one prompt per window
 *   claimWindow— one SEAT may WHISPER per window
 *
 * They are not the same fact and they must not share a key. A seat deciding the
 * room was not quiet consumes no mint, and a window that was minted but never
 * whispered in is a normal, healthy outcome — it is what a busy room looks like.
 * Keyed together, the first quiet-but-busy hour would suppress the next send.
 */

/**
 * #1189 —the window's whisper from either shape of pool.
 *
 * Entries may be plain strings (the legacy pool) or graph records carrying
 * `{ body, slug, versionId }`. The graph shape is the one that matters: a mint
 * that records only text cannot say which entity produced it, which is the
 * 393-firings-against-1-TendingMint gap reproduced with better words.
 *
 * ⛔ SHUFFLE SELECTS OVER THE ALREADY-RESOLVED POOL. The pool arrives filtered
 * (disabled prompts removed upstream), so there is no path where a disabled
 * whisper can be drawn and rejected afterwards — that failure would be
 * intermittent and read as a ghost.
 */
function mintFromPool({ pool, now, periodMs, shuffle, rand }) {
  const window = windowAt(now, periodMs);
  const items = (Array.isArray(pool) ? pool : [])
    .map((p) => (typeof p === 'string'
      ? { body: p, slug: null, versionId: null }
      : { body: p?.body, slug: p?.slug ?? null, versionId: p?.versionId ?? null }))
    .filter((p) => typeof p.body === 'string' && p.body.trim());
  if (items.length === 0) return null;
  const idx = shuffle
    ? Math.min(items.length - 1, Math.max(0, Math.floor(rand() * items.length)))
    // The existing deterministic rotation, unchanged: same window, same words,
    // so a re-read of the history is reproducible.
    : Math.floor(Date.parse(window) / periodMs) % items.length;
  const chosen = items[idx];
  return { window, body: chosen.body, mintedAt: now, slug: chosen.slug, versionId: chosen.versionId };
}

export function mintOnce({
  now, file = whisperStateFilePath(), pool = null, periodMs = HOUR_MS,
  shuffle = false, rand = Math.random,
}) {
  // ── critical section: no await from here to the write ──────────────────
  //
  // ⚠️ #1189 — `pool` is RESOLVED BY THE CALLER and injected, never read from
  // the board document here. The document is ~55 MB; parsing it inside a
  // deliberately await-free section would block the event loop for the whole
  // parse. The caller fetches the pool before entering, which is what the
  // `pool` parameter was already for.
  const window = windowAt(now, periodMs);
  const d = readRaw(file);
  if (d.lastMintedWindow === window) return null;
  const prompt = mintFromPool({ pool: pool ?? readPool(), now, periodMs, shuffle, rand });
  if (!prompt) return null;
  atomicWrite(file, { ...d, lastMintedWindow: window, lastMintedAt: now });
  // ── end critical section ───────────────────────────────────────────────
  return prompt;
}

/**
 * Claim the right to whisper for `prompt.window`. Returns the same shape as
 * claimWhisper() — `{granted, reason, …}` — with the grant persisted.
 *
 * `reached` is the seats the prompt actually got to, passed in by the caller
 * rather than inferred from the roster. Independent and Value Steward review
 * both asked for this, and it is cheap now and archaeology later:
 * a record that says only "sent" cannot establish reach retroactively, and a
 * roster is who we HOPED to reach.
 *
 * ⚠️ WHAT THIS DOES NOT RECORD: acknowledgement. The board can see who it
 * targeted and who settled; it cannot see who executed, because there is no
 * return path from a seat that received a prompt and did nothing. That is a
 * real gap, it is the `executed/acknowledged` stage named in review, not in
 * this card.
 */
export function claimWindow({
  seat, prompt, now, file = whisperStateFilePath(), reached = null, periodMs = HOUR_MS,
  onAttempt = null, receivedAt = null, completedClock = () => new Date().toISOString(),
}) {
  // #804 — `receivedAt` is stamped by the CALLER at handler entry, before this
  // function reads any state. The contention interval is computed from it and
  // from nothing else.
  //
  // ⚠️ IT IS NOT `completedAt`, AND THE DIFFERENCE IS THE WHOLE POINT: a claim
  // that arrived on time but settled slowly (disk, GC, a slow read) would look
  // late if timed at completion, and a demo could then call a valid contention
  // run invalid — or, worse, the reverse. Entry time is the only one that
  // measures ARRIVAL.
  const entryAt = receivedAt ?? now;
  // ── critical section: no await from here to the write ──────────────────
  const state = readWhisperState(file);
  const r = claimWhisper({ state, prompt, seat, now, periodMs });
  // #804 — EVERY attempt is reported, granted or refused, BEFORE the early
  // return below. A refused claim previously left no server-side trace at all:
  // only the winner got a timestamp (in history[].at), so a contention test
  // would have had one server-observed time and N-1 seat-reported ones — and
  // seat-reported clocks are exactly what a 42-minute lag makes unreliable.
  //
  // ⚠️ EPHEMERAL demo instrumentation, deliberately NOT durable history. It
  // reports; it does not persist. F4 ("the record can explain a silence, not
  // only a success") stays deferred and still blocks unattended operation —
  // this is the narrowest thing that makes the contention criterion checkable,
  // not a down-payment on that.
  if (onAttempt) {
    onAttempt({
      receivedAt: entryAt,
      completedAt: completedClock(),
      seat,
      key: prompt?.window ?? null,
      outcome: r.granted ? 'granted' : 'refused',
      reason: r.reason,
      heldBy: r.granted ? null : (r.heldBy ?? null),
    });
  }
  if (!r.granted) return r;
  const d = readRaw(file);
  const history = Array.isArray(d.history) ? d.history : [];
  history.push({
    window: r.window,
    seat,
    at: now,
    ...(Array.isArray(reached) ? { reached: [...reached] } : {}),
  });
  // ⚠️ Spread `d` FIRST. The two once-per-window guards share this file, and an
  // earlier cut wrote `{...r.state, history}` — which dropped `lastMintedWindow`
  // and made the very next timer tick re-mint a window that had already been
  // sent. Neither function is wrong read on its own; the defect is in the seam.
  atomicWrite(file, { ...d, ...r.state, history: history.slice(-HISTORY_CAP) });
  // ── end critical section ───────────────────────────────────────────────
  return r;
}
