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
/**
 * C3b — how an obligation is published, frozen at commit on the origin AND every entry, never changed:
 *   legacy     the direct commons post was written in the same document write; the entry names it
 *              (`legacyPostId`) and publishing only VERIFIES it (receipt 'legacy', no new post).
 *   publisher  nothing was posted at commit; publishing writes the post (opId = opIdFor(...)).
 * A missing, unknown, or entry/origin-disagreeing mode is MALFORMED and is never inferred.
 */
export const OUTBOX_MODES = Object.freeze(['legacy', 'publisher']);
/** A published entry is kept whole for exactly this long, then reduced to its identity. */
export const PUBLISHED_RETENTION_MS = 7 * 24 * 3600 * 1000;

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

export const obligationIdOf = (mutationId, slot) => `${mutationId}:${slot}`;
/** The deterministic idempotency key of a publisher-mode post. */
export const opIdFor = (mutationId, slot) => `urn:ex:op/announce/${mutationId}/${slot}`;

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
 *   mode        'legacy' | 'publisher', frozen on the origin and on every entry
 *   slots       [{ slot, body, mentions, notify, legacyPostId? }] — one pending entry per slot, payload frozen here
 */
export function withAnnouncement(outbox, { mutationId, origin, at, originActor, mode, slots }) {
  if (typeof mutationId !== 'string' || !mutationId) throw new Error('withAnnouncement: mutationId is required');
  if (!OUTBOX_MODES.includes(mode)) throw new Error(`withAnnouncement: mode must be one of ${OUTBOX_MODES.join(', ')}`);
  if (!Array.isArray(slots) || slots.length === 0) throw new Error('withAnnouncement: at least one slot is required');
  const { origins, entries } = outboxOf({ [OUTBOX_FIELD]: outbox });
  if (origins[mutationId]) throw new Error(`withAnnouncement: mutation ${mutationId} is already committed`);
  const nextEntries = { ...entries };
  for (const s of slots) {
    const obligationId = obligationIdOf(mutationId, s.slot);
    if (nextEntries[obligationId]) throw new Error(`withAnnouncement: obligation ${obligationId} already exists`);
    nextEntries[obligationId] = {
      obligationId, mutationId, slot: s.slot, status: 'pending', mode,
      ...(mode === 'legacy' && typeof s.legacyPostId === 'string' && s.legacyPostId ? { legacyPostId: s.legacyPostId } : {}),
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
        committedAt: at, occurredAt: at, originActor, mode,
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

// ── C3b — publishing ─────────────────────────────────────────────────────────

/** Null when the entry and its origin agree on a known mode; 'malformed-entry' otherwise. Never infers. */
export function modeProblem(entry, origin) {
  if (!isObj(entry) || !isObj(origin)) return 'malformed-entry';
  if (!OUTBOX_MODES.includes(entry.mode) || !OUTBOX_MODES.includes(origin.mode)) return 'malformed-entry';
  if (entry.mode !== origin.mode) return 'malformed-entry';
  return null;
}

/** Does `post` say exactly what the frozen payload says, for exactly this obligation? */
export function postMatchesEntry(entry, post) {
  const p = isObj(entry) ? entry.payload : null;
  if (!isObj(p) || !isObj(post)) return false;
  return post.author === p.author
    && post.body === p.body
    && isObj(post.origin)
    && post.origin.mutationId === entry.mutationId
    && post.origin.slot === entry.slot;
}

/**
 * Legacy proof: the entry's `legacyPostId` must name an existing post that matches the frozen payload and
 * provenance. Returns {ok:true, postId} or {ok:false, reason: 'legacy-proof-missing'|'legacy-proof-mismatch'}.
 * `findPost(id)` returns the stored post or null.
 */
export function legacyProof(entry, findPost) {
  const id = isObj(entry) ? entry.legacyPostId : null;
  if (typeof id !== 'string' || !id) return { ok: false, reason: 'legacy-proof-missing' };
  const post = findPost(id);
  if (!post) return { ok: false, reason: 'legacy-proof-missing' };
  if (!postMatchesEntry(entry, post)) return { ok: false, reason: 'legacy-proof-mismatch' };
  return { ok: true, postId: id };
}

/**
 * PURE audit of the stored outbox. A compacted (identity-only) entry counts as present.
 *   missing-entry  an origin slot with no entry          {kind, mutationId, slot}
 *   orphan-entry   an entry whose mutation has no origin {kind, obligationId, mutationId}
 *   slot-mismatch  an entry whose slot its origin lacks  {kind, obligationId, mutationId, slot}
 * What it cannot see: a write that recorded neither an origin nor an entry.
 */
export function auditOutbox(doc) {
  const { origins, entries } = outboxOf(doc);
  const failures = [];
  const present = new Set();
  for (const e of Object.values(entries)) {
    if (!isObj(e)) continue;
    present.add(`${e.mutationId}\u0000${e.slot}`);
    const o = origins[e.mutationId];
    if (!isObj(o)) failures.push({ kind: 'orphan-entry', obligationId: e.obligationId, mutationId: e.mutationId });
    else if (!Array.isArray(o.slots) || !o.slots.includes(e.slot)) failures.push({ kind: 'slot-mismatch', obligationId: e.obligationId, mutationId: e.mutationId, slot: e.slot });
  }
  for (const [mutationId, o] of Object.entries(origins)) {
    for (const slot of (isObj(o) && Array.isArray(o.slots) ? o.slots : [])) {
      if (!present.has(`${mutationId}\u0000${slot}`)) failures.push({ kind: 'missing-entry', mutationId, slot });
    }
  }
  return { failures };
}
