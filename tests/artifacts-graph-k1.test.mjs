/**
 * #1624 K13, ARTIFACTS. The one small kind whose write crosses TWO entities: adding an artifact appends it AND adds its id to a run's `prov:generated`, in one locked write, and refuses a run that does not exist. Same template as the other K13 rows: REST with a REAL
 * executor behind a proxy, type-agnostic (the artifact is found by a marker in its `contentUrl`), a unit-off server as the oracle, written by the separate test author BEFORE the build, synthetic content. Without a python with pyoxigraph the unit-on rows are SKIPPED, and
 * a skip is NOT a pass. `UNIT_ENV` is the one switch the build names (`SCRUM_GRAPH_UNIT_SMALLKINDS`). There is no route that LISTS artifacts, so the observable effects are the 201 answer and the run's `generated` list in `GET /api/runs`.
 *
 *   AR0  CONTROL (green today): with the unit OFF, an artifact is created (201, wire `{id, name, contentUrl, encodingFormat, contentHash, run}`, the default name the last path segment of the URL); no `by`, no `contentUrl`, a body over 4,096 bytes, and an unknown
 *        run are all 400 and change nothing; the run's `generated` then lists exactly the artifacts that were created; six concurrent artifacts for one run are all accepted, distinct, and all listed (the document's lock makes it true).
 *   AR1  PARITY: the same script on a unit-on server answers the same statuses and the same masked wire, and the run lists agree.
 *   AR2  THE GRAPH HOLDS IT, THE DOCUMENT DOES NOT: after the script the executor holds a marker from an artifact's `contentUrl` and the board file does not.
 *   AR3  ONE WRITE ACROSS TWO ENTITIES (unit on): six concurrent artifacts for one run are all accepted, have six distinct ids, and ALL SIX are in the run's `generated` (no lost update: the two entities move together or not at all).
 *   AR4  FAIL LOUD AND ALL-OR-NOTHING (unit on): with the executor away, creating an artifact answers 503 (never 201) and, once the executor is back, the run's `generated` is UNCHANGED (no artifact without its link to the run, no link without its artifact); back, the
 *        same create lands once.
 *
 * NOT COVERED, by name: the artifact written for a run that lives in the document and not the graph (the families move together under one switch; a mixed state is the migration's); the 4,096-byte limit at the boundary (4,097 is used); `contentHash` verification (stored verbatim, never checked); migration of existing artifacts (its read-back compares them by id and field).
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
const ROSTER_FILE = path.join(os.tmpdir(), `ar1k-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, gizmo: { name: 'Gizmo', glyph: 'g', color: '#c4a07c' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(40000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const ALNUM = () => `${process.pid}x${Date.now().toString(36)}`.replace(/[^a-z0-9]/gi, '').toLowerCase();
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g; const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g;
const maskDeep = (v) => { if (typeof v === 'string') return v.replace(UUID, '<uuid>').replace(ISO, '<time>'); if (Array.isArray(v)) return v.map(maskDeep); if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x)])); return v; };
const record = (out) => (label, r) => out.push([label, r.status, r.body && typeof r.body === 'object' ? maskDeep(r.body) : null]);

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
async function unitOn(body, dsid = 'ar1k-test') {
  const exec = await startExecutor({ store: tmpStore('ar1k-store-'), datasetId: dsid, create: true });
  const proxy = await startProxy(exec.baseUrl);
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', [UNIT_ENV]: '1' } });
  try { return await body({ base: rest.baseUrl, rest, proxy, exec }); } finally { await rest.stop(); try { await proxy.down(); } catch { /* down */ } await killExecutor(exec); }
}
async function holders(execUrl, needle) {
  const res = await fetch(`${execUrl}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query' }, body: `SELECT ?s ?p WHERE { { ?s ?p ?o FILTER(isLiteral(?o) && CONTAINS(STR(?o), ${JSON.stringify(needle)})) } UNION { GRAPH ?g { ?s ?p ?o FILTER(isLiteral(?o) && CONTAINS(STR(?o), ${JSON.stringify(needle)})) } } }`, signal: AbortSignal.timeout(30000) });
  assert.equal(res.status, 200, 'the store scan is answered'); return (await res.json()).results.bindings.length;
}
const generatedOf = async (base, runId) => { const runs = (await api(base, 'GET', '/api/runs')).body ?? []; const r = runs.find((x) => x.id === runId); return r ? (r.generated ?? []) : null; };
const mkRun = async (base, tag) => { const r = await api(base, 'POST', '/api/runs', { by: 'ada', op: 'research' }); assert.equal(r.status, 201, `a run is created (${r.status} ${r.text.slice(0, 100)})`); return r.body.id; };

async function artifactScript(base, tag) {
  const out = []; const rec = record(out); const runId = await mkRun(base, tag);
  const url = (n) => `https://example.invalid/${tag}/file-${n}.txt`;
  rec('create', await api(base, 'POST', '/api/artifacts', { by: 'ada', run: runId, contentUrl: url(1), encodingFormat: 'text/plain', contentHash: `sha256:${tag}` }));
  rec('create minimal', await api(base, 'POST', '/api/artifacts', { by: 'gizmo', run: runId, contentUrl: url(2) }));
  rec('create no by', await api(base, 'POST', '/api/artifacts', { run: runId, contentUrl: url(3) }));
  rec('create no contentUrl', await api(base, 'POST', '/api/artifacts', { by: 'ada', run: runId }));
  rec('create body over the limit', await api(base, 'POST', '/api/artifacts', { by: 'ada', run: runId, contentUrl: url(4), body: 'x'.repeat(4097) }));
  rec('create unknown run', await api(base, 'POST', '/api/artifacts', { by: 'ada', run: 'https://scrumboard.local/run/none', contentUrl: url(5) }));
  rec('create no run', await api(base, 'POST', '/api/artifacts', { by: 'ada', contentUrl: url(6) }));
  const gen = await generatedOf(base, runId); out.push(['generated count', 200, gen ? gen.length : null]);
  return { out, runId };
}

test('AR0 CONTROL: with the unit OFF the artifact script answers as listed and concurrent artifacts for one run are all kept', { timeout: 180000 }, async () => {
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const tag = ALNUM(); const { out, runId } = await artifactScript(rest.baseUrl, tag); const s = Object.fromEntries(out.map(([l, c, b]) => [l, c]));
    assert.deepEqual([s.create, s['create minimal'], s['create no by'], s['create no contentUrl'], s['create body over the limit'], s['create unknown run'], s['create no run']], [201, 201, 400, 400, 400, 400, 400]);
    const created = out.find(([l]) => l === 'create')[2]; assert.deepEqual(Object.keys(created).sort(), ['contentHash', 'contentUrl', 'encodingFormat', 'id', 'name', 'run'].sort(), `the wire: ${JSON.stringify(Object.keys(created))}`);
    assert.equal(out.find(([l]) => l === 'create minimal')[2].name, 'file-2.txt', 'the default name is the last path segment');
    assert.equal(out.find(([l]) => l === 'generated count')[2], 2, 'the run lists exactly the two artifacts that were created');
    const rs = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => api(rest.baseUrl, 'POST', '/api/artifacts', { by: 'ada', run: runId, contentUrl: `https://example.invalid/${tag}/concurrent-${n}` })));
    assert.deepEqual(rs.map((r) => r.status), [201, 201, 201, 201, 201, 201]); assert.equal(new Set(rs.map((r) => r.body.id)).size, 6, 'six distinct ids');
    const gen = await generatedOf(rest.baseUrl, runId); assert.equal(gen.length, 8, `all six concurrent artifacts and the two earlier ones are listed (${gen.length})`); for (const r of rs) assert.ok(gen.includes(r.body.id), 'each concurrent artifact is in the run\'s generated list');
  } finally { await rest.stop(); }
});

test('AR1 PARITY: the artifact script on a unit-on server answers the same statuses and masked wire as the unit-off server', { skip: SKIP, timeout: 300000 }, async () => {
  const off = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try { const tag = ALNUM(); const { out: expected } = await artifactScript(off.baseUrl, tag); await unitOn(async ({ base }) => { const { out } = await artifactScript(base, tag); assert.deepEqual(out, expected, 'every answer equals the unit-off answer'); }); } finally { await off.stop(); }
});

test('AR2 THE GRAPH HOLDS IT, THE DOCUMENT DOES NOT: a marker from an artifact\'s contentUrl is in the executor and not in the board file', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, rest, exec }) => {
    const tag = ALNUM(); await artifactScript(base, tag); const needle = `example.invalid/${tag}/file-1.txt`;
    assert.ok(await holders(exec.baseUrl, needle) >= 1, 'the executor store holds the artifact\'s URL'); assert.ok(!JSON.stringify(rest.readBoardFile()).includes(needle), 'and the board file does not');
  });
});

test('AR3 ONE WRITE ACROSS TWO ENTITIES (unit ON): six concurrent artifacts for one run are all accepted, distinct, and ALL in the run\'s generated list', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base }) => {
    const tag = ALNUM(); const runId = await mkRun(base, tag);
    const rs = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => api(base, 'POST', '/api/artifacts', { by: 'ada', run: runId, contentUrl: `https://example.invalid/${tag}/concurrent-${n}` })));
    assert.deepEqual(rs.map((r) => r.status), [201, 201, 201, 201, 201, 201], `all six are accepted (${JSON.stringify(rs.map((r) => r.status))})`); assert.equal(new Set(rs.map((r) => r.body.id)).size, 6, 'six distinct ids');
    const gen = await generatedOf(base, runId); assert.equal(gen?.length, 6, `the run lists all six (${gen?.length}): a lost update here is an artifact whose run does not know it`); for (const r of rs) assert.ok(gen.includes(r.body.id), 'each artifact is in the list');
  });
});

test('AR4 FAIL LOUD AND ALL-OR-NOTHING (unit ON): executor away: 503 and the run\'s generated list unchanged; back: the same create lands once', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async ({ base, proxy }) => {
    const tag = ALNUM(); const runId = await mkRun(base, tag);
    const first = await api(base, 'POST', '/api/artifacts', { by: 'ada', run: runId, contentUrl: `https://example.invalid/${tag}/before` }); assert.equal(first.status, 201, 'CONTROL: an artifact is created while the executor is up');
    await proxy.down();
    const w = await api(base, 'POST', '/api/artifacts', { by: 'ada', run: runId, contentUrl: `https://example.invalid/${tag}/during` });
    assert.equal(w.status, 503, `a create with the executor away is a 503, never a 201 (${w.status} ${w.text.slice(0, 100)})`);
    assert.equal((await api(base, 'POST', '/api/artifacts', { by: 'ada', contentUrl: 'x' })).status, 400, 'a malformed request is still a 400, on its own grounds');
    await sleep(500); await proxy.up();
    const gen = await generatedOf(base, runId); assert.deepEqual(gen, [first.body.id], `the run's generated list is exactly the one artifact created before: no artifact without its link, no link without its artifact (${JSON.stringify(gen)})`);
    const again = await api(base, 'POST', '/api/artifacts', { by: 'ada', run: runId, contentUrl: `https://example.invalid/${tag}/after` }); assert.equal(again.status, 201, 'back: the create lands');
    assert.equal((await generatedOf(base, runId)).length, 2, 'and the run lists the two that exist');
  });
});
