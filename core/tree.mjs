/**
 * core/tree.mjs — hierarchy derivation from node `isPartOf` (ADR-001 #214 +
 * a standing requirement: pages AND issues nest, recursively).
 *
 * Hierarchy is stored FLAT — each node carries an optional `isPartOf` (its
 * parent's @id) — and the TREE is DERIVED. Moving a node = repoint `isPartOf`;
 * nothing else changes, no paths to rewrite. The same primitive serves wiki
 * subpages and agile epic→story→subtask breakdown. Pure, no I/O.
 */

/**
 * Index nodes by parent. Returns { children: Map<id, childId[]>, roots: id[] }.
 * A node with no `isPartOf` — or a dangling parent not in the set — is a root.
 * Child order follows input order.
 */
export function buildChildIndex(nodes) {
  const children = new Map();
  const roots = [];
  for (const n of nodes) children.set(n['@id'], []);
  for (const n of nodes) {
    const parent = n.isPartOf;
    if (parent != null && children.has(parent)) children.get(parent).push(n['@id']);
    else roots.push(n['@id']);
  }
  return { children, roots };
}

/**
 * Build the nested tree: an array of roots, each { id, node, children: [...] }.
 * Cycle-safe — a node already on the current descent path is not re-entered.
 */
export function buildTree(nodes) {
  const { children, roots } = buildChildIndex(nodes);
  const byId = new Map(nodes.map((n) => [n['@id'], n]));
  const build = (id, seen) => {
    if (seen.has(id)) return { id, node: byId.get(id), children: [] }; // cycle guard
    const next = new Set(seen).add(id);
    return {
      id,
      node: byId.get(id),
      children: children.get(id).map((childId) => build(childId, next)),
    };
  };
  return roots.map((id) => build(id, new Set()));
}
