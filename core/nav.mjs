/**
 * core/nav.mjs — pure logic for the wiki page-nav (#229): filter, sort, and
 * tree transforms over schema.org nodes. Browser-safe ESM (no I/O, no DOM), so
 * wiki.html imports it and node tests cover it.
 *
 * The filter mirrors the board's #53 `field:value` + free-text syntax for
 * consistency, mapped onto the node shape (CreativeWork + `board` facet).
 */

const lc = (v) => (v == null ? '' : String(v)).toLowerCase();

/**
 * Match a node against a query: space-separated terms ANDed; each term is either
 * `field:value` (type/label/assignee/priority/column/for/id) or free text
 * (name + body + #id). Empty query matches everything. Unknown field → free text.
 */
export function matchesNodeQuery(node, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return true;
  return q.split(/\s+/).filter(Boolean).every((term) => matchesTerm(node, term));
}

function matchesTerm(node, term) {
  const colon = term.indexOf(':');
  if (colon > 0) {
    const field = term.slice(0, colon);
    const value = term.slice(colon + 1);
    if (value === '') return true; // bare "field:" imposes no constraint
    const board = node.board || {};
    switch (field) {
      case 'type':
        return lc(node.additionalType).replace(/^scrum:/, '') === value;
      case 'label': case 'tag':
        return (board.labels || []).some((l) => lc(l).includes(value));
      case 'assignee': case 'who':
        return (board.assignees || []).some((a) => lc(a).includes(value));
      case 'priority': case 'prio':
        return lc(board.priority).includes(value);
      case 'column': case 'col':
        return lc(board.column).includes(value);
      case 'for':
        return lc(board.for).includes(value);
      case 'id':
        return String(node.identifier != null ? node.identifier : '') === value;
      // unknown field falls through to free-text matching of the whole term
    }
  }
  const hay = [node.name || '', node.text || '', '#' + (node.identifier ?? ''), String(node.identifier ?? '')]
    .join(' ').toLowerCase();
  return hay.includes(term);
}

/**
 * A comparator over nodes for the sort toggle.
 * - 'edited'  → most-recently-modified first (dateModified desc)
 * - 'created' → newest first (dateCreated desc)
 * - 'alpha'   → name A→Z, case-insensitive + numeric-aware (default)
 */
export function nodeComparator(mode) {
  if (mode === 'edited') return (a, b) => lc(b.dateModified).localeCompare(lc(a.dateModified));
  if (mode === 'created') return (a, b) => lc(b.dateCreated).localeCompare(lc(a.dateCreated));
  return (a, b) => lc(a.name).localeCompare(lc(b.name), undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Prune a tree (array of { id, node, children }) to branches whose node matches
 * `predicate` OR that have a kept descendant — so the path to every match stays
 * visible. Returns new branch objects (does not mutate).
 */
export function filterTree(branches, predicate) {
  const out = [];
  for (const b of branches || []) {
    const children = filterTree(b.children || [], predicate);
    if (predicate(b.node) || children.length) out.push({ ...b, children });
  }
  return out;
}

/** Sort every level of the tree by a node comparator. Returns new branches. */
export function sortTree(branches, comparator) {
  return (branches || [])
    .map((b) => ({ ...b, children: sortTree(b.children || [], comparator) }))
    .sort((x, y) => comparator(x.node, y.node));
}
