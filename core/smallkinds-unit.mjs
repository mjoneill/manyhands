/**
 * #1624 — THE SMALL-KINDS UNIT. The first family through the one generic `entity.put`
 * primitive is `scrum:Wake`: append-only, one field `by` (declared seat) plus an optional
 * `note`, no version, no reference, no concurrency beyond the duplicate guard. The flag
 * is `SCRUM_GRAPH_UNIT_SMALLKINDS=1`.
 *
 * OFF unless the flag AND the conversations unit (which itself requires the slice) are
 * on. With it OFF nothing here is called.
 *
 *   write   one `entity.put` intention through core/graph-compiler.mjs (kind: wake). The
 *           actor is the DECLARED seat (`urn:ex:seat/<seat>`), one graphActor call. The
 *           opId is derived from the caller (a uuid + the seat), never any body text.
 *   read    one SELECT against the executor for the list path. The seat filter rides
 *           the WHERE so an unrelated seat cannot leak. The wire is the `entityJson`
 *           literal the write stored, so a reader on either store sees the same shape.
 *   fail    an unreadable / undetermined executor is GRAPH_EXECUTOR_UNAVAILABLE (503 at
 *           the routes): the wake was not written AND the answer is not "no" — never an
 *           empty list dressed as "none", never a 201.
 *
 * Adding a second family (talk / role / agent / etc.) = one row in RECORD_KINDS, one
 * row in the canonicalizeRecord/planRecord blocks (a `kind` switch on `entity`), and one
 * helper here. No new authority is granted: the same actor + people + digest + fresh-IRI
 * guards apply. Wake is append-only — a future editable family will need its own
 * version guard, not arbitrary generic write authority.
 *
 * Wire shape preserved on either store: `{id, seat, at, note}` (read from `entityJson`,
 * the JSON literal the write stored). With the unit ON the document collection is not
 * read or written: route 4455's `wakesOf` throws on the SMALLKINDS_UNIT branch, so no
 * surface can answer a stale document copy under a fresh flag.
 */
import crypto from 'node:crypto';
import { LOGBORN_TERMS as TM } from './graph-compiler.mjs';
import { unavailable } from './logborn-unit.mjs';
import { BK } from './graph-vocab.mjs';

const PERSON_IRI = 'https://scrumboard.local/person/';

// #1624 — one IRI mint, one opId mint, one SPARQL read; the wire builder is the server's.
// Wake IRI is a fresh uuid: append-only means we never re-use one, and the IRI is the
// receipt-bound identity for `fresh`. The opId is a uuid-derived `urn:ex:op/` IRI; no
// raw caller text can land inside it (#1622).
export const WAKE_PREFIX = 'https://scrumboard.local/wake/';

export function wakeIri() { return `${WAKE_PREFIX}${crypto.randomUUID()}`; }
export function wakeOpIri(seat) { return `urn:ex:op/smallkinds/wake/${encodeURIComponent(seat)}/${crypto.randomUUID()}`; }

/** The wake projection's intent — the generic primitive + the per-kind projection. */
export function wakeCreateIntention({ actor, iri, seat, at, note, entityJson }) {
  return { kind: 'entity.put', opId: wakeOpIri(seat), actor,
    entity: { kind: 'wake', iri, seat, at, note: note == null ? '' : String(note), entityJson } };
}

// ── #449 — REACTIONS. One append-only node per toggle; a post's reactions are the FOLD of its toggles. ──
/** The palette of slice 1. A reaction outside it is refused at the route; the compiler stores any string. */
export const REACTION_PALETTE = Object.freeze(['👍', '❤️', '😂', '🤷', '👏', '👀']);
export const REACTION_PREFIX = 'https://scrumboard.local/reaction/';
const POST_ENTITY_PREFIX = 'https://scrumboard.local/entity/';
export const postEntityIri = (postId) => `${POST_ENTITY_PREFIX}${postId}`;
export function reactionIri() { return `${REACTION_PREFIX}${crypto.randomUUID()}`; }
export function reactionOpIri(seat) { return `urn:ex:op/smallkinds/reaction/${encodeURIComponent(seat)}/${crypto.randomUUID()}`; }

/** One toggle's intention. `state` is 'on' or 'off'; the post must be live when it lands (the compiler's precondition). */
export function reactionIntention({ actor, iri, postId, seat, emoji, state, at }) {
  const entityJson = JSON.stringify({ post: postId, seat, emoji, state, at });
  return { kind: 'entity.put', opId: reactionOpIri(seat), actor,
    entity: { kind: 'reaction', iri, post: postEntityIri(postId), seat, emoji, state, at, entityJson } };
}

/** Every toggle on the given posts, in ONE query. Post ids ride a VALUES block, each checked to be an id-shaped token. */
export function reactionsForQuery(postIds) {
  const ids = postIds.filter((id) => /^[A-Za-z0-9-]{1,64}$/.test(String(id)));
  if (!ids.length) return null;
  const values = ids.map((id) => `<${postEntityIri(id)}>`).join(' ');
  return `SELECT ?r ?j WHERE { VALUES ?post { ${values} } ?r <${TM.type}> <${TM.Reaction}> ; <${TM.reactionTo}> ?post . GRAPH ${BK} { ?r <${TM.entityJson}> ?j } }`;
}

/**
 * The fold. `toggles` are {iri, post, seat, emoji, state, at}. For each (post, seat, emoji) the LATEST toggle wins (by `at`,
 * ties by iri, so the answer never depends on row order); the live ones are kept. Per post: emoji in the order of their
 * earliest live reaction, and each emoji's reactors in the order they reacted. Returns Map(postId → [{emoji, by}]).
 */
export function foldReactions(toggles) {
  const latest = new Map();
  const later = (a, b) => (a.at > b.at || (a.at === b.at && a.iri > b.iri));
  for (const t of toggles) {
    const k = JSON.stringify([t.post, t.seat, t.emoji]);
    const cur = latest.get(k);
    if (!cur || later(t, cur)) latest.set(k, t);
  }
  const live = [...latest.values()].filter((t) => t.state === 'on')
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.iri < b.iri ? -1 : a.iri > b.iri ? 1 : 0));
  const out = new Map();
  for (const t of live) {
    if (!out.has(t.post)) out.set(t.post, []);
    const list = out.get(t.post);
    let chip = list.find((c) => c.emoji === t.emoji);
    if (!chip) { chip = { emoji: t.emoji, by: [] }; list.push(chip); }
    chip.by.push(t.seat);
  }
  return out;
}

/** Bindings → a toggle, or null when the stored JSON is unreadable. */
export function toggleFromRow(r) {
  let j;
  try { j = JSON.parse(String(r.j.value)); } catch { return null; }
  if (!j || typeof j !== 'object' || typeof j.post !== 'string' || typeof j.seat !== 'string' || typeof j.emoji !== 'string' || typeof j.at !== 'string') return null;
  if (j.state !== 'on' && j.state !== 'off') return null;
  return { iri: String(r.r.value), post: j.post, seat: j.seat, emoji: j.emoji, state: j.state, at: j.at };
}

/** A seat key → the same canonical person IRI the compiler writes for `wokeSeat`. */
const seatIriForFilter = (seat) => `<${PERSON_IRI}${encodeURIComponent(String(seat))}>`;

/**
 * Every wake from the executor, in ONE shot, with optional seat and limit. Rows are
 * {w: IRI, j: entityJson literal}. The list path orders newest-first; the seat filter
 * rides the WHERE on the EXACT same person IRI the compiler writes, so an unrelated
 * seat cannot leak. The limit gate matches the unit-off behaviour byte-for-byte:
 * a parsed integer > 0 is applied; anything else (NaN, negative, non-integer) is noop,
 * so a malformed query string is a 200 with the full list, never a `LIMIT 1` floor.
 */
export function wakesForQuery({ seat, limit } = {}) {
  // #1638 — the entityJson copy is bookkeeping (named graph); type and wokeAt are domain (default graph)
  const head = `?w <${TM.type}> <${TM.Wake}> ; <${TM.wokeAt}> ?at . GRAPH ${BK} { ?w <${TM.entityJson}> ?j }`;
  const body = seat
    ? `SELECT ?w ?j ?at WHERE { ${head} ?w <${TM.wokeSeat}> ${seatIriForFilter(seat)} . }`
    : `SELECT ?w ?j ?at WHERE { ${head} }`;
  const limitClause = (Number.isInteger(limit) && limit > 0) ? ` LIMIT ${limit}` : '';
  return `${body} ORDER BY DESC(?at)${limitClause}`;
}

/** Bindings → the document-shaped entity the existing `wakeToWire` builder reads. */
export function wakeFromRow(r) {
  let parsed;
  try { parsed = JSON.parse(String(r.j.value)); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  return { '@id': String(r.w.value), '@type': 'scrum:Wake',
    'scrum:wokeSeat': parsed.seat ?? '',
    'scrum:wokeAt': parsed.at ?? String(r.at.value),
    text: parsed.note ?? '' };
}

/** The unit's runtime: reads + writes through the slice's client, fenced. */
export function createSmallkindsUnit({ slice }) {
  async function select(sparql) {
    const t0 = Date.now();
    const fenced = await slice.fence();
    if (fenced) throw unavailable(fenced, t0);
    const r = await slice.client.query(sparql);
    if (!r.ok) throw unavailable(r.reason, t0);
    return r.rows;
  }
  /** All wakes (or the seat's wakes), newest first, optionally limited: { unavailable } | { wakes: entity[] }. */
  async function readWakes(filter = {}) {
    try {
      const raw = await select(wakesForQuery(filter));
      const out = raw.map(wakeFromRow).filter(Boolean);
      return { wakes: out };
    } catch (e) {
      if (e?.code === 'GRAPH_EXECUTOR_UNAVAILABLE') return { unavailable: e.message };
      throw e;
    }
  }
  /**
   * One wake write. Returns { status: APPLIED | UNAVAILABLE, reason? }.
   *
   * #1587-style reconciliation: an UNKNOWN first answer is reconciled by receipt; an
   * ABSENT receipt means the wake was NOT written and a replay is safe; any other
   * UNKNOWN leaves the outcome indeterminate and the route answers 503
   * GRAPH_UNAVAILABLE — never a 201 (a wake must not be implied as written when
   * the executor could not tell us). Reused deliveries/post conventions
   * (`unavailable` carries the interval), and a retry of this SAME intention under
   * the SAME opId is an `intent-collision` receipt (the duplicate guard), never a
   * new intention.
   */
  /** #449 — the folded reactions of these posts: { unavailable } | { reactions: Map(postId → [{emoji, by}]) }. */
  async function readReactions(postIds) {
    const q = reactionsForQuery(postIds);
    if (!q) return { reactions: new Map() };
    try {
      const rows = await select(q);
      return { reactions: foldReactions(rows.map(toggleFromRow).filter(Boolean)) };
    } catch (e) {
      if (e?.code === 'GRAPH_EXECUTOR_UNAVAILABLE') return { unavailable: e.message };
      throw e;
    }
  }
  async function writeWake(intention) {
    const t0 = Date.now();
    const fenced = await slice.fence();
    if (fenced) return { status: 'UNAVAILABLE', reason: fenced };
    let r = await slice.client.update(intention);
    if (r.outcome === 'UNKNOWN') {
      const rc = await slice.client.reconcile(intention);
      if (rc.outcome === 'ABSENT') r = await slice.client.update(intention);
      else if (rc.outcome !== 'UNKNOWN') r = rc;
    }
    if (r.outcome === 'APPLIED') return { status: 'APPLIED' };
    if (r.outcome === 'REJECTED') return { status: 'REJECTED', reason: r.reason };
    if (r.outcome === 'PRECONDITION_FAILED') return { status: 'PRECONDITION_FAILED', reason: r.reason };
    // UNKNOWN / ABSENT (post-reconcile) — the executor could not tell us whether the
    // wake was written. We do NOT retry with a fresh opId: that would mint a new
    // intention and could land a second wake. Map to UNAVAILABLE so the route 503s.
    return { status: 'UNAVAILABLE', reason: r.reason ?? `outcome=${r.outcome}` };
  }
  // #449 — a reaction toggle is the same shape of write as a wake (one fresh node through entity.put), so it takes the
  // same reconciliation: an undetermined outcome is UNAVAILABLE, never a guess.
  return { readWakes, writeWake, readReactions, writeReaction: writeWake };
}