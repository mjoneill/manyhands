/**
 * #1198 — THE MODEL ADAPTER.
 *
 * The direct manyhands-to-model path is the thing #1196 exists to build. These
 * tests drive all three protocols against a STUB, which is the point of the vendored transport indirection: the whole
 * adapter is exercised with no live model, no GPU, and no network.
 *
 * ⚠️ WHAT A STUB CANNOT TELL YOU, said here so nobody reads a green suite as
 * more than it is: these tests prove the adapter shapes requests, reads
 * responses, and applies its policy correctly. They do NOT prove that Ollama,
 * OpenRouter or MLX actually answer in the shapes asserted here. That is a live
 * check against a real provider and it belongs to #1203's acceptance run.
 * A stub agreeing with itself is one instrument, not two.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  callModel, courtesyUnload, classifyStatus, runawayBudget, approxTokens,
  RunawayGenerationError, ModelAssertionError, ModelRefusedError,
  RUNAWAY_RATIO, RUNAWAY_FLOOR_TOKENS, PROTOCOL_NAMES,
} from '../core/model-adapter.mjs';

const MSGS = [{ role: 'user', content: 'name one thing that would change your mind' }];

/** Capture what the adapter SENDS as well as what it does with the reply. */
function stub(responses) {
  const sent = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const transport = async (req) => {
    sent.push(req);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return typeof next === 'function' ? next(req) : next;
  };
  return { transport, sent };
}

const ollamaOk = (text = 'an answer', extra = {}) => ({
  status: 200,
  body: {
    message: { content: text }, done: true, done_reason: 'stop',
    prompt_eval_count: 12, eval_count: 5, ...extra,
  },
  rawBody: '{}',
});

const openaiOk = (text = 'an answer', extra = {}) => ({
  status: 200,
  body: {
    choices: [{ message: { content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 5, ...(extra.usage || {}) },
  },
  rawBody: '{}',
});

const mlxOk = (text = 'an answer') => ({
  status: 200,
  body: { text, stop_reason: 'stop', usage: { prompt_tokens: 12, completion_tokens: 5 } },
  rawBody: '{}',
});

// ── one call shape over three protocols ──────────────────────────────────────

test('#1198 all three protocols answer through ONE call shape', async () => {
  const cases = [
    ['ollama-native', ollamaOk('from ollama'), 'from ollama', '/api/chat'],
    ['openai-completions', openaiOk('from openrouter'), 'from openrouter', '/chat/completions'],
    ['mlx', mlxOk('from mlx'), 'from mlx', '/v1/generate'],
  ];
  for (const [protocol, response, expected, path] of cases) {
    const s = stub(response);
    const out = await callModel(
      { model: 'm', protocol, baseUrl: 'http://x' }, MSGS, { transport: s.transport },
    );
    assert.equal(out.text, expected, `${protocol} must return the text`);
    assert.equal(out.stopReason, 'stop');
    assert.equal(out.usage.completionTokens, 5, `${protocol} must report usage`);
    assert.ok(s.sent[0].url.endsWith(path), `${protocol} must post to ${path}`);
  }
  // Copy before sorting: PROTOCOL_NAMES is frozen, and `sort` mutates in place.
  assert.deepEqual([...PROTOCOL_NAMES].sort(), ['mlx', 'ollama-native', 'openai-completions']);
});

test('#1198 an unknown protocol is a NAMED refusal, not a crash', async () => {
  await assert.rejects(
    () => callModel({ model: 'm', protocol: 'telepathy' }, MSGS, { transport: stub(ollamaOk()).transport }),
    (e) => e instanceof ModelAssertionError && /telepathy/.test(e.message) && /ollama-native/.test(e.message),
  );
});

// ── sampling belongs to the ROLE, and a call may override one knob ───────────

test('#1198 sampling knobs reach the provider under ITS names', async () => {
  const s = stub(ollamaOk());
  await callModel(
    { model: 'm', protocol: 'ollama-native', baseUrl: 'http://x' },
    MSGS,
    { transport: s.transport, temperature: 0, seed: 42, topP: 0.9, topK: 40, repetitionPenalty: 1.1, stop: ['\n\n'] },
  );
  const o = s.sent[0].body.options;
  assert.equal(o.temperature, 0);
  assert.equal(o.seed, 42, 'seed is what makes #1203 an experiment rather than an anecdote');
  assert.equal(o.top_p, 0.9);
  assert.equal(o.top_k, 40);
  assert.equal(o.repeat_penalty, 1.1, 'our name is repetitionPenalty; Ollama calls it repeat_penalty');
  assert.deepEqual(o.stop, ['\n\n']);
});

test('#1198 the ROLE carries defaults and one call may override just one', async () => {
  const s = stub(ollamaOk());
  const judge = { model: 'm', protocol: 'ollama-native', baseUrl: 'http://x',
    sampling: { temperature: 0, seed: 7, topP: 0.5 } };
  await callModel(judge, MSGS, { transport: s.transport, temperature: 0.9 });
  const o = s.sent[0].body.options;
  assert.equal(o.temperature, 0.9, 'the call overrides');
  assert.equal(o.seed, 7, 'and the rest of the role survives — not restated, not lost');
  assert.equal(o.top_p, 0.5);
});

test('#1198 keep_alive is honoured — the GPU is shared with a neighbour process', async () => {
  const s = stub(ollamaOk());
  await callModel({ model: 'm', protocol: 'ollama-native', baseUrl: 'http://x' },
    MSGS, { transport: s.transport, keepAlive: 0 });
  assert.equal(s.sent[0].body.keep_alive, 0);
});

// ── the assertions, one test each ───────────────────────────────────────────

test('#1198 a `length` stop is a CONFIGURATION failure, never a returned answer', async () => {
  for (const [protocol, res] of [
    ['ollama-native', { status: 200, body: { message: { content: 'truncated mid-' }, done: true, done_reason: 'length' }, rawBody: '{}' }],
    ['openai-completions', { status: 200, body: { choices: [{ message: { content: 'truncated mid-' }, finish_reason: 'length' }] }, rawBody: '{}' }],
  ]) {
    await assert.rejects(
      () => callModel({ model: 'm', protocol, baseUrl: 'http://x' }, MSGS, { transport: stub(res).transport }),
      (e) => e instanceof ModelAssertionError && e.assertion === 'stopReason' && /truncated, not complete/.test(e.message),
      `${protocol}: a cut-off answer must not be handed back as an answer`,
    );
  }
});

test('#1198 empty text with a 200 is a NAMED failure — the soft-refusal shape', async () => {
  // Exactly the shape that cost an hour on #1221 the same afternoon: a provider
  // returning success and nothing. An empty answer and a failed call are
  // different facts and must never be indistinguishable to the caller.
  await assert.rejects(
    () => callModel({ model: 'm', protocol: 'ollama-native', baseUrl: 'http://x' },
      MSGS, { transport: stub(ollamaOk('   ')).transport }),
    (e) => e instanceof ModelAssertionError && e.assertion === 'nonEmpty',
  );
});

test('#1198 a thinking model reporting ZERO reasoning tokens is refused', async () => {
  const res = openaiOk('answered without thinking', {
    usage: { completion_tokens_details: { reasoning_tokens: 0 } },
  });
  await assert.rejects(
    () => callModel({ model: 'm', protocol: 'openai-completions', baseUrl: 'http://x', thinking: true },
      MSGS, { transport: stub(res).transport }),
    (e) => e instanceof ModelAssertionError && e.assertion === 'thinking',
  );
});

test('#1198 a NON-thinking model is not held to a reasoning budget', async () => {
  const res = openaiOk('fine', { usage: { completion_tokens_details: { reasoning_tokens: 0 } } });
  const out = await callModel({ model: 'm', protocol: 'openai-completions', baseUrl: 'http://x' },
    MSGS, { transport: stub(res).transport });
  assert.equal(out.text, 'fine', 'the assertion must be scoped to what the registry claims');
});

// ── the runaway budget ──────────────────────────────────────────────────────

test('#1198 the runaway budget is sized to THIS prompt, not to maxTokens', () => {
  assert.equal(runawayBudget(0), RUNAWAY_FLOOR_TOKENS, 'a tiny prompt still gets the floor');
  assert.equal(runawayBudget(10000), RUNAWAY_RATIO * 10000);
  assert.equal(runawayBudget(1e9), 32768, 'and it is capped');
  // ⭐ The reason the budget exists: maxTokens is sized for the largest
  // LEGITIMATE answer, so a repetition loop stays under it and runs to ~32,000
  // tokens (#58). The budget for a small prompt is an order of magnitude lower.
  assert.ok(runawayBudget(approxTokens('a short question')) < 32768 / 10);
});

test('#1198 ⭐ a synthetic repetition loop TRIPS the budget', async () => {
  // The #58 shape: out-of-distribution input, model loops, output grows without
  // ever hitting maxTokens. 9000 completion tokens against a ~10-token prompt.
  const loop = 'the answer is the answer is '.repeat(1200);
  const res = {
    status: 200,
    body: { message: { content: loop }, done: true, done_reason: 'stop',
      prompt_eval_count: 10, eval_count: 9000 },
    rawBody: '{}',
  };
  await assert.rejects(
    () => callModel({ model: 'm', protocol: 'ollama-native', baseUrl: 'http://x' },
      MSGS, { transport: stub(res).transport }),
    (e) => e instanceof RunawayGenerationError && e.produced === 9000
      && e.budget === RUNAWAY_FLOOR_TOKENS && /pathological, not merely large/.test(e.message),
  );
});

test('#1198 a runaway is a DIFFERENT error from a malformed answer', () => {
  // One recurs identically on retry; the other may not. Collapsing them would
  // make "retry this" and "never retry this" the same decision.
  const runaway = new RunawayGenerationError(9000, 2000, 10);
  assert.equal(runaway.code, 'RUNAWAY');
  assert.notEqual(runaway.code, new ModelAssertionError('x', 'y').code);
});

// ── retry policy, as data ───────────────────────────────────────────────────

test('#1198 the status policy can be READ without being executed', () => {
  assert.equal(classifyStatus(429).action, 'retry');
  assert.equal(classifyStatus(503).action, 'retry');
  assert.equal(classifyStatus(410).action, 'retire');
  assert.equal(classifyStatus(404).action, 'refuse');
  assert.equal(classifyStatus(401).action, 'refuse');
  assert.equal(classifyStatus(200).action, 'ok');
  assert.match(classifyStatus(404).reason, /WHICH/, 'two different 404s need two different fixes');
});

test('#1198 429 retries with backoff and then succeeds', async () => {
  const s = stub([{ status: 429, body: null, rawBody: 'slow down' }, ollamaOk('finally')]);
  const out = await callModel({ model: 'm', protocol: 'ollama-native', baseUrl: 'http://x' },
    MSGS, { transport: s.transport, backoffMs: 0 });
  assert.equal(out.text, 'finally');
  assert.equal(out.attempts, 2);
});

test('#1198 429 forever gives up and STILL carries the body', async () => {
  const s = stub({ status: 429, body: null, rawBody: 'rate limited: try again in 60s' });
  await assert.rejects(
    () => callModel({ model: 'm', protocol: 'ollama-native', baseUrl: 'http://x' },
      MSGS, { transport: s.transport, retries: 2, backoffMs: 0 }),
    (e) => e instanceof ModelRefusedError && e.status === 429 && /try again in 60s/.test(e.body),
  );
});

test('#1198 ⛔ 410 RETIRES the model instead of retrying it forever', async () => {
  // #838/#840: a dead provider returned 410 thirteen times with a dated
  // end-of-life notice in the body, and the retry logic consumed it as 429 Busy.
  // Nobody read the body because nothing kept it.
  const eol = 'This model was retired on 2026-06-30. Use gemma4:26b.';
  const s = stub({ status: 410, body: null, rawBody: eol });
  await assert.rejects(
    () => callModel({ model: 'dead-model', protocol: 'openai-completions', baseUrl: 'http://x' },
      MSGS, { transport: s.transport, backoffMs: 0 }),
    (e) => e instanceof ModelRefusedError && e.retire === 'dead-model' && e.body === eol,
  );
  assert.equal(s.sent.length, 1, 'a 410 must be asked EXACTLY ONCE — retrying it is the #838 defect');
});

test('#1198 401 names the key REFERENCE and never the key', async () => {
  const s = stub({ status: 401, body: null, rawBody: 'invalid api key' });
  await assert.rejects(
    () => callModel(
      { model: 'm', protocol: 'openai-completions', baseUrl: 'http://x', apiKeyRef: 'env:OPENROUTER_KEY' },
      MSGS, { transport: s.transport, apiKey: 'sk-secret-value-do-not-log' },
    ),
    (e) => {
      assert.ok(e instanceof ModelRefusedError && e.status === 401);
      assert.equal(e.apiKeyRef, 'env:OPENROUTER_KEY');
      const dump = JSON.stringify({ msg: e.message, ref: e.apiKeyRef, body: e.body });
      assert.ok(!dump.includes('sk-secret-value-do-not-log'),
        'a refusal is a place a secret goes to live forever — carry the REFERENCE');
      return true;
    },
  );
});

test('#1198 5xx retries, and the body survives the last one', async () => {
  const s = stub({ status: 500, body: null, rawBody: 'upstream exploded' });
  await assert.rejects(
    () => callModel({ model: 'm', protocol: 'mlx', baseUrl: 'http://x' },
      MSGS, { transport: s.transport, retries: 1, backoffMs: 0 }),
    (e) => e instanceof ModelRefusedError && /upstream exploded/.test(e.body),
  );
  assert.equal(s.sent.length, 2, 'one try plus one retry');
});

// ── courtesy unload ─────────────────────────────────────────────────────────

test('#1198 courtesyUnload asks Ollama to drop the model, and never throws', async () => {
  const s = stub({ status: 200, body: {}, rawBody: '{}' });
  const r = await courtesyUnload({ model: 'm', protocol: 'ollama-native', baseUrl: 'http://x' },
    { transport: s.transport });
  assert.equal(r.unloaded, true);
  assert.equal(s.sent[0].body.keep_alive, 0);

  // Best-effort BY DESIGN: failing to be polite to a neighbour must never fail
  // the work that already succeeded.
  const boom = await courtesyUnload({ model: 'm', protocol: 'ollama-native', baseUrl: 'http://x' },
    { transport: async () => { throw new Error('connection refused'); } });
  assert.equal(boom.unloaded, false);
  assert.match(boom.reason, /connection refused/);

  const notOllama = await courtesyUnload({ model: 'm', protocol: 'openai-completions' }, {});
  assert.equal(notOllama.unloaded, false, 'and it is a no-op for a hosted model');
});

// ── what the first live call taught this file ───────────────────────────────

test('#1198 a thinking model that burns its whole budget reasoning says SO', async () => {
  // ⭐ NOT INVENTED. This is the shape of the FIRST live call this adapter ever
  // made, against qwen3.5-fast on local Ollama: 300 permitted tokens, all of
  // them spent in `message.thinking`, `content: ""`, `done_reason: "length"`.
  // Reading only `content` reports "the model returned nothing", which is true
  // and useless — it returned 300 tokens, none of them for us. And the fix for
  // this ("raise the budget / turn thinking off") is the opposite of the fix
  // for a mid-sentence truncation, so one message for both sends half of all
  // readers the wrong way.
  const res = {
    status: 200,
    body: {
      message: { role: 'assistant', content: '', thinking: 'Let me consider what a kanban board '.repeat(30) },
      done: true, done_reason: 'length', prompt_eval_count: 18, eval_count: 300,
    },
    rawBody: '{}',
  };
  await assert.rejects(
    () => callModel({ model: 'qwen3.5-fast:latest', protocol: 'ollama-native', baseUrl: 'http://x' },
      MSGS, { transport: stub(res).transport }),
    (e) => {
      assert.ok(e instanceof ModelAssertionError && e.assertion === 'stopReason');
      assert.equal(e.producedNothing, true);
      assert.equal(e.reasoned, true);
      assert.match(e.message, /never started/,
        'the reader must be sent to the budget, not to a hunt for truncated text');
      return true;
    },
  );
});

test('#1198 a truncated answer WITH text is reported differently, and carries the excerpt', async () => {
  const res = {
    status: 200,
    body: { message: { content: 'A kanban board exists to make work visible so that' },
      done: true, done_reason: 'length', eval_count: 300 },
    rawBody: '{}',
  };
  await assert.rejects(
    () => callModel({ model: 'm', protocol: 'ollama-native', baseUrl: 'http://x' },
      MSGS, { transport: stub(res).transport }),
    (e) => {
      assert.equal(e.producedNothing, false);
      assert.match(e.message, /truncated, not complete/);
      assert.match(e.excerpt, /make work visible/,
        'a truncated answer is evidence — carry it rather than making the caller re-run the call');
      return true;
    },
  );
});

test('#1198 Ollama reasoning is counted, so `thinking: true` is a claim something checks', async () => {
  const res = {
    status: 200,
    body: { message: { content: 'a real answer', thinking: 'some reasoning here' },
      done: true, done_reason: 'stop', eval_count: 5 },
    rawBody: '{}',
  };
  const out = await callModel({ model: 'm', protocol: 'ollama-native', baseUrl: 'http://x', thinking: true },
    MSGS, { transport: stub(res).transport });
  assert.equal(out.text, 'a real answer');
  assert.ok(out.usage.reasoningTokens > 0,
    'before this, the thinking assertion could never be satisfied for an Ollama model — '
    + 'a guard that cannot pass is as useless as one that cannot fail');
});
