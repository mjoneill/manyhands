/**
 * #823 — an unknown field must be REPORTED, never silently discarded.
 *
 * Measured incident (2026-08-17 00:45Z): a card was created and then updated
 * with `relatedTo` passed as a TOP-LEVEL field. The real contract nests it
 * under `relationships` with numeric members. Three writes — card_create,
 * card_update, and REST PATCH — each returned success and stored no edge.
 * The caller had no way to distinguish a malformed call from a correct one.
 *
 * Two independent layers produce the same behaviour and both are covered here:
 *   - MCP: zod's z.object() strips keys the schema does not name (default).
 *   - REST: PATCHABLE_CARD_FIELDS skips unknown keys by design (#249).
 *
 * The bar is REPORTED, not necessarily REJECTED — REST keeps accepting the
 * write (forward-compat was the point of #249) but must say what it ignored,
 * so a caller can assert on it. MCP, which advertises an explicit schema,
 * rejects outright.
 *
 * ⚠️ Every test here pairs the failure case with the SUCCESS case on the same
 * surface. A guard that rejects everything would pass a rejection-only suite;
 * the correct-call assertions are what make these fixtures discriminate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, startMcpServer, mcpSession } from './helpers/harness.mjs';

function pairTest(name, fn) {
  test(name, async () => {
    const rest = await startRestServer();
    const mcp = await startMcpServer({ restApiBase: rest.baseUrl });
    try {
      await fn({ rest, mcp });
    } finally {
      await mcp.stop();
      await rest.stop();
    }
  });
}

// callTool returns the whole JSON-RPC envelope. Reading `res.isError` directly
// yields undefined, which makes `assert.notEqual(isError, true)` pass no matter
// what the server did — a fixture that cannot discriminate. Unwrap first.
const R = (r) => r?.result ?? r;
const textOf = (r) => (R(r)?.content || []).map((c) => c.text || '').join('\n');
const isErr = (r) => R(r)?.isError === true;

async function seedCard(baseUrl, body = {}) {
  const res = await fetch(`${baseUrl}/api/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'subject', ...body }),
  });
  assert.equal(res.status, 201);
  return res.json();
}

const getCard = async (baseUrl, id) =>
  (await fetch(`${baseUrl}/api/cards/${id}`)).json();

// ── MCP: the exact incident ──────────────────────────────────────────────

pairTest('card_update rejects a top-level relatedTo instead of dropping it', async ({ rest, mcp }) => {
  const card = await seedCard(rest.baseUrl);
  const s = await mcpSession(mcp.mcpUrl);

  const res = await s.callTool('card_update', {
    id: String(card.shortId),
    by: 'ada',
    relatedTo: [7],           // ← not a field. Belongs under `relationships`.
  });

  assert.equal(isErr(res), true, 'an unknown field must not succeed');
  assert.match(textOf(res), /relatedTo/, 'the error must name the offending field');

  // And nothing was written under the guise of success.
  const after = await getCard(rest.baseUrl, card.shortId);
  assert.deepEqual(after.relationships.relatedTo, []);
});

pairTest('card_update still accepts the CORRECT nested form', async ({ rest, mcp }) => {
  const card = await seedCard(rest.baseUrl);
  const s = await mcpSession(mcp.mcpUrl);

  const res = await s.callTool('card_update', {
    id: String(card.shortId),
    by: 'ada',
    relationships: { relatedTo: [7] },
  });

  assert.equal(isErr(res), false, textOf(res));
  const after = await getCard(rest.baseUrl, card.shortId);
  assert.deepEqual(after.relationships.relatedTo, [7], 'the edge must actually land');
});

pairTest('card_create rejects an unknown field and creates nothing', async ({ rest, mcp }) => {
  const s = await mcpSession(mcp.mcpUrl);
  const before = (await (await fetch(`${rest.baseUrl}/api/cards`)).json());
  const countBefore = (before.cards || before).length;

  const res = await s.callTool('card_create', {
    title: 'should not exist',
    createdBy: 'ada',
    blockedBy: [3],           // ← nests under `relationships`
  });

  assert.equal(isErr(res), true);
  assert.match(textOf(res), /blockedBy/);

  const after = (await (await fetch(`${rest.baseUrl}/api/cards`)).json());
  assert.equal((after.cards || after).length, countBefore, 'no card may be created');
});

pairTest('a plain typo is named rather than swallowed', async ({ rest, mcp }) => {
  const card = await seedCard(rest.baseUrl);
  const s = await mcpSession(mcp.mcpUrl);

  const res = await s.callTool('card_update', {
    id: String(card.shortId),
    by: 'ada',
    titel: 'misspelled',      // the everyday case, not just the incident's shape
  });

  assert.equal(isErr(res), true);
  assert.match(textOf(res), /titel/);
  const after = await getCard(rest.baseUrl, card.shortId);
  assert.equal(after.title, 'subject', 'the card must be untouched');
});

// ── The guard must not be indiscriminate ─────────────────────────────────

pairTest('an ordinary valid update is unaffected by the guard', async ({ rest, mcp }) => {
  const card = await seedCard(rest.baseUrl);
  const s = await mcpSession(mcp.mcpUrl);

  const res = await s.callTool('card_update', {
    id: String(card.shortId),
    by: 'ada',
    title: 'renamed',
    priority: 'p1',
    labels: ['x'],
  });

  assert.equal(isErr(res), false, textOf(res));
  const after = await getCard(rest.baseUrl, card.shortId);
  assert.equal(after.title, 'renamed');
  assert.equal(after.priority, 'p1');
});

pairTest('a read tool with no unknown fields still works', async ({ rest, mcp }) => {
  const card = await seedCard(rest.baseUrl);
  const s = await mcpSession(mcp.mcpUrl);
  const res = await s.callTool('card_get', { id: String(card.shortId) });
  assert.equal(isErr(res), false, textOf(res));
});

// ── REST: same class, different layer ────────────────────────────────────

pairTest('REST PATCH reports ignored unknown keys instead of silently skipping', async ({ rest }) => {
  const card = await seedCard(rest.baseUrl);

  const res = await fetch(`${rest.baseUrl}/api/cards/${card.shortId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updatedBy: 'ada', relatedTo: [7], titel: 'x' }),
  });

  assert.equal(res.status, 200, 'forward-compat: the write still succeeds (#249)');
  const body = await res.json();
  assert.ok(Array.isArray(body.ignoredFields), 'the response must declare what it dropped');
  assert.deepEqual([...body.ignoredFields].sort(), ['relatedTo', 'titel', 'updatedBy']);
});

pairTest('REST PATCH with only known fields reports nothing ignored', async ({ rest }) => {
  const card = await seedCard(rest.baseUrl);

  const res = await fetch(`${rest.baseUrl}/api/cards/${card.shortId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ by: 'ada', title: 'fine' }),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.title, 'fine');
  assert.ok(
    body.ignoredFields === undefined || body.ignoredFields.length === 0,
    'a clean write must not claim it ignored something',
  );
});

// ── #823 REOPENED — the seam is strict at the TOP level ONLY ────────────────
//
// Measured 2026-08-20, by walking into it while folding #963 into #962:
//
//   card_update({ supersededBy: 962 })                    → REJECTED by name
//   card_update({ relationships: { supersededBy: [962] } }) → ACCEPTED, dropped
//
// One tool, one call, two opposite outcomes depending on nesting depth. The
// registration seam wraps `z.object(shape).strict()` around the OUTER object;
// every nested `z.object({...})` inside it keeps zod's stripping default.
//
// ⚠️ The partial fix is worse than none here. `supersededBy` is a real field —
// it appears in every card_get response — and the strict top level TEACHES a
// caller that bad keys get refused, so silence one level down reads as
// acceptance. A rail that fires in the obvious place trains you to trust the
// place it does not fire.
//
// The fold nearly shipped with no edge. That operation's entire value IS the
// edge, and only reading the field back caught it.

pairTest('card_update rejects an unknown key NESTED inside relationships', async ({ rest, mcp }) => {
  const card = await seedCard(rest.baseUrl);
  const s = await mcpSession(mcp.mcpUrl);

  const res = await s.callTool('card_update', {
    id: String(card.shortId),
    by: 'ada',
    // `supersededBy` is DERIVED — the writable direction is `supersedes` on the
    // superseding card. Nothing at the point of use says so, which is exactly
    // why a caller reaches for it.
    relationships: { supersededBy: [7] },
  });

  assert.equal(isErr(res), true, 'a nested unknown key must not succeed');
  assert.match(textOf(res), /supersededBy/, 'the error must name the offending nested field');
});

pairTest('card_update still accepts every KNOWN key inside relationships', async ({ rest, mcp }) => {
  const card = await seedCard(rest.baseUrl);
  const other = await seedCard(rest.baseUrl, { title: 'target' });
  const s = await mcpSession(mcp.mcpUrl);

  // The discriminator: a guard that rejected the whole nested object would pass
  // the test above and fail here. All four writable members in one call.
  const res = await s.callTool('card_update', {
    id: String(card.shortId),
    by: 'ada',
    relationships: {
      relatedTo: [other.shortId],
      supersedes: [other.shortId],
      blockedBy: [other.shortId],
      derivedFrom: [other.shortId],
    },
  });

  assert.equal(isErr(res), false, textOf(res));
  const after = await getCard(rest.baseUrl, card.shortId);
  assert.deepEqual(after.relationships.relatedTo, [other.shortId], 'relatedTo must land');
  assert.deepEqual(after.relationships.supersedes, [other.shortId], 'supersedes must land');
  assert.deepEqual(after.relationships.blockedBy, [other.shortId], 'blockedBy must land');
  assert.deepEqual(after.relationships.derivedFrom, [other.shortId], 'derivedFrom must land');
});
