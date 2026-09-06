/**
 * #1196 slice A — THE TOOL CHANNEL.
 *
 * The board is graph-native and until now the colleague sitting on it could
 * not read the graph: the adapter shaped a request out of {model, messages,
 * sampling} and read a string back, so an agent's only actuator was a regex
 * over its own reply. A colleague that cannot look anything up produces claims
 * with no referent, and nothing downstream can check them.
 *
 * This is the transport only. It does not make answers better — a reader given
 * the right rows still narrated over them, measured on the frozen set. What it
 * buys is that a claim can arrive ATTACHED to the query and rows that produced
 * it, which is the difference between an unfalsifiable answer and a checkable
 * one.
 *
 * Shaping and reading are pure and tested as such; the seam is tested against
 * a fake server, because a protocol that works in a unit test and drops the
 * field on the wire is the failure this file exists to catch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { callModel, PROTOCOL_NAMES } from '../core/model-adapter.mjs';

const WEATHER_TOOL = {
  type: 'function',
  function: {
    name: 'card_get',
    description: 'Read one card by its short id.',
    parameters: { type: 'object', properties: { shortId: { type: 'number' } }, required: ['shortId'] },
  },
};

/** A fake model server: records what it was sent, replies with what it is told to. */
function fakeServer(reply) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ path: req.url, body: JSON.parse(raw || '{}') });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(typeof reply === 'function' ? reply(seen.length) : reply));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    seen, baseUrl: `http://127.0.0.1:${srv.address().port}`, stop: () => new Promise((r) => srv.close(r)),
  })));
}

test('#1196A ollama-native: tools reach the wire only when granted, and tool calls are read back', async () => {
  const srv = await fakeServer({
    model: 'fake',
    message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'card_get', arguments: { shortId: 1196 } } }] },
    done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 4,
  });
  try {
    const agent = { model: 'fake', protocol: 'ollama-native', baseUrl: srv.baseUrl };

    // Granted: the tools array is on the request body, verbatim.
    const withTools = await callModel(agent, [{ role: 'user', content: 'read card 1196' }], { tools: [WEATHER_TOOL] });
    assert.deepEqual(srv.seen[0].body.tools, [WEATHER_TOOL], 'tools must reach the wire unchanged');

    // Read back as STRUCTURE, not as text the caller has to parse out of a string.
    assert.equal(withTools.toolCalls.length, 1);
    assert.equal(withTools.toolCalls[0].name, 'card_get');
    assert.deepEqual(withTools.toolCalls[0].arguments, { shortId: 1196 });
    assert.equal(withTools.text, '', 'a tool-calling turn need not carry prose');

    // NOT granted: no tools key at all. An empty array is a different claim
    // from "this agent has no tools" and some servers treat it as one.
    await callModel(agent, [{ role: 'user', content: 'hello' }], {});
    assert.ok(!('tools' in srv.seen[1].body), `ungranted request must carry no tools key, got ${JSON.stringify(srv.seen[1].body.tools)}`);
  } finally { await srv.stop(); }
});

test('#1196A openai-completions: the same contract on the hosted shape', async () => {
  const srv = await fakeServer({
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'card_get', arguments: '{"shortId":650}' } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 8, completion_tokens: 3 },
  });
  try {
    const agent = { model: 'fake', protocol: 'openai-completions', baseUrl: srv.baseUrl };
    const out = await callModel(agent, [{ role: 'user', content: 'read card 650' }], { tools: [WEATHER_TOOL] });
    assert.deepEqual(srv.seen[0].body.tools, [WEATHER_TOOL]);
    assert.equal(out.stopReason, 'tool_calls');
    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0].name, 'card_get');
    // The hosted shape sends arguments as a JSON STRING. A caller must not have
    // to know which protocol it is talking to in order to read them.
    assert.deepEqual(out.toolCalls[0].arguments, { shortId: 650 });
  } finally { await srv.stop(); }
});

test('#1196A a reply with no tool calls reports an empty list, never undefined', async () => {
  const srv = await fakeServer({ model: 'fake', message: { role: 'assistant', content: 'no tools needed' }, done: true, done_reason: 'stop' });
  try {
    const out = await callModel({ model: 'fake', protocol: 'ollama-native', baseUrl: srv.baseUrl }, [{ role: 'user', content: 'hi' }], {});
    assert.deepEqual(out.toolCalls, [], 'absent tool calls are an empty list: a caller must not branch on undefined');
    assert.equal(out.text, 'no tools needed');
  } finally { await srv.stop(); }
});

test('#1196A malformed tool arguments are reported, never silently dropped', async () => {
  const srv = await fakeServer({
    choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'card_get', arguments: '{not json' } }] }, finish_reason: 'tool_calls' }],
  });
  try {
    const out = await callModel({ model: 'fake', protocol: 'openai-completions', baseUrl: srv.baseUrl }, [{ role: 'user', content: 'x' }], { tools: [WEATHER_TOOL] });
    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0].name, 'card_get');
    assert.equal(out.toolCalls[0].arguments, null, 'unparseable arguments are null');
    assert.match(String(out.toolCalls[0].argumentsError), /json|parse/i, 'and the reason is carried, because a dropped call reads as a call never made');
  } finally { await srv.stop(); }
});

test('#1196A every protocol name still resolves — the channel adds a field, it does not fork the adapter', () => {
  assert.ok(PROTOCOL_NAMES.includes('ollama-native'));
  assert.ok(PROTOCOL_NAMES.includes('openai-completions'));
  assert.ok(PROTOCOL_NAMES.includes('mlx'));
});

test('#1196A a refusal carries the PROVIDER\'S OWN WORDS in the message, not just the status', async () => {
  // Found live, not by reading: a tools-bearing request to a model without the
  // tools capability comes back 400 with a body that says exactly that. The
  // adapter reported "model provider refused (400): client error 400" and the
  // body — the entire diagnosis — was on a field nobody prints. The same class
  // was already closed once for the hosted no-such-id case; the fix belongs in
  // the error, so every protocol gets it at once rather than one at a time.
  const srv = await fakeServer(() => ({ error: 'registry.ollama.ai/library/gemma3:12b does not support tools' }));
  const bad = http.createServer((req, res) => {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'registry.ollama.ai/library/gemma3:12b does not support tools' }));
  });
  await new Promise((r) => bad.listen(0, '127.0.0.1', r));
  await srv.stop();
  try {
    const agent = { model: 'gemma-ish', protocol: 'ollama-native', baseUrl: `http://127.0.0.1:${bad.address().port}` };
    await assert.rejects(
      () => callModel(agent, [{ role: 'user', content: 'x' }], { tools: [WEATHER_TOOL], retries: 0 }),
      (e) => {
        assert.match(e.message, /does not support tools/, `the provider's own words must be IN the message; got: ${e.message}`);
        assert.equal(e.status, 400);
        return true;
      },
    );
  } finally { await new Promise((r) => bad.close(r)); }
});

test('#1196A a role can turn thinking OFF — the adapter\'s own advice was unreachable through the adapter', async () => {
  // The stopReason error tells a reader to "raise the token budget or turn
  // thinking off for this role". Nothing could turn it off: the adapter reads
  // `message.thinking` on the way back and sends no flag on the way out.
  // Measured on this host with a 9B thinking model answering "are you there?":
  //   thinking on, 800 tokens  → 70 s, all 800 spent reasoning, EMPTY reply
  //   thinking on, 2048 tokens → 112 s, 4524 characters of reasoning, "I'm here."
  //   thinking off, 800 tokens → 1.3 s, 11 tokens, "Yes, I'm here."
  // A conversational wake does not need the reasoning; a tool-using one may.
  // So it is a per-role choice, which is what `thinking: false` on the agent
  // now expresses — and absent stays absent, because sending think:true to a
  // model that has no such flag is a different request from not sending one.
  const srv = await fakeServer({ model: 'fake', message: { role: 'assistant', content: 'ok' }, done: true, done_reason: 'stop' });
  try {
    const base = { model: 'fake', protocol: 'ollama-native', baseUrl: srv.baseUrl };
    await callModel({ ...base, thinking: false }, [{ role: 'user', content: 'x' }], {});
    assert.equal(srv.seen[0].body.think, false, 'thinking:false must reach the wire as think:false');

    await callModel({ ...base, thinking: true }, [{ role: 'user', content: 'x' }], {});
    assert.equal(srv.seen[1].body.think, true, 'and thinking:true says so explicitly');

    await callModel(base, [{ role: 'user', content: 'x' }], {});
    assert.ok(!('think' in srv.seen[2].body), 'an agent that says nothing about thinking sends no flag at all');
  } finally { await srv.stop(); }
});
