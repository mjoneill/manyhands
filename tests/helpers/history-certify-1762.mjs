/**
 * #1762 S4 v1.6.2 — build a CERTIFIED history frontier in a throwaway executor: the tree graph (header, rank entries, internal subtrees) and F's five history fields, from the live
 * canonical seq-nodes, with the independent reference in history-merkle-1762.mjs. ROW AUTHOR's code: it imports no product code and calls no construction script.
 *
 * `certifier(env)` takes the world's own operations so the same builder serves the reader rows and the lane rows:
 *   env = { q(sparql) -> bindings, update(sparql), BK (bookkeeping graph IRI), FR (F's IRI), XSD, PROV, RS, ACT }
 */
import crypto from 'node:crypto';
import * as M from './history-merkle-1762.mjs';

export const NS = 'urn:ex:';
export const HIST_F = ['Root', 'LeafCount', 'Tree', 'Format', 'Commitment'];
export const lit = (v) => JSON.stringify(String(v));

export function certifier({ q, update, BK, FR, XSD, PROV, RS, ACT }) {
  const X = (v) => `"${v}"^^<${XSD}integer>`;
  let seq = 0;
  /** the live canonical seq-nodes at or below `logSeq`, as certificate entries (ascending N) */
  async function liveEntries(logSeq) {
    const rows = await q(`SELECT ?a ?u ?op ?k WHERE { ?a <${PROV}used> ?u ; <${RS}op> ?op ; <${RS}entityKind> ?k . FILTER(STRSTARTS(STR(?a), "${ACT}seq-")) }`);
    const out = [];
    for (const b of rows) {
      const m = /^seq-(\d+)$/.exec(b.a.value.slice(ACT.length)); if (!m) continue;
      const N = Number(m[1]); if (N <= logSeq) out.push({ N, used: b.u.value, op: b.op.value, entityKind: b.k.value });
    }
    return out.sort((a, b) => a.N - b.N);
  }
  const leafIri = (tree, rank) => `${tree}/leaf/${rank}`;
  const nodeIri = (tree, s0, e0) => `${tree}/node/${s0}-${e0}`;
  const leafTriples = (tree, rank, e, leafHex) => `<${leafIri(tree, rank)}> <${NS}htRank> ${X(rank)} ; <${NS}htN> ${X(e.N)} ; <${NS}htUsed> <${e.used}> ; <${NS}htOp> ${lit(e.op)} ; <${NS}htKind> ${lit(e.entityKind)} ; <${NS}htLeaf> ${lit(leafHex)} .`;
  /** the internal subtrees RFC 6962's split names, as [start, end) ranges (a size-1 range is the leaf entry itself) */
  function internalRanges(L) { const out = []; const rec = (a, b) => { if (b - a < 2) return; out.push([a, b]); let k = 1; while (k * 2 < b - a) k *= 2; rec(a, a + k); rec(a + k, b); }; rec(0, L); return out; }
  /** write a tree graph for `entries`; returns what a test needs to tamper with it */
  async function writeTree(entries, { tree = `urn:scrum:history-tree:hb${++seq}-${crypto.randomUUID().slice(0, 6)}`, header = true } = {}) {
    const built = M.build(entries);
    const lines = [];
    if (header) lines.push(`<${tree}> <${NS}htFormat> "hist-v1" ; <${NS}htLeafCount> ${X(built.L)} ; <${NS}htRoot> ${lit(built.root)} .`);
    entries.forEach((e, i) => lines.push(leafTriples(tree, i, e, M.hex(built.leaves[i]))));
    const ranges = internalRanges(built.L);
    for (const [a, b] of ranges) lines.push(`<${nodeIri(tree, a, b)}> <${NS}htStart> ${X(a)} ; <${NS}htEnd> ${X(b)} ; <${NS}htHash> ${lit(M.hex(M.mth(built.leaves.slice(a, b))))} .`);
    await update(`INSERT DATA { GRAPH <${tree}> { ${lines.join('\n')} } }`);
    return { tree, built, entries, ranges };
  }
  /** F's five history fields for a tree and the F values they are committed with. `fields` overrides a field's SPARQL term (tampering). */
  async function writeFrontierHistory({ epoch, incarnationHex, logSeq, commitSeq, t, fields = {}, omit = [] }) {
    const commitment = M.commitment({ epoch, incarnation: incarnationHex, logSeq, commitSeq, L: t.built.L, tree: t.tree, root: t.built.root });
    const f = { Root: lit(t.built.root), LeafCount: X(t.built.L), Tree: `<${t.tree}>`, Format: lit('hist-v1'), Commitment: lit(commitment), ...fields };
    const keys = HIST_F.filter((k) => !omit.includes(k));
    if (keys.length) await update(`INSERT DATA { GRAPH <${BK}> { ${keys.map((k) => `<${FR}> <${NS}frontierHistory${k}> ${f[k]} .`).join('\n')} } }`);
    return { commitment, root: t.built.root, L: t.built.L, tree: t.tree };
  }
  return { X, liveEntries, leafIri, nodeIri, leafTriples, internalRanges, writeTree, writeFrontierHistory };
}
