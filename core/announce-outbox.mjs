/**
 * #1574 unit 2, C3a — the announcement OUTBOX, as pure helpers.
 *
 * The board document carries one server-owned field:
 *
 *   announcementOutbox = {
 *     origins: { [mutationId]:   { mutationId, slots, origin: {cardId, version}, committedAt, occurredAt, originActor } },
 *     entries: { [obligationId]: { obligationId, mutationId, slot, status, payload, ...mutable } },
 *   }
 *
 * An origin and its pending entries are written in the SAME board-document write as the change that caused
 * them, so an obligation exists exactly when its change does. Nothing here does I/O or reads a clock: the
 * server mints the mutationId (inside the write lock) and passes the time in.
 *
 * obligationId = `${mutationId}:${slot}`.
 */

export const OUTBOX_FIELD = 'announcementOutbox';
export const OUTBOX_STATUSES = Object.freeze(['pending', 'published', 'blocked']);
/** A published entry is kept whole for exactly this long, then reduced to its identity. */
export const PUBLISHED_RETENTION_MS = 7 * 24 * 3600 * 1000;

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

export const obligationIdOf = (mutationId, slot) => `${mutationId}:${slot}`;

/** The document's outbox, normalised to `{origins:{}, entries:{}}`. Never mutates; absent ⇒ empty. */
export function outboxOf(doc) {
  const ob = isObj(doc) ? doc[OUTBOX_FIELD] : null;
  return {
    origins: isObj(ob) && isObj(ob.origins) ? ob.origins : {},
    entries: isObj(ob) && isObj(ob.entries) ? ob.entries : {},
  };
}

/**
 * Commit one mutation's announcements into an outbox. Returns a NEW outbox; the input is not touched.
 *
 *   mutationId  server-generated, unique per committed mutation
 *   origin      provenance {cardId, version}
 *   at          ISO time of the change (committedAt and every payload's occurredAt)
 *   originActor who caused it
 *   slots       [{ slot, body, mentions, notify }] — one pending entry per slot, payload frozen here
 */
export function withAnnouncement(outbox, { mutationId, origin, at, originActor, slots }) {
  if (typeof mutationId !== 'string' || !mutationId) throw new Error('withAnnouncement: mutationId is required');
  if (!Array.isArray(slots) || slots.length === 0) throw new Error('withAnnouncement: at least one slot is required');
  const { origins, entries } = outboxOf({ [OUTBOX_FIELD]: outbox });
  if (origins[mutationId]) throw new Error(`withAnnouncement: mutation ${mutationId} is already committed`);
  const nextEntries = { ...entries };
  for (const s of slots) {
    const obligationId = obligationIdOf(mutationId, s.slot);
    if (nextEntries[obligationId]) throw new Error(`withAnnouncement: obligation ${obligationId} already exists`);
    nextEntries[obligationId] = {
      obligationId, mutationId, slot: s.slot, status: 'pending',
      payload: {
        author: 'board',
        body: s.body,
        mentions: Array.isArray(s.mentions) ? [...s.mentions] : [],
        notify: s.notify,
        occurredAt: at,
        originActor,
        origin: { ...origin },
        mutationId,
        slot: s.slot,
      },
    };
  }
  return {
    origins: {
      ...origins,
      [mutationId]: {
        mutationId, slots: slots.map((s) => s.slot), origin: { ...origin },
        committedAt: at, occurredAt: at, originActor,
      },
    },
    entries: nextEntries,
  };
}

/**
 * The read shape of GET /api/outbox: arrays, in stored order. `mutationId` filters BOTH lists; `status`
 * filters entries. Origins are listed even when none of their entries exist (that absence is what an audit
 * looks for, so the read must not hide it).
 */
export function listOutbox(doc, { status, mutationId } = {}) {
  const { origins, entries } = outboxOf(doc);
  const byMutation = (x) => !mutationId || x.mutationId === mutationId;
  return {
    origins: Object.values(origins).filter((o) => isObj(o) && byMutation(o)),
    entries: Object.values(entries).filter((e) => isObj(e) && byMutation(e) && (!status || e.status === status)),
  };
}

/**
 * PURE compaction with an explicit clock. A `published` entry whose `publishedAt` is MORE than 7 days
 * before nowMs is reduced to {obligationId, mutationId, slot, status:'published', publishedAt, postId}.
 * Exactly 7 days is kept whole. Pending, blocked, and published-without-a-valid-publishedAt entries are
 * never touched; origins are never touched; the rest of the document is preserved. Idempotent.
 * Always returns a new document object; the input is not mutated.
 */
export function compactOutbox(doc, nowMs) {
  if (!isObj(doc)) return doc;
  const ob = doc[OUTBOX_FIELD];
  if (!isObj(ob) || !isObj(ob.entries)) return { ...doc };
  let changed = false;
  const entries = {};
  for (const [id, e] of Object.entries(ob.entries)) {
    const at = isObj(e) && e.status === 'published' && typeof e.publishedAt === 'string' ? Date.parse(e.publishedAt) : NaN;
    if (Number.isFinite(at) && nowMs - at > PUBLISHED_RETENTION_MS) {
      const reduced = { obligationId: e.obligationId, mutationId: e.mutationId, slot: e.slot, status: 'published', publishedAt: e.publishedAt, postId: e.postId };
      entries[id] = reduced;
      if (Object.keys(e).length !== Object.keys(reduced).length) changed = true;
    } else {
      entries[id] = e;
    }
  }
  return changed ? { ...doc, [OUTBOX_FIELD]: { ...ob, entries } } : { ...doc };
}
