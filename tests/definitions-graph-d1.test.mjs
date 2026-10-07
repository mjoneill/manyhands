/**
 * #1624 K13, THE DEFINITIONS: procedures (with their versions) and runs, models, predicates and kinds. Same template as the wake and roles/obligations rows: REST with a REAL executor behind a proxy, type-agnostic (each entity is found by a
 * marker in its text), written by the separate test author BEFORE the build, synthetic content. Without a python with pyoxigraph the unit-on rows are SKIPPED, and a skip is NOT a pass. `UNIT_ENV` is the one switch the build names
 * (`SCRUM_GRAPH_UNIT_SMALLKINDS`, confirmed on #1624).
 *
 * Why these five together: they are the families whose guards the document gets FOR FREE from `withWriteLock` (read, check, write, one critical section), and which a generic `entity.put` with no lock does not. Three guards matter because
 * their loss is silent damage, not a wrong status:
 *   - a procedure version's NUMBER is `count of existing versions + 1`; two concurrent revisions must be v2 and v3, never both v2 and never one lost (a past run names a version, so a duplicate or lost version re-attributes method);
 *   - a model key (and a predicate or kind name) is ONE identity; two concurrent registrations must be one 201 and one 409 (or one 201 and one revision), never two nodes (a second model "would fork its probe history");
 *   - a revision keeps the ORIGINAL registrant (#1477) and a procedure version leaves the procedure identity untouched.
 * The rest are pinned by PARITY OF ANSWERS AND REFUSALS, as in the roles rows: one script of legal and refused operations goes to a unit-off and a unit-on server; every status and masked wire must be equal.
 *
 *   D0  CONTROL (green today): the unit-off server answers every step of the three scripts as listed below.
 *   D1  PARITY: the same three scripts on a unit-on server answer the same statuses and masked wire (uuids and times masked, plain lists compared as sets), and the lists read back afterwards are equal.
 *   D2  THE GRAPH HOLDS THEM, THE DOCUMENT DOES NOT: after the scripts the executor's store holds a marker from each family and the board file holds none.
 *   D3  CONCURRENCY KEEPS THE IDENTITY: six concurrent procedure versions are v2..v7 and all listed, once each; two concurrent registrations of one model key are exactly [201, 409] and one model; two concurrent registrations of one predicate
 *       name are one 201, one 200 and one entity. (Unit-off is the control: the document's lock makes it true today.)
 *   D4  FAIL LOUD, AND THE GUARDS THAT NEED NO STORE STILL REFUSE: with the executor away every create or register answers 503 (never 201), every list 503 (never an empty list), a malformed request is still a 400; back, the creates land once.
 *
 * SCRIPTS. PROCEDURES AND RUNS: create (201); no `by`, no name, no body (400); revise by name (201, v2); revise an unknown procedure, no body (400); a run with a `performedUsing` that is no version (400); an EVENT op (400); a run that USES an
 * outside URL (201, kept as a literal); a run that names participants; `generated` that resolves (200), that dangles (400), on an unknown run (400), with no nodes (400); lists, and the `op` filter. MODELS: create (201); a twin key (409); bad key,
 * no model, bad protocol, a key-shaped secret field, a lowercase `apiKeyRef`, a negative cost (all 400); patch (200), patch an unknown key (404); list and the provider filter. PREDICATES AND KINDS: register (201); re-register by another seat
 * (200, same registrant, new reviser); a bad name, no definition, no `by`, a kind definition under 40 characters, a kind with no `createdBy` (all 400); lists.
 *
 * NOT COVERED, by name: agents and agent prompts (their own rows: the rest/retire write releases claimed cards in the same update); runs/generated against a memory or decision (only cards are used); the admin-only authority on predicate and
 * kind registration (#1559, a different harness); the model probe route; migration of the existing rows (its read-back compares them by id and field); the ORDER of a plain list (compared as a set: wire order is not a contract these rows pin).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const UNIT_ENV = 'SCRUM_GRAPH_UNIT_SMALLKINDS';
const ROSTER_FILE = path.join(os.tmpdir(), `d1k-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, gizmo: { name: 'Gizmo', glyph: 'g', color: '#c4a07c' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(40000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const ALNUM = () => `${process.pid}x${Date.now().toString(36)}`.replace(/[^a-z0-9]/gi, '');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g;
/** mask what legitimately differs between servers: uuids (inside any string, ids and IRIs alike) and timestamps */
const maskDeep = (v) => {
  if (typeof v === 'string') return v.replace(UUID, '<uuid>').replace(ISO, '<time>');
  if (Array.isArray(v)) return v.map(maskDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x)]));
  return v;
};
const asSet = (v) => (Array.isArray(v) ? [...v].map((x) => JSON.stringify(maskDeep(x))).sort() : maskDeep(v));

async function startProxy(execUrl) {
  const p = {};
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
    try { const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }); const t = await f.text(); res.statusCode = f.status; res.end(t); } catch { try { req.socket.destroy(); } catch { /* gone */ } }
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r)); p.port = p.server.address().port; p.url = `http://127.0.0.1:${p.port}`;
  p.down = () => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); });
  p.up = () => new Promise((r, j) => { p.server.once('error', j); p.server.listen(p.port, '127.0.0.1', r); });
  return p;
}
async function unitOn(body, dsid = 'd1k-test') {
  const exec = await startExecutor({ store: tmpStore('d1k-store-'), datasetId: dsid, create: true });
  const proxy = await startProxy(exec.baseUrl);
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', [UNIT_ENV]: '1' } });
  try { return await body({ base: rest.baseUrl, rest, proxy, exec }); } finally { await rest.stop(); try { await proxy.down(); } catch { /* down */ } await killExecutor(exec); }
}
async function holders(execUrl, needle) {
  const res = await fetch(`${execUrl}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query' }, body: `SELECT ?s ?p WHERE { { ?s ?p ?o FILTER(isLiteral(?o) && CONTAINS(STR(?o), ${JSON.stringify(needle)})) } UNION { GRAPH ?g { ?s ?p ?o FILTER(isLiteral(?o) && CONTAINS(STR(?o), ${JSON.stringify(needle)})) } } }`, signal: AbortSignal.timeout(30000) });
  assert.equal(res.status, 200, 'the store scan is answered'); return (await res.json()).results.bindings.length;
}
const record = (out) => (label, r) => out.push([label, r.status, r.body && typeof r.body === 'object' ? (Array.isArray(r.body) ? asSet(r.body) : maskDeep(r.body)) : null]);

/** procedures and runs */
async function procScript(base, tag) {
  const out = []; const rec = record(out);
  const card = (await api(base, 'POST', '/api/cards', { title: `${tag} what the run made`, description: 'x', createdBy: 'ada' })).body;
  const good = { by: 'ada', name: `${tag} method`, body: `${tag} step one, then step two` };
  const created = await api(base, 'POST', '/api/procedures', good); rec('create', created);
  rec('create no by', await api(base, 'POST', '/api/procedures', { name: 'n', body: 'b' }));
  rec('create no name', await api(base, 'POST', '/api/procedures', { by: 'ada', body: 'b' }));
  rec('create no body', await api(base, 'POST', '/api/procedures', { by: 'ada', name: 'n' }));
  rec('revise by name', await api(base, 'POST', '/api/procedure-versions', { by: 'gizmo', procedure: good.name, body: `${tag} revised: step one, then step two, then check` }));
  rec('revise unknown', await api(base, 'POST', '/api/procedure-versions', { by: 'ada', procedure: 'no such method', body: 'b' }));
  rec('revise no body', await api(base, 'POST', '/api/procedure-versions', { by: 'ada', procedure: good.name }));
  const verId = created.body?.version?.id;
  rec('run bad performedUsing', await api(base, 'POST', '/api/runs', { by: 'ada', op: 'research', performedUsing: 'https://scrumboard.local/procedure-version/none' }));
  rec('run event op', await api(base, 'POST', '/api/runs', { by: 'ada', op: 'create' }));
  rec('run no op', await api(base, 'POST', '/api/runs', { by: 'ada' }));
  const run = await api(base, 'POST', '/api/runs', { by: 'ada', op: 'research', performedUsing: verId, used: ['https://example.invalid/outside-source'], participants: ['gizmo'] }); rec('run create', run);
  rec('run create plain', await api(base, 'POST', '/api/runs', { by: 'gizmo', op: 'review' }));
  const runId = run.body?.id;
  rec('generated resolves', await api(base, 'POST', '/api/runs/generated', { by: 'ada', run: runId, nodes: [card.shortId] }));
  rec('generated dangles', await api(base, 'POST', '/api/runs/generated', { by: 'ada', run: runId, nodes: ['no-such-node'] }));
  rec('generated unknown run', await api(base, 'POST', '/api/runs/generated', { by: 'ada', run: 'https://scrumboard.local/run/none', nodes: [card.shortId] }));
  rec('generated no nodes', await api(base, 'POST', '/api/runs/generated', { by: 'ada', run: runId }));
  rec('list procedures', await api(base, 'GET', '/api/procedures'));
  rec('list runs', await api(base, 'GET', '/api/runs'));
  rec('list runs op=research', await api(base, 'GET', '/api/runs?op=research'));
  return out;
}
/** models */
async function modelScript(base, tag) {
  const out = []; const rec = record(out);
  const key = `d1-${tag.toLowerCase()}`; const good = { by: 'ada', key, model: `${tag}-model:1b`, protocol: 'ollama-native', provider: `p-${tag.toLowerCase()}`, costIn: 0.5, costOut: 1.5, capabilities: ['tools'] };
  rec('create', await api(base, 'POST', '/api/models', good));
  rec('create twin', await api(base, 'POST', '/api/models', { ...good, costIn: 9 }));
  rec('create bad key', await api(base, 'POST', '/api/models', { ...good, key: 'Not A Key!' }));
  rec('create no model', await api(base, 'POST', '/api/models', { by: 'ada', key: `${key}b`, protocol: 'ollama-native' }));
  rec('create bad protocol', await api(base, 'POST', '/api/models', { ...good, key: `${key}c`, protocol: 'carrier-pigeon' }));
  rec('create secret field', await api(base, 'POST', '/api/models', { ...good, key: `${key}d`, apiToken: 'sk-synthetic-not-real' }));
  rec('create lowercase apiKeyRef', await api(base, 'POST', '/api/models', { ...good, key: `${key}e`, apiKeyRef: 'a-real-looking-value' }));
  rec('create negative cost', await api(base, 'POST', '/api/models', { ...good, key: `${key}f`, costIn: -1 }));
  rec('patch', await api(base, 'PATCH', `/api/models/${key}`, { by: 'gizmo', costOut: 2.5, apiKeyRef: 'D1_SYNTHETIC_KEY_NAME' }));
  rec('patch unknown', await api(base, 'PATCH', '/api/models/no-such-model', { by: 'ada', costOut: 1 }));
  rec('list', await api(base, 'GET', '/api/models'));
  rec('list provider', await api(base, 'GET', `/api/models?provider=p-${tag.toLowerCase()}`));
  return out;
}
/** predicates and kinds */
async function vocabScript(base, tag) {
  const out = []; const rec = record(out);
  const pname = `scrum:d1p${tag}`; const kname = `scrum:D1k${tag}`;
  const pdef = `${tag} what asserting this predicate means in these rows`; const kdef = `${tag} is a kind used only by these rows and it stands for nothing real at all`;
  rec('predicate register', await api(base, 'POST', '/api/predicates', { by: 'ada', name: pname, definition: pdef }));
  rec('predicate revise by another seat', await api(base, 'POST', '/api/predicates', { by: 'gizmo', name: pname, definition: `${pdef}, revised` }));
  rec('predicate bad name', await api(base, 'POST', '/api/predicates', { by: 'ada', name: 'unprefixed', definition: pdef }));
  rec('predicate no definition', await api(base, 'POST', '/api/predicates', { by: 'ada', name: `${pname}b` }));
  rec('predicate no by', await api(base, 'POST', '/api/predicates', { name: `${pname}c`, definition: pdef }));
  rec('kind register', await api(base, 'POST', '/api/kinds', { by: 'ada', name: kname, definition: kdef, createdBy: 'a_verb' }));
  rec('kind revise by another seat', await api(base, 'POST', '/api/kinds', { by: 'gizmo', name: kname, definition: `${kdef}, revised`, createdBy: 'a_verb' }));
  rec('kind bad name', await api(base, 'POST', '/api/kinds', { by: 'ada', name: 'scrum:lowercase', definition: kdef, createdBy: 'a_verb' }));
  rec('kind short definition', await api(base, 'POST', '/api/kinds', { by: 'ada', name: `${kname}b`, definition: 'too short', createdBy: 'a_verb' }));
  rec('kind no createdBy', await api(base, 'POST', '/api/kinds', { by: 'ada', name: `${kname}c`, definition: kdef }));
  rec('predicates list', await api(base, 'GET', '/api/predicates'));
  rec('kinds list', await api(base, 'GET', '/api/kinds'));
  return out;
}
const scripts = async (base, tag) => ({ proc: await procScript(base, tag), model: await modelScript(base, tag), vocab: await vocabScript(base, tag) });

test('D0 CONTROL: with the unit OFF every step of the three scripts answers as listed in the header', { timeout: 180000 }, async () => {
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const t = ALNUM(); const s = await scripts(rest.baseUrl, t);
    const st = (arr) => Object.fromEntries(arr.map(([l, c]) => [l, c]));
    const p = st(s.proc); const m = st(s.model); const v = st(s.vocab);
    assert.deepEqual([p.create, p['create no by'], p['create no name'], p['create no body'], p['revise by name'], p['revise unknown'], p['revise no body']], [201, 400, 400, 400, 201, 400, 400]);
    assert.deepEqual([p['run bad performedUsing'], p['run event op'], p['run no op'], p['run create'], p['run create plain'], p['generated resolves'], p['generated dangles'], p['generated unknown run'], p['generated no nodes']], [400, 400, 400, 201, 201, 200, 400, 400, 400]);
    assert.deepEqual([m.create, m['create twin'], m['create bad key'], m['create no model'], m['create bad protocol'], m['create secret field'], m['create lowercase apiKeyRef'], m['create negative cost'], m.patch, m['patch unknown']], [201, 409, 400, 400, 400, 400, 400, 400, 200, 404]);
    assert.deepEqual([v['predicate register'], v['predicate revise by another seat'], v['predicate bad name'], v['predicate no definition'], v['predicate no by'], v['kind register'], v['kind revise by another seat'], v['kind bad name'], v['kind short definition'], v['kind no createdBy']], [201, 200, 400, 400, 400, 201, 200, 400, 400, 400]);
    const pred = (await api(rest.baseUrl, 'GET', '/api/predicates')).body.find((x) => x.name === `scrum:d1p${t}`);
    assert.equal(pred.registeredBy, 'ada', 'a revision keeps the original registrant'); assert.equal(pred.revisedBy, 'gizmo');
  } finally { await rest.stop(); }
});

test('D1 PARITY: the three scripts on a unit-on server answer the same statuses and masked wire as the unit-off server', { skip: SKIP, timeout: 300000 }, async () => {
  const off = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const tag = ALNUM(); const expected = await scripts(off.baseUrl, tag);
    await unitOn(async ({ base }) => {
      const got = await scripts(base, tag);
      for (const fam of ['proc', 'model', 'vocab']) assert.deepEqual(got[fam], expected[fam], `${fam}: every answer equals the unit-off answer`);
    });
  } finally { await off.stop(); }
});

test('D2 THE GRAPH HOLDS THEM, THE DOCUMENT DOES NOT: a marker from each family is in the executor and not in the board file', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, rest, exec }) => {
    const tag = ALNUM(); await scripts(base, tag);
    const file = JSON.stringify(rest.readBoardFile());
    for (const [family, needle] of [['procedure body', `${tag} step one, then step two`], ['procedure revision', `${tag} revised: step one`], ['model', `${tag}-model:1b`], ['predicate', `${tag} what asserting this predicate means`], ['kind', `${tag} is a kind used only by these rows`]]) {
      assert.ok(await holders(exec.baseUrl, needle) >= 1, `${family}: the executor store holds it`);
      assert.ok(!file.includes(needle), `${family}: and the board file does not`);
    }
  });
});

async function concurrency(base, tag) {
  const out = {};
  const proc = (await api(base, 'POST', '/api/procedures', { by: 'ada', name: `${tag} concurrent method`, body: 'v1 text' })).body;
  const vs = await Promise.all([2, 3, 4, 5, 6, 7].map((n) => api(base, 'POST', '/api/procedure-versions', { by: 'ada', procedure: proc.id, body: `${tag} concurrent revision ${n}` })));
  out.versionStatuses = vs.map((r) => r.status);
  const listed = ((await api(base, 'GET', '/api/procedures')).body ?? []).find((p) => p.id === proc.id);
  out.versionNames = (listed?.versions ?? []).map((v) => v.name).sort();
  out.versionBodies = (listed?.versions ?? []).map((v) => v.body).filter((b) => String(b).startsWith(`${tag} concurrent revision`)).sort();
  const key = `d1-race-${tag.toLowerCase()}`;
  const ms = await Promise.all([1, 2].map((n) => api(base, 'POST', '/api/models', { by: n === 1 ? 'ada' : 'gizmo', key, model: `${tag}-race-${n}`, protocol: 'ollama-native' })));
  out.modelStatuses = ms.map((r) => r.status).sort();
  out.modelCount = ((await api(base, 'GET', `/api/models?key=${key}`)).body ?? []).length;
  const pname = `scrum:d1race${tag}`;
  const ps = await Promise.all([1, 2].map((n) => api(base, 'POST', '/api/predicates', { by: n === 1 ? 'ada' : 'gizmo', name: pname, definition: `${tag} racing definition ${n}` })));
  out.predicateStatuses = ps.map((r) => r.status).sort();
  out.predicateCount = ((await api(base, 'GET', '/api/predicates')).body ?? []).filter((p) => p.name === pname).length;
  return out;
}
const expectConcurrent = (c, tag) => {
  assert.deepEqual(c.versionStatuses, [201, 201, 201, 201, 201, 201], 'all six concurrent revisions are accepted');
  assert.deepEqual(c.versionNames, [`${tag} concurrent method v1`, ...[2, 3, 4, 5, 6, 7].map((n) => `${tag} concurrent method v${n}`)], 'the versions are v1..v7, each number ONCE (never two v2, never one lost)');
  assert.equal(c.versionBodies.length, 6, 'and all six revision texts are stored');
  assert.deepEqual(c.modelStatuses, [201, 409], 'two concurrent registrations of one model key are one 201 and one 409');
  assert.equal(c.modelCount, 1, 'and there is ONE model (a second would fork its probe history)');
  assert.deepEqual(c.predicateStatuses, [200, 201], 'two concurrent registrations of one predicate name are one 201 and one revision');
  assert.equal(c.predicateCount, 1, 'and there is ONE predicate entity');
};

test('D3 CONCURRENCY KEEPS THE IDENTITY (unit OFF is the control): six versions v1..v7 once each, one model key, one predicate name', { timeout: 180000 }, async () => {
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try { const tag = ALNUM(); expectConcurrent(await concurrency(rest.baseUrl, tag), tag); } finally { await rest.stop(); }
});

test('D3b CONCURRENCY KEEPS THE IDENTITY (unit ON): the same, through the graph', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base }) => { const tag = ALNUM(); expectConcurrent(await concurrency(base, tag), tag); });
});

test('D4 FAIL LOUD: executor away: every create/register 503 and every list 503, a malformed request still 400; back: the creates land once', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, proxy }) => {
    const tag = ALNUM();
    assert.equal((await api(base, 'POST', '/api/procedures', { by: 'ada', name: `${tag} before`, body: 'text before' })).status, 201, 'CONTROL: a procedure is created while the executor is up');
    await proxy.down();
    const procs = await api(base, 'POST', '/api/procedures', { by: 'ada', name: `${tag} during`, body: 'text during' });
    const attempts = [
      ['procedure create', procs],
      ['version create', await api(base, 'POST', '/api/procedure-versions', { by: 'ada', procedure: `${tag} before`, body: 'revised during' })],
      ['run create', await api(base, 'POST', '/api/runs', { by: 'ada', op: 'research' })],
      ['model create', await api(base, 'POST', '/api/models', { by: 'ada', key: `d1-down-${tag.toLowerCase()}`, model: 'm', protocol: 'ollama-native' })],
      ['predicate register', await api(base, 'POST', '/api/predicates', { by: 'ada', name: `scrum:d1down${tag}`, definition: 'registered while the executor is away' })],
      ['kind register', await api(base, 'POST', '/api/kinds', { by: 'ada', name: `scrum:D1down${tag}`, definition: 'registered while the executor is away, which must not be implied', createdBy: 'a_verb' })],
    ];
    for (const [label, r] of attempts) assert.equal(r.status, 503, `${label} with the executor away is a 503, never a 201 (${r.status} ${r.text.slice(0, 120)})`);
    for (const route of ['/api/procedures', '/api/runs', '/api/models', '/api/predicates', '/api/kinds']) { const l = await api(base, 'GET', route); assert.equal(l.status, 503, `GET ${route} with the executor away is a 503, never an empty list (${l.status})`); }
    assert.equal((await api(base, 'POST', '/api/procedures', { by: 'ada', name: 'n' })).status, 400, 'a malformed request is still a 400, on its own grounds');
    assert.equal((await api(base, 'POST', '/api/predicates', { by: 'ada', name: 'unprefixed', definition: 'd' })).status, 400, 'including a malformed predicate name');
    await sleep(500); await proxy.up();
    assert.equal((await api(base, 'POST', '/api/procedures', { by: 'ada', name: `${tag} after`, body: 'text after' })).status, 201, 'back: a create lands');
    const names = ((await api(base, 'GET', '/api/procedures')).body ?? []).map((p) => p.name);
    assert.ok(names.includes(`${tag} before`) && names.includes(`${tag} after`), `and the list shows the earlier and the later ones (${JSON.stringify(names)})`);
    assert.ok(!names.includes(`${tag} during`), 'but not the one refused while the executor was away');
  });
});
