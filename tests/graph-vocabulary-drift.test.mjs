/**
 * #1104's open slice — the unknown-term guard's OWN staleness, measured on a
 * live store rather than a fixture.
 *
 * The guard refuses any schema:/scrum: term missing from GRAPH_VOCABULARY, a
 * hand-maintained set. The suite's drift test walks a fixture's projection and
 * passed clean while scrum:ofSilence was missing, because the fixture never
 * projected a tending entity — a control that did not traverse the population.
 * vocabularyDrift(store) walks WHATEVER store it is given, so pointed at the
 * production replica it answers "is the guard refusing a working query right
 * now?" by name, in both directions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import oxigraph from 'oxigraph';
import { buildGraphStore, vocabularyDrift, GRAPH_VOCABULARY, IRI } from '../core/graph-replica.mjs';
import { domainToJsonLd } from '../core/jsonld.mjs';

const doc = () => domainToJsonLd({
  nodes: [
    { '@type': 'CreativeWork', '@id': 'u-a', identifier: 1, name: 'alpha', text: 'body', additionalType: 'scrum:task',
      board: { column: 'backlog', order: 0, assignees: ['ada'], labels: ['x'], for: '', priority: 'p1',
        relationships: { relatedTo: ['u-b'], blockedBy: [], supersedes: [], derivedFrom: [], supersededBy: [] } } },
    { '@type': 'CreativeWork', '@id': 'u-b', identifier: 2, name: 'beta', text: '', additionalType: 'scrum:idea',
      board: { column: 'done', order: 0, assignees: [], labels: [], for: '', priority: null,
        relationships: { relatedTo: [], blockedBy: [], supersedes: [], derivedFrom: [], supersededBy: [] } } },
  ],
  messages: [{ '@type': 'Comment', '@id': 'm-1', text: 'about alpha', author: 'bex', about: 'u-a', dateCreated: '2026-08-05T00:00:00Z', mentions: [] }],
  people: [{ '@type': 'Person', '@id': 'https://scrumboard.local/person/ada', identifier: 'ada', name: 'Ada', 'scrum:glyph': null, 'scrum:resolved': true, 'scrum:aliases': [] }],
  columns: [{ id: 'backlog', name: 'Backlog', order: 0 }, { id: 'done', name: 'Done', order: 1 }],
  nextShortId: 3, lastUpdated: null,
});

test('a projected fixture has NO undeclared terms, and the report says what it counted', () => {
  const store = buildGraphStore(doc());
  const d = vocabularyDrift(store);
  assert.deepEqual(d.undeclared, [], `undeclared: ${d.undeclared.join(', ')}`);
  assert.equal(d.ok, true);
  assert.ok(d.emitted > 5, 'the fixture projects something — the check is not vacuous');
  assert.equal(d.declared, GRAPH_VOCABULARY.size);
  assert.ok(Array.isArray(d.unused), 'unused is reported, not hidden');
  assert.match(d.means.undeclared, /refused/);
});

test('MUTATION CONTROL — a predicate the projection emits and the dictionary lacks is NAMED, in prefixed form', () => {
  const store = buildGraphStore(doc());
  const nn = (i) => oxigraph.namedNode(i);
  // scrum:ofSilence was the real miss (caught by the suite, since declared), so
  // the control plants a term that cannot be declared and must be named.
  assert.equal(GRAPH_VOCABULARY.has('scrum:ofSilence'), true, 'the real miss is now declared — the control must not depend on it');
  store.add(oxigraph.quad(nn(IRI.entity + 'u-a'), nn(IRI.scrum + 'neverDeclaredTerm'), oxigraph.literal('x')));
  const d = vocabularyDrift(store);
  assert.equal(d.ok, false);
  assert.deepEqual(d.undeclared, ['scrum:neverDeclaredTerm']);
});

test('MUTATION CONTROL — a class the projection emits and the dictionary lacks is named too', () => {
  const store = buildGraphStore(doc());
  const nn = (i) => oxigraph.namedNode(i);
  store.add(oxigraph.quad(nn(IRI.entity + 'zzz'), nn(IRI.rdf + 'type'), nn(IRI.scrum + 'Widget')));
  const d = vocabularyDrift(store);
  assert.deepEqual(d.undeclared, ['scrum:Widget']);
});

test('terms outside schema:/scrum: are not the guard\'s business and are not judged', () => {
  const store = buildGraphStore(doc());
  const nn = (i) => oxigraph.namedNode(i);
  store.add(oxigraph.quad(nn(IRI.entity + 'u-a'), nn('https://example.org/other#thing'), oxigraph.literal('x')));
  store.add(oxigraph.quad(nn(IRI.entity + 'u-a'), nn(IRI.rdf + 'type'), nn(IRI.prov + 'Activity')));
  assert.equal(vocabularyDrift(store).ok, true);
});
