/**
 * #844 — AN ECHO IS NOT AN ATTEMPT.
 *
 * ⛔ THE DEFECT THIS FIXES WAS SHIPPED BY THE FIX FOR THE SAME CLASS.
 *
 * `a8217fb` added `refusedFields`/`ignoredFields` to PATCH so a caller learns
 * what the route discarded. Correct. But the predicate was "was this key
 * present?", not "did the caller try to CHANGE anything?" — so the most
 * ordinary client pattern in existence, GET a card / change one field / send it
 * back, produced:
 *
 *   PATCH with the server's own output, title changed
 *     -> 200, title: "renamed"          ← the ONE intended change
 *        refusedFields ["id","shortId","createdAt","createdBy"]
 *        ignoredFields ["updatedAt","claimedBy","claimedAt","comments"]
 *
 *   ⇒ EIGHT diagnostics on a request that attempted to change none of them.
 *
 * ⚠️ That is the always-fires rule, living inside the response body: "a rule
 * that always fires trains the room to dismiss the instrument inside a week,
 * taking the working rules down with it." A read-modify-write client sees eight
 * entries on every write, learns to skip both fields, and then the one that
 * matters is invisible. The defect this whole card family exists to prevent,
 * reproduced inside the diagnostic built to prevent it.
 *
 * ⇒ THE FIX IS THE PREDICATE, NOT THE STATUS CODE. The noise was never 2xx-vs-4xx.
 *
 *     submitted === stored  → SILENT.   nothing was attempted.
 *     submitted !== stored  → REPORTED. a real client bug.
 *
 * Found by a peer measuring the round-trip rather than reading the diff.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer } from './helpers/harness.mjs';

const mk = async (baseUrl, body = {}) => (await fetch(`${baseUrl}/api/cards`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: 'orig', createdBy: 'ada', ...body }),
})).json();

const get = async (baseUrl, id) => (await fetch(`${baseUrl}/api/cards/${id}`)).json();

const patch = async (baseUrl, id, body) => {
  const res = await fetch(`${baseUrl}/api/cards/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ by: 'ada', ...body }),
  });
  return { status: res.status, body: await res.json() };
};

test('#844 read-modify-write reports NOTHING — the echo is silent', async () => {
  const server = await startRestServer();
  try {
    const c = await mk(server.baseUrl);
    const got = await get(server.baseUrl, c.shortId);

    // The whole card, verbatim, one field changed. The ordinary client pattern.
    const r = await patch(server.baseUrl, c.shortId, { ...got, title: 'renamed' });

    assert.equal(r.status, 200, "the server's own output must be valid input to it");
    assert.equal(r.body.title, 'renamed', 'control: the one intended change landed');
    assert.equal(r.body.refusedFields, undefined,
      `echoed immutables must be silent — got ${JSON.stringify(r.body.refusedFields)}`);
    assert.ok(
      r.body.ignoredFields === undefined || r.body.ignoredFields.length === 0,
      `echoed derived fields must be silent — got ${JSON.stringify(r.body.ignoredFields)}`,
    );
  } finally {
    await server.stop();
  }
});

test('#844 a REAL attempt to change an immutable is still reported', async () => {
  // The anti-overreach control. Suppressing echoes must not suppress the
  // finding — that would trade a noisy diagnostic for a silent one, which is
  // the defect this family started with.
  const server = await startRestServer();
  try {
    const c = await mk(server.baseUrl, { createdBy: 'ada' });
    const r = await patch(server.baseUrl, c.shortId, { createdBy: 'grace', title: 'renamed' });

    assert.equal(r.status, 200);
    assert.deepEqual(r.body.refusedFields, ['createdBy'], 'a genuine attempt must still be named');
    assert.equal(r.body.title, 'renamed', 'and the legal half still lands');

    const fresh = await get(server.baseUrl, c.shortId);
    assert.equal(fresh.createdBy, 'ada', 'authorship remains immutable (#631)');
  } finally {
    await server.stop();
  }
});

test('#844 a genuinely unknown key is still reported, echo-suppression or not', async () => {
  const server = await startRestServer();
  try {
    const c = await mk(server.baseUrl);
    const r = await patch(server.baseUrl, c.shortId, { zzz_not_a_field: 'x', title: 'renamed' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.ignoredFields, ['zzz_not_a_field']);
  } finally {
    await server.stop();
  }
});

test('#844 CLASS 4 — a server-derived relationship echoes without a 400', async () => {
  // `supersededBy` is emitted by GET on every card and was refused on write as
  // "unknown relationship type" — the server calling its own output unknown.
  // A caller reads "unknown", checks their spelling, finds it correct, and is
  // worse off than with silence. Same shape as #842: a diagnostic naming the
  // right key with the wrong reason.
  const server = await startRestServer();
  try {
    const c = await mk(server.baseUrl);
    const got = await get(server.baseUrl, c.shortId);
    assert.ok('supersededBy' in (got.relationships || {}), 'GET emits it — that is the premise');

    const r = await patch(server.baseUrl, c.shortId, { relationships: got.relationships });
    assert.equal(r.status, 200, "an echo of the server's own derived field must not 400");
  } finally {
    await server.stop();
  }
});

test('#844 a REAL write to a derived relationship is still refused', async () => {
  // The paired control: accepting an echo must not accept an assertion.
  const server = await startRestServer();
  try {
    const c = await mk(server.baseUrl);
    const r = await patch(server.baseUrl, c.shortId, { relationships: { supersededBy: [7] } });
    assert.equal(r.status, 400, 'setting a server-maintained inverse is still a client bug');
    assert.match(r.body.error, /supersededBy/);
  } finally {
    await server.stop();
  }
});
