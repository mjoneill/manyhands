/**
 * core/links.mjs — wikilink parsing + backlink derivation (ADR-001 #214).
 *
 * Links are NOT stored — they're DERIVED from `[[wikilinks]]` in a node's body
 * (single source of truth). `parseWikiLinks` extracts targets from text;
 * `buildLinkIndex` resolves them across a node set into an outbound + backlink
 * index. Pure functions, no I/O.
 */

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

/**
 * Extract `[[wikilink]]` targets from text, in first-seen order, deduplicated.
 * `[[Target|alias]]` yields the target ("Target"); whitespace is trimmed.
 */
export function parseWikiLinks(text) {
  if (typeof text !== 'string') return [];
  const targets = [];
  const seen = new Set();
  for (const m of text.matchAll(WIKILINK_RE)) {
    let target = m[1];
    const pipe = target.indexOf('|');
    if (pipe >= 0) target = target.slice(0, pipe);
    target = target.trim();
    if (target && !seen.has(target)) {
      seen.add(target);
      targets.push(target);
    }
  }
  return targets;
}

/**
 * Derive the link graph over a node set. Targets resolve to nodes by `name`
 * (case-insensitive — the wiki convention `[[Page Title]]`). Self-links and
 * unresolved targets are dropped (a "broken links" surface is deferred).
 * Returns { outbound: Map<id, id[]>, backlinks: Map<id, id[]> }, keyed by @id.
 */
export function buildLinkIndex(nodes) {
  const byName = new Map();
  for (const n of nodes) {
    if (typeof n.name === 'string') byName.set(n.name.toLowerCase(), n);
  }
  const outbound = new Map();
  const backlinks = new Map();
  for (const n of nodes) backlinks.set(n['@id'], []);
  for (const n of nodes) {
    const resolved = [];
    for (const target of parseWikiLinks(n.text || '')) {
      const hit = byName.get(target.toLowerCase());
      if (hit && hit['@id'] !== n['@id']) {
        resolved.push(hit['@id']);
        backlinks.get(hit['@id']).push(n['@id']);
      }
    }
    outbound.set(n['@id'], resolved);
  }
  return { outbound, backlinks };
}
