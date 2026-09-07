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

import { readFileSync, writeFileSync, renameSync, existsSync, statSync } from 'node:fs';
import { boardToDomain } from './mapping.mjs';
import { domainToJsonLd, jsonLdToDomain, isJsonLdDocument } from './jsonld.mjs';
import { ensurePeople } from './people.mjs';

/**
 * #1014 — parsed-domain cache, keyed on the file's identity, NOT on time.
 *
 * Every read re-read and re-parsed the whole store: ~100 ms of CPU (measured
 * 45 ms read + 51 ms parse on 38.4 MiB) on Node's SINGLE event-loop thread. So
 * reads did not merely cost 100 ms, they cost 100 ms EACH, IN SEQUENCE — 8
 * concurrent readers measured 0.89 s wall against 0.10 s on a control route
 * that reads nothing. That serialization is invisible to a single-user profile
 * by construction, which is why it survived a clean browser profile of #209.
 *
 * ⛔ THE TRAP THIS AVOIDS: callers MUTATE what they are handed — server.js:489
 * writes `c.mentions` onto conversations, :503 replaces `data.columns`. A cache
 * returning one shared object leaks one request's mutations into the next: a
 * corruption that returns 200 and passes every other test. So the cache holds a
 * PRISTINE domain and every caller gets its own `structuredClone`.
 *
 * ⚠️ The clone is not free and the win is honest, not magic:
 *     parse + project                 100 ms
 *     structuredClone                  34 ms   ⇐ what a hit now costs
 *     JSON.parse(JSON.stringify(…))   138 ms   ⛔ SLOWER than reparsing
 *     statSync                          0.2 ms
 *   ⇒ ~3× on a hit, not elimination. 8 readers: ~900 ms → ~300 ms.
 *
 * Keyed on nanosecond mtime + size via a bigint stat. Millisecond mtime alone
 * would serve a stale parse for two writes landing inside the same millisecond;
 * `saveDomain` is tmp+rename and stamps `lastUpdated`, so that window is already
 * narrow, but ns resolution closes it rather than arguing about it.
 */
const CACHE_MAX = 4;
const _cache = new Map();

function _identity(filePath) {
  const st = statSync(filePath, { bigint: true });
  return `${st.mtimeNs}:${st.size}`;
}

/**
 * #715 — the cached domain WITHOUT the clone, for readers that promise not to
 * write. `loadDomain` clones on the way out because writers mutate what they
 * are handed; on a 57 MB board that clone is ~250 ms and ~110 MB of allocation
 * PER REQUEST, and a handful of overlapping readers turned it into a
 * garbage-collection stall that blocked the event loop for eighteen minutes.
 * The caller owns the freeze: this function only hands back the shared object
 * and the identity it was parsed under, so a reader can tell a hit from a
 * rebuild. ⛔ Mutating the result corrupts every later reader in the process.
 */
export function loadDomainShared(filePath) {
  if (!existsSync(filePath)) return { key: null, domain: _parseDomain(filePath) };
  const key = _identity(filePath);
  const hit = _cache.get(filePath);
  if (hit && hit.key === key) return { key, domain: hit.domain };
  const fresh = _parseDomain(filePath);
  if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value);
  _cache.set(filePath, { key, domain: fresh });
  return { key, domain: fresh };
}

/** Read the store → domain projection. Empty domain if the file is absent. */
export function loadDomain(filePath) {
  if (existsSync(filePath)) {
    const key = _identity(filePath);
    const hit = _cache.get(filePath);
    // Clone on the way OUT, always — a hit and a miss must be indistinguishable
    // to the caller, or the first reader after a write silently gets the only
    // mutable copy and the bug comes back for exactly one request in N.
    if (hit && hit.key === key) return structuredClone(hit.domain);
    const fresh = _parseDomain(filePath);
    // Bounded: tests load hundreds of throwaway paths in one process, and an
    // unbounded Map of parsed 38 MiB domains is a leak wearing a cache's name.
    if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value);
    _cache.set(filePath, { key, domain: fresh });
    return structuredClone(fresh);
  }
  return _parseDomain(filePath);
}

function _parseDomain(filePath) {
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
  let stamped = { ...domain, lastUpdated: opts.now || new Date().toISOString() };
  // #686 — a ROSTERED writer materializes Person nodes into the document
  // (regenerated each save: one function, one authority, rebuilt not synced).
  // A roster-less writer (scripts, the redact CLI) PRESERVES whatever people
  // the last rostered save minted — write-granularity preservation, pinned
  // by test. Materialization must not depend on which caller happens to save.
  if (opts.roster) stamped = { ...ensurePeople(stamped, opts.roster), lastUpdated: stamped.lastUpdated };
  const doc = domainToJsonLd(stamped);
  const tmp = filePath + '.tmp';
  const json = JSON.stringify(doc, null, 2);
  writeFileSync(tmp, json, 'utf8');
  renameSync(tmp, filePath);

  // #1114 — THE WRITER INSTALLS WHAT IT JUST WROTE.
  //
  // The cache is keyed on file identity, so before this line every write
  // invalidated it and the next read paid a full re-read + reparse: 422 ms on
  // the live 55.9 MB board, on the same single thread the writes need. In a
  // busy room reads and writes alternate, so the hit rate collapsed toward
  // zero exactly when the cache was worth most.
  //
  // ⛔ What is installed must be what a COLD PROCESS would read, not merely
  // what we have in hand. Three ways to get there, MEASURED on the live 55.9 MB
  // document rather than argued:
  //
  //     what a cold read costs:   readFile 132 ms + JSON.parse 102 ms = 234 ms
  //     A  reparse the string we already wrote          116 ms   ✅ shipped
  //     B  extra JSON.stringify + JSON.parse            371 ms   ⛔ NET LOSS
  //     C  project `doc` directly                        11 ms   ⛔ INCORRECT
  //
  // ⚠️ B is what this fix shipped as until it was measured — it "saves" a
  // 234 ms read by spending 371 ms, which is slower than doing nothing. The
  // store's own #715 note says the same thing in different words and I still
  // had to be shown the number. An optimisation nobody timed is a guess.
  //
  // ⛔ C is the fastest and it is WRONG, which the test caught and reasoning
  // did not: `JSON.stringify` DROPS `undefined`-valued keys, so a domain
  // carrying one makes the cache disagree with the file — silently, for every
  // reader until the next write. That is a worse failure than a slow read.
  //
  // ⇒ A is correct BY CONSTRUCTION rather than by argument: `json` is the
  // exact byte sequence now on disk, and `jsonLdToDomain(JSON.parse(json))` is
  // the exact function a cold reader applies to it. There is no shape that can
  // round-trip differently, because it is the same round trip.
  try {
    _cache.set(filePath, {
      key: _identity(filePath),
      domain: jsonLdToDomain(JSON.parse(json)),
    });
    if (_cache.size > CACHE_MAX) _cache.delete(_cache.keys().next().value);
  } catch {
    // A cache we cannot build correctly is a cache we must not have. Dropping
    // it costs the next reader a reparse; installing a wrong one costs every
    // reader until the next write, silently.
    _cache.delete(filePath);
  }
  return doc;
}

/**
 * #1114 — test seam. Drops the cached parse for one path so a test can prove
 * that an assertion about a cache HIT was not vacuous. Nothing in the server
 * calls this; it exists so the control in `store-write-cache-1114.test.mjs`
 * can show the same read failing without the cache.
 */
export function _dropCacheForTest(filePath) {
  _cache.delete(filePath);
}
