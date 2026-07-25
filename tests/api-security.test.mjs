/**
 * #249 — server-side hardening for the board-render XSS + CSRF chain.
 *
 * Layer 3 (validation): the id/type/priority/assignees fields are rendered into
 * HTML attributes by the board client, so the API — the trust boundary between
 * agents — must reject out-of-shape values rather than store them. Also folds in
 * the "PATCH copies arbitrary keys" finding via a patchable-field allowlist.
 *
 * Layer 2 (CSRF): a mutating /api request must declare Content-Type:
 * application/json, which is not a CORS "simple" content-type — forcing a
 * preflight a cross-origin page can't satisfy. Closes the drive-by text/plain
 * "simple request" POST vector.
 *
 * Isolated server per test (own port + temp board) — never live :3141.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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

const send = (baseUrl, method, path, body, headers = { 'Content-Type': 'application/json' }) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const post = (baseUrl, path, body, headers) => send(baseUrl, 'POST', path, body, headers);
const patch = (baseUrl, path, body, headers) => send(baseUrl, 'PATCH', path, body, headers);
const listCards = async (baseUrl) => (await fetch(`${baseUrl}/api/cards`)).json();

// ── Layer 3: validation of the XSS-sink fields ───────────────────────────

apiTest('POST /api/cards rejects an invalid card type (400, not stored)', async ({ baseUrl }) => {
  const res = await post(baseUrl, '/api/cards', { title: 't', type: 'x"><img src=x>' });
  assert.equal(res.status, 400);
  assert.equal((await listCards(baseUrl)).length, 0, 'malformed card was not stored');
});

apiTest('POST /api/cards rejects an invalid priority (400)', async ({ baseUrl }) => {
  const res = await post(baseUrl, '/api/cards', { title: 't', priority: 'p9"><b>' });
  assert.equal(res.status, 400);
});

apiTest('POST /api/cards rejects a non-UUID id (400)', async ({ baseUrl }) => {
  const res = await post(baseUrl, '/api/cards', { title: 't', id: 'x"><img src=x onerror=1>' });
  assert.equal(res.status, 400);
});

apiTest('POST /api/cards rejects an assignee carrying markup (400)', async ({ baseUrl }) => {
  const res = await post(baseUrl, '/api/cards', { title: 't', assignees: ['alex', 'x"><img>'] });
  assert.equal(res.status, 400);
});

apiTest('POST /api/cards still accepts valid id/type/priority/assignees (201)', async ({ baseUrl }) => {
  const id = randomUUID();
  const res = await post(baseUrl, '/api/cards', {
    title: 'ok', id, type: 'feature', priority: 'p1', assignees: ['sage', 'alex'],
  });
  assert.equal(res.status, 201);
  const card = await res.json();
  assert.equal(card.id, id);
  assert.equal(card.type, 'feature');
  assert.equal(card.priority, 'p1');
  assert.deepEqual(card.assignees, ['sage', 'alex']);
});

apiTest('PATCH /api/cards rejects an invalid type (400)', async ({ baseUrl }) => {
  const created = await (await post(baseUrl, '/api/cards', { title: 'c' })).json();
  const res = await patch(baseUrl, `/api/cards/${created.shortId}`, { type: 'x"><b>' });
  assert.equal(res.status, 400);
});

apiTest('PATCH /api/cards ignores unknown keys (field allowlist)', async ({ baseUrl }) => {
  const created = await (await post(baseUrl, '/api/cards', { title: 'c' })).json();
  const res = await patch(baseUrl, `/api/cards/${created.shortId}`, {
    title: 'renamed', bogusField: 'x', __danger: 1,
  });
  assert.equal(res.status, 200);
  const card = await res.json();
  assert.equal(card.title, 'renamed', 'an allowlisted field still applies');
  assert.ok(!('bogusField' in card), 'unknown key dropped');
  assert.ok(!('__danger' in card), 'unknown key dropped');
});

apiTest('POST /api/nodes rejects an invalid type (400)', async ({ baseUrl }) => {
  const res = await post(baseUrl, '/api/nodes', { title: 'n', type: 'x"><img>' });
  assert.equal(res.status, 400);
});

// ── Layer 2: Content-Type guard (CSRF simple-request defense) ─────────────

apiTest('POST with a text/plain body is rejected 415 and does not persist', async ({ baseUrl }) => {
  const res = await post(baseUrl, '/api/cards', JSON.stringify({ title: 'x' }), { 'Content-Type': 'text/plain' });
  assert.equal(res.status, 415);
  assert.equal((await listCards(baseUrl)).length, 0, 'the text/plain write did not persist');
});

apiTest('POST /api/save with text/plain is rejected 415', async ({ baseUrl }) => {
  const res = await fetch(`${baseUrl}/api/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ cards: [], columns: [], conversations: [] }),
  });
  assert.equal(res.status, 415);
});

apiTest('POST with application/json still works (201)', async ({ baseUrl }) => {
  const res = await post(baseUrl, '/api/cards', { title: 'fine' });
  assert.equal(res.status, 201);
});

apiTest('DELETE (no body / no content-type) is exempt from the guard', async ({ baseUrl }) => {
  const created = await (await post(baseUrl, '/api/cards', { title: 'to-delete' })).json();
  const res = await fetch(`${baseUrl}/api/cards/${created.shortId}`, { method: 'DELETE' });
  assert.ok(res.ok, `DELETE still allowed (status ${res.status})`);
});

// ── #299: columns get the same PATCH-whitelist + validation cards already have ──

apiTest('PATCH /api/columns ignores unknown keys (no arbitrary-key write)', async ({ baseUrl }) => {
  const col = await (await post(baseUrl, '/api/columns', { name: 'Triage' })).json();
  await patch(baseUrl, `/api/columns/${col.id}`, { junkKey: 'x', __proto__: { polluted: 1 }, name: 'Triage 2' });
  const cols = await (await fetch(`${baseUrl}/api/columns`)).json();
  const stored = cols.find((c) => c.id === col.id);
  assert.equal(stored.name, 'Triage 2', 'whitelisted field still applies');
  assert.ok(!('junkKey' in stored), 'unknown key not persisted onto the column');
});

apiTest('PATCH /api/columns rejects a non-string / over-long name (400, not stored)', async ({ baseUrl }) => {
  const col = await (await post(baseUrl, '/api/columns', { name: 'Keep' })).json();
  const bad = await patch(baseUrl, `/api/columns/${col.id}`, { name: 'z'.repeat(300) });
  assert.equal(bad.status, 400, 'over-long name rejected');
  const badType = await patch(baseUrl, `/api/columns/${col.id}`, { name: 12345 });
  assert.equal(badType.status, 400, 'non-string name rejected');
  const cols = await (await fetch(`${baseUrl}/api/columns`)).json();
  assert.equal(cols.find((c) => c.id === col.id).name, 'Keep', 'name unchanged after rejected patches');
});

apiTest('PATCH /api/columns rejects a non-numeric order (400)', async ({ baseUrl }) => {
  const col = await (await post(baseUrl, '/api/columns', { name: 'Ord' })).json();
  const bad = await patch(baseUrl, `/api/columns/${col.id}`, { order: 'first' });
  assert.equal(bad.status, 400, 'non-numeric order rejected');
});
