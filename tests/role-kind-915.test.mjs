/**
 * #915 slice 1 — ROLE is an entity type (ruled f9e31a70), and a role grant IS a
 * seat declaration: a person holds a typed state for a bounded interval, and
 * the current one is the OPEN interval, never the newest node by date.
 *
 *   scrum:Role            a registered kind (kind-registry, predicate names,
 *                         projection, role_create / role_list) — an instance
 *                         carries a key (po · scrum-master · value-steward…),
 *                         a name, a definition, and `scrum:definedBy` → the
 *                         card that holds the full text (#272, #418). This
 *                         card says twice that the work is CONSOLIDATION: the
 *                         verbs mint roles; they do not invent them.
 *   scrum:role            an optional entity edge on scrum:SeatDeclaration →
 *                         the Role held for that interval. A declaration that
 *                         names a role the board does not hold is refused.
 *
 * The seam: declare a seat with a role over MCP → ask the graph "who holds
 * role X now" → ONE row, the open declaration; a re-declaration without the
 * role ends it, and the same query returns nothing. Nothing else moves: mode,
 * acceptsRoutineWork, expiry and the 168 h cap are untouched (a role held past
 * a week is re-declared, which is exactly how the room grants it today).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRestServer, startPair, mcpSession, makeBoardFixture } from './helpers/harness.mjs';
import { kindByName, ENTITY_KINDS, COLLECTION_OF } from '../core/kind-registry.mjs';
import { PREDICATE_SOURCE } from '../core/predicate-names.mjs';

const api = async (base, method, p, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const IN_1H = () => new Date(Date.now() + 3600_000).toISOString();
const fresh = () => makeBoardFixture({ cards: [{ id: 'role-card-1', shortId: 1, title: 'Reflective Facilitator — the role card', column: 'backlog', createdAt: '2026-06-24T00:00:00.000Z', updatedAt: '2026-06-24T00:00:00.000Z' }], nextShortId: 2 });
const text = (r) => r.result?.content?.[0]?.text ?? JSON.stringify(r);
const graph = async (base, query) => {
  let q;
  for (let i = 0; i < 40; i++) {
    q = await api(base, 'POST', '/api/graph', { query });
    if (q.status === 200) return q;
    await new Promise((r) => setTimeout(r, 50));
  }
  return q;
};

test('#915 scrum:Role is a registered kind with a collection, and the predicate names are declared in code', () => {
  const k = kindByName('scrum:Role');
  assert.ok(k, 'scrum:Role is declared in core/kind-registry.mjs');
  assert.equal(k.eventKind, 'role');
  assert.equal(k.collection, 'roles');
  assert.match(k.createdBy, /role_create/);
  assert.match(k.definition, /consolidat|defin/i);
  assert.ok(ENTITY_KINDS.has('role'), 'the event log accepts entity kind "role"');
  assert.equal(COLLECTION_OF.role, 'roles');
  assert.equal(PREDICATE_SOURCE['scrum:roleKey'], 'scrum:roleKey');
  assert.equal(PREDICATE_SOURCE['scrum:definedBy'], 'scrum:definedBy');
  assert.equal(PREDICATE_SOURCE['scrum:role'], 'scrum:role');
});

test('#915 POST /api/roles mints a role that names its defining card; the key is unique; a definedBy the board does not hold is refused', async () => {
  const srv = await startRestServer({ board: fresh() });
  try {
    const bad = await api(srv.baseUrl, 'POST', '/api/roles', { by: 'ada', key: 'scrum-master', name: 'Scrum Master', definition: 'x'.repeat(50), definedBy: 999 });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.match(bad.body.error, /definedBy/);

    const ok = await api(srv.baseUrl, 'POST', '/api/roles', { by: 'ada', key: 'scrum-master', name: 'Scrum Master (Reflective Facilitator)', definition: 'Coaches the team to live the values of scrum; asks, never asserts; cite-don\'t-guess. Full text on the defining card.', definedBy: 1 });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.key, 'scrum-master');
    assert.match(ok.body.id, /^https:\/\/scrumboard\.local\/role\//);
    assert.ok(ok.body.definedBy, 'the defining card rides the wire as a reference');

    const dup = await api(srv.baseUrl, 'POST', '/api/roles', { by: 'ada', key: 'scrum-master', name: 'again', definition: 'y'.repeat(50) });
    assert.equal(dup.status, 409, 'one role per key — a second mint is a revision, not a twin');

    const list = await api(srv.baseUrl, 'GET', '/api/roles');
    assert.equal(list.status, 200);
    assert.equal(list.body.roles.length, 1);
    assert.equal(list.body.roles[0].key, 'scrum-master');

    const q = await graph(srv.baseUrl, `SELECT ?r ?key ?card WHERE { ?r a scrum:Role ; scrum:roleKey ?key ; scrum:definedBy ?card . ?card a scrum:Card }`);
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.equal(q.body.rows.length, 1, `the role is a node and definedBy is an EDGE that joins to the card — ${JSON.stringify(q.body.rows)}`);
    assert.equal(String(q.body.rows[0].key), 'scrum-master');
  } finally { await srv.stop(); }
});

test('#915 SEAM — declare a seat WITH a role over MCP → "who holds role X now" is ONE graph row, the open declaration; re-declare without it → none; an unknown role is refused', async () => {
  const tokensFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'role-tokens-')), 'tokens.json');
  fs.writeFileSync(tokensFile, JSON.stringify({ tokens: { 'tok-ada': { seat: 'ada', heartbeat_s: 60 } } }));
  const { rest, mcp, stop } = await startPair({ board: fresh(), mcpEnv: { SCRUM_SEAT_TOKENS: tokensFile } });
  try {
    const minted = await api(rest.baseUrl, 'POST', '/api/roles', { by: 'ada', key: 'po', name: 'Product Owner', definition: 'Owns Planned as the sprint; grooms WHY / WHAT / first move; every resident a full participant.' });
    assert.equal(minted.status, 201, JSON.stringify(minted.body));

    const ada = await mcpSession(mcp.mcpUrl, { headers: { Authorization: 'Bearer tok-ada' } });
    const unknown = await ada.callTool('seat_declare', { mode: 'available', acceptsRoutineWork: true, expiresAt: IN_1H(), role: 'value-steward' });
    assert.match(text(unknown), /role/, `a role the board does not hold is refused — ${text(unknown)}`);
    assert.match(text(unknown), /400|UNKNOWN_ROLE|names no scrum:Role/, text(unknown));

    const declared = await ada.callTool('seat_declare', { mode: 'available', acceptsRoutineWork: true, expiresAt: IN_1H(), role: 'po' });
    const dj = JSON.parse(text(declared));
    assert.equal(dj.error, undefined, text(declared));
    assert.equal(dj.role, 'po', 'the declaration reads back with its role');

    const WHO = `SELECT ?d ?seat WHERE { ?d a scrum:SeatDeclaration ; scrum:declaredSeat ?seat ; scrum:role ?r . ?r a scrum:Role ; scrum:roleKey "po" . FILTER NOT EXISTS { ?d scrum:endedAt ?x } }`;
    let q;
    for (let i = 0; i < 40; i++) { q = await api(rest.baseUrl, 'POST', '/api/graph', { query: WHO }); if (q.status === 200 && q.body.rows.length === 1) break; await new Promise((r) => setTimeout(r, 50)); }
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.equal(q.body.rows.length, 1, `exactly one OPEN declaration holds po — ${JSON.stringify(q.body.rows)}`);
    assert.match(String(q.body.rows[0].seat), /ada$/);

    // the API's own read carries it too — not only the graph
    const states = await api(rest.baseUrl, 'GET', '/api/seats/state');
    const mine = states.body.seats.find((x) => x.seat === 'ada');
    assert.ok(mine, JSON.stringify(states.body).slice(0, 300));
    assert.equal(mine.role, 'po');

    // re-declare WITHOUT mentioning the role (an availability change): the
    // role is CARRIED FORWARD — an unrelated declaration never shortens it
    const redo = await ada.callTool('seat_declare', { mode: 'resting', acceptsRoutineWork: false, expiresAt: IN_1H() });
    const rj = JSON.parse(text(redo));
    assert.equal(rj.error, undefined, text(redo));
    assert.equal(rj.role, 'po', 'the new interval carries the role forward');
    for (let i = 0; i < 40; i++) { q = await api(rest.baseUrl, 'POST', '/api/graph', { query: WHO }); if (q.status === 200 && q.body.rows.length === 1 && String(q.body.rows[0].d).includes('seq-')) break; await new Promise((r) => setTimeout(r, 50)); }
    assert.equal(q.body.rows.length, 1, `still exactly ONE open holder — the new interval, not the old — ${JSON.stringify(q.body.rows)}`);

    // release it explicitly: role: null → the prior interval ends and the role goes with it
    const released = await ada.callTool('seat_declare', { mode: 'resting', acceptsRoutineWork: false, expiresAt: IN_1H(), role: null });
    assert.equal(JSON.parse(text(released)).role, undefined, `released — ${text(released)}`);
    for (let i = 0; i < 40; i++) { q = await api(rest.baseUrl, 'POST', '/api/graph', { query: WHO }); if (q.status === 200 && q.body.rows.length === 0) break; await new Promise((r) => setTimeout(r, 50)); }
    assert.equal(q.body.rows.length, 0, 'nobody holds po now: the OPEN interval decides, not the newest node by date');
    const held = await api(rest.baseUrl, 'POST', '/api/graph', { query: `SELECT (COUNT(?d) AS ?n) WHERE { ?d a scrum:SeatDeclaration ; scrum:role ?r ; scrum:endedAt ?x }` });
    assert.equal(Number(held.body.rows[0].n), 2, 'both ended intervals still record that po WAS held — history, not erasure');
    await ada.close?.();
  } finally { await stop(); }
});

test('#915 role_create / role_list over MCP mint and read the same rows', async () => {
  const { rest, mcp, stop } = await startPair({ board: fresh() });
  try {
    const s = await mcpSession(mcp.mcpUrl);
    const made = await s.callTool('role_create', { by: 'ada', key: 'value-steward', name: 'Value Steward', definition: 'A non-builder named at kickoff; writes the Banana Test; binding andon. Full text on the defining card.', definedBy: 1 });
    const mj = JSON.parse(text(made));
    assert.equal(mj.key, 'value-steward', text(made));
    const listed = await s.callTool('role_list', {});
    const lj = JSON.parse(text(listed));
    assert.equal((lj.roles || lj).length, 1);
    const viaRest = await api(rest.baseUrl, 'GET', '/api/roles');
    assert.equal(viaRest.body.roles[0].id, mj.id, 'one store, two doors');
    await s.close?.();
  } finally { await stop(); }
});
