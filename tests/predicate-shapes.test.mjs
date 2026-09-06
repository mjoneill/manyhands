/**
 * #1244 — the shape of a predicate's object, sampled rather than authored.
 *
 * The failure this prevents, twice measured: the RIGHT predicate with the WRONG
 * object shape returns a clean zero, indistinguishable from "nothing matches".
 * A registry of definitions does not prevent it — checked, it carries no shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHAPE_QUERY, shapeOf, prefixOf, withObjectShapes } from '../core/predicate-shapes.mjs';

test('#1244 shapeOf: iri, literal, mixed — and NONE is not literal', () => {
  assert.equal(shapeOf({ n: 6, iris: 6 }), 'iri');
  assert.equal(shapeOf({ n: 6, iris: 0 }), 'literal');
  assert.equal(shapeOf({ n: 6, iris: 3 }), 'mixed');
  // ⛔ the load-bearing case: registered and never used has NO shape. Reporting
  // "literal" here would invent a fact about data that does not exist, which is
  // the exact defect one layer up.
  assert.equal(shapeOf({ n: 0, iris: 0 }), 'none');
  assert.equal(shapeOf({}), 'none');
  assert.equal(shapeOf({ n: 5 }), 'unknown', 'a count we cannot classify is UNKNOWN, never a guess');
});

test('#1244 the engine classifies, not a regex — the query asks isIRI', () => {
  // A literal containing a colon is indistinguishable from an IRI by string
  // inspection: "2026-09-06T09:00:07.001Z" vs "column:backlog".
  assert.match(SHAPE_QUERY, /isIRI\(\?o\)/);
  assert.match(SHAPE_QUERY, /GROUP BY \?p/);
  assert.match(SHAPE_QUERY, /COUNT\(\?o\)/);
  assert.match(SHAPE_QUERY, /SUM\(/, 'counting IRIs is what makes MIXED sayable rather than a majority vote');
});

test('#1244 prefixOf: the prefix a seat must type, and only for an IRI', () => {
  assert.equal(prefixOf('column:col-mpa03u7z-342ye', 'iri'), 'column');
  assert.equal(prefixOf('entity:abc', 'iri'), 'entity');
  assert.equal(prefixOf('bug', 'literal'), null);
  assert.equal(prefixOf('2026-09-06T09:00:07.001Z', 'literal'), null, 'a colon in a LITERAL is not a prefix');
  assert.equal(prefixOf(null, 'iri'), null);
});

test('#1244 withObjectShapes joins meaning to shape, and an unused predicate still appears', () => {
  const registry = [
    { name: 'scrum:column', definition: 'which lane a card is in' },
    { name: 'scrum:cardType', definition: 'the card type' },
    { name: 'scrum:neverUsed', definition: 'registered, no instances' },
  ];
  const sample = [
    { p: 'scrum:column', n: '1124', iris: '1124', obj: 'column:backlog' },
    { p: 'scrum:cardType', n: '1124', iris: '0', obj: 'bug' },
  ];
  const out = withObjectShapes(registry, sample);
  assert.equal(out.length, 3, 'a registered predicate with no rows is still reported — absence must not look like omission');

  const col = out.find((p) => p.name === 'scrum:column');
  assert.equal(col.objectShape.shape, 'iri');
  assert.equal(col.objectShape.prefix, 'column');
  assert.equal(col.objectShape.sample, 'column:backlog');
  assert.match(col.objectShape.means, /never a quoted string/);
  assert.equal(col.definition, 'which lane a card is in', 'the meaning survives the join');

  const kind = out.find((p) => p.name === 'scrum:cardType');
  assert.equal(kind.objectShape.shape, 'literal');
  assert.equal(kind.objectShape.prefix, null);

  const unused = out.find((p) => p.name === 'scrum:neverUsed');
  assert.equal(unused.objectShape.shape, 'none');
  assert.equal(unused.objectShape.sample, null);
  assert.equal(unused.objectShape.observed, 0);
  assert.match(unused.objectShape.means, /not the same as a literal/);
});

test('#1244 MIXED says so rather than picking a winner', () => {
  const out = withObjectShapes(
    [{ name: 'scrum:sometimes', definition: 'd' }],
    [{ p: 'scrum:sometimes', n: '10', iris: '4', obj: 'entity:x' }],
  );
  assert.equal(out[0].objectShape.shape, 'mixed');
  assert.match(out[0].objectShape.means, /BOTH kinds/);
});
