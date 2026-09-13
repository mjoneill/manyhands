/**
 * #1357 — the card-graph export, on a fixture, with no file it did not write.
 *
 * Five cards: a reciprocal relatedTo pair (the server writes both ends — one
 * edge in the .dot, the duplicate MARKED not dropped), a blockedBy edge, an
 * isolated card, a dangling UUID and a legacy `card-*` id (each COUNTED, so a
 * reader can tell "no edges" from "edges the export could not resolve").
 *
 * And the refusal: with no --data and no env, the CLI exits 2 and reads
 * nothing. There is no production default any more, and this is the test
 * that keeps it gone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { topology, summaryLines, toDot, toCytoscape } from '../tools/export-graph-topology.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = (n) => `0000000${n}-0000-4000-8000-000000000000`.slice(-36);
const card = (n, over = {}) => ({ '@id': id(n), '@type': 'CreativeWork', identifier: n, name: `Card ${n}`, column: 'backlog', ...over });
const FIXTURE = { '@graph': [
  card(1, { relatedTo: [id(2)] }),
  card(2, { relatedTo: [id(1)], blockedBy: [id(3)] }),          // reciprocal pair + a blocker
  card(3, { relatedTo: ['deadbeef-0000-4000-8000-000000000000'] }), // dangling UUID
  card(4, { derivedFrom: ['card-legacy01'] }),                     // legacy id
  card(5),                                                         // isolated
  { '@id': 'x', '@type': 'Person', name: 'not a card' },
  card(6, { column: null }),                                       // no column ⇒ not on the board ⇒ excluded
] };

test('#1357 topology — counts, dedupe, isolation, and the two dropped-reference counters', () => {
  const t = topology(FIXTURE);
  assert.deepEqual(t.nodes.map((n) => n.id), [1, 2, 3, 4, 5], 'cards with an integer id AND a column');
  assert.equal(t.edges.length, 3, 'relatedTo ×2 (both ends) + blockedBy');
  assert.deepEqual(t.edgeByType, { relatedTo: 2, blockedBy: 1 });
  assert.equal(t.edges.filter((e) => e.reciprocalDupe).length, 1, 'the second end of the pair is MARKED');
  assert.equal(t.skippedUnresolvable, 1, 'the dangling UUID is counted');
  assert.equal(t.legacyUnresolved, 1, 'the legacy id is counted separately');
  assert.deepEqual([...t.isolated].sort(), [4, 5], 'cards whose only refs were dropped are isolated; 3 is joined to 2 by the blocker');
  assert.equal(t.components.length, 3, '{1,2,3} · {4} · {5}');
  assert.equal(t.components[0].length, 3);
});

test('#1357 renderers — one .dot line per relatedTo pair, isolated greyed; cytoscape carries the dupe flag; summary is eight lines', () => {
  const t = topology(FIXTURE);
  const dot = toDot(t, 'fixture');
  assert.equal((dot.match(/-> /g) || []).length, 2, 'two arrows: one relatedTo pair, one blockedBy');
  assert.match(dot, /"5" \[label="5 Card 5", fillcolor="#eeeeee"/);
  assert.match(dot, /"2" -> "3" \[label="blockedBy", color=red/);
  const cy = toCytoscape(t, 'fixture', '2026-09-13T00:00:00.000Z');
  assert.equal(cy.elements.filter((e) => e.data.type).length, 3, 'cytoscape keeps every edge');
  assert.equal(cy.elements.filter((e) => e.data.reciprocalDupe === true).length, 1);
  assert.equal(cy.elements.find((e) => e.data.id === '5').data.isolated, true);
  const lines = summaryLines(t, 'fixture');
  assert.equal(lines.length, 8);
  assert.match(lines[4], /legacy ids {8}1/);
});

test('#1357 CLI — no --data and no SCRUM_BOARD_FILE ⇒ exit 2, nothing read, nothing written', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/export-graph-topology.mjs'), '--out', '/nonexistent/should-not-write'], {
    env: { PATH: process.env.PATH },   // no SCRUM_BOARD_FILE, no HOME to fall back to
    encoding: 'utf8',
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /name the board file/);
  assert.equal(r.stdout, '');
});
