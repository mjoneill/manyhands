/**
 * #1470 — a resident may revise HER OWN memories.
 *
 * The resident half of #1438 needs a seat to set PRIORITY on what she keeps
 * (assembly is priority-first, and not one memory on the board had one), and to
 * retag or append to a lesson of hers. #1383's shape, one card over: that tool
 * is self-scoped BY CONSTRUCTION (its path is built from the bound seat). This
 * one can't be, because the memory id arrives in the model's args, so the fence
 * is an explicit owner check before any write: a memory whose owner is not the
 * bound seat is refused and nothing is written.
 *
 * And the prompt stops lying: it told every resident her memory was reached
 * through memory_create / memory_list, and her grants held neither. The
 * disclosure now names what actually works (the REMEMBER line), and offers
 * memory_update, with each memory's id, only to a seat that holds the grant.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeExecutor, BOARD_TOOLS, toolsFor } from '../core/board-tools.mjs';
import { buildMessages } from '../core/guest-loop.mjs';

function fakeBoard(memories) {
  const patches = [];
  return {
    patches,
    exec: makeExecutor({
      get: async (p) => {
        const id = decodeURIComponent(p.split('/').pop());
        const m = memories[id];
        if (!m) throw new Error(`GET ${p} → 404`);
        return m;
      },
      post: async () => ({}),
      patch: async (p, body) => { patches.push({ p, body }); return { ...memories[decodeURIComponent(p.split('/').pop())], ...body }; },
      by: 'pip',
    }),
  };
}
const MEMS = {
  mine: { id: 'mine', owner: 'pip', title: 'a lesson', body: 'x', version: 3 },
  theirs: { id: 'theirs', owner: 'quill', title: 'not yours', body: 'y', version: 1 },
};

test('#1470 memory_update on the seat\'s OWN memory PATCHes it, attributed to the seat', async () => {
  const b = fakeBoard(MEMS);
  const out = await b.exec('memory_update', { id: 'mine', priority: 'p0', tags: ['boot'] });
  assert.equal(b.patches.length, 1);
  assert.equal(b.patches[0].p, '/api/memories/mine');
  assert.equal(b.patches[0].body.priority, 'p0');
  assert.deepEqual(b.patches[0].body.tags, ['boot']);
  assert.equal(b.patches[0].body.by, 'pip', 'the write is attributed to the bound seat');
  assert.equal(out.priority, 'p0');
});

test('#1470 ⛔ memory_update on ANOTHER seat\'s memory is REFUSED and writes nothing', async () => {
  const b = fakeBoard(MEMS);
  await assert.rejects(() => b.exec('memory_update', { id: 'theirs', priority: 'p0' }), /not yours|owner/i);
  assert.equal(b.patches.length, 0, 'nothing reached the wire');
});

test('#1470 a smuggled owner or `by` in the args cannot aim the write elsewhere', async () => {
  const b = fakeBoard(MEMS);
  await assert.rejects(() => b.exec('memory_update', { id: 'theirs', owner: 'pip', by: 'quill', priority: 'p1' }), /not yours|owner/i);
  await b.exec('memory_update', { id: 'mine', owner: 'quill', by: 'quill', priority: 'p2' });
  assert.equal(b.patches[0].body.by, 'pip');
  assert.equal(b.patches[0].body.owner, undefined, 'owner is never sent: it is not an editable field');
});

test('#1470 only the editable fields reach the wire, and an empty edit is refused', async () => {
  const b = fakeBoard(MEMS);
  await b.exec('memory_update', { id: 'mine', bodyAppend: '\nmore', ifVersion: 3, junk: 'no' });
  assert.deepEqual(Object.keys(b.patches[0].body).sort(), ['bodyAppend', 'by', 'ifVersion']);
  await assert.rejects(() => b.exec('memory_update', { id: 'mine' }), /nothing to change/i);
  await assert.rejects(() => b.exec('memory_update', { priority: 'p0' }), /id/i);
});

test('#1470 memory_update is a board tool, grantable, and absent when ungranted', () => {
  assert.ok(BOARD_TOOLS.some((t) => t.function.name === 'memory_update'));
  const d = JSON.stringify(BOARD_TOOLS.find((t) => t.function.name === 'memory_update'));
  assert.doesNotMatch(d, /read first/, 'the tool description promises nothing the wake does not do');
  assert.deepEqual(toolsFor({ toolGrants: ['card_get'] }).map((t) => t.function.name), ['card_get']);
  assert.deepEqual(toolsFor({ toolGrants: ['memory_update'] }).map((t) => t.function.name), ['memory_update']);
});

const sys = (m) => m.filter((x) => x.role === 'system').map((x) => x.content).join('\n');
const all = (m) => m.map((x) => (typeof x.content === 'string' ? x.content : JSON.stringify(x.content))).join('\n');
const WAKE = { kind: 'mention', id: 'w1', author: 'ada', body: 'hi', createdAt: '2026-09-24T00:00:00Z' };
const MEM = [{ id: 'mem-123', body: 'a lesson I kept', updatedAt: '2026-09-23T00:00:00Z' }];

test('#1470 the prompt no longer names memory tools the seat does not hold', () => {
  const m = buildMessages({ agent: { seatKey: 'pip', name: 'pip', residency: 'resident', toolGrants: ['card_get'] }, wake: WAKE, memories: MEM });
  assert.doesNotMatch(sys(m), /memory_create|memory_list|memory_update/, 'no ungranted memory tool is named');
  assert.match(sys(m), /REMEMBER/, 'and it says what actually works');
  assert.doesNotMatch(all(m), /mem-123/, 'ids are not shown to a seat that cannot use them');
});

test('#1470 a seat granted memory_update is told so, and sees each memory\'s id', () => {
  const m = buildMessages({ agent: { seatKey: 'pip', name: 'pip', residency: 'resident', toolGrants: ['memory_update'] }, wake: WAKE, memories: MEM });
  assert.match(sys(m), /memory_update/);
  // Review finding (09-24): the wake shows the newest ten, not priority order,
  // so the prompt must not promise priority decides what she sees. That
  // changes when assembly is wired into the resident wake (#1438).
  assert.doesNotMatch(sys(m), /read first/, 'no promise the wake does not keep');
  assert.match(sys(m), /does not yet order by it/);
  assert.match(all(m), /mem-123/, 'the id she needs to name a memory is in front of her');
});

// ── the seam: the real runner, a real board, a scripted model ─────────────────
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

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

test('#1470 SEAM: a granted resident sets priority on HER memory through the real runner; her attempt on another seat\'s is refused and changes nothing', { timeout: 60000 }, async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  const api = async (method, p, body) => { const r = await fetch(`${srv.baseUrl}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const mine = await api('POST', '/api/memories', { title: 'my lesson', body: 'check before claiming', owner: 'pip', by: 'pip', tags: ['agent-memory', 'pip'] });
  const theirs = await api('POST', '/api/memories', { title: 'quill lesson', body: 'not pip\'s', owner: 'quill', by: 'quill', tags: ['agent-memory', 'quill'] });
  assert.equal(mine.status, 201); assert.equal(theirs.status, 201);
  const v = await vendor((n) => {
    if (n === 1) return { message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'memory_update', arguments: JSON.stringify({ id: mine.body.id, priority: 'p0' }) } }] }, finish: 'tool_calls' };
    if (n === 2) return { message: { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'memory_update', arguments: JSON.stringify({ id: theirs.body.id, priority: 'p0' }) } }] }, finish: 'tool_calls' };
    return { message: { role: 'assistant', content: 'REPLY: done' }, finish: 'stop' };
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resident-mem-'));
  try {
    const model = { model: 'fake', protocol: 'openai-completions', baseUrl: v.baseUrl };
    const made = await api('POST', '/api/agents', { seatKey: 'pip', prompt: 'You are pip.', model, residency: 'resident', contextPolicy: 'artifact-only', toolGrants: ['memory_update'], by: 'ada' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    await api('POST', '/api/conversations', { author: 'ada', body: '@pip rank what matters' });
    const r = await runOnce({ SCRUM_BOARD_URL: srv.baseUrl, SCRUM_GUEST_STATE_FILE: path.join(dir, 'pip.state.json') }, 'pip');
    assert.equal(r.code, 0, r.err + r.out);

    const after = (await api('GET', `/api/memories/${mine.body.id}`)).body;
    assert.equal(after.priority, 'p0', 'her own memory now carries the priority: ' + JSON.stringify(after));
    const other = (await api('GET', `/api/memories/${theirs.body.id}`)).body;
    assert.equal(other.priority, undefined, 'the other seat\'s memory is untouched: ' + JSON.stringify(other));

    const text = (b) => (b.messages || []).map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    assert.match(text(v.calls[0]), new RegExp(mine.body.id), 'her memory\'s id was in front of her');
    const refusal = v.calls.flatMap((b) => b.messages || []).find((m) => m.role === 'tool' && /not yours/.test(String(m.content)));
    assert.ok(refusal, 'the refusal reached the model as the tool result');
  } finally { await v.stop(); await srv.stop(); }
});
