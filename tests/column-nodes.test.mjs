/**
 * #687 — columns become GRAPH NODES: out of scrum:meta, into @graph as typed
 * entities, with card.column resolving to them as an @id edge by declaration.
 *
 * The principal's scope note (2026-08-05): columns are DYNAMIC (add/remove/
 * reorder) and vertical order carries scrum meaning. The lifecycle half was
 * already true before this slice — column create/update/delete all emit log
 * events, and card order rides update events — so this slice owes only the
 * REPRESENTATION: the document says what the system already records.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainToJsonLd, jsonLdToDomain, COLUMN_IRI_BASE } from '../core/jsonld.mjs';

const mkDomain = () => ({
  nodes: [
    { '@type': 'CreativeWork', '@id': 'c1', identifier: 1, name: 't', text: 'b',
      additionalType: 'scrum:task',
      board: { assignees: [], labels: ['triage'], column: 'backlog', order: 0 } },
  ],
  messages: [],
  columns: [
    { id: 'backlog', name: 'Backlog', order: 0 },
    { id: 'done', name: 'Done', order: 1 },
  ],
  nextShortId: 2, lastUpdated: null,
});

test('columns ride @graph as scrum:Column nodes and round-trip to plain {id,name,order} exactly', () => {
  const domain = mkDomain();
  const doc = domainToJsonLd(domain);
  const cols = doc['@graph'].filter((e) => e['@type'] === 'scrum:Column');
  assert.equal(cols.length, 2, 'both columns are IN the graph');
  assert.equal(cols[0]['@id'], `${COLUMN_IRI_BASE}backlog`, 'node @id lives where the @context points');
  assert.equal(cols[0]['scrum:order'], 0, 'vertical order is graph state, not decoration');
  assert.equal(doc['scrum:meta'].columns, undefined, 'meta no longer carries columns');

  const back = jsonLdToDomain(doc);
  assert.deepEqual(back, domain, 'exact inverse — consumers keep reading plain domain.columns');
  // the phantom-card control, same as #686's: a Column must never round-trip
  // into the card collection.
  assert.equal(back.nodes.some((n) => n['@type'] === 'scrum:Column'), false);
});

test('legacy documents with columns still in scrum:meta load unchanged (lazy flip on next save)', () => {
  const legacy = {
    '@context': {}, '@graph': [],
    'scrum:meta': { columns: [{ id: 'x', name: 'X', order: 0 }], nextShortId: 1, lastUpdated: null },
  };
  const domain = jsonLdToDomain(legacy);
  assert.deepEqual(domain.columns, [{ id: 'x', name: 'X', order: 0 }], 'meta columns surface as domain.columns');
  const resaved = domainToJsonLd(domain);
  assert.equal(resaved['scrum:meta'].columns, undefined, 'the next save flips them into @graph');
  assert.equal(resaved['@graph'].filter((e) => e['@type'] === 'scrum:Column').length, 1);
});

test('@context: card.column is an @id edge into the column IRI space; labels get a defined term as literals', () => {
  const ctx = domainToJsonLd(mkDomain())['@context'];
  assert.equal(ctx.column?.['@type'], '@id', 'a card\'s column string IS a reference');
  assert.equal(ctx.column?.['@context']?.['@base'], COLUMN_IRI_BASE);
  // labels are concepts, not identities: a defined term, deliberately NOT
  // @id-typed — the graph-complete claim needs the predicate named, not a
  // node minted per label string.
  assert.equal(typeof ctx.labels, 'string', 'labels term is defined');
  assert.equal(ctx.labels?.['@type'], undefined, 'and stays a literal, not a reference');
});

test('unknown fields on a column survive the round trip (losslessness, the slice-1 keystone)', () => {
  const domain = mkDomain();
  domain.columns[0].wipLimit = 5;   // a future field nobody modelled yet
  const back = jsonLdToDomain(domainToJsonLd(domain));
  assert.deepEqual(back, domain, 'unmodelled column fields ride through untouched');
});
