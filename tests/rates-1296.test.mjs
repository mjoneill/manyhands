/**
 * #1296 slice 2 — A TWO-TERM MODEL OF A FOUR-TERM BILL.
 *
 * The vendor bills prompt, completion, reasoning, and the cached portion of the
 * prompt at its own reduced rate. `costIn`/`costOut` model two of the four.
 *
 * ⛔ THAT IS NOT AN INACCURATE NUMBER. IT IS A NUMBER THAT CANNOT BECOME
 * ACCURATE — and the gap was measured on our own rows on 2026-09-07:
 *
 *     ledger's own recorded cost                       $0.02421
 *     the same rows at the vendor's published rates    $0.04240
 *     ⇒ 1.75x under, with cached tokens billed at FULL price
 *
 * ⭐ THE CATEGORY SET IS OPEN, which the card requires: carry whatever
 * categories arrive rather than hardcoding these four. A second provider may
 * split differently, and a hardcoded schema drops
 * the category it has never seen — silently, which is the failure mode this
 * whole card is about.
 *
 * ⛔ AND AN UNPRICED CATEGORY IS NOT PRICED AT ZERO. It is omitted and NAMED as
 * omitted, in `costCategories`. A cost that silently drops a term is
 * indistinguishable from one where the term is free, and only one is a fact.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const api = async (base, method, path, body) => {
  const r = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// The affected seat's real shape: $0.140/M prompt, $0.280/M completion and
// reasoning, $0.028/M for a cache read — expressed per TOKEN, as the field is.
const FOUR_TERM = {
  key: 'four-term', model: 'vendor/four-term', provider: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1', protocol: 'openai-completions',
  apiKeyRef: 'OPENROUTER_API_KEY', maxOutputTokens: 4096, by: 'ada',
  rates: { prompt: 0.000000140, completion: 0.000000280, reasoning: 0.000000280, cachedPrompt: 0.000000028 },
};

const ROW = {
  by: 'ada', agent: 'gizmo', model: 'vendor/four-term', protocol: 'openai-completions',
  ok: true, at: '2026-09-07T22:00:00.000Z',
  tokensIn: 10000, tokensOut: 1000, reasoningTokens: 600, cachedPromptTokens: 8000,
};

async function withServer(fn) {
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try { return await fn(s); } finally { await s.stop(); }
}

test('#1296 ⭐ ALL FOUR TERMS are billed, and the cached portion at its OWN rate', async () => {
  await withServer(async (s) => {
    assert.equal((await api(s.baseUrl, 'POST', '/api/models', FOUR_TERM)).status, 201);
    const out = await api(s.baseUrl, 'POST', '/api/model-calls', ROW);
    assert.equal(out.status, 201, JSON.stringify(out.body));

    //  uncached prompt   (10000 - 8000) * 1.40e-7 = 0.00028
    //  cached prompt              8000 * 2.80e-8 = 0.000224
    //  completion                 1000 * 2.80e-7 = 0.00028
    //  reasoning                   600 * 2.80e-7 = 0.000168
    const expected = 2000 * 0.000000140 + 8000 * 0.000000028 + 1000 * 0.000000280 + 600 * 0.000000280;
    assert.ok(Math.abs(out.body.cost - expected) < 1e-12,
      `expected ${expected}, got ${out.body.cost}`);
    assert.deepEqual(out.body.costCategories, ['cachedPrompt', 'completion', 'prompt', 'reasoning'],
      'the row must say WHICH terms the number is made of');

    // ⭐ AND THE POINT: the old two-term arithmetic is materially different.
    const twoTerm = 10000 * 0.000000140 + 1000 * 0.000000280;
    assert.ok(out.body.cost !== twoTerm,
      'a four-term bill priced with two terms must not coincidentally agree');
  });
});

test('#1296 ⛔ CACHED TOKENS ARE A SUBSET, NOT AN EXTRA — the prompt term is the REMAINDER', async () => {
  // The error that would look almost right: billing 10,000 prompt tokens AND
  // 8,000 cached ones bills 18,000 tokens for a 10,000-token prompt. The cache
  // would then make calls look MORE expensive, which is the opposite of the
  // lever this card exists to measure.
  await withServer(async (s) => {
    assert.equal((await api(s.baseUrl, 'POST', '/api/models', FOUR_TERM)).status, 201);
    const cached = await api(s.baseUrl, 'POST', '/api/model-calls', ROW);
    const uncached = await api(s.baseUrl, 'POST', '/api/model-calls', { ...ROW, agent: 'nocache', cachedPromptTokens: 0 });
    assert.equal(uncached.status, 201, JSON.stringify(uncached.body));

    assert.ok(cached.body.cost < uncached.body.cost,
      `a cache HIT must cost LESS than the same call with no cache — got ${cached.body.cost} vs ${uncached.body.cost}`);
    // and the saving is exactly the discount on the cached portion
    const saving = uncached.body.cost - cached.body.cost;
    assert.ok(Math.abs(saving - 8000 * (0.000000140 - 0.000000028)) < 1e-12,
      `the saving must be the cached tokens at the DIFFERENCE of the two rates; got ${saving}`);
  });
});

test('#1296 ⛔ A CATEGORY WITH NO REGISTERED RATE IS OMITTED AND NAMED, never priced at 0', async () => {
  // #1294's rule one level up. A model registered with no reasoning rate must
  // not report a cost that silently excludes reasoning while looking complete.
  await withServer(async (s) => {
    assert.equal((await api(s.baseUrl, 'POST', '/api/models', {
      ...FOUR_TERM, key: 'no-reasoning-rate', model: 'vendor/no-reasoning-rate',
      rates: { prompt: 0.000000140, completion: 0.000000280 },
    })).status, 201);
    const out = await api(s.baseUrl, 'POST', '/api/model-calls', { ...ROW, model: 'vendor/no-reasoning-rate' });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.deepEqual(out.body.costCategories, ['completion', 'prompt'],
      'reasoning was NOT priced and the row must say so — an omitted term and a free term are different facts');
    assert.ok(!out.body.costCategories.includes('cachedPrompt'));
    // with no cachedPrompt rate the cached tokens stay ORDINARY prompt tokens
    const expected = 10000 * 0.000000140 + 1000 * 0.000000280;
    assert.ok(Math.abs(out.body.cost - expected) < 1e-12,
      `without a cachedPrompt rate the whole prompt bills at the prompt rate; expected ${expected}, got ${out.body.cost}`);
  });
});

test('#1296 ⭐ AN UNKNOWN CATEGORY IS HONOURED, not dropped — the set is open', async () => {
  // The card's condition: a second provider may split differently. A rate under a
  // name this code has never heard of must not be silently ignored... and must
  // also not be invented into a cost when no tokens for it were reported.
  await withServer(async (s) => {
    assert.equal((await api(s.baseUrl, 'POST', '/api/models', {
      ...FOUR_TERM, key: 'exotic', model: 'vendor/exotic',
      rates: { prompt: 0.000000140, completion: 0.000000280, imageTiles: 0.001 },
    })).status, 201);
    const reg = await api(s.baseUrl, 'GET', '/api/models');
    const m = (reg.body.models || reg.body).find((x) => x.key === 'exotic');
    assert.equal(m.rates.imageTiles, 0.001,
      'the registry must STORE a category it does not recognise — dropping it is how a provider change becomes invisible');

    const out = await api(s.baseUrl, 'POST', '/api/model-calls', { ...ROW, model: 'vendor/exotic' });
    assert.ok(!out.body.costCategories.includes('imageTiles'),
      'but a rate with no tokens on the row contributes nothing and is not claimed as priced');
  });
});

test('#1296 ⛔ NEGATIVE CONTROL — a FREE local model still prices to exactly 0', async () => {
  // Acceptance 4, verbatim: "a four-term model must not make the zero-term case
  // fail." The local ollama seat costs nothing and must keep running.
  await withServer(async (s) => {
    assert.equal((await api(s.baseUrl, 'POST', '/api/models', {
      key: 'free-engine', model: 'local/free-model', provider: 'ollama',
      baseUrl: 'http://localhost:11434', protocol: 'ollama-native',
      maxOutputTokens: 4096, costIn: 0, costOut: 0, freeTier: true, by: 'ada',
    })).status, 201);
    const out = await api(s.baseUrl, 'POST', '/api/model-calls', {
      ...ROW, model: 'local/free-model', protocol: 'ollama-native',
      reasoningTokens: null, cachedPromptTokens: null,
    });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(out.body.cost, 0, 'a free model costs zero');
    assert.equal(out.body.costMeasured, true, 'and that zero is MEASURED, not a gap wearing a number');
    assert.deepEqual(out.body.costCategories, ['completion', 'prompt']);
  });
});

test('#1296 ⛔ BACKWARDS COMPATIBILITY — a model with only costIn/costOut prices EXACTLY as before', async () => {
  // Every model registered before this change must be unaffected. #1202's tests
  // depend on it, and a silent repricing of the existing corpus would be a
  // worse defect than the one being fixed.
  await withServer(async (s) => {
    assert.equal((await api(s.baseUrl, 'POST', '/api/models', {
      key: 'legacy', model: 'vendor/legacy', provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1', protocol: 'openai-completions',
      apiKeyRef: 'OPENROUTER_API_KEY', maxOutputTokens: 4096,
      costIn: 0.000001, costOut: 0.000002, by: 'ada',
    })).status, 201);
    const out = await api(s.baseUrl, 'POST', '/api/model-calls', {
      by: 'ada', agent: 'gizmo', model: 'vendor/legacy', protocol: 'openai-completions',
      ok: true, at: ROW.at, tokensIn: 1000, tokensOut: 500,
    });
    assert.ok(Math.abs(out.body.cost - 0.002) < 1e-12, `expected 0.002 exactly as before, got ${out.body.cost}`);
    assert.deepEqual(out.body.costCategories, ['completion', 'prompt'],
      'costIn/costOut ARE the prompt and completion rates under their old names');
  });
});

test('#1296 the rate table and the cost terms are QUERYABLE from the graph', async () => {
  await withServer(async (s) => {
    assert.equal((await api(s.baseUrl, 'POST', '/api/models', FOUR_TERM)).status, 201);
    assert.equal((await api(s.baseUrl, 'POST', '/api/model-calls', ROW)).status, 201);

    const q = await api(s.baseUrl, 'POST', '/api/graph', {
      query: 'SELECT ?c ?term WHERE { ?c a scrum:ModelCall ; scrum:costCategories ?term . }', by: 'ada',
    });
    assert.equal(q.status, 200, `the query must run: ${JSON.stringify(q.body).slice(0, 300)}`);
    const terms = (q.body.rows || q.body.bindings || []).map((r) => String(r.term?.value ?? r.term)).sort();
    assert.deepEqual(terms, ['cachedPrompt', 'completion', 'prompt', 'reasoning'],
      'a reader can filter for rows priced WITHOUT a reasoning term, which a bare cost cannot answer');

    const qm = await api(s.baseUrl, 'POST', '/api/graph', {
      query: 'SELECT ?m ?rates WHERE { ?m a scrum:Model ; scrum:rates ?rates . }', by: 'ada',
    });
    assert.equal(qm.status, 200, `the model query must run: ${JSON.stringify(qm.body).slice(0, 300)}`);
    const rows = qm.body.rows || qm.body.bindings || [];
    assert.equal(rows.length, 1, 'the rate table reaches the graph');
    assert.equal(JSON.parse(String(rows[0].rates?.value ?? rows[0].rates)).cachedPrompt, 0.000000028);
  });
});

test('#1296 ⛔ a malformed rate is REFUSED BY NAME, not coerced', async () => {
  await withServer(async (s) => {
    for (const [rates, expect] of [
      [{ prompt: -1 }, /non-negative/],
      [{ prompt: 'cheap' }, /non-negative/],
      [{ 'prompt tokens': 1 }, /alphanumeric/],
      [[0.1], /must be an object/],
    ]) {
      const r = await api(s.baseUrl, 'POST', '/api/models', { ...FOUR_TERM, key: `bad-${Math.random().toString(36).slice(2)}`, rates });
      assert.equal(r.status, 400, `must refuse ${JSON.stringify(rates)}, got ${r.status}`);
      assert.match(String(r.body.error), expect);
    }
  });
});
