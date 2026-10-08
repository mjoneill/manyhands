/**
 * #1559 — the route WIRING end to end, each refusal with an allowed twin.
 * Written by a reviewer in review of 59fdb5e (diagnostics/review-1559-20261004,
 * sha 34b25b26…): the unit tests proved authorizeWrite, but three route
 * mutations (seat submitted as actor, everyone an admin, non-grant kind passed)
 * passed the whole suite. These catch all five she tried. Adopted by the builder.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startRestServer, freePort, PROJECT_DIR } from './helpers/harness.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';

const TOK = { bob: mintToken(), admin: mintToken() };
function tokensFile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-tok-'));
  const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  const cred = (p) => ({ tokenHash: hashToken(p), scope: 'admin', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null });
  const f = path.join(d, 'seat-tokens.json');
  fs.writeFileSync(f, JSON.stringify({ seats: Object.fromEntries(Object.entries(TOK).map(([k, v]) => [k, { credentials: [cred(v)] }])) }));
  return f;
}
const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(PROJECT_DIR, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;
async function boot(extraEnv, dsid) {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-store-'));
  const init = spawnSync(PY, ['-c', `import pyoxigraph as px\ns = px.Store(${JSON.stringify(store)})\ns.update('INSERT DATA { GRAPH <urn:scrum:bookkeeping:executor> { <urn:ex:dataset> <urn:ex:datasetId> "${dsid}" ; <urn:ex:epoch> 1 ; <urn:ex:commitSeq> 0 } }')\ns.flush()`]);
  assert.equal(init.status, 0, String(init.stderr));
  const srv = await startRestServer({ env: { SCRUM_GRAPH_EXECUTOR_URL: `http://127.0.0.1:${await freePort()}`, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_TRIAL_EXECUTOR_STORE: store, GRAPH_EXECUTOR_PYTHON: PY, SCRUM_SEAT_TOKENS: tokensFile(), ...extraEnv } });
  for (let i = 0; i < 100; i++) { const c = await (await fetch(`${srv.baseUrl}/api/trial/counters`, { headers: { authorization: `Bearer ${TOK.bob}` } })).json(); if (c.executor) break; await new Promise((r) => setTimeout(r, 50)); }
  return srv;
}
const hdr = (seat) => ({ 'content-type': 'application/json', authorization: `Bearer ${TOK[seat]}` });
const post = (srv, seat, p, body) => fetch(`${srv.baseUrl}${p}`, { method: 'POST', headers: hdr(seat), body: JSON.stringify(body) }).then((r) => r.json());
const updates = async (srv) => (await (await fetch(`${srv.baseUrl}/api/trial/counters`, { headers: hdr('bob') })).json()).executor.updates;
let srv, obs;
before(async () => { if (SKIP) return; srv = await boot({ SCRUM_AUTH: 'required', SCRUM_GRAPH_GRANT_ADMINS: 'admin' }, 'rv-req'); obs = await boot({}, 'rv-obs'); });
after(async () => { await srv?.stop(); await obs?.stop(); });
const rule = (op, actor) => ({ kind: 'rule', opId: `urn:ex:op/${op}`, actor, rule: { iri: `urn:ex:R/${op}` } });

test('#1559 wiring: a non-admin seat creating a RULE is refused over HTTP before dispatch; the admin twin is applied', { skip: SKIP }, async () => {
  const u0 = await updates(srv);
  const bad = await post(srv, 'bob', '/api/graph/rule', rule('rv1', 'urn:ex:seat/bob'));
  assert.equal(bad.outcome, 'REJECTED'); assert.match(bad.reason, /not-a-grant-admin/);
  assert.equal(await updates(srv), u0, 'nothing dispatched');
  { const t = await post(srv, 'admin', '/api/graph/rule', rule('rv2', 'urn:ex:seat/admin')); assert.equal(t.outcome, 'APPLIED', 'twin: ' + JSON.stringify(t).slice(0, 300)); }
});
test('#1559 wiring: a non-admin seat creating a GRANT is refused over HTTP; the admin twin is applied', { skip: SKIP }, async () => {
  const g = (op, actor) => ({ kind: 'grant', opId: `urn:ex:op/${op}`, actor, grant: { iri: `urn:ex:G/${op}`, grantee: 'urn:ex:seat/bob', scope: 'urn:ex:s', mayRetire: false, rev: '1' } });
  assert.match((await post(srv, 'bob', '/api/graph/grant', g('rv3', 'urn:ex:seat/bob'))).reason ?? '', /not-a-grant-admin/);
  assert.equal((await post(srv, 'admin', '/api/graph/grant', g('rv4', 'urn:ex:seat/admin'))).outcome, 'APPLIED', 'twin');
});
test('#1559 wiring: a bound seat naming ANOTHER seat as actor is refused over HTTP; naming itself is allowed', { skip: SKIP }, async () => {
  const a = (op, actor) => ({ kind: 'assertion', opId: `urn:ex:op/${op}`, actor, newAssertion: { iri: `urn:ex:A/${op}`, subject: 'urn:ex:t', predicate: 'urn:ex:p', value: { type: 'literal', value: 'v' }, scope: 'urn:ex:s' }, authority: { grant: 'urn:ex:G/rv4', grantRev: '1', rule: 'urn:ex:R/rv2', ruleRev: '1' } });
  const u0 = await updates(srv);
  const bad = await post(srv, 'bob', '/api/graph/assert', a('rv5', 'urn:ex:seat/admin'));
  assert.equal(bad.outcome, 'REJECTED'); assert.match(bad.reason, /actor-not-authenticated-seat/);
  assert.equal(await updates(srv), u0, 'nothing dispatched');
  assert.equal((await post(srv, 'bob', '/api/graph/assert', a('rv6', 'urn:ex:seat/bob'))).outcome, 'APPLIED', 'twin');
});
test('#1559 wiring: a caller-supplied `by` is refused as an unknown field; the same write without it is applied', { skip: SKIP }, async () => {
  const w = (op, extra) => ({ kind: 'rule', opId: `urn:ex:op/${op}`, actor: 'urn:ex:seat/admin', rule: { iri: `urn:ex:R/${op}` }, ...extra });
  const bad = await post(srv, 'admin', '/api/graph/rule', w('rv7', { by: 'mallory' }));
  assert.equal(bad.outcome, 'REJECTED');
  assert.equal((await post(srv, 'admin', '/api/graph/rule', w('rv8', {}))).outcome, 'APPLIED', 'twin');
});
test('#1559 wiring: observe mode with a recorded bearer is refused over HTTP (not authentication)', { skip: SKIP }, async () => {
  const u0 = await updates(obs);
  const bad = await post(obs, 'bob', '/api/graph/rule', rule('rv9', 'urn:ex:seat/bob'));
  assert.equal(bad.outcome, 'REJECTED'); assert.match(bad.reason, /unauthenticated/);
  assert.equal(await updates(obs), u0, 'nothing dispatched');
});
