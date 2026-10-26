// #1762 S1 — the builder's half of S1's proof (the black-box rows in history-native-s1-1762, written first, are the other half): the
// activity record is FAIL-CLOSED in the compiler, a refused write commits no activity, and a replayed write (a lost ack)
// commits its activity exactly once. Against a real temp executor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { compile, changeActivityIri, staticCheck, originKeyOf, mutationIdOf, originPrepareOp, admitStoredOriginPlan } from '../core/graph-compiler.mjs';
import { entityQuads } from '../core/collections-unit.mjs';
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
  t.after(async () => { await killExecutor(x); fs.rmSync(store, { recursive: true, force: true }); });   // no tmp leftover
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

test('#1762 B8 (review 131) a template variable with its binding REMOVED is refused by staticCheck: never APPLIED with the activity silently skipped', () => {
  const c = card({ id: 'review-card' });
  const opId = 'urn:ex:op/card/b8';
  const { sparql } = compile(intent(opId, [createPart(c)]));
  assert.equal(staticCheck(sparql, opId).ok, true, 'control: the compiled update passes');
  const lines = sparql.split('\n');
  const at = lines.findIndex((l) => l.includes(`BIND(IF(BOUND(?ok), <${changeActivityIri(opId, 0)}>,`));
  assert.ok(at >= 0, 'the activity subject binding is in the update');
  const mutant = lines.filter((_, i) => i !== at).join('\n');
  const r = staticCheck(mutant, opId);
  assert.equal(r.ok, false, 'the removed-binding mutant is refused');
  assert.ok(r.errors.some((e) => /never bound/.test(e)), JSON.stringify(r.errors));
});

test('#1762 B9 (review 131) a prepared origin plan carrying COLLECTION history is admitted on read-back, and a non-canonical one is refused', () => {
  const actor = 'https://scrumboard.local/person/ada', agent = 'https://scrumboard.local/agent/zoe';
  const mid = mutationIdOf(originKeyOf('agent-rest', 'zoe', 'review-history', 'ada'));
  const descriptor = { route: 'agent-rest', subject: 'zoe', requestKey: 'review-history', originActor: 'ada', mutationId: mid, provenance: { agent: 'zoe', releasedCards: ['released-card'] }, slots: [{ slot: 'agent-rest', author: 'board', body: 'fixture', mentions: [], notify: false }] };
  const entity = { '@id': agent, '@type': 'scrum:Agent', 'scrum:seatKey': 'zoe', 'scrum:state': 'resting', name: 'zoe' };
  const coll = { collection: 'agents', iri: agent, expectedVersion: '1', version: '2', quads: entityQuads(entity), json: JSON.stringify(entity), history: { op: 'update', entityKind: 'agent', versionAfter: 'unknown' } };
  const released = card({ id: 'released-card', shortId: 2, version: 2 });
  const part = { iri: cardIriOf(released.id), expectedVersion: '1', version: '2', quads: cardQuads(released, shortIdMap([released])), json: JSON.stringify(released), history: cardHistoryFacts({ ...released, version: 1, claimedBy: 'zoe' }, released) };
  const stored = compile({ kind: 'origin.prepare', opId: originPrepareOp(mid), actor, origin: descriptor, plan: { parts: [part], collections: [coll] } }).canonical.record.plan;
  assert.ok(stored.collections[0].history, 'the compiler stores the collection history');
  const admitted = admitStoredOriginPlan(descriptor, stored);
  assert.deepEqual(JSON.parse(JSON.stringify(admitted)).collections?.[0]?.history ?? JSON.parse(JSON.stringify(admitted)).plan?.collections?.[0]?.history, stored.collections[0].history, 'and read-back keeps it');
  const bad = JSON.parse(JSON.stringify(stored)); bad.collections[0].history = { ...bad.collections[0].history, op: 'rewrite' };
  assert.throws(() => admitStoredOriginPlan(descriptor, bad));
});

test('#1762 B10 (CI, #1749 A8) a literal holding a raw U+2028 / U+2029 is still SEEN by staticCheck: it compiles, and a removed binding on it is still refused', async () => {
  // psqLit (the post-seq reservation's literals) leaves U+2028 raw; a JS `.` stops at it, so staticCheck's BIND parse missed
  // the binding and the unbound-use check refused a valid reservation
  const { reserveOpId } = await import('../core/postseq-reserve.mjs');
  const it = { mode: 'ordinary', author: 'ada', requestId: 'rk-b10', draft: { body: 'line\u2028sep and para\u2029sep', attachedTo: null, mentions: [], attachments: [], conversation: null, onBehalfOf: null } };
  const opId = reserveOpId([it]);
  const { sparql } = compile({ kind: 'postseq.reserve', opId, actor: 'urn:ex:seat/ada', reservations: [it] });   // compile runs staticCheck
  assert.equal(staticCheck(sparql, opId).ok, true);
  const lines = sparql.split('\n');
  const at = lines.findIndex((l) => l.includes('\u2028') && /AS \?d_\w+\)$/.test(l));
  assert.ok(at >= 0, 'the binding that carries the raw separator');
  assert.equal(staticCheck(lines.filter((_, k) => k !== at).join('\n'), opId).ok, false, 'its removal is still refused');
});
