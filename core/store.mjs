/**
 * core/store.mjs — storage adapter for the node domain (ADR-002 D2/D3, #227).
 *
 * The imperative shell around the pure domain↔disk serialization: it owns the
 * file conventions (atomic tmp+rename) and nothing else. The domain core never
 * touches the filesystem.
 *
 * Storage is schema.org-PRIMARY: the canonical on-disk format is a JSON-LD
 * document (core/jsonld.mjs) — the domain's CreativeWork/Comment nodes persisted
 * directly. `loadDomain` still reads the LEGACY `{cards, conversations, …}` blob
 * too, so old backups and the legacy-shaped test fixtures keep working and any
 * legacy file transparently flips to JSON-LD on its next save. `saveDomain`
 * always writes JSON-LD.
 *
 * The hexagonal seam means a future SQLite adapter (D2) can replace this behind
 * the same loadDomain/saveDomain contract with no domain or view changes, gated
 * on a real trigger (FTS/search). The `_README` banner rides through the domain
 * and is guaranteed to lead the file (domainToJsonLd places it first).
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { boardToDomain } from './mapping.mjs';
import { domainToJsonLd, jsonLdToDomain, isJsonLdDocument } from './jsonld.mjs';

/** Read the store → domain projection. Empty domain if the file is absent. */
export function loadDomain(filePath) {
  if (!existsSync(filePath)) {
    return { nodes: [], messages: [], columns: [], nextShortId: 1, lastUpdated: null };
  }
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  // schema.org-primary (#227) — the canonical format.
  if (isJsonLdDocument(parsed)) return jsonLdToDomain(parsed);
  // Legacy `{cards, …}` blob — old backups + legacy-shaped test fixtures.
  // Defensive shape-coercion, then project to the domain.
  if (!Array.isArray(parsed.cards)) parsed.cards = [];
  if (!Array.isArray(parsed.columns)) parsed.columns = [];
  if (!Array.isArray(parsed.conversations)) parsed.conversations = [];
  if (typeof parsed.nextShortId !== 'number') parsed.nextShortId = 1;
  return boardToDomain(parsed);
}

/**
 * Persist a domain as a JSON-LD document. Atomic (tmp + rename), `_README`
 * leads, `lastUpdated` stamped (carried in `scrum:meta`). `opts.now` overrides
 * the timestamp (test determinism). Returns the written JSON-LD document.
 */
export function saveDomain(filePath, domain, opts = {}) {
  const stamped = { ...domain, lastUpdated: opts.now || new Date().toISOString() };
  const doc = domainToJsonLd(stamped);
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
  renameSync(tmp, filePath);
  return doc;
}
