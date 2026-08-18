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
import { REL_TYPES, MENTIONS_CARD } from './jsonld.mjs';

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
  // #818 — a relationship member naming no card. It gets its OWN namespace so
  // it can never be mistaken for an entity: IRI that merely failed to resolve;
  // the id in the document was a shortId, not an entity id, and pretending
  // otherwise would invent a target. #530: "never drop or confidently invent."
  unresolved: 'https://scrumboard.local/unresolved/',
  // #814 — a commit is an ENTITY. It was a `git:<sha>` literal, and a literal
  // cannot be traversed, joined or counted.
  commit: 'https://scrumboard.local/commit/',
  // #687 — a label is a CONCEPT. Its own namespace because a label is not a
  // card, a person or a column, and folding it into entity: would make
  // "is this id a card?" un-askable.
  concept: 'https://scrumboard.local/concept/',
  // #792/#857 §VI — a falsifier check. Its own namespace, and its own NODE,
  // because a check is a (claim, ask, expect) TRIPLE that must stay paired:
  // flattened onto the card as literals, two checks give six values and no way
  // to say which ask belongs to which claim.
  check: 'https://scrumboard.local/check/',
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
  projectLabelAliases(store, doc._labelAliases);
  return store;
}

/**
 * #857 §IV — DECLARED label synonyms, as `schema:sameAs` edges.
 *
 * #687 minted one concept per distinct label string and deliberately stopped
 * there. Measured after it shipped: 393 concepts, SEVEN normalised collisions —
 * including a THREE-way one (`building scrum board` / `building-scrum-board` /
 * `building-scrum board`) that every post that night described as two, because a
 * bare-string vocabulary cannot be asked what it contains.
 *
 * ⛔ NOTHING IS MERGED AUTOMATICALLY. Normalisation SURFACES candidates; a seat
 * DECLARES the merge. Two strings that normalise alike are not necessarily one
 * concept, and fusing them at write time would bake an unfalsifiable judgement
 * into the store — the same reason the replica emits facts and leaves
 * interpretation to queries.
 *
 * ⚠️ Emitted from ONE authority (the declared map) and rebuilt every time, so
 * there is no second copy to drift. Aliases whose concept no longer exists emit
 * nothing rather than minting a node for a label no card carries.
 */
export function projectLabelAliases(store, aliases) {
  if (!Array.isArray(aliases)) return store;
  const SA = nn(IRI.schema + 'sameAs');
  for (const row of Array.isArray(aliases) ? aliases : []) {
    const alias = row?.alias, canonical = row?.canonical;
    if (!alias || !canonical || alias === canonical) continue;
    const a = nn(IRI.concept + encodeURIComponent(alias));
    const c = nn(IRI.concept + encodeURIComponent(canonical));
    // Only link concepts that actually exist — a declaration whose concept has
    // since lost every card must not resurrect it as a bare node.
    if (!store.match(a, A, nn(IRI.schema + 'DefinedTerm')).length) continue;
    if (!store.match(c, A, nn(IRI.schema + 'DefinedTerm')).length) continue;
    store.add(oxigraph.triple(a, SA, c));
  }
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
/**
 * #687 — collect the concept nodes this subject currently points at.
 *
 * Read BEFORE the subject's triples are deleted, because afterwards there is
 * nothing left to say which concepts it used to carry — and a sweep with no
 * candidate list would have to scan every concept on every write.
 */
function conceptsOf(store, subject) {
  const K = nn(IRI.schema + 'keywords');
  return store.match(subject, K, null).map((q) => q.object);
}

/**
 * #687 — delete concepts nothing points at any more.
 *
 * ⛔ WHY THIS IS NOT OPTIONAL. Concept triples hang from the CONCEPT's subject,
 * not from the card's, so subject-scoped deletion cannot reach them. The first
 * implementation therefore left a typed, named concept alive after its last
 * card dropped the label — present in an incrementally-synced store and absent
 * from a rebuilt one, which is #714's parity invariant broken and the room's
 * D-rule failing exactly as stated: a derived thing that needs keeping in step
 * with its authority has left the pattern.
 *
 * ⚠️ ONLY sweeps candidates that just lost an edge, and only when NO card still
 * references them — a concept two cards share must survive one of them dropping
 * it. Over-collecting here would be the more damaging bug, since it would delete
 * identities that are still in use and every query would silently narrow.
 */
/**
 * #814 — drop every Blocker node hanging off this card.
 *
 * ⛔ A Blocker's subject is `entity:<card>/blocker/<target>` — DERIVED from the
 * card's id and not equal to it, so `match(cardSubject, null, null)` never
 * reaches it. The first cut relied on that match and I wrote a comment saying
 * there was nothing to sweep. Deleting two scratch cards on production left a
 * Blocker node behind, carrying an owner and a status and pointing at nothing.
 *
 * ⚠️ D5 again — a derived node on a foreign subject, invisible to subject-scoped
 * deletion — committed in the same change whose comment cited D5 as the reason
 * it could not happen. Knowing the failure class does not exempt you from it.
 */
function sweepBlockerNodes(store, cardSubjectIri) {
  sweepDerivedNodes(store, cardSubjectIri, 'Blocker', 'blocker');
  // #814 — the SECOND family on a derived subject. Generalised rather than
  // copied: the first one cost a production orphan because its case was not
  // written, and a second hand-rolled prefix walk would be two places to forget.
  sweepDerivedNodes(store, cardSubjectIri, 'ReleaseCondition', 'rc');
}

/** Delete nodes of `type` whose subject is `<card>/<segment>/…`. */
function sweepDerivedNodes(store, cardSubjectIri, type, segment) {
  const prefix = `${cardSubjectIri}/${segment}/`;
  for (const q of store.match(null, A, nn(IRI.scrum + type))) {
    if (!q.subject.value.startsWith(prefix)) continue;
    for (const t of store.match(q.subject, null, null)) store.delete(t);
  }
}

function sweepOrphanConcepts(store, candidates) {
  const K = nn(IRI.schema + 'keywords');
  for (const t of candidates) {
    if (store.match(null, K, t).length) continue;   // still referenced — leave it
    for (const q of store.match(t, null, null)) store.delete(q);
  }
}

export function updateEntity(store, entity) {
  const subject = nn(subjectIriFor(entity));
  // #687 — read the old concept edges while they still exist.
  const priorConcepts = conceptsOf(store, subject);
  // #792/#857 §VI — a check NODE is #687's D5 shape: a derived node on a
  // foreign subject, which the subject-scoped deletion below cannot see. Drop a
  // check from a card and its node would survive in the synced store while
  // being absent from a rebuilt one — the running server reporting a claim as
  // watched that no rebuild agrees with, and nobody rebuilds to check.
  //
  // ⭐ It CANNOT over-collect, which is the more damaging half of that bug
  // (#687: over-collecting silently narrows every query): candidates are
  // reached only through THIS subject's own hasCheck edges, and a check node is
  // owned by exactly one card — unlike a concept, which is shared and therefore
  // needs the still-referenced test sweepOrphanConcepts does.
  const priorChecks = store.match(subject, nn(IRI.scrum + 'hasCheck'), null).map((q) => q.object);
  // #805 — an RDF collection lives in BLANK NODES, which are their own subjects.
  // Subject-scoped deletion alone would drop `<pv> orderedPrompts _:head` and
  // orphan every `_:cell rdf:first/rdf:rest` triple behind it, forever, on
  // every reorder. Walk and delete the chain FIRST, while the head edge that
  // reaches it still exists.
  dropListChains(store, subject);
  for (const q of store.match(subject, null, null)) store.delete(q);
  // BEFORE re-projecting, unlike the concept sweep below: these nodes are owned
  // outright, so re-projection recreates exactly the ones that survive.
  for (const chk of priorChecks) for (const q of store.match(chk, null, null)) store.delete(q);
  projectEntity(store, entity);
  // AFTER re-projecting: a concept the entity still carries has just been
  // re-added, so it will not be swept. Only genuinely dropped ones are.
  sweepOrphanConcepts(store, priorConcepts);
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
  // #687 — a DELETED card releases its concepts too. Same reasoning as
  // updateEntity: read the edges before the triples that carry them are gone.
  const priorConcepts = conceptsOf(store, subject);
  sweepBlockerNodes(store, subject.value);
  let n = 0;
  for (const q of store.match(subject, null, null)) { store.delete(q); n += 1; }
  sweepOrphanConcepts(store, priorConcepts);
  return n;
}

/**
 * #651 — MEMORY predicate semantics. One explicit table, same discipline as
 * TENDING_PREDICATES: a predicate with no declared kind THROWS rather than
 * reaching the document and never reaching the graph. That refusal is the whole
 * reason the tending projection is trustworthy, and a silent drop here would be
 * worse — the entity class exists precisely so a pruned memory stays findable.
 */
export const MEMORY_PREDICATES = Object.freeze({
  identifier: 'literal',
  name: 'literal',                 // the memory's title
  'scrum:owner': 'person',         // whose memory it is — an EDGE, never a string
  'scrum:tag': 'literal',          // repeatable
  'scrum:currentVersion': 'ref',   // Memory → its newest MemoryVersion
  'scrum:ofMemory': 'ref',         // MemoryVersion → its Memory
  'scrum:version': 'literal',
  'scrum:body': 'literal',         // the text. IMMUTABLE on a version.
  author: 'person',
  dateCreated: 'literal',
});

function projectMemory(store, e) {
  const add = (s, p, o) => store.add(oxigraph.triple(s, p, o));
  const S = IRI.scrum, SC = IRI.schema, P = IRI.person;
  const s = nn(e['@id']);
  add(s, A, nn(S + String(e['@type']).slice(6)));

  const predIri = (k) => (k.startsWith('scrum:') ? nn(S + k.slice(6)) : nn(SC + k));
  const asPerson = (v) => nn(String(v).startsWith('http') ? v : P + v);

  for (const [k, v] of Object.entries(e)) {
    if (k === '@id' || k === '@type' || v === undefined || v === null) continue;
    const kind = MEMORY_PREDICATES[k];
    if (!kind) {
      throw new Error(
        `graph-replica: no projection semantics for memory predicate ${JSON.stringify(k)} `
        + `on ${e['@type']}. Add it to MEMORY_PREDICATES — a fact with no declared `
        + 'kind would otherwise reach the document and never reach the graph.',
      );
    }
    for (const one of Array.isArray(v) ? v : [v]) {
      if (one === undefined || one === null) continue;
      if (kind === 'person') add(s, predIri(k), asPerson(one));
      else if (kind === 'ref') add(s, predIri(k), nn(String(one)));
      else add(s, predIri(k), lit(one));
    }
  }
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
      // an authored, expiring "not yet". parkedBy is an EDGE so "what has
      // this person parked, and until when" is a traversal rather than a scan.
      if (e.parkedBy) add(s, nn(S + 'parkedBy'), personRef(e.parkedBy));
      if (e['scrum:parkedAt']) add(s, nn(S + 'parkedAt'), lit(e['scrum:parkedAt']));
      if (e['scrum:parkedUntil']) add(s, nn(S + 'parkedUntil'), lit(e['scrum:parkedUntil']));
      if (e['scrum:parkedReason']) add(s, nn(S + 'parkedReason'), lit(e['scrum:parkedReason']));
      // #814 — mint one node per sha, however many cards cite it, so the
      // inverse ("what did this commit implement") is a hop rather than a scan.
      // The node carries the sha and nothing else: subject, author and date
      // live in git, the board cannot verify them, and asserting them here
      // would be inventing.
      for (const sha of e.implementedBy || []) {
        if (typeof sha !== 'string' || !sha) continue;
        const c = nn(IRI.commit + sha);
        add(s, nn(S + 'implementedBy'), c);
        add(c, A, nn(S + 'Commit'));
        add(c, nn(SC + 'identifier'), lit(sha));
      }
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
      // #687 — BOTH HALVES, and the literal is not the compromise half.
      //
      // #857 §V: "Membership by label is cheap and bulk; structural children get
      // real edges. Both, on purpose — THE STRING FOR SCALE, THE EDGE FOR
      // TRAVERSAL." The literal is what 391 labels, every `card_list?label=`
      // call and every existing consumer read; it stays, unchanged, forever.
      //
      // What was missing is the other half. #687 closed in 2026-08-05 having
      // stated the exact trigger for building it: "mint concept nodes IF WE WANT
      // LABEL→CARDS TRAVERSAL FROM THE GRAPH SIDE." A literal cannot be a
      // subject, so today you can ask "which labels does this card carry" and
      // you cannot start at a label and walk to its cards. That condition is now
      // met and measured: traversal is one of the three graph-first gaps, and
      // 47% of cards touch nothing.
      //
      // ⚠️ SHAPE, per the room's D-rule: materialized here at PROJECTION time
      // from ONE authority — the card's own labels — and rebuilt every time.
      // There is no second copy to keep in step, so drift stays unrepresentable.
      //
      // ⛔ NOT SYNONYMS. `building scrum board` and `building-scrum-board` get
      // two nodes here and that is correct for this slice: merging them needs a
      // mechanism nobody has designed yet, and identities are a prerequisite for
      // every candidate design. Minting the identity does not decide the merge.
      for (const l of e.labels || []) {
        add(s, nn(S + 'label'), lit(l));
        const t = nn(IRI.concept + encodeURIComponent(l));
        add(s, nn(IRI.schema + 'keywords'), t);
        // Set-semantics per triple, so N cards sharing a label converge on ONE
        // node rather than minting N look-alikes. That convergence IS the
        // identity: without it every query above would still pass while the
        // graph held N unrelated things that happen to spell the same.
        store.add(oxigraph.triple(t, A, nn(IRI.schema + 'DefinedTerm')));
        store.add(oxigraph.triple(t, nn(IRI.schema + 'name'), lit(l)));
      }
      // #792/#857 §VI — the falsifier tripwires, as NODES so (claim, ask,
      // expect) stays a paired triple rather than three loose literals.
      //
      // ⛔ THE `ask` TEXT IS EMITTED VERBATIM AND NOT CLASSIFIED HERE. Four of
      // #857's nine checks are card-state PROXIES ("is #651 in done?") and five
      // are real MEASUREMENTS ("does prov:Activity exist?"), and the output
      // makes them indistinguishable — a proxy watches the same human judgement
      // that rotted §IV three times in thirty-one hours. Deciding which is
      // which belongs in a QUERY, where it can be argued with; baking the rule
      // in here would put an unfalsifiable interpretation in the store.
      (e['scrum:checks'] || []).forEach((c, i) => {
        if (!c || typeof c !== 'object') return;
        const chk = nn(IRI.check + e['@id'] + '-' + i);
        add(s, nn(S + 'hasCheck'), chk);
        add(chk, A, nn(S + 'Check'));
        if (c.claim != null) add(chk, nn(S + 'claim'), lit(c.claim));
        if (c.ask != null) add(chk, nn(S + 'ask'), lit(c.ask));
        if (typeof c.expect === 'boolean') add(chk, nn(S + 'expect'), lit(c.expect));
      });
      // #656 — the DERIVED reference edge, beside the deliberate ones and
      // never merged with them. Kept off REL_TYPES on purpose: that list is
      // the set of relationships a PERSON asserted, and the inverse-sync,
      // dangling-shortId and API-contract code all read it. This edge is
      // computed from card text at projection time, is always resolved (an
      // unresolvable #NNN is dropped upstream, so there is no
      // UnresolvedReference branch to mirror), and its whole purpose is to be
      // queryable — 2,706 edges rescuing 266 otherwise-isolated cards were in
      // the document and in no query until this loop existed.
      for (const r of e[MENTIONS_CARD] || []) {
        if (typeof r === 'string' && r) add(s, nn(S + 'mentionsCard'), nn(E + r));
      }
      // #814 — BLOCKER OWNERSHIP as a typed node beside the edge.
      //
      // `blockedBy` says WHAT blocks this card; it cannot hold WHO is clearing
      // it or WHETHER they still are, so that lived in prose and the graph could
      // find the narration without answering from it.
      //
      // ⭐ KEEP THE EDGE, ADD THE NODE — the shape this room has now settled on
      // twice (the label literal beside its concept, #687). Every existing
      // consumer and traversal reads `blockedBy`, and it is untouched.
      //
      // ⚠️ THE NODE IS DERIVED FROM THE EDGE, and that is the D5 lesson applied
      // at design time rather than discovered after. #687's concepts hung off a
      // FOREIGN subject and orphaned when their last card dropped the label —
      // invisible to subject-scoped deletion, and 1,438 tests could not see it.
      // ⛔ AND THE FIRST VERSION OF THIS COMMENT WAS WRONG. It said these hang
      // off THIS card's subject so "there is nothing to sweep". They do not:
      // the subject is `entity:<card>/blocker/<target>`, DERIVED from the card's
      // id and not equal to it, so subject-scoped deletion never reaches them.
      // Removing the EDGE drops them (they are re-projected from blockedBy);
      // DELETING THE CARD did not, and production proved it. See
      // sweepBlockerNodes, which is called from both paths.
      {
        const blockedBy = new Set((e.blockedBy || []).map(String));
        for (const b of e['scrum:blockers'] || []) {
          if (!b || b.card == null) continue;
          // Serialization already resolved `card` to the target's @id, so this
          // compares like with like. A blocker whose edge is gone emits NOTHING:
          // ownership without a live edge would be state outliving the fact it
          // describes, which is the orphan shape #687 hit.
          const targetIri = blockedBy.has(String(b.card)) ? String(b.card) : null;
          if (!targetIri) continue;
          const bn = nn(`${IRI.entity}${e['@id']}/blocker/${encodeURIComponent(String(b.card))}`);
          add(bn, A, nn(S + 'Blocker'));
          add(bn, nn(S + 'blocks'), s);
          add(bn, nn(S + 'blockedByCard'), nn(E + targetIri));
          if (b.owner) add(bn, nn(S + 'owner'), personRef(b.owner));
          if (b.status) add(bn, nn(S + 'status'), lit(b.status));
          if (b.note) add(bn, nn(S + 'note'), lit(b.note));
        }
      }
      // #814 — ACCEPTANCE EVIDENCE. A release condition becomes a node so
      // "which result discharged which condition" is a join rather than a
      // careful read of two prose blocks in different places.
      //
      // ⭐ REUSES `scrum:evidencedBy`, which the tending vocabulary already
      // declared @id-typed for durable sources. Minting a rival predicate would
      // be the vocabulary-collision shape — two names for one relation, and
      // every query then has to know which subsystem it is standing in.
      //
      // ⚠️ An UNDISCHARGED condition still projects, with no evidence edge, so
      // "not yet met" is an unbound variable rather than a missing row. If only
      // discharged conditions appeared, a card would look accepted precisely
      // because nobody recorded the outstanding ones.
      for (const [i, a] of (e['scrum:acceptance'] || []).entries()) {
        if (!a || typeof a.condition !== 'string' || !a.condition.trim()) continue;
        const rc = nn(`${IRI.entity}${e['@id']}/rc/${i}`);
        add(rc, A, nn(S + 'ReleaseCondition'));
        add(rc, nn(S + 'ofCard'), s);
        add(rc, nn(SC + 'name'), lit(a.condition));
        if (a.note) add(rc, nn(S + 'note'), lit(a.note));
        for (const ref of a.evidence || []) {
          // A sha is a commit; a uuid is a board entity. Both are NODES — the
          // whole point, since a literal cannot be traversed or joined.
          const iri = /^[0-9a-f]{40}$/.test(ref) ? IRI.commit + ref : IRI.entity + ref;
          add(rc, nn(S + 'evidencedBy'), nn(iri));
        }
      }
      // #858 — THE MEMBERSHIP SPINE. Phase 2 chose `parent`/`isPartOf` over
      // `relatedTo` precisely so a membership edge would stay distinguishable
      // from a relatedness edge forever, wrote nineteen of them (the
      // agent-interface seam, the upgrade episode, the wiki-cron cluster, a
      // conference hierarchy) — and the replica never emitted the predicate.
      //
      // ⛔ Nineteen edges, correct in the store, in zero queries. The structural
      // half of Phase 2 was invisible to exactly the traversal it was built for,
      // and #858's RC3 is stated in terms of reachability from the apex.
      //
      // ⚠️ Found by the INVERSE half of #875's guard — "nothing declared has
      // vanished" — which fired while the forward half ("every emitted predicate
      // is declared") passed clean. A guard that runs one direction certifies
      // the other.
      if (typeof e.isPartOf === 'string' && e.isPartOf) {
        add(s, nn(SC + 'isPartOf'), nn(E + e.isPartOf));
      }
      // ONE list, imported — a second copy here is the #618 drift shape.
      for (const rt of REL_TYPES) {
        for (const r of e[rt] || []) {
          if (r == null) continue;
          if (typeof r === 'string') { add(s, nn(S + rt), nn(E + r)); continue; }
          // #818 — the member names no card, so serialization left the raw
          // shortId as a NUMBER ("rides VERBATIM — losslessness beats tidiness
          // on dangling data"). This branch used to skip it, and seven live
          // edges existed in the document and in no query. Skipping also
          // defeated cardEdgesResolved's OPTIONAL join, which exists so a
          // dangling edge appears with an unbound target rather than vanishing
          // — it never fired, because the edge was gone before the query ran.
          const ref = nn(IRI.unresolved + String(r));
          add(s, nn(S + rt), ref);
          add(ref, A, nn(S + 'UnresolvedReference'));
          add(ref, nn(SC + 'identifier'), lit(String(r)));
        }
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
    } else if (t === 'scrum:Memory' || t === 'scrum:MemoryVersion') {
      projectMemory(store, e);
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

  // #885 — REFUSE AN UNBOUNDED PROPERTY PATH, BEFORE IT RUNS.
  //
  // ⚰️ Measured by doing it: `?a !<urn:none>* ?c` — "reachable by ANY predicate"
  // — took /api/graph off the air. REST stayed up; the graph endpoint timed out
  // at 20s and did not recover until the server was restarted, costing another
  // 14s of cold sync. One seat's curiosity, a shared surface down.
  //
  // ⛔ AND IT CANNOT BE A TIMEOUT. `store.query()` below is SYNCHRONOUS: a
  // runaway query blocks Node's event loop, so no timer fires and nothing can
  // cancel it. The only place to stand is before the call.
  //
  // The shape is unbounded BY CONSTRUCTION: a transitive quantifier over a
  // negated property set means "walk every edge in the graph, from everywhere".
  // ⚠️ Precision is load-bearing — a false positive refuses a legal query for a
  // hazard it does not have:
  //     !<x>                depth-1, any predicate       ALLOWED (fast, useful)
  //     (a|b)* / p*         enumerated                   ALLOWED (692 rows, 25ms)
  //     !<x>* / !(a|b)+     unbounded, any predicate     REFUSED
  //
  // ⭐ The message names the alternative, because the enumerated form is the
  // right answer and is not obvious. A guard that refuses without teaching is a
  // guard people learn to route around.
  const UNBOUNDED_ANY_PATH = /![\s]*(?:<[^>]*>|\([^)]*\))[\s]*[*+]/;
  if (UNBOUNDED_ANY_PATH.test(sparql)) {
    throw Object.assign(
      new Error(
        'unbounded property path: a transitive quantifier (* or +) over a negated property set '
        + '(!<...>) walks every edge in the graph from every node. This query cannot be bounded or '
        + 'cancelled once started — the engine is synchronous, so it would block every other caller '
        + 'until the process is restarted. It has taken this endpoint down once.',
      ),
      {
        code: 'UNBOUNDED_PATH',
        hint: 'Enumerate the predicates you actually mean. On this board '
          + '(scrum:relatedTo|scrum:mentionsCard|scrum:blockedBy|scrum:supersedes|scrum:derivedFrom'
          + '|scrum:supersededBy|schema:isPartOf) with * answers a full-corpus closure in ~25ms. '
          + 'A depth-1 !<urn:none> is also fine — it is only the transitive form that is unbounded.',
      },
    );
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
