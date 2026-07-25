/**
 * #229 — pure logic for the wiki nav: filter (field:value + free text, mirroring
 * the board's #53 syntax over schema.org nodes), sort comparators, and tree
 * transforms (prune-to-matches keeping ancestors; sort each level). The DOM
 * wiring is covered by wiki-e2e; here we pin the pure core.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesNodeQuery, nodeComparator, filterTree, sortTree } from '../core/nav.mjs';

const node = (over = {}) => ({
  '@id': 'x', identifier: 1, name: 'Alpha Page', text: 'hello world',
  additionalType: 'scrum:task', dateCreated: '2026-01-01T00:00:00Z', dateModified: '2026-02-01T00:00:00Z',
  board: { labels: ['wiki', 'infra'], assignees: ['sage'], priority: 'p1', column: 'backlog', for: '' },
  ...over,
});

test('matchesNodeQuery: empty query matches everything', () => {
  assert.equal(matchesNodeQuery(node(), ''), true);
  assert.equal(matchesNodeQuery(node(), '   '), true);
});

test('matchesNodeQuery: free text hits name, body, and #id', () => {
  assert.equal(matchesNodeQuery(node(), 'alpha'), true);
  assert.equal(matchesNodeQuery(node(), 'world'), true);
  assert.equal(matchesNodeQuery(node(), '#1'), true);
  assert.equal(matchesNodeQuery(node(), 'absent'), false);
});

test('matchesNodeQuery: field:value over schema.org node + board facet', () => {
  assert.equal(matchesNodeQuery(node(), 'type:task'), true);
  assert.equal(matchesNodeQuery(node(), 'type:idea'), false);
  assert.equal(matchesNodeQuery(node(), 'label:wiki'), true);
  assert.equal(matchesNodeQuery(node(), 'label:nope'), false);
  assert.equal(matchesNodeQuery(node(), 'assignee:sage'), true);
  assert.equal(matchesNodeQuery(node(), 'priority:p1'), true);
  assert.equal(matchesNodeQuery(node(), 'column:backlog'), true);
  assert.equal(matchesNodeQuery(node(), 'id:1'), true);
  assert.equal(matchesNodeQuery(node(), 'id:2'), false);
});

test('matchesNodeQuery: terms AND together; unknown field falls back to free text', () => {
  assert.equal(matchesNodeQuery(node(), 'alpha type:task'), true);
  assert.equal(matchesNodeQuery(node(), 'alpha type:idea'), false, 'one failing term fails the whole query');
  assert.equal(matchesNodeQuery(node(), 'bogus:thing'), false, 'unknown field → free-text, no match');
  assert.equal(matchesNodeQuery(node({ text: 'has bogus:thing literally' }), 'bogus:thing'), true);
});

test('nodeComparator: alpha (default), edited (dateModified desc), created (dateCreated desc)', () => {
  const a = node({ name: 'Apple', dateCreated: '2026-01-01Z', dateModified: '2026-01-01Z' });
  const b = node({ name: 'banana', dateCreated: '2026-03-01Z', dateModified: '2026-02-01Z' });
  const c = node({ name: 'Cherry', dateCreated: '2026-02-01Z', dateModified: '2026-03-01Z' });
  const names = (cmp) => [a, b, c].slice().sort(cmp).map((n) => n.name);
  assert.deepEqual(names(nodeComparator('alpha')), ['Apple', 'banana', 'Cherry'], 'case-insensitive alpha');
  assert.deepEqual(names(nodeComparator('edited')), ['Cherry', 'banana', 'Apple'], 'most-recently-edited first');
  assert.deepEqual(names(nodeComparator('created')), ['banana', 'Cherry', 'Apple'], 'newest-created first');
});

// tree branch shape: { id, node, children: [branch] }
const br = (name, children = [], over = {}) => ({
  id: name, node: node({ name, ...over }), children,
});

test('filterTree: keeps matches AND their ancestors, prunes the rest', () => {
  const tree = [
    br('Parent', [br('Child-match', [], { name: 'needle' }), br('Child-miss')]),
    br('Lonely'),
  ];
  const pred = (n) => matchesNodeQuery(n, 'needle');
  const out = filterTree(tree, pred);
  assert.equal(out.length, 1, 'Lonely pruned; Parent kept as ancestor');
  assert.equal(out[0].node.name, 'Parent');
  assert.equal(out[0].children.length, 1, 'only the matching child remains');
  assert.equal(out[0].children[0].node.name, 'needle');
});

test('sortTree: orders every level by the comparator', () => {
  const tree = [
    br('Beta', [br('Yak'), br('Ant')]),
    br('Alpha'),
  ];
  const out = sortTree(tree, nodeComparator('alpha'));
  assert.deepEqual(out.map((b) => b.node.name), ['Alpha', 'Beta'], 'roots sorted');
  assert.deepEqual(out[1].children.map((b) => b.node.name), ['Ant', 'Yak'], 'children sorted too');
});
