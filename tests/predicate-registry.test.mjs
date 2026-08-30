/**
 * #945 slice 1 — the PREDICATE REGISTRY, as observation. Decision aad42bf5
 * (Option D, 2026-08-20): "a predicate must be registered with a definition
 * before it can be used." This slice registers, GATES NOTHING — the decision's
 * own reopensIf is the experiment, and an experiment that has been replaced by
 * a build cannot come back "no" (the guard recorded on #945's acceptance).
 * The write-verb gate is a later slice, contingent on the experiment's result.
 *
 * Born in the graph per Decision aaf1774b: a PredicateDefinition is an ENTITY
 * (event-logged, projected), not a side-file. The registry IS the first
 * consumer of its own invariant.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const reg = async (baseUrl, body) => {
  const r = await fetch(`${baseUrl}/api/predicates`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
const list = async (baseUrl, qs = '') => (await fetch(`${baseUrl}/api/predicates${qs}`)).json();

const ISPARTOF = {
  name: 'schema:isPartOf',
  definition: 'Structural containment: the subject BELONGS TO the object (card → apex/parent). Transitive by this board\'s choice. Asserted, never inferred from a label.',
  by: 'ada',
};

test('#945-1 a predicate is registered with a definition and listed back — the registry observes, it does not gate', async () => {
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  try {
    const c = await reg(s.baseUrl, ISPARTOF);
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(c.body.name, 'schema:isPartOf');
    assert.equal(c.body.registeredBy, 'ada');
    const all = await list(s.baseUrl);
    assert.equal(all.length, 1);
    assert.match(all[0].definition, /containment/i);
    const one = await list(s.baseUrl, '?name=schema:isPartOf');
    assert.equal(one.length, 1, 'filterable by exact name');
    const none = await list(s.baseUrl, '?name=scrum:neverRegistered');
    assert.deepEqual(none, [], 'an unknown name is an EMPTY LIST, never an error — "unregistered" is the common answer');
  } finally { await s.stop(); }
});

test('#945-1 refusals name what to do: bad name shape, empty definition, missing registrant', async () => {
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  try {
    const bad = await reg(s.baseUrl, { ...ISPARTOF, name: 'not-prefixed' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /prefix/i, 'the refusal teaches the shape');
    const empty = await reg(s.baseUrl, { ...ISPARTOF, definition: '   ' });
    assert.equal(empty.status, 400);
    assert.match(empty.body.error, /definition/i);
    const nobody = await reg(s.baseUrl, { name: 'scrum:x', definition: 'y' });
    assert.equal(nobody.status, 400);
    assert.match(nobody.body.error, /by|registrant|who/i);
  } finally { await s.stop(); }
});

test('#945-1 re-registering the same name REVISES the definition (one entity per name; the event log keeps the history)', async () => {
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  try {
    await reg(s.baseUrl, ISPARTOF);
    const v2 = await reg(s.baseUrl, { ...ISPARTOF, definition: 'Structural containment, revised.', by: 'bo' });
    assert.equal(v2.status, 200, 'a revision is not a second entity');
    const all = await list(s.baseUrl);
    assert.equal(all.length, 1, 'one definition per predicate name');
    assert.match(all[0].definition, /revised/);
    assert.equal(all[0].registeredBy, 'bo', 'the reviser is the current registrant of record');
  } finally { await s.stop(); }
});

test('#945-1 BORN IN THE GRAPH: a registered predicate is reachable from /api/graph with its definition', async () => {
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  try {
    await reg(s.baseUrl, ISPARTOF);
    const r = await fetch(`${s.baseUrl}/api/graph`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: 'ada', query: 'SELECT ?n ?def ?who WHERE { ?p a scrum:PredicateDefinition ; schema:name ?n ; scrum:definition ?def ; schema:creator ?who }' }),
    });
    const d = await r.json();
    assert.equal(r.status, 200, JSON.stringify(d).slice(0, 300));
    assert.equal(d.rows.length, 1, `the registry is graph-queryable: ${JSON.stringify(d.rows)}`);
    assert.equal(String(d.rows[0].n), 'schema:isPartOf');
    assert.match(String(d.rows[0].def), /containment/i);
    assert.equal(String(d.rows[0].who), 'person:ada');
  } finally { await s.stop(); }
});

test('#945-1 GATES NOTHING — an unregistered predicate stops no existing write (the observation-only contract)', async () => {
  const s = await startRestServer({ board: makeBoardFixture({ cards: [], conversations: [] }) });
  try {
    // a card write touching relationships (edges = predicates) with an empty registry
    const mk = await fetch(`${s.baseUrl}/api/cards`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'unimpeded', createdBy: 'ada' }),
    });
    assert.equal(mk.status, 201, 'slice 1 observes; the gate is a LATER slice, contingent on the experiment');
  } finally { await s.stop(); }
});
