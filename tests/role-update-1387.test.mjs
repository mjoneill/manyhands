/**
 * #1387 — a role can be REVISED, and its history kept. `role_create` refuses
 * a twin ("revise it rather than minting a twin") and nothing revised, so the
 * Scrum Master's amended definition (#272, 09-14) could not reach her prompt.
 *
 * PATCH /api/roles/:key (and MCP role_update) changes definition / name /
 * definedBy on the SAME node (declarations point at its IRI), and keeps every
 * prior state as a scrum:RoleVersion — the #1199 pattern — so "what was the
 * SM told on 09-13 vs 09-15" is a query.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { startRestServer, startPair, mcpSession, makeBoardFixture } from './helpers/harness.mjs';

const ts = '2026-09-14T00:00:00.000Z';
const card = (shortId, title) => ({ id: `c${shortId}`, shortId, title, description: '', type: 'task', column: 'backlog', order: shortId, assignees: ['unassigned'], labels: [], priority: null, createdAt: ts, updatedAt: ts, version: 1 });
const api = (base) => async (method, p, body) => { const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const DEF1 = 'Holds the sequence honest, names gates, asks rather than asserts — the witness of the room.';
const DEF2 = 'Accountable for the team\'s effectiveness: coaches craft, causes impediments to be removed, serves the PO, owns the cadence.';

test('#1387 PATCH revises the definition on the SAME node, keeps the prior state as version 1, and the role section carries the new text', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [card(272, 'the SM card'), card(915, 'the intake')], nextShortId: 916 }) });
  try {
    const call = api(srv.baseUrl);
    const minted = await call('POST', '/api/roles', { key: 'scrum-master', name: 'Scrum Master', definition: DEF1, definedBy: 272, by: 'ada' });
    assert.equal(minted.status, 201, JSON.stringify(minted.body));
    assert.equal(minted.body.version, 1, 'a minted role is version 1');
    // hold it, so the section can be read for a seat
    const decl = await call('PUT', '/api/seats/pip/state', { mode: 'available', acceptsRoutineWork: true, expiresAt: new Date(Date.now() + 3600_000).toISOString(), role: 'scrum-master' });
    assert.equal(decl.status, 200, JSON.stringify(decl.body));
    let sec = await call('GET', '/api/seats/pip/role-section');
    assert.match(sec.body.section, /witness of the room/);

    const up = await call('PATCH', '/api/roles/scrum-master', { definition: DEF2, by: 'bo' });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal(up.body.key, 'scrum-master');
    assert.equal(up.body.version, 2);
    assert.equal(up.body.definition, DEF2);
    assert.equal(up.body.id, minted.body.id, 'same IRI — the declaration still points at it');
    // the section follows the CURRENT definition
    sec = await call('GET', '/api/seats/pip/role-section');
    assert.match(sec.body.section, /owns the cadence/);
    assert.doesNotMatch(sec.body.section, /witness of the room/);
    // the prior state is a version node, queryable
    const q = await call('POST', '/api/graph', { query: 'SELECT ?v ?n ?text WHERE { ?v a scrum:RoleVersion ; scrum:ofRole ?r ; scrum:version ?n ; schema:text ?text . ?r scrum:roleKey "scrum-master" } ORDER BY ?n', by: 'ada' });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    const rows = q.body.rows.map((r) => [Number(r.n), String(r.text).slice(0, 20)]);
    assert.deepEqual(rows, [[1, DEF1.slice(0, 20)], [2, DEF2.slice(0, 20)]], 'both states are on the record: ' + JSON.stringify(q.body.rows));
    // and the role node says which is current
    const cur = await call('POST', '/api/graph', { query: 'SELECT ?n WHERE { ?r a scrum:Role ; scrum:roleKey "scrum-master" ; scrum:version ?n }', by: 'ada' });
    assert.equal(Number(cur.body.rows[0]?.n), 2);
    // list carries the version and the versions count
    const list = await call('GET', '/api/roles');
    const sm = list.body.roles.find((r) => r.key === 'scrum-master');
    assert.equal(sm.version, 2); assert.equal(sm.versions, 2);
  } finally { await srv.stop(); }
});

test('#1387 refusals: unknown key → 404; no field → 400; definedBy naming no card → 400; key is immutable; by required', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [card(272, 'the SM card')], nextShortId: 273 }) });
  try {
    const call = api(srv.baseUrl);
    await call('POST', '/api/roles', { key: 'po', name: 'Product Owner', definition: DEF1, definedBy: 272, by: 'ada' });
    assert.equal((await call('PATCH', '/api/roles/nope', { definition: DEF2, by: 'ada' })).status, 404);
    assert.equal((await call('PATCH', '/api/roles/po', { by: 'ada' })).status, 400, 'nothing to change');
    assert.equal((await call('PATCH', '/api/roles/po', { definedBy: 999, by: 'ada' })).status, 400);
    assert.equal((await call('PATCH', '/api/roles/po', { definition: DEF2 })).status, 400, 'by required');
    assert.equal((await call('PATCH', '/api/roles/po', { key: 'sm', definition: DEF2, by: 'ada' })).status, 400, 'key cannot change');
    assert.equal((await call('PATCH', '/api/roles/po', { definition: 'too short', by: 'ada' })).status, 400);
    const still = (await call('GET', '/api/roles')).body.roles.find((r) => r.key === 'po');
    assert.equal(still.version, 1, 'a refused revision writes nothing');
  } finally { await srv.stop(); }
});

test('#1387 MCP role_update reaches the route', async () => {
  const pair = await startPair({ board: makeBoardFixture({ cards: [card(272, 'the SM card')], nextShortId: 273 }) });
  try {
    const call = api(pair.rest.baseUrl);
    await call('POST', '/api/roles', { key: 'po', name: 'Product Owner', definition: DEF1, definedBy: 272, by: 'ada' });
    const s = await mcpSession(pair.mcp.mcpUrl);
    const r = await s.callTool('role_update', { key: 'po', definition: DEF2, by: 'ada' });
    const j = JSON.parse(r.result?.content?.[0]?.text ?? JSON.stringify(r));
    assert.equal(j.version, 2, JSON.stringify(j));
    assert.equal(j.definition, DEF2);
  } finally { await pair.stop(); }
});

// A fake OpenAI-completions vendor that answers with what its prompt said about the role.
function vendor() {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw); calls.push(body);
      const sys = (body.messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n');
      const content = /owns the cadence/.test(sys) ? 'REPLY: my prompt says I own the cadence.' : /witness of the room/.test(sys) ? 'REPLY: my prompt says I am the witness.' : 'REPLY: no role in my prompt.';
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } }));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ calls, baseUrl: `http://127.0.0.1:${srv.address().port}`, stop: () => new Promise((r) => srv.close(r)) })));
}
function runOnce(env, seat) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [new URL('../scripts/guest-once.mjs', import.meta.url).pathname, '--seat', seat], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

test('#1387 SEAM: a resident holding the role wakes after the revision and its prompt carries the NEW sentence', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [card(272, 'the SM card')], nextShortId: 273 }) });
  const v = await vendor();
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'role-update-')), 'pip.state.json');
  try {
    const call = api(srv.baseUrl);
    await call('POST', '/api/roles', { key: 'scrum-master', name: 'Scrum Master', definition: DEF1, definedBy: 272, by: 'ada' });
    const made = await call('POST', '/api/agents', { seatKey: 'pip', prompt: 'You are pip.', model: { model: 'fake', protocol: 'openai-completions', baseUrl: v.baseUrl }, residency: 'guest', contextPolicy: 'artifact-only', by: 'ada' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    await call('PUT', '/api/seats/pip/state', { mode: 'available', acceptsRoutineWork: true, expiresAt: new Date(Date.now() + 3600_000).toISOString(), role: 'scrum-master' });
    const env = { SCRUM_BOARD_URL: srv.baseUrl, SCRUM_GUEST_STATE_FILE: stateFile };
    await call('POST', '/api/conversations', { author: 'ada', body: '@pip what does your prompt say?' });
    const r1 = await runOnce(env, 'pip'); assert.equal(r1.code, 0, r1.err);
    await call('PATCH', '/api/roles/scrum-master', { definition: DEF2, by: 'bo' });
    await call('POST', '/api/conversations', { author: 'ada', body: '@pip and now?' });
    const r2 = await runOnce(env, 'pip'); assert.equal(r2.code, 0, r2.err);
    const posts = await call('GET', '/api/conversations?attachedTo=null&limit=50');
    const mine = (Array.isArray(posts.body) ? posts.body : posts.body.conversations).filter((m) => m.author === 'pip').map((m) => m.body);
    assert.ok(mine.some((b) => /witness/.test(b)), 'wake 1 saw version 1: ' + JSON.stringify(mine));
    assert.ok(mine.some((b) => /own the cadence/.test(b)), 'wake 2 saw version 2: ' + JSON.stringify(mine));
  } finally { await v.stop(); await srv.stop(); }
});
