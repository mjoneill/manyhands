/**
 * #1624 — THE MUTABLE SMALL-KIND COLLECTIONS in the graph (procedures and their versions, runs, models, predicates,
 * kinds, agents and their prompts; review 08:37Z: reuse #1598's transaction machinery through the single allowlisted
 * entity.put). Same rules as the card cache (core/cards-unit.mjs):
 *   · the cache is FILLED only from graph reads (at boot, and on reload);
 *   · it is UPDATED only after the executor answers APPLIED;
 *   · after any other answer it is marked UNCERTAIN and reloaded before the next read; a reload that fails is a 503.
 * Each family registers a collection: the board key it lives under and the UNIQUE values the graph must guard (a model
 * key, a predicate name, a procedure + version number). The document's lock still serialises REST's writes; the
 * version and unique guards make the graph itself refuse a stale or colliding write.
 *
 * An entity's projection is the replica's own (`projectEntity`), so graph_query reads the same triples; for every
 * family registered here the projection is subject-only (measured 2026-10-07 on the live board), which is what lets the
 * compiler refuse any quad whose subject is not the entity's own IRI.
 */
import oxigraph from 'oxigraph';
import { durableUpdate } from './durable-update.mjs';
import { projectEntity } from './graph-replica.mjs';

const RS = 'https://scrumboard.local/ns#';
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const termOf = (t) => {
  if (t.termType === 'NamedNode') return { type: 'uri', value: t.value };
  if (t.termType === 'Literal') {
    if (t.language) return { type: 'literal', value: t.value, lang: t.language };
    return t.datatype && t.datatype.value !== XSD_STRING ? { type: 'literal', value: t.value, datatype: t.datatype.value } : { type: 'literal', value: t.value };
  }
  throw new Error(`a collection projection produced a ${t.termType} term; only named nodes and literals are carried`);
};

/** One entity → its projected quads (compiler terms). */
export function entityQuads(entity) {
  const store = new oxigraph.Store();
  projectEntity(store, entity);
  return store.match(null, null, null).map((q) => [termOf(q.subject), termOf(q.predicate), termOf(q.object)]);
}

export class CollectionsUnavailable extends Error {
  constructor(reason) { super(`collections are unavailable: ${reason}`); this.code = 'COLLECTIONS_UNAVAILABLE'; }
}

/**
 * `families`: [{ key, unique?: (entity) => [{ predicate: IRI, value: term }] }]. `client` is a graph client.
 */
export function createCollectionsUnit({ client, families, mintId, actorIri = (who) => `https://scrumboard.local/person/${encodeURIComponent(who || 'board')}` }) {
  const byKey = new Map(families.map((f) => [f.key, f]));
  /** key → Map(id → { entity, json, ver }) */
  let cache = null;
  let uncertain = true;
  let gen = 0;

  async function load() {
    const next = new Map([...byKey.keys()].map((k) => [k, new Map()]));
    const q = await client.query(`SELECT ?s ?k ?v ?j WHERE { ?s <${RS}inCollection> ?k ; <urn:ex:ver> ?v ; <${RS}entityJson> ?j }`);
    if (!q.ok) throw new CollectionsUnavailable(q.reason || 'the graph could not be read');
    for (const r of q.rows) {
      const m = next.get(r.k.value);
      if (!m) continue;   // a collection no family here owns (a later unit's): not ours to serve
      m.set(r.s.value, { entity: JSON.parse(r.j.value), json: r.j.value, ver: Number(r.v.value) });
    }
    cache = next; uncertain = false; gen++;
  }
  async function ensureFresh() {
    if (cache && !uncertain) return;
    try { await load(); } catch (e) { uncertain = true; throw e instanceof CollectionsUnavailable ? e : new CollectionsUnavailable(e.message); }
  }
  /** key → a fresh mutable array of that collection's entities. */
  function snapshot() {
    if (!cache || uncertain) throw new CollectionsUnavailable('the collection cache is not current');
    return Object.fromEntries([...cache].map(([k, m]) => [k, [...m.values()].map((r) => JSON.parse(r.json))]));
  }
  /** The guarded parts that turn the cache into `data[key]` for every registered key ([] when nothing changed). */
  function plan(data) {
    if (!cache || uncertain) throw new CollectionsUnavailable('the collection cache is not current');
    const parts = [];
    for (const [key, fam] of byKey) {
      const was = cache.get(key);
      const seen = new Set();
      for (const e of Array.isArray(data[key]) ? data[key] : []) {
        const id = e && e['@id'];
        if (typeof id !== 'string') continue;
        seen.add(id);
        const json = JSON.stringify(e);
        const prev = was.get(id);
        if (prev && prev.json === json) continue;
        const unique = fam.unique ? fam.unique(e) : [];
        parts.push(prev
          ? { collection: key, iri: id, expectedVersion: String(prev.ver), version: String(prev.ver + 1), quads: entityQuads(e), prior: entityQuads(prev.entity), json, ...(unique.length ? { unique } : {}) }
          : { collection: key, iri: id, expectedVersion: null, version: '1', quads: entityQuads(e), json, ...(unique.length ? { unique } : {}) });
      }
      for (const [id, prev] of was) if (!seen.has(id)) parts.push({ collection: key, iri: id, remove: true, expectedVersion: String(prev.ver), prior: entityQuads(prev.entity) });
    }
    return parts;
  }
  /** After APPLIED: the cache becomes `data` for every registered key. */
  function applied(data, parts) {
    const written = new Map(parts.filter((p) => !p.remove).map((p) => [p.iri, Number(p.version)]));
    for (const [key, was] of cache) {
      const next = new Map();
      for (const e of Array.isArray(data[key]) ? data[key] : []) {
        const id = e && e['@id'];
        if (typeof id !== 'string') continue;
        const ver = written.get(id);
        next.set(id, ver == null && was.get(id) ? was.get(id) : { entity: JSON.parse(JSON.stringify(e)), json: JSON.stringify(e), ver: ver ?? 1 });
      }
      cache.set(key, next);
    }
    gen++;
  }
  /** A write of collection parts ALONE (no card changed): one entity.put kind 'collection'. */
  async function commit(data, { actor, opId } = {}) {
    const parts = plan(data);
    if (!parts.length) return { outcome: 'NOOP' };
    const intention = { kind: 'entity.put', opId: opId || `urn:ex:op/collections/${mintId()}`, actor: actorIri(actor), entity: { kind: 'collection', parts } };
    let r;
    try { r = await durableUpdate(client, intention); } catch (e) { uncertain = true; throw new CollectionsUnavailable(e.message); }
    if (r.outcome !== 'APPLIED') {
      // UNAVAILABLE: nothing was sent, so the cache is still the graph's. Anything else leaves it to be re-read.
      if (r.outcome !== 'UNAVAILABLE') uncertain = true;
      if (r.outcome === 'PRECONDITION_FAILED' || r.outcome === 'REJECTED') throw Object.assign(new Error(`collection write refused: ${r.outcome}${r.reason ? `: ${r.reason}` : ''}`), { code: 'CARD_WRITE_CONFLICT' });
      throw new CollectionsUnavailable(`the write's outcome is ${r.outcome}${r.reason ? `: ${r.reason}` : ''}`);
    }
    applied(data, parts);
    return { outcome: 'APPLIED', parts: parts.length };
  }
  /** Single-flight, 2 s, nothing cached: the same K7 probe as the card unit. */
  let probing = null;
  function reachable() {
    if (probing) return probing;
    probing = (async () => {
      let timer;
      const timeout = new Promise((r) => { timer = setTimeout(() => r(false), 2000); });
      const ok = await Promise.race([client.query('SELECT ?x WHERE { BIND(1 AS ?x) }').then((q) => q.ok, () => false), timeout]);
      clearTimeout(timer);
      return ok;
    })().finally(() => { probing = null; });
    return probing;
  }
  return {
    keys: [...byKey.keys()], load, ensureFresh, snapshot, plan, applied, commit, reachable,
    markUncertain() { uncertain = true; },
    get generation() { return gen; }, get loaded() { return cache != null; },
  };
}
