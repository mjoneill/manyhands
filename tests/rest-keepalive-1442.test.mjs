/**
 * #1442 step 2 — REST must never close an idle keep-alive socket itself.
 *
 * The MCP host talks to REST over pooled keep-alive sockets. When REST closes
 * an idle socket on its own timer, a request the host writes onto that socket
 * in the same moment comes back ECONNRESET (33 of 47 resets in the first 24 h
 * with cause codes were not at a restart). The cure is that the server leaves
 * idle sockets to the client, so these tests hold the socket idle PAST Node's
 * old 5 s default and require the server to still be holding it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startRestServer } from './helpers/harness.mjs';

const IDLE_PAST_OLD_DEFAULT_MS = 6500; // Node's default keepAliveTimeout is 5000

function get(agent, url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent }, (res) => {
      const localPort = req.socket.localPort;
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, localPort }));
    });
    req.on('error', reject);
  });
}

test('#1442: an idle keep-alive socket held past 5 s is still open on the server and is reused', { timeout: 30000 }, async () => {
  const rest = await startRestServer();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const url = `${rest.baseUrl}/api/health`;
    const first = await get(agent, url);
    assert.equal(first.status, 200);

    let serverClosed = false;
    const [sock] = Object.values(agent.freeSockets).flat();
    assert.ok(sock, 'the first response must leave a free keep-alive socket in the pool');
    sock.once('end', () => { serverClosed = true; });

    await new Promise((r) => setTimeout(r, IDLE_PAST_OLD_DEFAULT_MS));
    assert.equal(serverClosed, false, 'REST closed an idle socket on its own timer — the stale-socket race #1442 measured');

    const second = await get(agent, url);
    assert.equal(second.status, 200);
    assert.equal(second.localPort, first.localPort, 'the second request must ride the SAME socket, which only the client may end');
  } finally {
    agent.destroy();
    await rest.stop();
  }
});

test('#1442: REST sends no Keep-Alive timeout hint, so a client never derives a reuse window from a server timer', { timeout: 30000 }, async () => {
  const rest = await startRestServer();
  const agent = new http.Agent({ keepAlive: true });
  try {
    const res = await get(agent, `${rest.baseUrl}/api/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['keep-alive'], undefined, `unexpected hint: ${res.headers['keep-alive']}`);
  } finally {
    agent.destroy();
    await rest.stop();
  }
});
