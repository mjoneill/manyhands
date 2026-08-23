/**
 * #237 slice — a CONTRACT test for `/api/load`, the one endpoint the browser
 * actually calls.
 *
 * WHY THIS EXISTS. #235 was exactly this failure: post-#227 the server started
 * returning raw JSON-LD from `/api/load`, the board could not hydrate, and it
 * silently fell back to localStorage with auto-refresh dead. #237 names the
 * class — "tests covered the layer CHANGED, not the CONSUMERS across the seam.
 * #227 tested the storage round-trip thoroughly but not that /api/load still
 * returns the shape the browser parses. Tested the engine, not the tailpipe."
 *
 * Measured 2026-08-23: `grep -rn "api/load" tests/` returns nothing that asserts
 * its shape. The endpoint that every board load depends on had no contract test
 * at all — which is why #235 could ship.
 *
 * ⚠️ SCOPE, deliberately narrow. This does NOT test sync, merge, or the stale-
 * client scenario (#237's other two slices). It pins the RESPONSE SHAPE, which
 * is the half that #235 broke and the half a storage refactor can break again
 * without touching anything a browser test would notice.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

/** The fields the browser requires to hydrate. Named, not inferred. */
const REQUIRED_ARRAYS = ['cards', 'columns', 'conversations'];

test('#237 /api/load returns the board-shaped payload the browser hydrates from', async () => {
  const server = await startRestServer({
    board: makeBoardFixture({
      cards: [{
        id: 'c1', shortId: 1, title: 'A card', description: 'body', type: 'task',
        assignees: ['ada'], labels: [], for: '', priority: 'p1', column: 'backlog',
        order: 0, createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z',
        relationships: { relatedTo: [], blockedBy: [] },
      }],
      nextShortId: 2,
    }),
  });

  try {
    const res = await fetch(`${server.baseUrl}/api/load`);
    assert.equal(res.status, 200, '/api/load must answer 200');
    const body = await res.json();

    // ⛔ #235's actual failure: a JSON-LD document, not a board. If the storage
    // format ever leaks through this endpoint again, THIS is the assertion that
    // fires — before a human notices the board stopped hydrating.
    assert.ok(!('@graph' in body),
      '/api/load must NOT return the raw JSON-LD store document (#235). '
      + `Got top-level keys: ${Object.keys(body).join(', ')}`);

    for (const key of REQUIRED_ARRAYS) {
      assert.ok(Array.isArray(body[key]),
        `/api/load must return \`${key}\` as an array — the browser iterates it. `
        + `Got ${typeof body[key]}. Top-level keys: ${Object.keys(body).join(', ')}`);
    }

    // The card projection the board renders from. A storage change that drops
    // any of these produces blank cards rather than an error.
    const card = body.cards[0];
    assert.ok(card, 'the fixture card must survive the round-trip to /api/load');
    for (const field of ['id', 'shortId', 'title', 'column', 'order']) {
      assert.ok(field in card,
        `each card from /api/load must carry \`${field}\` — the board renders it. `
        + `Got: ${Object.keys(card).join(', ')}`);
    }

    // Anti-vacuity: prove the payload is the FIXTURE, not an empty default that
    // would satisfy every assertion above without the server reading anything.
    assert.equal(card.shortId, 1, 'the payload must reflect the fixture board, not an empty default');
    assert.equal(card.title, 'A card');
  } finally {
    await server.stop();
  }
});

/**
 * #237 slice 2 — the SAVE half of the same seam.
 *
 * The board's save contract is thinner than it looks and that is the hazard:
 * `saveToJSONFile()` POSTs `{cards, columns, nextShortId, lastUpdated}` and then
 * checks ONLY `response.ok`. It never reads the body. So the entire contract the
 * browser relies on is:
 *
 *     a 2xx from /api/save MEANS THE WRITE LANDED.
 *
 * Nothing tests that. A handler that accepted the payload, returned 200, and
 * dropped it would satisfy every existing test and every line of the browser —
 * and the board would report a successful save while losing the card. That is
 * the clobber/lost-card class #237 exists for, and it is why this test reads the
 * data BACK rather than asserting on the status code.
 *
 * ⚠️ NOT tested here: concurrency, stale-client merge, or whole-board-save
 * semantics (#237's third slice, and #118 intends to delete the endpoint
 * entirely). This pins ACCEPTED ⇒ STORED, nothing wider.
 */
test('#237 a 2xx from /api/save means the write actually landed', async () => {
  const server = await startRestServer({ board: makeBoardFixture() });

  try {
    const before = await (await fetch(`${server.baseUrl}/api/load`)).json();
    assert.equal(before.cards.length, 0, 'fixture must start empty — otherwise this proves nothing');

    const payload = {
      cards: [{
        id: 'save-1', shortId: 7, title: 'PERSISTED', description: '', type: 'task',
        assignees: [], labels: [], for: '', priority: null, column: 'backlog',
        order: 0, createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z',
        relationships: { relatedTo: [], blockedBy: [] },
      }],
      columns: before.columns,
      nextShortId: 8,
      lastUpdated: new Date().toISOString(),
    };

    const res = await fetch(`${server.baseUrl}/api/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    // This is all the browser checks.
    assert.ok(res.ok, `/api/save must answer 2xx — the board treats !ok as a failed save. Got ${res.status}`);

    // ⭐ THE ASSERTION THAT MATTERS. An accepted write is not a stored write:
    // read it back through the endpoint the board hydrates from.
    const after = await (await fetch(`${server.baseUrl}/api/load`)).json();
    const stored = after.cards.find((c) => c.id === 'save-1');
    assert.ok(stored,
      '/api/save returned 2xx but the card is ABSENT from /api/load. '
      + 'The board reports a successful save and has lost the data — the #237 clobber class. '
      + `Cards present: ${after.cards.length}`);
    assert.equal(stored.title, 'PERSISTED', 'the stored card must carry the payload it was sent, not a shell');
    assert.equal(after.nextShortId, 8, 'scalar board state must persist too, not just the card array');
  } finally {
    await server.stop();
  }
});

/**
 * #237 slice 3 — /api/conversations, the board's most-consumed endpoint.
 *
 * Five call sites, four distinct shapes: initial page (`?limit=`), the
 * older-messages pager (`?before=&limit=`), the since-poll (`?since=`), and a
 * bare call with no params. Prioritised by reference count and
 * recency of contract change: most-referenced of the four, and #1010 changed
 * its contract on 2026-08-23 by adding `?q=`.
 *
 * ⭐ WHY THE ARRAY SHAPE IS THE LOAD-BEARING ASSERTION. The consumer, verbatim:
 *
 *     .then(r => r.ok ? r.json() : [])
 *     .then(convs => {
 *       conversations.length = 0;                    // ← CLEARS FIRST
 *       if (Array.isArray(convs)) convs.forEach(...) // ← then guards
 *
 * The feed is emptied BEFORE the shape is checked. So if this endpoint ever
 * returns `{conversations: [...]}` instead of a bare array — the exact change
 * #235 made to /api/load — the guard skips, the feed renders empty, and NOTHING
 * throws. A silent blank commons with a 200 behind it.
 */
test('#237 /api/conversations returns a bare ARRAY for every shape the board requests', async () => {
  const server = await startRestServer({
    board: makeBoardFixture({
      conversations: [
        { id: 'm1', body: 'older', author: 'ada', attachedTo: null, attachments: [],
          mentions: [], createdAt: '2026-05-01T00:00:00.000Z' },
        { id: 'm2', body: 'newer', author: 'bex', attachedTo: null, attachments: [],
          mentions: [], createdAt: '2026-05-02T00:00:00.000Z' },
      ],
    }),
  });

  try {
    // The four call shapes, taken from index.html's five call sites.
    const calls = {
      'initial page': '?limit=10',
      'no params (the poll before _lastConvTs is set)': '',
      'since-poll': '?since=2026-05-01T12:00:00.000Z',
      'older-pager': '?before=2026-05-02T00:00:00.000Z&limit=10',
    };

    for (const [label, qs] of Object.entries(calls)) {
      const res = await fetch(`${server.baseUrl}/api/conversations${qs}`);
      assert.ok(res.ok, `${label}: must answer 2xx, got ${res.status}`);
      const body = await res.json();
      assert.ok(Array.isArray(body),
        `${label}: /api/conversations must return a BARE ARRAY. The board runs `
        + '`conversations.length = 0` BEFORE `Array.isArray(convs)`, so any other shape '
        + `empties the feed silently with no error. Got ${
          Array.isArray(body) ? 'array' : typeof body} `
        + `${body && !Array.isArray(body) ? `with keys: ${Object.keys(body).join(', ')}` : ''}`);
    }

    // The params must actually CONSTRAIN — a server that ignores them returns the
    // full corpus and still satisfies every assertion above (#777's class).
    const since = await (await fetch(
      `${server.baseUrl}/api/conversations?since=2026-05-01T12:00:00.000Z`)).json();
    assert.equal(since.length, 1, '`?since=` must filter, not be ignored (#777)');
    assert.equal(since[0].id, 'm2', '`?since=` must return messages AFTER the timestamp');

    const limited = await (await fetch(`${server.baseUrl}/api/conversations?limit=1`)).json();
    assert.equal(limited.length, 1, '`?limit=` must cap the page, not be ignored');

    // The fields the feed renders. A projection change that drops these produces
    // blank rows rather than an error.
    const all = await (await fetch(`${server.baseUrl}/api/conversations?limit=10`)).json();
    for (const field of ['id', 'body', 'author', 'createdAt']) {
      assert.ok(field in all[0],
        `each message must carry \`${field}\` — the feed renders it. Got: ${Object.keys(all[0]).join(', ')}`);
    }
  } finally {
    await server.stop();
  }
});
