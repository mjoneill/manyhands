/**
 * #1442 — a failed call to the board's REST API names its CAUSE, and says
 * "start the dev server" only when nothing was listening.
 *
 * Pure: the message builder, one case per class. Served: a real MCP adapter
 * pointed at (a) a port that accepts and then drops every connection, and
 * (b) a port with nothing on it — the two failures the old wrapper reported
 * identically, as "Start the dev server".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { unreachableMessage, causeOf } from '../core/rest-unreachable.mjs';
import { startMcpServer, mcpSession, freePort } from './helpers/harness.mjs';

const fetchFailed = (code, message) => Object.assign(new TypeError('fetch failed'), { cause: code ? Object.assign(new Error(message ?? ''), { code }) : undefined });

test('#1442 pure — a refused connection names ECONNREFUSED and keeps the start-the-server hint', () => {
  const m = unreachableMessage('http://127.0.0.1:9', fetchFailed('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:9'));
  assert.match(m, /ECONNREFUSED/);
  assert.match(m, /start the dev server/i);
});

test('#1442 pure — a reset or closed socket names its code and does NOT tell anyone to start a running server', () => {
  for (const code of ['ECONNRESET', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT']) {
    const m = unreachableMessage('http://127.0.0.1:3141', fetchFailed(code, 'other side closed'));
    assert.match(m, new RegExp(code), `${code} is named`);
    assert.doesNotMatch(m, /start the dev server/i, `${code}: the server may be up — no hint`);
  }
});

test('#1442 pure — no cause is said to be no cause, not guessed', () => {
  const m = unreachableMessage('http://x', new TypeError('fetch failed'));
  assert.match(m, /no cause code/);
  assert.doesNotMatch(m, /start the dev server/i);
  assert.deepEqual(causeOf(null), { code: null, message: null });
});

async function dropEveryConnection() {
  const srv = net.createServer((sock) => sock.destroy());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

async function errorTextOfCardGet(mcpUrl) {
  const s = await mcpSession(mcpUrl);
  const r = await s.callTool('card_get', { id: '1' });
  return JSON.stringify(r);
}

test('#1442 served — an adapter whose REST drops the connection reports the socket cause, without the dev-server hint', async () => {
  const dead = await dropEveryConnection();
  const mcp = await startMcpServer({ restApiBase: dead.url });
  try {
    const text = await errorTextOfCardGet(mcp.mcpUrl);
    assert.match(text, /Cannot reach scrum board REST API/, 'the failure is reported');
    assert.match(text, /ECONNRESET|UND_ERR_SOCKET|EPIPE/, `the cause code is named: ${text.slice(0, 300)}`);
    assert.doesNotMatch(text, /start the dev server/i, 'no false remedy');
  } finally { await mcp.stop?.(); await dead.close(); }
});

test('#1442 served — an adapter whose REST port is closed reports ECONNREFUSED and the hint', async () => {
  const closed = `http://127.0.0.1:${await freePort()}`;
  const mcp = await startMcpServer({ restApiBase: closed });
  try {
    const text = await errorTextOfCardGet(mcp.mcpUrl);
    assert.match(text, /ECONNREFUSED/, `the cause code is named: ${text.slice(0, 300)}`);
    assert.match(text, /start the dev server/i);
  } finally { await mcp.stop?.(); }
});
