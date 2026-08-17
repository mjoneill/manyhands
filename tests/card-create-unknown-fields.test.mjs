/**
 * #829 — POST /api/cards must report the fields it discards, as PATCH does.
 *
 * Found by review of #823 (88f464e), which fixed the MCP layer and the PATCH
 * route and left create untouched. Measured then: a create carrying `body`
 * and top-level `relatedTo` returned 201 with `description: ""`, no edges,
 * and no diagnostic — the exact incident #823's own commit message describes
 * ("two cards sat as titles-only while their author believed they were filed").
 *
 * Shape follows the PATCH route (#249 forward-compat): the write still
 * SUCCEEDS, and the response names what it dropped, present only when
 * non-empty so a clean create never claims it ignored something.
 *
 * ⚠️ Route-relative vocabulary is the trap here. `body` IS a real field on
 * /api/nodes (handleUpdateNode assigns card.description from patch.body), so
 * "unknown" is defined per route and this list is /api/cards only. A blanket
 * allowlist across routes would break the wiki surface.
 *
 * ⚠️ Every failure case below is paired with a control asserting a KNOWN key
 * landed in the same request. Without that pairing a broken probe — a create
 * that failed for an unrelated reason — reads as a passing finding.
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

async function createCard(baseUrl, body) {
  const res = await fetch(`${baseUrl}/api/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { res, card: await res.json() };
}

// ── The measured incident ────────────────────────────────────────────────

apiTest('#829 create reports `body` and top-level relatedTo instead of dropping them', async ({ baseUrl }) => {
  const { res, card } = await createCard(baseUrl, {
    title: 'scope probe',
    createdBy: 'ada',
    body: 'this text goes nowhere — the field is `description`',
    relatedTo: [7],   // belongs under `relationships`
  });

  assert.equal(res.status, 201, 'the write still succeeds — #249 forward-compat');
  // CONTROL: a known key landed, so this is not a broken probe.
  assert.equal(card.title, 'scope probe');

  assert.ok(Array.isArray(card.ignoredFields), 'create must declare what it dropped');
  assert.deepEqual([...card.ignoredFields].sort(), ['body', 'relatedTo']);

  // And the drop itself is unchanged — this card reports, it does not rescue.
  assert.equal(card.description, '');
  assert.deepEqual(card.relationships.relatedTo, []);
});

apiTest('#829 a single typo is named', async ({ baseUrl }) => {
  const { res, card } = await createCard(baseUrl, { title: 'typo probe', titel: 'misspelled' });
  assert.equal(res.status, 201);
  assert.equal(card.title, 'typo probe');            // control
  assert.deepEqual(card.ignoredFields, ['titel']);
});

// ── The guard must not fire on the route's real vocabulary ───────────────

apiTest('#829 a clean create reports nothing ignored', async ({ baseUrl }) => {
  const { res, card } = await createCard(baseUrl, {
    title: 'clean', description: 'real text', createdBy: 'ada',
  });
  assert.equal(res.status, 201);
  assert.equal(card.description, 'real text');
  assert.ok(
    card.ignoredFields === undefined || card.ignoredFields.length === 0,
    `a clean create must not claim it ignored something — got ${JSON.stringify(card.ignoredFields)}`,
  );
});

apiTest('#829 EVERY field create actually consumes is silent', async ({ baseUrl }) => {
  // The anti-false-positive control, and the one that catches drift: if a
  // field is added to createCardFromPayload and not to the consumed set, it
  // would be reported as ignored while genuinely taking effect — a lie in the
  // opposite direction, and the more confusing one to debug.
  const { res, card } = await createCard(baseUrl, {
    id: '11111111-2222-3333-4444-555555555555',
    title: 'everything', description: 'd', type: 'bug',
    assignees: ['ada'], labels: ['x'], for: 'someone',
    priority: 'p1', column: 'backlog', order: 3,
    createdBy: 'ada', relationships: { relatedTo: [7] },
  });

  assert.equal(res.status, 201);
  assert.ok(
    card.ignoredFields === undefined || card.ignoredFields.length === 0,
    `create's own vocabulary must not be reported as ignored — got ${JSON.stringify(card.ignoredFields)}`,
  );
  // Controls: prove the fields actually took effect, so "silent" isn't
  // silence about a create that quietly did nothing.
  assert.equal(card.title, 'everything');
  assert.equal(card.type, 'bug');
  assert.equal(card.priority, 'p1');
  assert.deepEqual(card.labels, ['x']);
  assert.deepEqual(card.relationships.relatedTo, [7]);
});

apiTest('#829 the `assignee` singular alias is consumed, not reported', async ({ baseUrl }) => {
  // createCardFromPayload accepts `assignee` (string) as well as `assignees`.
  // A consumed-key list assembled from the response object would miss it,
  // because it never appears on the stored card.
  const { res, card } = await createCard(baseUrl, { title: 'alias', assignee: 'ada' });
  assert.equal(res.status, 201);
  assert.deepEqual(card.assignees, ['ada'], 'the alias took effect');
  assert.ok(
    card.ignoredFields === undefined || card.ignoredFields.length === 0,
    `an accepted alias must not be reported as ignored — got ${JSON.stringify(card.ignoredFields)}`,
  );
});
