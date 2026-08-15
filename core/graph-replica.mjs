/**
 * core/graph-replica.mjs — #694: the graph traversal engine.
 *
 * An in-process Oxigraph store projected from the JSON-LD document. The store
 * FILE stays the authority (#642 R2 lineage: the log → the document → this);
 * the replica is disposable, rebuilt from the document whenever it is stale,
 * and never written through — `query()` structurally refuses SPARQL UPDATE
 * (verified: oxigraph parses updates only via `update()`, which nothing here
 * calls).
 *
 * Spike-decided (2026-08-05, live corpus): Oxigraph answers an UNBOUNDED
 * transitive traversal in 2ms where the property-graph alternative took 7.6s
 * depth-capped. The projection below is the spike's, made whole.
 *
 * The principal's acceptance criterion, verbatim on #694: the tool has to have
 * PULL — better than the file, better than composed API calls — or agents
 * simply won't reach for it. Bounded results and prefixed-IRI shortening are
 * token-efficiency features in service of that, not politeness.
 */

import oxigraph from 'oxigraph';
import { createHash } from 'node:crypto';
import { REL_TYPES } from './jsonld.mjs';

export const IRI = Object.freeze({
  entity: 'https://scrumboard.local/entity/',
  person: 'https://scrumboard.local/person/',
  column: 'https://scrumboard.local/column/',
  scrum: 'https://scrumboard.local/ns#',
  schema: 'https://schema.org/',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  // #725 — activities from the event log. PROV-O is the W3C vocabulary for
  // "something happened, and someone was responsible", which is exactly what an
  // event record is and exactly what a Comment is not.
  activity: 'https://scrumboard.local/activity/',
  prov: 'http://www.w3.org/ns/prov#',
});

/** Prepended to every query so agents never hand-declare a prefix. */
export const SPARQL_PREFIXES = Object.entries(IRI)
  .map(([p, iri]) => `PREFIX ${p}: <${iri}>`).join('\n');

export const DEFAULT_LIMIT = 100;
export const LIMIT_CEILING = 1000;

const nn = (i) => oxigraph.namedNode(i);
const lit = (v) => oxigraph.literal(String(v));
const A = nn(IRI.rdf + 'type');

/**
 * JSON-LD document → triples. Bare-uuid @ids become entity: IRIs; people and
 * columns already carry their IRI @ids and keep them. Dangling relationship
 * values that are not strings (legacy shortId numbers) are not edges and are
 * skipped — the DOCUMENT keeps them verbatim; the replica only speaks graph.
 */
export function buildGraphStore(doc) {
  const store = new oxigraph.Store();
  for (const e of doc['@graph'] || []) projectEntity(store, e);
  return store;
}

/**
 * #725 — event log → prov:Activity triples.
 *
 * The board has written structured events for every mutation since 2026-08-04
 * and the graph has never read them. `deriveEvents()` emits
 * `{seq, actor, op, entity:{kind,id}, occurred_at}` and `appendEvent()`
 * persists them. That record IS a PROV Activity — actor is who was responsible,
 * op is what happened, entity is what it happened to.
 *
 * WHY THIS IS SEPARATE FROM THE DOCUMENT. The same fact is currently stored
 * TWICE: once structurally in the log, and once as prose ("🔔 <seat> claimed
 * #726") in a Comment authored by `person:board` — a node with 267 references
 * and zero triples, because the board is not a person. Projecting the events
 * gives the fact a home that does not require inventing a speaker, and leaves
 * the prose alone.
 *
 * ⇒ Today "who moved cards, and when" CANNOT be asked (the mover is prose in a
 * body) and "what did each person say this week" silently includes 267 machine
 * events. Both stop being true once activities are distinct from speech.
 *
 * Idempotent by `seq`, which is the event's identity: replaying the log on a
 * rebuild is not new history. Malformed records are skipped rather than thrown
 * on — a real append-only log carries real junk, and a projection that dies on
 * one bad line takes the whole query surface with it.
 *
 * Sizing measured before building, not after: 1,624 events over 4 days is
 * ~8,120 triples against a store already holding ~70,748 — about 11%, so this
 * is unfiltered. There was no decision to make.
 */
export function projectActivities(store, events) {
  for (const ev of events || []) {
    if (!ev || typeof ev !== 'object') continue;
    const { seq, actor, op } = ev;
    const ent = ev.entity;
    // seq is identity (without it the activity doubles on every rebuild), op is
    // what happened, entity is what it happened to. All three are required.
    //
    // ⚠️ ACTOR IS NOT REQUIRED, and that was a real defect caught on live data.
    // A first cut dropped any event with `actor: null` — which turned out to be
    // 23 genuine card updates whose actor simply was not recorded. Skipping them
    // undercounted "who moved cards" by 23 and said nothing about it: silently
    // discarding a population and reporting a clean number, which is the defect
    // class this whole card exists to remove. An activity with an unknown actor
    // still HAPPENED. It is projected without wasAssociatedWith, which makes
    // "activities nobody is accountable for" a query rather than an absence.
    if (seq == null || !op || !ent || !ent.id) continue;

    const a = nn(IRI.activity + `seq-${seq}`);
    // Identity check BEFORE writing: `store.add` is set-semantics per triple,
    // but re-deriving the IRI each rebuild is what keeps that true. Guarding
    // here also makes the idempotence explicit rather than incidental.
    if (store.match(a, A, nn(IRI.prov + 'Activity')).length) continue;

    store.add(oxigraph.triple(a, A, nn(IRI.prov + 'Activity')));
    if (actor) store.add(oxigraph.triple(a, nn(IRI.prov + 'wasAssociatedWith'), nn(IRI.person + actor)));
    store.add(oxigraph.triple(a, nn(IRI.scrum + 'op'), lit(op)));
    store.add(oxigraph.triple(a, nn(IRI.prov + 'used'), nn(IRI.entity + ent.id)));
    // `entityKind` is projected as its own literal so "card activity only" is a
    // triple pattern rather than an IRI-prefix string match — the difference
    // between a query anyone can write and one only its author can.
    if (ent.kind) store.add(oxigraph.triple(a, nn(IRI.scrum + 'entityKind'), lit(ent.kind)));
    const when = ev.occurred_at || ev.recorded_at;
    if (when) store.add(oxigraph.triple(a, nn(IRI.prov + 'startedAtTime'), lit(when)));
  }
  return store;
}

/**
 * #714 — the subject IRI an entity's triples hang from. Cards and messages carry
 * bare uuids and live under entity:; people and columns already carry full IRIs
 * and keep them. One rule covers every class, which is what makes subject-scoped
 * deletion safe: `match(subject, null, null)` finds exactly this entity's own
 * triples and nothing else's — an arrow FROM another card TO this one is stored
 * under that other card's subject and is therefore untouched.
 */
/**
 * #805 — THE TENDING PREDICATE SEMANTICS REGISTRY.
 *
 * One explicit table, not nine per-type branches and not a heuristic. Every
 * predicate the bootstrap or the runtime writers emit declares whether it is a
 * literal, an edge to a Person, an edge to another entity, or an ordered list.
 *
 * ⛔ WHY NOT INFER IT. A first cut guessed: uuid-shaped values became edges and
 * everything else became a literal. That is a rule which is right until the day
 * a body text happens to look like a uuid, or an evidence ref stops doing so —
 * and when it is wrong it is SILENTLY wrong, because a literal where an edge
 * belonged simply fails to join and returns fewer rows. Declaring beats
 * sniffing precisely where the failure is a quiet undercount.
 *
 * ⚠️ An unknown predicate on a tending entity THROWS rather than being dropped
 * or guessed at. That is deliberate and it is the completeness property: adding
 * a field to the bootstrap without teaching the projector cannot silently ship
 * a fact that never reaches the graph — which is exactly how the whole tending
 * system came to exist in the document and nowhere else.
 */
export const TENDING_PREDICATES = Object.freeze({
  // identity / structure
  identifier: 'literal',
  'scrum:ofPrompt': 'iri',
  'scrum:ofPlaylist': 'iri',
  'scrum:ofMint': 'iri',
  'scrum:ofSilence': 'iri',
  'scrum:orderedPrompts': 'list',
  'scrum:version': 'literal',
  // prompt content + provenance
  'scrum:body': 'literal',
  author: 'person',
  'scrum:influencedBy': 'person',
  'scrum:evidencedBy': 'iri',
  'scrum:provenanceNote': 'literal',
  'scrum:importedAt': 'literal',
  // state + control
  'scrum:enabled': 'literal',
  'scrum:paused': 'literal',
  'scrum:pausedAt': 'literal',
  'scrum:actor': 'person',
  'scrum:occurredAt': 'literal',
  // mint / settlement
  'scrum:legacyClockWindow': 'literal',
  'scrum:silenceSince': 'literal',
  'scrum:mintedAt': 'literal',
  'scrum:claimValidUntil': 'literal',
  'scrum:promptVersion': 'iri',
  'scrum:seatNamesWithOpenStreamsAtSend': 'person',
  // claim attempts
  'scrum:receivedAt': 'literal',
  'scrum:completedAt': 'literal',
  'scrum:outcome': 'literal',
  'scrum:declaredSeat': 'person',
  'scrum:declaredSeatRaw': 'literal',
  'scrum:heldByAttempt': 'iri',
  'scrum:reason': 'literal',
});

/**
 * #805 — project one tending entity as FACTS.
 *
 * Before this existed these entities fell to the unknown-class fallback, which
 * emits type + identifier and stops. Measured on the bootstrap output: nine
 * entities, thirteen triples, every one rdf:type or identifier. `graph_query`
 * could discover that a prompt version EXISTED and learn nothing about it — not
 * its text, not its author, and not the playlist order we had just spent the
 * evening declaring in the JSON-LD context.
 */
function projectTending(store, e) {
  const add = (s, p, o) => store.add(oxigraph.triple(s, p, o));
  const S = IRI.scrum, SC = IRI.schema, E = IRI.entity, P = IRI.person;
  const s = nn(e['@id']);
  add(s, A, nn(S + String(e['@type']).slice(6)));

  const predIri = (k) => (k.startsWith('scrum:') ? nn(S + k.slice(6)) : nn(SC + k));
  const asPerson = (v) => nn(String(v).startsWith('http') ? v : P + v);
  // A bare uuid is a board entity (a Comment, usually — evidence points at the
  // real utterance). Anything else already carries its own IRI, or is a source
  // ref like `git:2a6f4d0` that names no node and stays a literal rather than
  // minting an entity that does not exist.
  const asRef = (v) => (/^[0-9a-f-]{36}$/i.test(String(v)) ? nn(E + v)
    : String(v).startsWith('http') ? nn(String(v)) : lit(v));

  for (const [k, v] of Object.entries(e)) {
    if (k === '@id' || k === '@type' || v === undefined || v === null) continue;
    const kind = TENDING_PREDICATES[k];
    if (!kind) {
      throw new Error(
        `graph-replica: no projection semantics for tending predicate ${JSON.stringify(k)} `
        + `on ${e['@type']}. Add it to TENDING_PREDICATES — a fact with no declared `
        + 'kind would otherwise reach the document and never reach the graph.',
      );
    }
    if (kind === 'list') {
      const items = Array.isArray(v?.['@list']) ? v['@list'] : null;
      if (!items) {
        throw new Error(`graph-replica: ${k} must be {"@list":[…]} — a bare array is an unordered set`);
      }
      if (!items.length) { add(s, predIri(k), nn(IRI.rdf + 'nil')); continue; }
      // Blank-node names derive from the OWNING subject, so two playlists cannot
      // collide and re-projecting the same entity is stable.
      const tag = createHash('sha256').update(e['@id']).digest('hex').slice(0, 12);
      const cell = (i) => oxigraph.blankNode(`tl${tag}_${i}`);
      add(s, predIri(k), cell(0));
      items.forEach((item, i) => {
        add(cell(i), nn(IRI.rdf + 'first'), asRef(item));
        add(cell(i), nn(IRI.rdf + 'rest'), i + 1 < items.length ? cell(i + 1) : nn(IRI.rdf + 'nil'));
      });
      continue;
    }
    for (const one of (Array.isArray(v) ? v : [v])) {
      if (one === undefined || one === null) continue;
      add(s, predIri(k), kind === 'person' ? asPerson(one) : kind === 'iri' ? asRef(one) : lit(one));
    }
  }
}

export function subjectIriFor(entity) {
  const id = String(entity['@id']);
  return id.startsWith('http') ? id : IRI.entity + id;
}

/**
 * #714 — re-index ONE entity: drop the triples it owns, emit them again from its
 * current state. This is the loop body `buildGraphStore` has always run over
 * everything; nothing here is computed across entities, which is the property
 * that makes incremental maintenance possible at all.
 */
export function updateEntity(store, entity) {
  const subject = nn(subjectIriFor(entity));
  // #805 — an RDF collection lives in BLANK NODES, which are their own subjects.
  // Subject-scoped deletion alone would drop `<pv> orderedPrompts _:head` and
  // orphan every `_:cell rdf:first/rdf:rest` triple behind it, forever, on
  // every reorder. Walk and delete the chain FIRST, while the head edge that
  // reaches it still exists.
  dropListChains(store, subject);
  for (const q of store.match(subject, null, null)) store.delete(q);
  projectEntity(store, entity);
}

/**
 * #805 — delete every RDF-list cell reachable from `subject`'s list-valued
 * predicates. Walks rdf:rest to the end rather than assuming a length, so a
 * list that SHRANK does not leave its old tail behind.
 */
function dropListChains(store, subject) {
  const REST = nn(IRI.rdf + 'rest');
  for (const q of store.match(subject, null, null)) {
    if (q.object.termType !== 'BlankNode') continue;
    let cell = q.object;
    const seen = new Set();
    while (cell && cell.termType === 'BlankNode' && !seen.has(cell.value)) {
      seen.add(cell.value);
      const rest = store.match(cell, REST, null)[0]?.object;
      for (const c of store.match(cell, null, null)) store.delete(c);
      cell = rest;
    }
  }
}

/** #714 — remove an entity's own triples without re-emitting (deletion). */
export function removeEntity(store, idOrEntity) {
  const id = typeof idOrEntity === 'string' ? idOrEntity : subjectIriFor(idOrEntity);
  // #805 — same reason as updateEntity: the list chain is not this subject's.
  dropListChains(store, nn(id.startsWith('http') ? id : IRI.entity + id));
  const subject = nn(id.startsWith('http') ? id : IRI.entity + id);
  let n = 0;
  for (const q of store.match(subject, null, null)) { store.delete(q); n += 1; }
  return n;
}

/** Emit one entity's triples into `store`. The projection, per entity. */
function projectEntity(store, e) {
  const add = (s, p, o) => store.add(oxigraph.triple(s, p, o));
  const S = IRI.scrum, SC = IRI.schema, E = IRI.entity, P = IRI.person, C = IRI.column;
  const personRef = (k) => nn(String(k).startsWith('http') ? k : P + k);

  {
    const t = e['@type'];
    if (t === 'CreativeWork') {
      const s = nn(E + e['@id']);
      add(s, A, nn(SC + 'CreativeWork'));
      if (e.identifier != null) add(s, nn(SC + 'identifier'), lit(e.identifier));
      if (e.name != null) add(s, nn(SC + 'name'), lit(e.name));
      if (e.text) add(s, nn(SC + 'text'), lit(e.text));
      if (e.additionalType) add(s, nn(S + 'cardType'), lit(String(e.additionalType).replace(/^scrum:/, '')));
      if (e.dateCreated) add(s, nn(SC + 'dateCreated'), lit(e.dateCreated));
      if (e.dateModified) add(s, nn(SC + 'dateModified'), lit(e.dateModified));
      if (e.creator) add(s, nn(SC + 'creator'), personRef(e.creator));
      if (e.column) add(s, nn(S + 'column'), nn(C + e.column));
      if (e['scrum:priority']) add(s, nn(S + 'priority'), lit(e['scrum:priority']));
      if (e['scrum:order'] != null) add(s, nn(S + 'order'), lit(e['scrum:order']));
      if (e.claimedBy) add(s, nn(S + 'claimedBy'), personRef(e.claimedBy));
      // #723 — claimedAt sat beside claimedBy in the document and was never
      // emitted, so a graph-backed card_get would have dropped it silently. It
      // is load-bearing: the stall-watch keys on "claimed and unchanged across
      // two checks", which needs the timestamp, not just the holder.
      if (e['scrum:claimedAt']) add(s, nn(S + 'claimedAt'), lit(e['scrum:claimedAt']));
      // #723 — `for` is free text, not a person. Measured across the corpus:
      // 100 cards set it, 74 distinct values, and only a quarter resemble any
      // kind of name. The rest are teams, systems, outcomes, and in several
      // cases a full acceptance criterion in a sentence. One value names three
      // different things at once, only one of which is a person.
      //
      // So: a LITERAL, not a personRef. Routing this through the person
      // namespace would mint ~74 entities, most of which are not people — the
      // same coercion that already put a bot, a wiki and a monitor in /person/
      // (see the range-restriction card). It is also the only place a card's
      // beneficiary is recorded, so projecting it makes that VISIBLE to the
      // graph.
      //
      // Visible, not yet answerable: the values are unnormalised, so the most
      // common beneficiary appears under two literals differing only in case
      // and an exact-match query silently returns about three quarters of them.
      // Normalising belongs at the write path or in a companion predicate, not
      // here — coercing free text into entities is the defect this comment
      // already declines to commit.
      if (e['scrum:for']) add(s, nn(S + 'for'), lit(e['scrum:for']));
      for (const a of e.assignees || []) if (a && a !== 'unassigned') add(s, nn(S + 'assignee'), personRef(a));
      for (const l of e.labels || []) add(s, nn(S + 'label'), lit(l));
      // ONE list, imported — a second copy here is the #618 drift shape.
      for (const rt of REL_TYPES) {
        for (const r of e[rt] || []) if (typeof r === 'string') add(s, nn(S + rt), nn(E + r));
      }
    } else if (t === 'Comment') {
      const s = nn(E + e['@id']);
      add(s, A, nn(SC + 'Comment'));
      if (e.author) add(s, nn(SC + 'author'), personRef(e.author));
      if (typeof e.about === 'string' && e.about !== 'null') add(s, nn(SC + 'about'), nn(E + e.about));
      if (e.dateCreated) add(s, nn(SC + 'dateCreated'), lit(e.dateCreated));
      if (e.text) add(s, nn(SC + 'text'), lit(e.text));
      for (const m of e.mentions || []) if (m) add(s, nn(S + 'mentionsName'), lit(m));
    } else if (t === 'Person') {
      const s = nn(e['@id']);
      add(s, A, nn(SC + 'Person'));
      if (e.identifier) add(s, nn(SC + 'identifier'), lit(e.identifier));
      if (e.name) add(s, nn(SC + 'name'), lit(e.name));
      add(s, nn(S + 'resolved'), lit(!!e['scrum:resolved']));
    } else if (t === 'scrum:Column') {
      const s = nn(e['@id']);
      add(s, A, nn(S + 'Column'));
      if (e.identifier) add(s, nn(SC + 'identifier'), lit(e.identifier));
      if (e.name) add(s, nn(SC + 'name'), lit(e.name));
      if (e['scrum:order'] != null) add(s, nn(S + 'order'), lit(e['scrum:order']));
    } else if (typeof t === 'string' && t.startsWith('scrum:Tending')) {
      projectTending(store, e);
    } else if (e && e['@id']) {
      // An entity class this projection doesn't know yet (wiki pages are
      // already in the event vocabulary; more will come). It must NOT vanish:
      // a query that can't see an entity class serves silently partial answers,
      // and nothing looks identical to "nothing exists". Surface it minimally —
      // typed, named, findable — so its absence from richer queries is
      // DISCOVERABLE rather than invisible. Pinned by the completeness test.
      const s = nn(String(e['@id']).startsWith('http') ? e['@id'] : E + e['@id']);
      add(s, A, nn(typeof t === 'string' && t.startsWith('scrum:') ? S + t.slice(6) : SC + (t || 'Thing')));
      if (e.identifier != null) add(s, nn(SC + 'identifier'), lit(e.identifier));
      if (e.name != null) add(s, nn(SC + 'name'), lit(e.name));
    }
  }
}

/**
 * #714 — bring `store` up to date with `doc` by touching only what changed.
 *
 * The full rebuild is paid by whoever queries next after ANY write, which is why
 * nothing could be built on top of the graph. Measured on the live board — 13,256
 * entities, 67,413 triples:
 *
 *   sync after one card edit   ~104ms   (1 entity re-projected)
 *   sync with nothing changed   ~85ms   (0 re-projected — the hash pass alone)
 *   cold sync                  ~6.2s    vs ~5.1s for a cold full rebuild
 *
 * ⚠️ So this is NOT a free win: the hash pass makes a COLD start ~20% slower.
 * That is the right trade only because cold happens once per process and the
 * post-write path happens on every query — but it is a real cost and should not
 * be reported as a pure improvement. Cold-path timings are also noisy (the same
 * full rebuild measured 2.1s and 5.1s in different processes), so treat the
 * seconds-scale figures as order-of-magnitude and the ~100ms warm figure — which
 * is stable and is the one that matters — as the actual result.
 *
 * Returns the new hash map plus counts, so a caller can log what it actually did
 * rather than assert it. Pass `prev = null` for a cold start (projects
 * everything and is exactly a full rebuild).
 */
export function syncGraphStore(store, doc, prev) {
  const next = new Map();
  const entities = doc['@graph'] || [];
  let updated = 0, removed = 0;
  for (const e of entities) {
    if (!e || e['@id'] == null) continue;
    const key = subjectIriFor(e);
    const hash = createHash('sha1').update(JSON.stringify(e)).digest('hex');
    next.set(key, hash);
    if (!prev) {
      // Cold start: nothing to replace, so the match-and-delete is pointless work.
      projectEntity(store, e); updated += 1;
    } else if (prev.get(key) !== hash) { updateEntity(store, e); updated += 1; }
  }
  // Entities that vanished from the document lose their triples. Arrows POINTING
  // at them survive under their own subjects — the same dangling-reference
  // behaviour a full rebuild produces, since it projects whatever the document
  // says and the document is what dropped them.
  if (prev) {
    for (const key of prev.keys()) {
      if (!next.has(key)) { removeEntity(store, key); removed += 1; }
    }
  }
  return { hashes: next, updated, removed, total: entities.length };
}

/** IRI → prefixed short form for token-efficient results. */
function shorten(value) {
  for (const [p, iri] of Object.entries(IRI)) {
    if (value.startsWith(iri)) return `${p}:${value.slice(iri.length)}`;
  }
  return value;
}

/**
 * Run a read query. SELECT and ASK only — a shape the engine enforces
 * structurally (query(), never update()) and this wrapper enforces socially
 * with a clear refusal instead of a parser error.
 *
 * Bounded by default: a query with no LIMIT gets DEFAULT_LIMIT; any LIMIT is
 * capped at LIMIT_CEILING; the cut is confessed via `truncated` (fetched at
 * limit+1, same trick as every bounded surface here).
 */
export function queryGraph(store, sparql, { limit } = {}) {
  if (typeof sparql !== 'string' || !sparql.trim()) throw Object.assign(new Error('empty query'), { code: 'EMPTY_QUERY' });
  if (/\b(INSERT|DELETE|LOAD|CLEAR|DROP|CREATE|MOVE|COPY|ADD)\b/i.test(sparql.replace(/<[^>]*>/g, ''))) {
    throw Object.assign(new Error('graph_query is READ-ONLY: SELECT or ASK. Writes go through the board API, which is what gives them events, actors and rails.'), { code: 'READ_ONLY' });
  }

  const declared = sparql.match(/\bLIMIT\s+(\d+)/i);
  const wanted = Math.min(Number(limit ?? (declared ? declared[1] : DEFAULT_LIMIT)) || DEFAULT_LIMIT, LIMIT_CEILING);
  const probe = wanted + 1;
  const body = declared ? sparql.replace(/\bLIMIT\s+\d+/i, `LIMIT ${probe}`) : `${sparql}\nLIMIT ${probe}`;

  const t = performance.now();
  const out = store.query(`${SPARQL_PREFIXES}\n${body}`);
  const ms = performance.now() - t;

  if (typeof out === 'boolean') return { ask: out, rows: [], returned: 0, truncated: false, ms };
  const rows = [];
  for (const binding of out) {
    const row = {};
    for (const [k, v] of binding.entries()) {
      row[k] = v.termType === 'NamedNode' ? shorten(v.value) : v.value;
    }
    rows.push(row);
    if (rows.length > wanted) break;
  }
  const truncated = rows.length > wanted;
  if (truncated) rows.length = wanted;
  return { rows, returned: rows.length, truncated, limit: wanted, ms: Math.round(ms * 10) / 10 };
}
