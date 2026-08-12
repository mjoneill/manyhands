/**
 * #794 — bounded comment metadata for the single-card response path.
 *
 * ⚠️ WHY THIS IS A MODULE AND NOT A FUNCTION INSIDE server.js.
 * The first implementation (6b32d96) lived in server.js, which exports nothing.
 * Its source comment claimed "insertion into a fixed-size buffer" and
 * "ALLOCATION is O(cap)" — and the code pushed EVERY matching comment into an
 * array and sorted the whole thing. Caught in independent read-only review.
 *
 * ⭐ The seven wire-level tests could not have caught that, and this is the
 * general lesson: they assert on the SERIALIZED RESPONSE, and the response was
 * correct. A claim about internal behaviour needs a surface where internal
 * behaviour is observable. That surface is an exported function.
 *
 * ── THE TWO BOUNDS ARE INDEPENDENT ─────────────────────────────────────────
 *   RECENT_CAP     bounds how MANY stubs come back
 *   PREVIEW_CHARS  bounds how BIG each one is
 * Capping the count alone does not bound the payload: one 40KB comment defeats
 * it by itself. Both are asserted, and each has its own mutation test.
 */

export const COMMENT_RECENT_CAP = 3;
export const COMMENT_PREVIEW_CHARS = 140;

/** ISO-8601 UTC strings sort lexicographically, so no Date parsing is needed. */
const isNewer = (a, b) => String(a.createdAt) > String(b.createdAt);

/**
 * A stub carries enough to DECIDE whether to fetch the full comment, and no
 * more: who, when, and the opening line.
 *
 * ⚠️ FIRST LINE, then truncate — not the first 140 characters. #794 asks for
 * "author, date, first line"; slicing raw would flatten a multi-line comment
 * into a run-on that reads as one sentence and misrepresents its shape.
 */
function toStub(c) {
  const body = String(c.body || '');
  const nl = body.indexOf('\n');
  let firstLine = nl === -1 ? body : body.slice(0, nl);
  // CRLF: indexOf('\n') stops AFTER the '\r', which would ride along into the
  // preview as an invisible trailing character. (review finding, 2026-08-12)
  if (firstLine.endsWith('\r')) firstLine = firstLine.slice(0, -1);
  return {
    id: c.id,
    author: c.author,
    createdAt: c.createdAt,
    preview: firstLine.slice(0, COMMENT_PREVIEW_CHARS),
  };
}

/**
 * Count every comment attached to `cardId`; retain only the newest CAP.
 *
 * ⭐ THE BUFFER NEVER EXCEEDS THE CAP — not even transiently. When it is full
 * we drop the oldest BEFORE splicing the newcomer in, so there is no moment at
 * which CAP+1 elements are held. There is no sort: the buffer is maintained
 * newest-first by insertion, so `sort` is never called on the population.
 *
 * `conversations` is consumed as an iterable and read exactly once, so a
 * generator or a stream works here without materialising the population.
 *
 * @param {Iterable<{attachedTo?: string, createdAt?: string}>} conversations
 * @param {string} cardId
 * @returns {{total: number, recent: Array<{id, author, createdAt, preview}>}}
 */
export function commentMetadata(conversations, cardId) {
  let total = 0;
  const recent = []; // newest-first · length <= COMMENT_RECENT_CAP at ALL times

  for (const c of conversations) {
    if (c.attachedTo !== cardId) continue;
    total += 1;

    if (recent.length === COMMENT_RECENT_CAP) {
      // Older than everything we hold — it can never enter the buffer.
      if (!isNewer(c, recent[COMMENT_RECENT_CAP - 1])) continue;
      recent.pop(); // drop the oldest FIRST, so we never hold CAP+1
    }

    let i = 0;
    while (i < recent.length && !isNewer(c, recent[i])) i += 1;
    recent.splice(i, 0, c);
  }

  return { total, recent: recent.map(toStub) };
}
