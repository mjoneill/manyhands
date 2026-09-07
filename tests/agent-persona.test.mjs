/**
 * #1199 — AN AGENT IS A GRAPH NODE; ITS PROMPT IS A VERSIONED DOCUMENT.
 *
 * The owner's scope: the server must not know what a librarian or a reviewer
 * is. A colleague's job lives in two data fields — the prompt and the tool
 * grants — and communities fill them with work nobody here has imagined.
 *
 * Done-when, verbatim: Settings can create an agent, pick a model, write and
 * re-version its prompt, set tool grants and budget; `?a a scrum:Agent`
 * returns it with its current prompt version.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';
import { buildMessages, guestOnce } from '../core/guest-loop.mjs';
import { callModel } from '../core/model-adapter.mjs';

const api = async (baseUrl, method, p, body) => {
  const r = await fetch(`${baseUrl}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let parsed = null; try { parsed = await r.json(); } catch { /* none */ }
  return { status: r.status, body: parsed };
};
const sparql = async (baseUrl, query) => { const r = await api(baseUrl, 'POST', '/api/graph', { query }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.rows; };
const MODEL = { model: 'gemma4:26b', protocol: 'ollama-native', baseUrl: 'http://localhost:11434' };
const GIZMO = { seatKey: 'gizmo', name: 'Gizmo', emoji: '🔧', prompt: 'Answer only from what you are handed.', model: MODEL, toolGrants: ['conversation_post'], budgetPerDay: 0.5, residency: 'guest', by: 'ada' };

test('#1199 create → the node exists with prompt VERSION 1; a duplicate seat key is refused; the prompt cannot be overwritten by PATCH', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const c = await api(srv.baseUrl, 'POST', '/api/agents', GIZMO);
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(c.body.seatKey, 'gizmo'); assert.equal(c.body.prompt.version, 1); assert.equal(c.body.prompt.body, GIZMO.prompt);
    assert.deepEqual(c.body.toolGrants, ['conversation_post']); assert.equal(c.body.budgetPerDay, 0.5); assert.equal(c.body.state, 'invited');
    const dup = await api(srv.baseUrl, 'POST', '/api/agents', GIZMO);
    assert.equal(dup.status, 409, 'creating it again would fork the identity');
    const over = await api(srv.baseUrl, 'PATCH', '/api/agents/gizmo', { prompt: 'new text', by: 'ada' });
    assert.equal(over.status, 400); assert.match(over.body.error, /VERSION/);
  } finally { await srv.stop(); }
});

test('#1199 REFUSALS that protect the record: no prompt · no model · a model spec carrying a key · a bad seat key · no by', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    assert.equal((await api(srv.baseUrl, 'POST', '/api/agents', { ...GIZMO, prompt: '' })).status, 400);
    assert.equal((await api(srv.baseUrl, 'POST', '/api/agents', { ...GIZMO, model: null })).status, 400);
    const keyed = await api(srv.baseUrl, 'POST', '/api/agents', { ...GIZMO, model: { ...MODEL, apiKey: 'sk-live-x' } });
    assert.equal(keyed.status, 400); assert.match(keyed.body.error, /apiKeyRef/, 'a key in a snapshotted document is a key in every later snapshot');
    assert.equal((await api(srv.baseUrl, 'POST', '/api/agents', { ...GIZMO, seatKey: 'Not A Seat!' })).status, 400);
    assert.equal((await api(srv.baseUrl, 'POST', '/api/agents', { ...GIZMO, by: '' })).status, 400);
    assert.equal((await api(srv.baseUrl, 'GET', '/api/agents')).body.length, 0, 'nothing landed');
  } finally { await srv.stop(); }
});

test('#1199 re-versioning keeps version 1 intact, moves currentPrompt, and the graph answers the card\'s own query with the CURRENT version', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    await api(srv.baseUrl, 'POST', '/api/agents', GIZMO);
    const v2 = await api(srv.baseUrl, 'POST', '/api/agents/gizmo/prompt', { body: 'Be brief, and cite a card.', by: 'bo' });
    assert.equal(v2.status, 201); assert.equal(v2.body.prompt.version, 2); assert.equal(v2.body.promptVersions, 2);
    const rows = await sparql(srv.baseUrl, `SELECT ?seat ?v ?body WHERE { ?a a scrum:Agent ; scrum:seatKey ?seat ; scrum:currentPrompt ?p . ?p scrum:version ?v ; scrum:body ?body }`);
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.equal(rows[0].seat, 'gizmo'); assert.equal(Number(rows[0].v), 2); assert.equal(rows[0].body, 'Be brief, and cite a card.');
    const v1 = await sparql(srv.baseUrl, `SELECT ?body WHERE { ?p a scrum:AgentPromptVersion ; scrum:version 1 ; scrum:body ?body }`);
    assert.equal(v1.length, 1); assert.equal(v1[0].body, GIZMO.prompt, 'version 1 is still there, byte for byte');
    // identity is free: the agent is sameAs the person node with its seat key
    const same = await sparql(srv.baseUrl, `SELECT ?p WHERE { ?a a scrum:Agent ; scrum:seatKey "gizmo" ; schema:sameAs ?p }`);
    assert.equal(same.length, 1); assert.match(String(same[0].p), /gizmo$/);
    // grants are triple patterns
    const grants = await sparql(srv.baseUrl, `SELECT ?a WHERE { ?a a scrum:Agent ; scrum:toolGrant "conversation_post" }`);
    assert.equal(grants.length, 1);
  } finally { await srv.stop(); }
});

test('#1199 PATCH sets state, grants, budget and model; a bad state is refused; retired is queryable', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    await api(srv.baseUrl, 'POST', '/api/agents', GIZMO);
    assert.equal((await api(srv.baseUrl, 'PATCH', '/api/agents/gizmo', { state: 'asleep', by: 'ada' })).status, 400);
    const p = await api(srv.baseUrl, 'PATCH', '/api/agents/gizmo', { state: 'retired', toolGrants: [], budgetPerDay: 0, by: 'ada' });
    assert.equal(p.status, 200); assert.equal(p.body.state, 'retired'); assert.deepEqual(p.body.toolGrants, []); assert.equal(p.body.budgetPerDay, 0);
    assert.equal((await api(srv.baseUrl, 'GET', '/api/agents?state=retired')).body.length, 1);
    assert.equal((await api(srv.baseUrl, 'PATCH', '/api/agents/nobody', { state: 'resting', by: 'ada' })).status, 404);
  } finally { await srv.stop(); }
});

test('#1199 DISCLOSURE is mechanical: a guest is told it will not persist; a resident is told it persists and where its memory lives', () => {
  const wake = { id: 'm1', author: 'bo', body: '@gizmo hi', createdAt: '2026-09-06T10:00:00Z' };
  const g = buildMessages({ agent: { seatKey: 'gizmo', residency: 'guest', model: MODEL }, wake });
  assert.match(g[0].content, /will not persist/);
  const r = buildMessages({ agent: { seatKey: 'gizmo', residency: 'resident', model: MODEL }, wake });
  assert.match(r[0].content, /persist across wakes/); assert.match(r[0].content, /memory store/);
});

test('#1199 → #1202: a run from a BOARD agent records its prompt VERSION on the model-call row, so "which prompt wrote that post" is one hop', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    await api(srv.baseUrl, 'POST', '/api/agents', GIZMO);
    const a = (await api(srv.baseUrl, 'GET', '/api/agents?seat=gizmo')).body[0];
    const agent = { seatKey: a.seatKey, name: a.name, systemPrompt: a.prompt.body, promptVersion: a.prompt.id, residency: a.residency, contextPolicy: a.contextPolicy, model: a.model };
    const mention = (await api(srv.baseUrl, 'POST', '/api/conversations', { body: '@gizmo hello?', author: 'bo' })).body;
    const post = (b) => api(srv.baseUrl, 'POST', '/api/conversations', b).then((r) => r.body);
    const ledgerSink = async (row) => (await api(srv.baseUrl, 'POST', '/api/model-calls', { by: row.agent, model: row.model, promptVersion: row.promptVersion, producedPost: row.postId, cost: 0 })).body;
    const ok = { status: 200, body: { message: { content: 'REPLY: hello' }, done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 }, rawBody: '{}' };
    const r = await guestOnce({ agent, wake: mention, callModel: (ag, m, o) => callModel(ag, m, { ...o, transport: async () => ok }), post, ledgerSink, ledgerFile: '/tmp/never-used-1199.jsonl' });
    assert.equal(r.posted, true);
    const rows = await sparql(srv.baseUrl, `SELECT ?pv ?body WHERE { ?x a scrum:ModelCall ; scrum:producedPost entity:${r.postId} ; scrum:promptVersion ?pv . ?v a scrum:AgentPromptVersion ; scrum:body ?body . FILTER(STR(?v) = ?pv) }`);
    assert.equal(rows.length, 1, `the post → the call → the prompt version that wrote it: ${JSON.stringify(rows)}`);
    assert.equal(rows[0].body, GIZMO.prompt);
  } finally { await srv.stop(); }
});

test('#1199 the Settings page carries the Agents panel: create, list, and save-as-new-version — wired to the routes above', () => {
  const html = fs.readFileSync(new URL('../settings.html', import.meta.url), 'utf8');
  assert.match(html, /id="agents-panel"/); assert.match(html, /fetch\('\/api\/agents'/);
  assert.match(html, /\/api\/agents\/\$\{encodeURIComponent\(a\.seatKey\)\}\/prompt/, 'editing mints a version');
  assert.match(html, /No key is ever stored/);
});
