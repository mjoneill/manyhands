/**
 * core/withheld-log.mjs — #1952 A BOUNDED, PER-SEAT LOCAL LOG OF WITHHELD REPLIES.
 *
 * The #1428 withheld file (core/withheld-state.mjs) is a HAND-BACK: it holds
 * only the newest held-back reply and is cleared after one receiving wake. So
 * a reply a resident wrote and withheld was gone after the next decline or the
 * next wake, and "she never answered" could not be checked (measured
 * 2026-11-15/16: a 174-token reply, `declined:explicit`, unrecoverable).
 *
 * This file is the RECORD beside it:
 *
 *   1. APPENDED every time the runner parks text in the #1428 file, with
 *      { text, at, wakeId, wakeKind, reason, tokens, model }.
 *   2. BOUNDED: the last WITHHELD_LOG_MAX_ENTRIES entries AND nothing older
 *      than WITHHELD_LOG_MAX_AGE_MS; whichever bound is tighter wins. An entry
 *      whose `at` cannot be read is dropped (it could otherwise live forever).
 *   3. PRIVATE: written atomically (tmp + rename) at mode 0600, beside the
 *      seat's state file. It never reaches the board row, REST, the graph,
 *      the prompt, or a runner log line beyond counts.
 *   4. NEVER FEEDS THE PROMPT. The hand-back stays the #1428 file's job; this
 *      log is read only by the machine's owner (scripts/withheld-log.mjs).
 *   5. FAILS OPEN. A missing log is the normal first case; a corrupt one is
 *      moved aside (kept, not destroyed) and a fresh one started; an unwritable
 *      one throws to the runner, which reports a count and lets the wake finish.
 *
 * ⛔ PRIVACY LINE (#1952): read locally by the machine's owner, never posted or
 * quoted to the room without the seat's say-so. A standalone NO_REPLY is also
 * a resident's deliberate choice of silence (#1351), so some entries are drafts
 * she chose not to send.
 *
 * Shape on disk: { "version": 1, "entries": [ {…}, … ] }, oldest first.
 */
import fs from 'node:fs';
import path from 'node:path';

export const WITHHELD_LOG_VERSION = 1;
export const WITHHELD_LOG_MAX_ENTRIES = 10;
export const WITHHELD_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The log's location: beside the seat's state file, like the #1428 file. */
export function defaultWithheldLogPath(stateFile) {
  if (!stateFile) return null;
  return `${stateFile}.withheld-log.json`;
}

function cleanEntry(e) {
  if (!e || typeof e !== 'object' || typeof e.text !== 'string' || !e.text) return null;
  return {
    text: e.text,
    at: typeof e.at === 'string' ? e.at : null,
    wakeId: typeof e.wakeId === 'string' ? e.wakeId : null,
    wakeKind: typeof e.wakeKind === 'string' ? e.wakeKind : null,
    reason: typeof e.reason === 'string' ? e.reason : null,
    tokens: Number.isFinite(e.tokens) ? e.tokens : null,
    model: typeof e.model === 'string' ? e.model : null,
  };
}

/**
 * Read the log. Never throws. `status` says which case it was, so a caller can
 * count a corrupt file instead of mistaking it for an empty one:
 *   ok      — parsed; `entries` oldest first
 *   missing — no file (the normal first case)
 *   corrupt — the file exists but is not a log; `entries` is []
 */
export function readWithheldLog(file) {
  if (!file) return { entries: [], status: 'missing' };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { return e?.code === 'ENOENT' ? { entries: [], status: 'missing' } : { entries: [], status: 'corrupt' }; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { entries: [], status: 'corrupt' }; }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) return { entries: [], status: 'corrupt' };
  return { entries: parsed.entries.map(cleanEntry).filter(Boolean), status: 'ok' };
}

/** Apply both bounds. Age first, then count; the tighter one decides what is left. */
export function boundWithheldEntries(entries, nowMs, { maxEntries = WITHHELD_LOG_MAX_ENTRIES, maxAgeMs = WITHHELD_LOG_MAX_AGE_MS } = {}) {
  const floor = nowMs - maxAgeMs;
  return entries
    .filter((e) => { const t = Date.parse(e.at); return Number.isFinite(t) && t >= floor; })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(-maxEntries);
}

/** tmp + rename at 0600; the chmod pins the mode on an overwrite too (writeFileSync's mode applies only on create). */
function writeAtomic0600(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}

/**
 * Append one entry and rewrite the bounded log. Returns
 *   { kept, corrupt }  — how many entries the file now holds, and whether an
 *                        unreadable log was moved aside to make room for it.
 * THROWS on a write failure (the runner catches it and reports a count). The
 * thrown message names the error code, never the text.
 */
export function appendWithheldLog(file, entry, { now = Date.now() } = {}) {
  if (!file) throw new Error('appendWithheldLog: file is required');
  const clean = cleanEntry(entry);
  if (!clean) throw new Error('appendWithheldLog: entry.text (non-empty string) is required');
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const prior = readWithheldLog(file);
  let corrupt = false;
  if (prior.status === 'corrupt') {
    corrupt = true;
    // Keep the unreadable file, aside; never destroy a record we could not read.
    try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* the write below replaces it either way */ }
  }
  const entries = boundWithheldEntries([...prior.entries, clean], Number.isFinite(nowMs) ? nowMs : Date.now());
  try { writeAtomic0600(file, { version: WITHHELD_LOG_VERSION, entries }); }
  catch (e) {
    const err = new Error(`withheld-log write failed (${e?.code ?? e?.name ?? 'unknown'})`);
    err.code = e?.code ?? e?.name ?? 'unknown';
    throw err;
  }
  return { kept: entries.length, corrupt };
}

/** Human-readable rendering, newest first. For the owner's local read command only. */
export function formatWithheldLog(entries) {
  if (!entries.length) return 'No withheld replies in the log.';
  return [...entries].reverse().map((e, i) => [
    `── ${i + 1}. ${e.at ?? '(no time)'} · ${e.wakeKind ?? '?'} ${e.wakeId ?? '(no wake id)'} · ${e.reason ?? '?'} · ${e.tokens ?? '?'} tokens · ${e.model ?? '?'}`,
    e.text,
  ].join('\n')).join('\n\n');
}
