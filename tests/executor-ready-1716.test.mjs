/**
 * #1716 — readiness for a REST's trial executor must be a fact about THIS REST's executor, never "something answered".
 * TEST AUTHOR's rows, written before the build, against the seam agreed in the commons (43903, 43905):
 *   tests/helpers/executor-ready.mjs  exports  waitExecutorReady(baseUrl, { dsid, headers, tries, intervalMs })
 * It polls GET /api/trial/counters, resolves with the counters only when the identity names `dsid` AND (when the counters
 * report trialControl) executorRunning is true, and otherwise rejects with an error naming "identity" or
 * "executorRunning" and what it saw.
 *
 * The failure it guards (#1716, CI 39169172339): a test picks an executor port with freePort() (unheld, #1140), another
 * test's REST takes that port first, our trial executor fails to bind, and the old readiness check
 * (`if (c.executor) return`, where `executor` is ANY JSON from <url>/health) accepts the stranger. Graph writes then
 * meet the stranger's 401 and come back as 503 GRAPH_WRITE_UNAVAILABLE.
 *
 *   T1  PRECONDITION: a real executor's /health body, captured without the helper (R3 needs it)
 *   T0  PRECONDITION / the trap: with a 401-answering stranger holding the executor port, the counters' `executor` field is
 *       NON-NULL — the old check would have passed. (True at main; it is the reason the rows below exist.)
 *   R1  that stranger: waitExecutorReady REJECTS, naming identity
 *   R2  CONTROL: a REST whose own trial executor holds a genuinely free port: RESOLVES, identity.datasetId === dsid,
 *       executorRunning === true
 *   R3a a stranger that serves a real executor's /health body with ANOTHER dataset id: REJECTS (a shape-only check passes it)
 *   R3b a stranger that serves a real executor's /health body WITH OUR dataset id, while our own child could not bind: REJECTS
 *       (a dataset-id-only check passes it; executorRunning is the fact a stranger cannot supply — commons 43905)
 *
 * NOT covered: which test's REST was the stranger in CI; the 503's remaining causes (#1713); timing of freePort reuse.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { startRestServer, freePort, PROJECT_DIR } from './helpers/harness.mjs';

const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(PROJECT_DIR, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const T = { skip: HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY} (a skip is not a pass)`, timeout: 120000 };
const DSID = 'ds-1716-own';

let W = null, wErr = null;
try { W = await import(pathToFileURL(path.join(PROJECT_DIR, 'tests', 'helpers', 'executor-ready.mjs')).href); } catch (e) { wErr = e; }
const ready = () => { assert.ok(W?.waitExecutorReady, `tests/helpers/executor-ready.mjs does not export waitExecutorReady yet (${wErr?.message?.slice(0, 100)})`); return W.waitExecutorReady; };

function initStore(dsid) {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'er1716-store-'));
  const r = spawnSync(PY, ['-c', `import pyoxigraph as px\ns = px.Store(${JSON.stringify(store)})\ns.update('INSERT DATA { GRAPH <urn:scrum:bookkeeping:executor> { <urn:ex:dataset> <urn:ex:datasetId> "${dsid}" ; <urn:ex:epoch> 1 ; <urn:ex:commitSeq> 0 } }')\ns.flush()`]);
  assert.equal(r.status, 0, String(r.stderr)); return store;
}
// a stranger on a port: /health answers `health` (status, JSON body); everything else is a REST-style 401
async function stranger(health) {
  const srv = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(health.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(health.body)); return; }
    res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'a credential is required (SCRUM_AUTH=required)', code: 'AUTH_REQUIRED' }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}
const AUTH401 = { status: 401, body: { error: 'a credential is required: send Authorization (SCRUM_AUTH=required)', code: 'AUTH_REQUIRED' } };
async function restAt(executorUrl, dsid = DSID) {
  return startRestServer({ env: { SCRUM_GRAPH_EXECUTOR_URL: executorUrl, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_TRIAL_EXECUTOR_STORE: initStore(dsid), GRAPH_EXECUTOR_PYTHON: PY } });
}
const counters = async (base) => (await fetch(`${base}/api/trial/counters`)).json();
const FAST = { dsid: DSID, headers: {}, tries: 30, intervalMs: 50 };
async function rejects(p, re, label) {
  let err = null; try { await p; } catch (e) { err = e; }
  assert.ok(err, `${label}: waitExecutorReady RESOLVED against a stranger`);
  assert.match(String(err.message), re, `${label}: the refusal names what failed (${String(err.message).slice(0, 200)})`);
}

let realHealth = null;   // a REAL executor's /health body, captured by T1 for R3a/R3b

test('#1716 (T0) PRECONDITION, the trap: with a 401 stranger on the executor port, counters.executor is non-null, so the old check passes', T, async () => {
  const s = await stranger(AUTH401); const rest = await restAt(s.url);
  try {
    let c = null; for (let i = 0; i < 40 && !c?.executor; i++) { c = await counters(rest.baseUrl); if (!c.executor) await new Promise((r) => setTimeout(r, 50)); }
    assert.ok(c.executor, `the old readiness field is satisfied by the stranger (${JSON.stringify(c).slice(0, 200)})`);
  } finally { await rest.stop(); await s.close(); }
});

test('#1716 (T1) PRECONDITION: capture a REAL executor /health body for R3 (no helper used)', T, async () => {
  const url = `http://127.0.0.1:${await freePort()}`; const rest = await restAt(url);
  try {
    for (let i = 0; i < 300 && realHealth?.datasetId !== DSID; i++) { try { realHealth = await (await fetch(`${url}/health`)).json(); } catch { /* not up yet */ } if (realHealth?.datasetId !== DSID) await new Promise((r) => setTimeout(r, 50)); }
    assert.equal(realHealth?.datasetId, DSID, `a real executor answered /health with our dataset id (${JSON.stringify(realHealth).slice(0, 160)})`);
  } finally { await rest.stop(); }
});

test('#1716 (R2) CONTROL: a REST whose own trial executor holds a free port is READY, with our identity and its child running', T, async () => {
  const url = `http://127.0.0.1:${await freePort()}`; const rest = await restAt(url);
  try {
    const c = await ready()(rest.baseUrl, { dsid: DSID, headers: {}, tries: 300, intervalMs: 50 });
    assert.equal(c?.identity?.datasetId, DSID, `resolved with our identity (${JSON.stringify(c?.identity)})`);
    assert.equal(c?.executorRunning, true, 'and our own child is running');
  } finally { await rest.stop(); }
});

test('#1716 (R1) a 401-answering stranger on the executor port is NOT ready', T, async () => {
  const s = await stranger(AUTH401); const rest = await restAt(s.url);
  try { await rejects(ready()(rest.baseUrl, FAST), /identity|executorRunning/i, 'R1'); } finally { await rest.stop(); await s.close(); }
});

test('#1716 (R3a) a stranger serving a real /health body with ANOTHER dataset id is NOT ready', T, async () => {
  assert.ok(realHealth, 'PRECONDITION: T1 captured a real /health body (run the file whole)');
  const s = await stranger({ status: 200, body: { ...realHealth, datasetId: 'ds-1716-someone-else' } }); const rest = await restAt(s.url);
  try { await rejects(ready()(rest.baseUrl, FAST), /identity|executorRunning/i, 'R3a'); } finally { await rest.stop(); await s.close(); }
});

test('#1716 (R3b) a stranger serving a real /health body WITH OUR dataset id, while our own child could not bind, is NOT ready', T, async () => {
  assert.ok(realHealth, 'PRECONDITION: T1 captured a real /health body (run the file whole)');
  const s = await stranger({ status: 200, body: { ...realHealth, datasetId: DSID } }); const rest = await restAt(s.url);
  try {
    // PRECONDITION: the identity really does look right — so only executorRunning can refuse it
    let c = null; for (let i = 0; i < 40; i++) { c = await counters(rest.baseUrl); if (c?.identity?.datasetId === DSID && c.executorRunning === false) break; await new Promise((r) => setTimeout(r, 50)); }
    assert.equal(c?.identity?.datasetId, DSID, `PRECONDITION: the stranger passes a dataset-id check (${JSON.stringify(c?.identity)})`);
    assert.equal(c?.executorRunning, false, `PRECONDITION: our own child is NOT running, so only executorRunning can tell (${JSON.stringify({ executorRunning: c?.executorRunning, trialControl: c?.trialControl })})`);
    await rejects(ready()(rest.baseUrl, FAST), /executorRunning|identity/i, 'R3b');
  } finally { await rest.stop(); await s.close(); }
});
