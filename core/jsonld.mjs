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
export const PERSON_IRI_BASE = 'https://scrumboard.local/person/';

/**
 * #687 — the IRI space column references resolve into. `card.column: "backlog"`
 * is, per the @context, the @id of a scrum:Column node in this same graph —
 * the same strings-become-edges-by-declaration move as #686's people.
 */
export const COLUMN_IRI_BASE = 'https://scrumboard.local/column/';

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
  // #687 — a card's column string is a reference to a scrum:Column node.
  column: { '@id': 'scrum:column', '@type': '@id', '@context': { '@base': COLUMN_IRI_BASE } },
  // #687 — labels are concepts, not identities: the predicate is named so the
  // graph-complete claim holds, but values stay literals — no node minted per
  // label string.
  labels: 'scrum:label',
  // #685 — relationships are @id EDGES. Values are the target nodes' own @ids
  // (no @base: card @ids are in-document identifiers), converted from the
  // domain's shortIds at serialization and back at load.
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
const REL_TYPES = ['relatedTo', 'blockedBy', 'supersedes', 'derivedFrom', 'supersededBy'];
const FACET_TO_PROP = {
  column: 'column', assignees: 'assignees', labels: 'labels', claimedBy: 'claimedBy',
  priority: 'scrum:priority', order: 'scrum:order', for: 'scrum:for',
  claimedAt: 'scrum:claimedAt', _extra: 'scrum:extra',
};
const PROP_TO_FACET = Object.fromEntries(Object.entries(FACET_TO_PROP).map(([f, p]) => [p, f]));

/** Card node (nested facet) → flat document entity. Lossless; pure. */
function cardNodeToFlat(node, shortToId) {
  const { board, ...flat } = node;
  if (!board) return node;
  for (const [k, v] of Object.entries(board)) {
    if (k === 'relationships') {
      // Presence-preserving: only the relationship types the facet actually
      // held are emitted, so `{relatedTo: []}` and "no relationships at all"
      // stay distinct through the round trip. A shortId naming no card rides
      // VERBATIM — losslessness beats tidiness on dangling data.
      for (const [rt, arr] of Object.entries(v || {})) {
        flat[rt] = (arr || []).map((sid) => shortToId.get(sid) ?? sid);
      }
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
    if (REL_TYPES.includes(k)) {
      // Key-order preservation is load-bearing (the replay invariant compares
      // BYTES): `relationships` re-enters the facet at the position of the
      // first relationship key encountered — same slot it flattened out of —
      // and later types land inside the same object, keeping their order.
      if (!board.relationships) board.relationships = rels;
      rels[k] = (v || []).map((ref) => idToShort.get(ref) ?? ref);
    }
    else if (k in PROP_TO_FACET) board[PROP_TO_FACET[k]] = v;
    else if (k.startsWith('scrum:') && k !== 'scrum:meta') board[k.slice(6)] = v;  // unknown facet key, prefix stripped
    else node[k] = v;
  }
  node.board = board;                                  // every card carries the facet, even empty
  return node;
}

// Messages are schema.org Comment; people are Person; columns are scrum:Column;
// everything else is a node (a card).
const isMessage = (entity) => entity && entity['@type'] === 'Comment';
const isPerson = (entity) => entity && entity['@type'] === 'Person';
const isColumn = (entity) => entity && entity['@type'] === 'scrum:Column';

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
  const { nodes = [], messages = [], people = [], columns = [], _README, ...meta } = domain;
  const doc = {};
  if (_README !== undefined) doc._README = _README;   // first key — JSON.stringify keeps insertion order
  doc['@context'] = CONTEXT;
  // #685 — the shortId→@id map for relationship edges lives here and only
  // here: serialization holds the whole graph, so no second copy can drift.
  const shortToId = new Map(nodes.map((n) => [n.identifier, n['@id']]));
  // #685/#686/#687 — cards flatten their facet; people and columns are graph
  // citizens beside cards and messages.
  doc['@graph'] = [
    ...nodes.map((n) => cardNodeToFlat(n, shortToId)),
    ...messages, ...people, ...columns.map(columnToNode),
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
  const cardEntities = graph.filter((e) => !isMessage(e) && !isPerson(e) && !isColumn(e));
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
  if (doc._README !== undefined) domain._README = doc._README;
  return domain;
}

/** True if a parsed file is a JSON-LD document (vs the legacy `{cards,…}` blob). */
export function isJsonLdDocument(parsed) {
  return !!parsed && typeof parsed === 'object' && Array.isArray(parsed['@graph']);
}
