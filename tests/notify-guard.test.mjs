/**
 * #218 — the test harness must be structurally leak-proof: a default test
 * server must NOT notify the live MCP, even when the environment configures a
 * notify target (which is exactly how the #203 leak bit during the #215 build —
 * `node --test` inherited the live SCRUM_MCP_NOTIFY_URL).
 *
 * Behavior tests against a local spy notify server (never the live :3001).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startRestServer } from './helpers/harness.mjs';

/** A tiny HTTP server that records every POST it receives. */
function startSpy() {
  return new Promise((resolve) => {
    const hits = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { hits.push(body); res.writeHead(200); res.end('ok'); });
    });
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({
        url: `http://127.0.0.1:${port}/internal/notify`,
        hits,
        stop: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

const post = (baseUrl, body, author) =>
  fetch(`${baseUrl}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body, author }),
  });

test('a DEFAULT harness server does not notify, even when the env configures a target (#218)', async () => {
  const spy = await startSpy();
  const prev = process.env.SCRUM_MCP_NOTIFY_URL;
  process.env.SCRUM_MCP_NOTIFY_URL = spy.url; // simulate the live MCP being in the env (the leak condition)
  try {
    const rest = await startRestServer(); // DEFAULT — must override the env with notify disabled
    try {
      const res = await post(rest.baseUrl, 'must not leak', 'sage');
      assert.equal(res.status, 201);
      await new Promise((r) => setTimeout(r, 300)); // give any errant notify time to fire
      assert.equal(spy.hits.length, 0, 'default server stayed silent despite the env target');
    } finally {
      await rest.stop();
    }
  } finally {
    if (prev === undefined) delete process.env.SCRUM_MCP_NOTIFY_URL;
    else process.env.SCRUM_MCP_NOTIFY_URL = prev;
    await spy.stop();
  }
});

test('the harness still notifies when a target is explicitly passed (opt-in preserved)', async () => {
  const spy = await startSpy();
  const rest = await startRestServer({ mcpNotifyUrl: spy.url });
  try {
    const res = await post(rest.baseUrl, 'opt-in nudge', 'nova');
    assert.equal(res.status, 201);
    for (let i = 0; i < 20 && spy.hits.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(spy.hits.length, 1, 'an explicitly configured notify target receives the nudge');
  } finally {
    await rest.stop();
    await spy.stop();
  }
});
