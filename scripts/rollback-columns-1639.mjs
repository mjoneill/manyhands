#!/usr/bin/env node
/**
 * #1639 — ROLLBACK of the columns unit: make the board document serve, with SCRUM_GRAPH_UNIT_COLUMNS off, the columns the
 * unit served.
 *
 *   node scripts/rollback-columns-1639.mjs --board-file <board.json> --executor-url <url> --dataset-id <id> [--dry-run]
 *
 * Operates on a STOPPED board's file (its REST server is down). With the unit on, column writes go to the graph only and the
 * document keeps its frozen copy, so simply turning the flag off would hide every column created since the flip (while the
 * cards that sit in it still name it), undo every rename and bring back every deleted column. This script reconciles by id,
 * with the graph as the authority, modelled on scripts/rollback-posts-1574.mjs:
 *
 *   a graph column the document lacks           → written into the document
 *   a graph column the document holds, differing → the document's copy is replaced by the graph's
 *   a document column the graph does not hold   → removed (the migration copied every document column into the graph, so
 *                                                  absence from the graph means the unit deleted it)
 *
 * Every graph read happens before anything is written; a failed read, the wrong dataset, or a graph holding NO columns (the
 * migration never ran: nothing to roll back FROM) exits 2 with the file untouched. Nothing to change → nothing is written,
 * so a second run leaves the file byte-identical. --dry-run reports what would change and writes nothing.
 *
 * Summary: the LAST stdout line, one JSON object {graphColumns, documentColumns, written, rewritten, removed, unchanged,
 * changed, dryRun}. Exit: 0 done · 2 refused (nothing written).
 */
import { boardFileProblem } from '../core/board-file-guard.mjs';
import { loadDomain, saveDomain } from '../core/store.mjs';
import { boardToDomain, domainToBoard } from '../core/mapping.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { createColumnsUnit } from '../core/columns-unit.mjs';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const FILE = opt('--board-file');
const URL_ = opt('--executor-url');
const DATASET = opt('--dataset-id');
const DRY = args.includes('--dry-run');

const summary = { graphColumns: 0, documentColumns: 0, written: 0, rewritten: 0, removed: 0, unchanged: 0, changed: false, dryRun: DRY };
const finish = (code, message) => {
  if (message) console.error(message);
  console.log(JSON.stringify(summary));
  process.exit(code);
};
if (!FILE || !URL_ || !DATASET) finish(2, 'usage: node scripts/rollback-columns-1639.mjs --board-file <board.json> --executor-url <url> --dataset-id <id> [--dry-run]');

// a missing, empty or non-board file is REFUSED, never read as an empty board
const fileProblem = boardFileProblem(FILE);
if (fileProblem) finish(2, fileProblem);

let board;
try { board = domainToBoard(loadDomain(FILE)); } catch (e) { finish(2, `cannot read ${FILE}: ${e.message}`); }
const docColumns = Array.isArray(board.columns) ? board.columns : [];
summary.documentColumns = docColumns.length;

// ── every graph read, before anything is decided ──
const client = createGraphClient({ baseUrl: URL_, expectedDatasetId: DATASET, timeoutMs: 60000 });
const ident = await client.datasetIdentity();   // a query alone does not check WHICH dataset answered
if (!ident.ok) finish(2, `executor not usable (${ident.reason}); nothing was written`);
const unit = createColumnsUnit({ client, mintId: () => 'unused' });
let graphColumns;
try { await unit.load(); graphColumns = unit.snapshot(); } catch (e) { finish(2, `cannot read the graph's columns (${e.message}); nothing was written`); }
summary.graphColumns = graphColumns.length;
if (!graphColumns.length) finish(2, 'the graph holds no columns (was the migration ever applied?): nothing to roll back from; nothing was written');

/** One comparable form of a column: keys sorted, so the same content compares equal whatever order its keys were written in. */
const canonical = (c) => JSON.stringify(Object.keys(c).sort().map((k) => [k, c[k]]));

// ── reconcile by id ──
const graphById = new Map(graphColumns.map((c) => [c.id, c]));
const docById = new Map(docColumns.filter((c) => c && typeof c.id === 'string').map((c) => [c.id, c]));
for (const [id, g] of graphById) {
  const d = docById.get(id);
  if (!d) summary.written++;
  else if (canonical(d) === canonical(g)) summary.unchanged++;
  else summary.rewritten++;
}
for (const id of docById.keys()) if (!graphById.has(id)) summary.removed++;
summary.changed = summary.written + summary.rewritten + summary.removed > 0 || docById.size !== docColumns.length;

if (!summary.changed || DRY) finish(0);

// the graph's columns, in their stored order; a column the document already holds unchanged keeps its own object
board.columns = graphColumns.map((g) => { const d = docById.get(g.id); return d && canonical(d) === canonical(g) ? d : g; });
board.lastUpdated = new Date().toISOString();
saveDomain(FILE, boardToDomain(board), { now: board.lastUpdated });   // roster-less: the people nodes are preserved
finish(0);
