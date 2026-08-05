/**
 * #685 — the `board` blob dissolves: kanban mechanics become first-class
 * scrum: predicates on the card node, and relationships become @id edges a
 * graph engine can follow.
 *
 * The load-bearing design decision: this is a DOCUMENT-level transform.
 * domainToJsonLd flattens the facet and converts relationship shortIds to
 * @id references (it alone holds the whole graph, so it alone can build the
 * shortId↔uuid map); jsonLdToDomain re-nests and converts back. The domain
 * model, server handlers, #614 inverse-sync, API contract (shortIds), and
 * the event log keep their existing shapes untouched — the document becomes
 * graph-complete while the app model stays stable, exactly the #686/#687
 * pattern.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainToJsonLd, jsonLdToDomain } from '../core/jsonld.mjs';

const mkDomain = () => ({
  nodes: [
    { '@type': 'CreativeWork', '@id': 'uuid-a', identifier: 90, name: 'alpha', text: '',
      additionalType: 'scrum:task',
      board: { column: 'backlog', order: 0, assignees: ['ada'], priority: 'p2',
               labels: ['x'], for: '',
               relationships: { relatedTo: [91], blockedBy: [], supersedes: [],
                                derivedFrom: [], supersededBy: [] } } },
    { '@type': 'CreativeWork', '@id': 'uuid-b', identifier: 91, name: 'beta', text: '',
      additionalType: 'scrum:idea',
      board: { column: 'done', order: 1, assignees: [], priority: null, labels: [],
               for: '', claimedBy: 'bex', claimedAt: '2026-08-05T00:00:00Z',
               relationships: { relatedTo: [90, 999], blockedBy: [90], supersedes: [],
                                derivedFrom: [], supersededBy: [] },
               _extra: { assignee: 'legacy-singular' } } },
  ],
  messages: [], columns: [], nextShortId: 92, lastUpdated: null,
});

test('the board blob is GONE from the document: mechanics are first-class properties', () => {
  const doc = domainToJsonLd(mkDomain());
  const a = doc['@graph'].find((e) => e['@id'] === 'uuid-a');
  assert.equal(a.board, undefined, 'no more untyped facet');
  assert.equal(a.column, 'backlog', 'column is a property (an @id edge per #687 context)');
  assert.deepEqual(a.assignees, ['ada'], 'assignees surface as the @id-typed term');
  assert.equal(a['scrum:priority'], 'p2');
  assert.equal(a['scrum:order'], 0);
});

test('relationships are @id references in the document, shortIds in the domain — both exactly', () => {
  const doc = domainToJsonLd(mkDomain());
  const a = doc['@graph'].find((e) => e['@id'] === 'uuid-a');
  assert.deepEqual(a.relatedTo, ['uuid-b'], 'shortId 91 became the @id of the node it names');
  const b = doc['@graph'].find((e) => e['@id'] === 'uuid-b');
  assert.deepEqual(b.blockedBy, ['uuid-a']);
  // A DANGLING shortId (999 names no card) survives verbatim rather than being
  // dropped or guessed — losslessness beats tidiness, and the round trip must
  // return it to the domain untouched.
  assert.deepEqual(b.relatedTo, ['uuid-a', 999], 'resolvable converts; dangling rides verbatim');

  const back = jsonLdToDomain(doc);
  assert.deepEqual(back, mkDomain(), 'EXACT round trip — shortIds restored, _extra intact');
});

test('@context declares every relationship term as an @id edge', () => {
  const ctx = domainToJsonLd(mkDomain())['@context'];
  for (const t of ['relatedTo', 'blockedBy', 'supersedes', 'derivedFrom', 'supersededBy']) {
    assert.equal(ctx[t]?.['@type'], '@id', `${t} is a graph edge, not a number list`);
  }
});

test('legacy documents (board blob still nested) load to the identical domain', () => {
  const domain = mkDomain();
  // hand-build the OLD document shape: facet nested, relationships as shortIds
  const legacyDoc = {
    '@context': {}, '@graph': structuredClone(domain.nodes), 'scrum:meta':
      { columns: [], nextShortId: 92, lastUpdated: null },
  };
  const back = jsonLdToDomain(legacyDoc);
  assert.deepEqual(back.nodes, domain.nodes, 'blob-shaped nodes pass through unchanged');
});

test('empty relationship arrays and absent facet fields survive the round trip', () => {
  const domain = mkDomain();
  delete domain.nodes[0].board.relationships;      // a card with no relationships key at all
  domain.nodes[0].board.labels = [];
  const back = jsonLdToDomain(domainToJsonLd(domain));
  assert.deepEqual(back, domain, 'absence and emptiness are both preserved, not normalized');
});
