// #1762 S1b — the builder's half of S1b's proof (the black-box K rows in history-native-s1b-1762, written first, are the other
// half): the compiler DERIVES a record write's activity facts from the record, refuses a contradiction and a history on a kind
// that records none, and the one graph client attaches history to every record write when native history is on, identically
// in update() and reconcile(), so a replay of a lost ack keeps its digest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, canonicalize, digestOf, changeActivityIri } from '../core/graph-compiler.mjs';
import { withNativeHistory } from '../core/graph-client.mjs';

const ADA = 'https://scrumboard.local/person/ada';
const M = 'https://scrumboard.local/memory/m-1762';
const memoryCreate = (over = {}) => ({
  kind: 'memory.create', opId: 'urn:ex:op/memory/s1b-b1', actor: ADA,
  memory: { iri: M, identifier: 'm-1762', owner: ADA, name: 'one', tags: [], priority: null, currentVersion: `${M}/v/1`, relatedTo: [] },
  versions: [{ iri: `${M}/v/1`, version: '1', body: 'b', author: ADA, dateCreated: '2026-10-26T00:00:00Z' }],
  ...over,
});
const facts = (i) => canonicalize(i).record.history;

test('#1762 S1b B1 the compiler DERIVES op, entityKind and prov:used from the record; the caller cannot name them', () => {
  assert.deepEqual(facts({ ...memoryCreate(), history: true }), { op: 'create', entityKind: 'memory', used: M, versionAfter: '1' });
  assert.throws(() => compile({ ...memoryCreate(), history: { op: 'delete' } }), /unknown field history.op/, 'only versionAfter may be supplied');
  const wake = { kind: 'entity.put', opId: 'urn:ex:op/wake/s1b-b1', actor: ADA, entity: { kind: 'wake', iri: 'https://scrumboard.local/wake/w-1762', seat: 'ada', at: '2026-10-26T00:00:00Z', note: null, entityJson: '{}' }, history: true };
  assert.deepEqual(facts(wake), { op: 'create', entityKind: 'wake', used: 'https://scrumboard.local/wake/w-1762', versionAfter: 'unknown' });
});

test('#1762 S1b B2 a supplied versionAfter that CONTRADICTS the record is refused; one the record cannot know is taken', () => {
  assert.throws(() => compile({ ...memoryCreate(), history: { versionAfter: 3 } }), /contradicts the record's own version 1/);
  const revise = { kind: 'memory.revise', opId: 'urn:ex:op/memory/s1b-b2', actor: ADA, target: { iri: M, expectedVersion: '4' },
    set: { name: 'renamed', tags: [], priority: null, currentVersion: `${M}/v/1`, relatedTo: [] }, versions: [] };
  assert.equal(facts({ ...revise, history: true }).versionAfter, 'unknown', 'a title-only revise carries no version of its own');
  assert.equal(facts({ ...revise, history: { versionAfter: 1 } }).versionAfter, '1', 'the REST version the unit read is taken');
});

test('#1762 S1b B3 history on a kind that records none is REFUSED, never silently dropped (imports, a collection entity.put)', () => {
  assert.throws(() => compile({ kind: 'person.import', opId: 'urn:ex:op/person/s1b-b3', actor: ADA, people: [{ '@type': 'Person', '@id': ADA, identifier: 'ada' }], history: true }), /unknown field history/);
  assert.throws(() => compile({ kind: 'entity.put', opId: 'urn:ex:op/collections/s1b-b3', actor: ADA, history: true, entity: { kind: 'collection', parts: [] } }), /carries its history on each part/);
});

test('#1762 S1b B4 the activity rides the record\'s own guarded INSERT, is part 0, and a history-less intention\'s digest is UNCHANGED', () => {
  const plain = compile(memoryCreate());
  const withH = compile({ ...memoryCreate(), history: true });
  assert.ok(!/ChangeActivity/.test(plain.sparql), 'no history, no activity');
  assert.ok(withH.sparql.includes(changeActivityIri('urn:ex:op/memory/s1b-b1', 0)), 'the part-0 activity IRI');
  assert.ok(!/holderAtWrite|columnAfter|columnBefore|ns#shortId>/.test(withH.sparql), 'no card-only fact');
  assert.equal(plain.digest, digestOf(canonicalize(memoryCreate())), 'the history-less digest is the pre-S1b digest (record.history absent)');
  assert.notEqual(plain.digest, withH.digest, 'and the history is digest-covered');
});

test('#1762 S1b B5 the client attaches history to a RECORD write only with the flag ON; migrations, collections and explicit history are left alone', () => {
  const i = memoryCreate();
  assert.equal(withNativeHistory(i, false), i, 'flag off: unchanged');
  assert.equal(withNativeHistory(i, true).history, true, 'flag on: attached');
  const given = { ...i, history: { versionAfter: 1 } };
  assert.equal(withNativeHistory(given, true), given, 'an explicit history is the caller\'s');
  for (const opId of ['urn:ex:op/migrate-1561/memory/x', 'urn:ex:op/model-call/import/x', 'urn:ex:op/delivery/abc/import', 'urn:ex:op/backfill/x']) {
    assert.equal(withNativeHistory({ ...i, opId }, true).history, undefined, `${opId} is a migration`);
  }
  const coll = { kind: 'entity.put', opId: 'urn:ex:op/collections/x', actor: ADA, entity: { kind: 'collection', parts: [] } };
  assert.equal(withNativeHistory(coll, true), coll, 'a collection write carries history per part (S1), not here');
  const card = { kind: 'card.write', opId: 'urn:ex:op/card/x', actor: ADA, parts: [] };
  assert.equal(withNativeHistory(card, true), card, 'a card write computes its own facts (S1)');
});

test('#1762 S1b B6 update() and reconcile() attach the SAME history, so a lost ack\'s replay reconciles to the original digest', async () => {
  const prev = process.env.SCRUM_HISTORY_NATIVE; process.env.SCRUM_HISTORY_NATIVE = '1';
  try {
    const { createGraphClient } = await import('../core/graph-client.mjs');
    const seen = [];
    const fetchStub = async (url, opts = {}) => {
      seen.push(String(url));
      if (String(url).endsWith('/health') || String(url).includes('/identity')) return new Response(JSON.stringify({ ok: true, datasetId: 'b6', epoch: '1' }), { status: 200 });
      if (String(url).includes('/receipt/')) return new Response(JSON.stringify({ ok: true, outcome: 'APPLIED', digest: 'stub' }), { status: 200 });
      return new Response('{}', { status: 200 });
    };
    const c = createGraphClient({ baseUrl: 'http://127.0.0.1:9', expectedDatasetId: 'b6', timeoutMs: 1000, label: 'b6', fetch: fetchStub });
    const want = compile({ ...memoryCreate(), history: true }).digest;
    const r = await c.reconcile(memoryCreate());
    assert.equal(r.digest, want, `reconcile computed the digest of the history-bearing intention (${JSON.stringify(r)})`);
  } finally { if (prev === undefined) delete process.env.SCRUM_HISTORY_NATIVE; else process.env.SCRUM_HISTORY_NATIVE = prev; }
});
