/**
 * #1645 slice 2a — GRAPH VOCABULARY AND PREDICATE SHAPES READ THE EXECUTOR. TEST AUTHOR's, written before the build (RED at 3b690b5).
 *
 * A DIFFERENTIAL against the replica, captured while it still exists: tests/fixtures-1645/golden-2a.json holds the REPLICA's answers at 3b690b5
 * on the whole-board fixture (tests/helpers/whole-board-1645.mjs). The executor build must give the same answers except for differences that are
 * LISTED here with a reason. Contract (card thread 43287 to 43306):
 *   GET /api/graph/vocabulary   every field vocabularyDrift returns, same names, structure and order; judged against the executor's OWN gate, the
 *                               union of GRAPH_VOCABULARY and EXECUTOR_ONLY_VOCABULARY (43306); rebuiltMs present and null; watermark replaced
 *                               by executorPosition "E:S"; source:"executor"
 *   GET /api/predicates?name=X&shapes=1   the same SHAPE_QUERY on the executor's PUBLIC dataset, the same output; `sample` is store-chosen, so it
 *                               must be a real object of its predicate, and shape, prefix, observed and means are compared exactly
 * INTENDED DIFFERENCES, each with its reason (measured on this fixture at 3b690b5: 0 triples only in the replica, 12 only in the executor):
 *   scrum:CardImport + scrum:sourceDigest   declared public migration provenance, one receipt per card (43300; whether it should stay public is #1705)
 *   scrum:postSeq                           each post's sequence number, a graph fact the replica never projected
 *   scrum:inCollection                      each column's collection membership, the same
 *
 *   V1  the drift body equals the golden one, judged against the union: emitted +4, declared + |EXECUTOR_ONLY_VOCABULARY|, undeclared [], and
 *       unused = the golden unused plus every executor-only term this fixture does not emit
 *   V2  the currency fields: rebuiltMs null, executorPosition the executor's own marker, source "executor", no watermark
 *   V3  named shapes for the predicates the replica answered: equal in everything but `sample`, and `sample` is a real object of the predicate
 *   V4  named shapes for the intended extras now answer (they were [] on the replica); a predicate neither store emits still answers []
 *   V5  NO REPLICA: on a fresh REST, both routes called, /api/health still says graph.boot null and graph.syncs 0 (the counter named in 43298).
 *       It needs #1645 slice 1 underneath: before slice 1, /api/health ITSELF kicks the replica build, so the probe would build what it counts
 *       (measured on a scratch implementation: red without slice 1's kick removal, green with it)
 *   V6  the PUBLIC dataset only: a predicate planted ONLY in the bookkeeping graph is in neither answer (CONTROL: the planted triple is there)
 *   V7  NO BOARD DOCUMENT: after boot, the vocabulary route and named and unnamed shapes lookups make ZERO board-document attempts, every attempt
 *       recorded (43340; the half of the 43287 pin that V5 had left out)
 *   V8  the unnamed shapes list still RETURNS the registry, read from the executor: a definition registered with the small-kinds unit on is
 *       in the list with its text, and the call makes zero board-document attempts (43343: [] must not pass by dropping the registry)
 *
 * NOT covered, by name: the unnamed /api/predicates list (the registry): this fixture has no predicate definitions, so that row waits on a
 * collections-bearing fixture; the 5000-row SHAPE_QUERY cap (this fixture is far under it, on purpose, 43289); the terms of kinds not in the
 * fixture (see the helper); that the rewrite IMPORTS the guard's union rather than copying it (a mutant's job, not a row's: a copy with the same
 * members is indistinguishable from outside).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HAVE_PY } from './helpers/graph-executor-proc.mjs';
import { wholeBoardWorld } from './helpers/whole-board-1645.mjs';
import { Q_POSITION } from '../core/logborn-unit.mjs';
import { GRAPH_VOCABULARY, EXECUTOR_ONLY_VOCABULARY } from '../core/graph-replica.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures-1645', 'golden-2a.json'), 'utf8'));
const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const BK = 'urn:scrum:bookkeeping:executor';
const EXTRA_TERMS = ['scrum:CardImport', 'scrum:sourceDigest', 'scrum:postSeq', 'scrum:inCollection'];
const EXTRA_PREDICATES = ['scrum:sourceDigest', 'scrum:postSeq', 'scrum:inCollection'];
// Terms DECLARED after the golden was taken (3b690b5) that this fixture does not emit, so they land in `unused`, each named with
// its card. A term added here is a reviewed vocabulary change; a term that appears in `unused` without being listed still fails V1.
const DECLARED_SINCE_GOLDEN = [
  'scrum:MoveFence', 'scrum:fencedMove', 'scrum:fencedAt',   // #1707 — the move fences
  'scrum:LabelAlias', 'scrum:aliasLabel', 'scrum:canonicalLabel',   // #1640 — label aliases as records
];
const PREFIX = { scrum: 'https://scrumboard.local/ns#', schema: 'https://schema.org/', entity: 'https://scrumboard.local/entity/', column: 'https://scrumboard.local/column/' };
const iri = (pfx) => { const [p, l] = pfx.split(':'); return PREFIX[p] ? `<${PREFIX[p]}${l}>` : null; };
const get = async (w, route) => { const r = await fetch(`${w.rest.baseUrl}${route}`, { signal: AbortSignal.timeout(30000) }); return { status: r.status, j: await r.json() }; };
const askExec = async (w, sparql) => { const r = await fetch(`${w.exec.baseUrl}/query?dataset=public`, { method: 'POST', body: sparql }); return /"boolean"\s*:\s*true/.test(await r.text()); };
const marker = async (w) => { const r = await fetch(`${w.exec.baseUrl}/query`, { method: 'POST', body: Q_POSITION }); const b = JSON.parse(await r.text()).results.bindings[0]; return `${b.e.value}:${b.seq.value}`; };
async function withWorld(body) { const w = await wholeBoardWorld(); try { return await body(w); } finally { await w.stop(); } }

/** Is `sample` a real object of `pred` in the executor's public dataset? An IRI sample is in prefixed form; a literal is its lexical form. */
async function sampleIsReal(w, pred, shape) {
  const p = iri(pred); assert.ok(p, `PRECONDITION: ${pred} expands`);
  if (shape.shape === 'iri') { const o = iri(shape.sample); assert.ok(o, `PRECONDITION: the sample ${shape.sample} expands`); return askExec(w, `ASK { ?s ${p} ${o} }`); }
  return askExec(w, `ASK { ?s ${p} ?o FILTER(STR(?o) = ${JSON.stringify(String(shape.sample))}) }`);
}

test('#1645 (V1) the vocabulary drift body equals the replica\'s, judged against the executor\'s own gate (the union)', { skip: SKIP, timeout: 240000 }, async () => {
  await withWorld(async (w) => {
    const { status, j } = await get(w, '/api/graph/vocabulary'); assert.equal(status, 200, JSON.stringify(j).slice(0, 300));
    const g = GOLDEN.drift;
    const union = new Set([...GRAPH_VOCABULARY, ...EXECUTOR_ONLY_VOCABULARY]);
    for (const t of EXTRA_TERMS) assert.ok(EXECUTOR_ONLY_VOCABULARY.has(t) && !GRAPH_VOCABULARY.has(t), `PRECONDITION: ${t} is an executor-only term`);
    for (const t of DECLARED_SINCE_GOLDEN) assert.ok(GRAPH_VOCABULARY.has(t) && !g.unused.includes(t), `PRECONDITION: ${t} is declared now and was not in the golden`);
    const expectUnused = [...new Set([...g.unused, ...DECLARED_SINCE_GOLDEN, ...[...EXECUTOR_ONLY_VOCABULARY].filter((t) => !EXTRA_TERMS.includes(t))])].sort();
    const body = Object.fromEntries(Object.keys(g).map((k) => [k, j[k]]));
    assert.deepEqual(body, { ...g, emitted: g.emitted + EXTRA_TERMS.length, declared: union.size, undeclared: [], unused: expectUnused, ok: true },
      'the drift body: the golden one, plus exactly the listed extras, judged against the union');
    assert.deepEqual(Object.keys(j).filter((k) => k in g), Object.keys(g), 'and its fields in the same order');
  });
});

test('#1645 (V2) the currency fields: rebuiltMs null, executorPosition the executor\'s own marker, source "executor", no watermark', { skip: SKIP, timeout: 240000 }, async () => {
  await withWorld(async (w) => {
    const { j } = await get(w, '/api/graph/vocabulary');
    assert.ok('rebuiltMs' in j && j.rebuiltMs === null, `rebuiltMs is present and null (got ${JSON.stringify(j.rebuiltMs)})`);
    assert.equal(j.executorPosition, await marker(w), 'executorPosition is the executor\'s own marker');
    assert.equal(j.source, 'executor');
    assert.ok(!('watermark' in j), `no replica watermark (got ${JSON.stringify(j.watermark)})`);
  });
});

test('#1645 (V3) named shapes the replica answered: equal in shape, prefix, observed and means; the sample is a real object of the predicate', { skip: SKIP, timeout: 240000 }, async () => {
  await withWorld(async (w) => {
    for (const [name, gold] of Object.entries(GOLDEN.shapes)) {
      if (EXTRA_PREDICATES.includes(name) || gold.body.length === 0) continue;
      const { status, j } = await get(w, `/api/predicates?name=${encodeURIComponent(name)}&shapes=1`);
      assert.equal(status, 200, `${name}: 200`);
      assert.equal(j.length, gold.body.length, `${name}: one entry, as the replica gave`);
      const [a, b] = [j[0], gold.body[0]];
      const { sample: sa, ...ra } = a.objectShape; const { sample: _sb, ...rb } = b.objectShape;
      assert.deepEqual({ ...a, objectShape: ra }, { ...b, objectShape: rb }, `${name}: equal to the replica's answer in everything but the sample`);
      assert.equal(await sampleIsReal(w, name, a.objectShape), true, `${name}: the sample ${JSON.stringify(sa)} is a real object of the predicate in the executor`);
    }
  });
});

test('#1645 (V4) the listed extras now have shapes (the replica had none); a predicate neither store emits still answers []', { skip: SKIP, timeout: 240000 }, async () => {
  await withWorld(async (w) => {
    for (const name of EXTRA_PREDICATES) {
      assert.deepEqual(GOLDEN.shapes[name].body, [], `PRECONDITION: the replica had no shape for ${name}`);
      const { j } = await get(w, `/api/predicates?name=${encodeURIComponent(name)}&shapes=1`);
      assert.equal(j.length, 1, `${name}: the executor's answer has it (got ${JSON.stringify(j).slice(0, 200)})`);
      assert.ok(j[0].objectShape && j[0].objectShape.observed > 0, `${name}: with an observed shape`);
      assert.equal(await sampleIsReal(w, name, j[0].objectShape), true, `${name}: whose sample is real`);
    }
    assert.deepEqual(GOLDEN.shapes['scrum:inColumn'].body, [], 'PRECONDITION: the replica answered [] for scrum:inColumn');
    assert.deepEqual((await get(w, '/api/predicates?name=scrum%3AinColumn&shapes=1')).j, [], 'and so does the executor: neither emits it');
  });
});

test('#1645 (V5) NO REPLICA: both routes answered on a fresh REST, and /api/health still says graph.boot null and graph.syncs 0', { skip: SKIP, timeout: 240000 }, async () => {
  await withWorld(async (w) => {
    const h0 = (await get(w, '/api/health')).j.graph;
    assert.ok(h0 && h0.boot == null && h0.syncs === 0, `PRECONDITION: a fresh REST has built no replica (graph ${JSON.stringify(h0)})`);
    assert.equal((await get(w, '/api/graph/vocabulary')).status, 200, 'the vocabulary route answered');
    assert.equal((await get(w, '/api/predicates?name=schema%3Aname&shapes=1')).status, 200, 'the shapes route answered');
    await new Promise((r) => setTimeout(r, 1500));   // a lazily-kicked build would land by now
    const h1 = (await get(w, '/api/health')).j.graph;
    assert.equal(h1.boot ?? null, null, `no replica was built (graph.boot ${JSON.stringify(h1.boot)})`);
    assert.equal(h1.syncs, 0, `and none synced (graph.syncs ${h1.syncs})`);
  });
});

test('#1645 (V6) the PUBLIC dataset only: a predicate planted only in the bookkeeping graph is in neither answer', { skip: SKIP, timeout: 240000 }, async () => {
  await withWorld(async (w) => {
    const planted = 'scrum:plantedBookkeepingOnly1645';
    const u = await fetch(`${w.exec.baseUrl}/update`, { method: 'POST', headers: { 'x-op-id': 'urn:op:v6-1645-plant' }, body: `INSERT DATA { GRAPH <${BK}> { <urn:ex:v6> ${iri(planted)} "bookkeeping only" } }` });
    assert.equal(u.status, 200, `PRECONDITION: planted (${await u.text()})`);
    const all = await (await fetch(`${w.exec.baseUrl}/query`, { method: 'POST', body: `ASK { GRAPH <${BK}> { <urn:ex:v6> ${iri(planted)} ?o } }` })).text();
    assert.match(all, /"boolean"\s*:\s*true/, 'CONTROL: the planted triple is in the bookkeeping graph');
    const v = (await get(w, '/api/graph/vocabulary')).j;
    assert.ok(!JSON.stringify(v).includes(planted), 'the vocabulary does not count it');
    assert.deepEqual((await get(w, `/api/predicates?name=${encodeURIComponent(planted)}&shapes=1`)).j, [], 'and the shapes route does not see it');
  });
});

test('#1645 (V7) NO BOARD DOCUMENT: after boot, the vocabulary route and named and unnamed shapes lookups make ZERO attempts on the board document', { skip: SKIP, timeout: 240000 }, async () => {
  // the half of the pin promised at 43287 and missing from V5 (the code reviewer's finding at ca25209, 43340: two document attempts on the
  // shapes route). Every attempt is recorded (tests/helpers/fs-store-recorder.mjs, SCRUM_FS_RECORD_ALL=1), so a caught read still counts.
  const os = await import('node:os');
  const recDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v7rec-')); const rec = path.join(recDir, 'opened.txt'); fs.writeFileSync(rec, '');
  const RECORDER = path.join(HERE, 'helpers', 'fs-store-recorder.mjs');
  // the small-kinds unit ON, as prod runs it: predicate definitions are a collection family, held in the executor when that unit is on (43342)
  const w = await wholeBoardWorld({ env: { SCRUM_GRAPH_UNIT_SMALLKINDS: '1', SCRUM_FS_RECORD: rec, SCRUM_FS_RECORD_ALL: '1', NODE_OPTIONS: `--import ${RECORDER}` } });
  try {
    await new Promise((r) => setTimeout(r, 1500));   // boot's own reads settle; the window opens BEFORE the first probe
    const board = [w.boardFile, fs.realpathSync(w.boardFile)];
    const attempts = () => fs.readFileSync(rec, 'utf8').split('\n').filter((l) => board.includes(l.trim())).length;
    assert.ok(fs.readFileSync(rec, 'utf8').split('\n').filter(Boolean).length > 0, 'CONTROL: the recorder is live in this process');
    const before = attempts();
    assert.equal((await get(w, '/api/graph/vocabulary')).status, 200, 'the vocabulary route answered');
    assert.equal((await get(w, '/api/predicates?name=schema%3Aname&shapes=1')).status, 200, 'a named shapes lookup answered');
    assert.equal((await get(w, '/api/predicates?shapes=1')).status, 200, 'the unnamed shapes list answered');
    const during = attempts() - before;
    assert.equal(during, 0, `the three calls made ${during} attempt(s) on the board document (counted per attempt, caught errors included)`);
  } finally { await w.stop(); fs.rmSync(recDir, { recursive: true, force: true }); }
});

test('#1645 (V8) the unnamed shapes list still RETURNS the registry from the executor, with zero board-document attempts', { skip: SKIP, timeout: 240000 }, async () => {
  // the code reviewer's point (43343): with no definitions in the fixture, a route that returns [] passes V7 by dropping the registry. So a
  // definition is registered through REST with the small-kinds unit on (it is then held in the executor), and the list must return it.
  const os = await import('node:os');
  const recDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8rec-')); const rec = path.join(recDir, 'opened.txt'); fs.writeFileSync(rec, '');
  const RECORDER = path.join(HERE, 'helpers', 'fs-store-recorder.mjs');
  const w = await wholeBoardWorld({ env: { SCRUM_GRAPH_UNIT_SMALLKINDS: '1', SCRUM_FS_RECORD: rec, SCRUM_FS_RECORD_ALL: '1', NODE_OPTIONS: `--import ${RECORDER}` } });
  try {
    const NAME = 'scrum:plantedForV8'; const DEF = 'a predicate registered by the #1645 V8 row, to prove the registry is read from the executor';
    const reg = await fetch(`${w.rest.baseUrl}/api/predicates`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: NAME, definition: DEF, by: 'ada' }) });
    assert.ok(reg.status === 200 || reg.status === 201, `PRECONDITION: the definition registers (${reg.status} ${(await reg.text()).slice(0, 200)})`);
    const held = await askExec(w, `ASK { ?d a ${iri('scrum:PredicateDefinition')} . ?d ?p ?n FILTER(STR(?n) = ${JSON.stringify(NAME)}) }`);
    assert.equal(held, true, 'CONTROL: the definition is held in the executor\'s public dataset');
    await new Promise((r) => setTimeout(r, 1500));
    const board = [w.boardFile, fs.realpathSync(w.boardFile)];
    const attempts = () => fs.readFileSync(rec, 'utf8').split('\n').filter((l) => board.includes(l.trim())).length;
    const before = attempts();
    const { status, j } = await get(w, '/api/predicates?shapes=1');
    const during = attempts() - before;
    assert.equal(status, 200, 'the unnamed list answered');
    const mine = (Array.isArray(j) ? j : []).find((p) => p.name === NAME);
    assert.ok(mine, `the list includes the definition held in the executor (names: ${JSON.stringify((Array.isArray(j) ? j : []).map((p) => p.name)).slice(0, 300)})`);
    assert.equal(mine.definition, DEF, 'with its definition text');
    assert.equal(during, 0, `and the call made ${during} attempt(s) on the board document`);
  } finally { await w.stop(); fs.rmSync(recDir, { recursive: true, force: true }); }
});
