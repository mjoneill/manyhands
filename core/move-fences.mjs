/**
 * #1707 — THE MOVE FENCES, ONE DEFINITION. A fence is a move requestId whose outcome was unknown and which its tab then
 * settled: from the fence on, a makeRoom PATCH carrying that id is refused (409 MOVE_FENCED). Fences are permanent.
 *
 * Two shapes, by where the set lives:
 *   · the DOCUMENT path (the small-kinds unit off): `data.moveFences` is an array of requestId STRINGS, as it always was;
 *   · the GRAPH path (the unit on): `data.moveFences` is the `moveFences` collection family (core/collection-families.mjs),
 *     one ENTITY per fence, written through the guarded entity.put like every other family. A lost or re-seeded document
 *     no longer forgets a fence, because the document is not where it is read from.
 * The server, the 1624 migration and its retire step all read and build fences through this module, so a string the
 * migration imports and the entity the server writes for the same id are the same entity.
 */
export const MOVE_FENCE_TYPE = 'scrum:MoveFence';
const BASE = 'https://scrumboard.local/movefence/';
/** The route already restricts a requestId to [A-Za-z0-9-]{8,64}, so it is safe as an IRI path segment as it stands. */
export const moveFenceIri = (requestId) => `${BASE}${requestId}`;
/** The entity for one fence. `fencedAt` is when the fence was recorded; an imported legacy fence has none (never invented). */
export function moveFenceEntity(requestId, fencedAt = null) {
  return { '@id': moveFenceIri(requestId), '@type': MOVE_FENCE_TYPE, 'scrum:fencedMove': requestId, ...(fencedAt ? { 'scrum:fencedAt': fencedAt } : {}) };
}
/** The fenced requestIds in either shape: a string is itself, an entity is its scrum:fencedMove; anything else is ignored. */
export const moveFenceIds = (list) => (Array.isArray(list) ? list : [])
  .map((x) => (typeof x === 'string' ? x : x && x['@type'] === MOVE_FENCE_TYPE && typeof x['scrum:fencedMove'] === 'string' ? x['scrum:fencedMove'] : null))
  .filter((x) => typeof x === 'string');
/** The document's legacy strings as entities, for the migration (entities already in that shape pass through). */
export const asMoveFenceEntities = (list) => (Array.isArray(list) ? list : [])
  .map((x) => (typeof x === 'string' ? moveFenceEntity(x) : x))
  .filter((x) => x && typeof x['@id'] === 'string');
