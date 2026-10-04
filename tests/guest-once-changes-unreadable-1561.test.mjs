/**
 * #1561 SEAM — the REAL runner (scripts/guest-once.mjs) carries an unreadable
 * /api/changes into the wake prompt as "could not be read", never as an empty list.
 * Written after the first version of this change broke the runner silently: a
 * trailing comment on its one-line options object commented out eight arguments,
 * `node --check` passed, and only the full suite's seam tests saw it. The
 * guestOnce-level test could not, because it never runs the script.
 * A proxy in front of a real board 503s /api/changes; the twin passes it through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

async function api(base, method, p, body) {
  const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
function listen(handler) {
  const srv = http.createServer(handler);
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}`, stop: () => new Promise((r) => srv.close(r)) })));
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
/** Forwards everything to the board; /api/changes answers 503 while `failChanges.on`. */
async function proxy(target, failChanges) {
  return listen((req, res) => {
    if (failChanges.on && req.url.startsWith('/api/changes')) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'executor unavailable', code: 'GRAPH_EXECUTOR_UNAVAILABLE' }));
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
const text = (b) => (b.messages || []).map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

test('#1561 SEAM: the real runner says an unreadable change list could not be read; a readable one adds no such line (twin)', { timeout: 60000 }, async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  const v = await vendor();
  const failChanges = { on: true };
  const px = await proxy(srv.baseUrl, failChanges);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gocu-'));
  try {
    const model = { model: 'fake', protocol: 'openai-completions', baseUrl: v.base };
    assert.equal((await api(srv.baseUrl, 'POST', '/api/agents', { seatKey: 'pip', prompt: 'You are pip.', model, residency: 'resident', by: 'ada' })).status, 201);
    const env = { SCRUM_BOARD_URL: px.base, SCRUM_GUEST_STATE_FILE: path.join(dir, 'pip.state.json') };

    await api(srv.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: '@pip what changed?' });
    let r = await runOnce(env, 'pip'); assert.equal(r.code, 0, r.err + r.out);
    assert.ok(v.calls.length >= 1, 'the model was called: ' + r.err);
    const unreadable = text(v.calls[v.calls.length - 1]);
    assert.match(unreadable, /recent changes could not be read/i);
    assert.match(unreadable, /not evidence that nothing changed/i);
    // the arguments AFTER `changes` must still reach guestOnce: the ledger row lands on the board only through ledgerSink
    const rows = (await api(srv.baseUrl, 'GET', '/api/model-calls?agent=pip')).body;
    const list = Array.isArray(rows) ? rows : (rows.calls || rows.rows || []);
    assert.ok(list.length >= 1, 'the wake\'s model-call row reached the board (ledgerSink was passed): ' + JSON.stringify(rows).slice(0, 200));

    failChanges.on = false;
    await api(srv.baseUrl, 'POST', '/api/conversations', { author: 'ada', body: '@pip and now?' });
    r = await runOnce(env, 'pip'); assert.equal(r.code, 0, r.err + r.out);
    assert.doesNotMatch(text(v.calls[v.calls.length - 1]), /could not be read/i, 'twin: readable changes, no such line');
  } finally { await px.stop(); await v.stop(); await srv.stop(); }
});
