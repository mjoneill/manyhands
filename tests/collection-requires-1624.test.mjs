/**
 * #1624 — the collections unit guards a reference only when the write SETS it (review: guard the reference, invent no
 * permanent-reference semantics). Pure: plan() against a cache loaded from a stub client, no executor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCollectionsUnit } from '../core/collections-unit.mjs';

const RS = 'https://scrumboard.local/ns#';
const role = (definedBy, name = 'r') => ({ '@id': 'https://scrumboard.local/role/r', '@type': 'scrum:Role', name, 'scrum:definedBy': definedBy });
const stub = (rows) => ({ query: async () => ({ ok: true, rows }) });
const rowOf = (e, v = 1) => ({ s: { value: e['@id'] }, k: { value: 'roles' }, v: { value: String(v) }, j: { value: JSON.stringify(e) } });
const unitWith = async (rows) => {
  const u = createCollectionsUnit({ client: stub(rows), families: [{ key: 'roles', requires: (e) => (e['scrum:definedBy'] ? [`https://scrumboard.local/entity/${e['scrum:definedBy']}`] : []) }], mintId: () => 'x' });
  await u.load(); return u;
};

test('a create that sets a reference requires its target', async () => {
  const u = await unitWith([]);
  const [p] = u.plan({ roles: [role('c1')] });
  assert.deepEqual(p.requires, ['https://scrumboard.local/entity/c1']);
});

test('an edit that leaves the reference unchanged does not require it again (the target may since have gone)', async () => {
  const u = await unitWith([rowOf(role('c1'))]);
  const [p] = u.plan({ roles: [role('c1', 'renamed')] });
  assert.equal(p.expectedVersion, '1');
  assert.equal(p.requires, undefined);
});

test('an edit that CHANGES the reference requires the new target only', async () => {
  const u = await unitWith([rowOf(role('c1'))]);
  const [p] = u.plan({ roles: [role('c2')] });
  assert.deepEqual(p.requires, ['https://scrumboard.local/entity/c2']);
});

test('a removal requires nothing', async () => {
  const u = await unitWith([rowOf(role('c1'))]);
  const [p] = u.plan({ roles: [] });
  assert.equal(p.remove, true);
  assert.equal(p.requires, undefined);
});
