/**
 * #1078 — the one answer reaches the two surfaces a reader actually opens:
 * GET /api/board/status and the MCP board_status tool. See in-flight.test.mjs
 * for the ruling; this file pins the wiring.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRestServer, startMcpServer, mcpSession, makeBoardFixture } from './helpers/harness.mjs';

const card = (shortId, over = {}) => ({
  id: `uuid-${shortId}`, shortId, title: `Card ${shortId}`, description: '', type: 'task',
  assignees: [], labels: [], for: '', priority: null, column: 'backlog', order: 0,
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', createdBy: 'ada',
  relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [] },
  claimedBy: null, claimedAt: null, ...over,
});

const fixture = () => makeBoardFixture({
  cards: [
    card(1, { claimedBy: 'pilot', claimedAt: '2026-01-01T00:00:00.000Z' }),   // ancient → stale
    card(2, { claimedBy: 'pilot', claimedAt: new Date().toISOString(), column: 'in-progress' }),
    card(3, { column: 'in-progress' }),                                        // busy column, nobody holds it
    card(4),
  ],
  conversations: [],
  nextShortId: 5,
});

test('GET /api/board/status carries inFlight — claim-authoritative, disagreements named, existing `claims` untouched', async () => {
  const srv = await startRestServer({ board: fixture() });
  try {
    const s = await (await fetch(`${srv.baseUrl}/api/board/status`)).json();
    assert.equal(s.claims.length, 2, 'the #573 contract stays');
    assert.equal(s.inFlight.authority, 'claim');
    assert.deepEqual(s.inFlight.cards.map((c) => c.shortId), [1, 2]);
    assert.deepEqual(s.inFlight.disagreements.stale, [1]);
    assert.deepEqual(s.inFlight.disagreements.claimedNotInProgress, [1]);
    assert.deepEqual(s.inFlight.disagreements.inProgressUnclaimed, [{ shortId: 3, title: 'Card 3' }]);
    assert.equal(typeof s.inFlight.staleAfterHours, 'number');
  } finally {
    await srv.stop();
  }
});

test('MCP board_status carries inFlight and a workLedger read from the same store work_list reads', async () => {
  const store = mkdtempSync(join(tmpdir(), 'inflight-mcp-'));
  writeFileSync(join(store, 'work-objects.jsonl'), JSON.stringify({
    id: 'w1', seq: 0, card: 4, declaredBy: 'ada', replyBy: '2026-08-10T00:20:00.000Z', required: ['bo'],
    transition: { type: 'declare', at: '2026-08-10T00:00:00.000Z', by: 'ada' },
  }) + '\n');
  const rest = await startRestServer({ board: fixture() });
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl, env: { SCRUM_WORK_STORE: store } });
  try {
    const session = await mcpSession(mcp.mcpUrl);
    const result = await session.callTool('board_status', {});
    const s = JSON.parse((result.result?.content ?? []).map((c) => c.text ?? '').join('\n'));
    assert.equal(s.inFlight.authority, 'claim');
    assert.equal(s.workLedger.available, true);
    assert.equal(s.workLedger.lastTransitionAt, '2026-08-10T00:00:00.000Z');
    assert.equal(s.workLedger.dormant, true);
    assert.equal(s.workLedger.reconciled, false);
  } finally {
    await mcp.stop();
    await rest.stop();
  }
});

test('MCP board_status without a work store says so — available:false, not a zero', async () => {
  const rest = await startRestServer({ board: fixture() });
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const session = await mcpSession(mcp.mcpUrl);
    const result = await session.callTool('board_status', {});
    const s = JSON.parse((result.result?.content ?? []).map((c) => c.text ?? '').join('\n'));
    assert.equal(s.workLedger.available, false);
    assert.match(s.workLedger.reason, /SCRUM_WORK_STORE/);
  } finally {
    await mcp.stop();
    await rest.stop();
  }
});
