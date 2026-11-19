/**
 * #1981 — SCRUM_BOARD_DOCUMENT=off on a BRAND-NEW dataset starts, instead of refusing until the card reference index (#1744) is
 * backfilled by hand. Measured in #1977 item 2 (2026-11-19): a --create'd dataset, prod's unit flags, document off, refused with
 * "the card reference index failed its full verification (the completion marker reads [])".
 *
 * The index is a GATE (#1744 finding 6), so the fix keeps every refusal that guards real data: the server writes the completion
 * marker ONLY when the marker is ABSENT and the dataset holds NOTHING outside bookkeeping (#1679's own test of "new"), in one
 * update guarded on both; then the unchanged FULL verification still runs and must say EXACT. An empty index over zero cards is
 * trivially exact, which is what the backfill script itself writes for "a fresh empty board" (F3).
 *
 *   D1  THE FIX: a --create'd dataset, every unit on, document off, starts; columns are seeded; a card is created; the marker
 *       reads exactly one true; a restart serves the same board.
 *   D2  REAL DATA STILL REFUSES: a dataset that holds a card (made with the document on, where the index is not enforced) and no
 *       marker, restarted with the document off, refuses naming #1744. It is not marked.
 *   D3  A LATCHED MARKER IS NEVER RE-OPENED: an empty dataset whose marker reads false refuses naming #1744, and still reads false.
 *
 * Without a python with pyoxigraph every row is SKIPPED, and a skip is NOT a pass.
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
const ROSTER = path.join(os.tmpdir(), `d1981-roster-${process.pid}.json`);
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
  const r = await fetch(`${x.baseUrl}/update`, { method: 'POST', body: u, headers: { 'x-op-id': `urn:ex:op/d1981-${process.pid}-${opN++}` } });
  assert.equal(r.status, 200, `raw update refused: ${await r.text()}`);
};
const columnNodes = async (x) => {
  const j = await sparql(x, 'SELECT ?id ?name ?order WHERE { ?c a <https://scrumboard.local/ns#Column> ; <https://schema.org/identifier> ?id ; <https://schema.org/name> ?name ; <https://scrumboard.local/ns#order> ?order } ORDER BY ?order');
  return j.results.bindings.map((b) => [b.id.value, b.name.value, Number(b.order.value)]);
};
const DEFAULTS = [['backlog', 'Backlog', 0], ['in-progress', 'In Progress', 1], ['done', 'Done', 2]];

/** a fresh dataset as an operator makes one: an empty store, started with --create */
async function freshDataset(t, tag) {
  const store = tmpStore(`d1981-${tag}-`);
  const ds = `d1981-${tag}-${process.pid}`;
  const x = await startExecutor({ store, datasetId: ds, create: true });
  t.after(async () => { await killExecutor(x); fs.rmSync(store, { recursive: true, force: true }); });
  return { x, ds, store };
}
/** a REST with every unit on, over that dataset; a refused start resolves { refused: <its output> } */
async function rest({ x, ds }, boardFile, extraEnv = {}) {
  try {
    const r = await startRestServer({ ...(boardFile ? { boardFile } : { board: { columns: [], cards: [] } }), env: { SCRUM_GRAPH_DATASET_ID: ds, SCRUM_GRAPH_EXECUTOR_URL: x.baseUrl, SCRUM_ROSTER_FILE: ROSTER, ...UNITS, ...extraEnv } });
    return { r, base: r.baseUrl ?? `http://127.0.0.1:${r.port}` };
  } catch (e) { return { refused: String(e?.message ?? e) }; }
}


const OFF = { SCRUM_BOARD_DOCUMENT: 'off', SCRUM_GRAPH_QUERY_SOURCE: 'executor', SCRUM_GRAPH_READY_SOURCE: 'executor', SCRUM_GRAPH_CHECKS_SOURCE: 'executor', SCRUM_GRAPH_NEIGHBORS_SOURCE: 'executor' };   // #1563: off needs every source on the executor
const MARKER_Q = 'SELECT ?v WHERE { GRAPH <' + BOOKKEEPING_GRAPH + '> { <urn:ex:card-ref-index/coverage> <urn:ex:card-ref-index/complete> ?v } }';
const marker = async (x) => (await sparql(x, MARKER_Q)).results.bindings.map((b) => b.v.value);

test('#1981 D1 a --create\'d dataset with the document off starts, seeds its columns, takes a card, and marks its empty index complete', T, async (t) => {
  const d = await freshDataset(t, 'd1');
  const a = await rest(d, null, OFF);
  assert.ok(!a.refused, `a new dataset with the document off refused to start: ${a.refused?.slice(0, 600)}`);
  try {
    const cols = await api(a.base, 'GET', '/api/columns');
    assert.equal(cols.status, 200); assert.deepEqual(cols.body.map((c) => c.id), ['backlog', 'in-progress', 'done']);
    const c = await api(a.base, 'POST', '/api/cards', { title: 'first card', column: 'backlog', createdBy: 'ada' });
    assert.ok([200, 201].includes(c.status), `the first card was refused: ${c.status} ${c.text.slice(0, 300)}`);
    assert.deepEqual(await marker(d.x), ['true'], 'the empty index is marked complete, exactly once');
  } finally { await a.r.stop(); }
  const b = await rest(d, null, OFF);
  assert.ok(!b.refused, `the same dataset refused on restart: ${b.refused?.slice(0, 600)}`);
  try {
    const cards = await api(b.base, 'GET', '/api/cards');
    assert.deepEqual(cards.body.map((c) => c.title), ['first card'], 'the restart serves the same board');
  } finally { await b.r.stop(); }
});

test('#1981 D2 a dataset holding a card and no marker still refuses with the document off, naming #1744; it is not marked', T, async (t) => {
  const d = await freshDataset(t, 'd2');
  const a = await rest(d);   // the document on: the index is not enforced, so a card lands with no marker
  assert.ok(!a.refused, `setup: ${a.refused?.slice(0, 400)}`);
  try {
    const c = await api(a.base, 'POST', '/api/cards', { title: 'real data', column: 'backlog', createdBy: 'ada' });
    assert.ok([200, 201].includes(c.status), `setup card: ${c.status} ${c.text.slice(0, 200)}`);
  } finally { await a.r.stop(); }
  assert.deepEqual(await marker(d.x), [], 'CONTROL: the document-on board left no marker');
  const b = await rest(d, null, OFF);
  assert.ok(b.refused, 'a dataset holding a card and no index marker started with the document off');
  if (b.r) await b.r.stop();
  assert.match(b.refused, /#1744/, 'and the refusal names #1744');
  assert.deepEqual(await marker(d.x), [], 'and nothing marked it complete');
});

test('#1981 D3 a latched (false) marker on an empty dataset is never re-opened: it refuses naming #1744 and still reads false', T, async (t) => {
  const d = await freshDataset(t, 'd3');
  await rawUpdate(d.x, 'INSERT DATA { GRAPH <' + BOOKKEEPING_GRAPH + '> { <urn:ex:card-ref-index/coverage> <urn:ex:card-ref-index/complete> "false"^^<http://www.w3.org/2001/XMLSchema#boolean> } }');
  const b = await rest(d, null, OFF);
  assert.ok(b.refused, 'an empty dataset with a latched marker started');
  if (b.r) await b.r.stop();
  assert.match(b.refused, /#1744/);
  assert.deepEqual(await marker(d.x), ['false'], 'the latch is untouched');
});
