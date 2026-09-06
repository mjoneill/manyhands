/**
 * #1196 slice C — THE COLLEAGUE ACTUALLY USES THE CHANNEL, AND THE ROW SAYS SO.
 *
 * Slices A and B built a tool channel and a surface; neither changed what
 * happens when a person mentions the seat. This wires them into the wake, and
 * with one requirement that is the whole reason the epic is worth building:
 * WHAT IT FETCHED IS RECORDED BESIDE WHAT IT SAID.
 *
 * Measured all night: handed the right rows, a small model still narrates over
 * them. So the ledger row is not decoration and not telemetry. It is the only
 * artifact that lets a reader ask the question that separates a grounded answer
 * from a fluent one — did those rows come back, and do they say that. Zero rows
 * and a confident answer is a pair nobody could see before tonight.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guestOnce } from '../core/guest-loop.mjs';

const tmpLedger = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gl-tools-')), 'ledger.jsonl');

const WAKE = { kind: 'mention', id: 'm1', author: 'ada', body: '@gizmo what does card 858 say?', createdAt: '2026-09-06T12:00:00.000Z' };
const agentWith = (grants) => ({
  seatKey: 'gizmo', residency: 'resident', contextPolicy: 'artifact-only',
  model: { model: 'fake', protocol: 'ollama-native', baseUrl: 'http://127.0.0.1:1' },
  toolGrants: grants,
});

function rowsFrom(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('#1196C a granted seat uses the channel, and every hop lands on the ledger row', async () => {
  const posts = [];
  const ledgerFile = tmpLedger();
  let turn = 0;
  const callModel = async () => {
    turn += 1;
    if (turn === 1) return { text: '', toolCalls: [{ id: 'c1', name: 'card_get', arguments: { shortId: 858 } }], stopReason: 'tool_calls', usage: { promptTokens: 5, completionTokens: 1 } };
    return { text: 'Card #858 is about the vocabulary gap.', toolCalls: [], stopReason: 'stop', usage: { promptTokens: 9, completionTokens: 8 } };
  };
  const out = await guestOnce({
    agent: agentWith(['card_get']), wake: WAKE, callModel, ledgerFile,
    post: async (p) => { posts.push(p); return { id: 'p1', createdAt: '2026-09-06T12:00:10.000Z' }; },
    execute: async (name, args) => ({ rows: [{ shortId: args.shortId, title: 'the vocabulary gap' }] }),
  });

  assert.equal(out.posted, true);
  assert.equal(posts[0].body, 'Card #858 is about the vocabulary gap.');

  const row = rowsFrom(ledgerFile).at(-1);
  assert.ok(Array.isArray(row.toolHops), 'the row carries the hops');
  assert.equal(row.toolHops.length, 1);
  assert.equal(row.toolHops[0].name, 'card_get');
  assert.deepEqual(row.toolHops[0].arguments, { shortId: 858 });
  assert.equal(row.toolHops[0].ok, true);
  assert.equal(row.toolHops[0].rowCount, 1, 'HOW MANY rows came back is the number that makes an answer checkable');
  assert.equal(row.modelCalls, 2, 'a hop costs a call and the count is on the record');
  assert.deepEqual(row.toolsGranted, ['card_get']);
});

test('#1196C ZERO ROWS is recorded as zero, so a confident answer over nothing is visible afterwards', async () => {
  const ledgerFile = tmpLedger();
  let turn = 0;
  const callModel = async () => {
    turn += 1;
    if (turn === 1) return { text: '', toolCalls: [{ id: 'c1', name: 'board_search', arguments: { q: 'nothing' } }], stopReason: 'tool_calls', usage: {} };
    return { text: 'The board clearly says the migration finished last Tuesday.', toolCalls: [], stopReason: 'stop', usage: {} };
  };
  const out = await guestOnce({
    agent: agentWith(['board_search']), wake: WAKE, callModel, ledgerFile,
    post: async () => ({ id: 'p1' }),
    execute: async () => ({ results: [] }),
  });
  assert.equal(out.posted, true, 'the post still happens: this slice records, it does not judge');
  const row = rowsFrom(ledgerFile).at(-1);
  assert.equal(row.toolHops[0].rowCount, 0);
  assert.equal(row.toolHops[0].ok, true, 'a search that matched nothing RAN — ok is about the call, not the harvest');
  // The pair that was invisible before tonight, now sitting in one row.
  assert.match(row.postedText ?? '', /migration finished/);
});

test('#1196C an UNGRANTED seat is unchanged: one call, no tools offered, no hops', async () => {
  const ledgerFile = tmpLedger();
  let calls = 0; let sawTools = null;
  const callModel = async (m, msgs, opts) => { calls += 1; sawTools = opts?.tools ?? null; return { text: 'plain answer', toolCalls: [], stopReason: 'stop', usage: {} }; };
  const out = await guestOnce({
    agent: agentWith([]), wake: WAKE, callModel, ledgerFile,
    post: async () => ({ id: 'p1' }),
    execute: async () => { throw new Error('must never run'); },
  });
  assert.equal(out.posted, true);
  assert.equal(calls, 1);
  assert.equal(sawTools, null, 'no grants means no tools offered at all');
  const row = rowsFrom(ledgerFile).at(-1);
  assert.deepEqual(row.toolHops, []);
  assert.deepEqual(row.toolsGranted, []);
});

test('#1196C a failing tool does not lose the wake, and the failure is on the row', async () => {
  const ledgerFile = tmpLedger();
  let turn = 0;
  const callModel = async () => {
    turn += 1;
    if (turn === 1) return { text: '', toolCalls: [{ id: 'c1', name: 'card_get', arguments: { shortId: 5 } }], stopReason: 'tool_calls', usage: {} };
    return { text: 'I could not read that card.', toolCalls: [], stopReason: 'stop', usage: {} };
  };
  const out = await guestOnce({
    agent: agentWith(['card_get']), wake: WAKE, callModel, ledgerFile,
    post: async () => ({ id: 'p1' }),
    execute: async () => { throw new Error('board unreachable'); },
  });
  assert.equal(out.posted, true);
  const row = rowsFrom(ledgerFile).at(-1);
  assert.equal(row.toolHops[0].ok, false);
  assert.match(row.toolHops[0].error, /board unreachable/);
});

test('#1196C the hop ceiling is DEPLOYMENT DATA: an agent sets its own, and the row says what was spent', async () => {
  // The machine this was built on runs a small model beside two other local
  // workloads, so four hops is minutes here. Another install may have room for
  // forty, or point at a hosted model where four is seconds. A ceiling chosen
  // for the cramped case and compiled in would spend everyone's capability to
  // buy our latency, so it rides on the agent and the row reports the spend.
  const ledgerFile = tmpLedger();
  const callModel = async () => ({ text: '', toolCalls: [{ id: 'c', name: 'card_get', arguments: { shortId: 1 } }], stopReason: 'tool_calls', usage: {} });
  const agent = { ...agentWith(['card_get']), maxHops: 2 };
  await guestOnce({
    agent, wake: WAKE, callModel, ledgerFile,
    post: async () => ({ id: 'p1' }),
    execute: async () => ({ rows: [] }),
  });
  const row = rowsFrom(ledgerFile).at(-1);
  assert.equal(row.toolHops.length, 2, "the agent's own ceiling is honoured, not a compiled-in one");
  assert.equal(row.stoppedBecause, 'max-hops');
  assert.ok(Number.isFinite(row.latencyMs), 'and the wall time is on the row, so a deployment learns its own number instead of inheriting ours');
});
