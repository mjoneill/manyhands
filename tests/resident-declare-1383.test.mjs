/**
 * #1383 — a resident may declare its OWN seat state. `seat_declare` and
 * `seat_clear` become board tools a runner can execute for the seat it binds;
 * there is no `seat` parameter, so #613's self-only rule holds by construction.
 * Why: #1376's live verification is a resident holding a role and seeing the
 * role section in its own prompt, and the resident could not declare (five
 * reads + card_claim were the whole grantable surface).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { makeExecutor, BOARD_TOOLS, toolsFor } from '../core/board-tools.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

test('#1383 executor: seat_declare PUTs and seat_clear DELETEs the RUNNER\'S OWN seat — no argument can aim it at another', async () => {
  const puts = []; const dels = [];
  const exec = makeExecutor({
    get: async () => ({}), post: async () => ({}),
    put: async (p, body) => { puts.push({ p, body }); return { seat: 'pip', mode: body.mode, role: body.role ?? null }; },
    del: async (p) => { dels.push(p); return { cleared: true }; },
    by: 'pip',
  });
  const out = await exec('seat_declare', { mode: 'available', acceptsRoutineWork: true, expiresAt: '2026-09-15T00:00:00.000Z', role: 'scrum-master', seat: 'someone-else' });
  assert.equal(puts[0].p, '/api/seats/pip/state', 'the path is the runner\'s seat');
  assert.equal(puts[0].body.seat, undefined, 'a smuggled `seat` never reaches the wire');
  assert.equal(puts[0].body.role, 'scrum-master');
  assert.equal(out.seat, 'pip');
  await exec('seat_clear', {});
  assert.deepEqual(dels, ['/api/seats/pip/state']);
  assert.ok(BOARD_TOOLS.some((t) => t.function.name === 'seat_declare') && BOARD_TOOLS.some((t) => t.function.name === 'seat_clear'), 'both are board tools (and so grantable)');
  assert.deepEqual(toolsFor({ toolGrants: ['card_get'] }).map((t) => t.function.name), ['card_get'], 'ungranted ⇒ absent from the request');
  assert.equal((await Promise.resolve(makeExecutor({ get: async () => ({}), post: async () => ({}), by: 'pip' })('seat_declare', { mode: 'resting', acceptsRoutineWork: false, expiresAt: 'x' }).catch((e) => e.message))).includes('put'), true, 'an executor built without put refuses by name rather than posting somewhere');
});

// A fake OpenAI-completions vendor scripted per turn.
function vendor(script) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw); calls.push(body);
      const step = script(calls.length, body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: step.message, finish_reason: step.finish }], usage: { prompt_tokens: 50, completion_tokens: 10 } }));
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
const sysText = (body) => (body.messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n');

test('#1383 SEAM: a granted resident declares scrum-master from its own wake; the row appears; the NEXT wake\'s prompt carries the section. Ungranted: refused by name, no row.', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [{ id: 'c1', shortId: 1, title: 'the SM definition', description: 'what the scrum master holds', type: 'task', column: 'backlog', order: 1, assignees: ['unassigned'], labels: [], priority: null, createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z', version: 1 }], nextShortId: 2 }) });
  const expires = new Date(Date.now() + 3600_000).toISOString();
  const firstSeen = new Set();
  const v = await vendor((n, body) => {
    const sys = sysText(body);
    const seat = /You are (\w+)\./.exec(sys)?.[1] || '?';
    // each seat's FIRST model call asks to declare; every later call answers,
    // and the answer says whether the role section was in the prompt it saw
    if (!firstSeen.has(seat)) {
      firstSeen.add(seat);
      return { message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'seat_declare', arguments: JSON.stringify({ mode: 'available', acceptsRoutineWork: true, expiresAt: expires, role: 'scrum-master' }) } }] }, finish: 'tool_calls' };
    }
    return { message: { role: 'assistant', content: `REPLY: ${/currently serving as Scrum Master/.test(sys) ? 'I hold the SM role now.' : 'no role in my prompt.'}` }, finish: 'stop' };
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resident-declare-'));
  const stateFile = path.join(dir, 'pip.state.json');
  try {
    const api = async (method, p, body) => { const r = await fetch(`${srv.baseUrl}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const role = await api('POST', '/api/roles', { key: 'scrum-master', name: 'Scrum Master', definition: 'Holds the sequence honest, names gates, and does not build — the full text is on the defining card.', definedBy: 1, by: 'ada' });
    assert.equal(role.status, 201, JSON.stringify(role.body));
    const model = { model: 'fake', protocol: 'openai-completions', baseUrl: v.baseUrl };
    const made = await api('POST', '/api/agents', { seatKey: 'pip', prompt: 'You are pip.', model, residency: 'guest', contextPolicy: 'artifact-only', toolGrants: ['seat_declare', 'seat_clear'], by: 'ada' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const env = { SCRUM_BOARD_URL: srv.baseUrl, SCRUM_GUEST_STATE_FILE: stateFile };

    // wake 1: a mention; the model declares, then answers
    const m1 = await api('POST', '/api/conversations', { author: 'ada', body: '@pip please take the SM role for the week' });
    assert.equal(m1.status, 201);
    const r1 = await runOnce(env, 'pip');
    assert.equal(r1.code, 0, r1.err + r1.out);
    const state = await api('GET', '/api/seats/state');
    const row = (state.body.seats || []).find((s) => s.seat === 'pip');
    assert.ok(row, 'pip has a row');
    assert.equal(row.role, 'scrum-master', 'the declaration carried the role: ' + JSON.stringify(row));
    assert.equal(row.mode, 'available');
    assert.doesNotMatch(sysText(v.calls[0]), /currently serving as/, 'wake 1\'s prompt had no role section yet');

    // wake 2: the section is in the prompt the model sees
    const m2 = await api('POST', '/api/conversations', { author: 'ada', body: '@pip and what role do you hold now?' });
    assert.equal(m2.status, 201);
    const r2 = await runOnce(env, 'pip');
    assert.equal(r2.code, 0, r2.err + r2.out);
    const last = v.calls[v.calls.length - 1];
    assert.match(sysText(last), /currently serving as Scrum Master \(role key: scrum-master\)/, 'the NEXT wake carries the section (#1376)');
    assert.match(sysText(last), /card #1/, 'and names the defining card');
    assert.match(r2.out, /\[#1376\] role: scrum-master/);
    const posts = await api('GET', '/api/conversations?attachedTo=null&limit=50');
    const mine = (Array.isArray(posts.body) ? posts.body : posts.body.conversations).filter((m) => m.author === 'pip');
    assert.ok(mine.some((m) => /I hold the SM role now/.test(m.body)), 'the model read it back: ' + JSON.stringify(mine.map((m) => m.body)));

    // negative control: a seat WITHOUT the grant asking for seat_declare is refused by name and writes no row
    const made2 = await api('POST', '/api/agents', { seatKey: 'quill', prompt: 'You are quill.', model, residency: 'guest', contextPolicy: 'artifact-only', toolGrants: ['card_get'], by: 'ada' });
    assert.equal(made2.status, 201);
    const m3 = await api('POST', '/api/conversations', { author: 'ada', body: '@quill declare yourself SM' });
    assert.equal(m3.status, 201);
    const r3 = await runOnce(env, 'quill');
    assert.equal(r3.code, 0, r3.err + r3.out);
    const state2 = await api('GET', '/api/seats/state');
    const qrow = (state2.body.seats || []).find((s) => s.seat === 'quill');
    assert.ok(!qrow || !qrow.role, 'no role row for the ungranted seat');
    // the refusal is handed back to the model as the tool result, by name (tool-loop.mjs)
    const quillCalls = v.calls.filter((b) => /You are quill\./.test(sysText(b)));
    const refusal = quillCalls.flatMap((b) => b.messages || []).find((m) => m.role === 'tool' && /not granted/.test(String(m.content)));
    assert.ok(refusal, 'the refusal reached the model: ' + JSON.stringify(quillCalls.map((b) => (b.messages || []).map((m) => m.role))));
    assert.match(String(refusal.content), /"seat_declare" is not granted/);
  } finally { await v.stop(); await srv.stop(); }
});
