/**
 * #1376 — a role held on the board reaches the agent's PROMPT.
 *
 * A role that lives only in scrollback is re-interpreted every wake (the
 * specimen: a Scrum Master who reconstructed the role as "claim a build").
 * So: while a seat's OPEN declaration holds a scrum:Role (#915), its system
 * prompt carries a short ROLE SECTION — the role's name, the role's own short
 * definition, and the pointer to the card holding the full text — assembled
 * at wake time from the graph, never written into the prompt version (#1199:
 * the prompt is identity; the role is state). No declaration → no section,
 * not an empty heading. Visible where prompts are visible (#1350).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { roleSectionFor, ROLE_SECTION_HEADING } from '../core/role-section.mjs';
import { buildMessages } from '../core/guest-loop.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const api = async (base, method, p, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const IN_1H = () => new Date(Date.now() + 3600_000).toISOString();
const ROLE = { key: 'scrum-master', name: 'Scrum Master (Reflective Facilitator)', definition: 'Helps the team live the values of scrum; asks, never asserts; sequences and holds gates by their real names; does not pull builds.', definedBy: { shortId: 272, title: 'Reflective Facilitator agent' } };

test('#1376 roleSectionFor — holds → a few lines naming the role, its own definition and the pointer; no live holding → empty string, no heading', () => {
  const held = roleSectionFor({ seat: 'bo', seats: [{ seat: 'bo', mode: 'available', role: 'scrum-master' }], roles: [ROLE] });
  assert.ok(held.startsWith(ROLE_SECTION_HEADING), held);
  assert.match(held, /currently serving as Scrum Master/);
  assert.match(held, /asks, never asserts/, 'the role\'s own words ride, not a paraphrase');
  assert.match(held, /#272/, 'the pointer to the full definition');
  assert.match(held, /scrum-master/, 'and the role key, so the seat can look it up');
  assert.ok(held.split('\n').length <= 6, `a few lines, not a page — got ${held.split('\n').length}`);

  assert.equal(roleSectionFor({ seat: 'bo', seats: [{ seat: 'bo', mode: 'available' }], roles: [ROLE] }), '', 'no role → nothing');
  assert.equal(roleSectionFor({ seat: 'bo', seats: [{ seat: 'bo', mode: 'unknown', role: 'scrum-master', expired: true }], roles: [ROLE] }), '', 'an expired/UNKNOWN row holds nothing');
  assert.equal(roleSectionFor({ seat: 'bo', seats: [{ seat: 'ada', mode: 'available', role: 'scrum-master' }], roles: [ROLE] }), '', 'someone else\'s role is not mine');
  const orphan = roleSectionFor({ seat: 'bo', seats: [{ seat: 'bo', mode: 'available', role: 'po' }], roles: [ROLE] });
  assert.match(orphan, /po/, 'a held key the roles list cannot describe still names the key — the holding is a fact even if the definition is missing');
  assert.doesNotMatch(orphan, /undefined/);
});

test('#1376 buildMessages — the section sits AFTER the identity prompt and BEFORE the wake; absent means absent (no heading at all)', () => {
  const agent = { seatKey: 'bo', name: 'Bo', residency: 'resident', systemPrompt: 'Be brief and kind.', toolGrants: [] };
  const wake = { kind: 'mention', id: 'm1', author: 'ada', body: '@bo hello', createdAt: new Date().toISOString() };
  const section = roleSectionFor({ seat: 'bo', seats: [{ seat: 'bo', mode: 'available', role: 'scrum-master' }], roles: [ROLE] });
  const withRole = buildMessages({ agent: { ...agent, roleSection: section }, wake });
  const sys = withRole[0].content;
  assert.ok(sys.includes('Be brief and kind.'));
  assert.ok(sys.includes(ROLE_SECTION_HEADING), 'the section is in the SYSTEM message');
  assert.ok(sys.indexOf('Be brief and kind.') < sys.indexOf(ROLE_SECTION_HEADING), 'identity first, then the role — the role is state, not identity');
  const without = buildMessages({ agent, wake });
  assert.equal(without[0].content.includes(ROLE_SECTION_HEADING), false, 'no heading when no role — absence is absence');
  assert.equal(buildMessages({ agent: { ...agent, roleSection: '' }, wake })[0].content.includes(ROLE_SECTION_HEADING), false);
});

const fresh = () => makeBoardFixture({ cards: [{ id: 'c272', shortId: 272, title: 'Reflective Facilitator agent', column: 'backlog', createdAt: '2026-06-24T00:00:00.000Z', updatedAt: '2026-06-24T00:00:00.000Z' }], nextShortId: 273 });

test('#1376 SERVED — GET /api/seats/:seat/role-section follows the declaration: held → section; released → empty; and the constraints view shows it as derived from the graph', async () => {
  const srv = await startRestServer({ board: fresh() });
  try {
    const a = await api(srv.baseUrl, 'POST', '/api/agents', { seatKey: 'bo', prompt: 'Be brief.', model: { model: 'fake', protocol: 'ollama-native', baseUrl: 'http://127.0.0.1:1' }, residency: 'resident', by: 'ada' });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    const none = await api(srv.baseUrl, 'GET', '/api/seats/bo/role-section');
    assert.equal(none.status, 200, JSON.stringify(none.body));
    assert.equal(none.body.section, '');
    assert.equal(none.body.role, null);

    assert.equal((await api(srv.baseUrl, 'POST', '/api/roles', { by: 'ada', key: 'scrum-master', name: ROLE.name, definition: ROLE.definition, definedBy: 272 })).status, 201);
    assert.equal((await api(srv.baseUrl, 'PUT', '/api/seats/bo/state', { mode: 'available', acceptsRoutineWork: true, expiresAt: IN_1H(), role: 'scrum-master' })).status, 200);
    let held;
    for (let i = 0; i < 40; i++) { held = await api(srv.baseUrl, 'GET', '/api/seats/bo/role-section'); if (held.body?.section) break; await new Promise((r) => setTimeout(r, 50)); }
    assert.match(held.body.section, /currently serving as Scrum Master/, JSON.stringify(held.body));
    assert.match(held.body.section, /#272/);
    assert.equal(held.body.role.key, 'scrum-master');

    const cons = await api(srv.baseUrl, 'GET', '/api/agents/bo/constraints');
    assert.equal(cons.status, 200, JSON.stringify(cons.body));
    assert.equal(cons.body.constraints.role.value.key, 'scrum-master', JSON.stringify(cons.body.constraints.role));
    assert.equal(cons.body.constraints.role.source, 'board', 'the role is read from the graph, not the agent record');
    assert.match(cons.body.constraints.role.section, /Scrum Master/);

    assert.equal((await api(srv.baseUrl, 'PUT', '/api/seats/bo/state', { mode: 'available', acceptsRoutineWork: true, expiresAt: IN_1H(), role: null })).status, 200);
    let gone;
    for (let i = 0; i < 40; i++) { gone = await api(srv.baseUrl, 'GET', '/api/seats/bo/role-section'); if (gone.body?.section === '') break; await new Promise((r) => setTimeout(r, 50)); }
    assert.equal(gone.body.section, '', 'released → no section on the next read');
    assert.equal((await api(srv.baseUrl, 'GET', '/api/agents/bo/constraints')).body.constraints.role.value, null);
  } finally { await srv.stop(); }
});

// ── the runner: the assembled prompt carries the section, read off the model's wire ──
function fakeOllama(reply) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => { calls.push({ url: req.url, body: raw }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: 'fake', message: { role: 'assistant', content: reply }, done: true, done_reason: 'stop', prompt_eval_count: 40, eval_count: 9 })); });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ calls, baseUrl: `http://127.0.0.1:${srv.address().port}`, stop: () => new Promise((r) => srv.close(r)) })));
}
const runOnce = (env, args = []) => new Promise((resolve) => {
  const p = spawn(process.execPath, [new URL('../scripts/guest-once.mjs', import.meta.url).pathname, '--seat', 'bo', ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
  p.on('close', (code) => resolve({ code, out, err }));
});

test('#1376 RUNNER SEAM — a wake of a seat holding a role sends the section to the model; the same seat with the role released sends none', async () => {
  const srv = await startRestServer({ board: fresh() });
  const ollama = await fakeOllama('REPLY: noted.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'role-prompt-'));
  const env = { SCRUM_BOARD_URL: srv.baseUrl, SCRUM_GUEST_STATE_FILE: path.join(dir, 'bo.state.json') };
  try {
    assert.equal((await api(srv.baseUrl, 'POST', '/api/agents', { seatKey: 'bo', prompt: 'Be brief.', model: { model: 'fake', protocol: 'ollama-native', baseUrl: ollama.baseUrl }, residency: 'resident', contextPolicy: 'artifact-only', by: 'ada', wakeOn: ['mention'] })).status, 201);
    assert.equal((await api(srv.baseUrl, 'POST', '/api/roles', { by: 'ada', key: 'scrum-master', name: ROLE.name, definition: ROLE.definition, definedBy: 272 })).status, 201);
    assert.equal((await api(srv.baseUrl, 'PUT', '/api/seats/bo/state', { mode: 'available', acceptsRoutineWork: true, expiresAt: IN_1H(), role: 'scrum-master' })).status, 200);
    await api(srv.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: '@bo what is your role?' });
    const r1 = await runOnce(env);
    assert.equal(r1.code, 0, r1.err + r1.out);
    assert.equal(ollama.calls.length, 1, r1.out + r1.err);
    assert.ok(ollama.calls[0].body.includes('currently serving as Scrum Master'), 'the model was told the role');
    assert.match(r1.out + r1.err, /\[#1376\] role: scrum-master/, 'and the runner said so on its log line');

    assert.equal((await api(srv.baseUrl, 'PUT', '/api/seats/bo/state', { mode: 'available', acceptsRoutineWork: true, expiresAt: IN_1H(), role: null })).status, 200);
    await api(srv.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: '@bo and now?' });
    const r2 = await runOnce(env);
    assert.equal(r2.code, 0, r2.err + r2.out);
    assert.equal(ollama.calls.length, 2, r2.out + r2.err);
    assert.equal(ollama.calls[1].body.includes(ROLE_SECTION_HEADING), false, 'released → the next wake carries no section, no heading');
    assert.match(r2.out + r2.err, /\[#1376\] role: none/);
  } finally { await ollama.stop(); await srv.stop(); }
});
