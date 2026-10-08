/**
 * #1570 — graph_query (POST /api/graph) is ONE coherent read view when the
 * #1561 log-born unit is ON.
 *
 * With SCRUM_GRAPH_UNIT_LOGBORN=1 memory/decision/seat-state writes go to the
 * graph executor and never reach the in-process replica, so graph_query was
 * blind to them (reproduced by a reviewer). Reviewer constraints this file pins:
 *
 *   MIXED     a query joining an executor-held memory to a JSON-held card
 *             sees BOTH sides in one SPARQL query (a reviewer).
 *   UNCHANGED an existing default-graph query (no GRAPH / FROM clause) returns
 *             the SAME rows flag ON as flag OFF (a reviewer, added requirement).
 *   FRESH     a card change and an executor write are each visible to the very
 *             next graph_query (the replica's read-your-writes bound, kept).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startRestServer, freePort, PROJECT_DIR } from './helpers/harness.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';

// #1569: a seat declares only its OWN state, so each declaring seat has its own token
const TOK = { bob: mintToken(), pbob: mintToken(), rbob: mintToken() };
function tokensFile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gq1570-tok-'));
  const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  const f = path.join(d, 'seat-tokens.json');
  const cred = (t) => ({ credentials: [{ tokenHash: hashToken(t), scope: 'admin', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null }] });
  fs.writeFileSync(f, JSON.stringify({ seats: Object.fromEntries(Object.entries(TOK).map(([k, t]) => [k, cred(t)])) }));
  return f;
}
const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(PROJECT_DIR, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;

function initStore(dsid) {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'gq1570-store-'));
  const init = spawnSync(PY, ['-c', `import pyoxigraph as px\ns = px.Store(${JSON.stringify(store)})\ns.update('INSERT DATA { GRAPH <urn:scrum:bookkeeping:executor> { <urn:ex:dataset> <urn:ex:datasetId> "${dsid}" ; <urn:ex:epoch> 1 ; <urn:ex:commitSeq> 0 } }')\ns.flush()`]);
  assert.equal(init.status, 0, String(init.stderr));
  return store;
}
async function boot({ dsid, unit }) {
  const srv = await startRestServer({ env: {
    SCRUM_GRAPH_EXECUTOR_URL: `http://127.0.0.1:${await freePort()}`, SCRUM_GRAPH_DATASET_ID: dsid,
    SCRUM_TRIAL_EXECUTOR_STORE: initStore(dsid), GRAPH_EXECUTOR_PYTHON: PY, SCRUM_SEAT_TOKENS: tokensFile(),
    SCRUM_AUTH: 'required', ...(unit ? { SCRUM_GRAPH_UNIT_LOGBORN: '1' } : {}),
  } });
  for (let i = 0; i < 200; i++) {
    const c = await (await fetch(`${srv.baseUrl}/api/trial/counters`, { headers: { authorization: `Bearer ${TOK.bob}` } })).json();
    if (c.executor) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return srv;
}
const call = async (srv, method, p, body, seat = 'bob') => {
  const r = await fetch(`${srv.baseUrl}${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOK[seat]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const gq = async (srv, query) => {
  const r = await call(srv, 'POST', '/api/graph', { query });
  assert.equal(r.status, 200, `graph_query refused: ${JSON.stringify(r.body)}`);
  return r.body;
};
const sorted = (rows) => rows.map((r) => JSON.stringify(Object.fromEntries(Object.entries(r).sort()))).sort();

let ON, OFF;
before(async () => {
  if (SKIP) return;
  [ON, OFF] = await Promise.all([boot({ dsid: 'gq-on', unit: true }), boot({ dsid: 'gq-off', unit: false })]);
});
after(async () => { await ON?.stop(); await OFF?.stop(); });

/** The same fixture on a server: one card claimed by bob, one memory owned by bob TAGGED with the card's identifier. */
async function fixture(srv, tag) {
  const card = await call(srv, 'POST', '/api/cards', { title: `card ${tag}`, by: 'bob' });
  assert.ok(card.status < 300, JSON.stringify(card.body));
  const shortId = String(card.body.shortId ?? card.body.identifier);
  const claim = await call(srv, 'POST', `/api/cards/${card.body.id}/claim`, { by: 'bob' });
  assert.ok(claim.status < 300, JSON.stringify(claim.body));
  const mem = await call(srv, 'POST', '/api/memories', { owner: 'bob', title: `mem ${tag}`, body: `about card ${shortId}`, tags: [`card-${shortId}`] });
  assert.equal(mem.status, 201, JSON.stringify(mem.body));
  return { card: card.body, shortId, mem: mem.body };
}

// The MIXED query, written exactly as a caller writes one today: default graph, no GRAPH/FROM.
// Memory side (executor when ON) ⋈ card side (document) on the OWNER = CLAIMANT person node
// AND on the tag literal naming the card.
const MIXED = (tag) => `SELECT ?title ?cardName ?who WHERE {
  ?m a scrum:Memory ; schema:name ?title ; scrum:owner ?who ; scrum:tag ?t .
  ?c a schema:CreativeWork ; schema:name ?cardName ; scrum:claimedBy ?who ; schema:identifier ?id .
  FILTER(?t = CONCAT("card-", ?id))
  FILTER(?title = "mem ${tag}")
}`;

test('#1570 RED→GREEN: flag ON, a memory written via REST is found by graph_query', { skip: SKIP }, async () => {
  const m = await call(ON, 'POST', '/api/memories', { owner: 'bob', title: 'findme-1570', body: 'b' });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  const r = await gq(ON, 'SELECT ?m ?b WHERE { ?m a scrum:Memory ; schema:name "findme-1570" . ?v scrum:ofMemory ?m ; scrum:body ?b }');
  assert.equal(r.returned, 1, `graph_query cannot see the executor-held memory: ${JSON.stringify(r.rows)}`);
  assert.equal(r.rows[0].b, 'b');
});

test('#1570 MIXED + UNCHANGED: a default-graph join of an executor memory to a JSON card returns the joined row, ON = OFF', { skip: SKIP }, async () => {
  const on = await fixture(ON, 'mixed');
  const off = await fixture(OFF, 'mixed');
  const rOn = await gq(ON, MIXED('mixed'));
  const rOff = await gq(OFF, MIXED('mixed'));
  assert.equal(rOff.returned, 1, `control: the flag-OFF board must answer the join: ${JSON.stringify(rOff.rows)}`);
  assert.equal(rOn.returned, 1, `flag ON lost one side of the join: ${JSON.stringify(rOn.rows)}`);
  assert.deepEqual(rOn.rows, rOff.rows);
  assert.deepEqual(rOn.rows[0], { title: 'mem mixed', cardName: 'card mixed', who: 'person:bob' });
  // and the identifiers the two boards minted are what the rows join on, not a coincidence
  assert.notEqual(on.mem.id, off.mem.id);
});

test('#1570 UNCHANGED: an existing default-graph census over card + memory subjects returns the same rows ON as OFF', { skip: SKIP }, async () => {
  await fixture(ON, 'census');
  await fixture(OFF, 'census');
  // the predicates on the memory, its version and the card — no GRAPH clause, no FROM.
  // IRIs and timestamps differ per board; predicates and literal shape must not.
  const Q = `SELECT ?kind ?p WHERE {
    { ?s a scrum:Memory ; schema:name "mem census" . BIND("memory" AS ?kind) }
    UNION { ?m a scrum:Memory ; schema:name "mem census" . ?s scrum:ofMemory ?m . BIND("version" AS ?kind) }
    UNION { ?s a schema:CreativeWork ; schema:name "card census" . BIND("card" AS ?kind) }
    ?s ?p ?o .
  }`;
  const rOn = await gq(ON, Q);
  const rOff = await gq(OFF, Q);
  assert.ok(rOff.returned > 10, `control: ${rOff.returned}`);
  assert.deepEqual(sorted(rOn.rows), sorted(rOff.rows));
  // no executor bookkeeping (urn:ex:ver, urn:ex:recordedBy, receipts) leaks into the board's vocabulary
  assert.ok(!rOn.rows.some((r) => String(r.p).startsWith('urn:ex:')), JSON.stringify(rOn.rows.filter((r) => String(r.p).startsWith('urn:ex:'))));
});

test('#1570 FRESH: an executor revise and a card rename are each visible to the very next graph_query', { skip: SKIP }, async () => {
  const { card, mem } = await fixture(ON, 'fresh');
  const p = await call(ON, 'PATCH', `/api/memories/${mem.id}`, { title: 'mem fresh2' });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const r1 = await gq(ON, 'SELECT ?n WHERE { ?m a scrum:Memory ; schema:name ?n . FILTER(STRSTARTS(?n, "mem fresh")) }');
  assert.deepEqual(r1.rows.map((r) => r.n), ['mem fresh2']);
  const u = await call(ON, 'PATCH', `/api/cards/${card.id}`, { title: 'card fresh2', by: 'bob' });
  assert.ok(u.status < 300, JSON.stringify(u.body));
  const r2 = await gq(ON, MIXED('fresh2'));
  assert.deepEqual(r2.rows, [{ title: 'mem fresh2', cardName: 'card fresh2', who: 'person:bob' }]);
});

test('#1570 decisions and seat declarations written ON are visible to graph_query', { skip: SKIP }, async () => {
  const d = await call(ON, 'POST', '/api/decisions', { statement: 'S-1570', decidedBy: 'bob', constrains: ['gq1570'], reopensIf: 'R' });
  assert.ok(d.status < 300, JSON.stringify(d.body));
  const s = await call(ON, 'PUT', '/api/seats/bob/state', { mode: 'resting', acceptsRoutineWork: false, note: 'gq1570', expiresAt: new Date(Date.now() + 86400_000).toISOString() });
  assert.ok(s.status < 300, JSON.stringify(s.body));
  const r = await gq(ON, `SELECT ?st ?mode WHERE {
    ?d a scrum:Decision ; scrum:statement ?st ; scrum:decidedBy person:bob .
    ?x a scrum:SeatDeclaration ; scrum:declaredSeat person:bob ; scrum:mode ?mode ; scrum:note "gq1570" .
    FILTER NOT EXISTS { ?x scrum:endedAt ?e } }`);
  assert.deepEqual(r.rows, [{ st: 'S-1570', mode: 'resting' }]);
});

// ── PARITY BATTERY: the graph_query-facing vocabulary of the three kinds, ON vs OFF ──
// The same script of writes on both boards, then the queries the existing tests
// (memory-graph-type, decisions-graph-record, seat-state-graph-record) and callers
// ask, compared row-for-row with per-board identifiers and timestamps normalised.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const TS = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g;
const norm = (rows) => sorted(rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v)
  .replace(/^entity:seat-state\/([^/]+)\/(seq-\d+|decl-.*)$/, 'entity:seat-state/$1/<decl>')
  .replace(UUID, '<uuid>').replace(TS, '<ts>')]))));

async function parityScript(srv) {
  const m = await call(srv, 'POST', '/api/memories', { owner: 'bob', title: 'P1', body: 'one', tags: ['z', 'a'], priority: 'p2' });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  await call(srv, 'PATCH', `/api/memories/${m.body.id}`, { bodyAppend: ' two' });
  await call(srv, 'PATCH', `/api/memories/${m.body.id}`, { title: 'P1b', tags: ['q'], priority: null });
  const m2 = await call(srv, 'POST', '/api/memories', { owner: 'bob', title: 'P2', body: 'other' });
  const rel = await call(srv, "PATCH", `/api/memories/${m2.body.id}`, { relatedTo: [m.body.id] });
  assert.equal(rel.status, 200, JSON.stringify(rel.body));
  const dA = await call(srv, 'POST', '/api/decisions', { statement: 'PA', decidedBy: 'pdec', constrains: ['pt', 'pt0'], reopensIf: 'R' });
  assert.equal(dA.status, 201, JSON.stringify(dA.body));
  await new Promise((r) => setTimeout(r, 15));
  await call(srv, 'POST', '/api/decisions', { statement: 'PB', decidedBy: 'pdec', constrains: ['pt'], reopensIf: 'R', supersedes: [dA.body.id.slice(0, 8)] });
  const exp = new Date(Date.now() + 86400_000).toISOString();
  for (const b of [{ mode: 'degraded', acceptsRoutineWork: true, expiresAt: exp, note: 'n1', constraints: ['slow'] }, { mode: 'resting', acceptsRoutineWork: false, expiresAt: exp }]) {
    const r = await call(srv, 'PUT', '/api/seats/pbob/state', b, 'pbob');
    assert.ok(r.status < 300, JSON.stringify(r.body));
  }
  await call(srv, 'DELETE', '/api/seats/pbob/state', undefined, 'pbob');
}
const BATTERY = {
  memoryTitleOwner: 'SELECT ?t ?owner WHERE { ?m a scrum:Memory ; schema:name ?t ; scrum:owner ?owner . FILTER(STRSTARTS(?t, "P")) }',
  memoryVersions: 'SELECT ?t ?v ?b ?a WHERE { ?m a scrum:Memory ; schema:name ?t . FILTER(STRSTARTS(?t, "P")) ?x scrum:ofMemory ?m ; scrum:version ?v ; scrum:body ?b ; schema:author ?a }',
  memoryCurrent: 'SELECT ?t ?b WHERE { ?m a scrum:Memory ; schema:name ?t ; scrum:currentVersion ?c . ?c scrum:body ?b . FILTER(STRSTARTS(?t, "P")) }',
  memoryTagsRelated: 'SELECT ?t ?tag ?rel WHERE { ?m a scrum:Memory ; schema:name ?t . FILTER(STRSTARTS(?t, "P")) OPTIONAL { ?m scrum:tag ?tag } OPTIONAL { ?m scrum:relatedTo ?r . ?r schema:name ?rel } }',
  decisions: 'SELECT ?st ?by ?topic ?re ?sup WHERE { ?d a scrum:Decision ; scrum:statement ?st ; scrum:decidedBy ?by ; scrum:constrains ?topic ; scrum:reopensIf ?re . FILTER(STRSTARTS(?st, "P")) OPTIONAL { ?d scrum:supersedes ?s . ?s scrum:statement ?sup } }',
  decisionCount: 'SELECT (COUNT(?d) AS ?n) WHERE { ?d a scrum:Decision ; scrum:statement ?st . FILTER(STRSTARTS(?st, "P")) }',
  seatIntervals: 'SELECT ?d ?mode ?arw ?note ?c ?ended WHERE { ?d a scrum:SeatDeclaration ; scrum:declaredSeat person:pbob ; scrum:mode ?mode . OPTIONAL { ?d scrum:acceptsRoutineWork ?arw } OPTIONAL { ?d scrum:note ?note } OPTIONAL { ?d scrum:constraint ?c } OPTIONAL { ?d scrum:endedAt ?e } BIND(BOUND(?e) AS ?ended) }',
  seatOpen: 'SELECT ?d WHERE { ?d a scrum:SeatDeclaration ; scrum:declaredSeat person:pbob FILTER NOT EXISTS { ?d scrum:endedAt ?e } }',
  vocabulary: 'SELECT ?t ?p (COUNT(*) AS ?n) WHERE { ?s a ?t ; ?p ?o . VALUES ?t { scrum:Memory scrum:MemoryVersion scrum:Decision scrum:SeatDeclaration } { ?s schema:name ?nm FILTER(STRSTARTS(?nm, "P")) } UNION { ?s scrum:ofMemory ?mm . ?mm schema:name ?nm FILTER(STRSTARTS(?nm, "P")) } UNION { ?s scrum:statement ?st FILTER(STRSTARTS(?st, "P")) } UNION { ?s scrum:declaredSeat person:pbob } } GROUP BY ?t ?p',
};

test('#1570 PARITY BATTERY: the existing graph_query vocabulary for memory / decision / seat-state answers the same ON as OFF', { skip: SKIP }, async () => {
  await parityScript(ON);
  await parityScript(OFF);
  const diffs = [];
  for (const [name, q] of Object.entries(BATTERY)) {
    const [a, b] = [await gq(ON, q), await gq(OFF, q)];
    assert.ok(b.returned > 0 || name === "seatOpen", `control: ${name} answers nothing flag OFF`);   // seatOpen: pbob was cleared, so none is open on either
    if (JSON.stringify(norm(a.rows)) !== JSON.stringify(norm(b.rows))) diffs.push({ name, on: norm(a.rows), off: norm(b.rows) });
  }
  assert.deepEqual(diffs, []);
});

test('#1570 the executor copy is RE-APPLIED after a document sync: a refused seat PUT (a log event) does not end the open declaration in graph_query', { skip: SKIP }, async () => {
  // The replica projects ANY seat-state event — a refused PUT included — as the END of the
  // seat's open interval (#1561 test file notes this pre-existing behaviour). With the unit ON
  // that open interval is the executor's copy, so a sync after the refusal would end it in the
  // view while the executor (and /api/seats/state) still hold it open — unless the copy is
  // re-applied after every document sync.
  const exp = new Date(Date.now() + 86400_000).toISOString();
  const ok = await call(ON, 'PUT', '/api/seats/rbob/state', { mode: 'resting', acceptsRoutineWork: false, expiresAt: exp }, 'rbob');
  assert.ok(ok.status < 300, JSON.stringify(ok.body));
  const Q = 'SELECT ?mode WHERE { ?d a scrum:SeatDeclaration ; scrum:declaredSeat person:rbob ; scrum:mode ?mode FILTER NOT EXISTS { ?d scrum:endedAt ?e } }';
  assert.deepEqual((await gq(ON, Q)).rows, [{ mode: 'resting' }]);
  const bad = await call(ON, 'PUT', '/api/seats/rbob/state', { mode: 'nonsense', acceptsRoutineWork: false, expiresAt: exp }, 'rbob');
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  const api = await call(ON, 'GET', '/api/seats/state');
  const seat = [].concat(api.body.seats || api.body).find((s) => s.seat === 'rbob');
  assert.equal(seat?.mode, 'resting', `control: the executor still holds rbob open: ${JSON.stringify(api.body)}`);
  assert.deepEqual((await gq(ON, Q)).rows, [{ mode: 'resting' }], 'graph_query must agree with the executor after a document sync');
});

test('#1570 an unreadable executor is a 503 GRAPH_EXECUTOR_UNAVAILABLE, never a replica-only answer', { skip: SKIP }, async () => {
  const stop = await call(ON, 'POST', '/api/trial/executor/stop');
  assert.ok(stop.status < 300, JSON.stringify(stop.body));
  try {
    const r = await call(ON, 'POST', '/api/graph', { query: 'SELECT ?c WHERE { ?c a schema:CreativeWork } LIMIT 1' });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.code, 'GRAPH_EXECUTOR_UNAVAILABLE');
    // the flag-OFF board does not depend on the executor for graph_query (the slice is on there too)
    const off = await call(OFF, 'POST', '/api/graph', { query: 'SELECT ?c WHERE { ?c a schema:CreativeWork } LIMIT 1' });
    assert.equal(off.status, 200);
  } finally {
    await call(ON, 'POST', '/api/trial/executor/start');
  }
});

test('#1570 replaceLogbornRecords: the kinds\' subjects are replaced whole; edges INTO them from JSON-held nodes are kept; a bad term touches nothing', async () => {
  const { buildGraphStore, replaceLogbornRecords, IRI } = await import('../core/graph-replica.mjs');
  const S = IRI.scrum, SC = IRI.schema, RDF = IRI.rdf + 'type';
  const store = buildGraphStore({ '@graph': [] });
  const u = (v) => ({ type: 'uri', value: v }), l = (v) => ({ type: 'literal', value: v });
  // what the document/log projection left: a STALE memory (gone from the executor) and an obligation pointing at it
  replaceLogbornRecords(store, []);   // no-op on an empty store
  const seed = [
    { s: u('urn:t:stale'), p: u(RDF), o: u(S + 'Memory') }, { s: u('urn:t:stale'), p: u(SC + 'name'), o: l('old title') },
    { s: u('urn:t:keep'), p: u(RDF), o: u(S + 'Memory') }, { s: u('urn:t:keep'), p: u(SC + 'name'), o: l('stale title of keep') },
  ];
  replaceLogbornRecords(store, seed);
  const oxigraph = (await import('oxigraph')).default;
  store.add(oxigraph.triple(oxigraph.namedNode('urn:t:obligation'), oxigraph.namedNode(SC + 'about'), oxigraph.namedNode('urn:t:keep')));
  const r = replaceLogbornRecords(store, [
    { s: u('urn:t:keep'), p: u(RDF), o: u(S + 'Memory') }, { s: u('urn:t:keep'), p: u(SC + 'name'), o: l('executor title') },
    { s: u('urn:t:keep'), p: u(S + 'version'), o: { type: 'literal', value: '2', datatype: 'http://www.w3.org/2001/XMLSchema#integer' } },
  ]);
  assert.deepEqual(r, { removed: 4, added: 3 });
  const rows = (q) => [...store.query(q)].map((b) => Object.fromEntries([...b.entries()].map(([k, v]) => [k, v.value])));
  assert.deepEqual(rows(`SELECT ?m ?n WHERE { ?m a <${S}Memory> ; <${SC}name> ?n }`), [{ m: 'urn:t:keep', n: 'executor title' }]);
  assert.equal(rows(`SELECT ?o WHERE { <urn:t:obligation> <${SC}about> ?o }`).length, 1, 'the JSON-held edge into the record survives');
  assert.equal(rows(`SELECT ?v WHERE { <urn:t:keep> <${S}version> ?v FILTER(?v = 2) }`).length, 1, 'a typed literal keeps its datatype');
  const before = store.size;
  assert.throws(() => replaceLogbornRecords(store, [{ s: u('urn:t:x'), p: u(RDF), o: { type: 'nonsense', value: 'x' } }]));
  assert.equal(store.size, before, 'a malformed term is refused before the store is touched');
});
