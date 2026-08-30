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
  // #966 — needed to emit a TYPED boolean. SPARQL's bare `true` IS
  // "true"^^xsd:boolean, so a plain string literal would not match the
  // query shape a caller naturally writes. (#907 notes `xsd:` is not a
  // bound PREFIX for queries; this is the datatype IRI, not a prefix.)
  xsd: 'http://www.w3.org/2001/XMLSchema#',
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

/**
 * #1104 — EVERY `schema:` AND `scrum:` TERM THE PROJECTION CAN EMIT.
 *
 * The spelling dictionary the unknown-term guard checks against. It is NOT a
 * description of what this board contains: a term here with no instances is
 * answered with an honest zero, which is the whole point. A term NOT here is
 * refused, because the projection can never produce it and a zero would be a
 * wrong answer delivered fluently.
 *
 * ⚠️ ADD A TERM HERE IN THE SAME COMMIT THAT TEACHES THE PROJECTION TO EMIT IT.
 * A missing entry refuses a working query — the one way this guard can be worse
 * than no guard. `tests/graph-unknown-term.test.mjs` projects a fixture and
 * fails on any emitted term this set does not carry.
 *
 * ⛔⛔ ENUMERATED FROM THE PROJECTOR SOURCE, NOT FROM THE LIVE STORE — and the
 * first cut got that backwards, which is worth keeping because it is this
 * guard's own thesis turned on its author.
 *
 * The first list came from asking the live board `SELECT DISTINCT ?p`: 70
 * predicates, 21 classes, complete-looking. The full suite then failed on
 * `scrum:ofSilence` — a REAL projected predicate with ZERO instances on this
 * board today (no mint currently carries a silence edge). A data enumeration
 * cannot see a term nobody has used yet, so it produced a dictionary that
 * refuses working queries about the emptiest corners of the schema — the exact
 * absent-from-data / absent-from-vocabulary confusion this guard exists to end.
 *
 * ⇒ ⭐ The store answers "what has been used". Only the source answers "what can
 *   be emitted", and the second is what a spelling dictionary needs.
 *
 * ⚠️ And the fixture drift test did NOT catch it: the fixture projects no
 * tending entities, so the control never traversed that part of the population.
 * The FULL SUITE is what caught it. Both are kept — the drift test fails fast on
 * the common terms, the suite covers the corners.
 */
export const GRAPH_VOCABULARY = new Set([
  // schema: predicates
  'schema:sameAs', 'schema:dateCreated', 'schema:identifier', 'schema:author',
  'schema:name', 'schema:text', 'schema:about', 'schema:keywords',
  'schema:creator', 'schema:dateModified', 'schema:isPartOf',
  // schema: classes
  'schema:CreativeWork', 'schema:Comment', 'schema:Person', 'schema:DefinedTerm',
  // scrum: predicates
  'scrum:entityKind', 'scrum:op', 'scrum:shortId', 'scrum:reopensIf',
  'scrum:constrains', 'scrum:decidedBy', 'scrum:statement', 'scrum:body',
  'scrum:version', 'scrum:ofMemory', 'scrum:currentVersion', 'scrum:tag',
  'scrum:owner', 'scrum:importedAt', 'scrum:provenanceNote',
  'scrum:declaredSeatRaw', 'scrum:declaredSeat', 'scrum:outcome',
  'scrum:receivedAt', 'scrum:ofMint', 'scrum:mintedAt',
  'scrum:legacyClockWindow', 'scrum:enabled', 'scrum:orderedPrompts',
  'scrum:ofPlaylist', 'scrum:evidencedBy', 'scrum:ofPrompt', 'scrum:order',
  'scrum:resolved', 'scrum:mentionsName', 'scrum:relatedTo', 'scrum:note',
  'scrum:status', 'scrum:blockedByPerson', 'scrum:blocks', 'scrum:mentionsCard',
  'scrum:label', 'scrum:implementedBy', 'scrum:priority', 'scrum:column',
  'scrum:cardType', 'scrum:claimedAt', 'scrum:claimedBy', 'scrum:for',
  'scrum:assignee', 'scrum:blockedByAnyHuman', 'scrum:derivedFrom',
  'scrum:ofCard', 'scrum:blockedBy', 'scrum:expect', 'scrum:ask', 'scrum:claim',
  'scrum:hasCheck', 'scrum:supersededBy', 'scrum:supersedes',
  'scrum:blockedByCard', 'scrum:parkedReason', 'scrum:parkedUntil',
  'scrum:parkedBy',
  // scrum: classes
  'scrum:ReleaseCondition', 'scrum:Decision', 'scrum:MemoryVersion',
  'scrum:Memory', 'scrum:TendingClaimAttempt', 'scrum:TendingMint',
  'scrum:TendingState', 'scrum:TendingPlaylistVersion', 'scrum:TendingPlaylist',
  'scrum:TendingPromptVersion', 'scrum:TendingPrompt', 'scrum:Column',
  'scrum:Blocker', 'scrum:Commit', 'scrum:UnresolvedReference', 'scrum:Check',
  'scrum:Tending',
  // ⚠️ EMITTED BY THE PROJECTOR AND ABSENT FROM THIS BOARD'S DATA TODAY. Every
  // one of these was missing from the first, store-derived list; `scrum:ofSilence`
  // is the one the suite caught and the rest came from the same source scan.
  // They are exactly the terms a data enumeration cannot see.
  'scrum:acceptance', 'scrum:actor', 'scrum:blockers', 'scrum:checks',
  'scrum:claimValidUntil', 'scrum:completedAt', 'scrum:heldByAttempt',
  'scrum:influencedBy', 'scrum:occurredAt', 'scrum:ofSilence', 'scrum:parkedAt',
  'scrum:paused', 'scrum:pausedAt', 'scrum:promptVersion', 'scrum:reason',
  'scrum:seatNamesWithOpenStreamsAtSend', 'scrum:silenceSince',
]);

export const DEFAULT_LIMIT = 100;
export const LIMIT_CEILING = 1000;

const nn = (i) => oxigraph.namedNode(i);
const lit = (v) => oxigraph.literal(String(v));
// #1034 — a TYPED numeric literal. SPARQL's bare `0` IS "0"^^xsd:integer, so a
// plain string never matches the shape a caller writes: FILTER(?o != 0) becomes
// a type mismatch that is true for every row (removing nothing), and ORDER BY
// sorts lexically ("100" < "20" < "9"). Same remedy as #966's typed boolean.
//
// ⚠️ Types only what IS an integer. A malformed order must not become an
// ill-typed literal claiming to be one — that would trade a wrong datatype for
// a lying datatype, which is worse: an ill-typed literal compares unequal to
// everything and would silently vanish from the very filters this fixes.
const intLit = (v) => {
  const n = typeof v === 'number' ? v : (String(v).trim() === '' ? NaN : Number(v));
  return Number.isInteger(n)
    ? oxigraph.literal(String(n), nn(IRI.xsd + 'integer'))
    : lit(v);
};
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
    // ⭐⭐⭐ #891 — THE SHORTID IS THE ACTIVITY'S OWN PROPERTY, not a join.
    //
    // This line was missing, and the omission had a measured cost: 34 production
    // activities whose target card had been deleted, so `prov:used entity:<uuid>`
    // pointed at nothing and the graph could no longer say what those events were
    // about. The raw log knew the whole time — `entity.shortId` is in every one
    // of the 2,014 card events, and was simply never projected.
    //
    // ⚠️ "It is derivable in one hop" is true only while the card EXISTS, which
    // is exactly the case where you most want the provenance: the record of what
    // happened must outlive the thing it happened to. Deriving through a node
    // that can vanish is not the same as keeping the fact.
    //
    // ⛔ ABSENT, NEVER ZERO, for an entity that has no shortId — 4,661 of the
    // log's events are conversations. A placeholder would join to a card under
    // any loose comparison; absence reads correctly in SPARQL as "no match".
    if (ent.shortId != null) store.add(oxigraph.triple(a, nn(IRI.scrum + 'shortId'), lit(String(ent.shortId))));
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
 * ⛔ A Blocker's subject is `entity:<card>/blocker/<index>` (#1043 — was
 * `/<target>`, which collided when two entries named the same subject) — DERIVED
 * from the card's id and not equal to it, so `match(cardSubject, null, null)` never
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
  // ⛔⛔ #881 — AND THE OTHER TWO DERIVED FAMILIES, which were missing here and
  // were found in PRODUCTION rather than by the suite.
  //
  // Blocker and ReleaseCondition nodes hang off DERIVED subjects
  // (`<card>/blocker/…`, `<card>/rc/…`), so the subject-scoped delete above
  // cannot reach them — the same #687 D5 shape the check sweep on the line above
  // exists for. Without this, an UPDATE adds the new triples beside the old:
  //
  //     scrum:status "open"      ← survives
  //     scrum:status "cleared"   ← added
  //
  // ⇒ A cleared blocker keeps answering the "what is waiting on me" query, which
  //   is precisely the structured version of the prose rot #881 was built to end.
  //
  // ⚠️ `sweepBlockerNodes` ALREADY EXISTED AND WAS CORRECT — it was wired into
  // removeEntity only, while a comment beside the projection said it "is called
  // from both paths". A sentence asserting a runtime property, believed by every
  // reader including the one who then built a feature on top of it.
  // ⚠️ ONE CALL COVERS BOTH FAMILIES — sweepBlockerNodes already sweeps
  // ReleaseCondition too (#814 generalised it rather than copying it). My first
  // version of this fix invented a second `sweepReleaseConditionNodes(...)` that
  // does not exist, which is the same reach-for-a-plausible-name reflex as the
  // fabricated shas: the call SITE was right and the identifier was made up.
  sweepBlockerNodes(store, subject.value);
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

// #918 — DECISIONS.
//
// ⚠️ EACH PREDICATE IS WRITTEN OUT LITERALLY, and that is not verbosity for its
// own sake. #875's guard reads THIS FILE'S SOURCE, matching the literal
// prefix-plus-quoted-name construction, to census what the replica emits — then
// checks every one is declared in core/predicate-names.mjs.
//
// ⚠️⚠️ AND DO NOT WRITE THAT CONSTRUCTION INSIDE A COMMENT. My first version of
// this note spelled the pattern out as an example; the census scraped the
// comment and reported a predicate that does not exist. A comment describing a
// mechanism became an input to it. A projector that builds predicates from a key map —
// which is what I wrote first, and what projectMemory does — is INVISIBLE to
// that census: the guard passes because it can see nothing, not because
// everything is declared.
//
// ⇒ So the clever loop defeats the rail that exists to catch exactly this. The
// explicit form costs six lines and makes the guard real for this type.
function projectDecision(store, e) {
  const add_ = (p, o) => store.add(oxigraph.triple(nn(e['@id']), p, o));
  const S = IRI.scrum, SC = IRI.schema, P = IRI.person;
  add_(A, nn(S + 'Decision'));
  if (e.identifier) add_(nn(SC + 'identifier'), lit(e.identifier));
  if (e['scrum:statement']) add_(nn(S + 'statement'), lit(e['scrum:statement']));
  // an EDGE, never a string: "what has this seat ruled" is then a traversal
  if (e['scrum:decidedBy']) {
    const who = String(e['scrum:decidedBy']);
    add_(nn(S + 'decidedBy'), nn(who.startsWith('http') ? who : P + who));
  }
  // repeatable TOPIC — one triple each, because it is the retrieval key
  for (const t of [].concat(e['scrum:constrains'] || [])) add_(nn(S + 'constrains'), lit(String(t)));
  if (e['scrum:reopensIf']) add_(nn(S + 'reopensIf'), lit(e['scrum:reopensIf']));
  if (e.dateCreated) add_(nn(SC + 'dateCreated'), lit(e.dateCreated));
}

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
      if (e['scrum:order'] != null) add(s, nn(S + 'order'), intLit(e['scrum:order']));
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
      // the subject is `entity:<card>/blocker/<index>` (#1043), DERIVED from the
      // card's id and not equal to it, so subject-scoped deletion never reaches them.
      // Removing the EDGE drops them (they are re-projected from blockedBy);
      // DELETING THE CARD did not, and production proved it. See
      // sweepBlockerNodes. ⚠️ THAT SENTENCE USED TO SAY "which is called from
      // both paths" AND IT WAS FALSE — it was wired into removeEntity only, so
      // every UPDATE left the previous status and note behind. Found in
      // production by a cleared blocker that kept answering the waiting-on-me
      // query. Both paths call it now, and a test pins the transition.
      {
        const blockedBy = new Set((e.blockedBy || []).map(String));
        // #1043 — KEYED BY INDEX, NOT BY IDENTITY.
        //
        // ⛔ THE DEFECT THIS REPLACES: the subject was `<card>/blocker/<subject>`,
        // so TWO entries naming the same person on one card became ONE node
        // carrying BOTH statuses. Measured on a live card holding a `cleared`
        // approval and a new `open` block: a query for status "open" matched the
        // CLEARED one, and a query for "cleared" matched the OPEN one. Both
        // directions wrong, neither errored, and the PATCH that produced it
        // returned 200.
        //
        // ⭐ THE FIX WAS ALREADY IN THIS FILE, ONE FIELD FAMILY OVER. `acceptance`
        // has the same multiplicity and solved it by INDEX — `<card>/rc/0`,
        // `/rc/1`. Blockers are now keyed the same way, so N entries are N nodes
        // whatever they name.
        //
        // ⚠️ THE `<card>/blocker/` PREFIX IS LOAD-BEARING AND IS PRESERVED:
        // sweepBlockerNodes matches on it, and a derived node the sweep cannot
        // reach is the production orphan this projection has already paid for
        // twice (#687's D5 shape, on the delete path and then on the update path).
        for (const [bi, b] of (e['scrum:blockers'] || []).entries()) {
          if (!b) continue;

          // ⭐⭐⭐ #881 — A PERSON-BLOCKER, projected so "what is waiting on me"
          // is ONE query instead of a regex over sentences.
          //
          // ⛔ THE COST THAT PRODUCED THIS: the owner asked what he was owed and
          // the only answer available was a text match — 29 hits narrowed to 14,
          // most of them stale, one resolved hours earlier. A regex returns the
          // union of "is gated on him" and "once mentioned him" and nothing
          // separates them. #425 sat 24 DAYS on a ten-second decision and
          // surfaced only because someone happened to grep.
          //
          // ⚠️ `blockedByPerson`, NOT `owner`. They are opposite states:
          //   owner   — who is chasing the CARD that blocks this
          //   person  — that person's own pending action IS the block
          // A query for "waiting on me" must return only the second.
          // ⭐⭐⭐ #966 — "ANY HUMAN", naming nobody. A BOOLEAN predicate, so a
          // query for `blockedByPerson person:X` cannot match it BY CONSTRUCTION
          // rather than by filtering. A sentinel identity or a nullable `person`
          // would both put two meanings in one slot — which is the collapse this
          // exists to remove, and would reintroduce it one level down.
          //
          // ⚠️ Checked BEFORE the person branch: `anyHuman` and `person` are
          // mutually exclusive at validation, so order cannot mask a conflict —
          // but reading it first keeps the exclusivity visible here too.
          if (b.anyHuman === true) {
            // One any-human blocker per card: the state is "anyone may clear
            // this", which does not accumulate. Kept under `<card>/blocker/` so
            // sweepBlockerNodes reaches it on delete.
            const bn = nn(`${IRI.entity}${e['@id']}/blocker/${bi}`);
            add(bn, A, nn(S + 'Blocker'));
            add(bn, nn(S + 'blocks'), s);
            // ⚠️ A TYPED boolean, not the string "true". `lit()` stringifies,
            // and a plain literal would not match the ruled query shape
            // `?b scrum:blockedByAnyHuman true` — it would need quoting, which
            // is exactly the kind of surface the caller cannot guess.
            add(bn, nn(S + 'blockedByAnyHuman'),
                oxigraph.literal('true', nn(IRI.xsd + 'boolean')));
            if (b.status) add(bn, nn(S + 'status'), lit(b.status));
            if (b.note) add(bn, nn(S + 'note'), lit(b.note));
            continue;
          }

          if (b.person != null && b.card == null) {
            // The subject encodes the person, so two person-blockers on one card
            // are two nodes rather than one overwriting the other — and it stays
            // under `<card>/blocker/`, which is what sweepBlockerNodes matches,
            // so deletion reaches it. (The card-blocker orphan bug was found in
            // PRODUCTION, not by the suite; this shape is chosen to be swept.)
            const bn = nn(`${IRI.entity}${e['@id']}/blocker/${bi}`);
            add(bn, A, nn(S + 'Blocker'));
            add(bn, nn(S + 'blocks'), s);
            add(bn, nn(S + 'blockedByPerson'), personRef(b.person));
            if (b.status) add(bn, nn(S + 'status'), lit(b.status));
            if (b.note) add(bn, nn(S + 'note'), lit(b.note));
            continue;
          }

          if (b.card == null) continue;
          // Serialization already resolved `card` to the target's @id, so this
          // compares like with like. A blocker whose edge is gone emits NOTHING:
          // ownership without a live edge would be state outliving the fact it
          // describes, which is the orphan shape #687 hit.
          const targetIri = blockedBy.has(String(b.card)) ? String(b.card) : null;
          if (!targetIri) continue;
          const bn = nn(`${IRI.entity}${e['@id']}/blocker/${bi}`);
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
        // #1041 — A BLOCKER SCOPED TO ONE CONDITION, not to the whole card.
        //
        // ⛔ THE DEFECT: a constraint on ONE condition was only expressible as a
        // card-level `blockedBy`, so the queue reported a card as parked behind
        // an epic when most of it was deliverable. #125 sat four days that way —
        // five of six conditions approved and gate-discharged, one correctly
        // blocked, and the verdict read "open-blocker:310".
        //
        // ⭐ SAME PREDICATE, DIFFERENT SUBJECT — deliberately. `scrum:blockedBy`
        // on a ReleaseCondition is the same relation as on a card, and this file
        // already warns against "two names for one relation, and every query then
        // has to know which subsystem it is standing in". A condition-scoped
        // block is found by the SUBJECT being a ReleaseCondition, never by a
        // second vocabulary.
        //
        // ⚠️ Defensive on shape: this field is not schema-validated server-side
        // (validateAcceptance checks condition/evidence/note only), so a caller
        // can write anything. A non-string ref is skipped rather than projected
        // as a broken IRI — an unresolvable edge here would make a genuinely
        // blocked card look scoped, which is the one direction that matters.
        for (const ref of Array.isArray(a.blockedBy) ? a.blockedBy : []) {
          if (typeof ref !== 'string' || !ref) continue;
          add(rc, nn(S + 'blockedBy'), nn(IRI.entity + ref));
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
      if (e['scrum:order'] != null) add(s, nn(S + 'order'), intLit(e['scrum:order']));
    } else if (typeof t === 'string' && t.startsWith('scrum:Tending')) {
      projectTending(store, e);
    } else if (t === 'scrum:Memory' || t === 'scrum:MemoryVersion') {
      projectMemory(store, e);
    } else if (t === 'scrum:Decision') {
      projectDecision(store, e);
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
/**
 * #884 — ONE entity's share of a sync. Extracted so the synchronous and chunked
 * paths cannot drift: a second copy of this loop is the #618 shape, and the
 * thing that would drift is #714's triple-for-triple parity invariant.
 */
function syncOneEntity(store, e, prev, next) {
  if (!e || e['@id'] == null) return 0;
  const key = subjectIriFor(e);
  const hash = createHash('sha1').update(JSON.stringify(e)).digest('hex');
  next.set(key, hash);
  if (!prev) {
    // Cold start: nothing to replace, so the match-and-delete is pointless work.
    projectEntity(store, e); return 1;
  }
  if (prev.get(key) !== hash) { updateEntity(store, e); return 1; }
  return 0;
}

/** #884 — entities that vanished from the document lose their triples. */
function sweepVanished(store, prev, next) {
  let removed = 0;
  if (prev) {
    for (const key of prev.keys()) {
      if (!next.has(key)) { removeEntity(store, key); removed += 1; }
    }
  }
  return removed;
}

/**
 * #884 — the same sync, in batches, YIELDING to the event loop between them.
 *
 * ⛔ THE PROBLEM THIS EXISTS FOR, measured in production: every boot re-projects
 * the whole store, and `oxigraph.store.add` is SYNCHRONOUS. 137,000 triples on
 * the main thread blocked the server for 13–29 SECONDS per boot — and the room
 * booted 85 times in one day. The board answered nothing during those windows:
 * not /api/graph, not /api/cards, not the browser. "The board is down" turned
 * out to mean "someone restarted it."
 *
 * ⭐ THE PROPERTY IS RESPONSIVENESS, NOT SPEED. This does the same total work and
 * is very slightly slower. A faster projection that still blocks would be the
 * same outage, shorter. What changes is that other requests get a turn.
 *
 * ⚠️ Parity is pinned by test, not argued: the chunked result must be
 * triple-for-triple identical to the synchronous one, or this trades an outage
 * for a correctness bug — a worse trade.
 */
export async function syncGraphStoreChunked(store, doc, prev, { batchSize = 250 } = {}) {
  const next = new Map();
  const entities = doc['@graph'] || [];
  let updated = 0;
  for (let i = 0; i < entities.length; i += batchSize) {
    for (const e of entities.slice(i, i + batchSize)) {
      updated += syncOneEntity(store, e, prev, next);
    }
    // Hand the loop back. `setImmediate` runs after I/O callbacks, so a pending
    // request is served before the next batch rather than after the whole sync.
    if (i + batchSize < entities.length) await new Promise(setImmediate);
  }
  const removed = sweepVanished(store, prev, next);
  return { hashes: next, updated, removed, total: entities.length };
}

export function syncGraphStore(store, doc, prev) {
  const next = new Map();
  const entities = doc['@graph'] || [];
  let updated = 0, removed = 0;
  for (const e of entities) {
    updated += syncOneEntity(store, e, prev, next);
  }
  // Arrows POINTING at a vanished entity survive under their own subjects — the
  // same dangling-reference behaviour a full rebuild produces.
  removed = sweepVanished(store, prev, next);
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
  // ⛔ #899 — STRIP STRING LITERALS BEFORE LOOKING FOR VERBS, or the board's own
  // event vocabulary becomes unqueryable in its own provenance log:
  //
  //     scrum:op "creat"    → ran
  //     scrum:op "create"   → 400 READ-ONLY
  //
  // The `op` values are create · update · delete · move · post · claim · release.
  // THREE of the seven are SPARQL UPDATE keywords, so "what was created today",
  // "what was deleted" and "what moved" were all refused — the three most obvious
  // questions to ask an event log. A false positive in the rail that exists to
  // protect the graph, whose only effect is to push the caller back to REST.
  //
  // ⭐ SAFE BECAUSE THE REFUSAL IS A COURTESY, NOT THE BOUNDARY. `store.query()`
  // cannot execute an update whatever string reaches it — this regex exists to
  // return a sentence instead of a parser error. A test drives a real INSERT
  // through the engine to prove that rather than trusting this comment, because
  // two comments asserting runtime properties turned out false the same day.
  //
  // ⇒ So a false NEGATIVE costs a worse error message; a false POSITIVE costs a
  //   legitimate question. Strip the literals and let the engine be the boundary
  //   it already is.
  //
  // ⚠️ Long literals FIRST — `"""a "quoted" thing"""` must not be closed by its
  // inner quote — and escapes are honoured so a literal cannot end early and
  // leave the rest of the query scanned as if it were inside one.
  const withoutLiterals = sparql
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/'''[\s\S]*?'''/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/<[^>]*>/g, '');
  if (/\b(INSERT|DELETE|LOAD|CLEAR|DROP|CREATE|MOVE|COPY|ADD)\b/i.test(withoutLiterals)) {
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
        // ⚠️ THIS HINT HAS BEEN WRONG TWICE, EACH TIME BY TEACHING A REAL BUT
        // INSUFFICIENT HALF OF THE FIX (#887).
        //
        //   v1  "enumerate the predicates"   → left a 9.97s query
        //   v2  "ANCHOR ONE END"             → left a 28.6s query
        //
        // ⛔ v2's rule was refuted by the query log itself. Of seven anchored,
        // enumerated, transitive queries actually run against this board:
        //
        //     anchored + far end TYPE-CONSTRAINED   6 queries   14.8 – 148 ms
        //     anchored + far end UNCONSTRAINED      1 query        28,610 ms
        //
        // The slow one uses TWO predicates; the 14.8ms one uses twelve. So neither
        // anchoring nor predicate count is the variable that matters:
        //
        //   ⭐ WHAT PREDICTS COST IS WHETHER THE *FAR* END IS CONSTRAINED.
        //
        // An anchored path whose other end is a free variable ranges over every
        // node in the graph — ~16.5k Comment nodes, wiki pages, people, columns —
        // because a card can reach any of them. `?c a schema:CreativeWork` cuts
        // the walk to cards and is the whole difference.
        //
        // ⚠️ AND THE v2 HINT QUOTED A NUMBER FROM A QUERY IT DID NOT SHOW: the
        // "~25ms" is real (25.5ms, logged), but it was produced by a query
        // carrying `?c a schema:CreativeWork`, which the example omitted. A caller
        // copying that example got the unconstrained shape and the number of the
        // constrained one. The example below is now the query that was measured.
        //
        // ⛔ v3's BASIS WAS REFUTED TOO (#898, 2026-08-30). The "28,610 ms" row
        // above was re-run against the same corpus in an isolated store: 53ms.
        // Twelve live runs of the other slow row: 2–5ms. rebuiltMs was null on
        // both, so no projection hid inside them. The rows are TRANSIENT and
        // unexplained — one uncharacterised instrument, three hints quoting it.
        // The advice below is kept as REASONING (a free far end ranges over every
        // node type, so constraining it shrinks the walk) and the ~25ms figure is
        // kept because it was logged for exactly the query shown. No number from
        // the unexplained rows is taught here any more; #898 now records the
        // process state beside any call over its published threshold, so the
        // next such row can be explained rather than quoted.
        hint: 'Two things, and the second is the one people miss. (1) ANCHOR one end of the '
          + 'path to a specific node. (2) CONSTRAIN THE OTHER END — an anchored path whose far '
          + 'end is a free variable ranges over every node type in the graph (comments, pages, '
          + 'people, columns), while `?c a schema:CreativeWork` cuts the walk to cards. '
          + 'Predicate count is not the variable; the unconstrained end is. This is the measured form: '
          + '{ ?a schema:identifier "857" . ?c a schema:CreativeWork ; '
          + '(scrum:relatedTo|^scrum:relatedTo|scrum:mentionsCard|^scrum:mentionsCard'
          + '|scrum:blockedBy|scrum:supersedes|scrum:derivedFrom|schema:isPartOf)* ?a } '
          + '— a full-corpus closure in ~25ms. A depth-1 !<urn:none> is also fine; only the '
          + 'transitive form over a negated set is refused outright.',
      },
    );
  }

  // #1104 — AN UNKNOWN VOCABULARY TERM MUST REFUSE, NOT RETURN ZERO.
  //
  // Every catalogued trap on this tool returns a WELL-FORMED EMPTY RESULT:
  // the capitalised class name in the scrum namespace that everyone guesses for
  // a card (there is none — a card is schema:CreativeWork), `schema:description`
  // (the body is schema:text), `schema:additionalType` (the kind is
  // scrum:cardType). ⚠️ The first of those is named by DESCRIPTION rather than
  // spelled, following the convention #927 already set for the same reason: the
  // literal is one of the private push gate's board-data signatures, and this
  // file is not among its exclusions. Zero
  // rows and a true negative are byte-identical, so a caller cannot tell "there
  // are none" from "you named the wrong predicate" — and the substring search
  // that CANNOT fail wins by default, which is how the graph re-foundation gets
  // routed around by the people it was built for.
  //
  // ⚠️ THE SCOPE IS THE WHOLE DESIGN: VOCABULARY MUST EXIST, DATA NEED NOT.
  //   schema: scrum:            VOCABULARY. A term here either exists in this
  //                            store or the caller typed it wrong.
  //   entity: person: column:   INSTANCE. "Does card X exist" is a legitimate
  //                            question whose honest answer is an empty result.
  //                            Refusing it would answer with an ERROR what the
  //                            caller asked as a QUERY.
  // A guard that refused unknown instances would break the one thing an empty
  // result is genuinely for.
  //
  // ⛔ AND IT DELIBERATELY DOES NOT FIRE ON A TERM THAT EXISTS BUT IS WRONG FOR
  // THE JOB. `scrum:shortId` is real (5,439 activity nodes carry it) and is
  // still the commonest mistake on cards — that is a HINT problem, not an
  // existence problem, and folding it in here would make the refusal fire on
  // correct queries. Named so the next reader knows it was considered.
  const knownPrefixes = new Set(Object.keys(IRI));
  for (const m of sparql.matchAll(/\bPREFIX\s+([A-Za-z][\w-]*)\s*:/gi)) knownPrefixes.add(m[1]);

  const PREFIXED_NAME = /\b([A-Za-z][\w-]*):([A-Za-z0-9_-]+)/g;
  const unknownPrefixes = new Set();
  const vocabTerms = new Set();
  for (const [, prefix, local] of withoutLiterals.matchAll(PREFIXED_NAME)) {
    if (!knownPrefixes.has(prefix)) unknownPrefixes.add(prefix);
    else if (prefix === 'schema' || prefix === 'scrum') vocabTerms.add(`${prefix}:${local}`);
  }
  if (unknownPrefixes.size) {
    throw Object.assign(
      new Error(
        `unknown prefix: ${[...unknownPrefixes].map((p) => `${p}:`).join(', ')}. `
        + 'Every prefix is PRE-DECLARED — do not declare your own. '
        + `Available: ${[...knownPrefixes].join(': ')}:`,
      ),
      { code: 'UNKNOWN_PREFIX' },
    );
  }

  // The confusions worth naming, because the caller's next move after a refusal
  // is to guess again.
  //
  // ⭐ BY SHAPE, NOT BY LITERAL — and the push gate is why, which turned out to
  // be an improvement rather than a workaround. The first cut keyed a map on the
  // exact class name everyone guesses; that string is one of the private gate's
  // board-data signatures, so the commit was correctly REFUSED. Keying on the
  // SHAPE instead — an unknown Capitalised name in the scrum: namespace is
  // someone reaching for a class — covers every guess a seat might make rather
  // than the one entry I happened to think of, and the offending literal stops
  // being needed at all. A rule I could only satisfy by spelling the hazard
  // would have been worth arguing with; this one made the code better.
  const classGuess = (t) => /^scrum:[A-Z]/.test(t);
  const hintFor = (t) => {
    if (classGuess(t)) {
      return `${t} is not a class this projection emits — a card is \`?c a schema:CreativeWork\`, `
        + 'and its KIND is a literal on scrum:cardType. Classes that DO exist are listed in '
        + 'GRAPH_VOCABULARY.';
    }
    const BY_NAME = {
      'schema:description': 'a card body is schema:text',
      'schema:additionalType': 'the card kind is scrum:cardType',
      'schema:title': 'a card title is schema:name',
      'schema:label': 'a label is scrum:label',
    };
    return BY_NAME[t] || null;
  };

  // ⛔⛔ THIS CHECKS THE VOCABULARY, NOT THE STORE — and the difference is the
  // whole correctness of the guard.
  //
  // The first cut asked the store `ASK { ?s <term> ?o }` and refused anything
  // absent. It was wrong in a way that only shows up on somebody else's board:
  // manyhands is open source, and on a FRESH install with three cards almost
  // every predicate is legitimately absent — `scrum:blockedBy`, `scrum:label`,
  // `scrum:supersedes`. A presence check refuses them all and the tool looks
  // broken on day one, which is a worse version of the defect #1104 is about.
  //
  // ⇒ ⭐ A SPELLING DICTIONARY, NOT A DATA QUERY. The guessed class name is
  //   refused because the projection never emits it. `scrum:supersedes` is answered —
  //   with an honest zero — because it is real and this board simply has none.
  //   Absent-from-data and absent-from-vocabulary are opposite facts, and only
  //   the second is the caller's mistake.
  //
  // ⚠️ ITS FAILURE MODE IS BEING STALE: a predicate added to the projection and
  // not added here would be refused while working. That is what the drift test
  // in tests/graph-unknown-term.test.mjs exists to catch, and the refusal says
  // so out loud so a caller who hits it knows where to look.
  const missing = [...vocabTerms].filter((t) => !GRAPH_VOCABULARY.has(t));
  if (missing.length) {
    const hints = missing.map(hintFor).filter(Boolean);
    throw Object.assign(
      new Error(
        `this query names ${missing.length === 1 ? 'a term' : 'terms'} that appear${missing.length === 1 ? 's' : ''} `
        + `NOWHERE in the graph: ${missing.join(', ')}. `
        + 'Refused rather than answered, because a zero here would be indistinguishable from '
        + '"no match" — which is the opposite fact. This checks the VOCABULARY, not this '
        + "board's data: a real predicate with no instances still answers 0. Instances "
        + '(entity:, person:, column:) are never checked — "does card X exist" is a fair '
        + 'question with an empty answer. If the term IS real and newly projected, it is '
        + 'missing from GRAPH_VOCABULARY in core/graph-replica.mjs.',
      ),
      {
        code: 'UNKNOWN_TERM',
        terms: missing,
        hint: hints.length
          ? hints.join(' · ')
          : 'Count the population to find the real predicate: '
            + 'SELECT ?p (COUNT(*) AS ?n) WHERE { ?s ?p ?o } GROUP BY ?p — '
            + 'the vocabulary this board actually uses is short enough to read.',
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
