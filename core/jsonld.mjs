/**
 * core/jsonld.mjs — JSON-LD serialization for the node domain (ADR-002 D2/D3, #227).
 *
 * The domain is ALREADY schema.org-shaped: `nodes` are CreativeWork objects and
 * `messages` are Comment objects (see core/mapping.mjs). So persisting it as a
 * schema.org document isn't a transform — it's just placement: nodes + messages
 * become the `@graph`, board mechanics (columns, nextShortId, lastUpdated, and
 * any other passthrough) ride a namespaced `scrum:meta`, and the `_README`
 * banner leads the file as it always has.
 *
 * This is the storage primitive the design calls for: schema.org on disk. It is
 * lossless and the exact inverse pair (domainToJsonLd ∘ jsonLdToDomain = id),
 * which composes with the proven board↔domain mapping to give a zero-loss
 * legacy→JSON-LD migration. Pure functions, no I/O (the functional core, D1).
 *
 * We use JSON-LD as a pragmatic, compact VOCABULARY (D3) — not a full RDF /
 * linked-data stack. The @context declares schema.org as the default vocab and
 * a `scrum:` prefix for our extension terms (the board facet, the meta block,
 * and additionalType values like `scrum:task`). Nothing here expands to triples.
 */

/**
 * #686 — the IRI space person-reference strings resolve into. A stored value
 * like `creator: "ada"` is, per the @context below, the IRI
 * `https://scrumboard.local/person/ada` — the @id of a Person node in this
 * same graph. The strings on 12K existing records became edges by DECLARATION,
 * not by rewriting.
 */
import { deriveCardReferences, MENTIONS_CARD } from './references.mjs';

export { MENTIONS_CARD };

export const PERSON_IRI_BASE = 'https://scrumboard.local/person/';

/**
 * #687 — the IRI space column references resolve into. `card.column: "backlog"`
 * is, per the @context, the @id of a scrum:Column node in this same graph —
 * the same strings-become-edges-by-declaration move as #686's people.
 */
export const COLUMN_IRI_BASE = 'https://scrumboard.local/column/';
// #814 — commits get their own namespace. They are not board entities and must
// never be mistaken for one; the sha is the identity and git holds the rest.
export const COMMIT_IRI_BASE = 'https://scrumboard.local/commit/';

// A person-reference term: string values are @id-typed and resolve against the
// person IRI space (JSON-LD 1.1 property-scoped context).
const personRef = (iri) => ({
  '@id': iri, '@type': '@id', '@context': { '@base': PERSON_IRI_BASE },
});

const CONTEXT = {
  '@vocab': 'https://schema.org/',
  scrum: 'https://scrumboard.local/ns#',
  board: 'scrum:board',           // the kanban facet on a node
  // #686 — the closed set of person-reference predicates, each an edge into
  // the Person nodes. `mentions` is DELIBERATELY absent: it is regex-scraped
  // prose holding real external people's handles, and an @id-typed mentions
  // would mint IRIs for strangers who never touched this board (#619's
  // consent guard, restated at the vocabulary level).
  creator: personRef('https://schema.org/creator'),
  author: personRef('https://schema.org/author'),
  assignees: personRef('scrum:assignees'),
  claimedBy: personRef('scrum:claimedBy'),
  parkedBy: personRef('scrum:parkedBy'),   // an authored disposition JOINS to its author
  // #814 — commits are ENTITIES, not strings. A card links to them; the sha is
  // their identity and the board asserts nothing else about them.
  implementedBy: { '@id': 'scrum:implementedBy', '@type': '@id', '@context': { '@base': COMMIT_IRI_BASE } },
  // #687 — a card's column string is a reference to a scrum:Column node.
  column: { '@id': 'scrum:column', '@type': '@id', '@context': { '@base': COLUMN_IRI_BASE } },
  // #687 — labels are concepts, not identities: the predicate is named so the
  // graph-complete claim holds, but values stay literals — no node minted per
  // label string.
  labels: 'scrum:label',
  // #685 — relationships are @id EDGES. Values are the target nodes' own @ids
  // (no @base: card @ids are in-document identifiers), converted from the
  // domain's shortIds at serialization and back at load.
  // #804 — playlist order is CONTENT, not metadata. A bare multi-value is a
  // SET in JSON-LD, so the sequence would hold only by accident of JSON
  // serialisation and any framing/compaction step could reorder it.
  // @container: @list makes the order a DECLARATION.
  'scrum:orderedPrompts': { '@id': 'scrum:orderedPrompts', '@type': '@id', '@container': '@list' },
  // Provenance predicates that name a seat are typed @id against the Person
  // base, so they JOIN to `author`. A provenance field that cannot reach a
  // Person node is decoration.
  'scrum:actor': { '@id': 'scrum:actor', '@type': '@id', '@context': { '@base': PERSON_IRI_BASE } },
  'scrum:declaredSeat': { '@id': 'scrum:declaredSeat', '@type': '@id', '@context': { '@base': PERSON_IRI_BASE } },
  'scrum:influencedBy': { '@id': 'scrum:influencedBy', '@type': '@id', '@context': { '@base': PERSON_IRI_BASE } },
  'scrum:seatNamesWithOpenStreamsAtSend': { '@id': 'scrum:seatNamesWithOpenStreamsAtSend', '@type': '@id', '@context': { '@base': PERSON_IRI_BASE } },
  'scrum:evidencedBy': { '@id': 'scrum:evidencedBy', '@type': '@id' },
  // ⛔ heldByAttempt references the WINNING CLAIM ATTEMPT, never a Person.
  // Pointing it at a Person would collapse the very distinction the 2026-08-14
  // incident turned on: the record would say who held it and lose whether that
  // was a bound actor, a declared proxy, or an unbound declaration. Derive any
  // display holder from the attempt's actor / declaredSeat / declaredSeatRaw.
  'scrum:heldByAttempt': { '@id': 'scrum:heldByAttempt', '@type': '@id' },
  // #656 — DERIVED, weak, and namespaced away from `mentions` on purpose (see
  // core/references.mjs). "This card's text mentions that card" — nothing more.
  [MENTIONS_CARD]: { '@id': MENTIONS_CARD, '@type': '@id' },
  relatedTo: { '@id': 'scrum:relatedTo', '@type': '@id' },
  blockedBy: { '@id': 'scrum:blockedBy', '@type': '@id' },
  supersedes: { '@id': 'scrum:supersedes', '@type': '@id' },
  derivedFrom: { '@id': 'scrum:derivedFrom', '@type': '@id' },
  supersededBy: { '@id': 'scrum:supersededBy', '@type': '@id' },
};

// ── #685 — the board facet dissolves at the DOCUMENT boundary ───────────────
//
// The domain keeps its nested `board` facet (handlers, #614 inverse-sync, the
// API contract and the event log all speak that shape); the DOCUMENT carries
// the same facts as first-class properties and @id edges. Serialization is the
// one place that holds the whole graph, so it is the one place a shortId↔@id
// conversion can live without a second copy that drifts.
export const REL_TYPES = ['relatedTo', 'blockedBy', 'supersedes', 'derivedFrom', 'supersededBy'];
const FACET_TO_PROP = {
  column: 'column', assignees: 'assignees', labels: 'labels', claimedBy: 'claimedBy',
  priority: 'scrum:priority', order: 'scrum:order', for: 'scrum:for',
  claimedAt: 'scrum:claimedAt', _extra: 'scrum:extra',
  implementedBy: 'implementedBy',
  parkedBy: 'parkedBy', parkedAt: 'scrum:parkedAt',
  parkedUntil: 'scrum:parkedUntil', parkedReason: 'scrum:parkedReason',
};
const PROP_TO_FACET = Object.fromEntries(Object.entries(FACET_TO_PROP).map(([f, p]) => [p, f]));

/** Card node (nested facet) → flat document entity. Lossless; pure. */
function cardNodeToFlat(node, shortToId) {
  const { board, ...flat } = node;
  // #656 — the derived reference edge. Computed here, from the card text that
  // is its only authority, and DROPPED in flatToCardNode below. It is the one
  // property on this entity that is not a fact the domain holds.
  const mentioned = deriveCardReferences(node, shortToId);
  if (mentioned) flat[MENTIONS_CARD] = mentioned;
  if (!board) return flat;
  for (const [k, v] of Object.entries(board)) {
    if (k === 'relationships') {
      // Presence-preserving: only the relationship types the facet actually
      // held are emitted, so `{relatedTo: []}` and "no relationships at all"
      // stay distinct through the round trip. A shortId naming no card rides
      // VERBATIM — losslessness beats tidiness on dangling data.
      for (const [rt, arr] of Object.entries(v || {})) {
        flat[rt] = (arr || []).map((sid) => shortToId.get(sid) ?? sid);
      }
    } else if (k === 'acceptance') {
      // #1041 — a condition-scoped blocker names its target by shortId, exactly
      // as `blockedBy` and `blockers` do. It is resolved to an @id HERE for the
      // same reason they are: the projection must be able to match it against
      // the card-level edge, and #814's note applies verbatim — "the mapping
      // lives HERE and only here, because serialization holds the whole graph;
      // a second copy in the replica is the #618 drift shape."
      //
      // ⚠️ A reference naming no card rides VERBATIM, same as a dangling
      // relationship member. Losslessness beats tidiness on dangling data.
      flat['scrum:acceptance'] = (v || []).map((a) => (
        a && Array.isArray(a.blockedBy)
          ? { ...a, blockedBy: a.blockedBy.map((sid) => shortToId.get(sid) ?? sid) }
          : a));
    } else if (k === 'blockers') {
      // #814 — a blocker names its card by shortId; the projection must compare
      // it against `blockedBy`, which is resolved to @ids two lines above. The
      // mapping lives HERE and only here, because serialization holds the whole
      // graph — a second copy in the replica is the #618 drift shape.
      flat['scrum:blockers'] = (v || []).map((b) => (
        b && b.card != null ? { ...b, card: shortToId.get(b.card) ?? b.card } : b));
    } else {
      flat[FACET_TO_PROP[k] ?? ('scrum:' + k)] = v;   // unknown facet keys ride prefixed
    }
  }
  return flat;
}

/** Flat document entity → card node (nested facet). Exact inverse. */
function flatToCardNode(entity, idToShort) {
  if (entity.board) return entity;                     // legacy document — already nested
  const node = {}; const board = {}; const rels = {};
  for (const [k, v] of Object.entries(entity)) {
    // ⛔ #656 — the derived reference edge is DROPPED, explicitly and first.
    // Without this line the `scrum:*` fallthrough below would route it into the
    // board facet and it would be WRITTEN BACK on the next save: a second copy
    // of a derived fact, which is the exact defect this predicate exists to
    // avoid. It would then outlive the text that produced it.
    if (k === MENTIONS_CARD) continue;
    if (REL_TYPES.includes(k)) {
      // Key-order preservation is load-bearing (the replay invariant compares
      // BYTES): `relationships` re-enters the facet at the position of the
      // first relationship key encountered — same slot it flattened out of —
      // and later types land inside the same object, keeping their order.
      if (!board.relationships) board.relationships = rels;
      rels[k] = (v || []).map((ref) => idToShort.get(ref) ?? ref);
    }
    else if (k === 'scrum:acceptance') {
      // #1041 — the inverse of the resolution in cardNodeToFlat. The domain
      // speaks shortIds, so a condition-scoped blocker turns back here.
      board.acceptance = (v || []).map((a) => (
        a && Array.isArray(a.blockedBy)
          ? { ...a, blockedBy: a.blockedBy.map((ref) => idToShort.get(ref) ?? ref) }
          : a));
    }
    else if (k === 'scrum:blockers') {
      // #814 — the inverse of the resolution in cardNodeToFlat. Serialization
      // turned each blocker's shortId into the target's @id so the projection
      // could match it against blockedBy; the domain speaks shortIds, so it
      // turns back here. A reference naming no card rides VERBATIM, same as a
      // dangling relationship member — losslessness beats tidiness.
      board.blockers = (v || []).map((b) => (
        b && b.card != null ? { ...b, card: idToShort.get(b.card) ?? b.card } : b));
    }
    else if (k in PROP_TO_FACET) board[PROP_TO_FACET[k]] = v;
    else if (k.startsWith('scrum:') && k !== 'scrum:meta') board[k.slice(6)] = v;  // unknown facet key, prefix stripped
    else node[k] = v;
  }
  node.board = board;                                  // every card carries the facet, even empty
  return node;
}

// Messages are schema.org Comment; people are Person; columns are scrum:Column.
//
// ⛔⛔ #804 SLICE ZERO — THE FALLTHROUGH USED TO BE "everything else is a card".
// That was fine while three classes were all that existed, and it became a
// silent-corruption bug the moment anything else needed to live in the graph:
// an unrecognised @type was not refused, it was RECLASSIFIED AS A CARD on the
// next load and surfaced in card_list. No error, no log, a plausible-looking
// card. This file already warned about it for Person and Column (#686/#687) —
// the warning was right and the guard was a whitelist of three.
//
// The partition is now CLOSED: anything the projection does not recognise is
// preserved verbatim in its own bucket and never becomes a card. "Graph first"
// means a new class is a first-class citizen of @graph, not a sidecar file and
// not a card facet.
const isMessage = (entity) => entity && entity['@type'] === 'Comment';
const isPerson = (entity) => entity && entity['@type'] === 'Person';
const isColumn = (entity) => entity && entity['@type'] === 'scrum:Column';

/**
 * The board-owned tending system's graph classes (#804).
 *
 * Declared here rather than in the tending modules on purpose: the projection
 * is the thing that must know them, and a type list that lives away from the
 * partition it governs is the drift this slice exists to prevent.
 */
export const TENDING_TYPES = Object.freeze([
  'scrum:TendingPrompt',         // the durable identity of a prompt
  'scrum:TendingPromptVersion',  // immutable; author + timestamp ride HERE
  'scrum:TendingPlaylist',       // ordered REFERENCES to prompts, not copies
  'scrum:TendingPlaylistVersion',
  'scrum:TendingState',          // enabled/paused, with actor provenance
  'scrum:TendingSilence',        // the causal key a mint answers
  'scrum:TendingMint',           // one offer, attached to its silence
  'scrum:TendingClaimAttempt',   // EVERY attempt — grants and refusals alike
  // Pause/resume as EVENTS, not only as current state. A mutable
  // `paused:false` erases the interval it was true, and archaeology then
  // cannot tell a deliberate suspension from an outage — which is the exact
  // question this whole feature exists to make answerable.
  'scrum:TendingControlEvent',
]);
const TENDING_TYPE_SET = new Set(TENDING_TYPES);
const isTending = (entity) => entity && TENDING_TYPE_SET.has(entity['@type']);

/**
 * #651 — MEMORY's graph classes.
 *
 * Declared here for the same reason the tending list is: the projection is what
 * must know them, and a type list living away from the partition it governs is
 * the drift that arrangement exists to prevent.
 *
 * ⚠️ The split is deliberate and it IS the feature. `scrum:Memory` is the durable
 * IDENTITY — retitle it, retag it, retire it. `scrum:MemoryVersion` is IMMUTABLE:
 * text, author and timestamp ride there and are never rewritten. Without that
 * split a prune overwrites the thing it prunes, which is the event this card
 * exists to make survivable: one curation pass took an index from 64 KB to
 * 6.5 KB with no record of what was cut.
 */
export const MEMORY_TYPES = Object.freeze([
  'scrum:Memory',         // durable identity: owner, title, tags
  'scrum:MemoryVersion',  // immutable text + author + timestamp
]);
const MEMORY_TYPE_SET = new Set(MEMORY_TYPES);
const isMemory = (entity) => entity && MEMORY_TYPE_SET.has(entity['@type']);
// #918 — decisions are their own class, beside memories rather than inside
// them: a decision has no versions and no owner, and folding it into the memory
// collection would make "what has this room decided" a filter over the wrong set.
const isDecision = (entity) => entity && entity['@type'] === 'scrum:Decision';
// #945 — predicate definitions are their own class for the same reason:
// "what does asserting X mean" must be a filter over the vocabulary, not over
// memories or decisions it happens to resemble.
const isPredicateDefinition = (entity) => entity && entity['@type'] === 'scrum:PredicateDefinition';

/**
 * ⛔ ENFORCE the ordering contract rather than merely preserving it.
 *
 * This module uses JSON-LD as a pragmatic vocabulary — nothing here expands to
 * triples — so declaring `@container: @list` in the context does NOT make a
 * bare array illegal by itself. Preservation and enforcement are different
 * properties, and only the second is a contract: without this check a playlist
 * could be written with a plain array, round-trip perfectly, and carry an
 * ordering guarantee that exists nowhere except in the writer's intention.
 *
 * A playlist version's sequence IS its content. So a malformed one is refused
 * LOUDLY at load rather than silently accepted — which is the one disposition
 * a fallthrough must never have.
 */
export function assertTendingShape(entity) {
  if (entity?.['@type'] !== 'scrum:TendingPlaylistVersion') return entity;
  const v = entity['scrum:orderedPrompts'];
  if (v === undefined) return entity;                    // absent is allowed; malformed is not
  if (Array.isArray(v)) {
    throw new Error(
      `TendingPlaylistVersion ${entity['@id']}: scrum:orderedPrompts is a bare array. `
      + 'A bare array is an unordered SET in JSON-LD — wrap it as {"@list":[…]} so the order is declared.',
    );
  }
  if (!v || !Array.isArray(v['@list'])) {
    throw new Error(
      `TendingPlaylistVersion ${entity['@id']}: scrum:orderedPrompts must be {"@list":[…]}.`,
    );
  }
  return entity;
}

// A card is recognised POSITIVELY: it projects as schema.org CreativeWork.
// Verified against the live board — 733 card entities, every one CreativeWork
// with an identifier, zero exceptions.
//
// The untyped-with-identifier clause is legacy tolerance, not a second rule:
// a hand-written or pre-#685 document may carry cards with no @type, and those
// must keep loading as cards rather than becoming "unmodelled". Anything with
// NEITHER a CreativeWork type NOR a shortId was never a card.
const isCard = (entity) => !!entity && (
  entity['@type'] === 'CreativeWork'
  || (entity['@type'] === undefined && entity.identifier !== undefined)
);

// #687 — plain {id, name, order, …} ↔ typed graph node. Lossless both ways:
// unmodelled fields ride through verbatim (the slice-1 keystone).
const columnToNode = ({ id, name, order, ...rest }) => ({
  '@type': 'scrum:Column', '@id': COLUMN_IRI_BASE + id,
  identifier: id, name, 'scrum:order': order, ...rest,
});
const nodeToColumn = ({ '@type': _t, '@id': _i, identifier, name, 'scrum:order': order, ...rest }) => ({
  id: identifier, name, order, ...rest,
});

/**
 * Domain → JSON-LD document. `_README` leads (convention); `@graph` holds the
 * nodes (CreativeWork) followed by the messages (Comment); all remaining domain
 * keys (columns, nextShortId, lastUpdated, any future passthrough) ride in
 * `scrum:meta`. The exact inverse of jsonLdToDomain.
 */
export function domainToJsonLd(domain) {
  const {
    nodes = [], messages = [], people = [], columns = [],
    tending = [], memories = [], decisions = [], predicates = [], labelAliases = [], _unmodelled = [], _README, ...meta
  } = domain;
  const doc = {};
  if (_README !== undefined) doc._README = _README;   // first key — JSON.stringify keeps insertion order
  doc['@context'] = CONTEXT;
  // #857 §IV — declared label synonyms. A flat map because it IS one: the
  // authority for "which spellings are one concept", read by the projection and
  // by nothing else. Kept OUT of @graph because it is a decision ABOUT the
  // graph's vocabulary rather than an entity in it.
  if (Array.isArray(labelAliases) && labelAliases.length) doc._labelAliases = labelAliases;
  // #685 — the shortId→@id map for relationship edges lives here and only
  // here: serialization holds the whole graph, so no second copy can drift.
  const shortToId = new Map(nodes.map((n) => [n.identifier, n['@id']]));
  // #685/#686/#687 — cards flatten their facet; people and columns are graph
  // citizens beside cards and messages.
  doc['@graph'] = [
    ...nodes.map((n) => cardNodeToFlat(n, shortToId)),
    ...messages, ...people, ...columns.map(columnToNode),
    ...tending,
    ...memories,
    ...decisions,
    ...predicates,
    // #804 — entities of a class this projection does not model ride through
    // verbatim rather than being dropped. Silent deletion is the other bad
    // answer to the fallthrough bug: a phantom card is at least visible.
    ..._unmodelled,
  ];
  doc['scrum:meta'] = meta;                            // nextShortId, lastUpdated, …
  return doc;
}

/**
 * JSON-LD document → domain. Splits `@graph` back into nodes vs messages by
 * @type, spreads `scrum:meta` back to top-level domain keys, restores `_README`.
 * Tolerant of a missing graph/meta (treated as empty) so a hand-written or
 * partial document still loads. The exact inverse of domainToJsonLd.
 */
export function jsonLdToDomain(doc) {
  const graph = Array.isArray(doc['@graph']) ? doc['@graph'] : [];
  const meta = (doc['scrum:meta'] && typeof doc['scrum:meta'] === 'object') ? doc['scrum:meta'] : {};
  const cardEntities = graph.filter(isCard);
  // #685 — the inverse map (@id → shortId) rebuilt from the same single graph.
  const idToShort = new Map(cardEntities.map((e) => [e['@id'], e.identifier]));
  const domain = {
    // #686/#687 — four entity classes. A Person or Column must never fall into
    // `nodes`: nodes round-trip through nodeToCard and would surface them as
    // phantom cards in card_list. #685 — flat card entities re-nest their facet.
    nodes: cardEntities.map((e) => flatToCardNode(e, idToShort)),
    messages: graph.filter(isMessage),
    ...meta,
  };
  // #687 — graph columns are the canonical location; a legacy document
  // (columns still in scrum:meta) keeps working via the meta spread above and
  // flips on its next save. When meta carried none, the graph's set — even an
  // EMPTY one — is the answer: a fresh board's `columns: []` must round-trip,
  // not vanish (found by the fresh-board pin, first run).
  const cols = graph.filter(isColumn);
  if (cols.length || !('columns' in domain)) domain.columns = cols.map(nodeToColumn);
  const people = graph.filter(isPerson);
  if (people.length) domain.people = people;          // absence preserved, not coerced to []
  // #804 — tending entities are their own class. Absence preserved, like people:
  // an untouched board must not sprout an empty key and churn its file on save.
  const tending = graph.filter(isTending);
  if (tending.length) domain.tending = tending.map(assertTendingShape);
  // #651 — memories are their own class. Absence preserved, like people and
  // tending: an untouched board must not sprout an empty key and churn its file.
  const memories = graph.filter(isMemory);
  if (memories.length) domain.memories = memories;
  // #918 — same absence-preserving rule.
  const decisions = graph.filter(isDecision);
  if (decisions.length) domain.decisions = decisions;
  // #945 — same rule again.
  const predicates = graph.filter(isPredicateDefinition);
  if (predicates.length) domain.predicates = predicates;
  // Anything recognised by NO predicate is kept verbatim so the serializer
  // stays lossless. It is never a card and never silently discarded.
  const unmodelled = graph.filter(
    (e) => !isCard(e) && !isMessage(e) && !isPerson(e) && !isColumn(e) && !isTending(e)
      && !isMemory(e) && !isDecision(e) && !isPredicateDefinition(e),
  );
  if (unmodelled.length) domain._unmodelled = unmodelled;
  if (Array.isArray(doc._labelAliases) && doc._labelAliases.length) domain.labelAliases = doc._labelAliases;
  if (doc._README !== undefined) domain._README = doc._README;
  return domain;
}

/** True if a parsed file is a JSON-LD document (vs the legacy `{cards,…}` blob). */
export function isJsonLdDocument(parsed) {
  return !!parsed && typeof parsed === 'object' && Array.isArray(parsed['@graph']);
}
