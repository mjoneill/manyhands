/**
 * #1640 — THE LABEL ALIASES, ONE DEFINITION. An alias says "this spelling of a label means that one": card creation stores
 * an aliased label on its canonical, and GET /api/labels/aliases serves the map.
 *
 * Two shapes, by where the map lives:
 *   · the DOCUMENT path (the small-kinds unit off): `data.labelAliases` is an array of ROWS `{id, alias, canonical, by, at}`,
 *     as it always was;
 *   · the GRAPH path (the unit on): `data.labelAliases` is the `labelAliases` collection family, one ENTITY per alias, written
 *     through the guarded entity.put like every other family. A lost or re-seeded document no longer forgets an alias.
 * This module stores the alias as a record only: no `schema:sameAs` between concepts. Whether that link is stored is the
 * open (a)/(b)/(c) choice on #1640 (concept nodes are shared and no writer may add sameAs to them today).
 * The server and the 1624 migration build and read aliases through this module, so the entity the migration imports and the
 * entity the server writes for the same alias are the same entity.
 */
export const LABEL_ALIAS_TYPE = 'scrum:LabelAlias';
const BASE = 'https://scrumboard.local/labelalias/';
/** One entity per alias SPELLING: a re-declaration of the same alias is the same entity (a revision), never a second node. */
export const labelAliasIri = (alias) => `${BASE}${encodeURIComponent(alias)}`;
/** The entity for one alias row: the alias and its canonical only (who declared it, and when, stay in the event log). */
export function labelAliasEntity({ alias, canonical }) {
  return { '@id': labelAliasIri(alias), '@type': LABEL_ALIAS_TYPE, 'scrum:aliasLabel': alias, 'scrum:canonicalLabel': canonical };
}
/** Rows in either shape: a document row is itself; an entity becomes the row callers read. Anything else is ignored. */
export const labelAliasRows = (list) => (Array.isArray(list) ? list : []).map((x) => {
  if (x && x['@type'] === LABEL_ALIAS_TYPE && typeof x['scrum:aliasLabel'] === 'string' && typeof x['scrum:canonicalLabel'] === 'string') {
    return { id: x['@id'], alias: x['scrum:aliasLabel'], canonical: x['scrum:canonicalLabel'] };
  }
  return x && typeof x.alias === 'string' && typeof x.canonical === 'string' ? x : null;
}).filter(Boolean);
/** The document's rows as entities, for the migration (entities already in that shape pass through). */
export const asLabelAliasEntities = (list) => (Array.isArray(list) ? list : [])
  .map((x) => (x && x['@type'] === LABEL_ALIAS_TYPE ? x : x && typeof x.alias === 'string' && typeof x.canonical === 'string' ? labelAliasEntity(x) : null))
  .filter((x) => x && typeof x['@id'] === 'string');
