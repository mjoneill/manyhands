/**
 * #1569 — with auth ENFORCED, a seat may declare and clear only ITS OWN state.
 * Found by a reviewer's review probe of the #1561 unit: bob PUT /api/seats/ada/state
 * returned 200 on both paths (flag ON attributed it to bob, but did not prevent it).
 * Seat state decides who is offered routine work, so this is authorization, not
 * attribution. Every refusal has a twin (the seat itself) that is allowed.
 * Observe mode is unchanged: with no enforced seat there is no "self" to compare.
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-tok-'));
  const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  const cred = (p) => ({ tokenHash: hashToken(p), scope: 'admin', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null });
  const f = path.join(d, 'seat-tokens.json');
  fs.writeFileSync(f, JSON.stringify({ seats: Object.fromEntries(Object.entries(TOK).map(([k, v]) => [k, { credentials: [cred(v)] }])) }));
  return f;
}
const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(PROJECT_DIR, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;

async function boot(dsid, unit) {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-store-'));
  const init = spawnSync(PY, ['-c', `import pyoxigraph as px\ns = px.Store(${JSON.stringify(store)})\ns.update('INSERT DATA { GRAPH <urn:scrum:bookkeeping:executor> { <urn:ex:dataset> <urn:ex:datasetId> "${dsid}" ; <urn:ex:epoch> 1 ; <urn:ex:commitSeq> 0 } }')\ns.flush()`]);
  assert.equal(init.status, 0, String(init.stderr));
  const srv = await startRestServer({ env: {
    SCRUM_GRAPH_EXECUTOR_URL: `http://127.0.0.1:${await freePort()}`, SCRUM_GRAPH_DATASET_ID: dsid,
    SCRUM_TRIAL_EXECUTOR_STORE: store, GRAPH_EXECUTOR_PYTHON: PY, SCRUM_SEAT_TOKENS: tokensFile(), SCRUM_AUTH: 'required',
    ...(unit ? { SCRUM_GRAPH_UNIT_LOGBORN: '1' } : {}),
  } });
  for (let i = 0; i < 200; i++) {
    const c = await (await fetch(`${srv.baseUrl}/api/trial/counters`, { headers: { authorization: `Bearer ${TOK.bob}` } })).json();
    if (c.executor) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return srv;
}
const later = new Date(Date.now() + 7 * 86400_000).toISOString();
const call = async (srv, method, p, seat, body) => {
  const r = await fetch(`${srv.baseUrl}${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOK[seat]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const declared = async (srv, seat) => {
  const s = (await call(srv, 'GET', '/api/seats/state', 'bob')).body;
  // the population is roster ∪ declared seats, so a seat that never declared is simply absent: UNKNOWN
  return s.seats.find((r) => r.seat === seat)?.mode ?? 'unknown';
};

let ON, OFF;
before(async () => { if (SKIP) return; [ON, OFF] = await Promise.all([boot('ss-on', true), boot('ss-off', false)]); });
after(async () => { await ON?.stop(); await OFF?.stop(); });

for (const [name, get] of [['flag ON', () => ON], ['flag OFF', () => OFF]]) {
  test(`#1569 ${name}: bob cannot declare or clear ada's state; ada can (twin)`, { skip: SKIP }, async () => {
    const srv = get();
    const decl = { mode: 'available', acceptsRoutineWork: true, expiresAt: later };
    const bad = await call(srv, 'PUT', '/api/seats/ada/state', 'bob', decl);
    assert.equal(bad.status, 403, JSON.stringify(bad.body));
    assert.equal(bad.body.code, 'SEAT_NOT_SELF');
    assert.equal(await declared(srv, 'ada'), 'unknown', 'nothing was declared for ada');
    const own = await call(srv, 'PUT', '/api/seats/ada/state', 'ada', decl);
    assert.equal(own.status, 200, 'twin: ada declares her own state ' + JSON.stringify(own.body));
    assert.equal(await declared(srv, 'ada'), 'available');
    const badClear = await call(srv, 'DELETE', '/api/seats/ada/state', 'bob');
    assert.equal(badClear.status, 403);
    assert.equal(badClear.body.code, 'SEAT_NOT_SELF');
    assert.equal(await declared(srv, 'ada'), 'available', "bob's refused clear left ada's declaration standing");
    const ownClear = await call(srv, 'DELETE', '/api/seats/ada/state', 'ada');
    assert.equal(ownClear.status, 200);
    assert.equal(ownClear.body.cleared, true, 'twin: ada clears her own');
  });
}

// #1568 — the same root, found first by the #1561 builder: a REFUSED seat-state
// request (logged as op 'refused', kind seat-state) was projected into the
// declaration timeline and ENDED the open interval. A refusal changes nothing.
test('#1568 flag OFF: a refused (400) seat PUT leaves the open declaration standing; an accepted re-declare replaces it (twin)', { skip: SKIP }, async () => {
  const later2 = new Date(Date.now() + 6 * 86400_000).toISOString();
  assert.equal((await call(OFF, 'PUT', '/api/seats/bob/state', 'bob', { mode: 'available', acceptsRoutineWork: true, expiresAt: later })).status, 200);
  const bad = await call(OFF, 'PUT', '/api/seats/bob/state', 'bob', { mode: 'not-a-mode', acceptsRoutineWork: true, expiresAt: later });
  assert.equal(bad.status, 400);
  assert.equal(await declared(OFF, 'bob'), 'available', 'the refusal ended nothing');
  assert.equal((await call(OFF, 'PUT', '/api/seats/bob/state', 'bob', { mode: 'resting', acceptsRoutineWork: false, expiresAt: later2 })).status, 200);
  assert.equal(await declared(OFF, 'bob'), 'resting', 'twin: an accepted declaration does replace it');
});
