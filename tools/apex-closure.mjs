#!/usr/bin/env node
/**
 * apex-closure — how much of the board is reachable from a root card.
 *
 * ⚰️ THIS FILE USED TO READ `board-data.json` AND TRAVERSE IN JAVASCRIPT.
 *
 * It was a reproduction of graph traversal, assembled on the fly, to answer a
 * question SPARQL answers with a property path — and its own docstring defended
 * the choice. #858's release condition is literally "one query returns the
 * manyhands set"; the tool wrote a traversal instead of the query.
 *
 * ⛔ AND IT ROTTED THE SAME DAY IT SHIPPED. Measured 2026-08-18:
 *
 *     this tool, JS traversal    381 reachable from #857
 *     the graph, one query       692 reachable from #857
 *
 * The cause was a second copy of the vocabulary:
 *
 *     const EDGE_KEYS = ['relatedTo','blockedBy','supersedes','derivedFrom','supersededBy']
 *
 * `scrum:mentionsCard` shipped that morning — 2,754 edges — and this list never
 * heard about it. The tool had been feeding the room a number 311 cards short,
 * and #858 records "apex closure = 375" from it.
 *
 * ⇒ ⭐ A HAND-BUILT REPRODUCTION CARRIES ITS OWN COPY OF WHAT COUNTS AS AN EDGE,
 * AND THAT COPY GOES STALE WITHOUT ANYONE EDITING IT. There is no diff to
 * review: the vocabulary grew somewhere else.
 *
 * ── SO IT ASKS THE GRAPH NOW ──────────────────────────────────────────────
 *
 * The predicate list still has to be written down — SPARQL has no legal
 * "any predicate, transitively" (`!<x>*` is legal and takes the endpoint down;
 * `(<>|!<>)*` does not parse here; a variable is illegal in a path). But it is
 * written in the QUERY, at the moment of asking, by whoever is asking — not
 * left in a file for a future reader to trust.
 *
 * Usage:
 *   node tools/apex-closure.mjs <rootShortId> [--base http://127.0.0.1:3141]
 */

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith('--'));
const base = (args.find((a) => a.startsWith('--base=')) || '--base=http://127.0.0.1:3141').split('=')[1];

if (!root) {
  console.error('usage: node tools/apex-closure.mjs <rootShortId> [--base=http://host:port]');
  process.exit(2);
}

/**
 * The edge vocabulary, enumerated on purpose.
 *
 * ⚠️ If you add an edge type to the projection, this query does not know. That
 * is the same hazard the old tool had — the difference is that it lives here,
 * in the question, where the person asking can see it and is choosing it. A
 * stale list in a query you are reading is a different animal from a stale list
 * in a file you inherited.
 */
const EDGES = [
  'scrum:mentionsCard', 'scrum:relatedTo', 'scrum:blockedBy',
  'scrum:supersedes', 'scrum:derivedFrom', 'scrum:supersededBy', 'schema:isPartOf',
];
const PATH = `(${EDGES.map((e) => `${e}|^${e}`).join('|')})`;

const q = async (query) => {
  const r = await fetch(`${base}/api/graph`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, limit: 1000 }),
  });
  const b = await r.json();
  if (!r.ok || b.error) throw new Error(`${r.status} ${b.error || ''}${b.hint ? ` — ${b.hint}` : ''}`);
  return b;
};

try {
  const total = await q('SELECT (COUNT(DISTINCT ?c) AS ?n) WHERE { ?c a schema:CreativeWork ; schema:identifier ?i }');
  const reached = await q(
    `SELECT (COUNT(DISTINCT ?c) AS ?n) WHERE { ?a schema:identifier "${root}" . `
    + `?c a schema:CreativeWork ; ${PATH}* ?a }`,
  );
  // ⭐ The unreachable set as a LIST, not a percentage. "45% isolated" is a
  // number nobody can act on; a list of shortIds is a morning's work.
  const orphans = await q(
    `SELECT ?id WHERE { ?a schema:identifier "${root}" . ?c a schema:CreativeWork ; schema:identifier ?id . `
    + `FILTER NOT EXISTS { ?c ${PATH}* ?a } } ORDER BY ?id`,
  );

  const n = Number(reached.rows[0].n);
  const t = Number(total.rows[0].n);
  console.log(`root #${root}  ·  surface: SPARQL replica  ·  undirected  ·  ${reached.ms}ms`);
  console.log(`reached ${n} of ${t} cards  (${((n / t) * 100).toFixed(0)}%)`);
  console.log(`\nunreachable (${orphans.returned}${orphans.truncated ? '+, TRUNCATED' : ''}):`);
  console.log('  ' + orphans.rows.map((r) => '#' + r.id).join(' '));
} catch (e) {
  // ⚠️ A failure here is a finding about the graph, not a reason to go back to
  // reading the file. Per the room's rule (2026-08-18): try the graph; if it
  // fails, file a card naming the failure and a proposed fix.
  console.error(`⛔ graph query failed: ${e.message}`);
  console.error('   That is a card, not a reason to read board-data.json instead.');
  process.exit(1);
}
