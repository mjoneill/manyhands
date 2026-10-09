/**
 * #1639 — core/columns-unit.mjs in isolation (no executor): the plain ↔ node translation, the snapshot's stored order,
 * the plan's parts (creates, updates, removes), the commit's ONE entity.put, and fail-loud on an unloaded cache.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createColumnsUnit, columnToNode, nodeToColumn } from '../core/columns-unit.mjs';

function fakeClient(columns) {
  const sent = [];
  return {
    sent,
    async query(q) {
      if (/BIND\(1 AS \?x\)/.test(q)) return { ok: true, rows: [{ x: { value: '1' } }] };
      return { ok: true, rows: columns.map((c) => ({ s: { value: columnToNode(c)['@id'] }, k: { value: 'columns' }, v: { value: '1' }, j: { value: JSON.stringify(columnToNode(c)) } })) };
    },
    async update(intention) { sent.push(intention); return { outcome: 'APPLIED' }; },
    async reconcile() { return { outcome: 'ABSENT' }; },
  };
}
const FOUR = [{ id: 'done', name: 'Done', order: 3 }, { id: 'backlog', name: 'Backlog', order: 0 }, { id: 'planned', name: 'Planned', order: 1 }, { id: 'in-progress', name: 'In Progress', order: 2 }];

test('the translation is lossless both ways, extra fields included', () => {
  const c = { id: 'x', name: 'X', order: 4, colour: 'red' };
  assert.deepEqual(columnToNode(c), { '@type': 'scrum:Column', '@id': 'https://scrumboard.local/column/x', identifier: 'x', name: 'X', 'scrum:order': 4, colour: 'red' });
  assert.deepEqual(nodeToColumn(columnToNode(c)), c);
});

test('an unloaded unit refuses to snapshot or plan (never an empty list)', () => {
  const u = createColumnsUnit({ client: fakeClient(FOUR), mintId: () => 'm' });
  assert.throws(() => u.snapshot(), /collections are unavailable/);
  assert.throws(() => u.plan(FOUR), /collections are unavailable/);
});

test('the snapshot is the stored order; an unchanged list plans nothing', async () => {
  const u = createColumnsUnit({ client: fakeClient(FOUR), mintId: () => 'm' });
  await u.load();
  assert.deepEqual(u.snapshot().map((c) => c.id), ['backlog', 'planned', 'in-progress', 'done']);
  assert.deepEqual(u.plan(u.snapshot()), []);
});

test('create, update and remove each plan one guarded part; a commit sends ONE entity.put and updates the cache', async () => {
  const client = fakeClient(FOUR);
  const u = createColumnsUnit({ client, mintId: () => 'm' });
  await u.load();
  const next = u.snapshot().filter((c) => c.id !== 'done').map((c) => (c.id === 'planned' ? { ...c, name: 'Next' } : c));
  next.push({ id: 'review', name: 'Review', order: 4 });
  const parts = u.plan(next);
  const by = Object.fromEntries(parts.map((p) => [p.iri.replace(/^.*\//, ''), p]));
  assert.deepEqual(Object.keys(by).sort(), ['done', 'planned', 'review']);
  assert.equal(by.done.remove, true);
  assert.equal(by.planned.expectedVersion, '1'); assert.equal(by.planned.version, '2');
  assert.equal(by.review.expectedVersion, null);
  assert.ok(by.review.quads.some(([, p, o]) => p.value.endsWith('#order') && o.datatype === 'http://www.w3.org/2001/XMLSchema#integer'));
  const r = await u.commit(next, { actor: 'ada' });
  assert.equal(r.outcome, 'APPLIED');
  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].kind, 'entity.put'); assert.equal(client.sent[0].entity.kind, 'collection');
  assert.equal(client.sent[0].entity.parts.length, 3);
  assert.deepEqual(u.snapshot().map((c) => c.id), ['backlog', 'planned', 'in-progress', 'review']);
  assert.equal(u.snapshot().find((c) => c.id === 'planned').name, 'Next');
});

test('an executor away: the commit throws the unavailable error and nothing is applied', async () => {
  const client = fakeClient(FOUR);
  client.update = async () => ({ outcome: 'UNAVAILABLE', reason: 'connection refused' });
  const u = createColumnsUnit({ client, mintId: () => 'm' });
  await u.load();
  await assert.rejects(u.commit([...u.snapshot(), { id: 'n', name: 'N', order: 9 }]), (e) => e.code === 'COLLECTIONS_UNAVAILABLE');
  assert.equal(u.snapshot().length, 4);
});
