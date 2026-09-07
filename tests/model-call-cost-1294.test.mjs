/**
 * #1294 — THE DAILY BUDGET CAP COULD NOT FIRE.
 *
 * Measured 2026-09-07 from two instruments that disagreed:
 *
 *     OpenRouter, past 48h    $2.05 · 429 requests · 5.82M tokens
 *     the board's ledger      145 model-call rows for that seat
 *                               rows with cost > 0        0
 *                               rows with tokensIn set    0
 *
 * `budgetCheck` (core/guest-loop.mjs) is correct in every line — it halts when
 * `calls >= 1 && spent >= budget`, refuses to run when the ledger is
 * unreadable, and posts a notice. It is fed `spentToday()`, which sums the
 * `cost` on these rows. `0 >= 2` is never true, so the halt could not trigger.
 *
 * ⛔ THE CAUSE, and it is one line of omission: `modelSpecOf` materialises a
 * registered model's `maxOutputTokens`, `timeoutMs` and `thinking` onto the
 * agent — and NOT `costIn`/`costOut`. The runner's `rowToBoard` computes cost
 * from `agent.model.costIn`, which is therefore always undefined, so the
 * ternary can only take its `: 0` branch. The rates were registered correctly
 * on the Model entity the whole time; nothing carried them to the calculation.
 *
 * ⇒ SO THE REGISTRY PRICES THE CALL SERVER-SIDE, WHERE IT CAN. Reasons, and
 * the third is the one that decides it:
 *   - it works for agents ALREADY BOUND, with no re-bind and no migration
 *   - the registry stays the single authority on price, so a rate change is
 *     live rather than materialised into every seat at bind time (a stale
 *     materialised PRICE under-bills silently, which is this defect again)
 *   - #534 set the precedent in this same file: `version` is server-computed,
 *     never accepted, because a value the caller controls cannot gate anything.
 *     A budget the caller can zero out is not a budget.
 *
 * ⚠️ AND "NEVER ACCEPTED" WAS TOO STRONG — my first version, caught by #1202's
 * own tests. They post an UNREGISTERED model with a cost the caller measured,
 * and zeroing those rows would throw away the only measurement anyone has. The
 * rule that survives is narrower: THE REGISTRY WINS WHERE IT CAN PRICE, and it
 * does not override what it cannot compute. The seat this card is about is
 * registered, so the half that matters for the budget is unaffected.
 *
 * ⚠️ AND THE CONDITION THAT SHAPED THESE TESTS is the affected seat's own:
 * "a free model's zero must be distinguishable from a dropped one. An
 * unmeasured zero isn't a value — it's a gap wearing a number."
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer } from './helpers/harness.mjs';

const j = (r) => r.json();
const post = (base, p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const PAID = { key: 'paid-engine', model: 'vendor/paid-model', provider: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1', protocol: 'openai-completions',
  apiKeyRef: 'OPENROUTER_API_KEY', maxOutputTokens: 4096,
  costIn: 0.000001, costOut: 0.000002, by: 'ada' };

const FREE = { key: 'free-engine', model: 'local/free-model', provider: 'ollama',
  baseUrl: 'http://localhost:11434', protocol: 'ollama-native',
  maxOutputTokens: 4096, costIn: 0, costOut: 0, freeTier: true, by: 'ada' };

async function withServer(fn) {
  const s = await startRestServer({});
  try { return await fn(s); } finally { await s.stop(); }
}

async function registerModels(base) {
  for (const m of [PAID, FREE]) {
    const r = await post(base, '/api/models', m);
    const raw = await r.text();
    assert.equal(r.status, 201, raw);
  }
}

const row = (over = {}) => ({
  by: 'ada', agent: 'ada', model: PAID.model, provider: PAID.baseUrl,
  protocol: 'openai-completions', tokensIn: 1000, tokensOut: 500,
  latencyMs: 100, ok: true, at: new Date().toISOString(), ...over,
});

const recordCall = async (base, body) => {
  const r = await post(base, '/api/model-calls', body);
  const raw = await r.text();
  assert.equal(r.status, 201, raw);
  return JSON.parse(raw);
};

test('#1294 ⭐ a PAID model with tokens records a NON-ZERO cost from the registry', async () => {
  await withServer(async (s) => {
    await registerModels(s.baseUrl);
    const out = await recordCall(s.baseUrl, row());
    // 1000 * 1e-6 + 500 * 2e-6 = 0.002
    assert.ok(out.cost > 0, `cost must be > 0, got ${out.cost}`);
    assert.ok(Math.abs(out.cost - 0.002) < 1e-9, `expected 0.002, got ${out.cost}`);
  });
});

test('#1294 ⛔ NEGATIVE CONTROL — a FREE model still records 0, and that 0 is CORRECT', async () => {
  // The affected seat's own condition. A fix that made every seat look
  // expensive would trade an inert cap for a false one, and would halt the
  // local ollama seat that costs nothing.
  await withServer(async (s) => {
    await registerModels(s.baseUrl);
    const out = await recordCall(s.baseUrl, row({ model: FREE.model, provider: FREE.baseUrl, protocol: 'ollama-native' }));
    assert.equal(out.cost, 0, 'a free model costs zero');
  });
});

test('#1294 ⛔ AN UNMEASURED ZERO IS NOT A MEASURED ZERO — a row with NO tokens says so', async () => {
  // "An unmeasured zero isn't a value — it's a gap wearing a number."
  // A cost of 0 because the model is free and a cost of 0 because usage was
  // dropped were indistinguishable, and that is what hid this across 145 rows.
  await withServer(async (s) => {
    await registerModels(s.baseUrl);
    const measured = await recordCall(s.baseUrl, row({ model: FREE.model, protocol: 'ollama-native' }));
    const unmeasured = await recordCall(s.baseUrl, row({ tokensIn: null, tokensOut: null }));

    assert.equal(measured.cost, 0);
    assert.equal(measured.costMeasured, true, 'a free model with tokens IS measured, and costs 0');
    assert.equal(unmeasured.costMeasured, false,
      'a row with no usage must NOT claim its zero is a measurement');
  });
});

test('#1294 — for a REGISTERED model the caller cannot set cost; the registry decides', async () => {
  // #534's rule applied to money: a value the caller controls cannot gate
  // anything. A runner sending cost: 0 must not zero out a paid call.
  // ⚠️ Scoped to REGISTERED models on purpose: #1202 posts unregistered rows
  // with a cost the caller measured, and refusing that number would throw away
  // the only measurement anyone has. See the unregistered test below.
  await withServer(async (s) => {
    await registerModels(s.baseUrl);
    const out = await recordCall(s.baseUrl, row({ cost: 0 }));
    assert.ok(out.cost > 0, `a caller-supplied 0 must not override the registry, got ${out.cost}`);

    const inflated = await recordCall(s.baseUrl, row({ cost: 999 }));
    assert.ok(inflated.cost < 1, `nor a caller-supplied 999, got ${inflated.cost}`);
  });
});

test('#1294 — a model that is NOT registered records an unmeasured cost, not a wrong one', async () => {
  // Guessing a rate for an unknown model would be worse than admitting the gap.
  await withServer(async (s) => {
    await registerModels(s.baseUrl);
    const out = await recordCall(s.baseUrl, row({ model: 'vendor/never-registered' }));
    assert.equal(out.cost, 0);
    assert.equal(out.costMeasured, false, 'an unregistered model with no declared cost cannot be priced, and says so');

    // …but a cost the CALLER measured is kept, because nobody else can supply it.
    const declared = await recordCall(s.baseUrl, row({ model: 'vendor/never-registered', cost: 0.0025 }));
    assert.ok(Math.abs(declared.cost - 0.0025) < 1e-9, `a declared cost on an unpriceable model is kept, got ${declared.cost}`);
    assert.equal(declared.costMeasured, true, 'and it counts as measured — it just was not measured HERE');
  });
});

test('#1294 ⭐ THE BUDGET CAN NOW FIRE — spend accumulates and crosses a threshold', async () => {
  // The whole point. `budgetCheck` halts on `spent >= budget`; before this,
  // spent was structurally 0 and the comparison could never be true.
  await withServer(async (s) => {
    await registerModels(s.baseUrl);
    for (let i = 0; i < 3; i++) await recordCall(s.baseUrl, row());

    const since = new Date(Date.now() - 3600_000).toISOString();
    const rows = await j(await fetch(`${s.baseUrl}/api/model-calls?agent=ada&since=${since}`));
    const list = Array.isArray(rows) ? rows : (rows.modelCalls ?? rows.calls ?? []);
    const spent = list.reduce((a, r) => a + (Number(r.cost) || 0), 0);

    assert.ok(spent > 0, `spend must accumulate, got ${spent}`);
    assert.ok(spent >= 0.006 - 1e-9, `three calls at 0.002 should be >= 0.006, got ${spent}`);
    // And the comparison the gate makes is now capable of being true.
    assert.equal(spent >= 0.005, true, 'a budget below the accrued spend would now halt');
  });
});
