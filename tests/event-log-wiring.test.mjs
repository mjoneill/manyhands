/**
 * #669 — the event log wired into the write path, end to end through the real
 * server. `tests/event-log.test.mjs` proves the log module in isolation; this
 * proves the SERVER actually feeds it, which is the half a unit test cannot see.
 *
 * The log is named for its board file (`X.json` → `X-events/`), so each fixture
 * gets its own. ⚠️ That naming exists BECAUSE these tests caught the first cut:
 * `dirname(board)/events` looked isolated and wasn't — every test board lives
 * directly in os.tmpdir(), so all of them shared one log and a fresh server saw
 * 219 events from other files. Isolation follows the store's identity, not its
 * folder; two stores in one directory must never share an append-only record.
 *
 * ⚠️ Fixture actors are synthetic (`ada`/`bex`/`cyd`) per repo convention — real
 * seat names in fixtures are a publication-gate finding (learned 2026-08-04).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startRestServer } from './helpers/harness.mjs';
import { readEvents, replay } from '../core/event-log.mjs';

const json = (extra = {}) => ({ headers: { 'Content-Type': 'application/json' }, ...extra });

/** Every event the server has written for this fixture, in seq order. */
const logOf = (server) => readEvents(`${server.boardFile.replace(/\.json$/, '')}-events`);

function withServer(name, fn) {
  test(name, async () => {
    const server = await startRestServer();
    try { await fn(server); } finally { await server.stop(); }
  });
}

// ── the write path declares, and the log records ──────────────────────────

withServer('#669 creating a card appends ONE create event carrying its full state', async (s) => {
  const card = await (await fetch(`${s.baseUrl}/api/cards`, json({
    method: 'POST', body: JSON.stringify({ title: 'logged on create', createdBy: 'ada' }),
  }))).json();

  const evs = logOf(s);
  assert.equal(evs.length, 1, `expected exactly one event, got ${JSON.stringify(evs.map((e) => e.op))}`);
  assert.equal(evs[0].op, 'create');
  assert.equal(evs[0].entity.kind, 'card');
  assert.equal(evs[0].entity.id, card.id);
  assert.equal(evs[0].actor, 'ada', 'the declared actor reaches the log');
  assert.equal(evs[0].state.title, 'logged on create', 'state is the full entity, not a reference');
  assert.equal(evs[0].seq, 1);
});

withServer('#669 a claim writes card-update AND its announcement — two events, one write, in order', async (s) => {
  const card = await (await fetch(`${s.baseUrl}/api/cards`, json({
    method: 'POST', body: JSON.stringify({ title: 'claim me', createdBy: 'ada' }),
  }))).json();
  const before = logOf(s).length;

  const r = await fetch(`${s.baseUrl}/api/cards/${card.id}/claim`, json({
    method: 'POST', body: JSON.stringify({ by: 'bex' }),
  }));
  assert.equal(r.status, 200, 'claim should succeed on an unheld card');

  const added = logOf(s).slice(before);
  assert.equal(added.length, 2, `claim + announcement = 2 events, got ${JSON.stringify(added.map((e) => e.op))}`);
  assert.equal(added[0].entity.kind, 'card');
  assert.equal(added[0].state.claimedBy, 'bex');
  assert.equal(added[1].entity.kind, 'conversation');
  assert.equal(added[1].op, 'post');
  assert.equal(added[1].seq, added[0].seq + 1,
    'the announcement must sit immediately after the claim in the total order — "did the card '
    + 'change before or after the post about it" is the returning seat\'s actual question');
});

withServer('#669 the #614 inverse fan-out logs the SIBLING card too', async (s) => {
  const target = await (await fetch(`${s.baseUrl}/api/cards`, json({
    method: 'POST', body: JSON.stringify({ title: 'the target', createdBy: 'ada' }),
  }))).json();
  const before = logOf(s).length;

  // Relating TO the target rewrites the TARGET's relationships as well.
  const source = await (await fetch(`${s.baseUrl}/api/cards`, json({
    method: 'POST',
    body: JSON.stringify({
      title: 'the source', createdBy: 'cyd',
      relationships: { relatedTo: [target.shortId] },
    }),
  }))).json();

  const added = logOf(s).slice(before);
  const touchedTarget = added.find((e) => e.entity.id === target.id);
  assert.ok(touchedTarget,
    'the target card was mutated by the source\'s create and MUST have its own event — '
    + 'without it, #642\'s "field-level change answerable" is false for the target');
  assert.equal(touchedTarget.op, 'update');
  assert.ok(touchedTarget.state.relationships.relatedTo.includes(source.shortId),
    'the logged state must show the back-edge that was actually written');
});

withServer('#669 deleting a card writes a tombstone carrying its last body', async (s) => {
  const card = await (await fetch(`${s.baseUrl}/api/cards`, json({
    method: 'POST', body: JSON.stringify({ title: 'doomed', description: 'last words', createdBy: 'ada' }),
  }))).json();
  const before = logOf(s).length;

  await fetch(`${s.baseUrl}/api/cards/${card.id}`, { method: 'DELETE' });

  const added = logOf(s).slice(before);
  assert.equal(added.length, 1);
  assert.equal(added[0].op, 'delete');
  assert.equal(added[0].state.description, 'last words',
    'a tombstone keeps the body — "deleted is just a state" needs the state');
});

withServer('#669 a conversation post is logged as its own event', async (s) => {
  await fetch(`${s.baseUrl}/api/conversations`, json({
    method: 'POST', body: JSON.stringify({ body: 'into the log', author: 'cyd' }),
  }));
  const evs = logOf(s);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].op, 'post');
  assert.equal(evs[0].actor, 'cyd');
  assert.equal(evs[0].state.body, 'into the log');
});

// ── the load-bearing claim: the log can rebuild the store ─────────────────

withServer('#669 replaying the whole log reproduces the served board', async (s) => {
  await fetch(`${s.baseUrl}/api/cards`, json({
    method: 'POST', body: JSON.stringify({ title: 'one', createdBy: 'ada' }),
  }));
  const two = await (await fetch(`${s.baseUrl}/api/cards`, json({
    method: 'POST', body: JSON.stringify({ title: 'two', createdBy: 'bex' }),
  }))).json();
  await fetch(`${s.baseUrl}/api/cards/${two.id}`, json({
    method: 'PATCH', body: JSON.stringify({ title: 'two, edited' }),
  }));
  const doomed = await (await fetch(`${s.baseUrl}/api/cards`, json({
    method: 'POST', body: JSON.stringify({ title: 'three', createdBy: 'cyd' }),
  }))).json();
  await fetch(`${s.baseUrl}/api/cards/${doomed.id}`, { method: 'DELETE' });
  await fetch(`${s.baseUrl}/api/conversations`, json({
    method: 'POST', body: JSON.stringify({ body: 'and a message', author: 'ada' }),
  }));

  // Genesis is the board as it was before any of the above — the fixture's own
  // starting cards, which the log never described.
  const served = await (await fetch(`${s.baseUrl}/api/load?conversations=1`)).json();
  const evs = logOf(s);
  const loggedIds = new Set(evs.filter((e) => e.entity.kind === 'card').map((e) => e.entity.id));
  const genesis = {
    cards: served.cards.filter((c) => !loggedIds.has(c.id)),
    conversations: [], columns: served.columns,
  };

  const rebuilt = replay(genesis, evs);

  const byTitle = (arr) => arr.map((c) => c.title).sort();
  assert.deepEqual(byTitle(rebuilt.cards), byTitle(served.cards),
    'replaying the log onto genesis must reproduce exactly the cards the server serves');
  assert.ok(!rebuilt.cards.some((c) => c.id === doomed.id), 'the deleted card stays deleted through replay');
  assert.equal(rebuilt.cards.find((c) => c.id === two.id).title, 'two, edited',
    'the last write wins on replay, not the first');
  assert.equal(rebuilt.conversations.length, 1, 'the posted message is rebuilt from the log');
});

// ── the rail itself ───────────────────────────────────────────────────────

test('#669 writeBoard REFUSES a write that does not declare what it did', async () => {
  // The guard is the reason totality holds by construction rather than by
  // discipline: a future handler that forgets cannot write at all. Asserted on
  // the source because the function is module-private by design.
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(src, /function writeBoard\(data, events\)/,
    'writeBoard must take events as a required-by-shape parameter');
  assert.match(src, /!Array\.isArray\(events\) \|\| events\.length === 0[\s\S]{0,120}throw new Error/,
    'writeBoard must THROW on a missing or empty events list, not default it away');
});

// —— #675: PATCH and DELETE declare their actor — the last omission closes ——
// Additive and optional: a caller that sends nothing gets exactly the old
// behaviour (actor null); `by` never lands on the card itself (the #249
// unknown-key guard was already holding that door).

withServer('#675 a PATCH with by records the actor; by never lands on the card', async (s) => {
  const card = await (await fetch(`${s.baseUrl}/api/cards`, json({
    method: 'POST', body: JSON.stringify({ title: 'edit me', createdBy: 'ada' }),
  }))).json();
  const before = logOf(s).length;
  await fetch(`${s.baseUrl}/api/cards/${card.id}`, json({
    method: 'PATCH', body: JSON.stringify({ title: 'edited', by: 'bex' }),
  }));
  const ev = logOf(s).slice(before).find((e) => e.op === 'update');
  assert.equal(ev.actor, 'bex', 'the declared editor reaches the log');
  const served = await (await fetch(`${s.baseUrl}/api/cards/${card.id}`)).json();
  assert.equal(served.by, undefined, 'by is event metadata, never a card field');
});

withServer('#675 a DELETE with ?by= records the actor on the tombstone', async (s) => {
  const card = await (await fetch(`${s.baseUrl}/api/cards`, json({
    method: 'POST', body: JSON.stringify({ title: 'doomed', createdBy: 'ada' }),
  }))).json();
  const before = logOf(s).length;
  await fetch(`${s.baseUrl}/api/cards/${card.id}?by=cyd`, { method: 'DELETE' });
  const ev = logOf(s).slice(before).find((e) => e.op === 'delete');
  assert.equal(ev.actor, 'cyd', 'the declared deleter reaches the tombstone');
});

withServer('#675 the omission stays honest for silent callers: no by → actor null', async (s) => {
  const card = await (await fetch(`${s.baseUrl}/api/cards`, json({
    method: 'POST', body: JSON.stringify({ title: 'silent edit', createdBy: 'ada' }),
  }))).json();
  const before = logOf(s).length;
  await fetch(`${s.baseUrl}/api/cards/${card.id}`, json({
    method: 'PATCH', body: JSON.stringify({ title: 'still silent' }),
  }));
  assert.equal(logOf(s).slice(before)[0].actor, null, 'no invented attribution — null means unsaid');
});
