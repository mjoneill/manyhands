/**
 * #1294 slice 2 — THE TOOL LOOP DISCARDED EVERY HOP'S USAGE.
 *
 * Slice 1 made the registry price a call server-side, and the cap still could
 * not fire, because the rows carried no tokens to price. This is why:
 *
 *     core/tool-loop.mjs   return { text, hops, modelCalls, stoppedBecause, messages }
 *     the string "usage"   appears ZERO times in that file
 *
 * `callModel` returns usage on every hop and `runToolLoop` drops all of it. The
 * guest loop then records `usage: result.usage ?? null` from the loop's return
 * — always undefined — so tokensIn/tokensOut are null, cost prices to 0, and
 * `spent >= budget` is never true.
 *
 * ⭐ IT ALSO EXPLAINS THE ASYMMETRY that made this findable: the search reader
 * calls `callModel` DIRECTLY and its rows carry tokens correctly (3,780 in /
 * 7,492 out on a live row). The seat that spends money goes through the tool
 * loop and records nothing. One adapter, two callers, opposite outcomes.
 *
 * ⚠️ AND THE SUM IS THE POINT, not a nicety. One wake is N model calls —
 * measured at ~3 paid requests per wake against maxHops: 8. A loop that
 * reported only the LAST hop's usage would under-bill by roughly the factor
 * that makes this expensive, and would look correct in a single-hop test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runToolLoop } from '../core/tool-loop.mjs';

const AGENT = { seatKey: 'ada', model: { model: 'm', protocol: 'openai-completions' } };
const TOOLS = [{ name: 'card_get' }];

/** A callModel stub that answers with tool calls for `hops` turns, then text. */
function stubModel(turns) {
  let i = 0;
  return async () => {
    const t = turns[Math.min(i, turns.length - 1)];
    i += 1;
    return t;
  };
}

const withTool = (usage) => ({ text: '', toolCalls: [{ id: 't1', name: 'card_get', arguments: { id: 1 } }], usage });
const done = (usage) => ({ text: 'the answer', toolCalls: [], usage });

test('#1294 ⭐ usage is RETURNED at all — a single-hop loop reports what the call used', async () => {
  const out = await runToolLoop({
    agent: AGENT, messages: [], tools: TOOLS, execute: async () => 'ok',
    callModel: stubModel([done({ promptTokens: 100, completionTokens: 20 })]),
  });
  assert.ok(out.usage, 'runToolLoop must return usage');
  assert.equal(out.usage.promptTokens, 100);
  assert.equal(out.usage.completionTokens, 20);
});

test('#1294 ⭐ THE SUM — usage across ALL hops, not just the last', async () => {
  // The defect this catches is under-billing by exactly the multiplier that
  // makes the tool loop expensive. A loop returning only the final call's
  // usage passes the single-hop test above and is wrong in production.
  const out = await runToolLoop({
    agent: AGENT, messages: [], tools: TOOLS, execute: async () => 'ok',
    callModel: stubModel([
      withTool({ promptTokens: 1000, completionTokens: 50 }),
      withTool({ promptTokens: 1200, completionTokens: 60 }),
      done({ promptTokens: 1400, completionTokens: 30 }),
    ]),
  });
  assert.equal(out.modelCalls, 3, 'three model calls happened');
  assert.equal(out.usage.promptTokens, 3600, 'prompt tokens are summed across hops');
  assert.equal(out.usage.completionTokens, 140, 'and so are completion tokens');
});

test('#1294 — a hop that reports NO usage does not poison the sum', async () => {
  // An adapter that omits usage on one turn must not make the whole wake
  // unmeasurable; the other hops are still real spend.
  const out = await runToolLoop({
    agent: AGENT, messages: [], tools: TOOLS, execute: async () => 'ok',
    callModel: stubModel([
      withTool({ promptTokens: 500, completionTokens: 10 }),
      withTool(undefined),
      done({ promptTokens: 300, completionTokens: 5 }),
    ]),
  });
  assert.equal(out.usage.promptTokens, 800);
  assert.equal(out.usage.completionTokens, 15);
});

test('#1294 ⛔ NO usage anywhere ⇒ usage is NULL, not a zero', async () => {
  // "An unmeasured zero isn't a value — it's a gap wearing a number."
  // Returning {promptTokens: 0} here would price the wake as free and be
  // indistinguishable from a genuinely free call.
  const out = await runToolLoop({
    agent: AGENT, messages: [], tools: TOOLS, execute: async () => 'ok',
    callModel: stubModel([done(undefined)]),
  });
  assert.equal(out.usage, null, 'no usage reported anywhere ⇒ null, so the ledger records it as UNMEASURED');
});

test('#1294 — reasoning tokens are summed too when the provider reports them', async () => {
  // Thinking is on for the seat this card is about, and reasoning tokens are
  // billed. Dropping them under-bills a thinking model specifically.
  const out = await runToolLoop({
    agent: AGENT, messages: [], tools: TOOLS, execute: async () => 'ok',
    callModel: stubModel([
      withTool({ promptTokens: 100, completionTokens: 10, reasoningTokens: 400 }),
      done({ promptTokens: 120, completionTokens: 15, reasoningTokens: 600 }),
    ]),
  });
  assert.equal(out.usage.reasoningTokens, 1000);
});

test('#1294 — the loop still returns everything it returned before', async () => {
  // Adding a field must not disturb the contract its callers already read.
  const out = await runToolLoop({
    agent: AGENT, messages: [], tools: TOOLS, execute: async () => 'ok',
    callModel: stubModel([withTool({ promptTokens: 1, completionTokens: 1 }), done({ promptTokens: 1, completionTokens: 1 })]),
  });
  for (const k of ['text', 'hops', 'modelCalls', 'stoppedBecause', 'messages']) {
    assert.ok(k in out, `the loop must still return ${k}`);
  }
  assert.equal(out.text, 'the answer');
  assert.equal(out.hops.length, 1);
  assert.equal(out.stoppedBecause, 'answered');
});

test('#1294 — usage is summed even when the loop stops at MAX HOPS', async () => {
  // A truncated exploration still cost money. Reporting no usage for the wake
  // that hit the ceiling would hide the most expensive wakes there are.
  const out = await runToolLoop({
    agent: AGENT, messages: [], tools: TOOLS, execute: async () => 'ok', maxHops: 2,
    callModel: stubModel([withTool({ promptTokens: 700, completionTokens: 25 })]),
  });
  assert.equal(out.stoppedBecause, 'max-hops');
  assert.ok(out.usage.promptTokens >= 700, `the hops that ran are still billed, got ${out.usage.promptTokens}`);
});

// ── END TO END ─────────────────────────────────────────────────────────────
// The loop returning usage is worth nothing if the LEDGER ROW still records
// none. Three lines had to change and each would have silently held the zero:
// the loop's return, the guest loop's `usage: null`, and the retry's merge.
import { guestOnce } from '../core/guest-loop.mjs';

test('#1294 ⭐ END TO END — a tool-using wake writes a ledger row WITH tokens', async () => {
  let recorded = null;
  let turn = 0;
  await guestOnce({
    agent: {
      seatKey: 'ada', name: 'Ada', systemPrompt: 'answer',
      model: { model: 'm', protocol: 'openai-completions' },
      toolGrants: ['card_get'],
    },
    wake: { id: 'w1', author: 'grace', body: 'hello @ada', createdAt: new Date().toISOString() },
    callModel: async () => {
      turn += 1;
      return turn === 1
        ? { text: '', toolCalls: [{ id: 't1', name: 'card_get', arguments: { id: 1 } }], usage: { promptTokens: 900, completionTokens: 40 } }
        : { text: 'here is the answer', toolCalls: [], usage: { promptTokens: 1100, completionTokens: 60 } };
    },
    execute: async () => 'a card',
    post: async () => ({ id: 'p1' }),
    ledgerSink: async (row) => { recorded = row; return { recorded: true, id: 'l1' }; },
  });

  assert.ok(recorded, 'a ledger row was written');
  assert.ok(recorded.usage, `the row must carry usage, got ${JSON.stringify(recorded.usage)}`);
  assert.equal(recorded.usage.promptTokens, 2000, 'summed across BOTH hops of the wake');
  assert.equal(recorded.usage.completionTokens, 100);
});

test('#1294 ⛔ END TO END — a wake whose provider reports nothing records usage NULL, not zero', async () => {
  // The row must stay honestly UNMEASURED so the ledger prices it as a gap
  // rather than as a free call.
  let recorded = null;
  await guestOnce({
    agent: {
      seatKey: 'ada', name: 'Ada', systemPrompt: 'answer',
      model: { model: 'm', protocol: 'openai-completions' },
      toolGrants: ['card_get'],
    },
    wake: { id: 'w2', author: 'grace', body: 'hello @ada', createdAt: new Date().toISOString() },
    callModel: async () => ({ text: 'an answer', toolCalls: [] }),
    execute: async () => 'a card',
    post: async () => ({ id: 'p2' }),
    ledgerSink: async (row) => { recorded = row; return { recorded: true, id: 'l2' }; },
  });
  assert.ok(recorded, 'a ledger row was written');
  assert.equal(recorded.usage, null, 'no usage reported ⇒ null, never {promptTokens: 0}');
});
