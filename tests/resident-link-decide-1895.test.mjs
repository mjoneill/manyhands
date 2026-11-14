/**
 * #1895 — a guest seat can answer a "bears on" link it was shown (#1851), under its OWN seat only.
 * `link_decide` joins core/board-tools.mjs, the one surface a guest's tools come from. Why it is here at all: #1852 will put
 * links in front of guests, and a guest handed one had no tool to answer it (#1851 "WHO CAN CONFIRM").
 *
 *   L1  the catalog entry: link, verdict, workingOn and NOTHING else (no seat, no `by`); a small model is told what a link is
 *   L2  strictly per-grant: link_decide is offered only when granted; card_get does not bring it; no tool is implied by another
 *   L3  confirm and dismiss send EXACTLY the request the MCP tool sends, with `by` = the executor's own seat
 *   L4  a smuggled seat / by / onBehalfOf never reaches the wire
 *   L5  a confirm with no workingOn, a bad link id, a bad verdict, a bad workingOn: refused in words BEFORE any request
 *   L6  a server refusal reaches the model as a readable sentence (the real runner, a real board)
 *   L8  the prompt names link_decide only to a resident granted it
 *   L7  granted: offered and callable on the real runner; not granted (even with card_get): absent, and refused by name if asked; the settings list offers it and a PATCH grant round-trips
 * NOT COVERED, BY NAME: a confirm landing in the graph (needs the graph executor; the REST side is #1851's own tests).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { makeExecutor, BOARD_TOOLS, toolsFor } from '../core/board-tools.mjs';
import { buildMessages } from '../core/guest-loop.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const LINK = 'a'.repeat(64);
const names = (ts) => ts.map((t) => t.function.name);

function wired() {
  const posts = []; const other = [];
  const exec = makeExecutor({
    get: async (p) => { other.push(['get', p]); return {}; },
    post: async (p, body) => { posts.push({ p, body }); return { id: LINK, verdict: body.verdict, by: body.by }; },
    put: async (p) => { other.push(['put', p]); return {}; },
    del: async (p) => { other.push(['del', p]); return {}; },
    patch: async (p) => { other.push(['patch', p]); return {}; },
    by: 'pip',
  });
  return { exec, posts, other };
}

test('L1 link_decide is in the catalog: link, verdict, workingOn and nothing that names a seat; its words tell a small model what a link is and what each verdict costs', () => {
  const t = BOARD_TOOLS.find((x) => x.function.name === 'link_decide');
  assert.ok(t, 'link_decide is a board tool');
  const p = t.function.parameters;
  assert.deepEqual(Object.keys(p.properties).sort(), ['link', 'verdict', 'workingOn']);
  assert.deepEqual(p.required, ['link', 'verdict']);
  assert.deepEqual(p.properties.verdict.enum, ['confirmed', 'dismissed']);
  assert.equal(p.properties.workingOn.type, 'integer');
  for (const k of Object.keys(p.properties)) assert.doesNotMatch(k, /seat|by|actor|owner/i, `${k} must not name a seat`);
  const d = t.function.description;
  assert.match(d, /bears on/i, 'says what a link is');
  assert.match(d, /USED/, 'says a confirm is counted as used');
  assert.match(d, /never confirm just because/i, 'warns off a confirm that only looks related');
  assert.match(d, /never be proposed/i, 'says what a dismiss does');
  assert.match(d, /workingOn/, 'names workingOn');
  assert.match(d, /YOUR (OWN )?seat/i, 'says the verdict is recorded under the seat it is');
});

test('L2 strictly per grant: link_decide only when granted; card_get does not bring it; no tool is implied by another', () => {
  assert.deepEqual(names(toolsFor({ toolGrants: ['link_decide'] })), ['link_decide']);
  assert.deepEqual(names(toolsFor({ toolGrants: ['card_get'] })), ['card_get'], 'card_get alone does not bring link_decide');
  assert.deepEqual(names(toolsFor({ toolGrants: ['card_get', 'link_decide'] })), ['card_get', 'link_decide']);
  assert.deepEqual(names(toolsFor({})), []);
  assert.deepEqual(names(toolsFor({ toolGrants: [] })), []);
  for (const t of BOARD_TOOLS) assert.deepEqual(names(toolsFor({ toolGrants: [t.function.name] })), [t.function.name], `${t.function.name} implies nothing else`);
});

test('L3 confirm and dismiss: the exact request, under the executor\'s own seat', async () => {
  const { exec, posts, other } = wired();
  const c = await exec('link_decide', { link: LINK, verdict: 'confirmed', workingOn: 1852 });
  assert.deepEqual(posts[0], { p: `/api/links/${LINK}/decide`, body: { verdict: 'confirmed', workingOn: 1852, by: 'pip' } });
  assert.equal(c.verdict, 'confirmed', 'the server\'s answer is handed back');
  await exec('link_decide', { link: LINK, verdict: 'dismissed' });
  assert.deepEqual(posts[1], { p: `/api/links/${LINK}/decide`, body: { verdict: 'dismissed', by: 'pip' } });
  assert.deepEqual(other, [], 'nothing else was called');
});

test('L4 no way to pass a seat: a smuggled seat, by or onBehalfOf is dropped before the wire', async () => {
  const { exec, posts } = wired();
  await exec('link_decide', { link: LINK, verdict: 'confirmed', workingOn: 7, seat: 'other', by: 'other', onBehalfOf: 'other', actor: 'other' });
  assert.deepEqual(posts[0].body, { verdict: 'confirmed', workingOn: 7, by: 'pip' });
});

test('L5 refused in a sentence BEFORE any request: confirm without workingOn, bad link id, bad verdict, bad workingOn', async () => {
  const { exec, posts } = wired();
  await assert.rejects(() => exec('link_decide', { link: LINK, verdict: 'confirmed' }), /workingOn.*confirm|confirm.*workingOn/i);
  await assert.rejects(() => exec('link_decide', { link: LINK, verdict: 'confirmed', workingOn: null }), /workingOn/);
  await assert.rejects(() => exec('link_decide', { link: LINK, verdict: 'confirmed', workingOn: 'the card' }), /workingOn/);
  await assert.rejects(() => exec('link_decide', { link: LINK, verdict: 'confirmed', workingOn: 1.5 }), /workingOn/);
  await assert.rejects(() => exec('link_decide', { link: 'short', verdict: 'dismissed' }), /link/);
  await assert.rejects(() => exec('link_decide', { link: `../${LINK}`, verdict: 'dismissed' }), /link/);
  await assert.rejects(() => exec('link_decide', { link: LINK, verdict: 'maybe' }), /confirmed.*dismissed/);
  await assert.rejects(() => exec('link_decide', { verdict: 'dismissed' }), /link/);
  assert.deepEqual(posts, [], 'no request was made for any of them');
});

// A fake OpenAI-completions vendor scripted per turn (as resident-declare-1383).
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
const toolMsgs = (calls, who) => calls.filter((b) => new RegExp(`You are ${who}\\.`).test(sysText(b))).flatMap((b) => b.messages || []).filter((m) => m.role === 'tool');

test('L6/L7 REAL RUNNER: a granted seat\'s refusal from the board comes back as a readable sentence; a seat holding card_get but not link_decide asking anyway is refused by name', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  const v = await vendor((n, body) => {
    const sys = sysText(body);
    const seat = /You are (\w+)\./.exec(sys)?.[1] || '?';
    const mine = (body.messages || []).filter((m) => m.role === 'tool').length;
    if (!mine) return { message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'link_decide', arguments: JSON.stringify({ link: LINK, verdict: 'dismissed' }) } }] }, finish: 'tool_calls' };
    return { message: { role: 'assistant', content: `REPLY: ${seat} done` }, finish: 'stop' };
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resident-link-decide-'));
  try {
    const api = async (method, p, body) => { const r = await fetch(`${srv.baseUrl}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const model = { model: 'fake', protocol: 'openai-completions', baseUrl: v.baseUrl };
    const made = await api('POST', '/api/agents', { seatKey: 'pip', prompt: 'You are pip.', model, residency: 'guest', contextPolicy: 'artifact-only', toolGrants: ['card_get'], by: 'ada' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    // L7a: it is grantable by name through the same validator the settings page saves through, and the page's list offers it
    const list = (await api('GET', '/api/tools')).body;
    assert.ok(list.some((t) => t.name === 'link_decide' && /link/i.test(t.description)), 'the settings list offers it');
    const granted = await api('PATCH', '/api/agents/pip', { toolGrants: ['card_get', 'link_decide'], by: 'ada' });
    assert.equal(granted.status, 200, JSON.stringify(granted.body));
    assert.deepEqual(granted.body.toolGrants, ['card_get', 'link_decide']);
    const made2 = await api('POST', '/api/agents', { seatKey: 'quill', prompt: 'You are quill.', model, residency: 'guest', contextPolicy: 'artifact-only', toolGrants: ['card_get'], by: 'ada' });
    assert.equal(made2.status, 201);

    const env = (seat) => ({ SCRUM_BOARD_URL: srv.baseUrl, SCRUM_GUEST_STATE_FILE: path.join(dir, `${seat}.state.json`) });
    assert.equal((await api('POST', '/api/conversations', { author: 'ada', body: '@pip answer that link' })).status, 201);
    const r1 = await runOnce(env('pip'), 'pip');
    assert.equal(r1.code, 0, r1.err + r1.out);
    const first = v.calls.find((b) => /You are pip\./.test(sysText(b)));
    assert.deepEqual((first.tools || []).map((t) => t.function.name), ['card_get', 'link_decide'], 'the seat granted it is offered it');
    // L6: this board runs no graph unit, so the route answers 503 LINKS_UNAVAILABLE with a sentence; the model must SEE it
    const tm = toolMsgs(v.calls, 'pip');
    assert.ok(tm.length, 'the model got a tool result');
    assert.match(String(tm[0].content), /links live in the graph executor/, 'the board\'s own sentence reached the model: ' + tm[0].content);
    assert.match(String(tm[0].content), /503/);

    // L7b: ungranted, the model asks anyway
    assert.equal((await api('POST', '/api/conversations', { author: 'ada', body: '@quill answer that link' })).status, 201);
    const r2 = await runOnce(env('quill'), 'quill');
    assert.equal(r2.code, 0, r2.err + r2.out);
    const qfirst = v.calls.find((b) => /You are quill\./.test(sysText(b)));
    assert.ok(!(qfirst.tools || []).some((t) => t.function.name === 'link_decide'), 'absent from the request of a seat that holds card_get but not link_decide');
    const refusal = toolMsgs(v.calls, 'quill').find((m) => /not granted/.test(String(m.content)));
    assert.ok(refusal, 'refused by name');
    assert.match(String(refusal.content), /"link_decide" is not granted/);
  } finally { await v.stop(); await srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('L8 the prompt names link_decide only when it is granted', () => {
  const WAKE = { kind: 'mention', id: 'w1', author: 'ada', body: 'hi', createdAt: '2026-11-14T00:00:00Z' };
  const sys = (grants) => buildMessages({ agent: { seatKey: 'pip', name: 'pip', residency: 'resident', toolGrants: grants }, wake: WAKE, memories: [] })
    .filter((x) => x.role === 'system').map((x) => x.content).join('\n');
  assert.doesNotMatch(sys(['card_get', 'seat_declare']), /link_decide/, 'card_get does not bring it, so it is not named');
  assert.match(sys(['card_get', 'link_decide']), /link_decide/);
  assert.match(sys(['link_decide']), /never confirm on looks alone/);
});
