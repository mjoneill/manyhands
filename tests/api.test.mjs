/**
 * Server-side tests for the REST API (#105).
 *
 * Each test gets its own isolated server.js child + throwaway board file.
 * Behavior tests — assert on observable HTTP responses and persisted state,
 * not on internal calls.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

/** Run a test body with a fresh, isolated REST server. */
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

// ── /api/board ──────────────────────────────────────────────────────────

apiTest('GET /api/board returns the full board shape', async ({ baseUrl }) => {
  const res = await fetch(`${baseUrl}/api/board`);
  assert.equal(res.status, 200);
  const board = await res.json();
  assert.ok(Array.isArray(board.cards), 'cards is an array');
  assert.ok(Array.isArray(board.columns), 'columns is an array');
  assert.ok(Array.isArray(board.conversations), 'conversations is an array');
  assert.equal(typeof board.nextShortId, 'number');
});

// ── /api/cards ──────────────────────────────────────────────────────────

apiTest('POST /api/cards creates a card with server-assigned fields', async ({ baseUrl }) => {
  const res = await fetch(`${baseUrl}/api/cards`, json({
    method: 'POST',
    body: JSON.stringify({ title: 'Test card' }),
  }));
  assert.equal(res.status, 201);
  const card = await res.json();
  assert.equal(card.title, 'Test card');
  assert.equal(typeof card.shortId, 'number');
  assert.ok(card.id, 'has a UUID id');
  assert.ok(card.createdAt, 'has createdAt');
  assert.equal(card.column, 'backlog', 'defaults to backlog');
  assert.deepEqual(card.assignees, ['unassigned'], 'defaults to unassigned');
});

apiTest('POST /api/cards without a title is rejected 400', async ({ baseUrl }) => {
  const res = await fetch(`${baseUrl}/api/cards`, json({
    method: 'POST',
    body: JSON.stringify({ description: 'no title here' }),
  }));
  assert.equal(res.status, 400);
});

apiTest('POST /api/cards assigns incrementing shortIds', async ({ baseUrl }) => {
  const mk = async (title) =>
    (await fetch(`${baseUrl}/api/cards`, json({ method: 'POST', body: JSON.stringify({ title }) }))).json();
  const a = await mk('first');
  const b = await mk('second');
  assert.equal(b.shortId, a.shortId + 1);
});

apiTest('GET /api/cards/:id works by both shortId and UUID', async ({ baseUrl }) => {
  const created = await (await fetch(`${baseUrl}/api/cards`, json({
    method: 'POST', body: JSON.stringify({ title: 'lookup me' }),
  }))).json();

  const byShort = await fetch(`${baseUrl}/api/cards/${created.shortId}`);
  assert.equal(byShort.status, 200);
  assert.equal((await byShort.json()).id, created.id);

  const byUuid = await fetch(`${baseUrl}/api/cards/${created.id}`);
  assert.equal(byUuid.status, 200);
  assert.equal((await byUuid.json()).shortId, created.shortId);
});

apiTest('GET /api/cards/:id returns 404 for a missing card', async ({ baseUrl }) => {
  const res = await fetch(`${baseUrl}/api/cards/999999`);
  assert.equal(res.status, 404);
});

apiTest('PATCH /api/cards/:id updates a field and bumps updatedAt', async ({ baseUrl }) => {
  const created = await (await fetch(`${baseUrl}/api/cards`, json({
    method: 'POST', body: JSON.stringify({ title: 'patch me' }),
  }))).json();

  await new Promise((r) => setTimeout(r, 5)); // ensure updatedAt can differ
  const res = await fetch(`${baseUrl}/api/cards/${created.shortId}`, json({
    method: 'PATCH', body: JSON.stringify({ column: 'done' }),
  }));
  assert.equal(res.status, 200);
  const patched = await res.json();
  assert.equal(patched.column, 'done');
  assert.notEqual(patched.updatedAt, created.updatedAt, 'updatedAt advanced');
});

apiTest('PATCH /api/cards/:id cannot change immutable fields', async ({ baseUrl }) => {
  const created = await (await fetch(`${baseUrl}/api/cards`, json({
    method: 'POST', body: JSON.stringify({ title: 'immutable test' }),
  }))).json();

  const patched = await (await fetch(`${baseUrl}/api/cards/${created.shortId}`, json({
    method: 'PATCH',
    body: JSON.stringify({ id: 'hacked', shortId: 99999, createdAt: '1999-01-01T00:00:00Z' }),
  }))).json();

  assert.equal(patched.id, created.id, 'id unchanged');
  assert.equal(patched.shortId, created.shortId, 'shortId unchanged');
  assert.equal(patched.createdAt, created.createdAt, 'createdAt unchanged');
});

apiTest('DELETE /api/cards/:id removes the card', async ({ baseUrl }) => {
  const created = await (await fetch(`${baseUrl}/api/cards`, json({
    method: 'POST', body: JSON.stringify({ title: 'delete me' }),
  }))).json();

  const del = await fetch(`${baseUrl}/api/cards/${created.shortId}`, { method: 'DELETE' });
  assert.equal(del.status, 204);

  const after = await fetch(`${baseUrl}/api/cards/${created.shortId}`);
  assert.equal(after.status, 404, 'card is gone');
});

apiTest('DELETE /api/cards/:id returns 404 for a missing card', async ({ baseUrl }) => {
  const res = await fetch(`${baseUrl}/api/cards/999999`, { method: 'DELETE' });
  assert.equal(res.status, 404);
});

// ── /api/columns ────────────────────────────────────────────────────────

apiTest('POST /api/columns creates a column; rejects missing name', async ({ baseUrl }) => {
  const ok = await fetch(`${baseUrl}/api/columns`, json({
    method: 'POST', body: JSON.stringify({ name: 'Review' }),
  }));
  assert.equal(ok.status, 201);
  assert.equal((await ok.json()).name, 'Review');

  const bad = await fetch(`${baseUrl}/api/columns`, json({
    method: 'POST', body: JSON.stringify({ order: 5 }),
  }));
  assert.equal(bad.status, 400);
});

apiTest('PATCH /api/columns/:id renames a column', async ({ baseUrl }) => {
  const res = await fetch(`${baseUrl}/api/columns/backlog`, json({
    method: 'PATCH', body: JSON.stringify({ name: 'Icebox' }),
  }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).name, 'Icebox');
});

// ── /api/conversations ──────────────────────────────────────────────────

apiTest('POST /api/conversations creates a message', async ({ baseUrl }) => {
  const res = await fetch(`${baseUrl}/api/conversations`, json({
    method: 'POST', body: JSON.stringify({ body: 'hello room', author: 'sage' }),
  }));
  assert.equal(res.status, 201);
  const conv = await res.json();
  assert.equal(conv.body, 'hello room');
  assert.equal(conv.author, 'sage');
  assert.equal(conv.attachedTo, null);
  assert.ok(conv.id && conv.createdAt);
});

apiTest('POST /api/conversations rejects empty body or author', async ({ baseUrl }) => {
  const noBody = await fetch(`${baseUrl}/api/conversations`, json({
    method: 'POST', body: JSON.stringify({ body: '   ', author: 'sage' }),
  }));
  assert.equal(noBody.status, 400);

  const noAuthor = await fetch(`${baseUrl}/api/conversations`, json({
    method: 'POST', body: JSON.stringify({ body: 'real text' }),
  }));
  assert.equal(noAuthor.status, 400);
});

apiTest('GET /api/conversations filters by since and author', async ({ baseUrl }) => {
  const post = (body, author) => fetch(`${baseUrl}/api/conversations`, json({
    method: 'POST', body: JSON.stringify({ body, author }),
  })).then((r) => r.json());

  // Use server-stamped timestamps, not a client clock — avoids same-ms
  // collisions with the inclusive (>=) `since` filter.
  const first = await post('first', 'alex');
  await new Promise((r) => setTimeout(r, 10));
  const second = await post('second', 'sage');
  assert.ok(first.createdAt < second.createdAt, 'posts are strictly ordered');

  // since = second's own timestamp; the >= filter returns exactly 'second'.
  const since = await (await fetch(
    `${baseUrl}/api/conversations?since=${encodeURIComponent(second.createdAt)}`,
  )).json();
  assert.equal(since.length, 1, 'only the post at-or-after the cutoff');
  assert.equal(since[0].body, 'second');

  const byAuthor = await (await fetch(`${baseUrl}/api/conversations?author=alex`)).json();
  assert.equal(byAuthor.length, 1);
  assert.equal(byAuthor[0].author, 'alex');
});

// ── #210: backward pagination — ?before & ?limit (bounded load + load-older) ──
// Slice 2 of #208: the browser loads recent-N and walks older on scroll-up,
// never losing access. No-param stays UNCAPPED (the #202 invariant).
function _convSeq(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    body: `msg ${i}`,
    author: 'alex',
    attachedTo: null,
    // chronological: m0 oldest … m(n-1) newest (fixed-width fields → lexical = chrono)
    createdAt: `2026-06-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
    mentions: [],
  }));
}

test('#210: ?limit=N returns the N MOST-RECENT conversations', async () => {
  const rest = await startRestServer({ board: makeBoardFixture({ conversations: _convSeq(10) }) });
  try {
    const got = await (await fetch(`${rest.baseUrl}/api/conversations?limit=3`)).json();
    assert.deepEqual(got.map((c) => c.id), ['m7', 'm8', 'm9'], 'the 3 newest, in chronological order');
  } finally { await rest.stop(); }
});

test('#210: ?before=<ts> returns only conversations strictly older than the cursor', async () => {
  const all = _convSeq(10);
  const rest = await startRestServer({ board: makeBoardFixture({ conversations: all }) });
  try {
    const got = await (await fetch(`${rest.baseUrl}/api/conversations?before=${encodeURIComponent(all[5].createdAt)}`)).json();
    assert.deepEqual(got.map((c) => c.id), ['m0', 'm1', 'm2', 'm3', 'm4'], 'strictly older than m5');
  } finally { await rest.stop(); }
});

test('#210: ?before=<ts>&limit=N returns the N most-recent OLDER messages (the load-older chunk)', async () => {
  const all = _convSeq(10);
  const rest = await startRestServer({ board: makeBoardFixture({ conversations: all }) });
  try {
    const got = await (await fetch(`${rest.baseUrl}/api/conversations?before=${encodeURIComponent(all[5].createdAt)}&limit=2`)).json();
    assert.deepEqual(got.map((c) => c.id), ['m3', 'm4'], 'the 2 newest among those older than m5');
  } finally { await rest.stop(); }
});

test('#210: ?limit is capped to bound the response (no resource exhaustion)', async () => {
  const rest = await startRestServer({ board: makeBoardFixture({ conversations: _convSeq(250) }) });
  try {
    const got = await (await fetch(`${rest.baseUrl}/api/conversations?limit=1000000`)).json();
    assert.ok(got.length <= 200, `capped (got ${got.length})`);
    assert.equal(got[got.length - 1].id, 'm249', 'still includes the newest');
  } finally { await rest.stop(); }
});

test('#210: no-param list stays UNCAPPED (the #202 invariant my change must not break)', async () => {
  const rest = await startRestServer({ board: makeBoardFixture({ conversations: _convSeq(250) }) });
  try {
    const got = await (await fetch(`${rest.baseUrl}/api/conversations`)).json();
    assert.equal(got.length, 250, 'no-param returns full history');
  } finally { await rest.stop(); }
});

test('#210: a non-numeric ?limit is ignored, not an error', async () => {
  const rest = await startRestServer({ board: makeBoardFixture({ conversations: _convSeq(10) }) });
  try {
    const res = await fetch(`${rest.baseUrl}/api/conversations?limit=abc`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).length, 10, 'invalid limit → no cap applied, full filtered set');
  } finally { await rest.stop(); }
});

// ── Regression: /api/save must not clobber conversations (#117) ──────────

apiTest('POST /api/save preserves conversations the payload omits (#117)', async ({ baseUrl }) => {
  // Seed a conversation through the API.
  await fetch(`${baseUrl}/api/conversations`, json({
    method: 'POST', body: JSON.stringify({ body: 'do not clobber me', author: 'sage' }),
  }));

  // Legacy whole-board save with NO conversations field — the exact shape
  // the browser sends. Pre-fix, this wiped the commons.
  const board = await (await fetch(`${baseUrl}/api/board`)).json();
  const legacyPayload = {
    cards: board.cards,
    columns: board.columns,
    nextShortId: board.nextShortId,
    lastUpdated: new Date().toISOString(),
  };
  const save = await fetch(`${baseUrl}/api/save`, json({
    method: 'POST', body: JSON.stringify(legacyPayload),
  }));
  assert.equal(save.status, 200);

  const convs = await (await fetch(`${baseUrl}/api/conversations`)).json();
  assert.equal(convs.length, 1, 'conversation survived the legacy save');
  assert.equal(convs[0].body, 'do not clobber me');
});

// ── Regression: /api/save must not let a stale client clobber cards (#230) ──
// 2026-06-15: a stale browser tab saved its old localStorage and rolled back 8
// cards. The browser deletes ONE card per save, so a save vanishing many cards
// is a stale-state clobber, never a legit action — refuse it.

apiTest('POST /api/save refuses a stale wholesale card-delete (clobber guard #230)', async ({ baseUrl }) => {
  for (const t of ['a', 'b', 'c', 'd']) {
    await fetch(`${baseUrl}/api/cards`, json({ method: 'POST', body: JSON.stringify({ title: t }) }));
  }
  const before = await (await fetch(`${baseUrl}/api/board`)).json();
  assert.equal(before.cards.length, 4);

  // A stale client saves a board missing 3 of the 4 cards.
  const stale = {
    cards: [before.cards[0]],
    columns: before.columns,
    nextShortId: before.nextShortId,
    lastUpdated: new Date().toISOString(),
  };
  const res = await fetch(`${baseUrl}/api/save`, json({ method: 'POST', body: JSON.stringify(stale) }));
  assert.equal(res.status, 409, 'a save vanishing 3 cards is refused');

  const after = await (await fetch(`${baseUrl}/api/board`)).json();
  assert.equal(after.cards.length, 4, 'no cards were deleted — the clobber was prevented');
});

apiTest('POST /api/save still allows a normal single-card delete', async ({ baseUrl }) => {
  for (const t of ['a', 'b', 'c']) {
    await fetch(`${baseUrl}/api/cards`, json({ method: 'POST', body: JSON.stringify({ title: t }) }));
  }
  const before = await (await fetch(`${baseUrl}/api/board`)).json();
  assert.equal(before.cards.length, 3);

  // Drop exactly one card — the normal browser delete-by-save.
  const payload = {
    cards: before.cards.slice(0, 2),
    columns: before.columns,
    nextShortId: before.nextShortId,
    lastUpdated: new Date().toISOString(),
  };
  const res = await fetch(`${baseUrl}/api/save`, json({ method: 'POST', body: JSON.stringify(payload) }));
  assert.equal(res.status, 200, 'dropping one card is a legit delete');

  const after = await (await fetch(`${baseUrl}/api/board`)).json();
  assert.equal(after.cards.length, 2, 'the single delete persisted');
});

apiTest('GET /api/load returns the legacy {cards} shape even when on-disk is JSON-LD (#235)', async ({ baseUrl }) => {
  // Any write flips the on-disk format to schema.org JSON-LD (saveDomain, #227).
  // /api/load must still hand the browser the legacy {cards,…} shape it parses,
  // not the raw @graph document — else the board can't hydrate from the server.
  await fetch(`${baseUrl}/api/cards`, json({ method: 'POST', body: JSON.stringify({ title: 'flip to jsonld' }) }));
  const data = await (await fetch(`${baseUrl}/api/load`)).json();
  assert.ok(Array.isArray(data.cards), '/api/load exposes cards[]; got keys: ' + Object.keys(data).join(','));
  assert.ok(data.cards.some((c) => c.title === 'flip to jsonld'), 'the created card is present in /api/load');
  assert.ok(!('@graph' in data), '/api/load must not leak the raw JSON-LD document');
});

// #671 — BOTH directions of the /api/load conversations contract, in one test,
// because breaking either one broke something real:
//
//   default lean   (#657) — 18.7MB the browser never reads. Re-fattening it is a
//                           silent 20x payload regression nobody would notice.
//   ?conversations=1 (#671) — bulk consumers (export-board.mjs) read the room
//                           here. When #657 removed it unconditionally, the
//                           export's data source went to zero for a full day.
//
// The honest `conversationsOmitted` flag was already there and nobody consumed
// it — a flag is not a consumer enumeration. This test is the part that refuses.
apiTest('GET /api/load omits conversations by default and returns them on opt-in (#657/#671)', async ({ baseUrl }) => {
  await fetch(`${baseUrl}/api/conversations`, json({
    method: 'POST', body: JSON.stringify({ body: 'a message the archive must be able to reach', author: 'ada' }),
  }));

  const lean = await (await fetch(`${baseUrl}/api/load`)).json();
  assert.deepEqual(lean.conversations, [], 'the DEFAULT must stay lean — #657 is not to be reverted');
  assert.equal(lean.conversationsOmitted, true, 'the omission must stay self-describing');

  const full = await (await fetch(`${baseUrl}/api/load?conversations=1`)).json();
  assert.ok(full.conversations.length >= 1,
    'a bulk consumer opting in must receive the room — this is export-board.mjs\'s only data source (#671)');
  assert.ok(!full.conversationsOmitted,
    'the opt-in response must not claim an omission it did not make');
  assert.ok(full.conversations.some((m) => m.body?.includes('the archive must be able to reach')),
    'the opt-in must return the actual messages, not an empty array with a friendlier flag');
});

apiTest('every write re-injects the _README block', async ({ baseUrl, readBoardFile }) => {
  await fetch(`${baseUrl}/api/cards`, json({
    method: 'POST', body: JSON.stringify({ title: 'trigger a write' }),
  }));
  const onDisk = readBoardFile();
  assert.ok(Array.isArray(onDisk._README), '_README is present after a write');
  assert.ok(onDisk._README.join(' ').includes('DO NOT EDIT'), '_README carries the warning');
});

// ── Mutex: concurrent writes must not collide ───────────────────────────

apiTest('concurrent POST /api/cards yields unique shortIds (mutex holds)', async ({ baseUrl }) => {
  const N = 12;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      fetch(`${baseUrl}/api/cards`, json({
        method: 'POST', body: JSON.stringify({ title: `concurrent ${i}` }),
      })).then((r) => r.json()),
    ),
  );
  const shortIds = results.map((c) => c.shortId);
  assert.equal(new Set(shortIds).size, N, 'all shortIds are distinct — no interleave');
});

// ── #110 — @mention extraction + ?mentions_me filter ────────────────────

apiTest('#110 conversations store @mentions extracted from the body', async ({ baseUrl }) => {
  const conv = await (await fetch(`${baseUrl}/api/conversations`, json({
    method: 'POST', body: JSON.stringify({ body: 'hey @sage, take a look', author: 'alex' }),
  }))).json();
  assert.deepEqual(conv.mentions, ['sage']);
});

apiTest('#110 mention extraction is case-insensitive and de-duplicated', async ({ baseUrl }) => {
  const conv = await (await fetch(`${baseUrl}/api/conversations`, json({
    method: 'POST', body: JSON.stringify({ body: '@Sage @sage @Robin', author: 'nova' }),
  }))).json();
  assert.deepEqual([...conv.mentions].sort(), ['robin', 'sage']);
});

apiTest('#110 a message with no @mention stores an empty mentions array', async ({ baseUrl }) => {
  const conv = await (await fetch(`${baseUrl}/api/conversations`, json({
    method: 'POST', body: JSON.stringify({ body: 'just a plain message', author: 'kit' }),
  }))).json();
  assert.deepEqual(conv.mentions, []);
});

apiTest('#110 GET ?mentions_me returns only messages mentioning that name', async ({ baseUrl }) => {
  const post = (body, author) => fetch(`${baseUrl}/api/conversations`, json({
    method: 'POST', body: JSON.stringify({ body, author }),
  }));
  await post('@sage can you check this', 'alex');
  await post('nothing for anyone here', 'nova');
  await post('@robin and @sage both', 'kit');

  const mine = await (await fetch(`${baseUrl}/api/conversations?mentions_me=sage`)).json();
  assert.equal(mine.length, 2, 'two messages mention sage');
  assert.ok(mine.every((c) => c.mentions.includes('sage')));
});

apiTest('#110 ?mentions_me combines with ?since', async ({ baseUrl }) => {
  const post = (body) => fetch(`${baseUrl}/api/conversations`, json({
    method: 'POST', body: JSON.stringify({ body, author: 'alex' }),
  })).then((r) => r.json());
  await post('@sage early message');
  await new Promise((r) => setTimeout(r, 10));
  const pivot = await post('@sage later message');
  await post('a later message mentioning nobody');   // after pivot, no @sage

  // since alone would return 2 (pivot + the nobody message); mentions_me
  // must narrow it to the one that is BOTH recent and mentions sage.
  const combined = await (await fetch(
    `${baseUrl}/api/conversations?mentions_me=sage&since=${encodeURIComponent(pivot.createdAt)}`,
  )).json();
  assert.equal(combined.length, 1, 'only the recent message that also mentions sage');
  assert.equal(combined[0].body, '@sage later message');
});

test('#110 pre-existing conversations get mentions backfilled on read', async () => {
  const board = makeBoardFixture({
    conversations: [
      {
        id: 'legacy-1',
        body: 'an old message for @nova, written before #110',
        author: 'alex',
        attachedTo: null,
        createdAt: '2026-05-01T00:00:00.000Z',
      },
      {
        id: 'legacy-2',
        body: 'an old message mentioning no one at all',
        author: 'kit',
        attachedTo: null,
        createdAt: '2026-05-01T01:00:00.000Z',
      },
    ],
  });
  const server = await startRestServer({ board });
  try {
    const novas = await (await fetch(`${server.baseUrl}/api/conversations?mentions_me=nova`)).json();
    assert.equal(novas.length, 1, 'only the legacy message mentioning nova (backfilled)');
    assert.equal(novas[0].id, 'legacy-1');
  } finally {
    await server.stop();
  }
});

// ── #699 — mention extraction validates against the ROSTER ──────────────
//
// The naive @(\w+) scan recorded 86 distinct "people" for a 6-person room:
// JSON-LD terms (@context, @id, @type), email domains (@gmail, @anthropic),
// npm tags (@latest), handles, and dates (@2026). Inert while mentions are a
// literal — and ~77 phantom Person nodes the moment they become IRIs, which
// is the obvious next graph slice. Cheaper to clear before than after.

apiTest('#699 an @token that is not a roster seat is NOT recorded as a mention', async ({ baseUrl }) => {
  const conv = await (await fetch(`${baseUrl}/api/conversations`, json({
    method: 'POST',
    body: JSON.stringify({
      body: 'the @context prefix, my @gmail address, tagged @latest, back in @2026',
      author: 'alex',
    }),
  }))).json();
  assert.deepEqual(conv.mentions, [],
    'JSON-LD terms, email domains, npm tags and years are not colleagues');
  assert.match(conv.body, /@context/,
    'and the text is UNTOUCHED — this filters the mentions list, never the prose');
});

apiTest('#699 POSITIVE CONTROL: a real seat in the same body is still recorded', async ({ baseUrl }) => {
  // Without this, the filter passes for an extractor that drops everything.
  const conv = await (await fetch(`${baseUrl}/api/conversations`, json({
    method: 'POST',
    body: JSON.stringify({ body: '@context is a term but @sage is a person', author: 'alex' }),
  }))).json();
  assert.deepEqual(conv.mentions, ['sage'], 'the seat survives, the term does not');
});

apiTest('#699 a display name canonicalises to the seat key', async ({ baseUrl }) => {
  // The live board carries one seat under four spellings, splitting ~1,850
  // mentions. The roster already knows key -> display name, so the alias
  // needs no new config: match either, record the key.
  const conv = await (await fetch(`${baseUrl}/api/conversations`, json({
    method: 'POST', body: JSON.stringify({ body: 'ping @Sage and @sage', author: 'kit' }),
  }))).json();
  assert.deepEqual(conv.mentions, ['sage'],
    'display-name and key forms collapse to one canonical key, de-duplicated');
});

apiTest('#699 an unknown @token never mints a person, even mixed with real ones', async ({ baseUrl }) => {
  const conv = await (await fetch(`${baseUrl}/api/conversations`, json({
    method: 'POST',
    body: JSON.stringify({ body: '@robin @notaseat @sage @vocab', author: 'nova' }),
  }))).json();
  assert.deepEqual([...conv.mentions].sort(), ['robin', 'sage'],
    'exactly the roster seats, nothing else');
});

apiTest('#699 ?mentions_me still finds a post that used the display name', async ({ baseUrl }) => {
  // The read path keys on the canonical form, so canonicalising on write is
  // what makes the query answer correctly for either spelling.
  await fetch(`${baseUrl}/api/conversations`, json({
    method: 'POST', body: JSON.stringify({ body: 'over to @Sage', author: 'alex' }),
  }));
  const hits = await (await fetch(`${baseUrl}/api/conversations?mentions_me=sage`)).json();
  assert.ok(hits.some((c) => /over to @Sage/.test(c.body)),
    'a display-name mention is findable by the canonical key');
});
