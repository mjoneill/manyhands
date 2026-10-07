/**
 * #1598 — CARDS IN THE GRAPH: the server side of a `card.write`.
 *
 * A card's graph form is produced by the SAME projection the replica uses (`cardToNode` → `cardNodeToFlat` →
 * `projectEntity`), so a `graph_query` written for the replica reads the executor's rows unchanged (K3). The server
 * owns the projection because it needs board context (the shortId → id map that resolves relationships and #NNN
 * mentions); the compiler owns the GUARD and validates that every quad belongs to the card it is written for.
 *
 * The output terms are the compiler's term shape ({type:'uri'|'literal', value, datatype?, lang?}), never SPARQL text.
 */
import oxigraph from 'oxigraph';
import { cardToNode } from './mapping.mjs';
import { cardNodeToFlat } from './jsonld.mjs';
import { projectEntity, IRI } from './graph-replica.mjs';

export const CARD_PREFIX = IRI.entity;
export const cardIriOf = (id) => `${IRI.entity}${id}`;
/** The counter node a create bumps (K6): its `urn:ex:ver` is the NEXT shortId to allocate. */
export const SHORTID_COUNTER_IRI = 'https://scrumboard.local/counter/nextShortId';

const XSD_STRING = `${IRI.xsd}string`;
const termOf = (t) => {
  if (t.termType === 'NamedNode') return { type: 'uri', value: t.value };
  if (t.termType === 'Literal') {
    if (t.language) return { type: 'literal', value: t.value, lang: t.language };
    return t.datatype && t.datatype.value !== XSD_STRING ? { type: 'literal', value: t.value, datatype: t.datatype.value } : { type: 'literal', value: t.value };
  }
  throw new Error(`a card projection produced a ${t.termType} term; card.write carries named nodes and literals only`);
};

/**
 * One card → its projected quads, as compiler terms. `shortToId` is the board's shortId → card id map (relationships
 * and #NNN mentions resolve through it, exactly as a document save does).
 */
export function cardQuads(card, shortToId) {
  const flat = cardNodeToFlat(cardToNode(card), shortToId);
  const store = new oxigraph.Store();
  projectEntity(store, flat);
  return store.match(null, null, null).map((q) => [termOf(q.subject), termOf(q.predicate), termOf(q.object)]);
}

/** The board's shortId → id map, from a card list. */
export const shortIdMap = (cards) => new Map(cards.filter(Boolean).map((c) => [c.shortId, c.id]));

const SHARED_PREFIXES = [IRI.concept, IRI.commit, IRI.unresolved];
/** A card's PRIOR quads for a `card.write`: its own projection minus the shared nodes, which a card write never deletes. */
export const priorQuads = (card, shortToId) => cardQuads(card, shortToId).filter(([s]) => !SHARED_PREFIXES.some((x) => s.value.startsWith(x)));
