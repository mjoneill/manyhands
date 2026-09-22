/**
 * #1435 — A FAILED CALL STILL SPENT TOKENS, and the row must say how many.
 *
 * 2026-09-22 22:03:54Z: a reasoning resident's call failed `nonEmpty` after
 * 205 s. Its board row carried NO usage (tokensOut / reasoningTokens null), so
 * the one question #1435 asks — did it spend its whole budget thinking? — could
 * not be answered from the row. The two calls before it spent 96.5% and 95.8%
 * of their output on reasoning. The adapter already attaches `usage` to the
 * error; the tool loop dropped the earlier hops' usage when a later hop threw,
 * and guestOnce's failure path wrote the row without any of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guestOnce } from '../core/guest-loop.mjs';
import { callModel, ModelAssertionError } from '../core/model-adapter.mjs';
import { rowToBoard } from '../core/model-call-row.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const api = async (baseUrl, method, p, body) => {
  const r = await fetch(`${baseUrl}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let parsed = null; try { parsed = await r.json(); } catch { /* none */ }
  return { status: r.status, body: parsed };
};
const MSGS = [{ role: 'user', content: 'hi' }];

test('#1435 adapter — the nonEmpty error carries usage AND the provider finish reason', async () => {
  const res = { status: 200, rawBody: '{}', body: { choices: [{ message: { content: '  ' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 900, completion_tokens: 1500, completion_tokens_details: { reasoning_tokens: 1500 } } } };   // under the runaway floor (2000), so nonEmpty is what fires
  await assert.rejects(
    () => callModel({ model: 'm', protocol: 'openai-completions', baseUrl: 'http://x', thinking: true }, MSGS, { transport: async () => res }),
    (e) => {
      assert.ok(e instanceof ModelAssertionError && e.assertion === 'nonEmpty');
      assert.equal(e.usage?.completionTokens, 1500, 'usage rides the error');
      assert.equal(e.usage?.reasoningTokens, 1500);
      assert.equal(e.stopReason, 'stop', 'and the finish reason, so "empty with stop" and "empty at length" are different rows');
      return true;
    });
});

test('#1435 adapter — a RUNAWAY abort carries usage too (it spent the most, and said the least)', async () => {
  const res = { status: 200, rawBody: '{}', body: { choices: [{ message: { content: 'loop loop loop' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 9000, completion_tokens_details: { reasoning_tokens: 100 } } } };
  await assert.rejects(
    () => callModel({ model: 'm', protocol: 'openai-completions', baseUrl: 'http://x' }, MSGS, { transport: async () => res }),
    (e) => { assert.equal(e.name, 'RunawayGenerationError'); assert.equal(e.usage?.completionTokens, 9000); return true; });
});

async function failedWake({ toolGrants }) {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  const agent = { seatKey: 'gizmo', name: 'Gizmo', systemPrompt: 'answer', residency: 'resident', model: { model: 'm', protocol: 'openai-completions', thinking: true }, ...(toolGrants ? { toolGrants } : {}) };
  const mention = (await api(srv.baseUrl, 'POST', '/api/conversations', { body: '@gizmo think hard', author: 'bo' })).body;
  let hop = 0;
  const empty = () => new ModelAssertionError('nonEmpty', 'the provider returned success and no text.',
    { usage: { promptTokens: 21000, completionTokens: 11300, reasoningTokens: 10900 }, attempts: 1, stopReason: 'stop' });
  const callModelStub = async () => {
    hop += 1;
    if (toolGrants && hop === 1) return { text: '', toolCalls: [{ id: 't1', name: 'card_get', arguments: { shortId: 1 } }], stopReason: 'tool_calls', usage: { promptTokens: 20000, completionTokens: 400, reasoningTokens: 380 }, anomalies: [] };
    throw empty();
  };
  const r = await guestOnce({ agent, wake: mention, callModel: callModelStub, execute: async () => ({ id: 'x' }),
    post: (b) => api(srv.baseUrl, 'POST', '/api/conversations', b).then((x) => x.body),
    ledgerSink: async (row) => (await api(srv.baseUrl, 'POST', '/api/model-calls', rowToBoard(row, agent))).body,
    ledgerFile: `/tmp/never-used-1435-${process.pid}.jsonl` });
  const wire = (await api(srv.baseUrl, 'GET', '/api/model-calls?agent=gizmo&limit=1')).body.calls[0];
  await srv.stop();
  return { r, wire };
}

test('#1435 END TO END (direct call) — a failed wake\'s BOARD row carries tokens, reasoning, finish reason', async () => {
  const { r, wire } = await failedWake({});
  assert.equal(r.reason, 'model-failed');
  assert.equal(wire.ok, false);
  assert.equal(wire.tokensOut, 11300, 'the spend is on the row');
  assert.equal(wire.reasoningTokens, 10900, 'and how much of it was thinking — the #1435 question');
  assert.equal(wire.tokensIn, 21000);
  assert.equal(wire.stopReason, 'stop');
});

test('#1435 END TO END (tool loop) — a failure on a LATER hop keeps the earlier hops\' usage, summed, and the hops', async () => {
  const { r, wire } = await failedWake({ toolGrants: ['card_get'] });
  assert.equal(r.reason, 'model-failed');
  assert.equal(wire.tokensOut, 11700, 'hop 1 (400) + failed hop 2 (11300): a wake is N calls, billed as N');
  assert.equal(wire.reasoningTokens, 11280);
  assert.equal(wire.modelCalls, 2, 'the row says how many calls the failed wake made');
  assert.equal(wire.toolHops.length, 1, 'and what it fetched before it failed');
});
