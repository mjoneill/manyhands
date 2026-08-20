/**
 * #966 — "waiting on ANY human" becomes representable.
 *
 * ⛔ THE COST THAT PRODUCED THIS, measured 2026-08-20T17:0xZ. #881 shipped
 * person-blockers and they work — but they offer exactly one slot, `person:
 * <key>`. Eight live blockers, ALL naming the same man. At least one says in
 * its own note that he is not the one who owes it:
 *
 *   #185: "NOT a decision: it is one bounded round trip of participation,
 *          and ANY HUMAN CAN SUPPLY IT."
 *
 * ⇒ Naming someone converts "anyone could do this" into "X owes this". That is
 * an artefact of the FIELD, not a fact about the work, and it is invisible at
 * the point of reading: the concierge query returns a clean list of things he
 * apparently owes. The list handed to him overstated his queue.
 *
 * ⚠️ And #965's gating ruling makes it concrete: once an open person-blocker
 * excludes a card from `board_ready`, an any-human card leaves the queue naming
 * one person — so nobody ELSE learns they could have cleared it in five minutes.
 *
 * ── THE SHAPE, ruled by the room's vocabulary voice ─────────────────────────
 *   input        { anyHuman: true, status: 'open', note: '…' }
 *   projection   ?blocker scrum:blockedByAnyHuman true
 *
 * ⭐ A BOOLEAN PREDICATE, deliberately: NOT a sentinel identity (`person:
 * "any-human"`) and NOT a nullable `person`. Both overload an existing slot —
 * "nobody recorded who" and "anyone will do" would become the same triple, and
 * the concierge query could not separate them. That collapse is the defect this
 * card exists to fix, so the fix must not reintroduce it one level down.
 *
 * ⚠️ The first proposal was `scrum:blockedByAnyHuman` with NO OBJECT. Every
 * predicate needs one; there is no such triple. Recorded because the argument
 * for it was structural and correct, and the shape was still unwritable.
 *
 * ── WHAT THESE TESTS PIN ────────────────────────────────────────────────────
 * The named-person query must not match the any-human set BY CONSTRUCTION —
 * not by filtering. And #881's `owner` / `person` distinction must survive a
 * third kind: they are opposite states and its own suite pins them apart.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

// Same shape the #881 suite defines locally — the harness exports the server,
// not a client.
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
    { id: 'u-1', shortId: 1, title: 'anyone could answer this', description: '', type: 'task',
      labels: [], assignees: [], column: 'backlog', order: 1,
      createdAt: '2026-08-01T00:00:00.000Z',
      relationships: { relatedTo: [], blockedBy: [2], supersedes: [], derivedFrom: [], supersededBy: [] } },
    { id: 'u-2', shortId: 2, title: 'a blocking card', description: '', type: 'task',
      labels: [], assignees: [], column: 'backlog', order: 2,
      createdAt: '2026-08-01T00:00:00.000Z', relationships: {} },
    { id: 'u-3', shortId: 3, title: 'genuinely needs ada', description: '', type: 'task',
      labels: [], assignees: [], column: 'backlog', order: 3,
      createdAt: '2026-08-01T00:00:00.000Z', relationships: {} },
  ],
  nextShortId: 4,
});

test('#966 a blocker can say ANY HUMAN, naming nobody', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const r = await api(s.baseUrl, 'PATCH', '/api/cards/1', {
      blockers: [{ anyHuman: true, status: 'open', note: 'one bounded round trip' }], by: 'ada',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ignoredFields, undefined, 'must not be validated-then-discarded');

    const fresh = await api(s.baseUrl, 'GET', '/api/cards/1');
    assert.deepEqual(fresh.body.blockers,
      [{ anyHuman: true, status: 'open', note: 'one bounded round trip' }]);
  } finally { await s.stop(); }
});

/**
 * ⭐⭐⭐ THE CONTROL, and it is the whole card. "What is waiting on ME" must
 * stop including work anyone could do. Two blockers, one named and one not; the
 * named query must return exactly one row.
 */
test('#966 a NAMED-person query does NOT match the any-human blocker', async () => {
  const s = await startRestServer({ board: board() });
  try {
    await api(s.baseUrl, 'PATCH', '/api/cards/1', {
      blockers: [{ anyHuman: true, status: 'open', note: 'anyone' }], by: 'ada',
    });
    await api(s.baseUrl, 'PATCH', '/api/cards/3', {
      blockers: [{ person: 'ada', status: 'open', note: 'genuinely hers' }], by: 'ada',
    });

    const q = await api(s.baseUrl, 'POST', '/api/graph', {
      query: `SELECT ?id WHERE {
        ?b a scrum:Blocker ; scrum:blockedByPerson person:ada ; scrum:status "open" ;
           scrum:blocks ?c .
        ?c schema:identifier ?id .
      }`,
    });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.deepEqual(q.body.rows, [{ id: '3' }],
      'the any-human card must NOT appear in what ada is owed');
  } finally { await s.stop(); }
});

test('#966 the ANY-HUMAN query returns the any-human set', async () => {
  // ⚠️ Representable-but-unreachable is #954's shape. A state nobody can query
  // is a state nobody acts on.
  const s = await startRestServer({ board: board() });
  try {
    await api(s.baseUrl, 'PATCH', '/api/cards/1', {
      blockers: [{ anyHuman: true, status: 'open', note: 'anyone' }], by: 'ada',
    });
    await api(s.baseUrl, 'PATCH', '/api/cards/3', {
      blockers: [{ person: 'ada', status: 'open', note: 'genuinely hers' }], by: 'ada',
    });

    const q = await api(s.baseUrl, 'POST', '/api/graph', {
      query: `SELECT ?id ?note WHERE {
        ?b a scrum:Blocker ; scrum:blockedByAnyHuman true ; scrum:status "open" ;
           scrum:blocks ?c .
        OPTIONAL { ?b scrum:note ?note }
        ?c schema:identifier ?id .
      }`,
    });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.deepEqual(q.body.rows, [{ id: '1', note: 'anyone' }],
      'and ada\'s genuinely-named card must not leak into it');
  } finally { await s.stop(); }
});

/**
 * ⛔ `anyHuman: false` must be REFUSED, not stored. Absence must not masquerade
 * as a meaningful false — a stored `false` is a third state ("someone decided
 * it is not any-human") that nothing else in the vocabulary can express, and it
 * would read identically to a blocker whose author never considered the
 * question.
 */
test('#966 anyHuman:false is REFUSED, so absence cannot masquerade as a decision', async () => {
  const s = await startRestServer({ board: board() });
  try {
    const r = await api(s.baseUrl, 'PATCH', '/api/cards/1', {
      blockers: [{ anyHuman: false, status: 'open' }], by: 'ada',
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  } finally { await s.stop(); }
});

test('#966 EXACTLY ONE target — naming a person AND anyHuman is refused', async () => {
  // Same rule #881 already applies to `card` + `person`: the two are opposite
  // states and an entry meaning either cannot be read as one.
  const s = await startRestServer({ board: board() });
  try {
    const r = await api(s.baseUrl, 'PATCH', '/api/cards/1', {
      blockers: [{ person: 'ada', anyHuman: true, status: 'open' }], by: 'ada',
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  } finally { await s.stop(); }
});

/**
 * ⭐ ACCEPTANCE 5 — #881's distinction must SURVIVE a third kind.
 *
 *   owner   — who is chasing the CARD that blocks this
 *   person  — that person's own pending action IS the block
 *
 * Its own suite pins those apart. A third kind must collapse neither, so all
 * three shapes are asserted in one board: a card-blocker with an owner, a
 * person-blocker, and an any-human blocker — each projecting its own predicate
 * and none matching the others' queries.
 */
test('#966 all THREE blocker kinds coexist without collapsing #881\'s distinction', async () => {
  const s = await startRestServer({ board: board() });
  try {
    await api(s.baseUrl, 'PATCH', '/api/cards/1', {
      blockers: [
        { card: 2, owner: 'bo', status: 'open', note: 'bo is chasing #2' },
        { anyHuman: true, status: 'open', note: 'anyone' },
      ], by: 'ada',
    });
    await api(s.baseUrl, 'PATCH', '/api/cards/3', {
      blockers: [{ person: 'ada', status: 'open', note: 'hers' }], by: 'ada',
    });

    const q = await api(s.baseUrl, 'POST', '/api/graph', {
      query: `SELECT ?kind (COUNT(?b) AS ?n) WHERE {
        ?b a scrum:Blocker ; scrum:status "open" .
        { ?b scrum:blockedByCard   ?x . BIND("card"      AS ?kind) } UNION
        { ?b scrum:blockedByPerson ?x . BIND("person"    AS ?kind) } UNION
        { ?b scrum:blockedByAnyHuman true . BIND("anyHuman" AS ?kind) }
      } GROUP BY ?kind ORDER BY ?kind`,
    });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.deepEqual(q.body.rows, [
      { kind: 'anyHuman', n: '1' },
      { kind: 'card', n: '1' },
      { kind: 'person', n: '1' },
    ], 'three kinds, one each, none absorbed into another');

    // ⛔ And `owner` is still ONLY on the card-blocker — the any-human blocker
    // must not have acquired one, which is how the distinction would rot.
    const owners = await api(s.baseUrl, 'POST', '/api/graph', {
      query: 'SELECT (COUNT(?o) AS ?n) WHERE { ?b a scrum:Blocker ; scrum:owner ?o }',
    });
    assert.deepEqual(owners.body.rows, [{ n: '1' }], 'exactly one owner, on the card-blocker');
  } finally { await s.stop(); }
});
