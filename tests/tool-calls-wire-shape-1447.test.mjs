/**
 * #1447 live finding — the tool loop keeps an assistant's tool calls in the
 * adapter's NORMALISED shape ({id, name, arguments}) and hands the transcript
 * back to the adapter. Lenient providers accepted that; the first strict one
 * (reached once data_collection: "deny" narrowed routing) refused every
 * multi-hop wake with 'missing messages.tool_calls.function'. The wire shape
 * belongs to the protocol, so each protocol's request serialises it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callModel } from '../core/model-adapter.mjs';

const normalised = [{ id: 'call_1', name: 'card_get', arguments: { id: '7' } }];
const HISTORY = [
  { role: 'user', content: 'look it up' },
  { role: 'assistant', content: '', tool_calls: normalised },
  { role: 'tool', name: 'card_get', tool_call_id: 'call_1', content: '{"ok":true}' },
];
const openaiOk = { status: 200, rawBody: '{}', body: { choices: [{ message: { content: 'done' }, finish_reason: 'stop' }], usage: {} } };
const ollamaOk = { status: 200, rawBody: '{}', body: { message: { content: 'done' }, done: true, done_reason: 'stop' } };

async function sent(agent, response) {
  const out = [];
  await callModel(agent, HISTORY, { transport: async (r) => { out.push(r); return response; } });
  return out[0].body.messages;
}

test('#1447 openai-completions sends tool_calls in the OpenAI wire shape', async () => {
  const msgs = await sent({ model: 'm', protocol: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1' }, openaiOk);
  assert.deepEqual(msgs[1].tool_calls, [{ id: 'call_1', type: 'function', function: { name: 'card_get', arguments: '{"id":"7"}' } }]);
  assert.deepEqual(msgs[2], HISTORY[2], 'tool results already travel in wire shape and are untouched');
});

test('#1447 ollama-native sends tool_calls with a function object and OBJECT arguments', async () => {
  const msgs = await sent({ model: 'm', protocol: 'ollama-native', baseUrl: 'http://localhost:11434' }, ollamaOk);
  assert.deepEqual(msgs[1].tool_calls, [{ id: 'call_1', type: 'function', function: { name: 'card_get', arguments: { id: '7' } } }]);
});

test('#1447 a tool call already in wire shape passes through unchanged', async () => {
  const wire = [{ id: 'c', type: 'function', function: { name: 'x', arguments: '{}' } }];
  const out = [];
  await callModel({ model: 'm', protocol: 'openai-completions', baseUrl: 'http://x' },
    [{ role: 'user', content: 'u' }, { role: 'assistant', content: '', tool_calls: wire }],
    { transport: async (r) => { out.push(r); return openaiOk; } });
  assert.deepEqual(out[0].body.messages[1].tool_calls, wire);
});

test('#1447 the caller\'s transcript is not mutated by serialisation', async () => {
  await sent({ model: 'm', protocol: 'openai-completions', baseUrl: 'http://x' }, openaiOk);
  assert.deepEqual(HISTORY[1].tool_calls, normalised);
});
