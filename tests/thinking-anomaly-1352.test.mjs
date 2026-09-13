/**
 * #1352 — THE ANSWER IS PUBLISHED; THE ANOMALY IS ON THE ROW. Across every seam.
 *
 * The adapter test flips the refusal (tests/model-adapter.test.mjs). This file
 * is about the four layers between the adapter and the ledger, because #1294
 * is the proof that a value the adapter returns can be dropped at any one of
 * them and look correct in a single-layer test:
 *
 *   adapter → tool loop (union across hops) → guest loop (row) → POST /api/model-calls → wire
 *
 * Each seam gets one assertion, and the last one reads the row BACK through
 * the API — #1254's lesson: a field accepted on write and never returned on
 * read is a field that does not exist to the caller.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runToolLoop } from '../core/tool-loop.mjs';
import { guestOnce } from '../core/guest-loop.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const api = async (baseUrl, method, p, body) => {
  const r = await fetch(`${baseUrl}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let parsed = null; try { parsed = await r.json(); } catch { /* none */ }
  return { status: r.status, body: parsed };
};

const AGENT = { seatKey: 'gizmo', name: 'Gizmo', systemPrompt: 'answer', model: { model: 'm', protocol: 'openai-completions', thinking: true }, thinking: true, residency: 'guest', toolGrants: ['card_get'] };
const TOOLS = [{ name: 'card_get' }];

test('#1352 tool loop — an anomaly on ANY hop is on the wake, de-duplicated, and a clean wake carries []', async () => {
  const turns = [
    { text: '', toolCalls: [{ id: 't1', name: 'card_get', arguments: { id: 1 } }], usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0 }, anomalies: ['zero-reasoning-tokens'] },
    { text: '', toolCalls: [{ id: 't2', name: 'card_get', arguments: { id: 2 } }], usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 9 }, anomalies: [] },
    { text: 'the answer', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0 }, anomalies: ['zero-reasoning-tokens'] },
  ];
  let i = 0;
  const out = await runToolLoop({ agent: AGENT, messages: [], tools: TOOLS, execute: async () => 'ok', callModel: async () => turns[i++] });
  assert.equal(out.text, 'the answer');
  assert.deepEqual(out.anomalies, ['zero-reasoning-tokens']);

  const clean = await runToolLoop({ agent: AGENT, messages: [], tools: [], callModel: async () => ({ text: 'fine', toolCalls: [], usage: { reasoningTokens: 5 }, anomalies: [] }) });
  assert.deepEqual(clean.anomalies, []);
  // an adapter that predates the field (no `anomalies` key at all) must not crash the loop
  const old = await runToolLoop({ agent: AGENT, messages: [], tools: [], callModel: async () => ({ text: 'fine', toolCalls: [], usage: null }) });
  assert.deepEqual(old.anomalies, []);
});

test('#1352 END TO END — the answer is POSTED, and the ledger row read back through the API carries the anomaly', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const mention = (await api(srv.baseUrl, 'POST', '/api/conversations', { body: '@gizmo are you there?', author: 'bo' })).body;
    const post = (b) => api(srv.baseUrl, 'POST', '/api/conversations', b).then((r) => r.body);
    // the runner's rowToBoard, reduced to the fields this test is about
    const ledgerSink = async (row) => (await api(srv.baseUrl, 'POST', '/api/model-calls', {
      by: row.agent, agent: row.agent, model: row.model, protocol: row.protocol, reasoningTokens: row.usage?.reasoningTokens ?? null,
      cost: 0, stopReason: row.stopReason, ok: row.ok, producedPost: row.postId, at: row.at, anomalies: row.anomalies ?? [],
    })).body;
    // what the adapter now returns for the 9-of-378 shape: text, zero reasoning, anomaly flagged
    const callModel = async () => ({ text: 'here, answered without reasoning', toolCalls: [], stopReason: 'stop', usage: { promptTokens: 10, completionTokens: 8, reasoningTokens: 0 }, anomalies: ['zero-reasoning-tokens'] });
    const r = await guestOnce({ agent: AGENT, wake: mention, callModel, post, ledgerSink, ledgerFile: `/tmp/never-used-1352-${process.pid}.jsonl` });
    assert.equal(r.posted, true, 'the answer reached the room');
    assert.ok(r.postId);

    const calls = (await api(srv.baseUrl, 'GET', '/api/model-calls?agent=gizmo')).body.calls;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ok, true);
    assert.equal(calls[0].producedPost, r.postId, 'the row points at the post — this is what made the 9 rows readable as losses, and now as deliveries');
    assert.deepEqual(calls[0].anomalies, ['zero-reasoning-tokens'], 'and the anomaly is on the row, read back, not only accepted');
    assert.equal(calls[0].reasoningTokens, 0);
  } finally { await srv.stop(); }
});

test('#1352 wire — a row posted WITHOUT the field reads back as [] (older runners), and a non-array is not silently coerced into a claim', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const legacy = await api(srv.baseUrl, 'POST', '/api/model-calls', { by: 'gizmo', model: 'm', cost: 0 });
    assert.equal(legacy.status, 201, JSON.stringify(legacy.body));
    const rows = (await api(srv.baseUrl, 'GET', '/api/model-calls?agent=gizmo')).body.calls;
    assert.deepEqual(rows[0].anomalies, []);
    const odd = await api(srv.baseUrl, 'POST', '/api/model-calls', { by: 'gizmo', model: 'm', cost: 0, anomalies: 'zero-reasoning-tokens' });
    assert.equal(odd.status, 201);
    const rows2 = (await api(srv.baseUrl, 'GET', '/api/model-calls?agent=gizmo')).body.calls;
    assert.deepEqual(rows2.find((c) => c.id === odd.body.id).anomalies, [], 'a bare string is not an anomaly list');
  } finally { await srv.stop(); }
});
