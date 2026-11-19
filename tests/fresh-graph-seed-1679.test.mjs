/**
 * #1679 — a FRESH graph-backed board starts: a newly created dataset, served with every unit flag on, seeds the default columns
 * instead of refusing. An EXISTING dataset that has lost its columns still refuses, as before.
 *
 * WHAT TELLS "new" FROM "lost" (accepted on the card, 55430): "new" is an operator's choice made one step earlier, at the
 * executor's `--create`. A store with no dataset marker never serves (F0), so the server cannot reach an empty dataset by a typo'd
 * path or an unmounted volume. The server then seeds ONLY when the dataset holds nothing at all outside the executor's bookkeeping
 * graph: a store that lost its columns still holds its cards (F3a); an interrupted import still holds what it imported (F3b).
 * Measured before the build: a `--create`d store holds 6 bookkeeping quads and nothing else, and a unit-on REST writes nothing
 * before the columns check.
 *
 *   F0  FALSIFIER (the card's first row): an empty store started WITHOUT --create never serves, plain, with --promote-epoch, or
 *       with --adopt-home; none of them writes a dataset marker, so none can hand the server an "empty" dataset.
 *   F1  THE FIX: a --create'd dataset + REST with every unit on starts; the columns are Backlog, In Progress, Done in that order;
 *       a card is created and lands in Backlog; the graph holds exactly three scrum:Column nodes.
 *   F2  NO SECOND SEED: the same dataset restarted serves the same three columns, still exactly three nodes; a column renamed
 *       before the restart keeps its name (a restart never re-seeds over the operator's board).
 *   F3a LOST COLUMNS STILL REFUSE: a seeded board with a card whose column nodes are then deleted refuses to serve, naming #1639.
 *   F3b ANY DATA STILL REFUSES: a --create'd dataset holding one stray triple and no columns or cards (an interrupted import)
 *       refuses to serve; it is not seeded.
 *
 * Without a python with pyoxigraph every row is SKIPPED, and a skip is NOT a pass (GRAPH_EXECUTOR_PYTHON names one).
 * NOT COVERED, by name: the CARDS unit off with cards in the document (the columns unit's own precondition, unchanged here);
 * concurrent first boots of two servers on one fresh dataset.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HAVE_PY, tmpStore, startExecutor, spawnExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { startRestServer } from './helpers/harness.mjs';
import { BOOKKEEPING_GRAPH } from '../core/graph-vocab.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const T = { skip: SKIP, timeout: 180000 };
const UNITS = { SCRUM_GRAPH_UNIT_CARDS: '1', SCRUM_GRAPH_UNIT_COLUMNS: '1', SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_LOGBORN: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1', SCRUM_GRAPH_UNIT_DELIVERIES: '1' };
const ROSTER = path.join(os.tmpdir(), `f1679-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
process.once('exit', () => { try { fs.rmSync(ROSTER, { force: true }); } catch { /* best effort */ } });

const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(40000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const sparql = async (x, q) => (await (await fetch(`${x.baseUrl}/query`, { method: 'POST', body: q })).json());
let opN = 0;
const rawUpdate = async (x, u) => {
  const r = await fetch(`${x.baseUrl}/update`, { method: 'POST', body: u, headers: { 'x-op-id': `urn:ex:op/f1679-${process.pid}-${opN++}` } });
  assert.equal(r.status, 200, `raw update refused: ${await r.text()}`);
};
const columnNodes = async (x) => {
  const j = await sparql(x, 'SELECT ?id ?name ?order WHERE { ?c a <https://scrumboard.local/ns#Column> ; <https://schema.org/identifier> ?id ; <https://schema.org/name> ?name ; <https://scrumboard.local/ns#order> ?order } ORDER BY ?order');
  return j.results.bindings.map((b) => [b.id.value, b.name.value, Number(b.order.value)]);
};
const DEFAULTS = [['backlog', 'Backlog', 0], ['in-progress', 'In Progress', 1], ['done', 'Done', 2]];

/** a fresh dataset as an operator makes one: an empty store, started with --create */
async function freshDataset(t, tag) {
  const store = tmpStore(`f1679-${tag}-`);
  const ds = `f1679-${tag}-${process.pid}`;
  const x = await startExecutor({ store, datasetId: ds, create: true });
  t.after(async () => { await killExecutor(x); fs.rmSync(store, { recursive: true, force: true }); });
  return { x, ds, store };
}
/** a REST with every unit on, over that dataset; a refused start resolves { refused: <its output> } */
async function rest({ x, ds }, boardFile) {
  try {
    const r = await startRestServer({ ...(boardFile ? { boardFile } : { board: { columns: [], cards: [] } }), env: { SCRUM_GRAPH_DATASET_ID: ds, SCRUM_GRAPH_EXECUTOR_URL: x.baseUrl, SCRUM_ROSTER_FILE: ROSTER, ...UNITS } });
    return { r, base: r.baseUrl ?? `http://127.0.0.1:${r.port}` };
  } catch (e) { return { refused: String(e?.message ?? e) }; }
}

test('#1679 F0 an empty store started without --create never serves (plain, --promote-epoch, --adopt-home): nothing hands the server an empty dataset', T, async () => {
  for (const extra of [[], ['--promote-epoch'], ['--adopt-home']]) {
    const store = tmpStore('f1679-f0-');
    try {
      const err = await spawnExecutor(['--store', store, '--port', '0', '--dataset-id', 'f1679-f0', ...extra]).then((x) => { killExecutor(x); return null; }, (e) => e);
      assert.ok(err, `an empty store served with ${JSON.stringify(extra)}`);
      assert.match(err.message, /REFUSED/, `not a refusal with ${JSON.stringify(extra)}: ${err.message.slice(0, 300)}`);
    } finally { fs.rmSync(store, { recursive: true, force: true }); }
  }
});

test('#1679 F1 a --create\'d dataset with every unit on starts, serves Backlog / In Progress / Done, and takes a card into Backlog', T, async (t) => {
  const d = await freshDataset(t, 'f1');
  const s = await rest(d);
  assert.ok(!s.refused, `refused to serve a fresh dataset: ${(s.refused || '').slice(0, 400)}`);
  t.after(() => s.r.stop());
  const cols = await api(s.base, 'GET', '/api/columns');
  assert.equal(cols.status, 200, cols.text.slice(0, 300));
  assert.deepEqual(cols.body.map((c) => [c.id, c.name, c.order]), DEFAULTS);
  const card = await api(s.base, 'POST', '/api/cards', { title: 'first card on a fresh board', createdBy: 'ada' });
  assert.equal(card.status, 201, card.text.slice(0, 300));
  assert.equal(card.body.column, 'backlog');
  assert.deepEqual(await columnNodes(d.x), DEFAULTS, 'the graph does not hold exactly the three default column nodes');
});

test('#1679 F2 a restart never seeds again: still exactly three column nodes, and a renamed column keeps its name', T, async (t) => {
  const d = await freshDataset(t, 'f2');
  const s1 = await rest(d);
  assert.ok(!s1.refused, (s1.refused || '').slice(0, 400));
  const ren = await api(s1.base, 'PATCH', '/api/columns/in-progress', { name: 'Doing' });
  assert.equal(ren.status, 200, ren.text.slice(0, 300));
  const boardFile = s1.r.boardFile;
  const bytes = boardFile && fs.existsSync(boardFile) ? fs.readFileSync(boardFile) : null;
  await s1.r.stop();
  if (bytes) fs.writeFileSync(boardFile, bytes);
  const s2 = await rest(d, bytes ? boardFile : undefined);
  assert.ok(!s2.refused, `the restart refused: ${(s2.refused || '').slice(0, 400)}`);
  t.after(() => s2.r.stop());
  const want = [['backlog', 'Backlog', 0], ['in-progress', 'Doing', 1], ['done', 'Done', 2]];
  assert.deepEqual(await columnNodes(d.x), want, 'the restart re-seeded or lost the rename');
  const cols = await api(s2.base, 'GET', '/api/columns');
  assert.deepEqual(cols.body.map((c) => [c.id, c.name, c.order]), want);
});

test('#1679 F3a a dataset that LOST its columns but holds a card still refuses to serve, naming #1639', T, async (t) => {
  const d = await freshDataset(t, 'f3a');
  const s1 = await rest(d);
  assert.ok(!s1.refused, (s1.refused || '').slice(0, 400));
  const card = await api(s1.base, 'POST', '/api/cards', { title: 'a card that outlives its columns', createdBy: 'ada' });
  assert.equal(card.status, 201, card.text.slice(0, 300));
  await s1.r.stop();
  await rawUpdate(d.x, 'DELETE WHERE { ?c a <https://scrumboard.local/ns#Column> ; ?p ?o }');
  assert.deepEqual(await columnNodes(d.x), [], 'the setup did not remove the columns');
  const s2 = await rest(d);
  if (!s2.refused) { await s2.r.stop(); assert.fail('a dataset with a card and no columns was served (it was re-seeded)'); }
  assert.match(s2.refused, /#1639 columns unit: the graph holds no columns/);
  assert.deepEqual(await columnNodes(d.x), [], 'the refused start wrote columns anyway');
});

test('#1679 F3c an UNMIGRATED board (an empty --create\'d graph under a document that holds cards and a non-default column) still refuses: its columns are migrated, never replaced by defaults', T, async (t) => {
  const d = await freshDataset(t, 'f3c');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1679-f3c-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const boardFile = path.join(dir, 'board.json');
  fs.writeFileSync(boardFile, JSON.stringify({ columns: [...DEFAULTS.map(([id, name, order]) => ({ id, name, order })), { id: 'planned', name: 'Planned', order: 3 }], cards: [{ id: 'c-1', shortId: 1, title: 'a card the document still holds', column: 'planned' }] }, null, 2));
  const s = await rest(d, boardFile);
  if (!s.refused) { await s.r.stop(); assert.fail('an unmigrated board was seeded with defaults'); }
  assert.match(s.refused, /#1639 columns unit: the graph holds no columns/);
  assert.deepEqual(await columnNodes(d.x), [], 'the refused start wrote columns anyway');
});

test('#1679 F3b a --create\'d dataset holding any data outside bookkeeping (no columns, no cards) still refuses: an interrupted import is not a new board', T, async (t) => {
  const d = await freshDataset(t, 'f3b');
  await rawUpdate(d.x, 'INSERT DATA { <urn:ex:f1679/stray> <urn:ex:f1679/p> "imported before the columns" }');
  const s = await rest(d);
  if (!s.refused) { await s.r.stop(); assert.fail('a dataset holding data was seeded as a new board'); }
  assert.match(s.refused, /#1639 columns unit: the graph holds no columns/);
  assert.deepEqual(await columnNodes(d.x), []);
  const bk = await sparql(d.x, `ASK { GRAPH <${BOOKKEEPING_GRAPH}> { ?s ?p ?o } }`);
  assert.equal(bk.boolean, true, 'control: the bookkeeping graph is readable on this query path');
});
