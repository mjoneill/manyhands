/**
 * #1744 (#1629 slice 4) — the derived CARD REFERENCE INDEX: which #N each live card names, kept in executor bookkeeping so a
 * create or delete can prove it re-projects EXACTLY the cards that name the shortId it adds or removes (contract v2 V2-2, F2).
 *
 * Per live card, ALWAYS (zero references too), one coverage node in the bookkeeping graph:
 *   <urn:ex:card-ref-index/card/<cardId>>  indexedVersion    xsd:integer  = the card's current graph version (urn:ex:ver)
 *                                          indexedJsonDigest              = sha256 of the card's stored entityJson
 *                                          namesShortId      xsd:integer  one per distinct #N the card names
 * and, once a verified backfill has finished, the marker <urn:ex:card-ref-index/coverage> complete true.
 * An ABSENT node is a violation, never "no references". The index is bookkeeping: no public, traversable triple.
 *
 * Pure: no I/O. The compiler and the backfill tool share these rules, so the two can't drift.
 */
import crypto from 'node:crypto';
import { parseCardRefs } from './references.mjs';

export const CARD_REF_INDEX_NS = 'urn:ex:card-ref-index/';
export const CRI = Object.freeze({
  card: (id) => `${CARD_REF_INDEX_NS}card/${id}`,
  indexedVersion: `${CARD_REF_INDEX_NS}indexedVersion`,
  indexedJsonDigest: `${CARD_REF_INDEX_NS}indexedJsonDigest`,
  namesShortId: `${CARD_REF_INDEX_NS}namesShortId`,
  marker: `${CARD_REF_INDEX_NS}coverage`,
  complete: `${CARD_REF_INDEX_NS}complete`,
});
const XSD_INT = 'http://www.w3.org/2001/XMLSchema#integer';
const XSD_BOOL = 'http://www.w3.org/2001/XMLSchema#boolean';

/**
 * The distinct #N a card names, sorted, by the board's own rules: `#NNN` in its title and description (references.mjs), every
 * relationship target, and every acceptance blocker. Unresolved names (no such card yet) are KEPT: a create of #N must find
 * the cards that already mention it.
 */
export function cardNames(card) {
  const n = new Set(parseCardRefs(`${card?.title ?? ''}\n${card?.description ?? ''}`).map(Number));
  for (const arr of Object.values(card?.relationships || {})) for (const v of Array.isArray(arr) ? arr : []) n.add(Number(v));
  for (const a of Array.isArray(card?.acceptance) ? card.acceptance : []) for (const v of a?.blockedBy || []) n.add(Number(v));
  return [...n].filter((x) => Number.isSafeInteger(x) && x > 0).sort((a, b) => a - b);
}

export const jsonDigest = (entityJson) => crypto.createHash('sha256').update(entityJson).digest('hex');

/** The coverage node's triples as SPARQL text (inside a GRAPH block), for one card at one version and stored JSON. */
export function coverageTriplesText(cardId, version, entityJson, card = JSON.parse(entityJson)) {
  const s = `<${CRI.card(cardId)}>`;
  const lines = [
    `${s} <${CRI.indexedVersion}> "${version}"^^<${XSD_INT}> .`,
    `${s} <${CRI.indexedJsonDigest}> ${JSON.stringify(jsonDigest(entityJson))} .`,
    ...cardNames(card).map((n) => `${s} <${CRI.namesShortId}> "${n}"^^<${XSD_INT}> .`),
  ];
  return lines.join('\n');
}

export const markerTripleText = () => `<${CRI.marker}> <${CRI.complete}> "true"^^<${XSD_BOOL}> .`;
