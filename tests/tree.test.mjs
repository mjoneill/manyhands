/**
 * Server-side tests for hierarchy derivation (core/tree.mjs).
 * Pure — behavior tests on the derived tree from node `isPartOf` pointers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChildIndex, buildTree } from '../core/tree.mjs';

const nodes = [
  { '@id': 'root1', name: 'Root 1' },
  { '@id': 'c1', name: 'Child 1', isPartOf: 'root1' },
  { '@id': 'c2', name: 'Child 2', isPartOf: 'root1' },
  { '@id': 'gc', name: 'Grandchild', isPartOf: 'c1' },
  { '@id': 'root2', name: 'Root 2' },
];

test('buildChildIndex derives children + roots from isPartOf (input order kept)', () => {
  const { children, roots } = buildChildIndex(nodes);
  assert.deepEqual(roots, ['root1', 'root2']);
  assert.deepEqual(children.get('root1'), ['c1', 'c2']);
  assert.deepEqual(children.get('c1'), ['gc']);
  assert.deepEqual(children.get('gc'), []);
});

test('a node with a dangling parent (not in the set) is treated as a root', () => {
  const { roots, children } = buildChildIndex([{ '@id': 'orphan', isPartOf: 'missing' }]);
  assert.deepEqual(roots, ['orphan']);
  assert.deepEqual(children.get('orphan'), []);
});

test('buildTree nests recursively from the roots', () => {
  const tree = buildTree(nodes);
  assert.equal(tree.length, 2);
  const r1 = tree.find((t) => t.id === 'root1');
  assert.equal(r1.children.length, 2);
  const c1 = r1.children.find((t) => t.id === 'c1');
  assert.equal(c1.children[0].id, 'gc');
  assert.equal(c1.children[0].node.name, 'Grandchild');
});

test('buildTree terminates even on a parent cycle in the data', () => {
  // a↔b: each has an in-set parent, so neither is a root → empty tree, no hang.
  const tree = buildTree([
    { '@id': 'a', isPartOf: 'b' },
    { '@id': 'b', isPartOf: 'a' },
  ]);
  assert.deepEqual(tree, []);
});
