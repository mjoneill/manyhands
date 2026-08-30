/**
 * #1104 — GET /api/graph/vocabulary runs vocabularyDrift over the SERVED
 * replica, so "is the guard refusing a working query right now" is a number
 * about production, with the watermark that says which projection it is about.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

test('GET /api/graph/vocabulary reports drift over the served replica, with its watermark', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  try {
    await fetch(`${srv.baseUrl}/api/cards`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'a card so the projection is not empty', description: 'x', createdBy: 'ada' }),
    });
    const r = await fetch(`${srv.baseUrl}/api/graph/vocabulary`);
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.ok, true, `undeclared on a fresh board: ${JSON.stringify(d.undeclared)}`);
    assert.deepEqual(d.undeclared, []);
    assert.ok(d.emitted > 0, 'non-vacuous: the projection emitted terms');
    assert.ok(Array.isArray(d.unused));
    assert.match(d.means.undeclared, /refused/);
    assert.ok(d.watermark && typeof d.watermark.projectedThrough === 'number', 'the number names the projection it is about');
    assert.ok('rebuiltMs' in d);
  } finally {
    await srv.stop();
  }
});
