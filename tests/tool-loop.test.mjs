/**
 * #1196 slice A2 — THE CALL / EXECUTE / CALL LOOP.
 *
 * A tool channel that sends tools and reads calls back is still one shot: the
 * colleague asks for a card and nothing hands it one. This is the loop that
 * closes it, and its contract is set by what we measured tonight rather than by
 * what would be convenient.
 *
 * Measured: a small model handed the right rows still narrated over them (4 of
 * 14 on a frozen set, 0 of 3 abstentions on negatives). So the loop is NOT
 * built to make answers correct. It is built so that every hop is RECORDED —
 * which tool, which arguments, how many rows came back — and travels with the
 * answer. A claim that arrives beside the query that produced it can be checked
 * by a reader downstream. That check is the deliverable; the model's confidence
 * is not evidence and this loop never treats it as such.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runToolLoop } from '../core/tool-loop.mjs';

const TOOLS = [{ type: 'function', function: { name: 'card_get', description: 'read a card', parameters: { type: 'object', properties: { shortId: { type: 'number' } } } } }];

/** A scripted model: each entry is one turn's reply. */
function scripted(turns) {
  const seen = [];
  let i = 0;
  return {
    seen,
    callModel: async (agent, messages) => {
      seen.push(messages.map((m) => ({ role: m.role, content: m.content, name: m.name })));
      const t = turns[i++] ?? { text: 'ran out of script', toolCalls: [] };
      return { text: t.text ?? '', toolCalls: t.toolCalls ?? [], stopReason: t.toolCalls?.length ? 'tool_calls' : 'stop', usage: { promptTokens: 1, completionTokens: 1 } };
    },
  };
}

test('#1196A2 one hop: the tool runs, its result is handed back, and the answer carries the hop', async () => {
  const m = scripted([
    { toolCalls: [{ id: 'c1', name: 'card_get', arguments: { shortId: 650 } }] },
    { text: 'Card 650 is the research record.' },
  ]);
  const out = await runToolLoop({
    agent: { model: 'fake', protocol: 'ollama-native' },
    messages: [{ role: 'user', content: 'what is card 650' }],
    tools: TOOLS,
    execute: async (name, args) => ({ rows: [{ shortId: args.shortId, title: 'the research record' }] }),
    callModel: m.callModel,
  });

  assert.equal(out.text, 'Card 650 is the research record.');
  assert.equal(out.hops.length, 1, 'one tool call is one hop');
  assert.equal(out.hops[0].name, 'card_get');
  assert.deepEqual(out.hops[0].arguments, { shortId: 650 });
  assert.equal(out.hops[0].ok, true);
  assert.equal(out.hops[0].rowCount, 1, 'how much came back is part of the record: zero rows answered confidently is the failure we are chasing');
  assert.equal(out.modelCalls, 2, 'a hop costs a second model call and the count is reported, never hidden');

  // The tool result must actually reach the model, or the loop is theatre.
  const secondTurn = m.seen[1];
  assert.ok(secondTurn.some((msg) => msg.role === 'tool' && /research record/.test(String(msg.content))),
    `the tool result must be in the second turn's messages, got ${JSON.stringify(secondTurn)}`);
});

test('#1196A2 the loop is BOUNDED and says so when it stops', async () => {
  // A model that asks for the same card forever. Small models do this.
  const m = scripted(Array.from({ length: 20 }, () => ({ toolCalls: [{ id: 'c', name: 'card_get', arguments: { shortId: 1 } }] })));
  const out = await runToolLoop({
    agent: {}, messages: [{ role: 'user', content: 'loop' }], tools: TOOLS,
    execute: async () => ({ rows: [] }),
    callModel: m.callModel,
    maxHops: 3,
  });
  assert.equal(out.hops.length, 3, 'the bound holds');
  assert.equal(out.stoppedBecause, 'max-hops', 'and the reason is named, because a truncated exploration that reads as a finished one is the same defect in a new place');
  assert.ok(out.text === '' || typeof out.text === 'string');
});

test('#1196A2 an ungranted tool is refused BY NAME and the refusal goes back to the model', async () => {
  const m = scripted([
    { toolCalls: [{ id: 'c1', name: 'card_delete', arguments: { shortId: 1 } }] },
    { text: 'Understood, I cannot do that.' },
  ]);
  let executed = 0;
  const out = await runToolLoop({
    agent: {}, messages: [{ role: 'user', content: 'delete card 1' }], tools: TOOLS,
    execute: async () => { executed += 1; return { rows: [] }; },
    callModel: m.callModel,
  });
  assert.equal(executed, 0, 'an ungranted tool is NEVER executed');
  assert.equal(out.hops[0].ok, false);
  assert.match(out.hops[0].error, /card_delete/, 'the refusal names the tool: a silent no is indistinguishable from a tool that returned nothing');
  assert.match(String(m.seen[1].find((x) => x.role === 'tool')?.content ?? ''), /card_delete/);
});

test('#1196A2 a tool that throws is reported to the model, never crashes the wake', async () => {
  const m = scripted([
    { toolCalls: [{ id: 'c1', name: 'card_get', arguments: { shortId: 9 } }] },
    { text: 'I could not read it.' },
  ]);
  const out = await runToolLoop({
    agent: {}, messages: [{ role: 'user', content: 'x' }], tools: TOOLS,
    execute: async () => { throw new Error('board unreachable'); },
    callModel: m.callModel,
  });
  assert.equal(out.hops[0].ok, false);
  assert.match(out.hops[0].error, /board unreachable/);
  assert.equal(out.text, 'I could not read it.', 'the wake still produces a turn');
});

test('#1196A2 malformed arguments never reach a tool', async () => {
  const m = scripted([
    { toolCalls: [{ id: 'c1', name: 'card_get', arguments: null, argumentsError: 'arguments are not valid JSON' }] },
    { text: 'Sorry, I garbled that.' },
  ]);
  let executed = 0;
  const out = await runToolLoop({
    agent: {}, messages: [{ role: 'user', content: 'x' }], tools: TOOLS,
    execute: async () => { executed += 1; return { rows: [] }; },
    callModel: m.callModel,
  });
  assert.equal(executed, 0);
  assert.equal(out.hops[0].ok, false);
  assert.match(out.hops[0].error, /json/i);
});

test('#1196A2 no tool calls means no loop and no extra model call', async () => {
  const m = scripted([{ text: 'I can answer that directly.' }]);
  const out = await runToolLoop({
    agent: {}, messages: [{ role: 'user', content: 'hi' }], tools: TOOLS,
    execute: async () => { throw new Error('must not run'); },
    callModel: m.callModel,
  });
  assert.equal(out.text, 'I can answer that directly.');
  assert.deepEqual(out.hops, []);
  assert.equal(out.modelCalls, 1);
  assert.equal(out.stoppedBecause, 'answered');
});

test('#1196A2 with NO tools granted the loop never offers any, and one call is the whole turn', async () => {
  const m = scripted([{ text: 'plain answer' }]);
  const out = await runToolLoop({ agent: {}, messages: [{ role: 'user', content: 'hi' }], tools: [], execute: null, callModel: m.callModel });
  assert.equal(out.modelCalls, 1);
  assert.deepEqual(out.hops, []);
  assert.equal(out.stoppedBecause, 'answered');
});

test('#1196A2 the bound holds WITHIN one turn: many calls in a single reply cannot outrun it', async () => {
  // A sabotage found this gap. Every earlier case sent one call per turn, so a
  // per-turn guard and a per-round guard were indistinguishable and either one
  // alone passed. A model is free to ask for five things at once, and only the
  // per-call check stops the fifth.
  const many = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, name: 'card_get', arguments: { shortId: i } }));
  const m = scripted([{ toolCalls: many }, { text: 'done' }]);
  let executed = 0;
  const out = await runToolLoop({
    agent: {}, messages: [{ role: 'user', content: 'read five cards' }], tools: TOOLS,
    execute: async () => { executed += 1; return { rows: [1] }; },
    callModel: m.callModel,
    maxHops: 2,
  });
  assert.equal(out.hops.length, 2, 'five calls in one turn still cost at most maxHops');
  assert.equal(executed, 2, 'and the tools beyond the bound are NEVER run');
  assert.equal(out.stoppedBecause, 'max-hops');
});
