/**
 * #1624 — THE import intention for one small-kind entity: ONE definition, used by the migration (which sends it) and by
 * the retire step (which rebuilds it from the file's content and checks the graph's receipt for it). The receipt's
 * digest is the compiler's digest of this exact intention, so "the graph took THIS content from the migration" is
 * checked by recomputing the digest from the file's copy: any change to the copy changes the digest.
 */
import { createHash } from 'node:crypto';
import { entityQuads } from './collections-unit.mjs';
import { compile } from './graph-compiler.mjs';

export const IMPORT_ACTOR = 'https://scrumboard.local/person/board';
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 32);

export const importOpId = (key, iri) => `urn:ex:op/collection/import/${key}/${sha(iri)}`;

/** `entity` is the document entity AFTER renames; `family` its family definition (core/collection-families.mjs). */
export function importIntention(family, entity) {
  const unique = family.unique ? family.unique(entity) : [];
  const requires = family.requires ? family.requires(entity) : [];
  const part = { collection: family.key, iri: entity['@id'], expectedVersion: null, version: '1', quads: entityQuads(entity), json: JSON.stringify(entity),
    ...(unique.length ? { unique } : {}), ...(requires.length ? { requires } : {}) };
  return { kind: 'entity.put', opId: importOpId(family.key, entity['@id']), actor: IMPORT_ACTOR, entity: { kind: 'collection', parts: [part] } };
}

/** The digest the executor records on the receipt of `importIntention(family, entity)`. */
export const importDigest = (family, entity) => compile(importIntention(family, entity)).digest;
