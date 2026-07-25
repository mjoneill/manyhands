/**
 * Server-side tests for the MCP server (#105).
 *
 * The MCP server is a thin adapter over the REST API (Pattern A). Tool tests
 * start a REST server first and point the MCP server at it, then verify the
 * tool's *effect* on REST state — behavior, not response shape.
 *
 * Includes the regression test for the #91 crash: a malformed JSON body must
 * not take the process down.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, startMcpServer, mcpSession, makeBoardFixture, startPair, openChannelStream } from './helpers/harness.mjs';

/** Test body with an MCP server only (no REST backend). */
function mcpTest(name, fn) {
  test(name, async () => {
    const mcp = await startMcpServer();
    try {
      await fn(mcp);
    } finally {
      await mcp.stop();
    }
  });
}

/** Test body with a REST server + an MCP server wired to it. */
function mcpWithRestTest(name, fn) {
  test(name, async () => {
    const rest = await startRestServer();
    const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
    try {
      await fn({ rest, mcp });
    } finally {
      await mcp.stop();
      await rest.stop();
    }
  });
}

// ── /health ─────────────────────────────────────────────────────────────

mcpTest('GET /health reports the server is alive', async ({ healthUrl }) => {
  const res = await fetch(healthUrl);
  assert.equal(res.status, 200);
  const health = await res.json();
  assert.equal(health.ok, true);
  assert.equal(typeof health.sessions, 'number');
});

// ── #182: the transports Map must not leak on abandoned sessions ─────────
// Each initialize creates a transport + a full McpServer kept in the Map and
// removed only on a clean onclose — which abandoned HTTP/SSE clients never send.
// Unbounded growth here is what OOM-crashed the live server. The reaper evicts
// idle sessions holding no open SSE stream; a streaming session must be kept.
// Short reap thresholds via env so the test doesn't wait minutes.
const REAP_ENV = { MCP_REAP_IDLE_MS: '120', MCP_REAP_SWEEP_MS: '40' };
// #363 — the accumulation test below needs an idle window comfortably LONGER
// than how long 25 sequential inits take under full-suite parallel load, or the
// earliest sessions age past the threshold and get reaped before the loop ends,
// racing the "sessions accumulated" sanity precondition. 120ms lost that race
// under load (saw +15 of 25); 2000ms gives ~an order of magnitude of headroom.
const REAP_ENV_SLOW = { MCP_REAP_IDLE_MS: '2000', MCP_REAP_SWEEP_MS: '40' };

test('#182: idle abandoned MCP sessions are reaped (no unbounded Map growth)', async () => {
  const mcp = await startMcpServer({ env: REAP_ENV_SLOW }); // #363 — idle > accumulation, deterministic
  try {
    const base = (await (await fetch(mcp.healthUrl)).json()).sessions;
    const N = 25;
    for (let i = 0; i < N; i++) await mcpSession(mcp.mcpUrl); // init + abandon (no clean close)
    const peak = (await (await fetch(mcp.healthUrl)).json()).sessions;
    assert.ok(peak - base >= N - 2, `sanity: sessions should accumulate first (saw +${peak - base})`);
    await new Promise((r) => setTimeout(r, 2500)); // #363 — > 2000ms idle threshold + a few sweeps
    const after = (await (await fetch(mcp.healthUrl)).json()).sessions;
    assert.ok(
      after - base <= 2,
      `transports leaked: ${after - base} of ${N} abandoned sessions still retained after the reap window`,
    );
  } finally {
    await mcp.stop();
  }
});

test('#182: a session holding an OPEN SSE stream is NOT reaped', async () => {
  const mcp = await startMcpServer({ env: REAP_ENV });
  try {
    const base = (await (await fetch(mcp.healthUrl)).json()).sessions;
    const { sessionId } = await mcpSession(mcp.mcpUrl);
    // open the server->client SSE stream and hold it open past the reap window
    const ac = new AbortController();
    const stream = fetch(mcp.mcpUrl, {
      method: 'GET',
      headers: { 'mcp-session-id': sessionId, Accept: 'text/event-stream' },
      signal: ac.signal,
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 550)); // well past idle threshold
    const after = (await (await fetch(mcp.healthUrl)).json()).sessions;
    assert.ok(after - base >= 1, 'a session with an open SSE stream must survive the reaper');
    ac.abort();
    await stream;
  } finally {
    await mcp.stop();
  }
});

// ── Regression: malformed input must not crash the process (#91) ────────

mcpTest('malformed JSON body does not crash the MCP server (#91)', async ({ mcpUrl, healthUrl }) => {
  // Pre-fix, an unguarded JSON.parse threw and the process exited.
  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: '{ this is not valid json at all',
  });
  // We don't care about the exact status — only that we got a response
  // and the server is still standing.
  assert.ok(res.status >= 400, 'malformed request is rejected, not accepted');

  const health = await (await fetch(healthUrl)).json();
  assert.equal(health.ok, true, 'server survived the malformed request');
});

mcpTest('an empty body does not crash the MCP server', async ({ mcpUrl, healthUrl }) => {
  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: '',
  });
  assert.ok(res.status >= 400);
  const health = await (await fetch(healthUrl)).json();
  assert.equal(health.ok, true, 'server survived the empty body');
});

// ── Handshake + tool discovery ──────────────────────────────────────────

mcpTest('initialize handshake yields a session id', async ({ mcpUrl }) => {
  const session = await mcpSession(mcpUrl);
  assert.ok(session.sessionId, 'got an mcp-session-id');
});

mcpTest('tools/list exposes the core tools with underscore names', async ({ mcpUrl }) => {
  const session = await mcpSession(mcpUrl);
  const listed = await session.listTools();
  const names = (listed.result?.tools ?? []).map((t) => t.name);
  assert.ok(names.length > 0, 'at least one tool is exposed');
  for (const expected of ['card_create', 'board_status', 'conversation_post']) {
    assert.ok(names.includes(expected), `exposes ${expected}`);
  }
  // Dotted names were rejected by the model API — guard against regressing.
  assert.ok(!names.some((n) => n.includes('.')), 'no dotted tool names');
});

// ── Tools have real effects on REST state ───────────────────────────────

mcpWithRestTest('card_create tool actually creates a card', async ({ rest, mcp }) => {
  const session = await mcpSession(mcp.mcpUrl);
  const result = await session.callTool('card_create', { title: 'made via MCP' });
  assert.ok(!result.error, `tool call did not error: ${JSON.stringify(result.error)}`);

  const cards = await (await fetch(`${rest.baseUrl}/api/cards`)).json();
  assert.equal(cards.length, 1, 'one card now exists on the REST side');
  assert.equal(cards[0].title, 'made via MCP');
});

mcpWithRestTest('conversation_post tool appends to the commons', async ({ rest, mcp }) => {
  const session = await mcpSession(mcp.mcpUrl);
  const result = await session.callTool('conversation_post', {
    body: 'posted through MCP',
    author: 'sage',
  });
  assert.ok(!result.error, `tool call did not error: ${JSON.stringify(result.error)}`);

  const convs = await (await fetch(`${rest.baseUrl}/api/conversations`)).json();
  assert.equal(convs.length, 1);
  assert.equal(convs[0].body, 'posted through MCP');
  assert.equal(convs[0].author, 'sage');
});

mcpWithRestTest('board_status tool returns board state', async ({ rest, mcp }) => {
  await fetch(`${rest.baseUrl}/api/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'visible to board_status' }),
  });
  const session = await mcpSession(mcp.mcpUrl);
  const result = await session.callTool('board_status', {});
  assert.ok(!result.error, `tool call did not error: ${JSON.stringify(result.error)}`);
  const text = (result.result?.content ?? []).map((c) => c.text ?? '').join('\n');
  assert.ok(text.length > 0, 'board_status returned content');
});

mcpWithRestTest('#110 conversation_list tool accepts a mentions_me filter', async ({ rest, mcp }) => {
  const post = (body, author) =>
    fetch(`${rest.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, author }),
    });
  await post('@sage please review the build run', 'alex');
  await post('unrelated chatter in the room', 'nova');

  const session = await mcpSession(mcp.mcpUrl);
  const result = await session.callTool('conversation_list', { mentions_me: 'sage' });
  assert.ok(!result.error, `tool call errored: ${JSON.stringify(result.error)}`);
  const text = (result.result?.content ?? []).map((c) => c.text ?? '').join('\n');
  const parsed = JSON.parse(text);
  assert.equal(parsed.length, 1, 'only the @sage message comes back');
  assert.equal(parsed[0].author, 'alex');
});

// ── #202: conversation_list must not dump full history by default ──────────
// The tool returned the ENTIRE board history unfiltered, blowing the consumer's
// ~32KB tool-result budget and burying agents who pulled it to "catch up".
// The cap lives in the MCP tool (mcp-server.mjs), NOT the REST endpoint — the
// browser UI's commons feed (loadConversations) depends on the REST list
// staying full. Budget is env-overridable so the test uses a small, deterministic cap.
const CONV_BUDGET_ENV = { SCRUM_CONV_LIST_BUDGET: '3000' };

function manyConversations(n, bodyLen = 200) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `c${String(i).padStart(4, '0')}`,
      author: i % 2 ? 'nova' : 'sage',
      body: `m${i} ` + 'x'.repeat(bodyLen),
      attachedTo: null,
      createdAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
      mentions: [],
    });
  }
  return out;
}

const parseList = (result) =>
  JSON.parse((result.result?.content ?? []).map((c) => c.text ?? '').join('\n'));

async function withConvBoard(convs, fn) {
  const rest = await startRestServer({ board: makeBoardFixture({ conversations: convs }) });
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl, env: CONV_BUDGET_ENV });
  try {
    await fn({ rest, mcp, session: await mcpSession(mcp.mcpUrl) });
  } finally {
    await mcp.stop();
    await rest.stop();
  }
}

test('#202: conversation_list defaults to a bounded RECENT window, not the full dump', async () => {
  const all = manyConversations(200);
  await withConvBoard(all, async ({ session }) => {
    const got = parseList(await session.callTool('conversation_list', {}));
    assert.ok(Array.isArray(got), 'returns an array');
    assert.ok(got.length < all.length, `capped below full history (got ${got.length} of ${all.length})`);
    assert.ok(JSON.stringify(got).length <= 32000, 'payload stays under the 32KB consumer budget');
    assert.equal(got[got.length - 1].id, all[all.length - 1].id, 'includes the newest message');
    assert.ok(!got.some((c) => c.id === all[0].id), 'excludes the oldest message');
  });
});

test('#202: conversation_list limit=all returns the FULL history (explicit opt-in)', async () => {
  const all = manyConversations(200);
  await withConvBoard(all, async ({ session }) => {
    const got = parseList(await session.callTool('conversation_list', { limit: 'all' }));
    assert.equal(got.length, all.length, 'limit=all returns everything');
  });
});

test('#202: conversation_list limit=N returns the N most-recent', async () => {
  const all = manyConversations(50);
  await withConvBoard(all, async ({ session }) => {
    const got = parseList(await session.callTool('conversation_list', { limit: '5' }));
    assert.equal(got.length, 5, 'returns exactly N');
    assert.equal(got[4].id, all[49].id, 'the newest is included');
    assert.equal(got[0].id, all[45].id, 'they are the N most-recent');
  });
});

test('#202: the REST list endpoint stays UNCAPPED — the browser UI depends on it', async () => {
  const all = manyConversations(200);
  const rest = await startRestServer({ board: makeBoardFixture({ conversations: all }) });
  try {
    const got = await (await fetch(`${rest.baseUrl}/api/conversations`)).json();
    assert.equal(got.length, all.length, "REST returns full history (capping is the MCP tool's job, not REST's)");
  } finally {
    await rest.stop();
  }
});

// ── #205/#206: attachments must reach every agent seat (channel knock + pull) ──
// #113 left attachment content visible only to a board-reading, FS-capable agent.
// (A) the channel block flags an attachment with a scalar `[📎 name]` marker in
// its CONTENT (never in meta — non-scalar meta is silently dropped by Claude
// Code's renderer; #205's attachments[] array there deafened every seat, #206
// fixed it); (B) attachment_get(id) pulls the bytes on demand (image content block).
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const uploadAtt = (baseUrl, name = 'pic.png', mime = 'image/png', data = PNG_1x1) =>
  fetch(`${baseUrl}/api/attachments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mime, data }),
  }).then((r) => r.json());

// A meta value is "scalar" if it's string/number/boolean (or absent). Claude
// Code's channel renderer SILENTLY DROPS any block whose meta carries a
// non-scalar (object/array) value — #205 deafened every seat by putting an
// attachments[] array in meta. This guard would have caught it; it is the first
// assertion in an emergent, probe-built contract for the opaque renderer.
const isScalarMetaValue = (v) =>
  v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v);

test('#206: channel notification meta is ALL-SCALAR (renderer-contract guard — would have caught #205)', async () => {
  const pair = await startPair();
  let stream;
  try {
    const session = await mcpSession(pair.mcp.mcpUrl);
    stream = await openChannelStream(pair.mcp.mcpUrl, session.sessionId);
    const meta = await uploadAtt(pair.rest.baseUrl);
    await fetch(`${pair.rest.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'alex', body: 'look', attachments: [meta] }),
    });
    const notif = await stream.next('notifications/claude/channel');
    const m = notif.params?.meta || {};
    assert.ok(
      typeof m.message_id === 'string' && m.message_id.length > 0,
      'meta is populated (guard is not vacuously passing on an empty meta)',
    );
    for (const [k, v] of Object.entries(m)) {
      assert.ok(isScalarMetaValue(v), `meta.${k} must be scalar (got ${typeof v}) — non-scalar meta is silently dropped by the renderer`);
    }
    assert.equal(m.attachments, undefined, 'attachments must NOT be in meta (that was the #205 regression)');
  } finally {
    if (stream) stream.close();
    await pair.stop();
  }
});

test('#206: the channel block flags an attachment with a scalar [📎 name] marker in content (the knock)', async () => {
  const pair = await startPair();
  let stream;
  try {
    const session = await mcpSession(pair.mcp.mcpUrl);
    stream = await openChannelStream(pair.mcp.mcpUrl, session.sessionId);
    const meta = await uploadAtt(pair.rest.baseUrl, 'diagram.png');
    await fetch(`${pair.rest.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'alex', body: 'look', attachments: [meta] }),
    });
    const notif = await stream.next('notifications/claude/channel');
    assert.match(
      notif.params?.content || '',
      /\[📎 diagram\.png\]/,
      'content carries the attachment marker so a channel-woken agent perceives it without a lookup',
    );
  } finally {
    if (stream) stream.close();
    await pair.stop();
  }
});

test('#206: a plain post (no attachment) gets NO marker — content is untouched', async () => {
  const pair = await startPair();
  let stream;
  try {
    const session = await mcpSession(pair.mcp.mcpUrl);
    stream = await openChannelStream(pair.mcp.mcpUrl, session.sessionId);
    await fetch(`${pair.rest.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'alex', body: 'just text' }),
    });
    const notif = await stream.next('notifications/claude/channel');
    assert.equal(notif.params?.content, 'alex: just text', 'no attachment → no marker');
  } finally {
    if (stream) stream.close();
    await pair.stop();
  }
});

test('#205: attachment_get(id) pulls the image back as an image content block', async () => {
  const rest = await startRestServer();
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const meta = await uploadAtt(rest.baseUrl);
    const session = await mcpSession(mcp.mcpUrl);
    const res = await session.callTool('attachment_get', { id: meta.id });
    const content = res.result?.content || [];
    assert.equal(content.length, 2, 'image block + the #345 path hint');
    assert.equal(content[0].type, 'image', 'the image is FIRST, so a vision model sees it before prose');
    assert.equal(content[0].mimeType, 'image/png');
    assert.ok(content[0].data && content[0].data.length > 0, 'has base64 image data');
  } finally {
    await mcp.stop();
    await rest.stop();
  }
});

// ── #345: a text-only seat must not be left holding an inert image block ──
// A seat whose model is text-only (some models declare input:["text"] only
// both declare input:["text"]). An image content block is inert to such a model.
// Before this, images returned the block and NOTHING else, while a mere PDF
// returned a helpful filesystem path — so the seat that could least use the bytes
// was the one given no way out. The path lets it route the image to a vision model.
test('#345: attachment_get returns the on-disk path alongside the image (text-only seats are not left blind)', async () => {
  const rest = await startRestServer();
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const meta = await uploadAtt(rest.baseUrl);
    const session = await mcpSession(mcp.mcpUrl);
    const res = await session.callTool('attachment_get', { id: meta.id });
    const content = res.result?.content || [];
    const hint = content.find((b) => b.type === 'text');
    assert.ok(hint, 'a text block accompanies the image');
    assert.ok(hint.text.includes(meta.id), 'the hint names the attachment id');
    assert.ok(hint.text.includes('attach'), 'the hint carries a filesystem path into the attachments dir');
    assert.ok(hint.text.includes('image'), 'the hint points at the image tool (the vision path)');
    assert.ok(!res.result?.isError, 'still a success, not an error');
  } finally {
    await mcp.stop();
    await rest.stop();
  }
});

// A non-image must keep its existing contract: no bytes inlined, path offered.
test('#345: a non-image attachment still returns a path and never inlines megabytes of base64', async () => {
  const rest = await startRestServer();
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const meta = await uploadAtt(rest.baseUrl, 'notes.pdf', 'application/pdf', PNG_1x1);
    const session = await mcpSession(mcp.mcpUrl);
    const res = await session.callTool('attachment_get', { id: meta.id });
    const content = res.result?.content || [];
    assert.equal(content.length, 1, 'non-image: text only');
    assert.equal(content[0].type, 'text');
    assert.ok(content[0].text.includes('non-image'), 'says so plainly');
    assert.ok(content[0].text.includes(meta.id), 'offers the path');
  } finally {
    await mcp.stop();
    await rest.stop();
  }
});

test('#205: attachment_get rejects a malicious id and never returns bytes', async () => {
  const rest = await startRestServer();
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const session = await mcpSession(mcp.mcpUrl);
    const res = await session.callTool('attachment_get', { id: '../../etc/passwd' });
    const c = res.result?.content?.[0] || {};
    assert.ok(res.result?.isError || c.type === 'text', 'rejected (error/text, not image bytes)');
    assert.notEqual(c.type, 'image');
  } finally {
    await mcp.stop();
    await rest.stop();
  }
});

// ── #301: bound MCP request bodies (mirror the REST server's #250 caps) ──
// :3001 buffered every request body unbounded — a giant POST could OOM the
// channel-delivery host and deafen the whole room until launchd restarts it.
test('#301 MCP rejects an over-cap request body and stays alive', async () => {
  // Tiny cap so the test payload is small; the server reads it from env.
  const mcp = await startMcpServer({ env: { SCRUM_MCP_MAX_BODY_BYTES: '2000' } });
  try {
    const huge = 'x'.repeat(50_000);
    const res = await fetch(mcp.mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { pad: huge } }),
    });
    assert.equal(res.status, 413, 'over-cap body rejected with 413');

    // The server must still be alive afterward (the whole point — no OOM/crash).
    const health = await fetch(mcp.healthUrl);
    assert.equal(health.status, 200, 'MCP server survived the oversized POST');

    // /internal/notify is bounded too (it's the other unbounded reader).
    const notify = await fetch(`${mcp.healthUrl.replace('/health', '')}/internal/notify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pad: huge }),
    });
    assert.equal(notify.status, 413, '/internal/notify also bounded');
    const health2 = await fetch(mcp.healthUrl);
    assert.equal(health2.status, 200, 'still alive after oversized notify');
  } finally {
    await mcp.stop();
  }
});

// A normal-sized request still works under the cap (regression guard).
test('#301 a normal request under the cap still handshakes', async () => {
  const mcp = await startMcpServer({ env: { SCRUM_MCP_MAX_BODY_BYTES: '1000000' } });
  try {
    const session = await mcpSession(mcp.mcpUrl);
    assert.ok(session.sessionId, 'initialize succeeded under the cap');
  } finally {
    await mcp.stop();
  }
});

// ── #303-7: delivery observability endpoints ──

test('#303-7 MCP /channel/status reports pending/mode/receivers/sessions', async () => {
  const mcp = await startMcpServer();
  try {
    const res = await fetch(mcp.healthUrl.replace('/health', '/channel/status'));
    assert.equal(res.status, 200);
    const s = await res.json();
    assert.equal(typeof s.pending, 'number', 'pending is a number');
    assert.equal(s.pending, 0, 'idle server has nothing in flight');
    assert.ok('mode' in s && 'receivers' in s && 'sessions' in s, 'shape: ' + JSON.stringify(s));
  } finally {
    await mcp.stop();
  }
});

test('#303-7 REST /api/channel-status proxies the MCP status (same-origin for the browser)', async () => {
  const pair = await startPair();
  try {
    const res = await fetch(`${pair.rest.baseUrl}/api/channel-status`);
    assert.equal(res.status, 200);
    const s = await res.json();
    assert.equal(typeof s.pending, 'number', 'proxied pending is a number: ' + JSON.stringify(s));
    assert.ok('mode' in s && 'receivers' in s, 'proxied shape carries through');
  } finally {
    await pair.stop();
  }
});

test('#303-7 REST /api/channel-status degrades to idle when MCP is unreachable', async () => {
  // notify disabled (default) → no MCP status URL → benign idle report, never an error.
  const rest = await startRestServer();
  try {
    const res = await fetch(`${rest.baseUrl}/api/channel-status`);
    assert.equal(res.status, 200, 'still 200, never errors the UI');
    const s = await res.json();
    assert.equal(s.pending, 0, 'idle when MCP is not wired');
  } finally {
    await rest.stop();
  }
});

// ── #362: the server onboards new sessions into the claim protocol ────────
// The coordination rail (#348/#350) is only structural if a fresh seat — a new
// agent, a post-compaction session with no memory of the protocol — learns the
// way of working at connect time, from the server itself. Tool schemas arrive
// automatically; the CONTRACT (claim before driving, 409 = yield, release when
// done) must ride in the initialize instructions.

mcpTest('#362: initialize instructions teach the claim protocol to a fresh session', async ({ mcpUrl }) => {
  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'claim-onboarding-test', version: '1.0.0' },
      },
    }),
  });
  const text = await res.text();
  const dataLine = text.split('\n').find((l) => l.trimStart().startsWith('data:'));
  const parsed = JSON.parse((dataLine ?? text).replace(/^\s*data:\s*/, ''));
  const instructions = parsed.result?.instructions ?? '';
  assert.ok(instructions.includes('card_claim'), 'instructions name the claim tool');
  assert.match(instructions, /409/, 'instructions state the 409 contract');
  assert.match(instructions, /yield/i, 'instructions say a 409 means yield, not retry');
  assert.ok(instructions.includes('card_release'), 'instructions name the release tool');
});
