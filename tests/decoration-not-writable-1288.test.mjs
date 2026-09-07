/**
 * #1288 — THE GUARD ON AN EXCLUSION.
 *
 * `descriptionExcerpt` and `legacyArrayIndex` were added to #831 RC0b's
 * SERVER_ASSIGNED set, which EXCLUDES them from the field-coverage universe.
 * That list's own header warns why that is dangerous: "an over-broad exclusion
 * is how a coverage check quietly stops covering things."
 *
 * So the exclusion is not left as an assertion. These tests are the thing that
 * makes it re-checkable: they encode WHY the two fields need no probe, and they
 * red the moment that stops being true.
 *
 * What was verified before excluding them (2026-09-07):
 *   - zero nodes in board-data.json carry either key, under any spelling —
 *     checked for namespaced JSON-LD variants, not just the bare name
 *   - both absent from PATCHABLE_CARD_FIELDS
 *   - their only occurrences in the server are the read decorator in
 *     core/cards-query.mjs
 *
 * ⚠️ AND THE BEHAVIOUR THAT MADE THE GUARD RED IS REAL AND STAYS: `GET
 * /api/cards` with no params returns a bare LIST and decorates every card;
 * `?limit=N` returns {cards, cardsTotal} and decorates only when asked. Two
 * response shapes from one endpoint, selected by whether `limit` is present.
 * That is pinned below rather than fixed — changing it is a caller-visible
 * contract change and belongs to whoever owns #209, not to this card.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer } from './helpers/harness.mjs';

const DECORATIONS = ['descriptionExcerpt', 'legacyArrayIndex'];

const j = (r) => r.json();
const post = (base, p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const patch = (base, p, body) => fetch(`${base}${p}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function withServer(fn) {
  const s = await startRestServer({});
  try { return await fn(s); } finally { await s.stop(); }
}

async function makeCard(base, title = 'a card') {
  const r = await post(base, '/api/cards', { title, by: 'ada', column: 'backlog', description: 'a description long enough to excerpt from' });
  const raw = await r.text();
  assert.equal(r.status, 201, raw);
  return JSON.parse(raw).shortId;
}

const stored = async (base, id) => j(await fetch(`${base}/api/cards/${id}`));

test('#1288 ⛔ THE CONTROL ON THE EXCLUSION — neither decoration is caller-settable via PATCH', async () => {
  // If either ever becomes writable, it belongs in the coverage universe with
  // a real probe, and the SERVER_ASSIGNED entry is then WRONG. This is the
  // test that notices.
  await withServer(async (s) => {
    const id = await makeCard(s.baseUrl);
    const before = await stored(s.baseUrl, id);

    for (const field of DECORATIONS) {
      const r = await patch(s.baseUrl, `/api/cards/${id}`, { by: 'ada', [field]: 'INJECTED' });
      // Accepted-and-ignored or refused are both fine; STORED is not.
      const after = await stored(s.baseUrl, id);
      assert.ok(!(field in after) || after[field] !== 'INJECTED',
        `${field} must not be settable by a caller (status ${r.status})`);
    }

    const after = await stored(s.baseUrl, id);
    assert.equal(after.title, before.title, 'and nothing else moved');
  });
});

test('#1288 ⛔ …nor through /api/save, which takes the cards array WHOLESALE', async () => {
  // The likelier leak: the browser reads decorated cards and saves them back.
  // #1039's carryForward is `{...stored, ...incoming}`, so an incoming key is
  // kept — which is exactly how a read projection could become durable state.
  await withServer(async (s) => {
    const id = await makeCard(s.baseUrl);
    const card = await stored(s.baseUrl, id);

    const r = await post(s.baseUrl, '/api/save', {
      cards: [{ ...card, descriptionExcerpt: 'INJECTED…', legacyArrayIndex: 99 }],
    });
    assert.ok(r.status === 200 || r.status === 409 || r.status === 400, `unexpected ${r.status}`);

    if (r.status === 200) {
      const after = await stored(s.baseUrl, id);
      for (const field of DECORATIONS) {
        assert.ok(!(field in after) || after[field] === undefined,
          `${field} must not become durable state via /api/save — a read projection that round-trips into the store is how a computed field turns into a stale one`);
      }
    }
  });
});

test('#1288 — the decorations are ABSENT unless asked for (the paged path)', async () => {
  await withServer(async (s) => {
    await makeCard(s.baseUrl);
    const plain = await j(await fetch(`${s.baseUrl}/api/cards?limit=5`));
    const cards = Array.isArray(plain) ? plain : plain.cards;
    for (const c of cards) {
      for (const field of DECORATIONS) {
        assert.ok(!(field in c), `${field} must not appear when it was not requested`);
      }
    }
  });
});

test('#1288 — and PRESENT when asked for, so the exclusion is not hiding a dead feature', async () => {
  // The positive half. If these fields stopped being emitted entirely, the
  // SERVER_ASSIGNED entries would be excluding names that no longer exist —
  // tidy, and quietly wrong.
  await withServer(async (s) => {
    await makeCard(s.baseUrl);
    const decorated = await j(await fetch(`${s.baseUrl}/api/cards?limit=5&excerpt=40&legacyIndex=1`));
    const cards = Array.isArray(decorated) ? decorated : decorated.cards;
    assert.ok(cards.length > 0, 'need at least one card');
    for (const field of DECORATIONS) {
      assert.ok(field in cards[0], `${field} must still be emitted when requested`);
    }
  });
});

test('#1288 ⚠️ TWO RESPONSE SHAPES FROM ONE ENDPOINT — pinned, not fixed', async () => {
  // `GET /api/cards` (no params) → a bare LIST, decorated.
  // `GET /api/cards?limit=N`     → {cards, cardsTotal}, undecorated.
  //
  // This is the contract a stranger could not be handed — the "externalizable
  // from the ground up" standard, failed. Changing it is caller-visible and
  // belongs to #209's owner; this test exists so the next person meets it
  // deliberately instead of discovering it inside an unrelated red.
  await withServer(async (s) => {
    await makeCard(s.baseUrl);
    const bare = await j(await fetch(`${s.baseUrl}/api/cards`));
    const paged = await j(await fetch(`${s.baseUrl}/api/cards?limit=5`));
    assert.ok(Array.isArray(bare), 'no params ⇒ a bare list');
    assert.ok(!Array.isArray(paged) && Array.isArray(paged.cards), 'limit ⇒ {cards, cardsTotal}');
  });
});
