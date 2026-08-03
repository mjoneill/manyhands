/**
 * #657 — the wire contract for slice 1, on both read paths the customer's ruling
 * names: the agent surface (GET /api/cards) and the human surface
 * (GET /api/load, which index.html fetches on every page open).
 *
 * Contract:
 *   GET /api/cards                  → legacy bare array, unchanged. The
 *     browser's own pages (commons.html) and any unknown external consumer
 *     keep working; same compat precedent as #202's no-param conversation
 *     list. The AGENT default flips at the MCP layer, which always sends
 *     bounds (card-list-mcp.test.mjs covers that half).
 *   GET /api/cards?<any known param> → { cards, cardsTotal } — bounded,
 *     summary-projected, cursor-paged (core/cards-query.mjs).
 *   unknown param                   → 400 + { unsupported } and a server-side
 *     log line naming the seat (`as=`) — fail-closed per #655, logged because
 *     the miss log IS the roadmap. `bestEffort=true` downgrades the refusal
 *     to best-effort service, same log line.
 *   GET /api/load                   → conversations: [] + conversationsOmitted
 *     — 91% of the 20.4MB payload was conversations the board view never
 *     reads (verified: index.html feeds its commons panel exclusively from
 *     bounded /api/conversations fetches).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

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

function board(n = 80, extra = {}) {
  return makeBoardFixture({
    cards: fixtureCards(n),
    nextShortId: n + 1,
    conversations: [
      { id: 'c1', body: 'hello', author: 'ada', attachedTo: null, mentions: [], createdAt: '2026-08-01T00:00:00.000Z' },
      { id: 'c2', body: 'world', author: 'ada', attachedTo: null, mentions: [], createdAt: '2026-08-02T00:00:00.000Z' },
    ],
    ...extra,
  });
}

test('GET /api/cards with no params stays the legacy bare array (compat)', async () => {
  const srv = await startRestServer({ board: board(10) });
  try {
    const r = await fetch(`${srv.baseUrl}/api/cards`);
    const data = await r.json();
    assert.ok(Array.isArray(data), 'no-param response must remain a bare array');
    assert.equal(data.length, 10);
    assert.equal(typeof data[0].description, 'string', 'legacy shape keeps full bodies');
  } finally {
    await srv.stop();
  }
});

test('GET /api/cards?limit=… returns the bounded, projected shape', async () => {
  const srv = await startRestServer({ board: board(80) });
  try {
    const r = await fetch(`${srv.baseUrl}/api/cards?limit=10`);
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.ok(!Array.isArray(data));
    assert.equal(data.cards.length, 10);
    assert.equal(data.cardsTotal, 80);
    assert.equal('description' in data.cards[0], false, 'default projection is summary');
    assert.equal(data.cards.at(-1).shortId, 80, 'most-recent tail');
  } finally {
    await srv.stop();
  }
});

test('fields=all with a limit keeps full bodies; fields list narrows; bad field 400s', async () => {
  const srv = await startRestServer({ board: board(20) });
  try {
    const full = await (await fetch(`${srv.baseUrl}/api/cards?limit=5&fields=all`)).json();
    assert.equal(typeof full.cards[0].description, 'string');

    const narrow = await (await fetch(`${srv.baseUrl}/api/cards?limit=5&fields=title`)).json();
    assert.deepEqual(Object.keys(narrow.cards[0]).sort(), ['id', 'shortId', 'title']);

    const bad = await fetch(`${srv.baseUrl}/api/cards?limit=5&fields=titel`);
    assert.equal(bad.status, 400);
    const err = await bad.json();
    assert.match(err.error, /titel/);
  } finally {
    await srv.stop();
  }
});

test('cursor paging works over the wire and an unknown cursor 400s', async () => {
  const srv = await startRestServer({ board: board(30) });
  try {
    const p1 = await (await fetch(`${srv.baseUrl}/api/cards?limit=10`)).json();
    const cursor = p1.cards[0].shortId;
    const p2 = await (await fetch(`${srv.baseUrl}/api/cards?limit=10&before=${cursor}`)).json();
    assert.equal(p2.cards.at(-1).shortId, cursor - 1);

    const bad = await fetch(`${srv.baseUrl}/api/cards?limit=10&before=99999`);
    assert.equal(bad.status, 400);
  } finally {
    await srv.stop();
  }
});

test('an unknown param fails closed with 400 + unsupported, and logs the seat key', async () => {
  const srv = await startRestServer({ board: board(5) });
  try {
    const r = await fetch(`${srv.baseUrl}/api/cards?limit=5&column=backlog&as=pilot`);
    assert.equal(r.status, 400, 'filters are slice 2; today they must refuse, not silently ignore');
    const err = await r.json();
    assert.deepEqual(err.unsupported, ['column']);

    // The miss log is the roadmap: the server must record what was asked for,
    // by whom. (console.warn → the server process's stderr.)
    const logged = await srv.waitForStderr(/card-query.*seat=pilot.*column/, 3000);
    assert.ok(logged, 'expected a [card-query] miss log naming seat and param');
  } finally {
    await srv.stop();
  }
});

test('bestEffort=true serves the known params and still logs the miss', async () => {
  const srv = await startRestServer({ board: board(5) });
  try {
    const r = await fetch(`${srv.baseUrl}/api/cards?limit=5&column=backlog&as=pilot&bestEffort=true`);
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.cards.length, 5);
    assert.deepEqual(data.unsupported, ['column'], 'best-effort must confess what it ignored');
    const logged = await srv.waitForStderr(/card-query.*seat=pilot.*column/, 3000);
    assert.ok(logged);
  } finally {
    await srv.stop();
  }
});

test('GET /api/load no longer ships conversations, and flags the omission', async () => {
  const srv = await startRestServer({ board: board(5) });
  try {
    const data = await (await fetch(`${srv.baseUrl}/api/load`)).json();
    assert.deepEqual(data.conversations, [], '18.7MB of never-rendered payload');
    assert.equal(data.conversationsOmitted, true, 'a reader must be able to tell empty from omitted');
    assert.equal(data.cards.length, 5, 'cards unharmed');
    assert.equal(data.columns.length, 4);
  } finally {
    await srv.stop();
  }
});

test('a browser load→save round-trip cannot wipe conversations off disk', async () => {
  // /api/save already allowlists {cards, columns, nextShortId, lastUpdated}
  // (2026-05-19 data-loss fix). This asserts the seam at #657's granularity:
  // the exact payload a browser now HOLDS (conversations: []) written back
  // through /api/save leaves the on-disk conversations intact.
  const srv = await startRestServer({ board: board(5) });
  try {
    const loaded = await (await fetch(`${srv.baseUrl}/api/load`)).json();
    const r = await fetch(`${srv.baseUrl}/api/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(loaded),
    });
    assert.equal(r.status, 200);
    // The store may persist either JSON-LD (@graph, Comment nodes) or the
    // legacy shape depending on migration state — count conversations in
    // whichever shape is on disk.
    const onDisk = srv.readBoardFile();
    const convCount = Array.isArray(onDisk['@graph'])
      ? onDisk['@graph'].filter((n) => n['@type'] === 'Comment').length
      : (onDisk.conversations || []).length;
    assert.equal(convCount, 2, 'conversations survived the round-trip');
  } finally {
    await srv.stop();
  }
});
