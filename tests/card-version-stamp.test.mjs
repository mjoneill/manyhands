/**
 * #534 slice 1 — a SERVER-CONTROLLED monotonic version on every card.
 *
 * This is the primitive #466 specified on 2026-07-25 and #534 needs. It is
 * deliberately INERT on its own: nothing reads the field yet. Slice 2 adds the
 * opt-in `ifVersion` precondition on PATCH, and it MUST NOT ship before this
 * does — see the ruling recorded on #534 and the reason encoded in test 4.
 *
 * ⛔ WHY THE ORDER IS A CORRECTNESS CONSTRAINT, NOT A PREFERENCE.
 * `handleSave` replaces the whole cards array with the client's copy:
 *
 *     for (const k of ['cards','columns',…]) merged[k] = incoming[k];
 *
 * so any SERVER-minted per-card field is either lost (the client never carried
 * it) or written back STALE (the client carried an old copy). A version that
 * can move BACKWARD turns the precondition built on it into a liar:
 *
 *     1  card X at version 5, server-stamped
 *     2  browser hydrates — holds X at version 5
 *     3  seat A PATCHes X            ⇒ version 6
 *     4  browser whole-board saves   ⇒ X is version 5 again
 *     5  seat B (read v5) sends ifVersion: 5 ⇒ MATCHES. FALSE PASS.
 *
 * Every step of that is already reproduced on this board. Test 4 is the one
 * that makes step 4 impossible, which is what makes slice 2 safe to build.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';
import { cardToNode, nodeToCard } from '../core/mapping.mjs';

async function api(baseUrl, method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const NEW_CARD = { title: 'version probe', description: 'ORIGINAL', createdBy: 'ada' };

test('#534 a new card is born with a version, and PATCH increments it monotonically', async () => {
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const c = await api(s.baseUrl, 'POST', '/api/cards', NEW_CARD);
    assert.equal(c.status, 201, `create failed: ${JSON.stringify(c.body)}`);
    assert.equal(c.body.version, 1, 'a new card must start at version 1');

    const p1 = await api(s.baseUrl, 'PATCH', `/api/cards/${c.body.id}`, { descriptionAppend: ' +A' });
    assert.equal(p1.body.version, 2, 'a PATCH must advance the version');

    const p2 = await api(s.baseUrl, 'PATCH', `/api/cards/${c.body.id}`, { title: 'retitled' });
    assert.equal(p2.body.version, 3, 'and again, monotonically');
  } finally { await s.stop(); }
});

test('#534 EVERY mutating path stamps — claim and release are card writes too', async () => {
  // A version maintained by only SOME write paths is the defect this slice
  // exists to prevent, one level down: a precondition built on a partially
  // maintained token reports guarded while providing nothing.
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const c = await api(s.baseUrl, 'POST', '/api/cards', NEW_CARD);
    const id = c.body.id;
    let v = c.body.version;

    await api(s.baseUrl, 'POST', `/api/cards/${id}/claim`, { by: 'ada' });
    const afterClaim = await api(s.baseUrl, 'GET', `/api/cards/${id}`);
    assert.ok(afterClaim.body.version > v, `claim must advance the version (was ${v}, got ${afterClaim.body.version})`);
    v = afterClaim.body.version;

    await api(s.baseUrl, 'DELETE', `/api/cards/${id}/claim`, { by: 'ada' });
    const afterRelease = await api(s.baseUrl, 'GET', `/api/cards/${id}`);
    assert.ok(afterRelease.body.version > v, `release must advance the version (was ${v}, got ${afterRelease.body.version})`);
  } finally { await s.stop(); }
});

test('#534 the version survives the node-domain round trip (the mapping is lossless)', async () => {
  // A field the mapping drops would be re-minted as 1 on the next load, which
  // is a silent reset — the same backward move as the save path, arriving
  // through the storage layer instead.
  const card = { id: 'x', title: 't', description: 'd', version: 7, column: 'backlog' };
  const back = nodeToCard(cardToNode(card));
  assert.equal(back.version, 7, 'version must survive card → node → card unchanged');
});
