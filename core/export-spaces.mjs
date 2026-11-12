/**
 * core/export-spaces.mjs — WHAT THE BOARD CAN EXPORT, derived, not typed (#1321).
 *
 * The export used to know three words — `commons`, `cards`, `wiki` — while the
 * kind registry knew 38 kinds. Memories, decisions, runs, model calls, agents,
 * deliveries and everything minted since were silently absent from every
 * archive, and the menu offered two of the three. The owner opened it and said
 * "having it in the Board suggests it only exports the board", and that was
 * true. The owner decided on 2026-09-13: DERIVE (recorded on the card).
 *
 * So this module reads the kind registry — the same registry #1214 built and
 * #1215 polices — and says: every registered kind that has a collection on
 * the board is an export SPACE. A kind minted next month is exportable by
 * construction. The two words people already type (`wiki`, `conversations`)
 * stay as aliases. Prose kinds (the room's words) are ticked by default;
 * machine kinds (ledgers, wakes, deliveries) are offered but unticked, because
 * an archive is for reading. And `describeExportSet` names, for a given
 * document and selection, what is INCLUDED (with counts), what is EXCLUDED
 * (with counts — an honest subset), and what is PRESENT BUT UNREGISTERED
 * (#804 keeps such entities verbatim under `_unmodelled`; #1215 names them) —
 * so an unregistered kind cannot be silently left out of an export either.
 *
 * Pure. The server serves it as `GET /api/export/spaces`; the exporter and the
 * Settings page both consume it, which is how the menu cannot drift from the
 * exporter (#1163's lesson, one layer up).
 */
import { KIND_DECLARATIONS } from './kind-registry.mjs';

/** Store key → the space name a human types. Everything else keeps its store key, kebab-cased. */
const SPACE_NAME_OF = { conversations: 'commons', modelCalls: 'model-calls', agentPrompts: 'agent-prompts', seatStates: 'seat-states', labelAliases: 'label-aliases' };
/** The words people already type, and what they mean. */
const ALIASES = { cards: ['wiki', 'board', 'card'], commons: ['conversations', 'conversation', 'room', 'messages'] };
/** The room's WORDS — ticked by default. Everything else is machine state, offered but unticked. */
const PROSE = new Set(['cards', 'commons', 'memories', 'decisions', 'procedures', 'obligations', 'kinds', 'predicates', 'tending']);
/** Collections that are not entities anyone reads in an archive: operator config and internal state. */
const NOT_EXPORTABLE = new Set(['columns', 'labelAliases', 'seatStates']);

/**
 * #1825 — the kinds whose RECORD IS THE GRAPH, and the route that serves each. With the graph units on, GET /api/board leaves
 * these collections out on purpose (#1582/#1626 posts, deliveries, model calls; #1624 wakes; #1561 memories), so reading them
 * from the document gives an empty list that looks like an empty board — which is how a whole room went missing from an export
 * that said "all accounted for". Each source names the KEY its rows arrive under (`null` = a bare array). The exporter refuses a
 * response without that key, because a lenient fallback is the same silent zero again (model calls answer under `calls`).
 * Each route serves both modes (units on: the graph; off: the document), so the exporter reads them the same way on every board.
 *   - /api/conversations with NO params is uncapped by contract (#202). Never page it by seq: under the conversations unit every
 *     seq page re-reads every post, so a walk is one full read per 200 posts.
 *   - /api/deliveries without all=1 is active deliveries plus the last 24 hours (#1582 hotfix 2). With all=1 it is read in
 *     PAGES (#1826): `paged` names the response field holding the next cursor, sent back as `after` until it is null. One
 *     unbounded all=1 read stopped answering at ~21.9k deliveries (503 after 10 s, measured 2026-11-12).
 */
export const ROUTE_SOURCES = Object.freeze({
  commons: { source: '/api/conversations', key: null },
  deliveries: { source: '/api/deliveries?all=1&limit=500', key: 'deliveries', paged: 'next' },
  'model-calls': { source: '/api/model-calls', key: 'calls' },
  wakes: { source: '/api/wakes', key: null },
  memories: { source: '/api/memories', key: 'memories' },
});

/**
 * The rows of a source's response, or an Error naming the route and the key it expected. A source with a declared key (or
 * `null`, a bare array) is held to it exactly. The registry's own three (decisions, kinds, predicates) predate declared keys:
 * an array, or an array under the space's name or `rows`, and anything else refuses — never `[]`.
 */
export function rowsOfResponse(space, json) {
  const where = `${space.source} (${space.space})`;
  if (space.key === null) return Array.isArray(json) ? json : new Error(`${where} answered without the bare array it serves`);
  if (typeof space.key === 'string') return Array.isArray(json?.[space.key]) ? json[space.key] : new Error(`${where} answered without its rows under \`${space.key}\``);
  if (Array.isArray(json)) return json;
  for (const k of [space.space, 'rows']) if (Array.isArray(json?.[k])) return json[k];
  return new Error(`${where} answered without an array, under \`${space.space}\`, or under \`rows\``);
}

const kebab = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

/**
 * Every export space, derived from the registry. Stable order: prose first,
 * then machine, each alphabetical by space name — the menu's order.
 * @returns {Array<{space:string, kind:string|null, collection:string, prose:boolean, aliases:string[], definition:string}>}
 */
export function exportableSpaces() {
  const seen = new Set();
  const out = [];
  for (const k of KIND_DECLARATIONS) {
    const collection = k.collection;
    if (!collection || NOT_EXPORTABLE.has(collection) || seen.has(collection)) continue;
    seen.add(collection);
    const space = SPACE_NAME_OF[collection] || kebab(collection);
    out.push({
      space, kind: k.name ?? null, collection,
      prose: PROSE.has(space), aliases: ALIASES[space] || [],
      definition: String(k.definition || ''),
      ...(ROUTE_SOURCES[space] || {}),   // #1825
    });
  }
  // Three kinds are registered WITHOUT a document collection because they are
  // born in the graph (#1147 decisions) or are the registry's own rows. They
  // are still export spaces; the exporter reads them from their own endpoint
  // (`GET /api/decisions`, `/api/kinds`, `/api/predicates`) and the index
  // counts them from there — the `source` says so.
  for (const [space, kind, source] of [['decisions', 'scrum:Decision', '/api/decisions'], ['kinds', 'scrum:KindDefinition', '/api/kinds'], ['predicates', 'scrum:PredicateDefinition', '/api/predicates']]) {
    if (seen.has(space)) continue;
    seen.add(space);
    const decl = KIND_DECLARATIONS.find((k) => k.name === kind);
    out.push({ space, kind, collection: space, source, prose: true, aliases: [], definition: String(decl?.definition || `The registry's own ${space}.`) });
  }
  return out.sort((a, b) => (a.prose === b.prose ? a.space.localeCompare(b.space) : a.prose ? -1 : 1));
}

/** Resolve typed words to canonical space names; `all` means every registered space. Unknown words are returned in `unknown`. */
export function resolveSpaces(words) {
  const spaces = exportableSpaces();
  const byWord = new Map();
  for (const s of spaces) { byWord.set(s.space, s.space); for (const a of s.aliases) byWord.set(a, s.space); }
  const list = (Array.isArray(words) ? words : String(words ?? '').split(','))
    .map((w) => String(w).trim().toLowerCase()).filter(Boolean);
  const resolved = []; const unknown = [];
  for (const w of list) {
    if (w === 'all') { for (const s of spaces) if (!resolved.includes(s.space)) resolved.push(s.space); continue; }
    const r = byWord.get(w);
    if (!r) unknown.push(w); else if (!resolved.includes(r)) resolved.push(r);
  }
  return { resolved, unknown, known: spaces.map((s) => s.space) };
}

/**
 * Rows for a space: an override (a space read from its own endpoint) wins over
 * the document's collection. Memories are HEAD + versions in one collection
 * (#1287): a memory counts once, as its head, and the exporter joins the
 * current version's body onto it — so "252 memories" means 252 things
 * remembered, not 252 + their edit history.
 */
export function rowsFor(doc, space, overrides = {}) {
  if (Array.isArray(overrides[space.space])) return overrides[space.space];
  const rows = Array.isArray(doc?.[space.collection]) ? doc[space.collection] : [];
  if (space.space !== 'memories') return rows;
  const versions = new Map(rows.filter((e) => e?.['@type'] === 'scrum:MemoryVersion').map((v) => [v['@id'], v]));
  return rows.filter((e) => e?.['@type'] === 'scrum:Memory').map((h) => {
    const v = versions.get(h['scrum:currentVersion']);
    return v ? { ...h, 'scrum:body': v['scrum:body'], author: v.author, dateCreated: v.dateCreated, 'scrum:version': v['scrum:version'] } : h;
  });
}

/**
 * For a board document and a selection: included (with counts), excluded (with
 * counts — every registered space not selected, even at 0), and unregistered
 * (types present in `_unmodelled`, by type, with a count and one example).
 * `overrides` supplies rows for spaces that live outside the document (decisions).
 */
export function describeExportSet(doc, words, overrides = {}, opts = {}) {
  const spaces = exportableSpaces();
  const { resolved } = resolveSpaces(words);
  const included = []; const excluded = [];
  for (const s of spaces) {
    // #1825 — for the EXPORTER (opts.unreadIfAbsent): a kind served by its own route that was not read, on a document without
    // its collection (GET /api/board omits it under a graph unit), has NO count: null ("not read"), never a 0 the board did not
    // say. The menu's own call keeps #1321's rule, where an absent collection is an empty one.
    const unread = opts.unreadIfAbsent && s.source && !Array.isArray(overrides[s.space]) && !Array.isArray(doc?.[s.collection]);
    const row = { space: s.space, kind: s.kind, collection: s.collection, prose: s.prose, count: unread ? null : rowsFor(doc, s, overrides).length };
    (resolved.includes(s.space) ? included : excluded).push(row);
  }
  const byType = new Map();
  for (const e of (Array.isArray(doc?._unmodelled) ? doc._unmodelled : [])) {
    const t = String(e?.['@type'] ?? '(no @type)');
    const cur = byType.get(t) || { type: t, count: 0, example: e?.['@id'] ?? null };
    cur.count += 1; byType.set(t, cur);
  }
  const unregistered = [...byType.values()].sort((a, b) => a.type.localeCompare(b.type));
  return { included, excluded, unregistered, selected: resolved };
}
