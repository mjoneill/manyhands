/**
 * #1584 — #118 Slice 2, the SERVER half: `PATCH /api/cards/:id` with
 * `{ column, order, makeRoom: true }` places the card at `order` in `column`
 * and, under the same write lock, shifts the cards it would collide with down
 * by one — only as far as the collision chain reaches, and no further.
 *
 * Why a server-side shift rather than N client PATCHes: a drag that renumbers
 * neighbours as several requests can be refused half-way (one neighbour 409s),
 * leaving the board in an order nobody chose. One request, one lock, one
 * compare-and-swap on the moved card: the move lands whole or not at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBoardFixture, startRestServer } from './helpers/harness.mjs';

const ts = '2026-09-01T00:00:00.000Z';
const card = (shortId, column, order, extra = {}) => ({
  id: `m${shortId}`, shortId, title: `card ${shortId}`, description: '', type: 'task',
  column, order, assignees: ['unassigned'], labels: [], priority: null, for: '',
  createdAt: ts, updatedAt: ts, version: 1, ...extra,
});

const board = () => makeBoardFixture({
  cards: [
    card(1, 'backlog', 1), card(2, 'backlog', 2), card(3, 'backlog', 3), card(4, 'backlog', 7),
    card(5, 'planned', 1), card(6, 'planned', 2),
  ],
  nextShortId: 7,
});

const req = async (baseUrl, method, path, body) => {
  const r = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const orders = async (baseUrl, column) => {
  const all = (await req(baseUrl, 'GET', `/api/cards?limit=50&column=${column}`)).body.cards;
  return Object.fromEntries(all.map((c) => [c.id, [c.order, c.version]]));
};

test('#1584 makeRoom: a card placed on an occupied order shifts exactly the collision chain, atomically', async () => {
  const s = await startRestServer({ board: board() });
  try {
    // m6 (planned) → backlog at order 2: m2 (2) and m3 (3) collide in a chain;
    // m4 (7) sits past a gap and must NOT move; m1 is above and must not move.
    const r = await req(s.baseUrl, 'PATCH', '/api/cards/m6', { column: 'backlog', order: 2, makeRoom: true, ifVersion: 1, return: 'id' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.version, 2);
    assert.deepEqual(
      (r.body.shifted || []).map((c) => [c.id, c.order, c.version]).sort(),
      [['m2', 3, 2], ['m3', 4, 2]],
      'the response names every neighbour it renumbered, with its new order and version',
    );
    assert.equal(r.body.ignoredFields, undefined, 'makeRoom is honoured, not reported as ignored');
    const b = await orders(s.baseUrl, 'backlog');
    assert.deepEqual(b, { m1: [1, 1], m6: [2, 2], m2: [3, 2], m3: [4, 2], m4: [7, 1] },
      'stored: the chain shifted, the gap stopped it, nothing above moved, untouched cards keep their version');
    const p = await orders(s.baseUrl, 'planned');
    assert.deepEqual(p, { m5: [1, 1] }, 'the source column is left alone (a gap is harmless)');
  } finally { await s.stop(); }
});

test('#1584 makeRoom: a stale ifVersion refuses the WHOLE move — no neighbour is shifted', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const r = await req(s.baseUrl, 'PATCH', '/api/cards/m6', { column: 'backlog', order: 1, makeRoom: true, ifVersion: 0 });
    assert.equal(r.status, 409);
    assert.equal(r.body.currentVersion, 1);
    const b = await orders(s.baseUrl, 'backlog');
    assert.deepEqual(b, { m1: [1, 1], m2: [2, 1], m3: [3, 1], m4: [7, 1] }, 'nothing renumbered');
    const p = await orders(s.baseUrl, 'planned');
    assert.deepEqual(p, { m5: [1, 1], m6: [2, 1] }, 'and the card did not move');
  } finally { await s.stop(); }
});

test('#1584 makeRoom: a free slot shifts nothing; without makeRoom a collision is stored as sent (negative control)', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const free = await req(s.baseUrl, 'PATCH', '/api/cards/m5', { column: 'backlog', order: 5, makeRoom: true, ifVersion: 1 });
    assert.equal(free.status, 200);
    assert.equal(free.body.shifted, undefined, 'nothing collided, so nothing is reported shifted');
    const plain = await req(s.baseUrl, 'PATCH', '/api/cards/m6', { column: 'backlog', order: 1, ifVersion: 1 });
    assert.equal(plain.status, 200);
    const b = await orders(s.baseUrl, 'backlog');
    assert.equal(b.m1[0], 1, 'a plain PATCH does not renumber — makeRoom is opt-in');
    assert.equal(b.m6[0], 1);
  } finally { await s.stop(); }
});

test('#1584 makeRoom: malformed requests are 400 and write nothing', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const noOrder = await req(s.baseUrl, 'PATCH', '/api/cards/m6', { column: 'backlog', makeRoom: true, ifVersion: 1 });
    assert.equal(noOrder.status, 400, JSON.stringify(noOrder.body));
    const notTrue = await req(s.baseUrl, 'PATCH', '/api/cards/m6', { column: 'backlog', order: 1, makeRoom: 'yes', ifVersion: 1 });
    assert.equal(notTrue.status, 400, JSON.stringify(notTrue.body));
    const frac = await req(s.baseUrl, 'PATCH', '/api/cards/m6', { column: 'backlog', order: 1.5, makeRoom: true, ifVersion: 1 });
    assert.equal(frac.status, 400, JSON.stringify(frac.body));
    const p = await orders(s.baseUrl, 'planned');
    assert.deepEqual(p, { m5: [1, 1], m6: [2, 1] });
  } finally { await s.stop(); }
});
