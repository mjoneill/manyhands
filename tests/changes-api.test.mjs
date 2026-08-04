/**
 * #679 — /api/changes and changes_since over the wire, LOG-backed.
 * Supersedes the wire half of the #643 field-read tests: fixtures can no
 * longer fake history by setting updatedAt — history now EXISTS only if a
 * write actually happened, which is the entire point.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, startMcpServer, mcpSession, makeBoardFixture } from './helpers/harness.mjs';

const json = (body) => ({
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('GET /api/changes serves real events incl. a delete with tombstone state', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  try {
    const card = await (await fetch(`${srv.baseUrl}/api/cards`, json({ title: 'lived briefly', description: 'last words', createdBy: 'ada' }))).json();
    await fetch(`${srv.baseUrl}/api/conversations`, json({ body: 'a post', author: 'bex' }));
    await fetch(`${srv.baseUrl}/api/cards/${card.id}`, { method: 'DELETE' });

    const r = await (await fetch(`${srv.baseUrl}/api/changes?since=2020-01-01T00:00:00Z&history=true`)).json();
    const ops = r.changes.map((c) => c.op);
    assert.deepEqual(ops, ['create', 'post', 'delete'], `seq order end-to-end, got ${ops}`);
    assert.equal(r.changes.at(-1).title, 'lived briefly', 'the delete row carries tombstone summary');
    assert.deepEqual(r.covers, { posts: 'exact', cards: 'creates+updates+deletes' });
    assert.deepEqual(r.omits, { cards: ['edit-actor'] });
    assert.equal(r.totals.cards, 2);
    assert.equal(r.totals.posts, 1);

    // latest-per-entity default: the card's create+delete collapse to the delete
    const dflt = await (await fetch(`${srv.baseUrl}/api/changes?since=2020-01-01T00:00:00Z`)).json();
    assert.equal(dflt.changes.filter((c) => c.id === card.id).length, 1);
    assert.equal(dflt.changes.find((c) => c.id === card.id).op, 'delete');
  } finally {
    await srv.stop();
  }
});

test('refusals: missing since · bad order · unknown param · pre-retention since', async () => {
  // One card predates the log (like the live board's 601): pre-log sinces
  // must refuse rather than answer partially. Test 1's empty-genesis board
  // is the opposite control — there, any since is honestly answerable.
  const srv = await startRestServer({
    board: makeBoardFixture({
      cards: [{ id: 'old1', shortId: 1, title: 'pre-log survivor', createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z', column: 'backlog' }],
      conversations: [],
      nextShortId: 2,
    }),
  });
  try {
    await fetch(`${srv.baseUrl}/api/conversations`, json({ body: 'seed', author: 'ada' }));
    assert.equal((await fetch(`${srv.baseUrl}/api/changes`)).status, 400, 'since required');
    assert.equal((await fetch(`${srv.baseUrl}/api/changes?since=2026-01-01T00:00:00Z&order=sideways`)).status, 400);
    const miss = await fetch(`${srv.baseUrl}/api/changes?since=2026-01-01T00:00:00Z&kind=card&as=pilot`);
    assert.equal(miss.status, 400, 'unknown param fails closed, logged as demand');
    assert.ok(await srv.waitForStderr(/changes-query.*seat=pilot.*kind/, 3000));

    const old = await fetch(`${srv.baseUrl}/api/changes?since=2020-01-01T00:00:00Z`);
    assert.equal(old.status, 400, 'a since before retention refuses');
    const body = await old.json();
    assert.equal(body.code, 'CURSOR_TOO_OLD');
    assert.ok(body.oldest_retained, 'the refusal names where retention starts');
    assert.equal(body.resync, true);
  } finally {
    await srv.stop();
  }
});

test('MCP changes_since round-trips the log-backed envelope with filters', async () => {
  const rest = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    await fetch(`${rest.baseUrl}/api/conversations`, json({ body: 'from ada', author: 'ada' }));
    await fetch(`${rest.baseUrl}/api/conversations`, json({ body: 'from bex', author: 'bex' }));
    const session = await mcpSession(mcp.mcpUrl);
    const result = await session.callTool('changes_since', { since: '2026-01-01T00:00:00Z', actor: 'bex' });
    const payload = JSON.parse((result.result?.content ?? []).map((c) => c.text ?? '').join('\n'));
    assert.equal(payload.changes.length, 1, 'actor filter rides the tool');
    assert.equal(payload.changes[0].by, 'bex');
    assert.ok(payload.totals, 'per-kind totals in the envelope');
  } finally {
    await mcp.stop();
    await rest.stop();
  }
});
