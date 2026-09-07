/**
 * #1202 — THE PROVENANCE LEDGER. One row per model call, as a NODE the graph
 * can query, never a log file (a log file is where the 410 body went to die,
 * #838). Two consumers were waiting: the budget halt (#987) and the egress
 * question (#979, "what left this box for vendor X").
 *
 * The card's done-when, verbatim: after one P5 slice-1 run,
 *   SELECT ?promptVersion ?model ?cost WHERE { ?x a scrum:ModelCall ; scrum:producedPost <that post> }
 * returns one row, and a budget of $0.00 halts the second run with a commons post.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';
import { guestOnce, recordLedger, budgetCheck } from '../core/guest-loop.mjs';
import { callModel } from '../core/model-adapter.mjs';

const api = async (baseUrl, method, p, body) => {
  const r = await fetch(`${baseUrl}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let parsed = null; try { parsed = await r.json(); } catch { /* none */ }
  return { status: r.status, body: parsed };
};
const sparql = async (baseUrl, query) => {
  const r = await api(baseUrl, 'POST', '/api/graph', { query });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.rows;
};
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')), 'model-calls.jsonl');
const AGENT = { seatKey: 'gizmo', model: { model: 'm', protocol: 'ollama-native', baseUrl: 'http://x' } };
// #1254 — these fixtures were written when publishing was IMPLICIT. The gate
// inverted that default, so a fixture that stands for "the model produced a
// reply" now has to say so with the marker, exactly as a real seat does. The
// prefix is added here rather than at 30 call sites, and skipped when the
// fixture's first line is already a directive or a deliberate non-reply — those
// cases are the subject of their own tests. The gate itself is tested in
// tests/explicit-post.test.mjs, never here.
const publishable = (t) => (!String(t ?? '').trim() || /^\s*(REPLY:|REMEMBER:|CLAIM:|NO_REPLY)/i.test(String(t))) ? t : `REPLY: ${t}`;
const ollamaOk = (text) => ({ status: 200, body: { message: { content: publishable(text) }, done: true, done_reason: 'stop', prompt_eval_count: 40, eval_count: 9 }, rawBody: '{}' });
const stubbed = (agent, messages, opts) => callModel(agent, messages, { ...opts, transport: async () => ollamaOk('hello from the model') });

test('#1202 POST /api/model-calls records a row with actor set; GET lists it and sums cost; a row with no `by` is refused', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const bad = await api(srv.baseUrl, 'POST', '/api/model-calls', { model: 'm' });
    assert.equal(bad.status, 400, 'no by → refused (#1193: actor:null forever)');
    const a = await api(srv.baseUrl, 'POST', '/api/model-calls', { by: 'gizmo', model: 'gemma4:26b', provider: 'http://localhost:11434', protocol: 'ollama-native', tokensIn: 40, tokensOut: 9, cost: 0.0025, stopReason: 'stop', latencyMs: 1200, contextHandedTo: ['m-1'], producedPost: 'p-1' });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(a.body.agent, 'gizmo'); assert.equal(a.body.cost, 0.0025);
    const b = await api(srv.baseUrl, 'POST', '/api/model-calls', { by: 'gizmo', model: 'gemma4:26b', cost: 0.001 });
    assert.equal(b.status, 201);
    const list = await api(srv.baseUrl, 'GET', '/api/model-calls?agent=gizmo');
    assert.equal(list.status, 200); assert.equal(list.body.count, 2);
    assert.ok(Math.abs(list.body.spent - 0.0035) < 1e-9, `spent rides the response: ${list.body.spent}`);
    const other = await api(srv.baseUrl, 'GET', '/api/model-calls?agent=nobody');
    assert.equal(other.body.count, 0); assert.equal(other.body.spent, 0);
  } finally { await srv.stop(); }
});

test('#1202 the ledger row is a NODE: the card\'s own query finds the call by the post it produced, with promptVersion, model and cost', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const post = await api(srv.baseUrl, 'POST', '/api/conversations', { body: 'hello from the model', author: 'gizmo' });
    assert.equal(post.status, 201);
    const rec = await api(srv.baseUrl, 'POST', '/api/model-calls', { by: 'gizmo', model: 'gemma4:26b', promptVersion: 'v1', cost: 0.5, tokensIn: 40, tokensOut: 9, producedPost: post.body.id, contextHandedTo: [post.body.id] });
    assert.equal(rec.status, 201);
    const rows = await sparql(srv.baseUrl, `SELECT ?promptVersion ?model ?cost WHERE { ?x a scrum:ModelCall ; scrum:producedPost entity:${post.body.id} ; scrum:promptVersion ?promptVersion ; scrum:model ?model ; scrum:cost ?cost }`);
    assert.equal(rows.length, 1, `one row by producedPost: ${JSON.stringify(rows)}`);
    assert.equal(rows[0].model, 'gemma4:26b'); assert.equal(rows[0].promptVersion, 'v1'); assert.equal(Number(rows[0].cost), 0.5);
    // the egress question: what was handed to the model, as edges
    const handed = await sparql(srv.baseUrl, `SELECT ?c WHERE { ?x a scrum:ModelCall ; scrum:agent person:gizmo ; scrum:contextHandedTo ?c }`);
    assert.equal(handed.length, 1);
    // and SUM works, because cost is a typed number
    const sum = await sparql(srv.baseUrl, `SELECT (SUM(?cost) AS ?spent) WHERE { ?x a scrum:ModelCall ; scrum:agent person:gizmo ; scrum:cost ?cost }`);
    assert.equal(Number(sum[0].spent), 0.5);
  } finally { await srv.stop(); }
});

test('#1202 recordLedger: the board sink is preferred; a refusing sink falls back to the file and says so — a row is never lost', async () => {
  const file = tmp();
  const ok = await recordLedger({ sink: async () => ({ id: 'mc-1' }), file, row: { agent: 'g' } });
  assert.deepEqual(ok, { recorded: 'board', id: 'mc-1' }); assert.equal(fs.existsSync(file), false);
  const errs = [];
  const fb = await recordLedger({ sink: async () => { throw new Error('board down'); }, file, row: { agent: 'g' }, onError: (e) => errs.push(e) });
  assert.equal(fb.recorded, 'file'); assert.equal(errs.length, 1);
  const line = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  assert.equal(line.sinkError, 'board down', 'the row says WHY it is in the file');
});

test('#1202 budgetCheck: no budget → allowed; unreadable ledger → HALT (fails closed); $0.00 allows one call and halts the second', async () => {
  assert.equal((await budgetCheck({ agent: { seatKey: 'g' }, spentToday: async () => ({ spent: 99, count: 9 }) })).allowed, true);
  const closed = await budgetCheck({ agent: { seatKey: 'g', budgetPerDay: 5 }, spentToday: async () => { throw new Error('ledger down'); } });
  assert.equal(closed.allowed, false); assert.match(closed.reason, /budget-unreadable/);
  const first = await budgetCheck({ agent: { seatKey: 'g', budgetPerDay: 0 }, spentToday: async () => ({ spent: 0, count: 0 }) });
  assert.equal(first.allowed, true, 'a $0 budget allows exactly one run');
  const second = await budgetCheck({ agent: { seatKey: 'g', budgetPerDay: 0 }, spentToday: async () => ({ spent: 0, count: 1 }) });
  assert.equal(second.allowed, false); assert.equal(second.reason, 'budget-breached');
});

test('#1202 END TO END on a real board: run one → ledger node with producedPost; a $0.00 budget halts run two with ONE commons post and NO model call', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const agent = { ...AGENT, budgetPerDay: 0 };
    const mention = (await api(srv.baseUrl, 'POST', '/api/conversations', { body: '@gizmo hello?', author: 'bo' })).body;
    const post = (b) => api(srv.baseUrl, 'POST', '/api/conversations', b).then((r) => r.body);
    const ledgerSink = async (row) => (await api(srv.baseUrl, 'POST', '/api/model-calls', { by: row.agent, agent: row.agent, model: row.model, protocol: row.protocol, tokensIn: row.usage?.promptTokens ?? null, tokensOut: row.usage?.completionTokens ?? null, cost: 0, stopReason: row.stopReason, latencyMs: row.latencyMs, ok: row.ok, contextHandedTo: row.contextHandedTo, producedPost: row.postId, at: row.at })).body;
    const spentToday = async (seat) => (await api(srv.baseUrl, 'GET', `/api/model-calls?agent=${seat}`)).body;
    let calls = 0;
    const cm = (a, m, o) => { calls += 1; return stubbed(a, m, o); };
    const r1 = await guestOnce({ agent, wake: mention, callModel: cm, post, ledgerSink, spentToday, ledgerFile: tmp() });
    assert.equal(r1.posted, true); assert.equal(r1.ledger.recorded, 'board'); assert.equal(calls, 1);
    const rows = await sparql(srv.baseUrl, `SELECT ?model WHERE { ?x a scrum:ModelCall ; scrum:producedPost entity:${r1.postId} ; scrum:model ?model }`);
    assert.equal(rows.length, 1, 'run one left a node pointing at its post');
    const r2 = await guestOnce({ agent, wake: mention, callModel: cm, post, ledgerSink, spentToday, ledgerFile: tmp() });
    assert.equal(r2.halted, true); assert.equal(r2.reason, 'budget-breached'); assert.equal(calls, 1, 'NO model call was made');
    const convs = (await api(srv.baseUrl, 'GET', '/api/conversations?attachedTo=null&limit=10')).body;
    const halts = (Array.isArray(convs) ? convs : convs.conversations).filter((m) => m.author === 'gizmo' && /HALTED/.test(m.body));
    assert.equal(halts.length, 1, 'exactly one halt post, as the agent, naming the budget');
    assert.match(halts[0].body, /budget 0/);
  } finally { await srv.stop(); }
});

// ── 2026-09-06 — the ledger dropped the SEED. Found on #1203: a row carrying
// seed 42 and temperature 0 got a 201 and read back without either. A record
// that cannot say how the model was made to answer is an anecdote.
test('#1202 a row keeps its SAMPLING (seed, temperature) on the wire AND in the graph; an unknown top-level field is REFUSED by name, never dropped', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const a = await api(srv.baseUrl, 'POST', '/api/model-calls', { by: 'gizmo', model: 'gemma3:12b', protocol: 'ollama-native', sampling: { seed: 42, temperature: 0, maxTokens: 800 }, wake: { kind: 'mention', messageId: 'm-1' }, memory: { handed: 1, state: 'read' }, memoryWritten: ['mem-1'], claims: [{ card: 7, ok: true }] });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual(a.body.sampling, { seed: 42, temperature: 0, maxTokens: 800 });
    assert.equal(a.body.wake.kind, 'mention'); assert.equal(a.body.memory.handed, 1); assert.deepEqual(a.body.memoryWritten, ['mem-1']); assert.equal(a.body.claims[0].card, 7);
    const listed = (await api(srv.baseUrl, 'GET', '/api/model-calls?agent=gizmo')).body.calls[0];
    assert.equal(listed.sampling.seed, 42, 'read back, not just echoed');
    const rows = (await api(srv.baseUrl, 'POST', '/api/graph', { query: 'SELECT ?seed ?t ?k ?h WHERE { ?c a scrum:ModelCall ; scrum:seed ?seed ; scrum:temperature ?t ; scrum:wakeKind ?k ; scrum:memoryHanded ?h }' })).body.rows;
    assert.equal(rows.length, 1, 'the seed is a graph fact'); assert.equal(rows[0].seed, '42'); assert.equal(rows[0].t, '0'); assert.equal(rows[0].k, 'mention'); assert.equal(rows[0].h, '1');
    const dropped = await api(srv.baseUrl, 'POST', '/api/model-calls', { by: 'gizmo', model: 'm', seed: 42 });
    assert.equal(dropped.status, 400, 'a top-level seed is the shape that was silently dropped'); assert.match(dropped.body.error, /"seed"/);
    const knob = await api(srv.baseUrl, 'POST', '/api/model-calls', { by: 'gizmo', model: 'm', sampling: { temp: 0 } });
    assert.equal(knob.status, 400); assert.match(knob.body.error, /temp/);
    const plain = await api(srv.baseUrl, 'POST', '/api/model-calls', { by: 'gizmo', model: 'm' });
    assert.equal(plain.status, 201, 'slice-1 rows still land'); assert.equal(plain.body.sampling, null);
  } finally { await srv.stop(); }
});
