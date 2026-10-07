/**
 * #1598 — THE CARDS UNIT: cards are read from and written to the graph executor (SCRUM_GRAPH_UNIT_CARDS=1).
 *
 * REST is the only card writer, and every card write already runs under its board write lock, so an in-process cache
 * stays coherent with the graph (review 05:56Z, point 4):
 *   · it is FILLED only from graph reads (at boot, and on reload);
 *   · it is UPDATED only after the executor answers APPLIED;
 *   · after any other answer it is marked UNCERTAIN and reloaded before the next read is served; a reload that fails
 *     leaves the unit unavailable (503), never a stale board served as current.
 *
 * A card's graph version (`urn:ex:ver`) is the unit's own write counter: every write that changes a card moves it by
 * one, whatever the handler did with the card's `version` field. The `ifVersion` precondition is still checked by the
 * handlers against the card's `version`, under the write lock, exactly as today.
 */
import { durableUpdate } from './durable-update.mjs';
import { cardQuads, priorQuads, cardIriOf, SHORTID_COUNTER_IRI, shortIdMap } from './cards-graph.mjs';
import { parseCardRefs } from './references.mjs';

/** Does `card` name any of `shortIds` (a #N in its title or body, or a shortId in a relationship or a condition's blockers)? */
function namesAny(card, shortIds) {
  const named = new Set(parseCardRefs(`${card.title ?? ''}\n${card.description ?? ''}`).map(Number));
  for (const arr of Object.values(card.relationships || {})) for (const v of arr || []) named.add(Number(v));
  for (const a of card.acceptance || []) for (const v of a?.blockedBy || []) named.add(Number(v));
  for (const n of shortIds) if (named.has(Number(n))) return true;
  return false;
}

const RS = 'https://scrumboard.local/ns#';
const T = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const VER = 'urn:ex:ver';

export class CardsUnavailable extends Error {
  constructor(reason) { super(`cards are unavailable: ${reason}`); this.code = 'CARDS_UNAVAILABLE'; }
}
export class CardWriteConflict extends Error {
  constructor(reason) { super(`card write refused: ${reason}`); this.code = 'CARD_WRITE_CONFLICT'; }
}

export function createCardsUnit({ client, actorIri = (who) => `https://scrumboard.local/person/${encodeURIComponent(who || 'board')}`, mintId }) {
  /** id → { card (as stored), json (its JSON text), ver } in insertion order; null until loaded. */
  let byId = null;
  let counter = null;        // the graph's nextShortId (null: no counter node yet)
  let uncertain = true;
  let gen = 0;               // moves on every cache change, so a shared read can key on it

  async function load() {
    const q = await client.query(`SELECT ?s ?v ?j WHERE { ?s <${T}> <${RS}Card> ; <${VER}> ?v ; <${RS}entityJson> ?j }`);
    if (!q.ok) throw new CardsUnavailable(q.reason || 'the graph could not be read');
    const c = await client.query(`SELECT ?n WHERE { <${SHORTID_COUNTER_IRI}> <${VER}> ?n }`);
    if (!c.ok) throw new CardsUnavailable(c.reason || 'the shortId counter could not be read');
    const rows = q.rows.map((r) => ({ card: JSON.parse(r.j.value), json: r.j.value, ver: Number(r.v.value) }));
    rows.sort((a, b) => (Number(a.card.shortId) || 0) - (Number(b.card.shortId) || 0));
    byId = new Map(rows.map((r) => [r.card.id, r]));
    counter = c.rows.length ? Number(c.rows[0].n.value) : null;
    uncertain = false; gen++;
  }

  /** Make the cache current before it is served. Throws CardsUnavailable. */
  async function ensureFresh() {
    if (byId && !uncertain) return;
    try { await load(); } catch (e) { uncertain = true; throw e instanceof CardsUnavailable ? e : new CardsUnavailable(e.message); }
  }

  /** The cards as a fresh mutable array (a handler may edit it), and the next shortId the board should allocate. */
  function snapshot(fileNextShortId) {
    if (!byId || uncertain) throw new CardsUnavailable('the card cache is not current');
    return { cards: [...byId.values()].map((r) => JSON.parse(r.json)), nextShortId: counter ?? fileNextShortId ?? 1 };
  }

  /** The parts of ONE card.write that turn the cached cards into `cards` (null when nothing changed). */
  function plan(cards, nextShortId) {
    const before = shortIdMap([...byId.values()].map((r) => r.card));
    const after = shortIdMap(cards);
    const parts = [];
    const seen = new Set();
    for (const card of cards) {
      if (!card || !card.id) continue;
      seen.add(card.id);
      const json = JSON.stringify(card);
      const was = byId.get(card.id);
      if (was && was.json === json) continue;
      parts.push(was
        ? { iri: cardIriOf(card.id), expectedVersion: String(was.ver), version: String(was.ver + 1), quads: cardQuads(card, after), prior: priorQuads(was.card, before), json }
        : { iri: cardIriOf(card.id), expectedVersion: null, version: '1', quads: cardQuads(card, after), json });
    }
    for (const [id, was] of byId) {
      if (!seen.has(id)) parts.push({ iri: cardIriOf(id), remove: true, expectedVersion: String(was.ver), prior: priorQuads(was.card, before) });
    }
    // #1598 C12 — a create or a remove changes which #N resolve. Every UNCHANGED card that names a shortId that appeared or
    // disappeared is re-projected in the SAME write when its projection differs (the document model got this for free:
    // the replica re-derived every card's references from the whole board).
    const changed = [...after.keys()].filter((k) => !before.has(k)).concat([...before.keys()].filter((k) => !after.has(k)));
    if (changed.length) {
      const inParts = new Set(parts.map((p) => p.iri));
      for (const card of cards) {
        const was = card && byId.get(card.id);
        if (!was || inParts.has(cardIriOf(card.id)) || !namesAny(was.card, changed)) continue;
        const q0 = cardQuads(was.card, before), q1 = cardQuads(was.card, after);
        if (JSON.stringify(q0) === JSON.stringify(q1)) continue;
        parts.push({ iri: cardIriOf(card.id), expectedVersion: String(was.ver), version: String(was.ver + 1), quads: q1, prior: priorQuads(was.card, before), json: was.json });
      }
    }
    const counterPart = nextShortId != null && Number(nextShortId) !== (counter ?? null) && (parts.length || counter == null)
      ? { expected: counter == null ? null : String(counter), next: String(nextShortId) } : null;
    if (!parts.length && !counterPart) return null;
    return { parts, counter: counterPart };
  }

  /**
   * Write the difference between the cache and `cards` as ONE guarded update. APPLIED → the cache becomes `cards`.
   * Anything else → the cache is marked uncertain (reloaded before the next read) and the write is refused.
   */
  async function commit(cards, nextShortId, { actor, opId, pending = [], collections = [] } = {}) {
    if (!byId || uncertain) throw new CardsUnavailable('the card cache is not current');
    // #1624 — collection parts (a K13 family's entities) ride the SAME update when this write also changed them.
    const p = plan(cards, nextShortId) ?? (collections.length ? { parts: [], counter: null } : null);
    if (!p) return { outcome: 'NOOP' };
    // K4 — only announcements whose card is a part of THIS write ride it (the others have no window to close).
    const inWrite = new Set(p.parts.filter((x) => !x.remove).map((x) => x.iri));
    const ride = pending.filter((a) => inWrite.has(cardIriOf(a.cardId))).map((a) => ({ card: cardIriOf(a.cardId), mutationId: a.mutationId, json: a.json }));
    const intent = { kind: 'card.write', opId: opId || `urn:ex:op/card/${mintId()}`, actor: actorIri(actor), parts: p.parts, ...(p.counter ? { counter: p.counter } : {}), ...(ride.length ? { pending: ride } : {}), ...(collections.length ? { collections } : {}) };
    let r;
    try { r = await durableUpdate(client, intent); } catch (e) { uncertain = true; throw new CardsUnavailable(e.message); }
    if (r.outcome !== 'APPLIED') {
      // UNAVAILABLE: nothing was sent, so the cache is still the graph's. Anything else leaves it to be re-read.
      if (r.outcome !== 'UNAVAILABLE') uncertain = true;
      if (r.outcome === 'PRECONDITION_FAILED' || r.outcome === 'REJECTED') throw new CardWriteConflict(`${r.outcome}${r.reason ? `: ${r.reason}` : ''}`);
      throw new CardsUnavailable(`the write's outcome is ${r.outcome}${r.reason ? `: ${r.reason}` : ''}`);
    }
    const written = new Map(p.parts.filter((x) => !x.remove).map((x) => [x.iri, Number(x.version)]));
    const next = new Map();
    for (const card of cards) {
      if (!card || !card.id) continue;
      const json = JSON.stringify(card);
      const was = byId.get(card.id);
      const ver = written.get(cardIriOf(card.id));
      next.set(card.id, ver == null && was ? was : { card: JSON.parse(json), json, ver: ver ?? 1 });
    }
    byId = next;
    if (p.counter) counter = Number(p.counter.next);
    gen++;
    return { outcome: 'APPLIED', parts: p.parts.length };
  }

  /** K5 — the outcome recorded for `opId` ('APPLIED', 'PRECONDITION_FAILED', …), or null when there is no receipt. Throws CardsUnavailable. */
  async function receipt(opId) {
    const q = await client.query(`SELECT ?o WHERE { <${opId}> <urn:ex:outcome> ?o }`);
    if (!q.ok) throw new CardsUnavailable(q.reason || 'the receipt could not be read');
    return q.rows.length ? q.rows[0].o.value.replace(/^urn:ex:/, '') : null;
  }

  /** K4 — every announcement recorded with a card write: [{ mutationId, json }]. Throws CardsUnavailable. */
  async function pendingAnnouncements() {
    const q = await client.query(`SELECT ?n ?j WHERE { ?n <${T}> <${RS}PendingAnnouncement> ; <${RS}entityJson> ?j }`);
    if (!q.ok) throw new CardsUnavailable(q.reason || 'the pending announcements could not be read');
    return q.rows.map((r) => ({ mutationId: r.n.value.split('/announce/')[1], json: r.j.value }));
  }
  /** Does a post with this id exist in the graph (live or redacted)? Throws CardsUnavailable. */
  async function postExists(id) {
    const q = await client.query(`SELECT ?t WHERE { <https://scrumboard.local/entity/${id}> <${T}> ?t } LIMIT 1`);
    if (!q.ok) throw new CardsUnavailable(q.reason || 'the posts could not be read');
    return q.rows.length > 0;
  }

  /**
   * K7 — is the executor answering right now? (review 06:16Z) SINGLE-FLIGHT: concurrent callers share one probe. A
   * probe that does not answer within PROBE_TIMEOUT_MS is DOWN (a slow executor is a fast 503, never a queue behind a
   * heavy query). Neither answer is remembered: the next request after this one probes again. (A cached DOWN was
   * allowed by the review, but C6b and C7 pin that the first request after the executor returns is served, so none.)
   */
  const PROBE_TIMEOUT_MS = 2000;
  let probing = null;
  function reachable() {
    if (probing) return probing;
    probing = (async () => {
      let timer;
      const timeout = new Promise((r) => { timer = setTimeout(() => r(false), PROBE_TIMEOUT_MS); });
      const ask = client.query('SELECT ?x WHERE { BIND(1 AS ?x) }').then((q) => q.ok, () => false);
      const ok = await Promise.race([ask, timeout]);
      clearTimeout(timer);
      return ok;
    })().finally(() => { probing = null; });
    return probing;
  }

  return {
    load, ensureFresh, snapshot, plan, commit, reachable, receipt, pendingAnnouncements, postExists,
    get generation() { return gen; }, get uncertain() { return uncertain; }, get loaded() { return byId != null; },
    markUncertain() { uncertain = true; },
  };
}
