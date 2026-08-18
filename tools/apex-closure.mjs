#!/usr/bin/env node
/**
 * apex-closure — measure how much of the board is reachable from a root card.
 *
 * WHY THIS EXISTS
 * #858's release condition is "one query returns the manyhands set, and returns
 * nothing that isn't in it." That is a property of the GRAPH, not a count of
 * edges written. A bulk write is only progress if this number moves, and moves
 * by exactly the amount intended:
 *
 *     more than expected -> something got connected that wasn't meant to be
 *     fewer than expected -> a write did not land
 *
 * So: snapshot before, write, snapshot after, diff. "Seven edges written" is an
 * activity count; "the closure grew by exactly nine, and the named out-of-scope
 * card is still absent" is evidence.
 *
 * ⛔ WHICH SURFACE THIS READS, STATED BECAUSE IT MATTERS
 * The on-disk JSON-LD store, not the REST projection and not the SPARQL replica.
 * Those disagree: the store keys relationships at top level by UUID and calls
 * hierarchy `isPartOf`; the API nests them under `relationships` by shortId and
 * calls hierarchy `parent`; the replica MINTS types the store has never held.
 * A closure measured on one surface is not a claim about another. (2026-08-18:
 * two seats each concluded a field was absent by grepping the other surface's
 * name for it. Both were wrong, in opposite directions.)
 *
 * ⭐ THE SELF-CHECK IS THE POINT
 * A traversal bug reports a SMALL number, and a small number looks like a
 * finding rather than a failure. This tool takes a card it must be able to
 * reach and REFUSES TO PRINT unless it reaches it. An instrument that cannot
 * fail loudly will eventually fail quietly.
 *
 * usage:
 *   node tools/apex-closure.mjs <rootShortId> [--expect-reachable N,N] [--json]
 *   node tools/apex-closure.mjs --diff before.json after.json
 */

import fs from 'node:fs';
import path from 'node:path';

// ⛔ NO DEFAULT PATH. The first version of this line carried an absolute path to
// the operator's private data tree, and the #561 publication gate refused the
// push — correctly. A convenience default that names where someone's board lives
// is exactly the residue that gate exists to keep out of a public repo.
//
// ⚠️ And requiring the variable is better than defaulting it for a second reason:
// a tool that silently reads SOME board when you forget to say which one will
// happily report a closure for the wrong graph. Refusing is the honest failure.
const STORE = process.env.BOARD_DATA;
if (!STORE) {
  console.error('BOARD_DATA is not set — it must point at the board-data.json to read.\n'
    + '  BOARD_DATA=/path/to/board-data.json node tools/apex-closure.mjs <rootShortId>\n'
    + '  (deliberately has no default: a closure measured against an unnamed board is\n'
    + '   a number without a surface, and this repo is public.)');
  process.exit(2);
}

// Authored edge types plus hierarchy. `isPartOf` is the STORE's name for what
// the API calls `parent`; both are included so a closure does not silently
// depend on which writer created the edge.
const EDGE_KEYS = ['relatedTo', 'blockedBy', 'supersedes', 'derivedFrom', 'supersededBy'];

function load() {
  const graph = JSON.parse(fs.readFileSync(STORE, 'utf8'))['@graph'];
  // A card is a graph member carrying additionalType. Comments and tending
  // entities share the store and are not part of card reachability.
  const cards = graph.filter((e) => e.additionalType);
  const byUuid = new Map(cards.map((e) => [String(e['@id']), e]));
  const uuidOf = new Map(cards.map((e) => [String(e.identifier), String(e['@id'])]));
  return { cards, byUuid, uuidOf };
}

/**
 * Neighbours of a node, UNDIRECTED.
 *
 * ⚠️ Directed reachability would answer a different and narrower question: "what
 * does the apex point AT". A membership set is not directional — a card parented
 * to a seam is in the set whether the edge is read from the child or the parent.
 * The direction choice is stated rather than defaulted, because it changes the
 * number and every reader deserves to know which was measured.
 */
function buildAdjacency({ cards }) {
  const adj = new Map();
  const link = (a, b) => {
    if (!a || !b) return;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b);
    adj.get(b).add(a);
  };
  for (const c of cards) {
    const self = String(c['@id']);
    for (const k of EDGE_KEYS) for (const t of c[k] || []) link(self, String(t));
    if (c.isPartOf) link(self, String(c.isPartOf));
  }
  return adj;
}

function closure(adj, rootUuid, maxDepth = 12) {
  const seen = new Set([rootUuid]);
  let frontier = new Set([rootUuid]);
  const byDepth = [];
  for (let d = 1; d <= maxDepth; d += 1) {
    const next = new Set();
    for (const n of frontier) for (const m of adj.get(n) || []) if (!seen.has(m)) next.add(m);
    if (!next.size) break;
    for (const m of next) seen.add(m);
    frontier = next;
    byDepth.push({ depth: d, cumulative: seen.size - 1, added: next.size });
  }
  seen.delete(rootUuid);
  return { reached: seen, byDepth };
}

function snapshot(rootShortId, expectReachable) {
  const data = load();
  const rootUuid = data.uuidOf.get(String(rootShortId));
  if (!rootUuid) throw new Error(`root #${rootShortId} not found in the store`);
  const adj = buildAdjacency(data);
  const { reached, byDepth } = closure(adj, rootUuid);

  // ⭐ SELF-CHECK. Without this, a broken traversal reports a plausible small
  // number and nobody can tell. Any card known to be reachable will do; the
  // root's own direct neighbours are the cheapest honest choice.
  const directCount = (adj.get(rootUuid) || new Set()).size;
  if (directCount === 0) {
    throw new Error(
      `SELF-CHECK FAILED: root #${rootShortId} has zero adjacent nodes. Either the root is\n`
      + '  genuinely isolated (a real and reportable finding) or the traversal is reading the\n'
      + '  wrong field names for this surface. Verify against a card known to carry edges\n'
      + '  before trusting any number from this run.',
    );
  }
  for (const sid of expectReachable) {
    const u = data.uuidOf.get(String(sid));
    if (!u) throw new Error(`SELF-CHECK: expected-reachable card #${sid} does not exist`);
    if (!reached.has(u)) {
      throw new Error(
        `SELF-CHECK FAILED: #${sid} was asserted reachable from #${rootShortId} and is not.\n`
        + '  Refusing to report. Either the assertion is wrong or the traversal is.',
      );
    }
  }

  return {
    root: String(rootShortId),
    surface: 'on-disk @graph (store)',
    direction: 'undirected',
    store: path.basename(STORE),
    totalCards: data.cards.length,
    reachedCount: reached.size,
    byDepth,
    reached: [...reached].map((u) => String(data.byUuid.get(u)?.identifier ?? u)).sort(),
  };
}

function report(s) {
  console.log(`root #${s.root}  ·  surface: ${s.surface}  ·  ${s.direction}`);
  console.log(`reached ${s.reachedCount} of ${s.totalCards} cards`);
  for (const d of s.byDepth) console.log(`   depth ${d.depth}: +${d.added}  (cumulative ${d.cumulative})`);
}

function diff(beforePath, afterPath) {
  const a = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
  const b = JSON.parse(fs.readFileSync(afterPath, 'utf8'));
  if (a.root !== b.root) throw new Error(`different roots: #${a.root} vs #${b.root} — not comparable`);
  if (a.direction !== b.direction || a.surface !== b.surface) {
    throw new Error('snapshots measured on different surfaces or directions — not comparable');
  }
  const before = new Set(a.reached);
  const after = new Set(b.reached);
  const gained = [...after].filter((x) => !before.has(x)).sort();
  const lost = [...before].filter((x) => !after.has(x)).sort();
  console.log(`root #${a.root}   ${a.reachedCount} → ${b.reachedCount}   (${gained.length >= 0 ? '+' : ''}${b.reachedCount - a.reachedCount})`);
  console.log(`gained (${gained.length}): ${gained.join(' ') || '—'}`);
  console.log(`lost   (${lost.length}): ${lost.join(' ') || '—'}`);
  if (lost.length) {
    console.log('\n⛔ CARDS LEFT THE CLOSURE. A membership write should be additive;');
    console.log('   a loss means an edge was overwritten. Check the rollback file.');
  }
  return { gained, lost };
}

const argv = process.argv.slice(2);
if (argv[0] === '--diff') {
  diff(argv[1], argv[2]);
} else {
  const root = argv[0];
  if (!root) {
    console.error('usage: node tools/apex-closure.mjs <rootShortId> [--expect-reachable N,N] [--json]');
    process.exit(2);
  }
  const ix = argv.indexOf('--expect-reachable');
  const expect = ix === -1 ? [] : String(argv[ix + 1] || '').split(',').filter(Boolean);
  const s = snapshot(root, expect);
  if (argv.includes('--json')) console.log(JSON.stringify(s, null, 2));
  else report(s);
}
