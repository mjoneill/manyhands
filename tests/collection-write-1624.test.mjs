/**
 * #1624 — entity.put kind 'collection' and card.write `collections`: the shared plumbing for the mutable K13 families,
 * against a REAL executor. The builder's rows (the families' REST rows are the separate test author's). Pins: a create is
 * fresh; a declared unique value is held by one member of a collection (not across collections); a stale version lands
 * nothing and a good one replaces the projection; a card.write that also carries a collection part is ONE guarded update
 * (a stale card part means the collection part does not land either); a quad on another entity is refused.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { compile } from '../core/graph-compiler.mjs';
import { entityQuads } from '../core/collections-unit.mjs';
import { cardQuads, cardIriOf } from '../core/cards-graph.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const ACTOR = 'https://scrumboard.local/person/ada';
const RS = 'https://scrumboard.local/ns#';
let n = 0;
const op = () => `urn:ex:op/collections/test-${process.pid}-${++n}`;
const model = (key, name = `model ${key}`) => ({ '@id': `https://scrumboard.local/model/${key}`, '@type': 'scrum:Model', 'scrum:modelKey': key, name });
const keyUnique = (e) => [{ predicate: `${RS}modelKey`, value: { type: 'literal', value: e['scrum:modelKey'] } }];
const part = (collection, e, expectedVersion = null, prior = null, version = '1', unique = keyUnique(e)) => ({
  collection, iri: e['@id'], expectedVersion, version, quads: entityQuads(e), ...(prior ? { prior: entityQuads(prior) } : {}), json: JSON.stringify(e), unique,
});
const put = (parts) => ({ kind: 'entity.put', opId: op(), actor: ACTOR, entity: { kind: 'collection', parts } });

async function withExec(body) {
  const x = await startExecutor({ store: tmpStore('cl-'), datasetId: 'cl-test', create: true });
  try { return await body(createGraphClient({ baseUrl: x.baseUrl, expectedDatasetId: 'cl-test', timeoutMs: 30000 })); } finally { await killExecutor(x); }
}
const rows = async (g, q) => { const r = await g.query(q); assert.ok(r.ok, r.reason); return r.rows; };
const triplesOf = async (g, iri) => (await rows(g, `SELECT ?p ?o WHERE { <${iri}> ?p ?o }`)).map((r) => `${r.p.value} ${r.o.value}`).sort();

test('#1624 collection: a create lands with its membership, version and wire JSON; a second create of the same entity is PRECONDITION_FAILED', { skip: SKIP }, async () => {
  await withExec(async (g) => {
    const m = model('k1');
    assert.equal((await g.update(put([part('models', m)]))).outcome, 'APPLIED');
    const t = await triplesOf(g, m['@id']);
    assert.ok(t.includes(`${RS}inCollection models`) && t.includes('urn:ex:ver 1') && t.some((x) => x.startsWith(`${RS}entityJson `)), JSON.stringify(t));
    assert.equal((await g.update(put([part('models', m)]))).outcome, 'PRECONDITION_FAILED');
  });
});

test('#1624 collection: a declared unique value is held by ONE member of a collection, and does not collide across collections', { skip: SKIP }, async () => {
  await withExec(async (g) => {
    assert.equal((await g.update(put([part('models', model('dup'))]))).outcome, 'APPLIED');
    const twin = { ...model('dup', 'twin'), '@id': 'https://scrumboard.local/model/dup-twin' };
    assert.equal((await g.update(put([part('models', twin)]))).outcome, 'PRECONDITION_FAILED', 'a second model with the same key is refused');
    const elsewhere = { ...twin, '@id': 'https://scrumboard.local/model/other-coll' };
    assert.equal((await g.update(put([part('otherKinds', elsewhere)]))).outcome, 'APPLIED', 'the same value in another collection is not a collision');
  });
});

test('#1624 collection: a stale version lands nothing; the right one replaces the projection; a remove deletes the entity', { skip: SKIP }, async () => {
  await withExec(async (g) => {
    const a = model('k3', 'first name');
    assert.equal((await g.update(put([part('models', a)]))).outcome, 'APPLIED');
    const b = { ...a, name: 'second name' };
    assert.equal((await g.update(put([part('models', b, '4', a, '5')]))).outcome, 'PRECONDITION_FAILED');
    assert.ok((await triplesOf(g, a['@id'])).includes('https://schema.org/name first name'), 'unchanged after a stale write');
    assert.equal((await g.update(put([part('models', b, '1', a, '2')]))).outcome, 'APPLIED');
    const t = await triplesOf(g, a['@id']);
    assert.ok(t.includes('https://schema.org/name second name') && !t.includes('https://schema.org/name first name'), JSON.stringify(t));
    assert.equal((await g.update(put([{ collection: 'models', iri: a['@id'], remove: true, expectedVersion: '2', prior: entityQuads(b) }]))).outcome, 'APPLIED');
    assert.deepEqual(await triplesOf(g, a['@id']), []);
  });
});

test('#1624 card.write with collections is ONE update: a stale card part means the collection part does not land either', { skip: SKIP }, async () => {
  await withExec(async (g) => {
    const c = { id: 'cw1', shortId: 1, title: 'c', column: 'backlog', version: 1 };
    assert.equal((await g.update({ kind: 'card.write', opId: op(), actor: ACTOR, parts: [{ iri: cardIriOf('cw1'), expectedVersion: null, version: '1', quads: cardQuads(c, new Map()), json: JSON.stringify(c) }] })).outcome, 'APPLIED');
    const m = model('with-card');
    const stale = { iri: cardIriOf('cw1'), expectedVersion: '9', version: '10', quads: cardQuads({ ...c, title: 'c2' }, new Map()), prior: [], json: JSON.stringify({ ...c, title: 'c2' }) };
    assert.equal((await g.update({ kind: 'card.write', opId: op(), actor: ACTOR, parts: [stale], collections: [part('models', m)] })).outcome, 'PRECONDITION_FAILED');
    assert.deepEqual(await triplesOf(g, m['@id']), [], 'the collection entity did not land');
    const good = { ...stale, expectedVersion: '1', version: '2' };
    assert.equal((await g.update({ kind: 'card.write', opId: op(), actor: ACTOR, parts: [good], collections: [part('models', m)] })).outcome, 'APPLIED');
    assert.ok((await triplesOf(g, m['@id'])).includes(`${RS}inCollection models`), 'both landed together');
  });
});

test('#1624 collection: a quad on another entity is refused before anything is sent', () => {
  const m = model('k5');
  const p = part('models', m);
  p.quads = [...p.quads, [{ type: 'uri', value: 'https://scrumboard.local/model/someone-else' }, { type: 'uri', value: 'https://schema.org/name' }, { type: 'literal', value: 'x' }]];
  assert.throws(() => compile(put([p])), /is not <https:\/\/scrumboard\.local\/model\/k5>/);
});
