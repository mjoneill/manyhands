/**
 * PATCH /api/cards/:id — the `relationships` nested field (#548).
 *
 * The defect: the PATCH loop was `card[k] = v`, a correct shallow merge and an
 * unconditional replace ONE LEVEL DOWN. `relationships` is the only nested
 * object in PATCHABLE_CARD_FIELDS, so it was the only field with this exposure.
 * Sending the one array you meant to change silently DELETED the other key —
 * a blocked card quietly became unblocked, and the 200 response looked normal.
 *
 * Behavior tests: every assertion is on an HTTP response or on the persisted
 * board file, never on how the merge is implemented.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

function apiTest(name, fn, { board } = {}) {
  test(name, async () => {
    const server = await startRestServer(board ? { board } : undefined);
    try {
      await fn(server);
    } finally {
      await server.stop();
    }
  });
}

/** A board carrying a card whose stored `relationships` is already malformed. */
function legacyBoard(relationships) {
  const ts = '2026-01-01T00:00:00.000Z';
  return makeBoardFixture({
    nextShortId: 2,
    cards: [{
      id: '11111111-2222-3333-4444-555555555555',
      shortId: 1,
      title: 'legacy junk',
      description: '',
      type: 'task',
      createdAt: ts,
      updatedAt: ts,
      assignees: ['unassigned'],
      labels: [],
      for: '',
      priority: null,
      column: 'backlog',
      order: 0,
      relationships,
    }],
  });
}

const json = (extra = {}) => ({
  headers: { 'Content-Type': 'application/json' },
  ...extra,
});

/** Create a card whose relationships have BOTH keys populated. */
async function seedLinkedCard(baseUrl) {
  const created = await (await fetch(`${baseUrl}/api/cards`, json({
    method: 'POST', body: JSON.stringify({ title: 'linked card' }),
  }))).json();
  const seeded = await (await fetch(`${baseUrl}/api/cards/${created.shortId}`, json({
    method: 'PATCH',
    body: JSON.stringify({ relationships: { relatedTo: [545], blockedBy: [466] } }),
  }))).json();
  assert.deepEqual(seeded.relationships, { relatedTo: [545], blockedBy: [466] }, 'seed precondition');
  return created;
}

// ── the defect ───────────────────────────────────────────────────────────

apiTest('PATCHing only relatedTo preserves blockedBy (#548)', async ({ baseUrl }) => {
  const card = await seedLinkedCard(baseUrl);

  const patched = await (await fetch(`${baseUrl}/api/cards/${card.shortId}`, json({
    method: 'PATCH',
    body: JSON.stringify({ relationships: { relatedTo: [545, 543] } }),
  }))).json();

  assert.deepEqual(patched.relationships.relatedTo, [545, 543], 'relatedTo updated');
  assert.ok('blockedBy' in patched.relationships, 'blockedBy key still present — it was being deleted entirely');
  assert.deepEqual(patched.relationships.blockedBy, [466], 'blockedBy survived a partial write');
});

apiTest('PATCHing only blockedBy preserves relatedTo (#548, mirror)', async ({ baseUrl }) => {
  const card = await seedLinkedCard(baseUrl);

  const patched = await (await fetch(`${baseUrl}/api/cards/${card.shortId}`, json({
    method: 'PATCH', body: JSON.stringify({ relationships: { blockedBy: [466, 543] } }),
  }))).json();

  assert.deepEqual(patched.relationships.blockedBy, [466, 543]);
  assert.deepEqual(patched.relationships.relatedTo, [545], 'relatedTo survived');
});

apiTest('the surviving sibling is on DISK, not just in the response (#548)', async ({ baseUrl, readBoardFile }) => {
  const card = await seedLinkedCard(baseUrl);

  await fetch(`${baseUrl}/api/cards/${card.shortId}`, json({
    method: 'PATCH', body: JSON.stringify({ relationships: { relatedTo: [1] } }),
  }));

  // A response can echo a merged object while persisting the clobbered one, so
  // read the file. On-disk is schema.org JSON-LD (#227): nodes live in @graph,
  // shortId is `identifier`, and the board facet carries relationships.
  const node = readBoardFile()['@graph'].find((n) => n.identifier === card.shortId);
  assert.ok(node, 'card is on disk');
  assert.deepEqual(node.board.relationships, { relatedTo: [1], blockedBy: [466] }, 'persisted state is merged');
});

// ── clearing must stay possible ──────────────────────────────────────────

apiTest('an EXPLICIT empty array still clears a relationship list', async ({ baseUrl }) => {
  const card = await seedLinkedCard(baseUrl);

  const patched = await (await fetch(`${baseUrl}/api/cards/${card.shortId}`, json({
    method: 'PATCH', body: JSON.stringify({ relationships: { blockedBy: [] } }),
  }))).json();

  assert.deepEqual(patched.relationships.blockedBy, [], 'explicit clear honoured');
  assert.deepEqual(patched.relationships.relatedTo, [545], 'other key untouched');
});

// ── shape validation (the field had NONE) ────────────────────────────────

apiTest('relationships must be an object', async ({ baseUrl }) => {
  const card = await seedLinkedCard(baseUrl);

  for (const bad of ['banana', 42, [545], null]) {
    const res = await fetch(`${baseUrl}/api/cards/${card.shortId}`, json({
      method: 'PATCH', body: JSON.stringify({ relationships: bad }),
    }));
    assert.equal(res.status, 400, `rejected ${JSON.stringify(bad)}`);
  }

  const after = await (await fetch(`${baseUrl}/api/cards/${card.shortId}`)).json();
  assert.deepEqual(after.relationships, { relatedTo: [545], blockedBy: [466] }, 'nothing was written');
});

apiTest('relationship lists must be arrays of card numbers', async ({ baseUrl }) => {
  const card = await seedLinkedCard(baseUrl);

  const bad = [
    { relatedTo: 'nope' },
    { blockedBy: { 0: 1 } },
    { relatedTo: ['545'] },      // string, not a number
    { relatedTo: [1.5] },        // not an integer shortId
    { blockedBy: [-1] },
  ];
  for (const b of bad) {
    const res = await fetch(`${baseUrl}/api/cards/${card.shortId}`, json({
      method: 'PATCH', body: JSON.stringify({ relationships: b }),
    }));
    assert.equal(res.status, 400, `rejected ${JSON.stringify(b)}`);
  }

  const after = await (await fetch(`${baseUrl}/api/cards/${card.shortId}`)).json();
  assert.deepEqual(after.relationships, { relatedTo: [545], blockedBy: [466] }, 'nothing was written');
});

apiTest('unknown keys inside relationships are dropped, not merged in (#249 spirit)', async ({ baseUrl }) => {
  const card = await seedLinkedCard(baseUrl);

  const patched = await (await fetch(`${baseUrl}/api/cards/${card.shortId}`, json({
    method: 'PATCH',
    body: JSON.stringify({ relationships: { relatedTo: [7], duplicateOf: [9], __proto__: { x: 1 } } }),
  }))).json();

  assert.deepEqual(Object.keys(patched.relationships).sort(), ['blockedBy', 'relatedTo'],
    'only the two known keys are stored');
  assert.deepEqual(patched.relationships.relatedTo, [7]);
  assert.deepEqual(patched.relationships.blockedBy, [466]);
});

// ── legacy state must be HEALED, not carried forward (#548, MiniMo's review) ──
//
// Validation only guards payloads arriving from now on. The endpoint used to
// accept anything, so malformed state is already on disk — and the first merge
// spread the existing object, which preserved it. A string spreads into indexed
// character keys: {...'banana'} → {0:'b',1:'a',…}. The repair has to normalise
// what it finds, or the fix is prospective only and the junk outlives it.

apiTest('a stored relationships STRING is normalised away by the next partial patch', async ({ baseUrl }) => {
  const patched = await (await fetch(`${baseUrl}/api/cards/1`, json({
    method: 'PATCH', body: JSON.stringify({ relationships: { relatedTo: [5] } }),
  }))).json();

  assert.deepEqual(patched.relationships, { relatedTo: [5], blockedBy: [] },
    'string did not survive as indexed character keys');
}, { board: legacyBoard('banana') });

apiTest('stored unknown inner keys and non-array lists are normalised away', async ({ baseUrl }) => {
  const patched = await (await fetch(`${baseUrl}/api/cards/1`, json({
    method: 'PATCH', body: JSON.stringify({ relationships: { relatedTo: [5] } }),
  }))).json();

  assert.deepEqual(Object.keys(patched.relationships).sort(), ['blockedBy', 'relatedTo']);
  assert.deepEqual(patched.relationships.relatedTo, [5]);
  assert.deepEqual(patched.relationships.blockedBy, [], 'a non-array stored list becomes []');
}, { board: legacyBoard({ relatedTo: [1], blockedBy: 'nope', duplicateOf: [9] }) });

apiTest('a stored ARRAY is normalised away too', async ({ baseUrl }) => {
  // Surfaced by mutation testing: dropping the object-guard in the merge is an
  // EQUIVALENT mutant (the per-key Array.isArray check already handles every
  // non-object shape), so no test could kill it. Pinning the behaviour anyway —
  // an array is a legacy shape someone could have stored, and a later
  // "simplification" of the merge should not be free to change what it does.
  const patched = await (await fetch(`${baseUrl}/api/cards/1`, json({
    method: 'PATCH', body: JSON.stringify({ relationships: { relatedTo: [5] } }),
  }))).json();

  assert.deepEqual(patched.relationships, { relatedTo: [5], blockedBy: [] });
}, { board: legacyBoard([1, 2, 3]) });

apiTest('a VALID stored list is still preserved through a partial patch', async ({ baseUrl }) => {
  // The healing must not become a reset — the sibling still has to survive.
  const patched = await (await fetch(`${baseUrl}/api/cards/1`, json({
    method: 'PATCH', body: JSON.stringify({ relationships: { relatedTo: [5] } }),
  }))).json();

  assert.deepEqual(patched.relationships, { relatedTo: [5], blockedBy: [466] });
}, { board: legacyBoard({ relatedTo: [1], blockedBy: [466] }) });

apiTest('a card created with no relationships can still be patched partially', async ({ baseUrl }) => {
  const created = await (await fetch(`${baseUrl}/api/cards`, json({
    method: 'POST', body: JSON.stringify({ title: 'bare card' }),
  }))).json();

  const patched = await (await fetch(`${baseUrl}/api/cards/${created.shortId}`, json({
    method: 'PATCH', body: JSON.stringify({ relationships: { relatedTo: [3] } }),
  }))).json();

  assert.deepEqual(patched.relationships.relatedTo, [3]);
  assert.deepEqual(patched.relationships.blockedBy, [], 'default preserved, not dropped');
});
