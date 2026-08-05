/**
 * #227 — the JSON-LD storage serializer. The domain is already schema.org-shaped
 * (nodes = CreativeWork, messages = Comment); this proves we can persist it
 * directly as a JSON-LD document and read it back with ZERO loss — the keystone
 * for flipping on-disk storage from the legacy blob to schema.org-primary.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainToJsonLd, jsonLdToDomain } from '../core/jsonld.mjs';
import { boardToDomain } from '../core/mapping.mjs';

// A representative legacy board: a full card, a SPARSE card carrying a legacy
// singular `assignee`, a floating message, and a homed message with an
// attachment + a legacy `_recovered` straggler. If JSON-LD holds all of this
// losslessly, it holds the real corpus.
const board = {
  _README: ['⚠️  do not edit directly'],
  cards: [
    {
      id: 'a', shortId: 1, title: 'Alpha', description: '# hi', type: 'task',
      column: 'backlog', order: 0, assignees: ['sage'], labels: [], for: '',
      priority: 'p1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
      relationships: { relatedTo: [], blockedBy: [] }, parent: null,
    },
    { id: 'b', title: 'Beta', column: 'done', order: 1, assignee: 'robin' }, // sparse + legacy field
  ],
  conversations: [
    { id: 'm1', body: 'floating', author: 'sage', attachedTo: null, createdAt: '2026-01-03T00:00:00.000Z', mentions: [] },
    {
      id: 'm2', body: 'homed', author: 'alex', attachedTo: 'a', createdAt: '2026-01-04T00:00:00.000Z',
      mentions: ['sage'], attachments: [{ id: 'att1', name: 'x.png', mime: 'image/png', size: 10 }],
      _recovered: 'legacy note',
    },
  ],
  columns: [{ id: 'backlog', name: 'Backlog', order: 0 }, { id: 'done', name: 'Done', order: 1 }],
  nextShortId: 3,
  lastUpdated: '2026-01-05T00:00:00.000Z',
};

test('domain → JSON-LD → domain round-trips losslessly', () => {
  const domain = boardToDomain(board);
  const back = jsonLdToDomain(domainToJsonLd(domain));
  assert.deepEqual(back, domain);
});

test('the document is genuinely schema.org-shaped', () => {
  const doc = domainToJsonLd(boardToDomain(board));
  assert.equal(doc['@context']['@vocab'], 'https://schema.org/');
  assert.ok(Array.isArray(doc['@graph']), '@graph holds the node+message graph');

  const types = doc['@graph'].map((e) => e['@type']);
  assert.ok(types.includes('CreativeWork') && types.includes('Comment'),
    'one graph, both types: ' + types.join(','));

  const alpha = doc['@graph'].find((e) => e['@id'] === 'a');
  assert.equal(alpha.name, 'Alpha');                  // D3: name = title
  assert.equal(alpha.text, '# hi');                   // D3: text = body
  assert.equal(alpha.additionalType, 'scrum:task');   // D3: additionalType = type

  const meta = doc['scrum:meta'];
  assert.equal(meta.nextShortId, 3);
  assert.equal(meta.lastUpdated, '2026-01-05T00:00:00.000Z');
  assert.equal(doc['@graph'].filter((e) => e['@type'] === 'scrum:Column').length, 2, 'columns ride in @graph (#687)');
});

test('_README leads the file when present, omitted when absent', () => {
  const doc = domainToJsonLd(boardToDomain(board));
  assert.equal(Object.keys(doc)[0], '_README', '_README is the first key (convention)');

  const noReadme = boardToDomain(board);
  delete noReadme._README;
  const doc2 = domainToJsonLd(noReadme);
  assert.ok(!('_README' in doc2), '_README omitted when not in the domain');
  assert.deepEqual(jsonLdToDomain(doc2), noReadme, 'still round-trips without _README');
});

test('empty domain round-trips (fresh board)', () => {
  const empty = { nodes: [], messages: [], columns: [], nextShortId: 1, lastUpdated: null };
  assert.deepEqual(jsonLdToDomain(domainToJsonLd(empty)), empty);
});
