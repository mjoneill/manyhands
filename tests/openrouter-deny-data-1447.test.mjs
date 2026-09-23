/**
 * #1447 — a request to OpenRouter carries its OWN data policy.
 *
 * OpenRouter's "no providers that retain or train on prompts" protection is an
 * account toggle, and an account toggle serves whoever last needed it (it was
 * turned off to evaluate a model). The room's traffic should not inherit that.
 * `provider.data_collection: "deny"` travels with every request to an
 * openrouter.ai host, and with nothing else: the field is OpenRouter's, and
 * another OpenAI-shaped host may reject a parameter it does not know.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callModel } from '../core/model-adapter.mjs';

const MSGS = [{ role: 'user', content: 'hello' }];
const ok = { status: 200, rawBody: '{}', body: { choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } } };
const ollamaOk = { status: 200, rawBody: '{}', body: { message: { content: 'hi' }, done: true, done_reason: 'stop' } };

async function sentBody(agent, response = ok, opts = {}) {
  const sent = [];
  await callModel(agent, MSGS, { transport: async (r) => { sent.push(r); return response; }, ...opts });
  return sent[0].body;
}

test('#1447 an OpenRouter request denies data collection', async () => {
  // The registry's own shape for the OpenRouter resident.
  const body = await sentBody({ model: 'deepseek/deepseek-v4-flash-0731', protocol: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1' });
  assert.deepEqual(body.provider, { data_collection: 'deny' });
});

test('#1447 the flag rides a tool-bearing call too (the resident loop is tool calls)', async () => {
  const tools = [{ type: 'function', function: { name: 'board_search', parameters: { type: 'object' } } }];
  const body = await sentBody({ model: 'm', protocol: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1/' }, ok, { tools });
  assert.equal(body.provider?.data_collection, 'deny');
  assert.ok(Array.isArray(body.tools) && body.tools.length === 1);
});

test('#1447 other OpenAI-shaped hosts get no provider field', async () => {
  for (const baseUrl of ['https://api.openai.com/v1', 'http://localhost:8080/v1', 'https://evil.example/openrouter.ai/v1', 'https://openrouter.ai.evil.example/v1']) {
    const body = await sentBody({ model: 'm', protocol: 'openai-completions', baseUrl });
    assert.equal('provider' in body, false, baseUrl);
  }
});

test('#1447 a local Ollama call is untouched', async () => {
  const body = await sentBody({ model: 'qwen3.5:9b', protocol: 'ollama-native', baseUrl: 'http://localhost:11434' }, ollamaOk);
  assert.equal('provider' in body, false);
});
