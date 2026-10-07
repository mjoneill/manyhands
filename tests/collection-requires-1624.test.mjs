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

test('a new entity that INHERITS its parent\'s reference (a role version) is not re-guarded; one that changes it is', async () => {
  const roleRow = rowOf(role('c1'));
  const u = createCollectionsUnit({ client: stub([roleRow, { ...rowOf({ '@id': 'https://scrumboard.local/role/r/v1', 'scrum:ofRole': 'https://scrumboard.local/role/r', 'scrum:definedBy': 'c1' }), k: { value: 'roleVersions' } }]),
    families: [{ key: 'roles', requires: (e) => (e['scrum:definedBy'] ? [`https://scrumboard.local/entity/${e['scrum:definedBy']}`] : []) },
      { key: 'roleVersions', requires: (e) => (e['scrum:definedBy'] ? [`https://scrumboard.local/entity/${e['scrum:definedBy']}`] : []), inherits: (e) => e['scrum:ofRole'] }], mintId: () => 'x' });
  await u.load();
  const v1 = u.snapshot().roleVersions[0];
  const keep = u.plan({ roles: [role('c1', 'renamed')], roleVersions: [v1, { '@id': 'https://scrumboard.local/role/r/v2', 'scrum:ofRole': 'https://scrumboard.local/role/r', 'scrum:definedBy': 'c1' }] });
  assert.deepEqual(keep.map((p) => p.requires), [undefined, undefined], 'the role keeps its card and the new version copies it: nothing re-guarded');
  const change = u.plan({ roles: [role('c2')], roleVersions: [v1, { '@id': 'https://scrumboard.local/role/r/v2', 'scrum:ofRole': 'https://scrumboard.local/role/r', 'scrum:definedBy': 'c2' }] });
  assert.deepEqual(change.map((p) => p.requires), [['https://scrumboard.local/entity/c2'], ['https://scrumboard.local/entity/c2']], 'a changed reference is guarded on both');
});
