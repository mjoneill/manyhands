/**
 * #643 — GET /api/changes: the returning-agent catch-up query.
 *
 * "What did I miss?" becomes a query, not an archaeology. Union of cards
 * (updatedAt-or-createdAt >= since) and posts (createdAt >= since — EXACT,
 * because posts are append-only by construction), one time-ordered list.
 *
 * The design was converged in-room (card #643, 01:05Z) and this implements
 * it verbatim:
 *   - order=asc DEFAULT (consistency with every bounded surface + replay
 *     semantics); order=desc as the explicit, named exception (the
 *     beneficiary's triage case). "The default is the principled one; the
 *     exception is where the beneficiary speaks."
 *   - bounded in CARDINALITY as well as time: default limit + total +
 *     returned + truncated. A time window is not a size bound.
 *   - the envelope carries newest/oldest (O(1) orientation regardless of
 *     order) and per-kind covers/omits — audible coverage, never inferred:
 *     posts are exact; cards are creates+updates only (deletes and
 *     edit-actor need the #642 event log).
 *   - `by`: author for posts (always present), createdBy for card CREATES,
 *     null for card updates (edit-authorship does not exist yet — honest
 *     null, disclosed in omits).
 *   - wiki pages are card nodes (ADR-001, one store) — represented as the
 *     card rows, never duplicated as a third kind.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryChanges, CHANGES_RECENT_LIMIT } from '../core/changes-query.mjs';

function board() {
  const mk = (shortId, createdAt, updatedAt, createdBy) => ({
    id: `uuid-${shortId}`, shortId, title: `Card ${shortId}`,
    createdAt, updatedAt, createdBy, column: 'backlog',
  });
  const post = (id, createdAt, author, attachedTo = null) => ({
    id, body: 'hi', author, attachedTo, createdAt,
  });
  return {
    cards: [
      mk(1, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', 'ada'),   // old, untouched
      mk(2, '2026-08-01T00:00:00Z', '2026-08-09T10:00:00Z', 'ada'),   // old, EDITED in window
      mk(3, '2026-08-09T11:00:00Z', '2026-08-09T11:00:00Z', 'grace'), // CREATED in window
      mk(4, '2026-08-09T12:00:00Z', undefined, 'ada'),                // created, no updatedAt
    ],
    conversations: [
      post('p-old', '2026-08-01T05:00:00Z', 'ada'),
      post('p-new1', '2026-08-09T10:30:00Z', 'grace', 'uuid-2'),
      post('p-new2', '2026-08-09T11:30:00Z', 'ada'),
    ],
  };
}

const SINCE = '2026-08-09T00:00:00Z';

test('unions edited cards, created cards, and posts — ascending by default', () => {
  const r = queryChanges(board(), { since: SINCE });
  assert.deepEqual(
    r.changes.map((c) => `${c.kind}:${c.kind === 'card' ? c.shortId : c.id}`),
    ['card:2', 'post:p-new1', 'card:3', 'post:p-new2', 'card:4'],
    'time-ordered union, oldest first',
  );
  assert.equal(r.total, 5);
  assert.equal(r.returned, 5);
  assert.equal(r.truncated, false);
});

test('card rows carry action + honest by; post rows carry author + attachedTo', () => {
  const r = queryChanges(board(), { since: SINCE });
  const byKey = Object.fromEntries(r.changes.map((c) => [c.kind === 'card' ? `c${c.shortId}` : c.id, c]));
  assert.equal(byKey.c2.action, 'update');
  assert.equal(byKey.c2.by, null, 'edit-authorship does not exist — honest null, not a guess');
  assert.equal(byKey.c3.action, 'create');
  assert.equal(byKey.c3.by, 'grace');
  assert.equal(byKey['p-new1'].by, 'grace');
  assert.equal(byKey['p-new1'].attachedTo, 'uuid-2');
});

test('order=desc is the explicit exception; envelope newest/oldest hold regardless', () => {
  const asc = queryChanges(board(), { since: SINCE });
  const desc = queryChanges(board(), { since: SINCE, order: 'desc' });
  assert.deepEqual(desc.changes.map((c) => c.at), [...asc.changes.map((c) => c.at)].reverse());
  assert.equal(asc.newest, desc.newest, 'orientation fields are order-independent');
  assert.equal(asc.oldest, desc.oldest);
});

test('bounded in cardinality: default limit, truncation is audible, cursor narrows the window', () => {
  const many = {
    cards: [],
    conversations: Array.from({ length: CHANGES_RECENT_LIMIT + 20 }, (_, i) => ({
      id: `p${i}`, body: 'x', author: 'ada', attachedTo: null,
      createdAt: `2026-08-09T0${Math.floor(i / 3600)}:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
    })),
  };
  const r = queryChanges(many, { since: '2026-08-09T00:00:00Z' });
  assert.equal(r.returned, CHANGES_RECENT_LIMIT);
  assert.equal(r.total, CHANGES_RECENT_LIMIT + 20);
  assert.equal(r.truncated, true);
  // The page is the NEWEST tail (catch-up wants recent); paging backward via
  // before=<oldest at of the page> walks history without overlap.
  const page2 = queryChanges(many, { since: '2026-08-09T00:00:00Z', before: r.changes[0].at });
  assert.ok(page2.changes.every((c) => c.at < r.changes[0].at));
});

test('the envelope discloses per-kind coverage — audible, never inferred', () => {
  const r = queryChanges(board(), { since: SINCE });
  assert.deepEqual(r.covers, { posts: 'exact', cards: 'creates+updates' });
  assert.deepEqual(r.omits, { cards: ['deletes', 'edit-actor'] });
  assert.equal(r.window.from, SINCE);
});

test('since is required — a changes query without a cutoff is the firehose', () => {
  assert.throws(() => queryChanges(board(), {}), (e) => e.code === 'MISSING_SINCE');
});

// ── wire checks (REST + MCP) live in this file to keep the slice one unit ──

import { startRestServer, startMcpServer, mcpSession, makeBoardFixture } from './helpers/harness.mjs';

test('GET /api/changes over the wire: envelope + refusals', async () => {
  const srv = await startRestServer({
    board: makeBoardFixture({
      cards: [{ id: 'u1', shortId: 1, title: 'old edited', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-09T10:00:00Z', column: 'backlog' }],
      conversations: [{ id: 'p1', body: 'x', author: 'ada', attachedTo: null, mentions: [], createdAt: '2026-08-09T11:00:00Z' }],
      nextShortId: 2,
    }),
  });
  try {
    const r = await (await fetch(`${srv.baseUrl}/api/changes?since=2026-08-09T00:00:00Z`)).json();
    assert.equal(r.total, 2);
    assert.deepEqual(r.changes.map((c) => c.kind), ['card', 'post']);
    assert.deepEqual(r.covers, { posts: 'exact', cards: 'creates+updates' });

    assert.equal((await fetch(`${srv.baseUrl}/api/changes`)).status, 400, 'since required');
    assert.equal((await fetch(`${srv.baseUrl}/api/changes?since=2026-08-09T00:00:00Z&order=sideways`)).status, 400);
    const miss = await fetch(`${srv.baseUrl}/api/changes?since=2026-08-09T00:00:00Z&kind=card&as=pilot`);
    assert.equal(miss.status, 400, 'unknown param fails closed, logged as demand');
    assert.ok(await srv.waitForStderr(/changes-query.*seat=pilot.*kind/, 3000));
  } finally {
    await srv.stop();
  }
});

test('MCP changes_since round-trips the envelope', async () => {
  const rest = await startRestServer({
    board: makeBoardFixture({
      cards: [],
      conversations: [{ id: 'p1', body: 'x', author: 'ada', attachedTo: null, mentions: [], createdAt: '2026-08-09T11:00:00Z' }],
    }),
  });
  const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
  try {
    const session = await mcpSession(mcp.mcpUrl);
    const result = await session.callTool('changes_since', { since: '2026-08-09T00:00:00Z' });
    const payload = JSON.parse((result.result?.content ?? []).map((c) => c.text ?? '').join('\n'));
    assert.equal(payload.total, 1);
    assert.equal(payload.changes[0].kind, 'post');
    assert.equal(payload.changes[0].by, 'ada');
  } finally {
    await mcp.stop();
    await rest.stop();
  }
});
