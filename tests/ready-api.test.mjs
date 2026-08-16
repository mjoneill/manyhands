/**
 * #815 — the wire contract for `board_ready`, on both adapters.
 *
 * The pure ruleset and its hand-derived truth table live in
 * ready-query.test.mjs; THIS file pins that the real server serves the same
 * verdicts over HTTP from a real board file (the full path: document →
 * domainToJsonLd → replica → queries → fold), and that the MCP tool is the
 * same surface, not a second one (#628: bound one adapter alone and the
 * other carries the defect).
 *
 * Fixture (REST shape, hand-derived expectations, exclusions NAMED):
 *   #1 free      backlog p2 unclaimed              → READY
 *   #2 held      backlog p0 claimed by ada      → EXCLUDED claimed-by:ada
 *   #3 waiting   backlog p1 blockedBy #4           → EXCLUDED open-blocker:4
 *   #4 blocker   in-progress p3 unclaimed          → READY (working column counts)
 *   #5 finished  done p0 unclaimed                 → EXCLUDED column:done
 *   Hand-derivation: #1 is p2, #4 is p3 → READY ORDER = [1, 4].
 *   #2 is the discriminator: highest priority on the board, must NOT appear.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, startMcpServer, mcpSession, makeBoardFixture } from './helpers/harness.mjs';

const card = (shortId, title, extra = {}) => ({
  id: `uuid-${shortId}`, shortId, title, description: 'body', type: 'task',
  assignees: [], labels: [], for: '', priority: null, column: 'backlog', order: 0,
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  createdBy: 'ada',
  relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [] },
  claimedBy: null, claimedAt: null,
  ...extra,
});

const board = () => makeBoardFixture({
  cards: [
    card(1, 'free', { priority: 'p2' }),
    card(2, 'held', { priority: 'p0', claimedBy: 'ada', claimedAt: '2026-08-02T00:00:00.000Z' }),
    card(3, 'waiting', { priority: 'p1', relationships: { relatedTo: [], blockedBy: [4], supersedes: [], derivedFrom: [] } }),
    card(4, 'blocker', { priority: 'p3', column: 'in-progress' }),
    card(5, 'finished', { priority: 'p0', column: 'done' }),
  ],
  nextShortId: 6,
  conversations: [],
});

test('GET /api/ready serves the hand-derived verdicts from a real board file', async () => {
  const srv = await startRestServer({ board: board() });
  try {
    const r = await fetch(`${srv.baseUrl}/api/ready`);
    assert.equal(r.status, 200);
    const data = await r.json();

    assert.deepEqual(data.ready.map((c) => c.shortId), [1, 4]);
    assert.equal(data.readyTotal, 2);

    const reasonOf = (n) => data.excluded.find((c) => c.shortId === n)?.reason;
    assert.equal(reasonOf(2), 'claimed-by:ada', 'the p0 card is held and must be absent');
    assert.equal(reasonOf(3), 'open-blocker:4');
    assert.equal(reasonOf(5), 'column:done');
    assert.ok(!data.ready.some((c) => c.shortId === 2), 'highest priority does not outrank a claim');
  } finally {
    await srv.stop();
  }
});

test('the queue is live: closing the blocker admits the waiter on the next call', async () => {
  const srv = await startRestServer({ board: board() });
  try {
    await fetch(`${srv.baseUrl}/api/cards/4`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ column: 'done' }),
    });
    const data = await (await fetch(`${srv.baseUrl}/api/ready`)).json();
    // Hand-derived: #3 (p1) now leads; #4 left the queue (column:done).
    assert.deepEqual(data.ready.map((c) => c.shortId), [3, 1]);
    assert.equal(data.excluded.find((c) => c.shortId === 4)?.reason, 'column:done');
  } finally {
    await srv.stop();
  }
});

test('?explain answers for one card either way; unknown shortIds 404, not empty', async () => {
  const srv = await startRestServer({ board: board() });
  try {
    const out = await (await fetch(`${srv.baseUrl}/api/ready?explain=3`)).json();
    assert.equal(out.ready, false);
    assert.equal(out.reason, 'open-blocker:4');

    const okIn = await (await fetch(`${srv.baseUrl}/api/ready?explain=1`)).json();
    assert.equal(okIn.ready, true);

    const missing = await fetch(`${srv.baseUrl}/api/ready?explain=999`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, 'UNKNOWN_CARD');
  } finally {
    await srv.stop();
  }
});

test('REGRESSION bb2ccee6 over the wire: explain ignores limit; bad limits 400', async () => {
  const srv = await startRestServer({ board: board() });
  try {
    // Hand-derived: ready order is [1, 4]; with limit=1 the page is [1] and
    // #4 is ready-but-past-the-page. It must still explain as ready.
    const page = await (await fetch(`${srv.baseUrl}/api/ready?limit=1`)).json();
    assert.deepEqual(page.ready.map((c) => c.shortId), [1], 'precondition: #4 is past the page');
    assert.equal(page.readyTotal, 2);
    assert.ok(page.excluded.length <= 1, 'exclusions page by the same bound');

    const v = await (await fetch(`${srv.baseUrl}/api/ready?limit=1&explain=4`)).json();
    assert.equal(v.ready, true, 'past-the-page must never read as UNKNOWN_CARD');

    const bad = await fetch(`${srv.baseUrl}/api/ready?limit=abc`);
    assert.equal(bad.status, 400, 'a malformed limit refuses instead of silently defaulting');
    assert.equal((await bad.json()).code, 'READY_BAD_LIMIT');
  } finally {
    await srv.stop();
  }
});

test('MCP board_ready rides the same surface and returns the same verdicts', async () => {
  const rest = await startRestServer({ board: board() });
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const session = await mcpSession(mcp.mcpUrl);
    const result = await session.callTool('board_ready', {});
    const payload = JSON.parse((result.result?.content ?? []).map((c) => c.text ?? '').join('\n'));
    assert.deepEqual(payload.ready.map((c) => c.shortId), [1, 4]);
    assert.equal(payload.excluded.find((c) => c.shortId === 2)?.reason, 'claimed-by:ada');

    const one = await session.callTool('board_ready', { explain: 3 });
    const verdict = JSON.parse((one.result?.content ?? []).map((c) => c.text ?? '').join('\n'));
    assert.equal(verdict.ready, false);
    assert.equal(verdict.reason, 'open-blocker:4');
  } finally {
    await mcp.stop();
    await rest.stop();
  }
});
