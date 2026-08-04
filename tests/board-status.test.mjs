/**
 * #573 — board_status fails on its own success: GET /api/board returns the
 * whole board including every conversation ever posted (20.7MB and growing
 * ~1.4MB/day), the MCP transport chokes, and the failure surfaces as a false
 * "session expired" — sending agents to restart servers that are fine.
 *
 * The orientation use-case needs the SHAPE of the board, not its history.
 * Fix shape (option 3 on the card — split, because /api/board is also the
 * board-state MCP resource whose full-state contract something may rely on):
 *
 *   GET /api/board          → UNCHANGED. Full legacy payload; the resource
 *                             and any unknown consumer keep their contract.
 *   GET /api/board/status   → the orientation projection: counts by column,
 *                             totals, live claims, recent tails, meta. Size
 *                             INVARIANT to corpus growth — the property whose
 *                             absence rotted the original tool.
 *   MCP board_status        → calls /status; description stops promising the
 *                             whole board.
 *
 * Also here: `type: "bug"` joins the card-type enum (third defect on #573) —
 * the store holds 5 bug-typed cards that the write path refuses and the #659
 * type= filter 400s on, i.e. a schema that cannot express existing data.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, startMcpServer, mcpSession, makeBoardFixture } from './helpers/harness.mjs';

function bigFixture({ cards = 60, convs = 200 } = {}) {
  return makeBoardFixture({
    cards: Array.from({ length: cards }, (_, i) => ({
      id: `uuid-${i + 1}`,
      shortId: i + 1,
      title: `Card ${i + 1}`,
      description: 'body '.repeat(300),
      type: 'task',
      assignees: [],
      labels: [],
      for: '',
      priority: null,
      column: ['backlog', 'planned', 'in-progress', 'done'][i % 4],
      order: 0,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      createdBy: 'ada',
      relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [] },
      claimedBy: i < 3 ? 'pilot' : null,
      claimedAt: i < 3 ? '2026-08-02T00:00:00.000Z' : null,
    })),
    conversations: Array.from({ length: convs }, (_, i) => ({
      id: `conv-${i + 1}`,
      body: 'chatter '.repeat(100),
      author: 'ada',
      attachedTo: null,
      mentions: [],
      createdAt: `2026-08-01T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`,
    })),
    nextShortId: cards + 1,
  });
}

test('GET /api/board is UNCHANGED — full legacy payload, conversations included (resource contract)', async () => {
  const srv = await startRestServer({ board: bigFixture({ cards: 8, convs: 5 }) });
  try {
    const data = await (await fetch(`${srv.baseUrl}/api/board`)).json();
    assert.equal(data.cards.length, 8);
    assert.equal(data.conversations.length, 5, 'the full-state contract stays intact');
    assert.equal(typeof data.cards[0].description, 'string');
  } finally {
    await srv.stop();
  }
});

test('GET /api/board/status returns the orientation projection, not the history', async () => {
  const srv = await startRestServer({ board: bigFixture({ cards: 60, convs: 200 }) });
  try {
    const s = await (await fetch(`${srv.baseUrl}/api/board/status`)).json();
    assert.equal(s.cardsTotal, 60);
    assert.equal(s.conversationsTotal, 200);
    assert.deepEqual(s.cardsByColumn, { backlog: 15, planned: 15, 'in-progress': 15, done: 15 });
    assert.equal(s.nextShortId, 61);
    assert.ok(Array.isArray(s.columns) && s.columns.length === 4);
    // Live claims are orientation-critical (who is holding what right now) —
    // and the audit's finding 1 says nothing else surfaces them.
    assert.equal(s.claims.length, 3);
    assert.equal(s.claims[0].claimedBy, 'pilot');
    // Recent tails: bounded, summary-shaped, no full bodies anywhere.
    assert.ok(s.recentCards.length <= 10);
    assert.equal('description' in s.recentCards[0], false);
    assert.ok(s.recentConversations.length <= 10);
    for (const c of s.recentConversations) {
      assert.ok((c.body ?? '').length <= 203, 'conversation preview, not the post');
    }
  } finally {
    await srv.stop();
  }
});

test('the status payload is size-invariant to corpus growth — the property whose absence caused #573', async () => {
  const small = await startRestServer({ board: bigFixture({ cards: 20, convs: 50 }) });
  const large = await startRestServer({ board: bigFixture({ cards: 400, convs: 2000 }) });
  try {
    const a = JSON.stringify(await (await fetch(`${small.baseUrl}/api/board/status`)).json());
    const b = JSON.stringify(await (await fetch(`${large.baseUrl}/api/board/status`)).json());
    assert.ok(b.length < a.length * 1.6,
      `status grew with the corpus: ${a.length} → ${b.length} bytes (20× the data must not mean 20× the payload)`);
    assert.ok(b.length < 60_000, `status is ${b.length} bytes — must stay far under any tool-result budget`);
  } finally {
    await small.stop();
    await large.stop();
  }
});

test('MCP board_status now answers on a board whose full payload would be huge', async () => {
  const rest = await startRestServer({ board: bigFixture({ cards: 100, convs: 500 }) });
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const session = await mcpSession(mcp.mcpUrl);
    const result = await session.callTool('board_status', {});
    const text = (result.result?.content ?? []).map((c) => c.text ?? '').join('\n');
    const s = JSON.parse(text);
    assert.equal(s.cardsTotal, 100);
    assert.equal(s.conversationsTotal, 500);
    assert.ok(text.length < 60_000, `tool result is ${text.length} bytes`);
  } finally {
    await mcp.stop();
    await rest.stop();
  }
});

test('type "bug" is now expressible: create accepts it and the type= filter serves it', async () => {
  const srv = await startRestServer({ board: bigFixture({ cards: 4, convs: 0 }) });
  try {
    const created = await fetch(`${srv.baseUrl}/api/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'a real bug', type: 'bug', createdBy: 'pilot' }),
    });
    assert.equal(created.status, 201, 'the write path stops refusing a type the store already holds');

    const filtered = await (await fetch(`${srv.baseUrl}/api/cards?type=bug`)).json();
    assert.equal(filtered.cardsTotal, 1);
    assert.equal(filtered.cards[0].type, 'bug');
  } finally {
    await srv.stop();
  }
});
