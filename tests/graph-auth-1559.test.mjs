/**
 * #1559 — who may write to the graph (authorized by the owner 2026-10-04 12:43Z).
 * Every refusal has a TWIN that differs only in the fault and is allowed, so
 * a check that is simply absent fails here rather than passing vacuously
 * (a reviewer, #1559 04:17Z #2).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { authorizeWrite, trialBypassFromEnv, parseAdmins, seatActor } from '../core/graph-auth.mjs';
import { startRestServer, freePort, PROJECT_DIR } from './helpers/harness.mjs';

const BOB = { seat: 'bob', scope: 'act', enforced: true };
const admins = parseAdmins('admin, ops');

test('#1559 an authenticated seat writes as itself (twin) and is refused as anyone else', () => {
  assert.equal(authorizeWrite({ auth: BOB, kind: 'correction', actor: seatActor('bob'), admins }), null);
  assert.match(authorizeWrite({ auth: BOB, kind: 'correction', actor: seatActor('mallory'), admins }), /^actor-not-authenticated-seat/);
  assert.match(authorizeWrite({ auth: BOB, kind: 'assertion', actor: 'urn:ex:bob', admins }), /^actor-not-authenticated-seat/, 'a non-seat actor IRI is not the seat');
});

test('#1559 observe mode is NOT authentication: a recorded-but-unchecked bearer is refused like anonymous (a reviewer #1)', () => {
  const observed = { seat: 'bob', scope: 'act', enforced: false };
  assert.match(authorizeWrite({ auth: observed, kind: 'assertion', actor: seatActor('bob'), admins }), /^unauthenticated/);
  assert.equal(authorizeWrite({ auth: { ...observed, enforced: true }, kind: 'assertion', actor: seatActor('bob'), admins }), null, 'twin: the same seat, enforced');
});

test('#1559 anonymous writes are refused unless the trial bypass is active (twin)', () => {
  assert.match(authorizeWrite({ auth: null, kind: 'correction', actor: 'urn:ex:bob', admins }), /^unauthenticated/);
  assert.match(authorizeWrite({ auth: { seat: null, enforced: true }, kind: 'correction', actor: 'urn:ex:bob', admins }), /^unauthenticated/);
  assert.equal(authorizeWrite({ auth: null, kind: 'correction', actor: 'urn:ex:bob', admins, trialBypass: true }), null);
});

test('#1559 the trial bypass never lets a BOUND seat speak as another (a reviewer)', () => {
  assert.match(authorizeWrite({ auth: BOB, kind: 'correction', actor: seatActor('mallory'), admins, trialBypass: true }), /^actor-not-authenticated-seat/);
  assert.match(authorizeWrite({ auth: BOB, kind: 'grant', actor: seatActor('bob'), admins, trialBypass: true }), /^not-a-grant-admin/, 'nor create grants as a non-admin');
});

test('#1559 grant and rule creation needs the AUTHENTICATED seat on the admin list; default deny', () => {
  const ADMIN = { seat: 'admin', scope: 'act', enforced: true };
  for (const kind of ['grant', 'rule']) {
    assert.equal(authorizeWrite({ auth: ADMIN, kind, actor: seatActor('admin'), admins }), null, `${kind}: twin, an admin`);
    assert.match(authorizeWrite({ auth: BOB, kind, actor: seatActor('bob'), admins }), /^not-a-grant-admin/, `${kind}: non-admin`);
    assert.match(authorizeWrite({ auth: ADMIN, kind, actor: seatActor('admin'), admins: parseAdmins('') }), /^not-a-grant-admin/, `${kind}: no list configured = nobody`);
    // the submitted actor never confers admin: bob naming the admin's actor is refused as a spoof
    assert.match(authorizeWrite({ auth: BOB, kind, actor: seatActor('admin'), admins }), /^actor-not-authenticated-seat/);
  }
  assert.equal(authorizeWrite({ auth: BOB, kind: 'correction', actor: seatActor('bob'), admins }), null, 'ordinary writes need no admin');
});

// ---------- the trial bypass: refused at STARTUP without launcher isolation ----------

function sandbox() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'g1559-')));
  fs.mkdirSync(path.join(dir, 'data', 'graph-store'), { recursive: true });
  return { dir, store: path.join(dir, 'data', 'graph-store') };
}

test('#1559 bypass: flag unset → inactive, whatever else is set', () => {
  const { dir, store } = sandbox();
  assert.deepEqual(trialBypassFromEnv({ TRIAL_DIR: dir, SCRUM_TRIAL_EXECUTOR_STORE: store }, { guardRoot: dir }), { active: false });
});

test('#1559 bypass: the flag WITH full launcher evidence is active (twin of every refusal below)', () => {
  const { dir, store } = sandbox();
  assert.equal(trialBypassFromEnv({ SCRUM_GRAPH_TRIAL_UNBOUND_ACTORS: '1', TRIAL_DIR: dir, SCRUM_TRIAL_EXECUTOR_STORE: store }, { guardRoot: dir }).active, true);
});

test('#1559 bypass: the flag without each piece of evidence REFUSES to start', () => {
  const { dir, store } = sandbox();
  const other = sandbox();
  const flag = { SCRUM_GRAPH_TRIAL_UNBOUND_ACTORS: '1' };
  assert.throws(() => trialBypassFromEnv({ ...flag, SCRUM_TRIAL_EXECUTOR_STORE: store }, { guardRoot: dir }), /TRIAL_DIR unset/);
  assert.throws(() => trialBypassFromEnv({ ...flag, TRIAL_DIR: dir, SCRUM_TRIAL_EXECUTOR_STORE: store }, { guardRoot: null }), /write fence .* is not loaded/);
  assert.throws(() => trialBypassFromEnv({ ...flag, TRIAL_DIR: dir, SCRUM_TRIAL_EXECUTOR_STORE: store }, { guardRoot: other.dir }), /guards .* not TRIAL_DIR/);
  assert.throws(() => trialBypassFromEnv({ ...flag, TRIAL_DIR: dir }, { guardRoot: dir }), /no server-owned trial executor store/);
  assert.throws(() => trialBypassFromEnv({ ...flag, TRIAL_DIR: dir, SCRUM_TRIAL_EXECUTOR_STORE: other.store }, { guardRoot: dir }), /store is outside TRIAL_DIR/);
});

// ---------- served ----------

const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(PROJECT_DIR, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;

test('#1559 served: a server started with the bypass flag but NO launcher isolation refuses to start', { skip: SKIP }, async () => {
  const { store } = sandbox();
  await assert.rejects(startRestServer({ env: {
    SCRUM_GRAPH_EXECUTOR_URL: `http://127.0.0.1:${await freePort()}`, SCRUM_GRAPH_DATASET_ID: 'trial-x',
    SCRUM_TRIAL_EXECUTOR_STORE: store, GRAPH_EXECUTOR_PYTHON: PY, SCRUM_GRAPH_TRIAL_UNBOUND_ACTORS: '1',
  } }));
});

test('#1559 served: in observe mode an anonymous write is REJECTED before dispatch and nothing reaches the store', { skip: SKIP }, async () => {
  const { store } = sandbox();
  const init = spawnSync(PY, ['-c', `import pyoxigraph as px\ns = px.Store(${JSON.stringify(store)})\ns.update('INSERT DATA { GRAPH <urn:scrum:bookkeeping:executor> { <urn:ex:dataset> <urn:ex:datasetId> "trial-anon" ; <urn:ex:epoch> 1 ; <urn:ex:commitSeq> 0 } }')\ns.flush()`]);
  assert.equal(init.status, 0, String(init.stderr));
  const eport = await freePort();
  const srv = await startRestServer({ env: { SCRUM_GRAPH_EXECUTOR_URL: `http://127.0.0.1:${eport}`, SCRUM_GRAPH_DATASET_ID: 'trial-anon', SCRUM_TRIAL_EXECUTOR_STORE: store, GRAPH_EXECUTOR_PYTHON: PY } });
  try {
    for (let i = 0; i < 100; i++) { const c = await (await fetch(`${srv.baseUrl}/api/trial/counters`)).json(); if (c.executor) break; await new Promise((r) => setTimeout(r, 50)); }
    const r = await (await fetch(`${srv.baseUrl}/api/graph/rule`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'rule', opId: 'urn:ex:op/anon', actor: 'urn:ex:anyone', rule: { iri: 'urn:ex:R/anon' } }) })).json();
    assert.equal(r.outcome, 'REJECTED');
    assert.match(r.reason, /^validation: unauthenticated/);
    const c = await (await fetch(`${srv.baseUrl}/api/trial/counters`)).json();
    assert.equal(c.executor.updates, 0, 'nothing was dispatched');
    assert.deepEqual(c.authPolicy, { trialUnboundActors: false, grantAdminCount: 0 });
  } finally { await srv.stop(); }
});
