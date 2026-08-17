/**
 * #843 — THE LAST TWO SILENT WRITE SURFACES.
 *
 * `POST /api/conversations` and `PATCH /api/columns` accepted an unknown key,
 * returned 2xx, discarded the data, and said nothing. Every earlier fix in this
 * family (#823 PATCH cards, #829 POST cards, #841 PATCH nodes) was scoped to the
 * surface where someone got burned; these two were found by asking the question
 * of every surface at once, before anyone was burned.
 *
 * ⛔ EACH ROUTE COMPUTES ITS OWN CONSUMED-SET, BESIDE ITS OWN HANDLER.
 *
 * "Unknown" is route-relative and this family has proven it three times: `body`
 * is real on /api/nodes and unknown on /api/cards; `priority` is the reverse; a
 * conversation has its own vocabulary again. A shared allowlist is the obvious
 * future tidy and it is WRONG — the route-locality test below exists to fail
 * when someone attempts it.
 *
 * ⚠️ THE PAIRED CONTROL IS NOT OPTIONAL. A diagnostic that fires on ordinary
 * traffic trains the room to skip it within a week, taking the working rules
 * down with it (#844). Every "names the junk" assertion here has a partner
 * asserting silence on a clean request — and the consumed-sets were derived from
 * what the real clients send (browser posts {body, author, attachments}; MCP
 * column_update sends {name, order}), so silence in production is by
 * construction, not by hope.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer } from './helpers/harness.mjs';

const JUNK = 'zzz_843_probe_not_a_real_field';

const post = async (baseUrl, path, body) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const patch = async (baseUrl, path, body) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const firstColumn = async (baseUrl) => (await (await fetch(`${baseUrl}/api/columns`)).json())[0];

// ── RC1 — each route reports what it discarded, and NAMES the key ────────────

test('#843 POST /api/conversations names the key it dropped, and still stores the legal half', async () => {
  const server = await startRestServer();
  try {
    const r = await post(server.baseUrl, '/api/conversations',
      { body: 'a real post', author: 'ada', [JUNK]: 'x' });

    assert.equal(r.status, 201, 'report-and-proceed (#249 posture, ratified at #844) — not a 400');
    assert.equal(r.body.body, 'a real post', 'control: the legal half of the write landed');
    assert.deepEqual(r.body.ignoredFields, [JUNK], 'the diagnostic must NAME the field, not merely exist');
  } finally {
    await server.stop();
  }
});

test('#843 POST /api/conversations is SILENT on a clean post — the paired control', async () => {
  // This is the exact body the browser sends (index.html postConversation).
  // If this ever reports, every seat sees a diagnostic on every message and
  // learns to ignore the field — the always-fires rule that #844 exists to stop.
  const server = await startRestServer();
  try {
    const r = await post(server.baseUrl, '/api/conversations',
      { body: 'ordinary traffic', author: 'ada', attachments: [] });

    assert.equal(r.status, 201);
    assert.equal(r.body.ignoredFields, undefined,
      `a clean post must report nothing — got ${JSON.stringify(r.body.ignoredFields)}`);
  } finally {
    await server.stop();
  }
});

test('#843 PATCH /api/columns names the key it dropped, and still applies the rename', async () => {
  const server = await startRestServer();
  try {
    const col = await firstColumn(server.baseUrl);
    const r = await patch(server.baseUrl, `/api/columns/${col.id}`, { name: 'Renamed', [JUNK]: 'x' });

    assert.equal(r.status, 200);
    assert.equal(r.body.name, 'Renamed', 'control: the legal half landed');
    assert.deepEqual(r.body.ignoredFields, [JUNK]);
  } finally {
    await server.stop();
  }
});

test('#843 PATCH /api/columns is SILENT on a clean rename — the paired control', async () => {
  // The exact shape MCP column_update sends: {name} / {order}, id in the URL.
  const server = await startRestServer();
  try {
    const col = await firstColumn(server.baseUrl);
    const r = await patch(server.baseUrl, `/api/columns/${col.id}`, { name: 'Clean', order: 0 });

    assert.equal(r.status, 200);
    assert.equal(r.body.ignoredFields, undefined,
      `the shape every real client sends must report nothing — got ${JSON.stringify(r.body.ignoredFields)}`);
    assert.equal(r.body.refusedFields, undefined);
  } finally {
    await server.stop();
  }
});

// ── #844 consistency — an echo is not an attempt ─────────────────────────────

test('#843 a column read-modify-write is silent: the echoed id is not an attempt', async () => {
  // GET a column, change one field, send it all back — the most ordinary client
  // pattern in existence. `id` is immutable, and reporting it here would be
  // #844's defect reproduced on a new surface.
  const server = await startRestServer();
  try {
    const col = await firstColumn(server.baseUrl);
    const r = await patch(server.baseUrl, `/api/columns/${col.id}`, { ...col, name: 'RMW' });

    assert.equal(r.status, 200);
    assert.equal(r.body.name, 'RMW', 'the one intended change landed');
    assert.equal(r.body.refusedFields, undefined,
      `an echoed immutable must be silent — got ${JSON.stringify(r.body.refusedFields)}`);
    assert.equal(r.body.ignoredFields, undefined);
  } finally {
    await server.stop();
  }
});

test('#843 a REAL attempt to change a column id is still refused and named', async () => {
  // The anti-overreach control: suppressing echoes must not suppress findings.
  const server = await startRestServer();
  try {
    const col = await firstColumn(server.baseUrl);
    const r = await patch(server.baseUrl, `/api/columns/${col.id}`, { id: 'something-else', name: 'Kept' });

    assert.equal(r.status, 200);
    assert.deepEqual(r.body.refusedFields, ['id'], 'a genuine attempt on an immutable must be named');
    assert.equal(r.body.name, 'Kept', 'and the legal half still lands');

    const fresh = await firstColumn(server.baseUrl);
    assert.equal(fresh.id, col.id, 'the id is genuinely immutable — the diagnostic is not the only guard');
  } finally {
    await server.stop();
  }
});

// ── RC3 — route-locality PROVEN in one run, not assumed ──────────────────────

test('#843 RC3 the same key is consumed on one route and reported-ignored on the other', async () => {
  // ⛔ THIS TEST FAILS IF SOMEONE FACTORS THE TWO CONSUMED-SETS INTO ONE
  // SHARED ALLOWLIST. That refactor looks like tidying and is the bug: a union
  // would make both routes accept both keys silently; an intersection would
  // make both report their own real fields as ignored.
  const server = await startRestServer();
  try {
    const col = await firstColumn(server.baseUrl);

    // `attachedTo` — real on conversations, unknown on columns.
    const card = await post(server.baseUrl, '/api/cards', { title: 'target', createdBy: 'ada' });
    const conv = await post(server.baseUrl, '/api/conversations',
      { body: 'attached', author: 'ada', attachedTo: card.body.id });
    assert.equal(conv.body.attachedTo, card.body.id, 'consumed on conversations');
    assert.equal(conv.body.ignoredFields, undefined, 'and therefore not reported there');

    const colA = await patch(server.baseUrl, `/api/columns/${col.id}`, { attachedTo: card.body.id });
    assert.deepEqual(colA.body.ignoredFields, ['attachedTo'], 'unknown on columns, and named');

    // `order` — real on columns, unknown on conversations. The mirror image, so
    // the result cannot be explained by one route simply being stricter.
    const colB = await patch(server.baseUrl, `/api/columns/${col.id}`, { order: 3 });
    assert.equal(colB.body.order, 3, 'consumed on columns');
    assert.equal(colB.body.ignoredFields, undefined);

    const convB = await post(server.baseUrl, '/api/conversations',
      { body: 'ordered?', author: 'ada', order: 3 });
    assert.deepEqual(convB.body.ignoredFields, ['order'], 'unknown on conversations, and named');
  } finally {
    await server.stop();
  }
});

test('#843 a server-DERIVED conversation field is reported when a client sends it', async () => {
  // `mentions` is computed from the body text. A client-supplied value is
  // discarded — and a caller who believes their value was stored would build on
  // a mention list the server never agreed to.
  const server = await startRestServer();
  try {
    const r = await post(server.baseUrl, '/api/conversations',
      { body: 'hello @ada', author: 'grace', mentions: ['everyone'], createdAt: '2020-01-01T00:00:00.000Z' });

    assert.equal(r.status, 201);
    assert.deepEqual(r.body.ignoredFields, ['createdAt', 'mentions'], 'both derived fields named, sorted');

    // ⚠️ Asserted against the CLIENT'S value, not against a real mention.
    // `extractMentions` is roster-bounded, and `ada` is a synthetic seat that is
    // deliberately not on any roster — so the server's honest answer here is
    // `[]`. That still discriminates: had the client's array been stored, this
    // would read `['everyone']`. Asserting a real mention would require a real
    // seat key, which does not belong in the suite.
    assert.deepEqual(r.body.mentions, [], 'the SERVER-derived value is what was stored');
    assert.notDeepEqual(r.body.mentions, ['everyone'], 'the client-supplied mention list was discarded');
    assert.notEqual(r.body.createdAt, '2020-01-01T00:00:00.000Z', 'the client timestamp was not honoured');
  } finally {
    await server.stop();
  }
});
