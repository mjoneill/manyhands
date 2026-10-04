/**
 * #1561 — a memory's TITLE / TAG / PRIORITY history survives the move to the executor.
 *
 * Flag OFF, the event log keeps every prior full state of a memory (each event's
 * `state.identity`); no API served it before this card (GET …/versions carries the
 * CURRENT title only, and /api/changes rows carry title null for memory events).
 * Flag ON, `memory.revise` used to overwrite name/tags/priority in place, keeping only
 * body versions. Now every revise records the identity it REPLACES on a revision node,
 * inside the same guarded update, and `GET /api/memories/:id/versions?identities=1`
 * returns the sequence on both paths:
 *
 *   identities: [{ title, tags (sorted), priority | null }, …]  oldest first, current last,
 *               consecutive equal entries collapsed (a body-only edit is not a new identity).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startRestServer, freePort, PROJECT_DIR } from './helpers/harness.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';

const TOK = { bob: mintToken() };
function tokensFile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lbh-tok-'));
  const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  const f = path.join(d, 'seat-tokens.json');
  fs.writeFileSync(f, JSON.stringify({ seats: { bob: { credentials: [{ tokenHash: hashToken(TOK.bob), scope: 'admin', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null }] } } }));
  return f;
}
const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(PROJECT_DIR, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;

function initStore(dsid) {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'lbh-store-'));
  const init = spawnSync(PY, ['-c', `import pyoxigraph as px\ns = px.Store(${JSON.stringify(store)})\ns.update('INSERT DATA { <urn:ex:dataset> <urn:ex:datasetId> "${dsid}" ; <urn:ex:epoch> 1 ; <urn:ex:commitSeq> 0 }')\ns.flush()`]);
  assert.equal(init.status, 0, String(init.stderr));
  return store;
}
async function boot({ dsid, unit }) {
  const store = initStore(dsid);
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
  srv.store = store;
  return srv;
}
const call = async (srv, method, p, body) => {
  const r = await fetch(`${srv.baseUrl}${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOK.bob}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const normalise = (x) => JSON.parse(JSON.stringify(x).replace(UUID, '<ID>').replace(ISO, '<T>'));

let ON, OFF;
before(async () => {
  if (SKIP) return;
  [ON, OFF] = await Promise.all([boot({ dsid: 'lbh-on', unit: true }), boot({ dsid: 'lbh-off', unit: false })]);
});
after(async () => { await ON?.stop(); await OFF?.stop(); });

async function retitleScript(srv) {
  const m = await call(srv, 'POST', '/api/memories', { owner: 'bob', title: 'T1', body: 'b1', tags: ['b', 'a'], priority: 'p2' });
  assert.equal(m.status, 201);
  const id = m.body.id;
  for (const body of [{ title: 'T2' }, { bodyAppend: ' +x' }, { title: 'T3', tags: ['c'], priority: null }]) {
    const r = await call(srv, 'PATCH', `/api/memories/${id}`, body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  return {
    plain: await call(srv, 'GET', `/api/memories/${id}/versions`),
    hist: await call(srv, 'GET', `/api/memories/${id}/versions?identities=1`),
    missing: await call(srv, 'GET', '/api/memories/00000000-0000-0000-0000-000000000000/versions?identities=1'),
  };
}

test('#1561 HISTORY: retitle twice + retag — every title and tag set is returned in order, the same with the unit ON as OFF', { skip: SKIP }, async () => {
  const [on, off] = [await retitleScript(ON), await retitleScript(OFF)];
  const expected = [
    { title: 'T1', tags: ['a', 'b'], priority: 'p2' },
    { title: 'T2', tags: ['a', 'b'], priority: 'p2' },
    { title: 'T3', tags: ['c'], priority: null },
  ];
  assert.equal(off.hist.status, 200, JSON.stringify(off.hist.body));
  assert.deepEqual(off.hist.body.identities, expected, 'flag OFF: the event log\'s states');
  assert.equal(on.hist.status, 200, JSON.stringify(on.hist.body));
  assert.deepEqual(on.hist.body.identities, expected, 'flag ON: the revision nodes + the current state');
  assert.deepEqual(normalise(on.hist), normalise(off.hist), 'parity, ids and timestamps normalised');
  // the default answer is unchanged on both paths (opt-in: the flag-OFF read costs an event-log scan)
  assert.equal(on.plain.body.identities, undefined); assert.equal(off.plain.body.identities, undefined);
  assert.deepEqual(normalise(on.plain), normalise(off.plain));
  assert.deepEqual([on.missing.status, off.missing.status], [404, 404]);
});

test('#1561 HISTORY under a race: concurrent retitles are each recorded exactly once (appended, never overwritten)', { skip: SKIP }, async () => {
  const m = await call(ON, 'POST', '/api/memories', { owner: 'bob', title: 'R-start', body: 'x' });
  const N = 6;
  const rs = await Promise.all(Array.from({ length: N }, (_, k) => call(ON, 'PATCH', `/api/memories/${m.body.id}`, { title: `R${k}` })));
  for (const r of rs) assert.equal(r.status, 200, JSON.stringify(r.body));
  const titles = (await call(ON, 'GET', `/api/memories/${m.body.id}/versions?identities=1`)).body.identities.map((x) => x.title);
  assert.equal(titles.length, N + 1, JSON.stringify(titles));
  assert.equal(titles[0], 'R-start');
  assert.deepEqual([...titles.slice(1)].sort(), Array.from({ length: N }, (_, k) => `R${k}`));
  assert.equal(titles.at(-1), (await call(ON, 'GET', `/api/memories/${m.body.id}`)).body.title, 'the last entry is the current title');
});
