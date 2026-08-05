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
};

// Messages are schema.org Comment; people are Person; everything else is a node.
const isMessage = (entity) => entity && entity['@type'] === 'Comment';
const isPerson = (entity) => entity && entity['@type'] === 'Person';

/**
 * Domain → JSON-LD document. `_README` leads (convention); `@graph` holds the
 * nodes (CreativeWork) followed by the messages (Comment); all remaining domain
 * keys (columns, nextShortId, lastUpdated, any future passthrough) ride in
 * `scrum:meta`. The exact inverse of jsonLdToDomain.
 */
export function domainToJsonLd(domain) {
  const { nodes = [], messages = [], people = [], _README, ...meta } = domain;
  const doc = {};
  if (_README !== undefined) doc._README = _README;   // first key — JSON.stringify keeps insertion order
  doc['@context'] = CONTEXT;
  doc['@graph'] = [...nodes, ...messages, ...people]; // #686 — people are graph citizens
  doc['scrum:meta'] = meta;                            // columns, nextShortId, lastUpdated, …
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
  const domain = {
    // #686 — three entity classes. A Person must never fall into `nodes`:
    // nodes round-trip through nodeToCard and would surface people as
    // phantom cards in card_list.
    nodes: graph.filter((e) => !isMessage(e) && !isPerson(e)),
    messages: graph.filter(isMessage),
    ...meta,
  };
  const people = graph.filter(isPerson);
  if (people.length) domain.people = people;          // absence preserved, not coerced to []
  if (doc._README !== undefined) domain._README = doc._README;
  return domain;
}

/** True if a parsed file is a JSON-LD document (vs the legacy `{cards,…}` blob). */
export function isJsonLdDocument(parsed) {
  return !!parsed && typeof parsed === 'object' && Array.isArray(parsed['@graph']);
}
