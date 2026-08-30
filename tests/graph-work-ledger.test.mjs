/**
 * #1112 item 3 (#645/#1078/#755, #902 item 5) — the WORK LEDGER becomes typed
 * nodes. "schema:Action is ZERO" was #902's own litmus for 'coordination is
 * structured, not prose': bids, grants, refusals and settlements lived in a
 * JSONL file only the MCP process could read, and §I's load-bearing claim —
 * the "no" must be RECORDABLE — was met by the ledger and invisible to every
 * query. Vocabulary per Decision 3956b66b (schema:Action + scrum:WorkObject).
 *
 * Shapes are copied from the PRODUCTION ledger of 2026-08-30 (53 rows), not
 * invented — including the two that would corrupt a naive projection: a
 * settlement whose actor is "protocol" (not a person), and a row whose
 * `required` field carries PROSE (a whole build description).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphStore, queryGraph, projectWorkLedger, vocabularyDrift } from '../core/graph-replica.mjs';

const store = () => buildGraphStore({ '@graph': [] });
const rows = (s, q) => queryGraph(s, q, { limit: 100 }).rows || [];

const ROW = (over = {}) => ({
  id: 'w-1', seq: 0, transition: { type: 'declare', by: 'ada', at: '2026-08-10T12:00:00.000Z' },
  replyBy: '2026-08-10T12:10:00.000Z', required: ['ada', 'bo'], declaredBy: 'ada', sourceMessageId: null, card: 42, ...over,
});

test('#1112-3 a declare and a NOBID project as schema:Action — the "no" is a record, not a sentence', () => {
  const s = store();
  projectWorkLedger(s, [
    ROW(),
    ROW({ seq: 1, transition: { type: 'nobid', by: 'bo', at: '2026-08-10T12:05:00.000Z' } }),
  ]);
  const r = rows(s, `SELECT ?a ?type ?who ?at WHERE {
    ?a a schema:Action ; scrum:transitionType ?type ; schema:agent ?who ; schema:dateCreated ?at } ORDER BY ?at`);
  assert.equal(r.length, 2);
  assert.deepEqual([String(r[0].type), String(r[1].type)], ['declare', 'nobid']);
  assert.equal(String(r[1].who), 'person:bo', 'the seat that said NO is an edge, not prose');
  // and both hang off ONE work object that knows its card
  const w = rows(s, `SELECT ?w ?id ?sid WHERE { ?w a scrum:WorkObject ; schema:identifier ?id ; scrum:shortId ?sid }`);
  assert.equal(w.length, 1);
  assert.equal(String(w[0].id), 'w-1');
  assert.equal(String(w[0].sid), '42', 'joinable to the card by shortId, like activities');
  const linked = rows(s, `SELECT ?a WHERE { ?a a schema:Action ; scrum:ofWork ?w . ?w schema:identifier "w-1" }`);
  assert.equal(linked.length, 2, 'every transition points at its work object');
});

test('#1112-3 a GRANT carries who it went to; a SETTLEMENT by "protocol" mints NO person and keeps its reason', () => {
  const s = store();
  projectWorkLedger(s, [
    ROW({ seq: 2, transition: { type: 'grant', by: 'ada', to: 'bo', at: '2026-08-10T12:06:00.000Z' } }),
    ROW({ id: 'w-2', seq: 4, transition: { type: 'settlement', to: 'ada', actor: 'protocol', closureReason: 'early-close', pendingAtClosure: [], effectiveAt: '2026-08-15T23:34:46.953Z', at: '2026-08-15T23:35:56.453Z' } }),
  ]);
  const g = rows(s, `SELECT ?to WHERE { ?a scrum:transitionType "grant" ; scrum:to ?to }`);
  assert.equal(String(g[0]?.to), 'person:bo');
  const st = rows(s, `SELECT ?to ?why ?eff WHERE { ?a scrum:transitionType "settlement" ; scrum:to ?to ; scrum:closureReason ?why ; scrum:effectiveAt ?eff }`);
  assert.equal(String(st[0]?.to), 'person:ada');
  assert.equal(String(st[0]?.why), 'early-close');
  const fake = rows(s, `SELECT ?a WHERE { ?a schema:agent ?p . FILTER(STR(?p) = "person:protocol" || CONTAINS(STR(?p), "protocol")) }`);
  assert.equal(fake.length, 0, '"protocol" is a mechanism, not a seat — no person node');
});

test('#1112-3 PROSE in `required` projects as a literal, never a minted person — copied from the real build-816 row', () => {
  const s = store();
  projectWorkLedger(s, [ROW({ id: 'w-3', required: ['ada', 'Build #816: board_ready returns each ready card\'s typed coordination edges'] })]);
  const req = rows(s, `SELECT ?p WHERE { ?w a scrum:WorkObject ; schema:identifier "w-3" ; scrum:required ?p }`);
  assert.deepEqual(req.map((r) => String(r.p)), ['person:ada'], 'only the parseable seat becomes an edge');
  const raw = rows(s, `SELECT ?r WHERE { ?w schema:identifier "w-3" ; scrum:requiredRaw ?r }`);
  assert.equal(raw.length, 1, 'the prose is KEPT as a literal — dropped silently would be the day\'s own sin');
  assert.match(String(raw[0].r), /Build #816/);
});

test('#1112-3 idempotent by (id, seq): replaying the ledger adds nothing', () => {
  const s = store();
  const l = [ROW(), ROW({ seq: 1, transition: { type: 'bid', by: 'bo', at: '2026-08-10T12:01:00.000Z' } })];
  projectWorkLedger(s, l);
  const size = s.size;
  projectWorkLedger(s, l);
  assert.equal(s.size, size);
});

test('#1112-3 every emitted term is DECLARED — the #1104 drift guard stays green', () => {
  const s = store();
  projectWorkLedger(s, [ROW(), ROW({ id: 'w-2', seq: 4, transition: { type: 'settlement', to: 'ada', actor: 'protocol', closureReason: 'early-close', effectiveAt: 'x', at: '2026-08-15T23:35:56.453Z' } })]);
  const d = vocabularyDrift(s);
  assert.deepEqual(d.undeclared, [], JSON.stringify(d.undeclared));
});

// ── the reader the wiring actually calls — raw rows, not folded objects ──────
test('#1112-3 readWorkObjectRows returns one row per line with (id, seq), skipping junk', async () => {
  const { readWorkObjectRows } = await import('../core/work-store.mjs');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workstore-'));
  fs.writeFileSync(path.join(dir, 'work-objects.jsonl'), [
    JSON.stringify(ROW()),
    'not json at all',
    JSON.stringify(ROW({ seq: 1, transition: { type: 'bid', by: 'bo', at: '2026-08-10T12:01:00.000Z' } })),
    JSON.stringify({ no: 'transition' }),
  ].join('\n') + '\n');
  const rows2 = readWorkObjectRows(dir);
  assert.equal(rows2.length, 2, 'two real rows; junk skipped, not thrown on');
  assert.deepEqual(rows2.map((r) => r.seq), [0, 1]);
  assert.equal(readWorkObjectRows(fs.mkdtempSync(path.join(os.tmpdir(), 'workstore-empty-'))).length, 0, 'no file = empty, not a crash');
});

// ── WIRED, not just exported — #725's lesson: the projection existed for weeks
// with its own tests as the only callers. This one starts the real server with
// SCRUM_WORK_STORE set and asks the real /api/graph.
test('#1112-3 the REST server projects the ledger it is pointed at — schema:Action is reachable from /api/graph', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { startRestServer, makeBoardFixture } = await import('./helpers/harness.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workstore-wire-'));
  fs.writeFileSync(path.join(dir, 'work-objects.jsonl'),
    JSON.stringify(ROW()) + '\n' + JSON.stringify(ROW({ seq: 1, transition: { type: 'nobid', by: 'bo', at: '2026-08-10T12:05:00.000Z' } })) + '\n');
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }), env: { SCRUM_WORK_STORE: dir } });
  try {
    const r = await fetch(`${srv.baseUrl}/api/graph`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: 'ada', query: 'SELECT ?type ?who WHERE { ?a a schema:Action ; scrum:transitionType ?type ; schema:agent ?who } ORDER BY ?type' }),
    });
    const d = await r.json();
    assert.equal(r.status, 200, JSON.stringify(d).slice(0, 300));
    assert.equal(d.rows.length, 2, `the ledger reached the query surface: ${JSON.stringify(d.rows)}`);
    assert.deepEqual(d.rows.map((x) => String(x.type)), ['declare', 'nobid']);
  } finally { await srv.stop(); }
});
