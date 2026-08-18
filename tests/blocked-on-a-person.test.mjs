/**
 * #881 — "waiting on a person" becomes queryable.
 *
 * ⛔ THE FAILURE THAT PRODUCED THIS, hit live 2026-08-18T17:57Z. The owner asked
 * what he owed the room on the cards and no query could answer it. The board's
 * only representation of "gated on a person" is prose, so the answer came from
 * a regex over sentences: 29 hits, narrowed to 14, most of them stale — one of
 * them a card resolved hours earlier. A text match returns the union of "is
 * gated on him" and "once mentioned him", and nothing separates them.
 *
 * The cost was already paid: #425 sat 24 DAYS on a ten-second decision, and
 * surfaced only because someone happened to grep. The board could not tell him.
 *
 * ⭐ THE SHAPE — extend what exists, do not mint a rival. `blockers` already
 * carries {card, owner, status, note} and already refuses an entry naming a card
 * that does not block. The gap is that a blocker could only ever BE a card.
 *
 *   blockers: [{ person: 'ada', status: 'open', note: 'edit-mode choice' }]
 *
 * ⚠️ `person` and `owner` are DIFFERENT and the distinction is the whole design:
 *   owner   — who is clearing a blocker that is a CARD
 *   person  — the person's pending action IS the blocker
 * Conflating them would make "waiting on that person" indistinguishable from
 * "that person is chasing the card that blocks this", which are opposite states.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const api = async (baseUrl, method, path, body) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
};

const board = () => makeBoardFixture({
  cards: [
    { id: 'u-1', shortId: 1, title: 'needs a decision', description: '', type: 'task',
      labels: [], assignees: [], column: 'in-progress', order: 1,
      createdAt: '2026-08-01T00:00:00.000Z',
      relationships: { relatedTo: [], blockedBy: [2], supersedes: [], derivedFrom: [], supersededBy: [] } },
    { id: 'u-2', shortId: 2, title: 'a blocking card', description: '', type: 'task',
      labels: [], assignees: [], column: 'backlog', order: 2,
      createdAt: '2026-08-01T00:00:00.000Z', relationships: {} },
  ],
  nextShortId: 3,
});

test('#881 a card can be blocked on a PERSON, with no blocking card', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const r = await api(s.baseUrl, 'PATCH', '/api/cards/1', {
      blockers: [{ person: 'ada', status: 'open', note: 'edit-mode choice' }], by: 'ada',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ignoredFields, undefined, 'must not be validated-then-discarded');

    const fresh = await api(s.baseUrl, 'GET', '/api/cards/1');
    assert.deepEqual(fresh.body.blockers,
      [{ person: 'ada', status: 'open', note: 'edit-mode choice' }]);
  } finally { await s.stop(); }
});

test('#881 THE CONCIERGE QUERY — "what is waiting on me", in one query', async () => {
  // ⭐ This is the question that had no answer. It is the whole card.
  const s = await startRestServer({ board: board() });
  try {
    await api(s.baseUrl, 'PATCH', '/api/cards/1', {
      blockers: [{ person: 'ada', status: 'open', note: 'edit-mode choice' }], by: 'ada',
    });
    const q = await api(s.baseUrl, 'POST', '/api/graph', {
      query: `SELECT ?id ?title ?note WHERE {
        ?b a scrum:Blocker ; scrum:blockedByPerson person:ada ; scrum:status "open" ;
           scrum:blocks ?c .
        OPTIONAL { ?b scrum:note ?note }
        ?c schema:identifier ?id ; schema:name ?title .
      }`,
    });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.deepEqual(q.body.rows, [{ id: '1', title: 'needs a decision', note: 'edit-mode choice' }],
      'one query, no prose matched');
  } finally { await s.stop(); }
});

test('#881 a CLEARED person-blocker drops out of "waiting on me"', async () => {
  // ⚠️ The rot this card predicted: a person-blocker that never clears is a
  // structured version of the same lie the prose told. Status must actually
  // filter, or the standing query accumulates instead of converging.
  const s = await startRestServer({ board: board() });
  try {
    await api(s.baseUrl, 'PATCH', '/api/cards/1', {
      blockers: [{ person: 'ada', status: 'cleared', note: 'he chose' }], by: 'ada',
    });
    const q = await api(s.baseUrl, 'POST', '/api/graph', {
      query: 'SELECT ?id WHERE { ?b a scrum:Blocker ; scrum:blockedByPerson person:ada ; '
        + 'scrum:status "open" ; scrum:blocks ?c . ?c schema:identifier ?id }',
    });
    assert.equal(q.body.rows.length, 0, 'cleared means gone from the queue');

    // Paired control: it still EXISTS, so the record of having waited survives.
    const all = await api(s.baseUrl, 'POST', '/api/graph', {
      query: 'SELECT ?st WHERE { ?b a scrum:Blocker ; scrum:blockedByPerson person:ada ; scrum:status ?st }',
    });
    assert.deepEqual(all.body.rows, [{ st: 'cleared' }],
      'the record stays; only the status changed — same shape as the miss log');
  } finally { await s.stop(); }
});

test('#881 person and card blockers COEXIST on one card and stay distinguishable', async () => {
  const s = await startRestServer({ board: board() });
  try {
    await api(s.baseUrl, 'PATCH', '/api/cards/1', {
      blockers: [
        { card: 2, owner: 'grace', status: 'open' },
        { person: 'ada', status: 'open' },
      ], by: 'ada',
    });
    const q = await api(s.baseUrl, 'POST', '/api/graph', {
      query: `SELECT ?kind WHERE {
        ?b a scrum:Blocker ; scrum:blocks ?c .
        ?c schema:identifier "1" .
        OPTIONAL { ?b scrum:blockedByCard ?bc }
        OPTIONAL { ?b scrum:blockedByPerson ?bp }
        BIND(IF(BOUND(?bp), "person", "card") AS ?kind)
      } ORDER BY ?kind`,
    });
    assert.deepEqual(q.body.rows.map((r) => r.kind), ['card', 'person'],
      'two blockers, two kinds, told apart by predicate rather than by reading a note');
  } finally { await s.stop(); }
});

test('#881 owner and person are NOT the same thing', async () => {
  // ⛔ THE DISTINCTION THAT MUST NOT COLLAPSE.
  //   owner  — that person is chasing the card that blocks this
  //   person — that person's own pending action IS the block
  // These are opposite states, and a query for "waiting on that person" must return
  // only the second.
  const s = await startRestServer({ board: board() });
  try {
    await api(s.baseUrl, 'PATCH', '/api/cards/1', {
      blockers: [{ card: 2, owner: 'ada', status: 'open' }], by: 'ada',
    });
    const q = await api(s.baseUrl, 'POST', '/api/graph', {
      query: 'SELECT ?id WHERE { ?b a scrum:Blocker ; scrum:blockedByPerson person:ada ; '
        + 'scrum:blocks ?c . ?c schema:identifier ?id }',
    });
    assert.equal(q.body.rows.length, 0,
      'that person OWNS clearing a card-blocker here — he is not what is blocking it. '
      + 'If this returns a row, the two states have collapsed and the concierge query lies.');
  } finally { await s.stop(); }
});

test('#881 a blocker naming neither a card nor a person is refused', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const r = await api(s.baseUrl, 'PATCH', '/api/cards/1', {
      blockers: [{ status: 'open', note: 'something vague' }], by: 'ada',
    });
    assert.equal(r.status, 400, 'a blocker must name what blocks');
  } finally { await s.stop(); }
});

test('#881 DELETING the card removes its person-blocker node', async () => {
  // The orphan case, written before the code — twice burned, once shy.
  const s = await startRestServer({ board: board() });
  try {
    await api(s.baseUrl, 'PATCH', '/api/cards/1', {
      blockers: [{ person: 'ada', status: 'open' }], by: 'ada',
    });
    await fetch(`${s.baseUrl}/api/cards/1`, { method: 'DELETE' });
    const q = await api(s.baseUrl, 'POST', '/api/graph', {
      query: 'SELECT (COUNT(?b) AS ?n) WHERE { ?b a scrum:Blocker }',
    });
    assert.equal(q.body.rows[0].n, '0');
  } finally { await s.stop(); }
});
