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

test('#534 POSITIVE CONTROL — a save from a CURRENT client still persists every card', async () => {
  // ⭐ Asked for by the seat whose ruling made this change necessary, and it is
  // the right guard: route A makes handleSave COMPUTE a field it currently
  // ACCEPTS, on the browser's own save path. The failure mode that matters is
  // not a wrong version — it is SAVING BREAKING.
  //
  // ⚠️ Asserted by READ-BACK, never by a 200: a 200 describes the request, not
  // the state (#823). This must pass BEFORE the change and AFTER it; it is a
  // guard against over-refusal, not evidence that the feature exists.
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    await api(s.baseUrl, 'POST', '/api/cards', { ...NEW_CARD, title: 'KEEP ONE' });
    await api(s.baseUrl, 'POST', '/api/cards', { ...NEW_CARD, title: 'KEEP TWO' });

    const board = await api(s.baseUrl, 'GET', '/api/board');
    const payload = JSON.parse(JSON.stringify(board.body));
    for (const c of payload.cards) if (c.title === 'KEEP TWO') c.description = 'EDITED BY BROWSER';

    const save = await api(s.baseUrl, 'POST', '/api/save', {
      cards: payload.cards, columns: payload.columns, nextShortId: payload.nextShortId,
    });
    assert.ok(save.status < 400, `a current client's save must succeed: ${JSON.stringify(save.body)}`);

    const after = await api(s.baseUrl, 'GET', '/api/board');
    const titles = after.body.cards.map((c) => c.title).sort();
    assert.deepEqual(titles, ['KEEP ONE', 'KEEP TWO'], 'every card sent must still be there');
    const two = after.body.cards.find((c) => c.title === 'KEEP TWO');
    assert.equal(two.description, 'EDITED BY BROWSER', "the browser's edit must actually land");
  } finally { await s.stop(); }
});

test('#534 ⭐ a whole-board SAVE can never move a card version BACKWARD', async () => {
  // ⭐⭐⭐ THE LOAD-BEARING TEST — this is the one that makes slice 2 honest.
  // Without it, /api/save writes the client's stale version back and a later
  // `ifVersion` comparison passes against a card that has moved on twice.
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const c = await api(s.baseUrl, 'POST', '/api/cards', NEW_CARD);
    const id = c.body.id;

    // Advance it server-side, the way a second seat's PATCH would.
    await api(s.baseUrl, 'PATCH', `/api/cards/${id}`, { descriptionAppend: ' +SEAT A' });
    const current = await api(s.baseUrl, 'GET', `/api/cards/${id}`);
    const serverVersion = current.body.version;
    assert.ok(serverVersion >= 2, 'the card must have moved on, or this test asserts nothing');

    const board = await api(s.baseUrl, 'GET', '/api/board');

    // CASE 1 — a stale client that CARRIES an old version and writes it back.
    const stale = JSON.parse(JSON.stringify(board.body));
    for (const card of stale.cards) if (card.id === id) card.version = 1;
    const save1 = await api(s.baseUrl, 'POST', '/api/save', {
      cards: stale.cards, columns: stale.columns, nextShortId: stale.nextShortId,
    });
    assert.ok(save1.status < 400, `save should not error: ${JSON.stringify(save1.body)}`);
    const after1 = await api(s.baseUrl, 'GET', `/api/cards/${id}`);
    assert.ok(after1.body.version >= serverVersion,
      `a save must not regress the version: server was ${serverVersion}, `
      + `client sent 1, card is now ${after1.body.version}`);

    // CASE 2 — a client that OMITS the field entirely. This is the worse one:
    // an absent version reads as "never written", so a default of 0 would let
    // `ifVersion: 0` pass on a card with real history.
    const v2 = after1.body.version;
    const board2 = await api(s.baseUrl, 'GET', '/api/board');
    const omitted = JSON.parse(JSON.stringify(board2.body));
    for (const card of omitted.cards) if (card.id === id) delete card.version;
    const save2 = await api(s.baseUrl, 'POST', '/api/save', {
      cards: omitted.cards, columns: omitted.columns, nextShortId: omitted.nextShortId,
    });
    assert.ok(save2.status < 400, `save should not error: ${JSON.stringify(save2.body)}`);
    const after2 = await api(s.baseUrl, 'GET', `/api/cards/${id}`);
    assert.equal(typeof after2.body.version, 'number',
      'a save that omits the version must not leave the card without one');
    assert.ok(after2.body.version >= v2,
      `omitting the version must not reset it: was ${v2}, now ${after2.body.version}`);
  } finally { await s.stop(); }
});

test('#534 a save must not INFLATE versions of cards it did not change', async () => {
  // The opposite failure, and it is not cosmetic: bumping an untouched card
  // makes a legitimate holder's `ifVersion` fail in slice 2. Over-refusing is
  // the way a precondition breaks working writers, so it is pinned here.
  const s = await startRestServer({ board: makeBoardFixture() });
  try {
    const a = await api(s.baseUrl, 'POST', '/api/cards', { ...NEW_CARD, title: 'A' });
    const b = await api(s.baseUrl, 'POST', '/api/cards', { ...NEW_CARD, title: 'B' });
    const bVersionBefore = (await api(s.baseUrl, 'GET', `/api/cards/${b.body.id}`)).body.version;

    const board = await api(s.baseUrl, 'GET', '/api/board');
    const payload = JSON.parse(JSON.stringify(board.body));
    for (const card of payload.cards) if (card.id === a.body.id) card.title = 'A EDITED';

    await api(s.baseUrl, 'POST', '/api/save', {
      cards: payload.cards, columns: payload.columns, nextShortId: payload.nextShortId,
    });

    const bAfter = await api(s.baseUrl, 'GET', `/api/cards/${b.body.id}`);
    assert.equal(bAfter.body.version, bVersionBefore,
      `an untouched card must keep its version (was ${bVersionBefore}, now ${bAfter.body.version})`);
  } finally { await s.stop(); }
});
