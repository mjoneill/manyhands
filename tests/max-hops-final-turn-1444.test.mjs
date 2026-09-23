/**
 * #1444 — WHEN THE HOP CEILING BITES, THE SEAT STILL GETS TO SPEAK.
 *
 * Measured 2026-09-23 over 1,116 rows for one resident: 88 wakes (7.9%)
 * ended `stoppedBecause: max-hops` with an EMPTY reply after 4–7 paid calls.
 * The loop broke out holding the last tool-calling turn's text — almost always
 * empty, because that turn asked for a tool instead of answering — and the
 * wake posted nothing. Now the ceiling earns ONE closing call, offered NO
 * tools, with the transcript so far; its text is the wake's answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runToolLoop } from '../core/tool-loop.mjs';

const TOOLS = [{ type: 'function', function: { name: 'card_get', description: 'read a card', parameters: { type: 'object', properties: { shortId: { type: 'number' } } } } }];
const AGENT = { toolGrants: ['card_get'] };
const toolTurn = (n = 1) => ({ text: '', toolCalls: Array.from({ length: n }, (_, i) => ({ id: `c${i}`, name: 'card_get', arguments: { shortId: i + 1 } })), stopReason: 'tool_calls', usage: { promptTokens: 10, completionTokens: 2 } });

function recorder(replyForFinal = 'Here is what I found, and what I could not check.') {
  const calls = [];
  return {
    calls,
    callModel: async (agent, messages, opts) => {
      calls.push({ tools: opts?.tools ?? null, messages: messages.map((m) => ({ ...m })) });
      if (opts?.tools) return toolTurn();   // a seat that ALWAYS reaches for another tool
      return { text: replyForFinal, toolCalls: [], stopReason: 'stop', usage: { promptTokens: 20, completionTokens: 5 } };
    },
  };
}

test('#1444 at the ceiling the loop makes ONE tool-free closing call, and its text is the answer', async () => {
  const m = recorder();
  const out = await runToolLoop({ agent: AGENT, messages: [{ role: 'user', content: 'q' }], tools: TOOLS, execute: async () => ({ rows: [] }), callModel: m.callModel, maxHops: 3 });
  assert.equal(out.stoppedBecause, 'max-hops', 'the ceiling is still named');
  assert.equal(out.hops.length, 3, 'the closing call is not a hop and runs no tool');
  assert.equal(out.text, 'Here is what I found, and what I could not check.', 'the seat spoke');
  assert.equal(out.finalTurn, 'answered');
  const last = m.calls.at(-1);
  assert.equal(last.tools, null, 'the closing call is offered NO tools');
  assert.match(JSON.stringify(last.messages.at(-1)), /used your lookups/i, 'and is told why');
  assert.equal(out.modelCalls, m.calls.length, 'and it is counted and billed like any call');
});

test('#1444 a ceiling hit MID-TURN leaves no unanswered tool call in the closing transcript', async () => {
  // Five calls in one turn against maxHops 2: three are never run. A provider
  // rejects a transcript whose tool_calls lack results, so each skipped call
  // gets a result that says it was skipped.
  const calls = [];
  const callModel = async (agent, messages, opts) => {
    calls.push({ tools: opts?.tools ?? null, messages: messages.map((m) => ({ ...m })) });
    return opts?.tools ? toolTurn(5) : { text: 'answered', toolCalls: [], stopReason: 'stop', usage: {} };
  };
  let executed = 0;
  const out = await runToolLoop({ agent: AGENT, messages: [{ role: 'user', content: 'q' }], tools: TOOLS, execute: async () => { executed += 1; return 'ok'; }, callModel, maxHops: 2 });
  assert.equal(executed, 2, 'tools beyond the bound are still NEVER run');
  const final = calls.at(-1).messages;
  const asked = final.filter((m) => m.role === 'assistant').flatMap((m) => (m.tool_calls || []).map((c) => c.id));
  const answered = new Set(final.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
  assert.deepEqual(asked.filter((id) => !answered.has(id)), [], 'every tool_call id in the transcript has a result');
  assert.equal(out.text, 'answered');
});

test('#1444 a seat that answers before the ceiling never triggers the closing call', async () => {
  let n = 0;
  const callModel = async (agent, messages, opts) => { n += 1; return n === 1 ? toolTurn() : { text: 'done early', toolCalls: [], stopReason: 'stop', usage: {} }; };
  const out = await runToolLoop({ agent: AGENT, messages: [], tools: TOOLS, execute: async () => 'ok', callModel, maxHops: 5 });
  assert.equal(out.stoppedBecause, 'answered');
  assert.equal(out.finalTurn ?? null, null, 'no closing turn happened');
  assert.equal(n, 2);
});

test('#1444 the loop reports only whether the closing call said anything; an empty one is recorded, not hidden', async () => {
  const empty = await runToolLoop({ agent: AGENT, messages: [], tools: TOOLS, execute: async () => 'ok', callModel: recorder('   ').callModel, maxHops: 1 });
  assert.equal(empty.finalTurn, 'empty');
  const said = await runToolLoop({ agent: AGENT, messages: [], tools: TOOLS, execute: async () => 'ok', callModel: recorder('NO_REPLY').callModel, maxHops: 1 });
  assert.equal(said.finalTurn, 'answered', 'decline-or-not is the publish gate\'s call, made in guest-loop');
  assert.equal(said.text, 'NO_REPLY', 'and the text is passed on to it');
});

test('#1444 (review) a ceiling reached WITH text in hand makes NO closing call: the answer is kept, not replaced', async () => {
  // The last turn both answered AND asked for a tool; the ceiling bit. That
  // answer is the wake's answer — a second call would cost again and its
  // text would REPLACE it.
  const calls = [];
  const callModel = async (agent, messages, opts) => {
    calls.push(opts?.tools ?? null);
    return { text: 'Here is my answer already.', toolCalls: [{ id: 'c1', name: 'card_get', arguments: { shortId: 1 } }], stopReason: 'tool_calls', usage: {} };
  };
  const out = await runToolLoop({ agent: AGENT, messages: [], tools: TOOLS, execute: async () => 'ok', callModel, maxHops: 1 });
  assert.equal(out.stoppedBecause, 'max-hops');
  assert.equal(out.text, 'Here is my answer already.', 'the answer in hand is kept');
  assert.equal(out.finalTurn ?? null, null, 'no closing turn happened');
  assert.ok(calls.every((t) => t !== null), 'every call that was made offered tools — none was the tool-free closing call');
});

import { guestOnce } from '../core/guest-loop.mjs';
import { rowToBoard } from '../core/model-call-row.mjs';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';
const api = async (b, m, p, body) => { const r = await fetch(`${b}${p}`, { method: m, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch {} return { status: r.status, body: j }; };

test('#1444 END TO END — a resident that keeps reaching for tools now POSTS, and the board row says the ceiling bit and the closing call answered', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const agent = { seatKey: 'gizmo', name: 'Gizmo', systemPrompt: 'x', residency: 'resident', toolGrants: ['card_get'], maxHops: 2, model: { model: 'm', protocol: 'openai-completions' } };
    const mention = (await api(srv.baseUrl, 'POST', '/api/conversations', { body: '@gizmo what is on card 1?', author: 'bo' })).body;
    const r = await guestOnce({ agent, wake: mention, memories: async () => [],
      callModel: recorder('Card 1 is the one I looked at; I could not check card 2.').callModel,
      execute: async () => ({ id: 'x', title: 't' }),
      post: (b) => api(srv.baseUrl, 'POST', '/api/conversations', b).then((x) => x.body),
      ledgerSink: async (row) => (await api(srv.baseUrl, 'POST', '/api/model-calls', rowToBoard(row, agent))).body,
      ledgerFile: `/tmp/never-used-1444-${process.pid}.jsonl` });
    assert.equal(r.posted, true, 'the wake that used to post NOTHING now posts');
    const row = (await api(srv.baseUrl, 'GET', '/api/model-calls?agent=gizmo&limit=1')).body.calls[0];
    assert.equal(row.ok, true);
    assert.equal(row.stoppedBecause, 'max-hops', 'the ceiling is still on the record');
    assert.equal(row.finalTurn, 'answered', 'and what the closing call did');
    const q = await api(srv.baseUrl, 'POST', '/api/graph', { query: 'SELECT ?t WHERE { ?c a scrum:ModelCall ; scrum:finalTurn ?t . }', by: 'ada' });
    const b = q.body.rows || q.body.bindings || [];
    assert.equal(String(b[0]?.t?.value ?? b[0]?.t), 'answered', 'queryable in the graph');
  } finally { await srv.stop(); }
});

test('#1444 (review) END TO END — a closing answer that is a standalone NO_REPLY is recorded DECLINED by the same predicate the gate uses; one QUOTED in code is published and recorded answered', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const agent = { seatKey: 'gizmo', name: 'Gizmo', systemPrompt: 'x', residency: 'resident', toolGrants: ['card_get'], maxHops: 1, model: { model: 'm', protocol: 'openai-completions' } };
    const run = async (closing) => {
      const mention = (await api(srv.baseUrl, 'POST', '/api/conversations', { body: '@gizmo hi', author: 'bo' })).body;
      const r = await guestOnce({ agent, wake: mention, memories: async () => [], callModel: recorder(closing).callModel, execute: async () => ({ id: 'x' }),
        post: (b) => api(srv.baseUrl, 'POST', '/api/conversations', b).then((x) => x.body),
        ledgerSink: async (row) => (await api(srv.baseUrl, 'POST', '/api/model-calls', rowToBoard(row, agent))).body,
        ledgerFile: `/tmp/never-used-1444b-${process.pid}.jsonl` });
      const row = (await api(srv.baseUrl, 'GET', '/api/model-calls?agent=gizmo&limit=1')).body.calls[0];
      return { r, row };
    };
    const dec = await run('NO_REPLY');
    assert.equal(dec.r.posted, false, 'the gate declined it');
    assert.equal(dec.row.finalTurn, 'declined');
    const quoted = await run('The rule is:\n\n```\nNO_REPLY\n```\n\nthat is all.');
    assert.equal(quoted.r.posted, true, 'the gate published the quoted token');
    assert.equal(quoted.row.finalTurn, 'answered', 'and the row agrees with what the room saw');
  } finally { await srv.stop(); }
});
