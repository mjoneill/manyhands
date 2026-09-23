/**
 * core/withheld-state.mjs — #1428 PRIVACY-CORRECT RECOVERY.
 *
 * The seat's NEXT-WAKE hand-back lives here, not on the board's model-call
 * row. The contract under privacy review:
 *
 *   1. RETAINED — the FULL withheld text lives in this per-seat file, in the
 *      runner's own process local. The author reads it back via the SAME
 *      file on the next wake (resident only). It is NEVER on the board row,
 *      REST, or graph.
 *
 *   2. NOT AUTO-REPLAYED — the next wake receives the text in its prompt as
 *      recoverable body; the loop never posts it as a replacement reply.
 *
 *   3. ONE-SHOT — a successful receiving wake clears the pending entry.
 *
 *   4. GUESTS NEVER SEE THIS — `readWithheldState` for a seat that does not
 *      own a state file returns `{ pending: null, version: 1 }`.
 *
 * The shape on disk:
 *   { "version": 1, "pending": { "text": "...", "reason": "standalone-no-reply",
 *                                "wakeId": "...", "at": "ISO" } | null }
 *
 * ⛔ WHY A SEPARATE FILE, NOT A FIELD ON `agent.guest-state.json`. That file
 * is read once at wake and rewritten at the end with the cursor. The withheld
 * state must round-trip through the wake that received it WITHOUT racing the
 * cursor write, so it lives in its own file: a partial wake (failed mid-way)
 * leaves the cursor where it was and the withheld state untouched, which is
 * what the slice's failed-call test asserts.
 *
 * ⛔ WHY A FILE, NOT A BOARD ROW. The model-call row reaches /api/model-calls
 * for ANYONE with a board token. A withheld reply is the resident's
 * deliberation — what she chose not to publish. Publishing it to a public
 * surface, even as "withheld", is the privacy leak the card exists to fix.
 * The runner's private file is the matching location: only this resident's
 * runner reads it.
 *
 * ⛔ GUESTS. Guest seats do not own runners for resident-private state.
 * `readWithheldState(seat, file)` for a guest returns `{pending: null}`,
 * and the runner never calls `writePending` for one. `priorWithheld` is
 * resident-only at the loop boundary (`agent.residency === 'resident'`).
 */
import fs from 'node:fs';
import path from 'node:path';

export const WITHHELD_STATE_VERSION = 1;

/** Empty default state — versioned, nothing pending. */
export function emptyWithheldState() {
  return { version: WITHHELD_STATE_VERSION, pending: null };
}

/**
 * Read the private state file. Returns the parsed shape or the empty
 * default if the file is absent / unreadable / malformed — and never
 * throws (a missing file at first wake is the normal case).
 *
 * ⛔ Never returns a partial shape with `pending` as a stale object whose
 * fields are corrupted: a malformed file is treated as empty.
 */
export function readWithheldState(file) {
  if (!file) return emptyWithheldState();
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return emptyWithheldState(); }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return emptyWithheldState(); }
  if (!parsed || typeof parsed !== 'object') return emptyWithheldState();
  const version = Number(parsed.version);
  const pending = (() => {
    const p = parsed.pending;
    if (!p || typeof p !== 'object') return null;
    if (typeof p.text !== 'string' || !p.text) return null;
    return {
      text: p.text,
      reason: typeof p.reason === 'string' ? p.reason : 'standalone-no-reply',
      wakeId: typeof p.wakeId === 'string' ? p.wakeId : null,
      at: typeof p.at === 'string' ? p.at : null,
    };
  })();
  return {
    version: Number.isFinite(version) && version >= 1 ? version : WITHHELD_STATE_VERSION,
    pending,
  };
}

/**
 * Atomically write the next-state to the file. The file's PARENT directory
 * is created on demand so a seat's first withheld reply does not require a
 * setup step.
 *
 * ⛔ NEVER REWRITES UNRELATED DATA. We own this file: nothing else
 * (cursor, deliveries, anything else) lives here. The runner calls either
 * `writePending` or `clearPending` per-wake outcome.
 *
 * #1428 LOUD FAILURE — DISK-LEVEL FAILURES MUST NOT BE SWALLOWED. The
 * pre-fix code tried the atomic rename, then a direct write, and on
 * EITHER failure returned as if everything were fine. That is the shape
 * of #1441 aimed at the runner's own recovery: silently confident green
 * while the recoverable body was NEVER written. A runner that believes
 * recoverability exists when nothing was retained will eventually emit a
 * public row whose reason says "withheld — recoverable next wake" and
 * whose file says otherwise. The fix: try atomic, then fallback; if BOTH
 * fail, throw with the file path AND the underlying error. The runner
 * catches the throw and emits a loud onError diagnostic that names
 * #1428 and the operation; the public row is NOT made.
 *
 * #1428 REVIEW: the file is written with MODE 0600 — owner
 * read+write only, no group, no other. The recoverable body is the
 * seat's deliberation; only the seat's own runner reads it. A file
 * readable by the group or the world is a leak. POSIX `fs.writeFileSync`
 * honours the mode bit only when the file is CREATED (not when it is
 * overwritten); the chmod call covers the overwrite path so a file that
 * existed at a permissive mode cannot keep it across a wake.
 *
 * ⛔ 0600 IS A PRIVACY GUARANTEE, NOT A BEST-EFFORT. A chmod that cannot
 * land the mode bit is a file that was readable to more than the seat
 * who owns it — a leak we will not silently accept. The chmod failures
 * are NOT swallowed: the catch around `chmodSync` is gone, and an EPERM
 * there bubbles out of writeJsonAtomic exactly the way a write failure
 * would. The contract is "final file mode 0600 OR a loud throw". A
 * persistence that quietly leaves 0644 (or worse) on a file that used to
 * be at 0o600 is the same shape of bug as silently swallowing a write:
 * the runner believes recoverability exists when nothing recoverable is
 * there, and a later wake reads a body anyone on the box could read.
 */
function writeJsonAtomic(file, obj) {
  if (!file) return;
  // Best-effort: ensure the parent directory exists. A failure here is
  // surfaced too — if the runner cannot even create the parent, the
  // atomic and direct writes that follow are guaranteed to fail for the
  // same reason, and we want a single error not three.
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); }
  catch (e) { throw new Error(`withheld-state mkdir failed (${e?.code ?? e?.name ?? 'unknown'}): ${e?.message ?? e}`); }
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const errors = [];
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
    // Pin the mode on the tmp file too — writeFileSync's `mode` only
    // applies on CREATE, and a residual `.tmp-…` from a prior crashed
    // wake could in theory survive at a different mode. The chmod call
    // throws on failure and propagates the throw — privacy is not
    // best-effort.
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    return;
  } catch (e) {
    errors.push(`atomic: ${e?.code ?? e?.name ?? 'unknown'}: ${e?.message ?? e}`);
    // Tidy the temp file if the rename failed mid-way.
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
  // Last-ditch attempt: direct write. The failing path is "I tried to do
  // the right thing and the OS said no" — we still try the simple form,
  // and if THIS too fails the runner must hear about it.
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 });
    // ⛔ fs.writeFileSync's `mode` only applies on CREATE. A file that
    // already existed at a permissive mode KEEPS IT on a successful
    // overwrite — the chmod below is the ONLY thing that pins the mode
    // regardless of whether the call was a create or an overwrite. The
    // privacy contract is not gated on the file's prior state. A chmod
    // failure here throws and is the catch below's "fallback: …" entry,
    // NOT a swallowed warning — the privacy guarantee is "final mode
    // 0600 OR a loud throw", and this is where the throw lives.
    fs.chmodSync(file, 0o600);
    return;
  } catch (e) {
    errors.push(`fallback: ${e?.code ?? e?.name ?? 'unknown'}: ${e?.message ?? e}`);
  }
  // Both attempts failed. Throw so the caller can decide. The message
  // names both attempts and the file (NOT the text — the body never
  // reaches this error string, by design: a logged-on-disk diagnostic
  // would carry the recoverable body to whatever log scraped it).
  throw new Error(`withheld-state persistence failed for ${file} — ${errors.join(' | ')}`);
}

/**
 * A successful suppression STORES OR REPLACES the pending entry. The new
 * text fully supersedes any prior pending text — the newest withholding
 * is the one the seat hears about on the next wake, so two consecutive
 * suppressions do not produce a stack of stale replies.
 *
 * #1428 — DISK FAILURES THROW. When neither the atomic rename nor the
 * direct fallback can land the text, writePending raises so the runner
 * can emit a loud onError diagnostic, refuse the public row, and signal
 * recovery failure locally. The recoverable body never reaches the
 * public surfaces (no rowToBoard, no REST, no graph) on a failed write.
 *
 * #1428 REVIEW — writePending requires a NON-EMPTY text. A bare
 * NO_REPLY is not a recoverable body — there is nothing to recover — so
 * the runner never reaches writePending for one. The runner's path for
 * a bare decline is `clearPending`, not writePending. This invariant is
 * what makes the order-(A) defect impossible at the boundary: a bare
 * decline CANNOT overwrite an existing pending entry, because the
 * function refuses to write an empty text in the first place.
 *
 * Returns the next-state that was persisted so the caller / test can
 * assert what the file looks like on success.
 */
export function writePending(file, { text, reason = 'standalone-no-reply', wakeId = null, at = null } = {}) {
  if (typeof text !== 'string' || !text) throw new Error('writePending: text (non-empty string) is required');
  const next = {
    version: WITHHELD_STATE_VERSION,
    pending: { text, reason, wakeId, at: at || new Date().toISOString() },
  };
  writeJsonAtomic(file, next);
  return next;
}

/**
 * #1428 REVIEW — content-aware retention. The runner's decision
 * "is this a recoverable reply or a bare decline" uses THIS predicate,
 * and only this predicate. It strips standalone NO_REPLY lines and the
 * whitespace around them, and asks of what remains.
 *
 * ⛔ NEVER USED TO REWRITE THE ORIGINAL TEXT. The runner preserves the
 * full original text on the private file — bytes, codepoints, every
 * character. This helper returns a CONTENT-AWARE VIEW used to decide
 * retention; the original text is what reaches the file.
 *
 * Why the helper does NOT consult the Markdown context (code spans,
 * quotes, fenced blocks) the publish-time gate does: the runner
 * already knows the reply DECLINED. The publish-time gate has decided
 * the reply is a decline; the runner only needs to ask "is there any
 * recoverable body left". A sentinel inside a fenced block was already
 * classified as "not a sentinel" by the gate; that is the gate's job.
 * This helper asks a coarser question on the same string the gate saw,
 * and the answer is what decides retention.
 *
 * Returns the text with standalone sentinel lines and the whitespace
 * adjacent to them removed, then trimmed. Empty ⇒ nothing recoverable.
 */
export function recoverableContent(text) {
  if (text == null) return '';
  const raw = String(text);
  if (!raw) return '';
  // Lines that are exactly the sentinel (case-insensitive, with optional
  // horizontal whitespace around them) are removed. Surrounding blank
  // lines collapse too — a reply whose only non-blank lines are sentinels
  // has nothing recoverable.
  const SENTINEL = /^[ \t]*NO_REPLY[ \t]*$/i;
  const lines = raw.split('\n');
  const kept = [];
  let i = 0;
  while (i < lines.length) {
    if (SENTINEL.test(lines[i])) {
      // Drop this sentinel line and any blank lines immediately around it.
      i += 1;
      // Leading blanks before this sentinel: drop them.
      while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
      // Trailing blanks after this sentinel: handled in the main loop below.
      continue;
    }
    if (lines[i].trim() === '') {
      // Tentatively keep the blank line; it is dropped only if it is the
      // ONLY thing between two sentinel lines (handled by the leading-blank
      // pop above when we encounter a sentinel) or between a sentinel and
      // the end of text (handled by the trailing trim below).
      kept.push(lines[i]);
      i += 1;
      continue;
    }
    kept.push(lines[i]);
    i += 1;
  }
  return kept.join('\n').trim();
}

/**
 * #1428 REVIEW — a bare decline is a wake whose `recoverableContent`
 * is empty. A bare NO_REPLY (alone, on its own line, with only whitespace
 * around it) and whitespace-only text are bare declines.
 *
 * The runner uses this to decide:
 *   - DO NOT write the recoverable body (nothing to recover);
 *   - CLEAR any existing pending entry (the author was told, she chose
 *     silence again — a later wake should not be invited to recover the
 *     old text).
 */
export function isBareDecline(text) {
  return recoverableContent(text).length === 0;
}

/**
 * A successful RECEIVING wake CLEARS the pending entry. The seat has been
 * told; her next silence no longer carries the old text. Idempotent: clear
 * on an empty file is a no-op.
 *
 * #1428 — DISK FAILURES THROW. Same loud-failure contract as writePending.
 * A clear that pretends to succeed when the file is unwritable is a leak:
 * the next wake will be told there is nothing pending when in fact the
 * recoverable body was never written. Throwing makes the runner treat this
 * the same way as a failed store: loud diagnostic, no public row.
 */
export function clearPending(file) {
  const next = emptyWithheldState();
  writeJsonAtomic(file, next);
  return next;
}

/**
 * A FAILED CALL PRESERVES. The runner did NOT see the text; the prompt
 * was not assembled with the hand-back; and the wake's model call errored
 * before the suppression gate ran. Returning the existing pending keeps
 * the offer for the next successful wake. This is the function that
 * distinct from "write a new entry" — preserve is "do not touch the file".
 *
 * In practice the implementation is "read and return": we never write on
 * a failed call, so the file is unchanged on disk.
 */
export function preservePending(file) {
  return readWithheldState(file);
}

/**
 * Build the hand-back block from the seat's state file. Returns a list of
 * `{text, reason}` entries — empty for guests, empty for empty state,
 * capped at `cap` (default 5) so an old-state file does not overflow the
 * prompt.
 *
 * ⛔ NEVER reads the board's /api/model-calls for the withheld text — that
 * would defeat the privacy contract. The text rides through this file and
 * this file only.
 */
export function handBackFromState(file, { cap = 5 } = {}) {
  const state = readWithheldState(file);
  if (!state || !state.pending) return [];
  const p = state.pending;
  if (typeof p.text !== 'string' || !p.text) return [];
  return [{ text: p.text, reason: p.reason || 'standalone-no-reply' }].slice(0, cap);
}

/**
 * Default file location for a seat's withheld state, as a sibling to the
 * guest state file. Indirected through this function so a runner can set
 * its own convention.
 */
export function defaultWithheldStatePath(stateFile) {
  if (!stateFile) return null;
  return `${stateFile}.withheld-state.json`;
}
