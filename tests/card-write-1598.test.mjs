/**
 * #1598 — the compiler's `card.write`, against a REAL executor. The builder's own rows (the REST-level rows are the
 * separate test author's, in scrum-board/diagnostics/unit7-cards-20261007/). Pins: one write = one guarded update (K2),
 * the graph holds the replica's own projection (K3), the shortId counter (K6), a multi-card write is all-or-nothing
 * (review 05:56Z, point 3), a re-write removes what the card no longer says, and shared nodes are never deleted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HAVE_PY, tmpStore, startExecutor, killExecutor } from './helpers/graph-executor-proc.mjs';
import { createGraphClient } from '../core/graph-client.mjs';
import { compile } from '../core/graph-compiler.mjs';
import { cardQuads, priorQuads, cardIriOf } from '../core/cards-graph.mjs';

const SKIP = HAVE_PY ? false : 'UNAVAILABLE: no python with pyoxigraph (a skip is not a pass)';
const ACTOR = 'https://scrumboard.local/person/ada';
let n = 0;
const op = () => `urn:ex:op/card/test-${process.pid}-${++n}`;
const card = (id, shortId, extra = {}) => ({ id, shortId, title: `card ${shortId}`, description: 'body', column: 'backlog', createdAt: '2026-10-07T06:00:00.000Z', createdBy: 'ada', version: 1, ...extra });
const part = (c, expectedVersion, prior = null, ids = new Map()) => ({
  iri: cardIriOf(c.id), expectedVersion, version: c.version, quads: cardQuads(c, ids), ...(prior ? { prior: priorQuads(prior, ids) } : {}), json: JSON.stringify(c),
});

async function withExec(body) {
  const x = await startExecutor({ store: tmpStore('cw-'), datasetId: 'cw-test', create: true });
  try { return await body(createGraphClient({ baseUrl: x.baseUrl, expectedDatasetId: 'cw-test', timeoutMs: 30000 })); } finally { await killExecutor(x); }
}
const rows = async (g, sparql) => { const q = await g.query(sparql); assert.ok(q.ok, q.reason); return q.rows; };
const triplesOf = async (g, iri) => (await rows(g, `SELECT ?p ?o WHERE { <${iri}> ?p ?o }`)).map((r) => `${r.p.value} ${r.o.value}`).sort();
const verOf = async (g, iri) => Number((await rows(g, `SELECT ?v WHERE { <${iri}> <urn:ex:ver> ?v }`))[0]?.v.value);

test('#1598 card.write: a create lands the projection, the version and the counter; a second create on the same id is PRECONDITION_FAILED', { skip: SKIP }, async () => {
  await withExec(async (g) => {
    const a = card('a1', 1, { labels: ['x'] });
    const r = await g.update({ kind: 'card.write', opId: op(), actor: ACTOR, parts: [part(a, null)], counter: { expected: null, next: '2' } });
    assert.equal(r.outcome, 'APPLIED', JSON.stringify(r));
    assert.equal(await verOf(g, cardIriOf('a1')), 1);
    assert.equal(await verOf(g, 'https://scrumboard.local/counter/nextShortId'), 2);
    const t = await triplesOf(g, cardIriOf('a1'));
    assert.ok(t.includes('https://schema.org/name card 1'), 'the projected name is there');
    assert.ok(t.some((x) => x.startsWith('https://scrumboard.local/ns#entityJson ')), 'the wire JSON is there');
    const again = await g.update({ kind: 'card.write', opId: op(), actor: ACTOR, parts: [part(a, null)], counter: { expected: '2', next: '3' } });
    assert.equal(again.outcome, 'PRECONDITION_FAILED');
    assert.equal(await verOf(g, 'https://scrumboard.local/counter/nextShortId'), 2, 'a refused create burns no number');
  });
});

test('#1598 card.write: an update guarded on a stale version is PRECONDITION_FAILED and changes nothing; on the right version it replaces the card', { skip: SKIP }, async () => {
  await withExec(async (g) => {
    const a = card('a2', 1, { labels: ['old-label'], blockers: [{ person: 'ada', status: 'open' }] });
    assert.equal((await g.update({ kind: 'card.write', opId: op(), actor: ACTOR, parts: [part(a, null)] })).outcome, 'APPLIED');
    const b = { ...a, title: 'renamed', labels: ['new-label'], blockers: [], version: 2 };
    const stale = await g.update({ kind: 'card.write', opId: op(), actor: ACTOR, parts: [part({ ...b, version: 8 }, '7', a)] });
    assert.equal(stale.outcome, 'PRECONDITION_FAILED');
    assert.ok((await triplesOf(g, cardIriOf('a2'))).includes('https://schema.org/name card 1'), 'unchanged after a stale write');
    const good = await g.update({ kind: 'card.write', opId: op(), actor: ACTOR, parts: [part(b, '1', a)] });
    assert.equal(good.outcome, 'APPLIED', JSON.stringify(good));
    const t = await triplesOf(g, cardIriOf('a2'));
    assert.ok(t.includes('https://schema.org/name renamed') && !t.includes('https://schema.org/name card 1'), 'the old name is gone, the new one is there');
    assert.ok(!t.some((x) => x.includes('old-label')), 'a dropped label leaves the card');
    assert.equal(await verOf(g, cardIriOf('a2')), 2);
    assert.equal((await rows(g, `SELECT ?b WHERE { ?b <https://scrumboard.local/ns#blocks> <${cardIriOf('a2')}> }`)).length, 0, 'a cleared blocker node is gone');
    assert.equal((await rows(g, 'SELECT ?c WHERE { <https://scrumboard.local/concept/old-label> a ?t }')).length, 1, 'the shared concept node is never deleted by a card write');
  });
});

test('#1598 card.write: a two-card write with ONE stale part lands NOTHING (one conjunctive guard)', { skip: SKIP }, async () => {
  await withExec(async (g) => {
    const a = card('a3', 1), b = card('b3', 2);
    assert.equal((await g.update({ kind: 'card.write', opId: op(), actor: ACTOR, parts: [part(a, null), part(b, null)] })).outcome, 'APPLIED');
    const a2 = { ...a, title: 'A moved', version: 2 }, b2 = { ...b, title: 'B moved', version: 2 };
    const r = await g.update({ kind: 'card.write', opId: op(), actor: ACTOR, parts: [part(a2, '1', a), part({ ...b2, version: 6 }, '5', b)] });
    assert.equal(r.outcome, 'PRECONDITION_FAILED');
    assert.ok((await triplesOf(g, cardIriOf('a3'))).includes('https://schema.org/name card 1'), 'the fresh part did not land either');
    const ok = await g.update({ kind: 'card.write', opId: op(), actor: ACTOR, parts: [part(a2, '1', a), part(b2, '1', b)] });
    assert.equal(ok.outcome, 'APPLIED');
    assert.ok((await triplesOf(g, cardIriOf('b3'))).includes('https://schema.org/name B moved'));
  });
});

test('#1598 card.write refuses a quad that is not the card\'s own (another card, a column node) before anything is sent', () => {
  const a = card('a4', 1);
  const p = part(a, null);
  const foreign = { ...p, quads: [...p.quads, [{ type: 'uri', value: cardIriOf('zz') }, { type: 'uri', value: 'https://schema.org/name' }, { type: 'literal', value: 'x' }]] };
  assert.throws(() => compile({ kind: 'card.write', opId: op(), actor: ACTOR, parts: [foreign] }), /not owned by/);
  const col = { ...p, quads: [...p.quads, [{ type: 'uri', value: 'https://scrumboard.local/column/backlog' }, { type: 'uri', value: 'https://schema.org/name' }, { type: 'literal', value: 'x' }]] };
  assert.throws(() => compile({ kind: 'card.write', opId: op(), actor: ACTOR, parts: [col] }), /not owned by/);
});

test('#1598 card.write: a REMOVE part deletes every owned triple on the right version (stale: nothing), and keeps shared nodes', { skip: SKIP }, async () => {
  await withExec(async (g) => {
    const a = card('a5', 1, { labels: ['keep-me'], acceptance: [{ condition: 'c1', evidence: [] }] });
    assert.equal((await g.update({ kind: 'card.write', opId: op(), actor: ACTOR, parts: [part(a, null)] })).outcome, 'APPLIED');
    const stale = await g.update({ kind: 'card.write', opId: op(), actor: ACTOR, parts: [{ iri: cardIriOf('a5'), remove: true, expectedVersion: '4', prior: priorQuads(a, new Map()) }] });
    assert.equal(stale.outcome, 'PRECONDITION_FAILED');
    assert.ok((await triplesOf(g, cardIriOf('a5'))).length > 0, 'a stale remove deletes nothing');
    const r = await g.update({ kind: 'card.write', opId: op(), actor: ACTOR, parts: [{ iri: cardIriOf('a5'), remove: true, expectedVersion: '1', prior: priorQuads(a, new Map()) }] });
    assert.equal(r.outcome, 'APPLIED', JSON.stringify(r));
    assert.deepEqual(await triplesOf(g, cardIriOf('a5')), [], 'the card subject holds nothing');
    assert.equal((await rows(g, `SELECT ?s WHERE { ?s ?p ?o FILTER(STRSTARTS(STR(?s), "${cardIriOf('a5')}/")) }`)).length, 0, 'no derived node survives');
    assert.equal((await rows(g, 'SELECT ?t WHERE { <https://scrumboard.local/concept/keep-me> a ?t }')).length, 1, 'the shared concept stays');
  });
});

test('#1598 card.write: card text that reads like SPARQL ("…; delete …", "; INSERT") is stored and read back exactly, never refused as a second operation', { skip: SKIP }, async () => {
  await withExec(async (g) => {
    const text = 'step 1; delete the old file\nthen ; INSERT DATA { <x> <y> "z" } and a quote " and \\ backslash, é, 🚀';
    const a = card('a6', 1, { title: 'x; DELETE WHERE { ?s ?p ?o }', description: text });
    const r = await g.update({ kind: 'card.write', opId: op(), actor: ACTOR, parts: [part(a, null)] });
    assert.equal(r.outcome, 'APPLIED', JSON.stringify(r));
    const got = await rows(g, `SELECT ?t ?j WHERE { <${cardIriOf('a6')}> <https://schema.org/text> ?t ; <https://scrumboard.local/ns#entityJson> ?j }`);
    assert.equal(got[0].t.value, text, 'the text reads back byte-for-byte');
    assert.deepEqual(JSON.parse(got[0].j.value), a, 'the wire JSON reads back as the same card');
  });
});
