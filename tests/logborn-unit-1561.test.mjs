/**
 * #1561 — the log-born unit (memory, decision, seat-state) on a REAL board server
 * with SCRUM_GRAPH_UNIT_LOGBORN=1, against a twin server with the flag OFF.
 *
 *   PARITY     the same script of REST calls on both servers gives the same
 *              statuses and bodies (ids and timestamps normalised).
 *   COUNTERS   with the flag ON, the unit's own writes and reads move none of
 *              writeBoard / saveDomain / appendEvent / graphReplicaSync; with it
 *              OFF the same calls DO move them (the sensitivity control).
 *   WHO        the writer is the authenticated seat; observe mode is refused
 *              before anything is dispatched.
 *   RACES      concurrent appends all survive through the expected-version guard.
 *   /api/assert  a batch with ANY memory assertion is refused WHOLE, before any
 *              effect (option b); the same batch without it applies.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startRestServer, freePort, PROJECT_DIR } from './helpers/harness.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';

const TOK = { bob: mintToken(), ada: mintToken() };
function tokensFile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-tok-'));
  const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  const cred = (p) => ({ tokenHash: hashToken(p), scope: 'admin', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null });
  const f = path.join(d, 'seat-tokens.json');
  fs.writeFileSync(f, JSON.stringify({ seats: Object.fromEntries(Object.entries(TOK).map(([k, v]) => [k, { credentials: [cred(v)] }])) }));
  return f;
}
const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(PROJECT_DIR, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;

function initStore(dsid) {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-store-'));
  const init = spawnSync(PY, ['-c', `import pyoxigraph as px\ns = px.Store(${JSON.stringify(store)})\ns.update('INSERT DATA { <urn:ex:dataset> <urn:ex:datasetId> "${dsid}" ; <urn:ex:epoch> 1 ; <urn:ex:commitSeq> 0 }')\ns.flush()`]);
  assert.equal(init.status, 0, String(init.stderr));
  return store;
}
async function boot({ dsid, unit, auth = 'required', store = initStore(dsid) }) {
  const srv = await startRestServer({ env: {
    SCRUM_GRAPH_EXECUTOR_URL: `http://127.0.0.1:${await freePort()}`, SCRUM_GRAPH_DATASET_ID: dsid,
    SCRUM_TRIAL_EXECUTOR_STORE: store, GRAPH_EXECUTOR_PYTHON: PY, SCRUM_SEAT_TOKENS: tokensFile(),
    ...(auth ? { SCRUM_AUTH: auth } : {}), ...(unit ? { SCRUM_GRAPH_UNIT_LOGBORN: '1' } : {}),
  } });
  for (let i = 0; i < 200; i++) {
    const c = await (await fetch(`${srv.baseUrl}/api/trial/counters`, { headers: { authorization: `Bearer ${TOK.bob}` } })).json();
    if (c.executor) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  srv.store = store;
  return srv;
}
const H = (seat = 'bob') => ({ 'content-type': 'application/json', authorization: `Bearer ${TOK[seat]}` });
const call = async (srv, method, p, body, seat = 'bob') => {
  const r = await fetch(`${srv.baseUrl}${p}`, { method, headers: H(seat), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const counters = async (srv) => (await call(srv, 'GET', '/api/trial/counters')).body;
const LEGACY_WRITES = ['writeBoard', 'saveDomain', 'appendEvent', 'graphReplicaSync'];
const delta = (a, b) => Object.fromEntries(Object.keys(b).map((k) => [k, b[k] - (a[k] ?? 0)]));
const later = new Date(Date.now() + 7 * 86400_000).toISOString();

let ON, OFF, OBS;
before(async () => {
  if (SKIP) return;
  [ON, OFF, OBS] = await Promise.all([boot({ dsid: 'lb-on', unit: true }), boot({ dsid: 'lb-off', unit: false }), boot({ dsid: 'lb-obs', unit: true, auth: null })]);
});
after(async () => { await ON?.stop(); await OFF?.stop(); await OBS?.stop(); });

// ── the script: every operation the unit owns, success and refusal ──────────
async function script(srv) {
  const out = [];
  const step = async (name, method, p, body, seat) => { const r = await call(srv, method, p, body, seat); out.push({ name, ...r }); return r; };
  const pause = () => new Promise((r) => setTimeout(r, 15));   // decisions list in dateCreated order; keep it unambiguous
  const m = await step('memory.create', 'POST', '/api/memories', { owner: 'bob', title: 'T1', body: 'B1 "q" ; \\u0041', tags: ['z', 'a'], priority: 'p2' });
  const id = m.body.id;
  await step('memory.create other', 'POST', '/api/memories', { owner: 'ada', title: 'Ada', body: 'ada text', by: 'bob' });
  await step('memory.create no body', 'POST', '/api/memories', { owner: 'bob', title: 'x' });
  await step('memory.create bad priority', 'POST', '/api/memories', { owner: 'bob', title: 'x', body: 'y', priority: 'p9' });
  await step('memory.get', 'GET', `/api/memories/${id}`);
  await step('memory.append', 'PATCH', `/api/memories/${id}`, { bodyAppend: ' +A' });
  await step('memory.prepend', 'PATCH', `/api/memories/${id}`, { bodyPrepend: 'P+ ' });
  await step('memory.retitle', 'PATCH', `/api/memories/${id}`, { title: 'T2', tags: ['q'], priority: null });
  await step('memory.replace ifVersion', 'PATCH', `/api/memories/${id}`, { body: 'replaced', ifVersion: 3 });
  await step('memory.stale ifVersion', 'PATCH', `/api/memories/${id}`, { body: 'nope', ifVersion: 1 });
  await step('memory.malformed ifVersion', 'PATCH', `/api/memories/${id}`, { body: 'nope', ifVersion: '2' });
  await step('memory.append+body', 'PATCH', `/api/memories/${id}`, { body: 'a', bodyAppend: 'b' });
  await step('memory.unknown', 'PATCH', '/api/memories/00000000-0000-0000-0000-000000000000', { title: 'x' });
  await step('memory.get unknown', 'GET', '/api/memories/00000000-0000-0000-0000-000000000000');
  await step('memory.versions', 'GET', `/api/memories/${id}/versions`);
  await step('memory.list', 'GET', '/api/memories');
  await step('memory.list owner', 'GET', '/api/memories?owner=bob');
  await step('memory.list tag', 'GET', '/api/memories?tag=q');
  await step('memory.assemble', 'GET', '/api/memories/assemble?owner=bob&budget=4096');
  await step('memory.assemble small', 'GET', '/api/memories/assemble?owner=bob&budget=40');

  const dA = await step('decision.create A', 'POST', '/api/decisions', { statement: 'S-A', decidedBy: 'bob', constrains: ['t1', 't0'], reopensIf: 'R' });
  await pause();
  await step('decision.twin', 'POST', '/api/decisions', { statement: 'S-B', decidedBy: 'bob', constrains: ['t1'], reopensIf: 'R' });
  await step('decision.create B supersedes', 'POST', '/api/decisions', { statement: 'S-B', decidedBy: 'bob', constrains: ['t1'], reopensIf: 'R', supersedes: [dA.body.id.slice(0, 8)] });
  await pause();
  const dC = await step('decision.create C force', 'POST', '/api/decisions', { statement: 'S-C', decidedBy: 'bob', constrains: ['t2'], reopensIf: 'R', force: true });
  await step('decision.relate', 'POST', `/api/decisions/${dC.body.id}/relations`, { by: 'bob', duplicateOf: dA.body.id });
  await step('decision.relate bad ref', 'POST', `/api/decisions/${dC.body.id}/relations`, { by: 'bob', supersedes: ['zzzzzzzzzz'] });
  await step('decision.invalid', 'POST', '/api/decisions', { statement: 'x', decidedBy: 'bob', constrains: ['t'] });
  await step('decision.list', 'GET', '/api/decisions');
  await step('decision.list constrains', 'GET', '/api/decisions?constrains=t1');
  await step('decision.list live', 'GET', '/api/decisions?live=1');

  // ⚠️ The refusals go BEFORE the first declare. On the flag-OFF path a REFUSED seat PUT
  // ENDS the seat's open declaration: sendJSON logs a `refused` event with entity kind
  // seat-state, and the replica's projectSeatDeclarationEvent ends the open interval on
  // ANY seat-state event (probed 2026-10-04; a pre-existing defect, reported on #1561,
  // deliberately NOT reproduced by the unit and not fixed here).
  await step('seat.mismatch', 'PUT', '/api/seats/bob/state', { seat: 'ada', mode: 'available', acceptsRoutineWork: true, expiresAt: later });
  await step('seat.unknown mode', 'PUT', '/api/seats/bob/state', { mode: 'unknown', acceptsRoutineWork: true, expiresAt: later });
  await step('seat.declare', 'PUT', '/api/seats/bob/state', { mode: 'available', acceptsRoutineWork: true, expiresAt: later, note: 'here' });
  await step('seat.states', 'GET', '/api/seats/state');
  await step('seat.redeclare', 'PUT', '/api/seats/bob/state', { mode: 'resting', acceptsRoutineWork: false, expiresAt: later });
  await step('seat.states 2', 'GET', '/api/seats/state');
  await step('seat.clear', 'DELETE', '/api/seats/bob/state');
  await step('seat.clear again', 'DELETE', '/api/seats/bob/state');
  await step('seat.states 3', 'GET', '/api/seats/state');
  return { out, ids: [id, dA.body.id, dC.body.id] };
}
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
function normalise(x, map) {
  const ph = (u) => { if (!map.has(u)) map.set(u, `<ID${map.size}>`); return map.get(u); };
  if (typeof x === 'string') return x.replace(UUID, ph).replace(ISO, '<T>');
  if (Array.isArray(x)) return x.map((v) => normalise(v, map));
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, k === 'graph' ? '<graph>' : normalise(v, map)]));
  return x;
}

test('#1561 PARITY: every memory/decision/seat-state operation answers the same with the unit ON as OFF', { skip: SKIP }, async () => {
  const [on, off] = [await script(ON), await script(OFF)];
  const n = (r) => normalise(r.out, new Map([['00000000-0000-0000-0000-000000000000', '<ZERO>']]));
  // ⚠️ GET /api/memories has NO defined order on either path: today's order is whatever
  // order the replica engine returns rows in (memoriesFromRows keeps it). Compared as a
  // SET here, and the question is in the #1561 report rather than decided by this test.
  const unordered = (steps) => steps.map((s) => (s.name.startsWith('memory.list') && Array.isArray(s.body?.memories)
    ? { ...s, body: { ...s.body, memories: [...s.body.memories].sort((x, y) => (x.id < y.id ? -1 : 1)) } } : s));
  const a = unordered(n(on)), b = unordered(n(off));
  for (let i = 0; i < b.length; i++) assert.deepEqual(a[i], b[i], `step ${b[i].name}`);
  assert.equal(a.length, b.length);
  // and the script really exercised the outcomes it names
  const st = Object.fromEntries(on.out.map((s) => [s.name, s.status]));
  assert.deepEqual([st['memory.create'], st['memory.stale ifVersion'], st['memory.malformed ifVersion'], st['memory.unknown'], st['decision.twin'], st['seat.mismatch']], [201, 409, 400, 404, 409, 403]);
});

test('#1561 COUNTERS: with the unit ON its writes and reads touch no legacy write/sync path; OFF, the same calls do (sensitivity)', { skip: SKIP }, async (t) => {
  const ops = async (srv) => {
    const m = await call(srv, 'POST', '/api/memories', { owner: 'bob', title: 'C', body: 'c' });
    assert.equal(m.status, 201);
    assert.equal((await call(srv, 'PATCH', `/api/memories/${m.body.id}`, { bodyAppend: '!', ifVersion: 1 })).status, 200);
    assert.equal((await call(srv, 'GET', `/api/memories/${m.body.id}`)).status, 200);
    assert.equal((await call(srv, 'GET', '/api/memories/assemble?owner=bob&budget=999')).status, 200);
    assert.equal((await call(srv, 'POST', '/api/decisions', { statement: 'cnt', decidedBy: 'ada', constrains: ['c'], reopensIf: 'r', force: true })).status, 201);
    assert.equal((await call(srv, 'GET', '/api/decisions')).status, 200);
    assert.equal((await call(srv, 'PUT', '/api/seats/ada/state', { mode: 'available', acceptsRoutineWork: true, expiresAt: later }, 'ada')).status, 200);
    assert.equal((await call(srv, 'GET', '/api/seats/state')).status, 200);
    assert.equal((await call(srv, 'DELETE', '/api/seats/ada/state', undefined, 'ada')).status, 200);
  };
  const on0 = (await counters(ON)).legacy; await ops(ON); const onD = delta(on0, (await counters(ON)).legacy);
  const off0 = (await counters(OFF)).legacy; await ops(OFF); const offD = delta(off0, (await counters(OFF)).legacy);
  t.diagnostic(`unit ON deltas: ${JSON.stringify(onD)} · unit OFF deltas: ${JSON.stringify(offD)}`);
  for (const k of LEGACY_WRITES) assert.equal(onD[k], 0, `unit ON: ${k} moved by ${onD[k]} (${JSON.stringify(onD)})`);
  for (const k of LEGACY_WRITES) assert.ok(offD[k] >= 1, `sensitivity: unit OFF, ${k} did not move (${JSON.stringify(offD)})`);
  // the writes are in the executor: its update count moved
  assert.ok((await counters(ON)).executor.updates >= 5);
});

test('#1561 WHO: the receipt names the AUTHENTICATED seat, not a body-declared author', { skip: SKIP }, async () => {
  const m = await call(ON, 'POST', '/api/memories', { owner: 'ada', title: 'on behalf', body: 'x' }, 'ada');
  assert.equal(m.status, 201);
  const r = spawnSync(PY, ['-c', `import pyoxigraph as px, sys
s = px.Store.read_only(${JSON.stringify(ON.store)})
q = 'SELECT ?a WHERE { ?op <urn:ex:actor> ?a . ?v <urn:ex:recordedBy> ?op ; <https://scrumboard.local/ns#ofMemory> <https://scrumboard.local/memory/${m.body.id}> }'
print([r['a'].value for r in s.query(q)])`]);
  assert.equal(r.status, 0, String(r.stderr));
  assert.match(String(r.stdout), /urn:ex:seat\/ada/);
});

test('#1561 WHO: observe mode — a write with NO key is refused before dispatch; reads still answer', { skip: SKIP }, async () => {
  // Was: "observe mode (no enforced seat) is refused" — #1559's pin (a reviewer #1). Withdrawn for the
  // unit's own routes at launch (a reviewer 18:41Z, a reviewer 18:43Z, the owner 18:40Z): a MATCHED key is judged
  // as required mode would judge it (tests/logborn-observe-keys-1561.test.mjs pins the boundary).
  // What stays pinned here: no key ⇒ 401 GRAPH_WRITE_UNAUTHENTICATED, nothing dispatched.
  const anon = async (method, p, body) => {
    const r = await fetch(`${OBS.baseUrl}${p}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const u0 = (await counters(OBS)).executor.updates;
  const r = await anon('POST', '/api/memories', { owner: 'bob', title: 'x', body: 'y' });
  assert.equal(r.status, 401); assert.equal(r.body.code, 'GRAPH_WRITE_UNAUTHENTICATED');
  assert.equal((await anon('POST', '/api/decisions', { statement: 'x', decidedBy: 'bob', constrains: ['t'], reopensIf: 'r' })).status, 401);
  assert.equal((await anon('PUT', '/api/seats/bob/state', { mode: 'available', acceptsRoutineWork: true, expiresAt: later })).status, 401);
  assert.equal((await counters(OBS)).executor.updates, u0, 'nothing dispatched');
  const l = await call(OBS, 'GET', '/api/memories');
  assert.equal(l.status, 200); assert.equal(l.body.total, 0);
  // twin: the same write WITH bob's matched key lands
  assert.equal((await call(OBS, 'POST', '/api/memories', { owner: 'bob', title: 'x', body: 'y' })).status, 201);
});

test('#1561 RACES: concurrent appends all survive through the expected-version guard', { skip: SKIP }, async () => {
  const m = await call(ON, 'POST', '/api/memories', { owner: 'bob', title: 'race', body: 'base' });
  const N = 6;
  const rs = await Promise.all(Array.from({ length: N }, (_, k) => call(ON, 'PATCH', `/api/memories/${m.body.id}`, { bodyAppend: ` [${k}]` })));
  for (const r of rs) assert.equal(r.status, 200, JSON.stringify(r.body));
  const final = (await call(ON, 'GET', `/api/memories/${m.body.id}`)).body;
  assert.equal(final.version, 1 + N);
  for (let k = 0; k < N; k++) assert.ok(final.body.includes(` [${k}]`), `append ${k} lost: ${final.body}`);
  const vs = (await call(ON, 'GET', `/api/memories/${m.body.id}/versions`)).body.versions.map((v) => v.version);
  assert.deepEqual(vs, Array.from({ length: N + 1 }, (_, k) => k + 1));
});

test('#1561 RACES: a retag racing an append both survive (only the expected-version guard prevents this lost update)', { skip: SKIP }, async () => {
  // An append mints a fresh version IRI, so two APPENDS collide on freshness even without the
  // revision guard. A retag mints no version: without the guard, an append that read the old
  // tags would write them back over the retag. Repeated, because the interleaving is the test.
  for (let round = 0; round < 12; round++) {
    const m = await call(ON, 'POST', '/api/memories', { owner: 'bob', title: `rr${round}`, body: 'base', tags: ['old'] });
    const [a, b] = await Promise.all([
      call(ON, 'PATCH', `/api/memories/${m.body.id}`, { bodyAppend: ' +x' }),
      call(ON, 'PATCH', `/api/memories/${m.body.id}`, { tags: ['new'] }),
    ]);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    const final = (await call(ON, 'GET', `/api/memories/${m.body.id}`)).body;
    assert.deepEqual(final.tags, ['new'], `round ${round}: the retag was lost`);
    assert.equal(final.body, 'base +x', `round ${round}: the append was lost`);
  }
});

test('#1561 /api/assert: a batch with ANY memory assertion is refused WHOLE before any effect; the same batch without it applies', { skip: SKIP }, async () => {
  for (const [name, definition] of [['scrum:relatedTo', 'see also; symmetric'], ['schema:isPartOf', 'containment']]) {
    const r = await call(ON, 'POST', '/api/predicates', { name, definition });
    assert.ok([200, 201, 409].includes(r.status), JSON.stringify(r.body));
  }
  const card = async (title) => (await call(ON, 'POST', '/api/cards', { title, column: 'backlog' })).body.shortId;
  const parent = await card('parent'); const child = await card('child');
  const m1 = (await call(ON, 'POST', '/api/memories', { owner: 'bob', title: 'm1', body: 'x' })).body.id;
  const m2 = (await call(ON, 'POST', '/api/memories', { owner: 'bob', title: 'm2', body: 'y' })).body.id;
  const cardPart = { subject: child, predicate: 'schema:isPartOf', object: parent };
  const c0 = (await counters(ON)).legacy;
  const r = await call(ON, 'POST', '/api/assert', { assertions: [cardPart, { subject: m1, predicate: 'scrum:relatedTo', object: m2 }] });
  const d = delta(c0, (await counters(ON)).legacy);
  assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.code, 'MEMORY_ASSERT_NOT_CUT_OVER');
  assert.equal(d.writeBoard, 0, 'no writeBoard'); assert.equal(d.saveDomain, 0, 'no saveDomain');
  assert.ok(!(await call(ON, 'GET', `/api/cards/${child}`)).body.parent, 'the card part did not apply');
  const twin = await call(ON, 'POST', '/api/assert', { assertions: [cardPart] });
  assert.equal(twin.status, 200, JSON.stringify(twin.body));
  assert.ok((await call(ON, 'GET', `/api/cards/${child}`)).body.parent, 'twin: the card part applies on its own');
});

test('#1561 the flag without the slice refuses to start', async () => {
  await assert.rejects(startRestServer({ env: { SCRUM_GRAPH_UNIT_LOGBORN: '1', SCRUM_GRAPH_EXECUTOR_URL: '' } }), /exited|REFUSED/);
});
