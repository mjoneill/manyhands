/**
 * #359 — the tool-response leg of the MCP server.
 *
 * Live failure (2026-07-09): an agent's conversation_post EXECUTED server-side
 * (the post persisted) while her client received an EMPTY tool response, three
 * episodes in three minutes — with zero server-side trace. Code-confirmed
 * mechanisms in the SDK transport:
 *
 *   (a) If the client aborts the POST whose SSE stream would carry the tool
 *       response, the transport's cancel() deletes the stream mapping; the
 *       response write is skipped via optional chaining, and the eventual
 *       "Failed to send response" error is routed to onerror — which nothing
 *       wired. Tool ran, response vanished, log silent.
 *   (b) A request on an unknown/reaped session returned HTTP 400. The MCP
 *       spec's session-recovery contract is 404 ("When a client receives HTTP
 *       404 in response to a request containing an Mcp-Session-Id, it MUST
 *       start a new session"). A 400 gives a compliant client no signal to
 *       re-initialize — it stays wedged on a dead session until a restart.
 *
 * These tests pin the fixed behaviors:
 *   1. unknown session  → 404 (the recovery signal), and it is logged
 *   2. reaped session   → same 404 journey a real rotted client takes
 *   3. client-aborted tool call → tool still executes AND the server says so
 *      LOUDLY in its log (the observability that was missing on the night)
 *   4. log lines carry timestamps (the night's episodes couldn't even be
 *      located in the log — bare console.log has no clock)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startMcpServer, mcpSession, freePort } from './helpers/harness.mjs';

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

/** Poll until fn() is truthy or timeout. */
async function eventually(fn, timeoutMs = 4000, everyMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) return fn();
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/**
 * A stub REST server standing in for server.js: accepts POST
 * /api/conversations, records each hit, and answers 201 after `delayMs` —
 * long enough for a test client to abort the MCP POST mid-tool-call.
 */
function startSlowRestStub(delayMs) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, body: raw });
      setTimeout(() => {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: `stub-${hits.length}`,
          body: 'stub',
          author: 'stub',
          attachedTo: null,
          createdAt: new Date().toISOString(),
        }));
      }, delayMs);
    });
  });
  return new Promise((resolve) => {
    freePort().then((port) => {
      server.listen(port, '127.0.0.1', () =>
        resolve({
          baseUrl: `http://127.0.0.1:${port}`,
          hits,
          stop: () => new Promise((r) => server.close(r)),
        }),
      );
    });
  });
}

// ── 1. Unknown session gets the spec's recovery signal (404), logged ──────

test('a request on an unknown session id returns 404 (the re-initialize signal), and the server logs it', async () => {
  const mcp = await startMcpServer();
  try {
    const res = await fetch(mcp.mcpUrl, {
      method: 'POST',
      headers: { ...MCP_HEADERS, 'mcp-session-id': 'no-such-session' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
    });
    assert.equal(
      res.status, 404,
      'unknown session must 404 — the MCP spec\'s signal for "start a new session"; 400 leaves the client wedged',
    );
    const parsed = await res.json();
    assert.ok(parsed.error, 'body is a JSON-RPC error');

    const logged = await eventually(() =>
      (mcp.stdoutText() + mcp.stderrText()).includes('no-such-session'),
    );
    assert.ok(logged, 'the unknown-session request is visible in the server log (it was invisible on the night)');
  } finally {
    await mcp.stop();
  }
});

// ── 2. The real rot journey: session reaped → next call 404s ──────────────

test('a session reaped for idleness gets 404 on its next call — a compliant client can recover by re-initializing', async () => {
  // Reaper tuned fast so the test lives the real timeline in miniature.
  const mcp = await startMcpServer({
    env: { MCP_REAP_IDLE_MS: '300', MCP_REAP_SWEEP_MS: '100' },
  });
  try {
    const session = await mcpSession(mcp.mcpUrl);

    // The session works while alive.
    const alive = await session.listTools();
    assert.ok(alive.result?.tools?.length > 0, 'live session serves tools/list');

    // Wait for the reaper to eat it (idle 300ms, sweep 100ms; generous margin).
    await eventually(() => mcp.stdoutText().includes('reaped'), 4000);
    assert.ok(mcp.stdoutText().includes('reaped'), 'the reaper fired');

    const res = await fetch(mcp.mcpUrl, {
      method: 'POST',
      headers: { ...MCP_HEADERS, 'mcp-session-id': session.sessionId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/list' }),
    });
    assert.equal(
      res.status, 404,
      'reaped session must 404 so the client knows to re-initialize (this exact journey wedged a live agent for a whole evening)',
    );
  } finally {
    await mcp.stop();
  }
});

// ── 3. The silent-drop scenario, made loud ─────────────────────────────────

test('a tool call whose client aborts mid-flight still executes — and the server logs the dropped response LOUDLY', async () => {
  const stub = await startSlowRestStub(800);
  const mcp = await startMcpServer({ restApiBase: stub.baseUrl });
  try {
    const session = await mcpSession(mcp.mcpUrl);

    // Fire conversation_post, then abort the POST while the tool is still
    // inside the slow REST call — the client walks away from the response.
    // Note: with SSE-on-POST the fetch RESOLVES at headers; the abort severs
    // the body stream, which is exactly where the tool response would arrive.
    const controller = new AbortController();
    const res = await fetch(mcp.mcpUrl, {
      method: 'POST',
      headers: { ...MCP_HEADERS, 'mcp-session-id': session.sessionId },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 42, method: 'tools/call',
        params: { name: 'conversation_post', arguments: { body: 'doomed ack', author: 'robin' } },
      }),
      signal: controller.signal,
    });

    // Let the request reach the server and the tool start (stub hit), then abort.
    await eventually(() => stub.hits.length > 0, 3000);
    assert.equal(stub.hits.length, 1, 'the tool call reached the REST layer before the abort');
    controller.abort();
    let bodyText = '';
    try { bodyText = await res.text(); } catch { bodyText = ''; }
    assert.ok(
      !bodyText.includes('"result"'),
      `no tool result reached the client — the empty-response symptom (got: ${JSON.stringify(bodyText)})`,
    );

    // The tool still completes server-side (the stub answers at 800ms) — that's
    // the "post persisted" half of the live symptom. The fix is the other half:
    // the server must SAY the response went undeliverable, with enough context
    // to correlate (session + tool).
    const log = await eventually(() => {
      const t = mcp.stdoutText() + mcp.stderrText();
      return t.includes('[#359]') ? t : '';
    }, 5000);
    assert.ok(
      log.includes('[#359]'),
      'the dropped response is loudly visible in the server log (on the night, this was a zero-trace event)',
    );
    const dropLine = log.split('\n').find((l) => l.includes('[#359]') && /drop|undeliver|abort/i.test(l));
    assert.ok(dropLine, `a [#359] line names the drop: ${JSON.stringify(log.split('\n').filter((l) => l.includes('[#359]')))}`);
    assert.ok(
      dropLine.includes(session.sessionId),
      'the drop line carries the session id (correlation is the point of observability)',
    );
    assert.ok(
      dropLine.includes('conversation_post'),
      'the drop line names the tool that lost its response',
    );
  } finally {
    await mcp.stop();
    await stub.stop();
  }
});

// ── 4. Log lines carry a clock ─────────────────────────────────────────────

test('server log lines are timestamped (the night\'s episodes could not even be located in the log)', async () => {
  const mcp = await startMcpServer();
  try {
    // Any logged event will do — a session init logs a line.
    await mcpSession(mcp.mcpUrl);
    const line = await eventually(() =>
      mcp.stdoutText().split('\n').find((l) => l.includes('Session initialized')),
    );
    assert.ok(line, 'found a Session initialized log line');
    assert.match(
      line,
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      `log line carries an ISO timestamp: ${JSON.stringify(line)}`,
    );
  } finally {
    await mcp.stop();
  }
});
