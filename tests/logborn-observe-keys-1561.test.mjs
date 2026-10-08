/**
 * #1561 launch — the live board runs SCRUM_AUTH=observe, and unit 1 refused every
 * observe-mode write (#1559: no enforced seat ⇒ unauthenticated). the owner
 * (2026-10-04 18:40Z) authorized keys + enforcement; the room (reviewers
 * 18:41–18:45Z) narrowed it to the unit's own write routes so the browser, hooks
 * and every other route keep observe's answer.
 *
 * Boundary, as a reviewer listed it: no / unknown / expired / revoked key refused;
 * read-scope key refused; a matched act key succeeds AND carries the enforced
 * context (the body assertion and #1569's seat-self rule run); anonymous reads and
 * non-graph writes unchanged; with the unit OFF nothing changes.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startRestServer, freePort, PROJECT_DIR } from './helpers/harness.mjs';
import { mintToken, hashToken } from '../core/credentials.mjs';
import { isLogbornWriteRoute } from '../core/graph-auth.mjs';

const TOK = { bob: mintToken(), ada: mintToken(), ro: mintToken(), exp: mintToken(), rev: mintToken(), unknown: mintToken() };
function tokensFile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ok-tok-'));
  const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
  const cred = (p, extra = {}) => ({ tokenHash: hashToken(p), scope: 'act', issuedAt: at(-1), expiresAt: at(24), issuedBy: 'test', revokedAt: null, note: null, ...extra });
  const seats = {
    bob: { credentials: [cred(TOK.bob)] },
    ada: { credentials: [cred(TOK.ada)] },
    ro: { credentials: [cred(TOK.ro, { scope: 'read' })] },
    exp: { credentials: [cred(TOK.exp, { expiresAt: at(-2) })] },
    rev: { credentials: [cred(TOK.rev, { revokedAt: at(-1) })] },
  };
  const f = path.join(d, 'seat-tokens.json');
  fs.writeFileSync(f, JSON.stringify({ seats }));
  return f;
}
const PY = process.env.GRAPH_EXECUTOR_PYTHON || path.join(PROJECT_DIR, 'graph-executor', '.venv', 'bin', 'python');
const HAVE_PY = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pyoxigraph'], { stdio: 'ignore' }).status === 0;
const SKIP = HAVE_PY ? false : `UNAVAILABLE: no python with pyoxigraph at ${PY}`;

async function boot(dsid, unit) {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'ok-store-'));
  const init = spawnSync(PY, ['-c', `import pyoxigraph as px\ns = px.Store(${JSON.stringify(store)})\ns.update('INSERT DATA { GRAPH <urn:scrum:bookkeeping:executor> { <urn:ex:dataset> <urn:ex:datasetId> "${dsid}" ; <urn:ex:epoch> 1 ; <urn:ex:commitSeq> 0 } }')\ns.flush()`]);
  assert.equal(init.status, 0, String(init.stderr));
  // SCRUM_AUTH deliberately UNSET — observe, as on the live board.
  const srv = await startRestServer({ env: {
    SCRUM_GRAPH_EXECUTOR_URL: `http://127.0.0.1:${await freePort()}`, SCRUM_GRAPH_DATASET_ID: dsid,
    SCRUM_TRIAL_EXECUTOR_STORE: store, GRAPH_EXECUTOR_PYTHON: PY, SCRUM_SEAT_TOKENS: tokensFile(),
    ...(unit ? { SCRUM_GRAPH_UNIT_LOGBORN: '1' } : {}),
  } });
  for (let i = 0; i < 200; i++) {
    const c = await (await fetch(`${srv.baseUrl}/api/trial/counters`)).json().catch(() => ({}));
    if (c.executor || !unit) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return srv;
}
const call = async (srv, method, p, seat, body) => {
  const headers = { 'content-type': 'application/json' };
  if (seat) headers.authorization = `Bearer ${TOK[seat]}`;
  const r = await fetch(`${srv.baseUrl}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const memory = (title) => ({ owner: 'bob', title, body: 'b' });
const titles = async (srv) => { const b = (await call(srv, 'GET', '/api/memories')).body; return (Array.isArray(b) ? b : b?.memories ?? []).map((m) => m.title); };
const later = new Date(Date.now() + 7 * 86400_000).toISOString();
const SEAT = { mode: 'available', acceptsRoutineWork: true, expiresAt: later };

let ON, OFF;
before(async () => { if (SKIP) return; [ON, OFF] = await Promise.all([boot('ok-on', true), boot('ok-off', false)]); });
after(async () => { await ON?.stop(); await OFF?.stop(); });

test('#1561 launch: the route set is exactly the unit\'s six write routes', () => {
  for (const [m, p] of [['POST', '/api/memories'], ['PATCH', '/api/memories/x'], ['POST', '/api/decisions'], ['POST', '/api/decisions/x/relations'], ['PUT', '/api/seats/bob/state'], ['DELETE', '/api/seats/bob/state']]) {
    assert.equal(isLogbornWriteRoute(m, p), true, `${m} ${p}`);
  }
  for (const [m, p] of [['GET', '/api/memories'], ['GET', '/api/memories/x'], ['GET', '/api/seats/state'], ['POST', '/api/conversations'], ['POST', '/api/cards'], ['GET', '/api/decisions'], ['PATCH', '/api/memories/x/versions']]) {
    assert.equal(isLogbornWriteRoute(m, p), false, `${m} ${p}`);
  }
});

test('#1561 launch: in observe, a unit write with no / unknown / expired / revoked key is refused and stores nothing', { skip: SKIP }, async () => {
  const cases = [[null, 401, 'AUTH_REQUIRED'], ['unknown', 401, 'TOKEN_UNKNOWN'], ['exp', 401, 'TOKEN_EXPIRED'], ['rev', 401, 'TOKEN_REVOKED']];
  for (const [seat, status, code] of cases) {
    const r = await call(ON, 'POST', '/api/memories', seat, memory(`refused-${seat}`));
    assert.equal(r.status, status, `${seat}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'GRAPH_WRITE_UNAUTHENTICATED', seat);
    assert.equal(r.body.reason, code, seat);
    const d = await call(ON, 'POST', '/api/decisions', seat, { statement: `refused-${seat}`, decidedBy: 'bob' });
    assert.equal(d.status, status, `decision ${seat}`);
    const s = await call(ON, 'PUT', '/api/seats/bob/state', seat, SEAT);
    assert.equal(s.status, status, `seat ${seat}`);
  }
  const t = await titles(ON);
  for (const [seat] of cases) assert.ok(!t.includes(`refused-${seat}`), `nothing stored for ${seat}`);
});

test('#1561 launch: a read-scope key is refused on a unit write (scope is enforced, not just identity)', { skip: SKIP }, async () => {
  const r = await call(ON, 'POST', '/api/memories', 'ro', memory('refused-ro'));
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(r.body.code, 'GRAPH_WRITE_SCOPE');
  assert.equal(r.body.reason, 'SCOPE_INSUFFICIENT');
  assert.ok(!(await titles(ON)).includes('refused-ro'));
});

test('#1561 launch: a matched act key writes a memory and declares its own seat', { skip: SKIP }, async () => {
  const ok = await call(ON, 'POST', '/api/memories', 'bob', memory('bob-ok'));
  assert.ok(ok.status === 200 || ok.status === 201, JSON.stringify(ok.body));
  assert.ok((await titles(ON)).includes('bob-ok'));
  const s = await call(ON, 'PUT', '/api/seats/bob/state', 'bob', SEAT);
  assert.equal(s.status, 200, JSON.stringify(s.body));
});

test('#1561 launch: the key carries the ENFORCED context — #1569 seat-self and the body assertion run in observe', { skip: SKIP }, async () => {
  const other = await call(ON, 'PUT', '/api/seats/ada/state', 'bob', SEAT);
  assert.equal(other.status, 403, JSON.stringify(other.body));
  assert.equal(other.body.code, 'SEAT_NOT_SELF');
  const own = await call(ON, 'PUT', '/api/seats/ada/state', 'ada', SEAT);
  assert.equal(own.status, 200, 'twin: ada declares her own');
  // body assertion: a memory sent by bob's key naming `by: ada` is stored with bob as the writer
  const m = await call(ON, 'POST', '/api/memories', 'bob', { owner: 'bob', title: 'relay', body: 'b', by: 'ada' });
  assert.ok(m.status === 200 || m.status === 201, JSON.stringify(m.body));
  const v = await call(ON, 'GET', `/api/memories/${m.body.id}/versions`);
  const first = (v.body?.versions ?? v.body ?? [])[0];
  assert.equal(first?.author, 'bob', `the writer is the key's seat, not the body's claim: ${JSON.stringify(v.body)}`);
});

test('#1561 launch: anonymous reads and non-graph writes are unchanged in observe', { skip: SKIP }, async () => {
  assert.equal((await call(ON, 'GET', '/api/memories')).status, 200);
  assert.equal((await call(ON, 'GET', '/api/decisions')).status, 200);
  assert.equal((await call(ON, 'GET', '/api/seats/state')).status, 200);
  const c = await call(ON, 'POST', '/api/conversations', null, { author: 'bob', body: 'anon post still lands' });
  assert.ok(c.status === 200 || c.status === 201, JSON.stringify(c.body));
});

test('#1561 launch: with the unit OFF, observe is exactly as before — an anonymous memory write lands', { skip: SKIP }, async () => {
  const r = await call(OFF, 'POST', '/api/memories', null, memory('off-anon'));
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body));
});
