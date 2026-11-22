/**
 * #2029 slice 1 (i) — THE REAL RUNNER HANDS A GUEST THE REACTIONS IT WAS GIVEN.
 *
 * The unit rows (guest-reactions-2029) prove the parts. This proves the seam: a real board with reactions on (a real
 * executor), the real scripts/guest-once.mjs, and a fake model that records exactly what it was handed.
 *
 *   E1 a 👍 on the guest's own post is in its next wake, marked as its own; the wake after that does NOT repeat it
 *      (the checkpoint moved past what was handed).
 *   E2 with the reactions read failing, the wake SAYS so, and the reaction is still handed on the next wake that can read
 *      (the checkpoint did not move past a window nobody saw).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const ROSTER_FILE = path.join(os.tmpdir(), `g2029-roster-${process.pid}.json`);
fs.writeFileSync(ROSTER_FILE, JSON.stringify({ seats: { ada: { name: 'Ada', glyph: 'a', color: '#7cc4a0' }, pip: { name: 'Pip', glyph: 'p', color: '#c4a07c' }, board: { name: 'Board', glyph: 'o', color: '#8899aa', kind: 'system' } } }));
after(() => { try { fs.unlinkSync(ROSTER_FILE); } catch { /* gone */ } });

async function api(base, method, p, body) {
  const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(40000) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
function listen(handler) {
  const srv = http.createServer(handler);
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}`, stop: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) })));
}
async function vendor() {
  const calls = [];
  const v = await listen((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      calls.push(JSON.parse(raw));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'REPLY: here' }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } }));
    });
  });
  return { ...v, calls };
}
// The guest's board, with the reactions read switchable to a failure (the rest passes through).
async function proxy(target, failReactions) {
  return listen((req, res) => {
    if (failReactions.on && req.url.startsWith('/api/reactions/recent')) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'the graph could not be read', code: 'GRAPH_UNAVAILABLE' }));
    }
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const r = await fetch(new URL(req.url, target), { method: req.method, headers: { 'content-type': req.headers['content-type'] || 'application/json' }, body });
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
      res.end(Buffer.from(await r.arrayBuffer()));
    });
  });
}
function runOnce(env, seat) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [new URL('../scripts/guest-once.mjs', import.meta.url).pathname, '--seat', seat], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}
const handed = (call) => (call.messages || []).map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

async function withBoard(body) {
  const dsid = `g2029-${process.pid}`;
  const store = tmpStore('g2029-store-');
  // Every resource is released in finally, including when a later one fails to start: a leaked executor keeps the
  // test process alive past its timeout (measured: a server that could not start left this file hanging 30 minutes).
  let exec = null, srv = null, v = null, px = null, dir = null;
  const failReactions = { on: false };
  try {
    exec = await startExecutor({ store, datasetId: dsid, create: true });
    srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }), env: { SCRUM_ROSTER_FILE: ROSTER_FILE, SCRUM_GRAPH_DATASET_ID: dsid, SCRUM_GRAPH_EXECUTOR_URL: exec.baseUrl, SCRUM_GRAPH_UNIT_CONVERSATIONS: '1', SCRUM_GRAPH_UNIT_SMALLKINDS: '1' } });
    v = await vendor();
    px = await proxy(srv.baseUrl, failReactions);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g2029-'));
    const model = { model: 'fake', protocol: 'openai-completions', baseUrl: v.base };
    assert.equal((await api(srv.baseUrl, 'POST', '/api/agents', { seatKey: 'pip', prompt: 'You are pip.', model, residency: 'guest', by: 'ada' })).status, 201);
    const env = { SCRUM_BOARD_URL: px.base, SCRUM_GUEST_STATE_FILE: path.join(dir, 'pip.state.json') };
    return await body({ base: srv.baseUrl, v, env, failReactions });
  } finally {
    if (px) await px.stop(); if (v) await v.stop(); if (srv) await srv.stop(); if (exec) await killExecutor(exec);
    fs.rmSync(store, { recursive: true, force: true }); if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('E1 a reaction on the guest\'s own post rides into its next wake, marked as its own, and is not repeated after', { skip: SKIP, timeout: 180000 }, () => withBoard(async ({ base, v, env }) => {
  const mine = await api(base, 'POST', '/api/conversations', { author: 'pip', body: 'pip shares a thought worth a nod' });
  assert.equal(mine.status, 201);
  assert.equal((await api(base, 'POST', `/api/conversations/${mine.body.id}/reactions`, { by: 'ada', emoji: '👍' })).status, 200);

  await api(base, 'POST', '/api/conversations', { author: 'ada', body: '@pip are you there?' });
  let r = await runOnce(env, 'pip'); assert.equal(r.code, 0, r.err + r.out);
  assert.ok(v.calls.length >= 1, 'the model was called: ' + r.err);
  const first = handed(v.calls[v.calls.length - 1]);
  assert.match(first, /ada 👍 on YOUR post: "pip shares a thought worth a nod"/, 'the reaction is handed, as the seat\'s own');
  assert.match(first, /does not ask you to reply/);

  const n = v.calls.length;
  await api(base, 'POST', '/api/conversations', { author: 'ada', body: '@pip and again?' });
  r = await runOnce(env, 'pip'); assert.equal(r.code, 0, r.err + r.out);
  assert.ok(v.calls.length > n, 'the second wake called the model');
  assert.doesNotMatch(handed(v.calls[v.calls.length - 1]), /ada 👍 on YOUR post/, 'already handed: the checkpoint moved');
}));

test('E2 a failed reactions read is SAID, and the reaction still arrives on the next wake that can read', { skip: SKIP, timeout: 180000 }, () => withBoard(async ({ base, v, env, failReactions }) => {
  const mine = await api(base, 'POST', '/api/conversations', { author: 'pip', body: 'pip posts something' });
  assert.equal((await api(base, 'POST', `/api/conversations/${mine.body.id}/reactions`, { by: 'ada', emoji: '🐊' })).status, 200);

  failReactions.on = true;
  await api(base, 'POST', '/api/conversations', { author: 'ada', body: '@pip hello?' });
  let r = await runOnce(env, 'pip'); assert.equal(r.code, 0, r.err + r.out);
  const failed = handed(v.calls[v.calls.length - 1]);
  assert.match(failed, /reactions could not be read this wake/i);
  assert.doesNotMatch(failed, /🐊/);

  failReactions.on = false;
  await api(base, 'POST', '/api/conversations', { author: 'ada', body: '@pip and now?' });
  r = await runOnce(env, 'pip'); assert.equal(r.code, 0, r.err + r.out);
  assert.match(handed(v.calls[v.calls.length - 1]), /ada 🐊 on YOUR post: "pip posts something"/, 'nothing was skipped');
}));
