// #1762 S1 — the builder's half of S1's proof (the black-box rows in history-native-s1-1762, written first, are the other half): the
// activity record is FAIL-CLOSED in the compiler, a refused write commits no activity, and a replayed write (a lost ack)
// commits its activity exactly once. Against a real temp executor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { compile, changeActivityIri } from '../core/graph-compiler.mjs';
import { cardQuads, cardIriOf, shortIdMap } from '../core/cards-graph.mjs';
import { cardHistoryFacts } from '../core/cards-unit.mjs';
import { lacksRequiredHistory, durableUpdate } from '../core/durable-update.mjs';

const DS = 's1-builder-1762';
const ACTOR = 'https://scrumboard.local/person/test-actor';
const card = (over = {}) => ({ id: 'c-1762', shortId: 1, title: 'one', column: 'backlog', version: 1, ...over });
const createPart = (c, history = cardHistoryFacts(null, c)) => ({ iri: cardIriOf(c.id), expectedVersion: null, version: '1', quads: cardQuads(c, shortIdMap([c])), json: JSON.stringify(c), ...(history ? { history } : {}) });
const intent = (opId, parts) => ({ kind: 'card.write', opId, actor: ACTOR, parts });

test('#1762 B1 FAIL CLOSED: history on some parts but not all is refused at compile time (no partially recorded write)', () => {
  const a = card({ id: 'c-a', shortId: 1 }), b = card({ id: 'c-b', shortId: 2 });
  assert.throws(() => compile(intent('urn:ex:op/card/b1', [createPart(a), createPart(b, null)])), /history must be on every part or on none/);
});

test('#1762 B2 FAIL CLOSED: an invalid fact is refused, never written as free text (op, column, holder, version)', () => {
  const c = card();
  const bad = [
    { ...cardHistoryFacts(null, c), op: 'rewrite' },
    { ...cardHistoryFacts(null, c), columnAfter: 'back log; DROP' },
    { ...cardHistoryFacts(null, c), holder: '<script>' },
    { ...cardHistoryFacts(null, c), versionAfter: '-1' },
    (() => { const h = cardHistoryFacts(null, c); delete h.columnBefore; return h; })(),   // a create must state columnBefore
  ];
  for (const h of bad) assert.throws(() => compile(intent('urn:ex:op/card/b2', [createPart(c, h)])), Error, JSON.stringify(h));
});

test('#1762 B3 CONTROL: a well-formed history compiles, and the activity terms ride the guarded data INSERT', () => {
  const c = card();
  const { sparql } = compile(intent('urn:ex:op/card/b3', [createPart(c)]));
  assert.match(sparql, /ChangeActivity/);
  assert.ok(sparql.includes(changeActivityIri('urn:ex:op/card/b3', 0)), 'the part-0 activity IRI is in the update');
});

test('#1762 B4 against a real executor: APPLIED commits exactly one activity per part; a replay of the same op (lost ack) adds none; a refused write (stale version) adds none and changes nothing', { skip: !HAVE_PY && 'no executor python' }, async (t) => {
  const store = tmpStore('s1b-1762-');
  const x = await startExecutor({ store, datasetId: DS, create: true });
  t.after(() => killExecutor(x));
  const client = createGraphClient({ baseUrl: x.baseUrl, expectedDatasetId: DS, timeoutMs: 30000, label: 's1-builder' });
  const count = async (opId) => {
    const q = await client.query(`SELECT (COUNT(?a) AS ?n) WHERE { ?a a <https://scrumboard.local/ns#ChangeActivity> ; <https://scrumboard.local/ns#recordedBy> <${opId}> }`);
    assert.ok(q.ok, q.reason); return Number(q.rows[0].n.value);
  };
  const total = async () => { const q = await client.query('SELECT (COUNT(?a) AS ?n) WHERE { ?a a <https://scrumboard.local/ns#ChangeActivity> }'); return Number(q.rows[0].n.value); };

  const a = card({ id: 'c-x', shortId: 1 }), b = card({ id: 'c-y', shortId: 2 });
  const create = intent('urn:ex:op/card/b4-create', [createPart(a), createPart(b)]);
  const r1 = await client.update(create);
  assert.equal(r1.outcome, 'APPLIED', JSON.stringify(r1));
  assert.equal(await count(create.opId), 2, 'one activity per part');
  const parts = await client.query(`SELECT ?p WHERE { ?a <https://scrumboard.local/ns#recordedBy> <${create.opId}> ; <https://scrumboard.local/ns#part> ?p } ORDER BY ?p`);
  assert.deepEqual(parts.rows.map((r) => Number(r.p.value)), [0, 1], 'parts are exactly 0..n-1');

  const r2 = await client.update(create);   // the same op again: what a client does after a lost ack
  assert.notEqual(r2.outcome, 'PRECONDITION_FAILED', JSON.stringify(r2));
  assert.equal(await count(create.opId), 2, 'a replay adds no activity');

  const before = await total();
  const stale = intent('urn:ex:op/card/b4-stale', [{ iri: cardIriOf(a.id), expectedVersion: '7', version: '8', quads: cardQuads({ ...a, title: 'two' }, shortIdMap([a, b])), prior: [], json: JSON.stringify({ ...a, title: 'two' }), history: cardHistoryFacts(a, { ...a, title: 'two' }) }]);
  const r3 = await client.update(stale);
  assert.equal(r3.outcome, 'PRECONDITION_FAILED', JSON.stringify(r3));
  assert.equal(await count(stale.opId), 0, 'a refused write commits no activity');
  assert.equal(await total(), before, 'and the store holds no new activity at all');
  const title = await client.query(`SELECT ?t WHERE { <${cardIriOf(a.id)}> <https://schema.org/name> ?t }`);
  assert.ok(!title.rows.some((r) => r.t.value === 'two'), 'the refused change itself is absent');
});

test('#1762 B5 cardHistoryFacts names the kind of change and the EVENT-TIME facts (the holder BEFORE the write)', () => {
  const was = card({ claimedBy: 'ada', column: 'in-progress' });
  assert.deepEqual(cardHistoryFacts(was, { ...was, claimedBy: null }), { op: 'release', shortId: 1, holder: 'ada', columnAfter: 'in-progress', versionAfter: '1' });
  assert.equal(cardHistoryFacts(card(), card({ claimedBy: 'bea' })).op, 'claim');
  const moved = cardHistoryFacts(card({ column: 'backlog' }), card({ column: 'done' }));
  assert.equal(moved.op, 'move'); assert.equal(moved.columnBefore, 'backlog'); assert.equal(moved.columnAfter, 'done');
  assert.equal(cardHistoryFacts(was, null).op, 'delete');
  assert.equal(cardHistoryFacts(was, null).holder, 'ada', 'a delete names who held the card when it was deleted');
  assert.equal(cardHistoryFacts(null, card({ version: undefined })).versionAfter, 'unknown', 'no REST version is unknown, never guessed');
});

test('#1762 B6 a part re-derived only because a #N it names changed is a REPROJECT, never an update (no false non-holder mutation)', () => {
  const was = card({ claimedBy: 'ada', description: 'see #2' });
  const h = cardHistoryFacts(was, JSON.parse(JSON.stringify(was)));
  assert.equal(h.op, 'reproject');
  assert.equal(h.holder, 'ada');
  assert.ok(!('columnBefore' in h));
  const { sparql } = compile(intent('urn:ex:op/card/b6', [{ ...createPart(card({ id: 'c-n', shortId: 2 })) }]));
  assert.ok(sparql.length > 0);
});

test('#1762 B7 with native history ON, a card or collection write carrying NO history is refused before it is sent; named migrations are exempt; OFF changes nothing', async () => {
  const bare = intent('urn:ex:op/card/b7', [createPart(card(), null)]);
  assert.equal(lacksRequiredHistory(bare, true), true);
  assert.equal(lacksRequiredHistory(intent('urn:ex:op/card/b7', [createPart(card())]), true), false);
  assert.equal(lacksRequiredHistory(bare, false), false, 'flag off: no guard');
  for (const op of ['urn:ex:op/collection/import/k/abc', 'urn:ex:op/cutover/x', 'urn:ex:op/backfill/x', 'urn:ex:op/migrate-1561/x']) assert.equal(lacksRequiredHistory({ ...bare, opId: op }, true), false, op);
  const coll = { kind: 'entity.put', opId: 'urn:ex:op/collections/b7', actor: ACTOR, entity: { kind: 'collection', parts: [{ collection: 'models', iri: 'https://scrumboard.local/entity/m1' }] } };
  assert.equal(lacksRequiredHistory(coll, true), true);
  // and the guard is in the shared send path: nothing reaches the client
  const prev = process.env.SCRUM_HISTORY_NATIVE; process.env.SCRUM_HISTORY_NATIVE = '1';
  try {
    let sent = 0;
    const r = await durableUpdate({ update: async () => { sent++; return { outcome: 'APPLIED' }; }, reconcile: async () => ({ outcome: 'ABSENT' }) }, bare);
    assert.equal(r.outcome, 'REJECTED'); assert.match(r.reason, /HISTORY_REQUIRED/); assert.equal(sent, 0, 'nothing was sent');
  } finally { if (prev === undefined) delete process.env.SCRUM_HISTORY_NATIVE; else process.env.SCRUM_HISTORY_NATIVE = prev; }
});
