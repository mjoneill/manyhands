/**
 * #614 — create surfaces must offer edges, with the four-verb vocabulary.
 *
 * The server has always accepted `relationships` at create (server.js
 * createCardFromPayload) but no create surface offered it, and the accepted
 * object was never validated. This slice:
 *   - keeps create-time relationships working (baseline, was already true)
 *   - extends the vocabulary: relatedTo · blockedBy · supersedes · derivedFrom
 *   - validates the object's shape at the API boundary (#249 discipline)
 *   - guards the #548 clobber: a partial relationships PATCH must not
 *     silently delete sibling keys
 *   - exposes the field in the MCP card_create schema
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer } from './helpers/harness.mjs';

function apiTest(name, fn) {
  test(name, async () => {
    const server = await startRestServer();
    try {
      await fn(server);
    } finally {
      await server.stop();
    }
  });
}

const json = (extra = {}) => ({
  headers: { 'Content-Type': 'application/json' },
  ...extra,
});

async function createCard(baseUrl, body) {
  const res = await fetch(`${baseUrl}/api/cards`, json({
    method: 'POST',
    body: JSON.stringify(body),
  }));
  return { res, card: res.status < 300 ? await res.json() : await res.json().catch(() => null) };
}

// ── Baseline: the two existing edge types at create ─────────────────────

apiTest('POST /api/cards stores relatedTo and blockedBy given at create', async ({ baseUrl }) => {
  const { res, card } = await createCard(baseUrl, {
    title: 'edge at birth',
    relationships: { relatedTo: [7], blockedBy: [3] },
  });
  assert.equal(res.status, 201);
  assert.deepEqual(card.relationships.relatedTo, [7]);
  assert.deepEqual(card.relationships.blockedBy, [3]);

  // And it persisted, not just echoed
  const got = await (await fetch(`${baseUrl}/api/cards/${card.shortId}`)).json();
  assert.deepEqual(got.relationships.relatedTo, [7]);
  assert.deepEqual(got.relationships.blockedBy, [3]);
});

// ── The four-verb vocabulary ────────────────────────────────────────────

apiTest('POST /api/cards stores supersedes and derivedFrom', async ({ baseUrl }) => {
  const { res, card } = await createCard(baseUrl, {
    title: 'verbed at birth',
    relationships: { supersedes: [12], derivedFrom: [4, 5] },
  });
  assert.equal(res.status, 201);
  assert.deepEqual(card.relationships.supersedes, [12]);
  assert.deepEqual(card.relationships.derivedFrom, [4, 5]);

  const got = await (await fetch(`${baseUrl}/api/cards/${card.shortId}`)).json();
  assert.deepEqual(got.relationships.supersedes, [12]);
  assert.deepEqual(got.relationships.derivedFrom, [4, 5]);
});

apiTest('a card created without relationships carries every key, empty', async ({ baseUrl }) => {
  const { res, card } = await createCard(baseUrl, { title: 'bare card' });
  assert.equal(res.status, 201);
  assert.deepEqual(card.relationships, {
    relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [],
    supersededBy: [],
  });
});

// ── Inverse maintenance, server-side (relocated from #42's client code) ──

apiTest('A supersedes B at create ⇒ the server writes B.supersededBy', async ({ baseUrl }) => {
  const { card: b } = await createCard(baseUrl, { title: 'the old decision' });
  const { card: a } = await createCard(baseUrl, {
    title: 'the new decision',
    relationships: { supersedes: [b.shortId] },
  });
  const got = await (await fetch(`${baseUrl}/api/cards/${b.shortId}`)).json();
  assert.deepEqual(got.relationships.supersededBy, [a.shortId],
    'the superseded card knows its successor without a scan');
});

apiTest('removing a supersedes edge via PATCH removes the inverse', async ({ baseUrl }) => {
  const { card: b } = await createCard(baseUrl, { title: 'old' });
  const { card: a } = await createCard(baseUrl, {
    title: 'new', relationships: { supersedes: [b.shortId] },
  });
  const res = await fetch(`${baseUrl}/api/cards/${a.shortId}`, json({
    method: 'PATCH',
    body: JSON.stringify({ relationships: { supersedes: [] } }),
  }));
  assert.equal(res.status, 200);
  const got = await (await fetch(`${baseUrl}/api/cards/${b.shortId}`)).json();
  assert.deepEqual(got.relationships.supersededBy, [],
    'the inverse is removed when the edge is');
});

apiTest('supersededBy is maintained, not writable — rejected as input', async ({ baseUrl }) => {
  const { res } = await createCard(baseUrl, {
    title: 'forged inverse', relationships: { supersededBy: [3] },
  });
  assert.equal(res.status, 400);
});

apiTest('A relatedTo B at create ⇒ the server writes B.relatedTo (both ends, any writer)', async ({ baseUrl }) => {
  const { card: b } = await createCard(baseUrl, { title: 'peer' });
  const { card: a } = await createCard(baseUrl, {
    title: 'other peer', relationships: { relatedTo: [b.shortId] },
  });
  const got = await (await fetch(`${baseUrl}/api/cards/${b.shortId}`)).json();
  assert.deepEqual(got.relationships.relatedTo, [a.shortId],
    'bidirectionality is a property of the data model now, not of one client');
});

// ── Shape validation at the boundary (#249 discipline) ──────────────────

apiTest('POST /api/cards rejects a non-object relationships value', async ({ baseUrl }) => {
  const { res } = await createCard(baseUrl, {
    title: 'bad shape', relationships: 'related to everything',
  });
  assert.equal(res.status, 400);
});

apiTest('POST /api/cards rejects unknown relationship types', async ({ baseUrl }) => {
  const { res } = await createCard(baseUrl, {
    title: 'unknown verb', relationships: { frobnicates: [9] },
  });
  assert.equal(res.status, 400);
});

apiTest('POST /api/cards rejects non-numeric relationship targets', async ({ baseUrl }) => {
  const { res } = await createCard(baseUrl, {
    title: 'bad target', relationships: { relatedTo: ['nine'] },
  });
  assert.equal(res.status, 400);
});

apiTest('PATCH /api/cards/:id rejects malformed relationships the same way', async ({ baseUrl }) => {
  const { card } = await createCard(baseUrl, { title: 'patch target' });
  const res = await fetch(`${baseUrl}/api/cards/${card.shortId}`, json({
    method: 'PATCH',
    body: JSON.stringify({ relationships: { frobnicates: [9] } }),
  }));
  assert.equal(res.status, 400);
});

// ── #548 guard: a partial relationships write must not drop siblings ────

apiTest('PATCH with a partial relationships object preserves sibling keys', async ({ baseUrl }) => {
  const { card } = await createCard(baseUrl, {
    title: 'sibling survival',
    relationships: { relatedTo: [7], blockedBy: [3] },
  });
  const res = await fetch(`${baseUrl}/api/cards/${card.shortId}`, json({
    method: 'PATCH',
    body: JSON.stringify({ relationships: { supersedes: [12] } }),
  }));
  assert.equal(res.status, 200);
  const got = await (await fetch(`${baseUrl}/api/cards/${card.shortId}`)).json();
  assert.deepEqual(got.relationships.supersedes, [12], 'the patched key landed');
  assert.deepEqual(got.relationships.relatedTo, [7], 'sibling relatedTo survived the partial write');
  assert.deepEqual(got.relationships.blockedBy, [3], 'sibling blockedBy survived the partial write');
});

apiTest('PATCH can still clear a relationship type with an explicit empty array', async ({ baseUrl }) => {
  const { card } = await createCard(baseUrl, {
    title: 'explicit clear',
    relationships: { relatedTo: [7] },
  });
  const res = await fetch(`${baseUrl}/api/cards/${card.shortId}`, json({
    method: 'PATCH',
    body: JSON.stringify({ relationships: { relatedTo: [] } }),
  }));
  assert.equal(res.status, 200);
  const got = await (await fetch(`${baseUrl}/api/cards/${card.shortId}`)).json();
  assert.deepEqual(got.relationships.relatedTo, [], 'explicit empty array clears the type');
});
