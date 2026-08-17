/**
 * #841 — PATCH /api/nodes reports what it discarded.
 *
 * The fourth surface of the #823 class. The seam (#823), PATCH /api/cards
 * (#823) and POST /api/cards (#829) each learned to name their dropped keys;
 * this route never did, so a caller sending `description` instead of `body` —
 * the natural mistake, since every other route calls it that — got a 200 and
 * lost their edit with no signal. On the wiki surface, that edit is prose a
 * human composed and cannot easily reproduce.
 *
 * ⚠️ EVERY CASE IS PAIRED. A route that reported *everything* as ignored, or
 * that rejected the whole write, would satisfy a test that only ever sends a
 * bad key. So each unknown key travels with a known one, and the known one is
 * asserted to have landed. The clean-patch case is the other half: a guard that
 * invents fields is the more expensive defect, because it makes correct callers
 * chase a diagnostic that is lying to them.
 *
 * ⛔ ROUTE-LOCAL BY CONSTRUCTION, and this is the trap the card names.
 * `body` is REAL here (it maps to card.description) and unknown on /api/cards.
 * `priority` is the reverse. A shared allowlist between the two routes would
 * pass a naive test and silently break the wiki. RC3 pins both directions in
 * one run so the shared-allowlist implementation cannot survive.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer } from './helpers/harness.mjs';

/** Create a bare card and return its shortId — every nodes PATCH needs a target. */
async function newCard(baseUrl, fields = {}) {
  const res = await fetch(`${baseUrl}/api/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'nodes-ignored-fields fixture', ...fields }),
  });
  assert.equal(res.status, 201, 'fixture card must be created');
  return (await res.json()).shortId;
}

async function patchNode(baseUrl, shortId, patch) {
  const res = await fetch(`${baseUrl}/api/nodes/${shortId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return { status: res.status, body: await res.json() };
}

/** Read back FRESH via the card surface. The PATCH response is the write's own
 *  echo; only a separate read is evidence that something persisted (#831's
 *  `reads` bug was exactly this — presence in the echo mistaken for storage).
 *
 *  ⚠️ Deliberately the CARD route, not `GET /api/nodes/:id`. That returns
 *  `{node, children, backlinks}` where the node is a schema.org projection with
 *  renamed keys — a read-back through a second mapping layer would make a
 *  mapping bug indistinguishable from a storage bug. `body` lands in
 *  `card.description`, so that is what gets asserted. */
async function readCard(baseUrl, shortId) {
  const res = await fetch(`${baseUrl}/api/cards/${shortId}`);
  return { status: res.status, body: await res.json() };
}

test('#841 RC1a — an unknown key is REPORTED, and the known key still lands', async () => {
  const server = await startRestServer();
  try {
    const id = await newCard(server.baseUrl);
    const { status, body } = await patchNode(server.baseUrl, id, {
      body: 'the prose a human just wrote',   // KNOWN on this route
      priority: 'p0',                         // unknown here, real on /api/cards
      zzz_not_a_field: 'junk',                // unknown everywhere
    });

    assert.equal(status, 200);
    assert.ok(Array.isArray(body.ignoredFields), 'the route must emit ignoredFields');
    assert.deepEqual(
      [...body.ignoredFields].sort(), ['priority', 'zzz_not_a_field'],
      'both discarded keys named — and NOTHING else, or the diagnostic is noise',
    );

    // The paired half: the write still worked. Without this a route that
    // refused the whole request would pass the assertion above.
    const fresh = await readCard(server.baseUrl, id);
    assert.equal(fresh.body.description, 'the prose a human just wrote', 'known key persisted');
  } finally {
    await server.stop();
  }
});

test('#841 RC1b — a clean patch reports NOTHING (the guard must not invent fields)', async () => {
  const server = await startRestServer();
  try {
    const id = await newCard(server.baseUrl);
    const { status, body } = await patchNode(server.baseUrl, id, {
      title: 'renamed', body: 'still fine',
    });

    assert.equal(status, 200);
    assert.equal(
      body.ignoredFields, undefined,
      'absent, not an empty array — an empty array on every response is noise a caller learns to skip',
    );

    const fresh = await readCard(server.baseUrl, id);
    assert.equal(fresh.body.title, 'renamed', 'and the clean patch actually applied');
  } finally {
    await server.stop();
  }
});

test('#841 RC3 — route-relative vocabulary: `body` is consumed HERE and ignored on /api/cards', async () => {
  const server = await startRestServer();
  try {
    // Direction 1 — /api/nodes CONSUMES body.
    const id = await newCard(server.baseUrl);
    const viaNodes = await patchNode(server.baseUrl, id, { body: 'wiki prose' });
    assert.equal(viaNodes.status, 200);
    assert.ok(
      !(viaNodes.body.ignoredFields || []).includes('body'),
      '`body` must NOT be reported ignored on the nodes route — it is real here',
    );
    assert.equal((await readCard(server.baseUrl, id)).body.description, 'wiki prose');

    // Direction 2 — /api/cards REPORTS body as ignored, same server, same run.
    const cardRes = await fetch(`${server.baseUrl}/api/cards/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'card-side rename', body: 'should be discarded here' }),
    });
    const cardBody = await cardRes.json();
    assert.equal(cardRes.status, 200);
    assert.ok(
      (cardBody.ignoredFields || []).includes('body'),
      '`body` IS unknown on /api/cards and must be reported there',
    );

    // ⇒ A shared allowlist cannot satisfy both directions. This is the test
    //   that fails if someone later "unifies" the two routes' field sets.
    assert.equal(
      (await readCard(server.baseUrl, id)).body.description, 'wiki prose',
      'and the cards-route PATCH did not overwrite the wiki body it discarded',
    );
  } finally {
    await server.stop();
  }
});

test('#841 RC1c — `parent` and `attachments` are consumed, not reported', async () => {
  // Guards against a fix that lists only title+body and quietly turns the
  // other two consumed keys into false positives.
  const server = await startRestServer();
  try {
    const parentId = await newCard(server.baseUrl, { title: 'parent page' });
    const childId = await newCard(server.baseUrl, { title: 'child page' });
    const { status, body } = await patchNode(server.baseUrl, childId, {
      parent: parentId, attachments: [],
    });
    assert.equal(status, 200);
    assert.equal(
      body.ignoredFields, undefined,
      '`parent` and `attachments` are consumed by this route and must not be flagged',
    );
  } finally {
    await server.stop();
  }
});
