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
