/**
 * #657 — the MCP half of slice 1: card_list flips to bounded + summary BY
 * DEFAULT, because the MCP tool is the agents' default surface and agents pay
 * for payload in context window (#656: "the API charges you for the answer
 * you didn't want, in the scarcest resource a seat has").
 *
 * The REST no-param call keeps the legacy bare array for browser pages and
 * unknown external consumers (card-list-query-api.test.mjs); the MCP tool
 * always sends bounds, so no agent gets the firehose without asking for it
 * page by page.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, startMcpServer, mcpSession, makeBoardFixture } from './helpers/harness.mjs';

function fixtureCards(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `uuid-${i + 1}`,
    shortId: i + 1,
    title: `Card ${i + 1}`,
    description: 'body '.repeat(200),
    type: 'task',
    assignees: [],
    labels: [],
    for: '',
    priority: null,
    column: 'backlog',
    order: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    createdBy: 'ada',
    relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [] },
    claimedBy: null,
    claimedAt: null,
  }));
}

const parsePayload = (result) =>
  JSON.parse((result.result?.content ?? []).map((c) => c.text ?? '').join('\n'));

async function withCardBoard(n, fn) {
  const rest = await startRestServer({
    board: makeBoardFixture({ cards: fixtureCards(n), nextShortId: n + 1 }),
  });
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const session = await mcpSession(mcp.mcpUrl);
    await fn(session);
  } finally {
    await mcp.stop();
    await rest.stop();
  }
}

test('card_list default is bounded + summary: no description, cardsTotal alongside', async () => {
  await withCardBoard(80, async (session) => {
    const data = parsePayload(await session.callTool('card_list', {}));
    assert.ok(!Array.isArray(data), 'bounded shape, not the legacy array');
    assert.equal(data.cards.length, 50, 'default page size');
    assert.equal(data.cardsTotal, 80, 'true total rides alongside');
    assert.equal('description' in data.cards[0], false, 'summary omits the body');
    assert.equal(data.cards.at(-1).shortId, 80, 'most-recent tail');
  });
});

test('card_list pages backward with before, and fields=all restores full bodies', async () => {
  await withCardBoard(30, async (session) => {
    const p1 = parsePayload(await session.callTool('card_list', { limit: 10 }));
    const cursor = String(p1.cards[0].shortId);
    const p2 = parsePayload(await session.callTool('card_list', { limit: 10, before: cursor }));
    assert.equal(p2.cards.at(-1).shortId, Number(cursor) - 1, 'strictly older window');

    const full = parsePayload(await session.callTool('card_list', { limit: 5, fields: 'all' }));
    assert.equal(typeof full.cards[0].description, 'string', 'fields=all keeps bodies');
  });
});

test('card_list surfaces the server refusal for an unknown cursor', async () => {
  await withCardBoard(5, async (session) => {
    const result = await session.callTool('card_list', { before: '9999' });
    const text = (result.result?.content ?? []).map((c) => c.text ?? '').join('\n');
    assert.match(text, /unknown before cursor|HTTP 400/, 'refusal reaches the agent, not page one');
  });
});

test('card_list filter args pass through: column narrows, typo refuses with the vocabulary', async () => {
  const rest = await startRestServer({
    board: makeBoardFixture({
      cards: fixtureCards(8).map((c, i) => ({ ...c, column: i % 2 ? 'done' : 'backlog' })),
      nextShortId: 9,
    }),
  });
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const session = await mcpSession(mcp.mcpUrl);
    const done = parsePayload(await session.callTool('card_list', { column: 'done' }));
    assert.equal(done.cardsTotal, 4);
    assert.ok(done.cards.every((c) => c.column === 'done'));

    const bad = await session.callTool('card_list', { column: 'in-progess' });
    const text = (bad.result?.content ?? []).map((c) => c.text ?? '').join('\n');
    assert.match(text, /in-progess/, 'refusal reaches the agent');
    assert.match(text, /backlog/, 'and names the valid vocabulary');
  } finally {
    await mcp.stop();
    await rest.stop();
  }
});
