/**
 * #303-3 — boot-time board migration. Cards created before shortIds existed
 * (26 of them, pre-2026-05-13) render as `#undefined` and can't be #NNN-linked
 * or deep-linked. The server backfills missing shortIds ONCE on boot, through
 * the store (in-process, before listen → no mutex race), idempotently.
 *
 * Rides along: strip non-canonical keys off columns (a column carrying a stray
 * key — e.g. a pre-#299 junk-key write — is normalized to {id,name,order}).
 *
 * Isolated temp board per test (never live :3141).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer } from './helpers/harness.mjs';

const ts = '2026-05-01T00:00:00.000Z';
const legacyCard = (id, title, extra = {}) => ({
  id, title, description: '', type: 'task', assignees: ['sage'], labels: [],
  for: '', priority: null, column: 'backlog', order: 0, createdAt: ts, updatedAt: ts,
  relationships: { relatedTo: [], blockedBy: [] }, ...extra, // NOTE: no shortId
});

test('#303-3 boot backfills missing shortIds — unique, no collisions, nextShortId advanced', async () => {
  const board = {
    cards: [
      legacyCard('a', 'has one', { shortId: 5 }),
      legacyCard('b', 'missing one'),
      legacyCard('c', 'missing two'),
    ],
    columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
    conversations: [],
    nextShortId: 6,
  };
  const server = await startRestServer({ board });
  try {
    const cards = await (await fetch(`${server.baseUrl}/api/cards`)).json();
    const byId = Object.fromEntries(cards.map((c) => [c.id, c]));
    // Every card now has a numeric shortId.
    for (const c of cards) assert.equal(typeof c.shortId, 'number', `${c.id} got a shortId`);
    // The pre-existing one is untouched.
    assert.equal(byId.a.shortId, 5, 'existing shortId preserved');
    // The two backfilled ones are unique and don't collide with 5.
    const sids = cards.map((c) => c.shortId);
    assert.equal(new Set(sids).size, sids.length, 'all shortIds unique');
    assert.ok(byId.b.shortId !== 5 && byId.c.shortId !== 5, 'no collision with existing');
    // nextShortId advanced past the highest assigned.
    const board2 = await (await fetch(`${server.baseUrl}/api/board`)).json();
    assert.ok(board2.nextShortId > Math.max(...sids), 'nextShortId advanced past max');
  } finally {
    await server.stop();
  }
});

test('#303-3 boot is idempotent — a fully-shortId board is not rewritten', async () => {
  const board = {
    cards: [legacyCard('a', 'ok', { shortId: 1 }), legacyCard('b', 'ok2', { shortId: 2 })],
    columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
    conversations: [], nextShortId: 3, lastUpdated: ts,
  };
  const server = await startRestServer({ board });
  try {
    const b = await (await fetch(`${server.baseUrl}/api/board`)).json();
    // No backfill needed → lastUpdated NOT bumped (migration didn't write).
    assert.equal(b.lastUpdated, ts, 'clean board not rewritten on boot');
  } finally {
    await server.stop();
  }
});

test('#303-3 boot strips non-canonical column keys (normalizes to id/name/order)', async () => {
  const board = {
    cards: [legacyCard('a', 'anchor', { shortId: 1 })],
    columns: [{ id: 'backlog', name: 'Backlog', order: 0, junkKey: null, evil: 'x' }],
    conversations: [], nextShortId: 2,
  };
  const server = await startRestServer({ board });
  try {
    const cols = await (await fetch(`${server.baseUrl}/api/columns`)).json();
    const backlog = cols.find((c) => c.id === 'backlog');
    assert.deepEqual(Object.keys(backlog).sort(), ['id', 'name', 'order'], 'only canonical keys remain');
  } finally {
    await server.stop();
  }
});
