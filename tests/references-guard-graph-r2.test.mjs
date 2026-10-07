/**
 * #1624 K13, THE REFERENCE GUARD: a role's `definedBy` and an obligation's `about` point at a card. The document path checks that the card exists and writes the role inside ONE critical section, so no card can vanish between the two. A generic graph write has no
 * critical section: unless the check is part of the SAME update as the write, a card deleted after the check and before the write leaves a role that points at nothing. The build owner's rule (#1624): when a write SETS or CHANGES a reference, the same update requires the referenced
 * subject to exist, so a concurrent delete makes the write fail its precondition instead of dangling. A write that leaves the reference unchanged is not guarded, and deleting the target is never blocked: no permanent-reference semantics. Same template as the other K13 rows:
 * REST with a REAL executor behind a proxy, written by the separate test author BEFORE the build, synthetic content. Switches: `SCRUM_GRAPH_UNIT_CARDS` AND `SCRUM_GRAPH_UNIT_SMALLKINDS` (a card reference can only be guarded in the graph when the cards are in it).
 * Without a python with pyoxigraph the unit-on rows are SKIPPED, and a skip is NOT a pass.
 *
 * THE INTERLEAVE IS BUILT, NOT RACED: the proxy HOLDS the one update that carries the role's (or obligation's) own marker text; while it is held the card is deleted through a SECOND EXECUTOR CLIENT that talks to the executor directly (a valid guarded `card.write` remove, built with the build's own card helpers),
 * not through the REST server, whose shared write lock would queue a REST delete behind the held write and never exercise the race; then the held update is released. Nothing depends on timing.
 *
 *   R4-0  CONTROL (unit off): the document path's answers for the same steps, recorded as the oracle: after the target card is deleted, a role revise that does NOT touch `definedBy` is answered X, and a create naming the deleted card is answered 400.
 *   R4a   A ROLE CREATE whose update is held while its `definedBy` card is deleted: refused (400, 409 or 412: a determinate refusal, never a 201, never a 5xx), the role is in neither the list nor the executor's store.
 *   R4b   AN OBLIGATION CREATE, the same with `about`.
 *   R4c   A ROLE REVISE that CHANGES `definedBy` to a second card, held while that second card is deleted: refused, and the role still points at its first card.
 *   R4d   NO PERMANENT REFERENCE (unit on): a role created and committed, THEN its card deleted: the delete succeeds; and a revise that leaves `definedBy` alone is answered as the unit-off server answers it (R4-0), not refused for the dangling reference.
 *
 * NOT COVERED, by name: references to a decision, a memory or a predicate (only cards are used); a reference set on a role VERSION; a held write that is a lost-ack or request-not-arrived case (the lost-ack rows); the document copy's state after a refused write; a hold released after the proxy gives up (this row releases it
 * itself).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createGraphClient } from '../core/graph-client.mjs';
import { cardIriOf, priorQuads, shortIdMap } from '../core/cards-graph.mjs';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const ROSTER_FILE = path.join(os.tmpdir(), `r2k-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, gizmo: { name: 'Gizmo', glyph: 'g', color: '#c4a07c' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (base, method, route, body) => {
  const res = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, text };
};
const ALNUM = () => `${process.pid}x${Date.now().toString(36)}`.replace(/[^a-z0-9]/gi, '').toLowerCase();
const DEFN = (m) => `${m} is a role used only by these rows and it commits a seat to nothing in particular at all`;
const REFUSED = [400, 409, 412];

/** a proxy that can HOLD the one `POST /update` whose body carries a marker, until `release()` is called; it counts the updates that pass through while one is held */
async function startProxy(execUrl) {
  const p = { hold: null, passedWhileHeld: 0 };
  p.arm = (marker) => { let release; const gate = new Promise((r) => { release = r; }); p.hold = { marker, gate, release, held: false, released: false }; p.passedWhileHeld = 0; return p.hold; };
  p.server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const bodyBuf = Buffer.concat(chunks); const fwd = { ...req.headers }; delete fwd.host; delete fwd['content-length']; delete fwd.connection;
    const isUpdate = req.method === 'POST' && req.url.split('?')[0] === '/update'; const h = p.hold; let duringHold = false;
    if (isUpdate && h && !h.held && bodyBuf.toString().includes(h.marker)) { h.held = true; await h.gate; h.released = true; }
    else if (isUpdate && h && h.held && !h.released) duringHold = true;
    try {
      const f = await fetch(`${execUrl}${req.url}`, { method: req.method, headers: fwd, ...(req.method === 'POST' ? { body: bodyBuf } : {}) }); const t = await f.text();
      if (duringHold && f.status === 200) p.passedWhileHeld++;
      res.statusCode = f.status; res.end(t);
    } catch { try { req.socket.destroy(); } catch { /* gone */ } }
  });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r)); p.url = `http://127.0.0.1:${p.server.address().port}`;
  p.down = () => new Promise((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); });
  return p;
}
async function unitOn(body, dsid = 'r2k-test') {
  const exec = await startExecutor({ store: tmpStore('r2k-store-'), datasetId: dsid, create: true });
  const proxy = await startProxy(exec.baseUrl);
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: proxy.url, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_CARDS: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1' } });
  try { return await body({ base: rest.baseUrl, rest, proxy, exec, dsid }); } finally { await rest.stop(); try { await proxy.down(); } catch { /* down */ } await killExecutor(exec); }
}
async function storeN(execUrl, literal) {
  const res = await fetch(`${execUrl}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query' }, body: `SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE { { ?s ?p ?o FILTER(isLiteral(?o) && CONTAINS(STR(?o), ${JSON.stringify(literal)})) } UNION { GRAPH ?g { ?s ?p ?o FILTER(isLiteral(?o) && CONTAINS(STR(?o), ${JSON.stringify(literal)})) } } }`, signal: AbortSignal.timeout(30000) });
  assert.equal(res.status, 200, 'the store scan is answered'); return Number((await res.json()).results.bindings[0].n.value);
}
const mkCard = async (base, title) => { const r = await api(base, 'POST', '/api/cards', { title, description: 'x', createdBy: 'ada' }); assert.equal(r.status, 201, `CONTROL: a card is created (${r.status} ${r.text.slice(0, 100)})`); return r.body; };
const mkRole = (base, key, tag, card) => api(base, 'POST', '/api/roles', { by: 'ada', key, name: `${tag} role`, definition: DEFN(tag), definedBy: card.shortId });
const rolesNamed = async (base, key) => { const r = (await api(base, 'GET', '/api/roles')).body; return (Array.isArray(r) ? r : (r?.roles ?? [])).filter((x) => JSON.stringify(x).includes(key)); };
const obsNamed = async (base, marker) => { const r = (await api(base, 'GET', '/api/obligations')).body; return (Array.isArray(r) ? r : (r?.obligations ?? [])).filter((x) => JSON.stringify(x).includes(marker)); };

/** delete a card the way a second writer would: a guarded `card.write` remove sent straight to the executor, read-then-remove at the stored version */
async function deleteCardDirect(ctx, card) {
  const client = createGraphClient({ baseUrl: ctx.exec.baseUrl, expectedDatasetId: ctx.dsid, timeoutMs: 30000 }); const iri = cardIriOf(card.id);
  const q = await client.query(`SELECT ?v ?j WHERE { <${iri}> <urn:ex:ver> ?v ; <https://scrumboard.local/ns#entityJson> ?j }`);
  assert.ok(q.ok && q.rows.length === 1, `CONTROL: the stored card is read back from the executor (${JSON.stringify(q).slice(0, 160)})`);
  const stored = JSON.parse(q.rows[0].j.value);
  return client.update({ kind: 'card.write', opId: `urn:ex:op/card/${randomUUID()}`, actor: 'https://scrumboard.local/person/board', parts: [{ iri, remove: true, expectedVersion: String(Number(q.rows[0].v.value)), prior: priorQuads(stored, shortIdMap([stored])) }] });
}

/** run `write` with its own update HELD, delete `card` while it is held, release, and return what both answered */
async function interleave(ctx, marker, write, card) {
  const { proxy } = ctx;
  const hold = proxy.arm(marker); const writing = write(); const t0 = Date.now();
  while (!hold.held && Date.now() - t0 < 15000) await sleep(50);
  assert.ok(hold.held, 'PRECONDITION: the write\'s own update reached the proxy and is HELD (otherwise the interleave was never built and this row proves nothing)');
  const d = await deleteCardDirect(ctx, card);
  assert.equal(d.outcome, 'APPLIED', `PRECONDITION: the card delete COMMITTED while the write's update was held (outcome ${d.outcome} ${d.reason ?? ''}); a delete that was refused or is still waiting means the interleave was not built and this row proves nothing`);
  hold.release(); const w = await writing;
  return { w, d };
}

test('R4-0 CONTROL: with the unit OFF, after the target card is deleted a create naming it is 400 and a revise that leaves definedBy alone is answered; the answers are recorded', { timeout: 180000 }, async () => {
  const rest = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  try {
    const tag = ALNUM(); const card = await mkCard(rest.baseUrl, `${tag} target`); const key = `r2-${tag}`;
    assert.equal((await mkRole(rest.baseUrl, key, tag, card)).status, 201, 'CONTROL: the role is created');
    assert.ok((await api(rest.baseUrl, 'DELETE', `/api/cards/${card.id}`)).status < 300, 'the delete is accepted even though a role points at the card');
    assert.equal((await mkRole(rest.baseUrl, `${key}b`, tag, card)).status, 400, 'a create naming the deleted card is refused 400');
    const keep = await api(rest.baseUrl, 'PATCH', `/api/roles/${key}`, { by: 'ada', name: `${tag} renamed` });
    console.log(`R4-0 oracle: revise that leaves definedBy alone, target deleted: ${keep.status}`); assert.ok([200, 400].includes(keep.status), `a recorded answer (${keep.status})`);
  } finally { await rest.stop(); }
});

test('R4a A ROLE CREATE held while its definedBy card is deleted: refused, and the role is in neither the list nor the store', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async (ctx) => {
    const tag = ALNUM(); const card = await mkCard(ctx.base, `${tag} target`); const key = `r2a-${tag}`;
    const { w } = await interleave(ctx, key, () => mkRole(ctx.base, key, tag, card), card);
    assert.ok(REFUSED.includes(w.status), `the role write must fail its reference precondition (400/409/412), not be created or error: got ${w.status} ${w.text.slice(0, 160)}; a 201 here is a role that points at a card that no longer exists`);
    assert.equal((await rolesNamed(ctx.base, key)).length, 0, 'the role is not in the list'); assert.equal(await storeN(ctx.exec.baseUrl, key), 0, "and not in the EXECUTOR's store");
  });
});

test('R4b AN OBLIGATION CREATE held while its about card is deleted: refused, and the obligation is in neither the list nor the store', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async (ctx) => {
    const tag = ALNUM(); const card = await mkCard(ctx.base, `${tag} target`); const marker = `${tag} owed`;
    const { w } = await interleave(ctx, marker, () => api(ctx.base, 'POST', '/api/obligations', { by: 'ada', owedBy: 'gizmo', kind: 'promise', about: card.shortId, note: marker }), card);
    assert.ok(REFUSED.includes(w.status), `the obligation write must fail its reference precondition (400/409/412), not be created or error: got ${w.status} ${w.text.slice(0, 160)}`);
    assert.equal((await obsNamed(ctx.base, marker)).length, 0, 'the obligation is not in the list'); assert.equal(await storeN(ctx.exec.baseUrl, marker), 0, "and not in the EXECUTOR's store");
  });
});

test('R4c A ROLE REVISE that CHANGES definedBy, held while the new card is deleted: refused, and the role still points at its first card', { skip: SKIP, timeout: 300000 }, async () => {
  await unitOn(async (ctx) => {
    const tag = ALNUM(); const first = await mkCard(ctx.base, `${tag} first`); const second = await mkCard(ctx.base, `${tag} second`); const key = `r2c-${tag}`;
    assert.equal((await mkRole(ctx.base, key, tag, first)).status, 201, 'CONTROL: the role is created');
    const marker = `${tag} moved`;
    const { w } = await interleave(ctx, marker, () => api(ctx.base, 'PATCH', `/api/roles/${key}`, { by: 'ada', name: marker, definedBy: second.shortId }), second);
    assert.ok(REFUSED.includes(w.status), `the revise must fail its reference precondition (400/409/412): got ${w.status} ${w.text.slice(0, 160)}`);
    const role = (await rolesNamed(ctx.base, key))[0]; assert.ok(role, 'the role is still there'); assert.ok(!JSON.stringify(role).includes(marker), 'and its name did not change');
    assert.ok(JSON.stringify(role).includes(String(first.shortId)) || JSON.stringify(role).includes(first.id), 'and it still points at its first card');
  });
});

test('R4d NO PERMANENT REFERENCE: a role committed and THEN its card deleted: the delete succeeds, and a revise that leaves definedBy alone is answered as the unit-off server answers it', { skip: SKIP, timeout: 300000 }, async () => {
  const off = await startRestServer({ board: makeBoardFixture(), env: { SCRUM_ROSTER_FILE: ROSTER_FILE } });
  let oracle;
  try { const tag = ALNUM(); const card = await mkCard(off.baseUrl, `${tag} target`); const key = `r2d-${tag}`; await mkRole(off.baseUrl, key, tag, card); await api(off.baseUrl, 'DELETE', `/api/cards/${card.id}`); oracle = (await api(off.baseUrl, 'PATCH', `/api/roles/${key}`, { by: 'ada', name: `${tag} renamed` })).status; } finally { await off.stop(); }
  await unitOn(async (ctx) => {
    const tag = ALNUM(); const card = await mkCard(ctx.base, `${tag} target`); const key = `r2d-${tag}`;
    assert.equal((await mkRole(ctx.base, key, tag, card)).status, 201, 'CONTROL: the role is created');
    const del = await api(ctx.base, 'DELETE', `/api/cards/${card.id}`); assert.ok(del.status < 300, `the delete of a referenced card is never blocked (got ${del.status})`);
    const keep = await api(ctx.base, 'PATCH', `/api/roles/${key}`, { by: 'ada', name: `${tag} renamed` }); assert.equal(keep.status, oracle, `a revise that leaves definedBy alone is answered as the unit-off server answers it (${oracle}), got ${keep.status} ${keep.text.slice(0, 120)}`);
  });
});
