/**
 * #725 part 2 — THE PROJECTION MUST ACTUALLY RUN. Not "the function is correct."
 *
 * ⛔ WHY THIS FILE EXISTS, STATED PLAINLY BECAUSE IT IS THE WHOLE POINT.
 *
 * `tests/graph-activities.test.mjs` has SEVEN passing tests for
 * `projectActivities()`. They have passed every run since #725 landed. And on
 * 2026-08-18 the live board answered `prov:Activity` with ZERO, because the
 * function had exactly eleven callers and every single one of them was in that
 * test file. Built, tested, exported, wired to nothing.
 *
 *   ⇒ A unit test proves an ARTIFACT is correct.
 *     It cannot prove the artifact is REACHED.
 *
 * That gap is the room's characteristic defect in its worst form so far: a
 * capability with a green suite and no production caller, where every green run
 * reads as "this feature works."
 *
 * ⭐ So this test asserts the PROPERTY, through the front door: write to the
 * board over HTTP the way a caller does, then ask the graph endpoint whether
 * the thing that just happened is visible as an activity. Nothing here imports
 * `projectActivities`. If someone deletes the wiring but keeps the function,
 * the other file stays green and THIS file goes red — which is the arrangement
 * that was missing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

/** Ask the live graph endpoint a question. */
async function sparql(baseUrl, query) {
  const res = await fetch(`${baseUrl}/api/graph`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, `graph query failed: ${JSON.stringify(body)}`);
  return body;
}

test('#725 a write through the front door becomes a queryable activity', async () => {
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    // ⚠️ THE CONTROL, RUN FIRST. A fresh board has no events, so the graph must
    // report zero activities BEFORE the write. Without this the assertion below
    // could pass on a store that was somehow pre-populated, and the test would
    // be measuring nothing.
    const before = await sparql(s.baseUrl,
      'SELECT (COUNT(?a) AS ?n) WHERE { ?a a prov:Activity }');
    assert.equal(before.rows[0].n, '0', 'control: a fresh board starts with no activities');

    const created = await fetch(`${s.baseUrl}/api/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'a card whose creation should be a fact', by: 'ada' }),
    });
    assert.equal(created.status, 201);

    const after = await sparql(s.baseUrl, `
      SELECT ?op ?actor ?kind WHERE {
        ?a a prov:Activity ; scrum:op ?op ; scrum:entityKind ?kind .
        OPTIONAL { ?a prov:wasAssociatedWith ?actor }
      }`);

    assert.ok(after.rows.length >= 1,
      'the board wrote a structured event for this create and the graph must be able '
      + 'to see it. Zero rows means projectActivities() is not wired into the replica '
      + 'lifecycle — the exact defect this file exists to catch, and the one its unit '
      + 'tests cannot.');

    const create = after.rows.find((r) => r.op === 'create');
    assert.ok(create, `no create activity among ${JSON.stringify(after.rows)}`);
    assert.equal(create.kind, 'card');
    assert.equal(create.actor, 'person:ada',
      'the actor travels from the event log into the graph as a Person edge, not a string');
  } finally { await s.stop(); }
});

test('#725 activities are distinct from speech — the query that was impossible', async () => {
  // ⭐ #725's stated payoff: "what did each person say this week" silently included
  // 267 machine events, and "who moved cards, and when" could not be asked at all,
  // because both facts lived in prose inside a Comment authored by person:board.
  // Once activities are their own type, the two questions separate.
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    await fetch(`${s.baseUrl}/api/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'moved by ada', by: 'ada' }),
    });

    const acts = await sparql(s.baseUrl,
      'SELECT (COUNT(?a) AS ?n) WHERE { ?a a prov:Activity }');
    const says = await sparql(s.baseUrl,
      'SELECT (COUNT(?c) AS ?n) WHERE { ?c a schema:Comment }');

    assert.ok(Number(acts.rows[0].n) > 0, 'the doing is queryable');
    assert.equal(says.rows[0].n, '0',
      'and it did NOT arrive as speech — an activity must not be counted as a Comment, '
      + 'which is the conflation #725 exists to end');
  } finally { await s.stop(); }
});

test('#725 idempotent across rebuilds — replaying the log is not new history', async () => {
  // The projection is keyed by `seq`. If the replica re-syncs (which it does after
  // EVERY write) and activities are re-projected without that guard, the count
  // climbs on each query and every "how much happened" answer inflates silently.
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    await fetch(`${s.baseUrl}/api/cards`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'one', by: 'ada' }),
    });
    const first = await sparql(s.baseUrl,
      'SELECT (COUNT(?a) AS ?n) WHERE { ?a a prov:Activity }');

    // A second write forces another sync, then a third query forces another.
    await fetch(`${s.baseUrl}/api/cards`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'two', by: 'ada' }),
    });
    const second = await sparql(s.baseUrl,
      'SELECT (COUNT(?a) AS ?n) WHERE { ?a a prov:Activity }');
    const third = await sparql(s.baseUrl,
      'SELECT (COUNT(?a) AS ?n) WHERE { ?a a prov:Activity }');

    assert.equal(Number(second.rows[0].n), Number(first.rows[0].n) + 1,
      'the second create added exactly one activity');
    assert.equal(third.rows[0].n, second.rows[0].n,
      'querying again re-syncs the replica and must NOT re-add activities already projected');
  } finally { await s.stop(); }
});
