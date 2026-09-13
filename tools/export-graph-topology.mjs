#!/usr/bin/env node
/**
 * export-graph-topology.mjs — export the board's card graph for visual audit.
 *
 * READ-ONLY. Node stdlib only — no dependencies.
 *
 * Reads the live board store (JSON-LD flat file), extracts the CARD graph
 * (schema:CreativeWork entries with an integer identifier + column), and emits:
 *
 *   <prefix>.dot             Graphviz — colour by column, isolated nodes greyed
 *   <prefix>.cytoscape.json  Cytoscape-compatible elements array
 *   plus a component/isolation summary on stdout.
 *
 * Usage:
 *   node tools/export-graph-topology.mjs [--data <board-data.json>]
 *        [--out <prefix>] [--format dot|cyto|both]
 *
 * Defaults: --data $SCRUM_BOARD_FILE — and NOTHING else. There is no home-path
 *           fallback (#1357): a tool that reads the production board when
 *           given no arguments is the read-only cousin of the test that posted
 *           to :3141 by inheriting a default. Name the file.
 *           --out  ./graph-topology   --format both
 *
 * ⚠️ TREE NOTE (see [#586]): the DATA file is wherever the server's
 *    SCRUM_BOARD_FILE points; CODE claims about running behaviour belong to
 *    the served tree, not this checkout. This tool only READS data; it writes
 *    nothing to the board.
 */
import fs from 'node:fs';

const REL_TYPES = ['relatedTo', 'blockedBy', 'supersedes', 'derivedFrom', 'supersededBy'];
const COLUMN_COLORS = {
  backlog: '#9e9e9e',
  done: '#c8e6c9',
  'in-progress': '#bbdefb',
};
const trunc = (s, n = 60) => (s || '').replace(/["\\]/g, "'").slice(0, n) + ((s || '').length > n ? '…' : '');

/**
 * The whole computation, on a parsed JSON-LD document. Pure: no I/O, no
 * process state, so a test can hand it a five-card fixture. Returns nodes,
 * edges (reciprocal relatedTo pairs marked, not dropped), components,
 * isolated ids, and the dropped-reference counts.
 */
export function topology(raw) {
const graph = raw['@graph'] || [];
const cards = graph.filter((n) => Array.isArray(n['@type']) ? n['@type'].includes('CreativeWork') : n['@type'] === 'CreativeWork')
  .filter((n) => Number.isInteger(n.identifier) && n.column);
const byId = new Map(cards.map((c) => [c.identifier, c]));

// relationship targets are stored as the card's @id (a UUID) — map to shortId.
// Legacy string ids ("card-xxxxxxxx") have no resolver in this file: counted
// separately as legacyUnresolved rather than silently dropped (#723-class).
const uuidToShort = new Map(cards.map((c) => [c['@id'], c.identifier]).filter(([k]) => k));

// ---- nodes & edges ---------------------------------------------------------
const nodes = cards.map((c) => ({
  id: c.identifier,
  title: trunc(c.name),
  column: c.column,
}));
const edges = [];
let skippedUnresolvable = 0;
let legacyUnresolved = 0;
for (const c of cards) {
  for (const type of REL_TYPES) {
    const targets = c[type];
    if (!Array.isArray(targets)) continue;
    for (const t of targets) {
      const short = typeof t === 'string' && /^[0-9a-f]{8}-/i.test(t) ? uuidToShort.get(t) : null;
      if (short == null) {
        if (typeof t === 'string' && t.startsWith('card-')) legacyUnresolved++;
        else skippedUnresolvable++;
        continue;
      }
      if (short === c.identifier) continue; // self-edge
      edges.push({ source: c.identifier, target: short, type });
    }
  }
}
// reciprocal relatedTo pairs appear twice (server writes both ends); mark dupes
const seenPair = new Set();
for (const e of edges) {
  if (e.type !== 'relatedTo') continue;
  const key = [e.source, e.target].sort((a, b) => a - b).join('~');
  if (seenPair.has(key)) e.reciprocalDupe = true;
  else seenPair.add(key);
}

// ---- connectivity (union-find, undirected view) ----------------------------
const parent = new Map(nodes.map((n) => [n.id, n.id]));
const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
for (const e of edges) union(e.source, e.target);
const compMembers = new Map();
for (const n of nodes) {
  const r = find(n.id);
  if (!compMembers.has(r)) compMembers.set(r, []);
  compMembers.get(r).push(n.id);
}
const components = [...compMembers.values()].sort((a, b) => b.length - a.length);
const isolated = nodes.filter((n) => compMembers.get(find(n.id)).length === 1).map((n) => n.id);

// ---- stats -----------------------------------------------------------------
const edgeByType = {};
for (const e of edges) edgeByType[e.type] = (edgeByType[e.type] || 0) + 1;
return { nodes, edges, components, isolated, edgeByType, skippedUnresolvable, legacyUnresolved };
}

export function summaryLines(t, source) {
  return [
    `source            ${source}`,
    `cards             ${t.nodes.length}`,
    `edges             ${t.edges.length} (${Object.entries(t.edgeByType).map(([k, v]) => `${k}:${v}`).join(' · ')})`,
    `dangling refs     ${t.skippedUnresolvable} (unresolvable target — dropped)`,
    `legacy ids        ${t.legacyUnresolved} ("card-*" format, no resolver in this export — dropped)`,
    `components        ${t.components.length}`,
    `largest component ${t.components[0]?.length ?? 0} cards`,
    `isolated vertices ${t.isolated.length}${t.isolated.length ? ': ' + t.isolated.slice(0, 20).join(', ') + (t.isolated.length > 20 ? ' …' : '') : ''}`,
  ];
}

// ---- Graphviz --------------------------------------------------------------
export function toDot({ nodes, edges, isolated }, source) {
  const lines = [
    '// generated by tools/export-graph-topology.mjs — READ-ONLY export',
    `// source: ${source}`,
    'digraph board {',
    '  layout=neato; overlap=false; splines=true;',
  ];
  for (const n of nodes) {
    const iso = isolated.includes(n.id);
    const color = iso ? '#eeeeee' : (COLUMN_COLORS[n.column] || '#ffffff');
    const font = iso ? '#999999' : '#000000';
    lines.push(`  "${n.id}" [label="${n.id} ${trunc(n.title, 40)}", fillcolor="${color}", style=filled, fontcolor="${font}"${iso ? ', tooltip="ISOLATED"' : ''}];`);
  }
  for (const e of edges) {
    if (e.reciprocalDupe) continue; // one line per relatedTo pair
    const style = e.type === 'blockedBy' ? 'color=red'
      : e.type === 'supersedes' || e.type === 'supersededBy' ? 'color=purple'
      : e.type === 'derivedFrom' ? 'color=orange' : '';
    lines.push(`  "${e.source}" -> "${e.target}" [label="${e.type}"${style ? ', ' + style : ''}, fontsize=9];`);
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}

// ---- Cytoscape JSON --------------------------------------------------------
export function toCytoscape({ nodes, edges, isolated }, source, drawnAt = new Date().toISOString()) {
  return {
    data: { name: 'board-topology', drawnAt, source },
    elements: [
      ...nodes.map((n) => ({ data: { id: String(n.id), label: `${n.id} ${n.title}`, column: n.column, isolated: isolated.includes(n.id) } })),
      ...edges.map((e, i) => ({ data: { id: `e${i}`, source: String(e.source), target: String(e.target), type: e.type, reciprocalDupe: !!e.reciprocalDupe } })),
    ],
  };
}

// ---- CLI -------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const arg = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
  const DATA = arg('--data', process.env.SCRUM_BOARD_FILE || null);
  if (!DATA) {
    console.error('export-graph-topology: name the board file — --data <board-data.json> (or SCRUM_BOARD_FILE). There is no default on purpose (#1357).');
    process.exit(2);
  }
  const OUT = arg('--out', './graph-topology');
  const FORMAT = arg('--format', 'both');
  const t = topology(JSON.parse(fs.readFileSync(DATA, 'utf8')));
  for (const l of summaryLines(t, DATA)) console.log(l);
  if (FORMAT === 'dot' || FORMAT === 'both') { fs.writeFileSync(OUT + '.dot', toDot(t, DATA)); console.log(`wrote ${OUT}.dot`); }
  if (FORMAT === 'cyto' || FORMAT === 'both') { fs.writeFileSync(OUT + '.cytoscape.json', JSON.stringify(toCytoscape(t, DATA))); console.log(`wrote ${OUT}.cytoscape.json`); }
}
