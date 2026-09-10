/**
 * #1338 — the Host guard AT THE SEAM: a hostile Host header sent at the real
 * REST server and the real MCP server, over a real socket.
 *
 * `fetch` will not let a caller set Host, which is exactly why a browser is
 * the attacker's tool and `http.request` is ours: it sends whatever we put in
 * `headers.host`, so this is the byte-for-byte shape of a rebinding request.
 *
 * Reproduced live 2026-09-10 before the guard existed:
 *   Host: attacker.example → 200, 891 bytes, real commons content.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { startRestServer, startMcpServer, makeBoardFixture } from './helpers/harness.mjs';

// Write bytes to the socket and return everything the server sends back.
function rawSocket(baseUrl, bytes) {
  const u = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    let out = '';
    const sock = net.connect({ host: u.hostname, port: Number(u.port) }, () => sock.write(bytes));
    sock.setEncoding('utf8');
    sock.on('data', (c) => { out += c; });
    sock.on('end', () => resolve(out));
    sock.on('error', reject);
    setTimeout(() => { sock.destroy(); resolve(out); }, 3000).unref();
  });
}

function raw(baseUrl, { method = 'GET', path = '/', host, body, headers = {} } = {}) {
  const u = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: u.hostname, port: u.port, method, path,
        headers: { ...(host === undefined ? {} : { host }), ...headers } },
      (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const card = { id: 'c1', shortId: 1, title: 'SECRET TITLE the attacker must not read', description: '', type: 'task',
  labels: [], assignees: [], column: 'backlog', order: 1, createdAt: '2026-08-01T00:00:00.000Z',
  relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [], supersededBy: [] } };

test('#1338 REST — a hostile Host is refused with 421 and NO board content, for a read AND a write', async () => {
  const s = await startRestServer({ board: makeBoardFixture({ cards: [card], nextShortId: 2 }) });
  try {
    const port = new URL(s.baseUrl).port;

    // READ under the attacker's origin.
    const read = await raw(s.baseUrl, { path: '/api/cards', host: `attacker.example:${port}` });
    assert.equal(read.status, 421, `expected 421, got ${read.status}: ${read.text.slice(0, 120)}`);
    assert.ok(!read.text.includes('SECRET TITLE'), 'the refusal must not carry board content');

    // WRITE under the attacker's origin — the mutation is the point of the attack.
    const write = await raw(s.baseUrl, {
      method: 'POST', path: '/api/conversations', host: `attacker.example:${port}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: 'bex', body: 'planted by attacker' }),
    });
    assert.equal(write.status, 421, `write must be refused too — got ${write.status}`);
    const after = await (await fetch(`${s.baseUrl}/api/conversations?limit=5`)).json();
    const list = Array.isArray(after) ? after : (after.conversations || []);
    assert.ok(!list.some((m) => (m.body || '').includes('planted by attacker')), 'nothing was written');

    // The refusal is decided BEFORE routing: a static page and an unknown path refuse identically.
    const page = await raw(s.baseUrl, { path: '/', host: `attacker.example:${port}` });
    assert.equal(page.status, 421);
    assert.ok(!page.text.includes('__SCRUM_ROSTER__'), 'the board page must not render under a hostile Host');
    const nowhere = await raw(s.baseUrl, { path: '/no/such/route', host: `attacker.example:${port}` });
    assert.equal(nowhere.status, 421, 'not 404 — the guard runs first');

    // ABSENT Host is refused, not defaulted to local. Node's http client fills
    // in a Host if we hand it an empty one, so this has to go over a raw
    // socket as HTTP/1.0 — the one dialect where omitting Host is legal.
    const noHost = await rawSocket(s.baseUrl, 'GET /api/cards HTTP/1.0\r\n\r\n');
    assert.match(noHost, /^HTTP\/1\.[01] 421 /, `absent Host must be refused — got ${noHost.split('\r\n')[0]}`);
    assert.ok(!noHost.includes('SECRET TITLE'));
  } finally { await s.stop(); }
});

test('#1338 REST NEGATIVE CONTROL — every name a real client sends is still served', async () => {
  const s = await startRestServer({ board: makeBoardFixture({ cards: [card], nextShortId: 2 }) });
  try {
    const port = new URL(s.baseUrl).port;
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `LOCALHOST:${port}`]) {
      const r = await raw(s.baseUrl, { path: '/api/cards', host });
      assert.equal(r.status, 200, `${host} must be served — got ${r.status}`);
      assert.ok(r.text.includes('SECRET TITLE'), `${host} must see the board`);
    }
    // And the harness's own fetch (Host: 127.0.0.1:PORT) — the shape every
    // test, the deploy probes, the fanout watch and the hooks use.
    const r = await fetch(`${s.baseUrl}/api/board/status`);
    assert.equal(r.status, 200);
  } finally { await s.stop(); }
});

test('#1338 REST — SCRUM_ALLOWED_HOSTS admits an extra local name, and only that name', async () => {
  const s = await startRestServer({
    board: makeBoardFixture({ cards: [card], nextShortId: 2 }),
    env: { SCRUM_ALLOWED_HOSTS: 'host.docker.internal' },
  });
  try {
    const port = new URL(s.baseUrl).port;
    const ok = await raw(s.baseUrl, { path: '/api/cards', host: `host.docker.internal:${port}` });
    assert.equal(ok.status, 200, `allowlisted name must be served — got ${ok.status}`);
    const near = await raw(s.baseUrl, { path: '/api/cards', host: `host.docker.internal.attacker.example:${port}` });
    assert.equal(near.status, 421, 'a suffix of the allowlisted name is not the name');
    const still = await raw(s.baseUrl, { path: '/api/cards', host: `attacker.example:${port}` });
    assert.equal(still.status, 421, 'the allowlist adds; it does not open');
  } finally { await s.stop(); }
});

test('#1338 MCP — the same guard, on the same terms: hostile refused (even /health), loopback served', async () => {
  const m = await startMcpServer();
  try {
    const port = new URL(m.baseUrl).port;
    const bad = await raw(m.baseUrl, { path: '/health', host: `attacker.example:${port}` });
    assert.equal(bad.status, 421, `MCP must refuse a hostile Host — got ${bad.status}`);
    assert.ok(!bad.text.includes('"sessions"'), 'the refusal must not carry the health payload');

    const badPost = await raw(m.baseUrl, {
      method: 'POST', path: '/mcp', host: `attacker.example:${port}`,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } } }),
    });
    assert.equal(badPost.status, 421, `MCP initialize under a hostile Host must be refused — got ${badPost.status}`);

    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      const ok = await raw(m.baseUrl, { path: '/health', host });
      assert.equal(ok.status, 200, `${host} must be served — got ${ok.status}`);
      assert.ok(ok.text.includes('"ok":true'));
    }
  } finally { await m.stop(); }
});
