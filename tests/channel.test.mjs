/**
 * Server-side tests for the #119 channel notifier (the autonomous room).
 *
 * Mechanism: when a commons post lands, server.js fires a best-effort notify
 * to the MCP server, which emits a `notifications/claude/channel` JSON-RPC
 * notification to every live MCP session. A `claude --channels server:manyhands`
 * session receives it as a <channel> block. These tests verify the
 * HTTP-transport path: REST post -> MCP -> notification on the session's
 * standalone SSE stream.
 *
 * NOTE: this verifies our server *emits* a well-formed channel notification
 * over HTTP transport. Whether Claude Code's `--channels` consumes it over
 * HTTP (vs the stdio-plugin transport the fakechat smoke test used) is a
 * separate end-to-end check — slice 3.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startRestServer,
  startMcpServer,
  startPair,
  mcpSession,
  openChannelStream,
  parseMcpResponse,
} from './helpers/harness.mjs';

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

function postConversation(baseUrl, body, author) {
  return fetch(`${baseUrl}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body, author }),
  });
}

// ── Capability advertisement ─────────────────────────────────────────────

test('initialize advertises the claude/channel experimental capability', async () => {
  const mcp = await startMcpServer();
  try {
    const res = await fetch(mcp.mcpUrl, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'channel-test', version: '1.0.0' },
        },
      }),
    });
    const parsed = parseMcpResponse(await res.text());
    const exp = parsed.result?.capabilities?.experimental;
    assert.ok(exp && exp['claude/channel'], 'claude/channel capability is advertised');
  } finally {
    await mcp.stop();
  }
});

// ── A commons post delivers a channel notification ───────────────────────

test('a new commons post delivers a claude/channel notification to a live session', async () => {
  const pair = await startPair();
  try {
    const session = await mcpSession(pair.mcp.mcpUrl);
    const stream = await openChannelStream(pair.mcp.mcpUrl, session.sessionId);
    try {
      const res = await postConversation(pair.rest.baseUrl, 'hello from the room', 'nova');
      assert.equal(res.status, 201, 'the conversation was created');
      const created = await res.json();

      const notif = await stream.next('notifications/claude/channel');
      assert.equal(notif.method, 'notifications/claude/channel');
      assert.ok(
        notif.params.content.includes('hello from the room'),
        'notification content carries the post body',
      );
      assert.equal(notif.params.meta.user, 'nova', 'meta.user is the post author');
      assert.equal(
        notif.params.meta.message_id, created.id,
        'meta.message_id is the conversation id (the idempotency key)',
      );
    } finally {
      stream.close();
    }
  } finally {
    await pair.stop();
  }
});

// ── Fan-out: every live session gets the nudge ────────────────────────────

test('a commons post fans out to every connected session', async () => {
  const pair = await startPair();
  try {
    const sessionA = await mcpSession(pair.mcp.mcpUrl);
    const sessionB = await mcpSession(pair.mcp.mcpUrl);
    const streamA = await openChannelStream(pair.mcp.mcpUrl, sessionA.sessionId);
    const streamB = await openChannelStream(pair.mcp.mcpUrl, sessionB.sessionId);
    try {
      await postConversation(pair.rest.baseUrl, 'broadcast test', 'sage');
      const [a, b] = await Promise.all([
        streamA.next('notifications/claude/channel'),
        streamB.next('notifications/claude/channel'),
      ]);
      assert.ok(a.params.content.includes('broadcast test'), 'session A received it');
      assert.ok(b.params.content.includes('broadcast test'), 'session B received it');
    } finally {
      streamA.close();
      streamB.close();
    }
  } finally {
    await pair.stop();
  }
});

// ── Fail-safe: a dead MCP notify target must not break posting ───────────

test('a commons post still succeeds when the MCP notify target is unreachable', async () => {
  // REST server pointed at a notify URL with nothing listening (port 1 → refused).
  const rest = await startRestServer({
    mcpNotifyUrl: 'http://127.0.0.1:1/internal/notify',
  });
  try {
    const res = await postConversation(rest.baseUrl, 'post with no nudge', 'kit');
    assert.equal(res.status, 201, 'posting succeeds even though the nudge cannot be delivered');
    const convs = await (await fetch(`${rest.baseUrl}/api/conversations`)).json();
    assert.equal(convs.length, 1, 'the conversation was persisted');
  } finally {
    await rest.stop();
  }
});

// ── Regression #289: a 409'd second GET must not deafen the held stream ───
//
// A channel client can open two GETs on one session (e.g. an SDK auto-open plus
// a forced resumeStream); the board holds one and rejects the other with 409.
// Before #289 `hasOpenStream` was a single per-session boolean, so the losing
// GET's immediate close flipped it false — and the board then skipped the still-
// held session in fan-out. Result: a live, connected receiver got zero
// broadcasts ("connected-but-deaf"). The fix tracks a count of open streams so a
// losing GET's close can't clobber a live one.

test('a 409-rejected second GET does not deafen the held channel stream (#289)', async () => {
  const pair = await startPair();
  try {
    const session = await mcpSession(pair.mcp.mcpUrl);
    const stream = await openChannelStream(pair.mcp.mcpUrl, session.sessionId);
    try {
      // Second concurrent GET on the same session — the board holds one stream
      // per session, so this one is rejected (409) and its response closes at
      // once. That close must NOT clobber the first, still-held stream.
      const loser = await fetch(pair.mcp.mcpUrl, {
        method: 'GET',
        headers: { 'mcp-session-id': session.sessionId, Accept: 'text/event-stream' },
      });
      assert.equal(
        loser.status, 409,
        'the second concurrent GET is rejected — one held stream per session',
      );
      await loser.text(); // drain so the server-side response fully closes
      await new Promise((r) => setTimeout(r, 50)); // let the server's res.on('close') run

      // The first stream is still held; a broadcast must still reach it.
      await postConversation(pair.rest.baseUrl, 'still listening?', 'robin');
      const notif = await stream.next('notifications/claude/channel');
      assert.ok(
        notif.params.content.includes('still listening?'),
        'the held stream still receives after the losing GET closed',
      );
    } finally {
      stream.close();
    }
  } finally {
    await pair.stop();
  }
});
