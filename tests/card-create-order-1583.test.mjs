/**
 * #1583 — a card created without an explicit `order` takes the END of its
 * column: max(order of the cards already in that column) + 1, allocated under
 * the server's write lock.
 *
 * Before: createCardFromPayload wrote `order: 0` for any create that did not
 * send a number, so every API-created card collided with every other one at
 * the top of its column — duplicate (column, order) pairs by construction.
 *
 * The concurrency case is the load-bearing one: an allocation computed OUTSIDE
 * the lock lets two simultaneous creates read the same maximum and both take
 * max+1. Fired together, every create must still get a distinct order.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';

const ts = '2026-09-01T00:00:00.000Z';
const card = (shortId, column, order) => ({
  id: `o${shortId}`, shortId, title: `card ${shortId}`, description: '', type: 'task',
  column, order, assignees: ['unassigned'], labels: [], priority: null, for: '',
  createdAt: ts, updatedAt: ts, version: 1,
});

const board = () => makeBoardFixture({
  cards: [card(1, 'backlog', 0), card(2, 'backlog', 7), card(3, 'backlog', 3), card(4, 'planned', 2)],
  nextShortId: 5,
});

const post = async (baseUrl, body) => {
  const r = await fetch(`${baseUrl}/api/cards`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

test('#1583 a create with no order lands at the END of its column (max+1), per column', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const a = await post(s.baseUrl, { title: 'to backlog', column: 'backlog' });
    assert.equal(a.status, 201);
    assert.equal(a.body.order, 8, 'backlog max is 7 ⇒ 8 (was 0 before #1583)');
    const b = await post(s.baseUrl, { title: 'to planned', column: 'planned' });
    assert.equal(b.body.order, 3, 'per column: planned max is 2 ⇒ 3');
    const c = await post(s.baseUrl, { title: 'to an empty column', column: 'done' });
    assert.equal(c.body.order, 0, 'an empty column starts at 0');
    const d = await post(s.baseUrl, { title: 'no column named' });
    assert.equal(d.body.column, 'backlog');
    assert.equal(d.body.order, 9, 'the default column is allocated the same way');
    // Persisted, not only echoed.
    const stored = await (await fetch(`${s.baseUrl}/api/cards/${a.body.id}`)).json();
    assert.equal(stored.order, 8);
  } finally { await s.stop(); }
});

test('#1583 an explicit numeric order is still honoured (negative control)', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const a = await post(s.baseUrl, { title: 'placed', column: 'backlog', order: 1.5 });
    assert.equal(a.body.order, 1.5);
    const z = await post(s.baseUrl, { title: 'placed at zero', column: 'backlog', order: 0 });
    assert.equal(z.body.order, 0, 'an explicit 0 is a choice, not an absence');
  } finally { await s.stop(); }
});

test('#1583 concurrent creates into one column all get DISTINCT end-of-column orders', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const N = 12;
    const results = await Promise.all(Array.from({ length: N }, (_, i) =>
      post(s.baseUrl, { title: `burst ${i}`, column: 'backlog' })));
    for (const r of results) assert.equal(r.status, 201);
    const orders = results.map((r) => r.body.order).sort((x, y) => x - y);
    assert.equal(new Set(orders).size, N, 'no two concurrent creates share an order: ' + JSON.stringify(orders));
    assert.deepEqual(orders, Array.from({ length: N }, (_, i) => 8 + i), 'contiguous after the prior max');

    // And the stored column holds no duplicate (column, order) pair at all.
    const all = (await (await fetch(`${s.baseUrl}/api/cards?limit=100&column=backlog`)).json()).cards;
    const stored = all.map((c) => c.order);
    assert.equal(new Set(stored).size, stored.length, 'stored backlog orders are unique: ' + JSON.stringify(stored));
  } finally { await s.stop(); }
});
