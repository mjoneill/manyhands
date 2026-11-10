/**
 * #1870: the OpenRouter extraction adapter must not record ok:true for a call the
 * provider did not finish. It wrote `ok: true` on every HTTP 200 and recorded
 * finish_reason beside it without reading it: model-call d530379c (17:42:09Z) reads
 * stopReason "error", ok:true, error:null.
 *
 * Rule (decided on #1870), SCOPED TO THIS ADAPTER: ok is true only when
 * finish_reason is "stop". A null finish_reason is an unproven completion, so
 * ok:false. OpenRouter normally sends one; an adapter whose provider never sends one
 * needs its own decision, not this rule. The HTTP 200 stays visible in `error`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenRouterModel } from '../core/knowledge-extraction-adapters.mjs';

function modelAnswering(finish) {
  const rows = [];
  const choice = { message: { content: '{"a":1}' } };
  if (finish !== undefined) choice.finish_reason = finish;
  const fetchImpl = async () => ({ status: 200, text: async () => JSON.stringify({ choices: [choice], usage: { prompt_tokens: 3, completion_tokens: 2 } }) });
  const model = createOpenRouterModel({ apiKey: 'sk-or-test-not-a-real-key', baseUrl: 'https://openrouter.test/api/v1', modelId: 'm/x', fetchImpl, ledger: { recordModelCall: async (r) => { rows.push(r); } } });
  return { model, rows };
}
const send = async (finish) => { const { model, rows } = modelAnswering(finish); const r = await model.send({ messages: [] }); assert.equal(rows.length, 1); return { r, row: rows[0] }; };

test('#1870 L1: HTTP 200 with finish_reason "error" (the d530379c shape) records ok:false, keeps the stop reason, and names the HTTP 200', async () => {
  const { row } = await send('error');
  assert.equal(row.ok, false);
  assert.equal(row.stopReason, 'error');
  assert.match(row.error, /finish_reason "error"/);
  assert.match(row.error, /http 200/);
});

for (const f of ['length', 'content_filter']) {
  test(`#1870 L2: HTTP 200 with finish_reason "${f}" records ok:false`, async () => {
    const { row } = await send(f);
    assert.equal(row.ok, false);
    assert.equal(row.stopReason, f);
  });
}

test('#1870 L3: HTTP 200 with NO finish_reason records ok:false (an unproven completion, decided on #1870 for THIS adapter)', async () => {
  const { row } = await send(undefined);
  assert.equal(row.ok, false);
  assert.equal(row.stopReason, null);
  assert.match(row.error, /no finish_reason/);
});

test('#1870 L4 (control): finish_reason "stop" records ok:true with no error, and the answer is returned unchanged', async () => {
  const { r, row } = await send('stop');
  assert.equal(row.ok, true);
  assert.equal(row.error, undefined);
  assert.equal(row.stopReason, 'stop');
  assert.deepEqual(r, { status: 200, json: { a: 1 } });
});
