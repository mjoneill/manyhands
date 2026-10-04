/**
 * #1561 K7 (a reviewer's mutation that survived): the guest runner's board key must
 * reach the BOARD and never the MODEL PROVIDER. Today that holds by scoping (the
 * runner's module-local fetch adds the key only for SCRUM_BOARD_URL; the model
 * adapter calls the provider with the global fetch), and nothing pinned it: sending
 * the key to every URL passed the whole suite. This runs the REAL runner through one
 * wake: a recording proxy in front of a real board, and a recording model stand-in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const KEY = 'sk-k7-board-key-not-for-the-model';

async function api(base, method, p, body) {
  const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
function listen(handler) {
  const srv = http.createServer(handler);
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}`, stop: () => new Promise((r) => srv.close(r)) })));
}
/** Model stand-in: records every request's headers and body. */
async function vendor() {
  const calls = [];
  const v = await listen((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      calls.push({ headers: req.headers, body: raw });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'REPLY: here' }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } }));
    });
  });
  return { ...v, calls };
}
/** Board proxy: records each request's Authorization header, forwards everything. */
async function proxy(target) {
  const seen = [];
  const p = await listen((req, res) => {
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization ?? null });
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const r = await fetch(new URL(req.url, target), { method: req.method, headers: { 'content-type': req.headers['content-type'] || 'application/json' }, body });
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
      res.end(Buffer.from(await r.arrayBuffer()));
    });
  });
  return { ...p, seen };
}
function runOnce(env, seat) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [new URL('../scripts/guest-once.mjs', import.meta.url).pathname, '--seat', seat], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

test('#1561 K7: through a real wake, the board key reaches the board and never the model provider', { timeout: 60000 }, async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  const v = await vendor();
  const px = await proxy(srv.baseUrl);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k7-'));
  const keyFile = path.join(dir, 'key'); fs.writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 });
  try {
    const model = { model: 'fake', protocol: 'openai-completions', baseUrl: v.base };
    assert.equal((await api(srv.baseUrl, 'POST', '/api/agents', { seatKey: 'pip', prompt: 'You are pip.', model, residency: 'resident', by: 'ada' })).status, 201);
    await api(srv.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: '@pip hello?' });
    const r = await runOnce({ SCRUM_BOARD_URL: px.base, SCRUM_GUEST_STATE_FILE: path.join(dir, 'pip.state.json'), SCRUM_SEAT_TOKEN_FILE: keyFile }, 'pip');
    assert.equal(r.code, 0, r.err + r.out);
    // the key was in play: the board side received it
    assert.ok(px.seen.length > 0);
    assert.ok(px.seen.every((s) => s.authorization === `Bearer ${KEY}`), 'every board call carried the key');
    // and the model side never did, in any header or in the body
    assert.ok(v.calls.length >= 1, 'the model was called: ' + r.err);
    for (const c of v.calls) {
      for (const [name, value] of Object.entries(c.headers)) assert.ok(!String(value).includes(KEY), `model request header ${name} carried the board key`);
      assert.ok(!c.body.includes(KEY), 'model request body carried the board key');
    }
    assert.ok(!(r.out + r.err).includes(KEY), 'the key is never printed');
  } finally { await px.stop(); await v.stop(); await srv.stop(); }
});
