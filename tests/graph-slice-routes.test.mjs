/**
 * #1558 slice — the flagged routes on a REAL board server, with the executor it
 * owns in trial mode. Builder's dev fixtures only.
 *
 * The legacy-path counters are the M2 instrument (frozen plan v0.2/A1), so they
 * are tested from both sides here: a correction must leave every one at zero
 * for its own request, AND an old-style write must move each one, or a zero
 * would mean nothing.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startRestServer, freePort, PROJECT_DIR } from './helpers/harness.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';

// #1559: graph writes need an enforced, bound seat whose actor is urn:ex:seat/<seat>.
// The tests write as real seats under SCRUM_AUTH=required; `admin` may create grants and rules.
const TOK = { bob: mintToken(), nobody: mintToken(), admin: mintToken() };
function tokensFile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-tok-'));
  const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  const cred = (plain) => ({ tokenHash: hashToken(plain), scope: 'admin', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null });
  const f = path.join(d, 'seat-tokens.json');
  fs.writeFileSync(f, JSON.stringify({ seats: Object.fromEntries(Object.entries(TOK).map(([k, v]) => [k, { credentials: [cred(v)] }])) }));
  return f;
}
const seatOf = (actor) => (typeof actor === 'string' && actor.startsWith('urn:ex:seat/') ? actor.slice('urn:ex:seat/'.length) : 'bob');
const authed = (seat = 'bob', headers = {}) => ({ ...headers, authorization: `Bearer ${TOK[seat]}` });

const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(PROJECT_DIR, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;

let server, base, execUrl, store;
let n = 0;
const fresh = (p) => `urn:ex:${p}/${++n}`;
const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: authed(seatOf(body?.actor), { 'content-type': 'application/json' }), body: JSON.stringify(body) });
const get = (p) => fetch(`${base}${p}`, { headers: authed() });
const counters = async () => (await (await get('/api/trial/counters')).json());
const ZERO = { saveDomain: 0, loadDomain: 0, loadDomainShared: 0, structuredClone: 0, graphReplicaSync: 0, writeBoard: 0, appendEvent: 0 };

async function waitExecutor() {
  for (let i = 0; i < 100; i++) {
    const c = await counters();
    if (c.executor) return c;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('trial executor never came up');
}

before(async () => {
  if (SKIP) return;
  store = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-store-'));
  // initialise the trial store's marker once, then hand it to the server to own
  const init = spawnSync(PY, ['-c', `
import pyoxigraph as px
s = px.Store(${JSON.stringify(store)})
s.update('INSERT DATA { <urn:ex:dataset> <urn:ex:datasetId> "trial-routes" ; <urn:ex:epoch> 1 ; <urn:ex:commitSeq> 0 }')
s.flush()`]);
  assert.equal(init.status, 0, String(init.stderr));
  execUrl = `http://127.0.0.1:${await freePort()}`;
  server = await startRestServer({ env: {
    SCRUM_GRAPH_EXECUTOR_URL: execUrl,
    SCRUM_GRAPH_DATASET_ID: 'trial-routes',
    SCRUM_TRIAL_EXECUTOR_STORE: store,
    GRAPH_EXECUTOR_PYTHON: PY,
    SCRUM_SEAT_TOKENS: tokensFile(),
    SCRUM_AUTH: 'required',
    SCRUM_GRAPH_GRANT_ADMINS: 'admin',
  } });
  base = server.baseUrl;
  await waitExecutor();
  // seed through the public seeding routes, the way the scorer will
  const admin = 'urn:ex:seat/admin';
  for (const [route, body] of [
    ['/api/graph/rule', { kind: 'rule', opId: 'urn:ex:op/seed-r', actor: admin, rule: { iri: 'urn:ex:R1' } }],
    ['/api/graph/grant', { kind: 'grant', opId: 'urn:ex:op/seed-g', actor: admin, grant: { iri: 'urn:ex:G1', grantee: 'urn:ex:seat/bob', scope: 'urn:ex:scopeX', mayRetire: true, rev: '1' } }],
    ['/api/graph/assert', { kind: 'assertion', opId: 'urn:ex:op/seed-a', actor: 'urn:ex:seat/bob',
      newAssertion: { iri: 'urn:ex:A1', subject: 'urn:ex:topic1', predicate: 'urn:ex:policy', value: { type: 'literal', value: 'old' }, scope: 'urn:ex:scopeX' },
      authority: { grant: 'urn:ex:G1', grantRev: '1', rule: 'urn:ex:R1', ruleRev: '1' } }],
  ]) {
    const r = await (await post(route, body)).json();
    assert.equal(r.outcome, 'APPLIED', `${route}: ${r.reason}`);
  }
});
after(async () => { await server?.stop(); });

const correction = (expectedVersion) => ({
  kind: 'correction', opId: fresh('op'), actor: 'urn:ex:seat/bob',
  targets: [{ iri: 'urn:ex:A1', expectedVersion }],
  newAssertion: { iri: fresh('N'), subject: 'urn:ex:topic1', predicate: 'urn:ex:policy', value: { type: 'literal', value: 'new' }, scope: 'urn:ex:scopeX' },
  authority: { grant: 'urn:ex:G1', grantRev: '1', rule: 'urn:ex:R1', ruleRev: '1' },
});

test('#1558 a correction through the route is APPLIED and touches NO legacy path in its own request', { skip: SKIP }, async () => {
  const g0 = (await counters()).legacy;
  const r = await (await post('/api/graph/correct', correction('1'))).json();
  assert.equal(r.outcome, 'APPLIED', r.reason);
  assert.deepEqual(r.legacy ?? ZERO, ZERO, 'request-scoped counters');
  // and process-wide, on a server doing nothing else
  const g1 = (await counters()).legacy;
  for (const k of Object.keys(ZERO)) assert.equal(g1[k] - g0[k], 0, `process-wide ${k}`);
});

test('#1558 SENSITIVITY: an old-style card write moves the legacy counters (so a zero means something)', { skip: SKIP }, async () => {
  const g0 = (await counters()).legacy;
  const r = await post('/api/cards', { title: 'fabricated trial card (counter control)' });
  assert.equal(r.status, 201);
  await (await get('/api/cards')).text();                                                       // a read: loadDomainShared
  await fetch(`${base}/api/graph`, { method: 'POST', headers: authed('bob', { 'content-type': 'application/json' }), body: JSON.stringify({ query: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1' }) });  // the replica sync
  const g1 = (await counters()).legacy;
  for (const k of ['saveDomain', 'loadDomain', 'structuredClone', 'graphReplicaSync', 'writeBoard', 'appendEvent']) {
    assert.ok(g1[k] - g0[k] >= 1, `${k} did not move (${g0[k]} → ${g1[k]})`);
  }
});

test('#1558 each write route takes only its own kind', { skip: SKIP }, async () => {
  const r = await post('/api/graph/assert', correction('2'));
  assert.equal(r.status, 400);
  assert.match((await r.json()).reason, /takes kind "assertion"/);
});

test('#1558 authority route: no resolver installed → 503 UNAVAILABLE, never an empty answer', { skip: SKIP }, async () => {
  if (fs.existsSync(path.join(PROJECT_DIR, 'core', 'authority-resolver.mjs'))) return;   // once installed, its own tests own this route
  const r = await fetch(`${base}/api/graph/authority?topic=urn:ex:topic1&predicate=urn:ex:policy&scope=urn:ex:scopeX`);
  assert.equal(r.status, 503);
  assert.equal((await r.json()).status, 'UNAVAILABLE');
});

test('#1558 authority route: the installed resolver answers through the server, and UNAVAILABLE when the executor is down', { skip: SKIP }, async () => {
  if (!fs.existsSync(path.join(PROJECT_DIR, 'core', 'authority-resolver.mjs'))) return;
  const q = 'topic=urn:ex:topic1&predicate=urn:ex:policy&scope=urn:ex:scopeX';
  const r = await get(`/api/graph/authority?${q}`);
  assert.equal(r.status, 200);
  const env = await r.json();
  // the first test corrected A1 into a fresh assertion under the seeded grant and rule
  assert.equal(env.status, 'CURRENT', env.reason);
  assert.match(env.reason, /^governing: /);
  assert.ok(env.retirements.some((x) => x.target === 'urn:ex:A1'), 'the retirement is explained in the same envelope');
  assert.equal(env.observedRevision.datasetId, 'trial-routes');
  assert.ok(env.evaluationTime, 'the server supplied an explicit evaluation time');
  assert.ok(Object.prototype.hasOwnProperty.call(env, 'legacy'), 'legacy is a request-scoped own property of every authority envelope');
  assert.equal(env.legacy ?? null, null, 'no legacy path touched by the authority read');
  assert.equal((await post('/api/trial/executor/stop', {})).status, 200);
  const down = await (await get(`/api/graph/authority?${q}`)).json();
  assert.equal(down.status, 'UNAVAILABLE');
  assert.equal((await post('/api/trial/executor/start', {})).status, 200);
});

// Helper asserting a D1 unavailable envelope has every D1 key — same shape the
// resolver returns on its own UNAVAILABLE branch. Driven by the exact envelope
// keys declared on core/authority-resolver.mjs:82 (status, topic, predicate,
// scope, evaluationTime, observedRevision, currentAuthorities, otherAssertions,
// retirements, governingRules, reason, completeness).
const D1_KEYS = ['status', 'topic', 'predicate', 'scope', 'evaluationTime', 'observedRevision', 'currentAuthorities', 'otherAssertions', 'retirements', 'governingRules', 'reason', 'completeness'];
const assertD1Shape = (env) => {
  for (const k of D1_KEYS) assert.ok(k in env, `missing D1 envelope key: ${k}`);
  assert.equal(env.status, 'UNAVAILABLE');
  assert.equal(env.observedRevision, null);
  assert.deepEqual(env.currentAuthorities, []);
  assert.deepEqual(env.otherAssertions, []);
  assert.deepEqual(env.retirements, []);
  assert.deepEqual(env.governingRules, []);
  assert.equal(env.completeness, 'incomplete');
};

test('#1558 D1 envelope shape: executor unreadable (stopped) returns the SAME D1 keys as resolver UNAVAILABLE, with caller evaluationTime preserved', { skip: SKIP }, async () => {
  if (!fs.existsSync(path.join(PROJECT_DIR, 'core', 'authority-resolver.mjs'))) return;
  const ET = '2026-10-04T00:00:00.000Z';
  const q = `topic=urn:ex:topic-stop&predicate=urn:ex:pred-stop&scope=urn:ex:scope-stop&evaluationTime=${encodeURIComponent(ET)}`;
  assert.equal((await post('/api/trial/executor/stop', {})).status, 200);
  try {
    const r = await get(`/api/graph/authority?${q}`);
    assert.equal(r.status, 200);
    const env = await r.json();
    assertD1Shape(env);
    assert.equal(env.topic, 'urn:ex:topic-stop');
    assert.equal(env.predicate, 'urn:ex:pred-stop');
    assert.equal(env.scope, 'urn:ex:scope-stop');
    assert.equal(env.evaluationTime, ET, 'caller-supplied evaluationTime round-trips on the executor-down branch');
    assert.match(env.reason, /^executor unreadable: /);
    assert.ok(Object.prototype.hasOwnProperty.call(env, 'legacy'), 'legacy is a request-scoped own property of every authority envelope');
    assert.equal(env.legacy ?? null, null, 'no legacy path touched by an authority read');
  } finally {
    assert.equal((await post('/api/trial/executor/start', {})).status, 200);
  }
});

test('#1558 D1 envelope shape: executor unreadable (stopped) with NO evaluationTime falls back to server-supplied ISO string', { skip: SKIP }, async () => {
  if (!fs.existsSync(path.join(PROJECT_DIR, 'core', 'authority-resolver.mjs'))) return;
  const q = 'topic=urn:ex:topic-stop2&predicate=urn:ex:pred-stop2&scope=urn:ex:scope-stop2';
  assert.equal((await post('/api/trial/executor/stop', {})).status, 200);
  try {
    const r = await get(`/api/graph/authority?${q}`);
    assert.equal(r.status, 200);
    const env = await r.json();
    assertD1Shape(env);
    assert.equal(env.topic, 'urn:ex:topic-stop2');
    assert.equal(env.predicate, 'urn:ex:pred-stop2');
    assert.equal(env.scope, 'urn:ex:scope-stop2');
    assert.match(env.evaluationTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, 'server-supplied evaluationTime is an ISO string');
    assert.match(env.reason, /^executor unreadable: /);
  } finally {
    assert.equal((await post('/api/trial/executor/start', {})).status, 200);
  }
});

test('#1558 D1 envelope shape: dataset-identity-mismatch returns the SAME D1 keys as resolver UNAVAILABLE', { skip: SKIP }, async () => {
  if (!fs.existsSync(path.join(PROJECT_DIR, 'core', 'authority-resolver.mjs'))) return;
  const { spawn } = await import('node:child_process');
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-other-env-'));
  const p = spawn(PY, [path.join(PROJECT_DIR, 'graph-executor', 'executor.py'), '--store', other, '--port', '0', '--dataset-id', 'NOT-the-trial', '--create'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const eport = await new Promise((r) => { let o = ''; p.stdout.on('data', (d) => { o += d; if (o.includes('\n')) r(JSON.parse(o).port); }); });
  const srv = await startRestServer({ env: { SCRUM_GRAPH_EXECUTOR_URL: `http://127.0.0.1:${eport}`, SCRUM_GRAPH_DATASET_ID: 'trial-x-env', GRAPH_EXECUTOR_PYTHON: PY } });
  try {
    const ET = '2026-10-04T00:00:00.000Z';
    const q = `topic=urn:ex:t-mismatch&predicate=urn:ex:p-mismatch&scope=urn:ex:s-mismatch&evaluationTime=${encodeURIComponent(ET)}`;
    const r = await fetch(`${srv.baseUrl}/api/graph/authority?${q}`);
    assert.equal(r.status, 200);
    const env = await r.json();
    assertD1Shape(env);
    assert.equal(env.topic, 'urn:ex:t-mismatch');
    assert.equal(env.predicate, 'urn:ex:p-mismatch');
    assert.equal(env.scope, 'urn:ex:s-mismatch');
    assert.equal(env.evaluationTime, ET, 'caller-supplied evaluationTime round-trips on the mismatch branch');
    assert.match(env.reason, /^dataset-identity-mismatch: refused before dispatch/);
    assert.ok(Object.prototype.hasOwnProperty.call(env, 'legacy'), 'legacy is a request-scoped own property of every authority envelope');
    assert.equal(env.legacy ?? null, null, 'no legacy path touched by an authority read');
  } finally { await srv.stop(); p.kill('SIGKILL'); }
});

// Copier for the not-installed-route fixture: copies the real core/ into .tmp
// filtering OUT ONLY core/authority-resolver.mjs (every other module —
// graph-client.mjs, legacy-counters.mjs, graph-vocab.mjs — is byte-identical).
// The copied graph-slice-routes.mjs then fails to dynamically import its sibling
// authority-resolver.mjs (ERR_MODULE_NOT_FOUND → null factory), and the real
// production authority() handler returns the D1 envelope at 503 BEFORE the
// fence runs — no host reachable. readBody is unused on this path. Names not "real
// HTTP 503": we are NOT bringing up a server; we are invoking the production route
// function in an isolated, absent-resolver fixture.
const COPY_ROOT = path.join(PROJECT_DIR, '.tmp', 'core-no-resolver');
const copyCoreExceptResolver = () => {
  fs.rmSync(COPY_ROOT, { recursive: true, force: true });
  fs.mkdirSync(COPY_ROOT, { recursive: true });
  fs.cpSync(path.join(PROJECT_DIR, 'core'), COPY_ROOT, {
    recursive: true,
    filter: (src) => path.basename(src) !== 'authority-resolver.mjs',
  });
};
// Build a fake req/res that the production route function drives directly. The
// handler calls sendJSON(res, status, body) and readBody(req) (unused on this branch).
const fakeWire = () => {
  const calls = [];
  return {
    calls,
    sendJSON: (res, status, body) => { calls.push({ res, status, body }); },
    readBody: () => { throw new Error('readBody must not be called on the not-installed branch'); },
  };
};
// Find the actual GET /api/graph/authority route registered by createGraphSlice.
const findAuthorityRoute = (slice) => {
  const r = slice.routes.find((x) => x.method === 'GET' && x.re.test('/api/graph/authority'));
  assert.ok(r, 'createGraphSlice did not register GET /api/graph/authority');
  return r;
};
// Drive the production authority() handler directly with a custom request URL,
// against the COPIED graph-slice-routes.mjs whose sibling authority-resolver.mjs
// was filtered out at copy time. Asserts the actual production route function's
// 503 + D1 envelope behaviour in an isolated absent-resolver fixture.
const driveNotInstalledRoute = async ({ baseUrl, datasetId, urlPath, query }) => {
  copyCoreExceptResolver();
  const copyRoute = path.join(COPY_ROOT, 'graph-slice-routes.mjs');
  const srcRoute = path.join(PROJECT_DIR, 'core', 'graph-slice-routes.mjs');
  // Code is unchanged in the copy: equal hashes prove we are exercising the SAME production route function.
  const srcHash = crypto.createHash('sha256').update(fs.readFileSync(srcRoute)).digest('hex');
  const copyHash = crypto.createHash('sha256').update(fs.readFileSync(copyRoute)).digest('hex');
  assert.equal(copyHash, srcHash, 'copied route file diverged from source — refactor must happen in the source, not the copy');
  // Cache-bust so a previous successful import of the real graph-slice-routes.mjs
  // does not bleed through and bring a loaded authority-resolver factory with it.
  const mod = await import(`${pathToFileURL(copyRoute).href}?absent=${process.pid}-${Date.now()}`);
  const wire = fakeWire();
  const slice = mod.createGraphSlice({
    config: { enabled: true, url: baseUrl, datasetId, trialStore: null, python: '/nonexistent', executorLog: null },
    sendJSON: wire.sendJSON,
    readBody: wire.readBody,
  });
  const route = findAuthorityRoute(slice);
  const req = { url: `${urlPath}?${query}` };
  const res = {};
  await route.fn(req, res);
  return wire;
};

test('#1558 D1 envelope shape: resolver NOT installed — production authority() handler returns 503 + the SAME D1 keys, exercised in an isolated absent-resolver fixture (no real HTTP 503, no live server)', async () => {
  // The slice file lives at core/graph-slice-routes.mjs and works under the same #1558 contract
  // whether the resolver file is on disk or not — proving the not-installed branch is the
  // PRODUCTION route function's behaviour, not a stubbed path. The COPY in .tmp is code-unchanged
  // (sha256 match above) and is missing ONLY authority-resolver.mjs so loadResolverFactory → null.
  const urlPath = '/api/graph/authority';
  const topic = 'urn:ex:t-1558-abs';
  const predicate = 'urn:ex:p-1558-abs';
  const scope = 'urn:ex:s-1558-abs';
  const evaluationTime = '2026-10-04T00:00:00.000Z';
  const query = `topic=${encodeURIComponent(topic)}&predicate=${encodeURIComponent(predicate)}&scope=${encodeURIComponent(scope)}&evaluationTime=${encodeURIComponent(evaluationTime)}`;
  // factory absent → handler returns 503 BEFORE the fence runs, so the unreachable URL never matters.
  const wire = await driveNotInstalledRoute({ baseUrl: 'http://127.0.0.1:1', datasetId: 'trial-abs-resolver', urlPath, query });
  assert.ok(wire.calls.length >= 1, 'production route function never called sendJSON');
  const call = wire.calls.at(-1);
  assert.equal(call.status, 503, 'not-installed branch returns HTTP 503');
  const env = call.body;
  // The thin shape (control) below intentionally lacks the D1 keys — this test catches that.
  assertD1Shape(env);
  assert.equal(env.topic, topic);
  assert.equal(env.predicate, predicate);
  assert.equal(env.scope, scope);
  assert.equal(env.evaluationTime, evaluationTime, 'caller-supplied evaluationTime round-trips on the not-installed branch');
  assert.equal(env.reason, 'resolver not installed');
  assert.ok(Object.prototype.hasOwnProperty.call(env, 'legacy'), 'legacy is a request-scoped own property on the not-installed envelope');
});

test('#1558 D1 envelope shape: CONTROL — an old thin 503 response ({status, reason} only) FAILS the D1-shape assertion, proving the corrected test exercises the branch', async () => {
  // The old, silent 503 was `{ status: 'UNAVAILABLE', reason: 'resolver not installed' }` —
  // minimal, no topic/predicate/scope/evaluationTime keys. The corrected test must
  // distinguish this from the real production response. We replay the thin shape and
  // confirm the helper rejects it — if assertD1Shape ever silently accepts a thin body,
  // the corrected test is broken.
  const thin = { status: 'UNAVAILABLE', reason: 'resolver not installed' };
  assert.throws(() => assertD1Shape(thin), /missing D1 envelope key/, 'thin 503 must NOT satisfy the D1 helper');
});

test('#1558 D1 envelope shape: stop and start the executor, only request-scoped legacy instrumentation is present on UNAVAILABLE branches', { skip: SKIP }, async () => {
  if (!fs.existsSync(path.join(PROJECT_DIR, 'core', 'authority-resolver.mjs'))) return;
  // authority read never touches a legacy path — counters must be all zero in the request's own context.
  assert.equal((await post('/api/trial/executor/stop', {})).status, 200);
  try {
    const r = await get(`/api/graph/authority?topic=urn:ex:t&predicate=urn:ex:p&scope=urn:ex:s`);
    assert.equal(r.status, 200);
    const env = await r.json();
    assertD1Shape(env);
    assert.ok(Object.prototype.hasOwnProperty.call(env, 'legacy'), 'legacy is a request-scoped own property of every authority envelope');
    assert.equal(env.legacy ?? null, null, 'no legacy path touched by an authority read on the down branch');
  } finally {
    assert.equal((await post('/api/trial/executor/start', {})).status, 200);
  }
});

test('#1558 trial control: executor stop → writes UNAVAILABLE; start → the same store, writes resume', { skip: SKIP }, async () => {
  assert.equal((await post('/api/trial/executor/stop', {})).status, 200);
  const down = await (await post('/api/graph/correct', correction('2'))).json();
  assert.equal(down.outcome, 'UNAVAILABLE');
  assert.equal((await post('/api/trial/executor/start', {})).status, 200);
  // A1 was retired by the first test, so write something independent of it
  const obs = { kind: 'assertion', opId: fresh('op'), actor: 'urn:ex:seat/nobody',
    newAssertion: { iri: fresh('N'), subject: 'urn:ex:topic1', predicate: 'urn:ex:policy', value: { type: 'literal', value: 'seen' }, scope: 'urn:ex:scopeX', binding: false } };
  const up = await (await post('/api/graph/assert', obs)).json();
  assert.equal(up.outcome, 'APPLIED', up.reason);
  assert.equal((await counters()).identity.datasetId, 'trial-routes');
});

test('#1558 the slice is OFF without its flag: no graph write routes exist', async () => {
  const plain = await startRestServer();
  try {
    const r = await fetch(`${plain.baseUrl}/api/graph/correct`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 404);
    assert.equal((await fetch(`${plain.baseUrl}/api/trial/counters`)).status, 404);
  } finally {
    await plain.stop();
  }
});

test('#1567 PC3 fencing: a server pointed at an executor holding ANOTHER dataset refuses every write and read before dispatch', { skip: SKIP }, async () => {
  const { spawn } = await import('node:child_process');
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-other-'));
  const p = spawn(PY, [path.join(PROJECT_DIR, 'graph-executor', 'executor.py'), '--store', other, '--port', '0', '--dataset-id', 'NOT-the-trial', '--create'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const eport = await new Promise((r) => { let o = ''; p.stdout.on('data', (d) => { o += d; if (o.includes('\n')) r(JSON.parse(o).port); }); });
  const srv = await startRestServer({ env: { SCRUM_GRAPH_EXECUTOR_URL: `http://127.0.0.1:${eport}`, SCRUM_GRAPH_DATASET_ID: 'trial-x', GRAPH_EXECUTOR_PYTHON: PY } });
  try {
    const w = await (await fetch(`${srv.baseUrl}/api/graph/rule`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'rule', opId: 'urn:ex:op/fence', actor: 'urn:ex:admin', rule: { iri: 'urn:ex:R/fence' } }) })).json();
    assert.equal(w.outcome, 'UNAVAILABLE');
    assert.match(w.reason, /dataset-identity-mismatch: refused before dispatch/);
    const a = await (await fetch(`${srv.baseUrl}/api/graph/authority?topic=urn:ex:t&predicate=urn:ex:p&scope=urn:ex:s`)).json();
    assert.equal(a.status, 'UNAVAILABLE');
    assert.match(a.reason, /dataset-identity-mismatch/);
    const h = await (await fetch(`http://127.0.0.1:${eport}/health`)).json();
    assert.equal(h.updates, 0, 'nothing reached the foreign store');
    assert.equal(h.commitSeq, '0');
  } finally { await srv.stop(); p.kill('SIGKILL'); }
});

test('#1567 fencing: the slice will not start without an expected dataset identity', async () => {
  const { createGraphSlice } = await import('../core/graph-slice-routes.mjs');
  assert.throws(() => createGraphSlice({ config: { enabled: true, url: 'http://127.0.0.1:1', datasetId: null }, sendJSON() {}, readBody() {} }), /SCRUM_GRAPH_DATASET_ID is required/);
});
