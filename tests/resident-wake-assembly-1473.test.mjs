/**
 * #1473 — the resident WAKES FROM THE ASSEMBLY.
 *
 * Until now the runner handed a resident her newest ten `agent-memory` memories,
 * whatever their priority, so a p0 lesson older than the latest ten was never
 * shown. With a declared `memoryBudgetBytes` on her agent node, the runner asks
 * `memory_assemble` instead: her `agent-memory` memories only (the consumer's
 * call: the tag is her "this belongs in my wake" marker), priority first,
 * inside the budget, and every memory left out is NAMED. The wake's model-call
 * row records what she was handed (budget, bytes, included and omitted ids),
 * so "what did she wake with" can be answered after the fact.
 *
 * Unset budget ⇒ the old newest-ten behaviour, unchanged. Nothing moves until
 * the agent node opts in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { assembleMemories } from '../core/memory-assemble.mjs';
import { buildMessages } from '../core/guest-loop.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

// ── the tag filter on the pure assembly ────────────────────────────────────────
test('#1473 assembleMemories({tag}) keeps only memories carrying that tag', () => {
  const mems = [
    { id: 'a', owner: 'pip', tags: ['agent-memory'], title: 'wake', body: 'kept', priority: 'p1', updatedAt: '2026-09-01' },
    { id: 'b', owner: 'pip', tags: ['receipt'], title: 'note', body: 'not for waking', priority: 'p0', updatedAt: '2026-09-02' },
  ];
  const a = assembleMemories(mems, { owner: 'pip', budgetBytes: 4096, tag: 'agent-memory' });
  assert.deepEqual(a.included, ['a']);
  assert.deepEqual(a.omitted, [], 'a filtered-out memory is not "omitted": it was never in the set');
  const all = assembleMemories(mems, { owner: 'pip', budgetBytes: 4096 });
  assert.deepEqual(all.included, ['b', 'a'], 'no tag ⇒ unchanged behaviour');
});

// ── the prompt, given an assembly ──────────────────────────────────────────────
const WAKE = { kind: 'mention', id: 'w1', author: 'ada', body: 'hi', createdAt: '2026-09-24T00:00:00Z' };
const sys = (m) => m.filter((x) => x.role === 'system').map((x) => x.content).join('\n');
const all = (m) => m.map((x) => (typeof x.content === 'string' ? x.content : JSON.stringify(x.content))).join('\n');

test('#1473 an ASSEMBLED memory block is framed as her own unverified words, shows the assembly, and the prompt stops saying the wake ignores priority', () => {
  const assembly = { assembled: true, budgetBytes: 2048, bytes: 60, text: '## old lesson  (m-old · p0 · 2026-08-01)\nthe p0 lesson\n\n', included: ['m-old'], omitted: [] };
  const m = buildMessages({ agent: { seatKey: 'pip', name: 'pip', residency: 'resident', toolGrants: ['memory_update'], memoryBudgetBytes: 2048 }, wake: WAKE, memories: assembly });
  assert.match(all(m), /the p0 lesson/, 'the assembled text is in front of her');
  assert.match(all(m), /NOT facts about the board/, '#1240 framing kept');
  assert.doesNotMatch(sys(m), /does not yet order by it/, 'the #1470 caveat flips when the wake does order by priority');
  assert.match(sys(m), /priority first/i, 'and the prompt says what is now true');
});

test('#1473 with NO budget declared the legacy list and the caveat are unchanged', () => {
  const m = buildMessages({ agent: { seatKey: 'pip', name: 'pip', residency: 'resident', toolGrants: ['memory_update'] }, wake: WAKE, memories: [{ id: 'x', body: 'a lesson', updatedAt: '2026-09-23' }] });
  assert.match(sys(m), /does not yet order by it/);
  assert.match(all(m), /you wrote: "a lesson"/);
});

// ── the agent node carries the budget, readable by the room ────────────────────
async function api(base, method, p, body) {
  const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

test('#1473 memoryBudgetBytes is set by PATCH, read back on the agent, visible in the graph, and a bad value is refused', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const model = { model: 'fake', protocol: 'openai-completions', baseUrl: 'http://127.0.0.1:1' };
    assert.equal((await api(srv.baseUrl, 'POST', '/api/agents', { seatKey: 'pip', prompt: 'You are pip.', model, residency: 'resident', by: 'ada' })).status, 201);
    assert.equal((await api(srv.baseUrl, 'PATCH', '/api/agents/pip', { memoryBudgetBytes: 'lots', by: 'ada' })).status, 400);
    assert.equal((await api(srv.baseUrl, 'PATCH', '/api/agents/pip', { memoryBudgetBytes: 0, by: 'ada' })).status, 400);
    const ok = await api(srv.baseUrl, 'PATCH', '/api/agents/pip', { memoryBudgetBytes: 3000, by: 'ada' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const agents = (await api(srv.baseUrl, 'GET', '/api/agents')).body;
    assert.equal(agents.find((a) => a.seatKey === 'pip').memoryBudgetBytes, 3000);
    const g = await api(srv.baseUrl, 'POST', '/api/graph', { query: 'SELECT ?b WHERE { ?a scrum:seatKey "pip" ; scrum:memoryBudgetBytes ?b }' });
    assert.equal(g.status, 200, JSON.stringify(g.body));
    assert.equal(Number(g.body.rows[0].b), 3000, 'the room can ask the graph what budget a seat was given');
  } finally { await srv.stop(); }
});

// ── the seam: the real runner, a real board ────────────────────────────────────
function vendor() {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      calls.push(JSON.parse(raw));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'REPLY: here' }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } }));
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

test('#1473 SEAM: with a budget declared, a p0 memory OLDER than the newest ten is in her wake, and the row records the assembly', { timeout: 60000 }, async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  const v = await vendor();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-assembly-'));
  try {
    const mk = (title, body, extra = {}) => api(srv.baseUrl, 'POST', '/api/memories', { title, body, owner: 'pip', by: 'pip', tags: ['agent-memory', 'pip'], ...extra });
    const old = await mk('the oldest lesson', 'THE-P0-LESSON', { priority: 'p0' });
    assert.equal(old.status, 201);
    for (let i = 0; i < 12; i++) assert.equal((await mk(`later ${i}`, `later lesson ${i}`)).status, 201);
    const model = { model: 'fake', protocol: 'openai-completions', baseUrl: v.baseUrl };
    assert.equal((await api(srv.baseUrl, 'POST', '/api/agents', { seatKey: 'pip', prompt: 'You are pip.', model, residency: 'resident', contextPolicy: 'artifact-only', by: 'ada' })).status, 201);
    const env = { SCRUM_BOARD_URL: srv.baseUrl, SCRUM_GUEST_STATE_FILE: path.join(dir, 'pip.state.json') };

    // control: no budget ⇒ newest ten ⇒ the old p0 is NOT shown
    await api(srv.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: '@pip one' });
    let r = await runOnce(env, 'pip'); assert.equal(r.code, 0, r.err + r.out);
    const text = (b) => (b.messages || []).map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    assert.doesNotMatch(text(v.calls[v.calls.length - 1]), /THE-P0-LESSON/, 'control: the legacy newest-ten slice drops the old p0');

    // declare a budget ⇒ the assembly ⇒ the old p0 leads
    assert.equal((await api(srv.baseUrl, 'PATCH', '/api/agents/pip', { memoryBudgetBytes: 500, by: 'ada' })).status, 200);
    await api(srv.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: '@pip two' });
    r = await runOnce(env, 'pip'); assert.equal(r.code, 0, r.err + r.out);
    const last = text(v.calls[v.calls.length - 1]);
    assert.match(last, /THE-P0-LESSON/, 'the p0 memory older than the newest ten is now in her wake');
    assert.match(last, /not included/i, 'and what did not fit is named');

    const rows = (await api(srv.baseUrl, 'GET', '/api/model-calls?agent=pip')).body;
    const list = Array.isArray(rows) ? rows : (rows.calls || rows.rows || []);
    const newest = list.map((x) => x.memory).filter(Boolean).find((m) => m.assembly);
    assert.ok(newest, 'a row carries memory.assembly: ' + JSON.stringify(list.map((x) => x.memory)));
    assert.equal(newest.assembly.budgetBytes, 500);
    assert.ok(newest.assembly.bytes <= 500);
    assert.ok(newest.assembly.included.includes(old.body.id), 'the row names the p0 memory as included');
    assert.ok(Array.isArray(newest.assembly.omitted) && newest.assembly.omitted.length > 0, 'and names what was left out');
  } finally { await v.stop(); await srv.stop(); }
});
