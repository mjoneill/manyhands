/**
 * #1214 — THE KIND REGISTRY, over the wire.
 *
 * The module tests hold the derivation. These hold the promise a seat actually
 * relies on: that "what kinds of thing live here, and how do I make one" can be
 * ANSWERED without reading source, and that the answer distinguishes three
 * different facts a census collapses into one —
 *
 *   declared      the runtime accepts it
 *   registered    someone wrote down what it means
 *   instantiated  something has actually created one
 *
 * The case that matters most is the one a census cannot express: DECLARED, real,
 * and zero instances. That kind is invisible to `SELECT ?t WHERE { ?s a ?t }`
 * by construction, and it is why this card exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

const api = async (baseUrl, method, path, body) => {
  const r = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await r.json(); } catch { /* none */ }
  return { status: r.status, body: parsed };
};

const board = () => makeBoardFixture({
  cards: [
    { id: 'u-1', shortId: 1, title: 'a card', description: '', type: 'task',
      labels: [], assignees: [], column: 'backlog', order: 1,
      createdAt: '2026-08-01T00:00:00.000Z', relationships: {} },
  ],
  nextShortId: 2,
});

// A kind this build genuinely does NOT declare — the case these tests exist for.
//
// ⚠️ It named `scrum:Procedure` until #1206 declared that kind for real, and
// these tests went red the same minute. Correct: the fixture's premise had
// expired. Whatever name sits here must stay absent from KIND_DECLARATIONS, so
// it is deliberately not a thing anyone would plausibly build.
const FOREIGN_KIND = {
  name: 'scrum:NotAThingThisBuildKnows',
  definition: 'A kind registered by a seat that this build has no declaration for. It exists to '
    + 'prove the board accepts and REPORTS such a registration rather than refusing it — refusing '
    + 'would make the seat lose the definition it took the trouble to write.',
  createdBy: 'kind_register',
  by: 'ada',
};

test('#1214 an unregistered board answers "what kinds exist" anyway — declared is not registered', async (t) => {
  const s = await startRestServer({ board: board() });
  t.after(() => s.stop());

  const listed = await api(s.baseUrl, 'GET', '/api/kinds');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, [],
    'nothing is registered on a fresh board — and that must not be read as "no kinds exist"');

  const declared = await api(s.baseUrl, 'GET', '/api/kinds?declared=1');
  assert.equal(declared.status, 200);
  assert.ok(declared.body.length >= 25,
    'the runtime knows its own vocabulary with an empty registry — this is the difference '
    + 'between a registry and a census, and the whole point of the card');
  const card = declared.body.find((k) => k.name === 'scrum:Card');
  assert.ok(card, 'scrum:Card must be declared');
  assert.match(card.createdBy, /card_create/,
    '"how do I make one" is answerable from the registry, not from reading server.js');
  assert.equal(card.registered, false, 'declared and registered are different facts');
});

test('#1214 registering a kind is a write with an author, and reads back', async (t) => {
  const s = await startRestServer({ board: board() });
  t.after(() => s.stop());

  const created = await api(s.baseUrl, 'POST', '/api/kinds', FOREIGN_KIND);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.name, 'scrum:NotAThingThisBuildKnows');
  assert.equal(created.body.createdBy, FOREIGN_KIND.createdBy);
  assert.equal(created.body.registeredBy, 'ada');

  const back = await api(s.baseUrl, 'GET', '/api/kinds?name=scrum:NotAThingThisBuildKnows');
  assert.equal(back.body.length, 1, 'a successful response is not a write — read it back');
  assert.equal(back.body[0].definition, FOREIGN_KIND.definition);
});

test('#1214 re-registering REVISES one entity rather than minting a second row', async (t) => {
  const s = await startRestServer({ board: board() });
  t.after(() => s.stop());

  await api(s.baseUrl, 'POST', '/api/kinds', FOREIGN_KIND);
  const revised = await api(s.baseUrl, 'POST', '/api/kinds', {
    ...FOREIGN_KIND,
    definition: 'A repeatable method stored as text with versions. Revised: names the verb that '
      + 'runs it, so a reader need not guess which tool performs a Procedure.',
    by: 'bo',
  });
  assert.equal(revised.status, 200, 'a re-register is an update, not a create');

  const all = await api(s.baseUrl, 'GET', '/api/kinds');
  assert.equal(all.body.length, 1, 'one entity per name — two rows would be two homes for one fact');
  assert.equal(all.body[0].registeredBy, 'bo');
  assert.ok(all.body[0].revisedAt, 'a revision is stamped so the change is visible');
});

test('#1214 a registry of names without definitions is refused, and says why', async (t) => {
  const s = await startRestServer({ board: board() });
  t.after(() => s.stop());

  const noDef = await api(s.baseUrl, 'POST', '/api/kinds', { name: 'scrum:Thing', createdBy: 'x', by: 'ada' });
  assert.equal(noDef.status, 400);
  assert.match(noDef.body.error, /logbook/,
    'the refusal must say what a definition is FOR, or the next caller writes "a thing" to get past it');

  const noVerb = await api(s.baseUrl, 'POST', '/api/kinds', {
    name: 'scrum:Thing', definition: 'x'.repeat(60), by: 'ada',
  });
  assert.equal(noVerb.status, 400);
  assert.match(noVerb.body.error, /createdBy/);

  const noAuthor = await api(s.baseUrl, 'POST', '/api/kinds', {
    name: 'scrum:Thing', definition: 'x'.repeat(60), createdBy: 'thing_create',
  });
  assert.equal(noAuthor.status, 400);
  assert.match(noAuthor.body.error, /Declared, not authenticated/);
});

test('#1214 a predicate name is refused where a KIND is expected', async (t) => {
  const s = await startRestServer({ board: board() });
  t.after(() => s.stop());

  // Lowercase local part: that is a predicate, and registering it here would put
  // a predicate in the class registry where no query would ever look for it.
  const r = await api(s.baseUrl, 'POST', '/api/kinds', {
    name: 'scrum:relatedTo', definition: 'x'.repeat(60), createdBy: 'graph_assert', by: 'ada',
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /capital/);
});

test('#1214 board status reports declared, registered and instantiated as THREE facts', async (t) => {
  const s = await startRestServer({ board: board() });
  t.after(() => s.stop());

  await api(s.baseUrl, 'POST', '/api/kinds', FOREIGN_KIND);
  const st = await api(s.baseUrl, 'GET', '/api/board/status');
  assert.equal(st.status, 200);
  const k = st.body.kinds;
  assert.ok(k, 'orientation must answer "what kinds of thing live here"');
  assert.ok(k.declaredCount >= 25);
  assert.equal(k.registeredCount, 1);

  // scrum:NotAThingThisBuildKnows was registered by a seat and is NOT in this build's module.
  // That is a real state to announce, never an error to refuse — refusing would
  // make the seat lose the definition it took the trouble to write.
  assert.ok(k.registeredNotDeclared.includes('scrum:NotAThingThisBuildKnows'),
    'a kind the graph knows and the runtime does not must be VISIBLE');

  // And the inverse: everything the runtime knows that nobody has written down.
  assert.ok(k.declaredNotRegistered.includes('scrum:Card'),
    'an unregistered declared kind is the backfill queue, and it should be readable');
});

test('#1214 a cold census degrades to a NAMED state, never to a 500 or a false zero', async (t) => {
  const s = await startRestServer({ board: board() });
  t.after(() => s.stop());

  const st = await api(s.baseUrl, 'GET', '/api/board/status');
  assert.equal(st.status, 200, 'orientation must not fail because the replica is cold');
  const k = st.body.kinds;
  assert.ok(['live', 'unavailable', 'failed'].includes(k.census),
    'the census state is stated, not inferred from a missing field');
  if (k.census !== 'live') {
    assert.ok(k.censusNote, 'an unavailable census says why');
    for (const row of k.kinds) {
      assert.equal(row.instances, null,
        'unknown is NULL, never 0 — a cold read reported as zero instances would be a lie '
        + 'that reads exactly like a true measurement');
    }
    assert.equal(k.declaredWithNoInstances, null,
      'the blind-spot list is only meaningful against a census that actually ran');
  }
  // Declared and registered are exact regardless — that is the degraded
  // behaviour being USEFUL rather than merely non-fatal.
  assert.ok(k.declaredCount >= 25);
});
