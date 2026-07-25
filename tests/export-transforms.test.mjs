/**
 * Behavior tests for the export transform layer (core/export-transforms.mjs).
 *
 * Context: your wiki keeps your team's real language. Adaptation for an outside
 * reader happens at the EXPORT boundary, never in the source — a record you
 * sanitise while you are still writing it is a record you can no longer trust.
 *
 * The load-bearing property is FAIL-CLOSED: the export must refuse to emit when
 * an un-transformed term survives, so the scrub is guaranteed by construction
 * rather than by whoever ran it having looked carefully. Every test below asks
 * "would this still pass if the implementation were a no-op?" — none would.
 *
 * NB for anyone editing these fixtures: keep `find` and `replace` DIFFERENT.
 * A rule that replaces a term with itself makes the assertion true no matter
 * what the implementation does, and the test goes on passing while the feature
 * is broken.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTransforms, findResidue, transformForExport } from '../core/export-transforms.mjs';

const cfg = (rules = [], forbidden = []) => ({ rules, forbidden });

test('applyTransforms substitutes a simple term', () => {
  const out = applyTransforms('the Nickname seat', cfg([{ find: 'Nickname', replace: 'Oscar' }]));
  assert.equal(out, 'the Oscar seat');
});

test('applyTransforms replaces EVERY occurrence, not just the first', () => {
  const out = applyTransforms('local-name and local-name', cfg([{ find: 'local-name', replace: 'token-ring' }]));
  assert.equal(out, 'token-ring and token-ring');
});

test('rules apply in order, so a phrase rule can pre-empt a word rule', () => {
  // The case that motivates ordering: the source explains WHY the internal name
  // was chosen. A bare word-swap leaves that explanation standing as a claim
  // about the NEW name — a sentence that was never true of it. The phrase rule
  // must win by running first.
  const out = applyTransforms(
    "mode: 'local-name' — local-name being a name that makes us laugh. Also local-name elsewhere.",
    cfg([
      { find: "mode: 'local-name' — local-name being a name that makes us laugh\\.", replace: "mode: 'token-ring'." },
      { find: 'local-name', replace: 'token-ring' },
    ]),
  );
  assert.equal(out, "mode: 'token-ring'. Also token-ring elsewhere.");
  assert.ok(!/laugh/.test(out), 'the now-false clause must be gone');
});

test('findResidue reports a forbidden term that survived', () => {
  const residue = findResidue('the LocalName mode', cfg([], [{ pattern: 'localname', flags: 'gi' }]));
  assert.equal(residue.length, 1);
  assert.match(residue[0].sample, /LocalName/);
});

test('findResidue catches a CASE VARIANT the rule missed', () => {
  // A lowercase-only rule leaves "LocalName" behind. This is the realistic bug:
  // the scrub looks done and isn't. The forbidden check must be case-insensitive
  // independently of how the rule was written.
  const text = applyTransforms('localname and LocalName', cfg([{ find: 'localname', replace: 'token-ring' }]));
  assert.match(text, /LocalName/, 'precondition: the case variant survives the rule');
  const residue = findResidue(text, cfg([], [{ pattern: 'localname', flags: 'gi' }]));
  assert.equal(residue.length, 1, 'the surviving variant must be caught');
});

test('findResidue returns empty when the text is clean', () => {
  const residue = findResidue('token-ring mode', cfg([], [{ pattern: 'localname', flags: 'gi' }]));
  assert.deepEqual(residue, []);
});

test('FAIL-CLOSED: transformForExport THROWS when a forbidden term survives', () => {
  // The load-bearing guarantee. A config that forbids a term but has no rule
  // for it must abort the export rather than emit a leaky artifact.
  assert.throws(
    () => transformForExport('the localname mode', cfg([], [{ pattern: 'localname', flags: 'gi' }])),
    /residue|localname/i,
  );
});

test('FAIL-CLOSED: the thrown error names the offending term and its context', () => {
  // Diagnostics matter: a refusal that does not say WHAT leaked just gets
  // worked around. The message must be actionable.
  try {
    transformForExport('a Nickname reference remains', cfg([], [{ pattern: 'nickname', flags: 'gi' }]));
    assert.fail('expected a throw');
  } catch (err) {
    assert.match(err.message, /Nickname/, 'must quote the surviving term');
  }
});

test('transformForExport returns the transformed text when the scrub is complete', () => {
  const out = transformForExport(
    'the Nickname seat runs localname',
    cfg(
      [{ find: 'Nickname', replace: 'Oscar' }, { find: 'localname', replace: 'token-ring' }],
      [{ pattern: 'nickname', flags: 'gi' }, { pattern: 'localname', flags: 'gi' }],
    ),
  );
  assert.equal(out, 'the Oscar seat runs token-ring');
});

test('a rule whose replacement itself contains a forbidden term still fails closed', () => {
  // Guards against a config that "fixes" a term by rewording into it again.
  assert.throws(
    () => transformForExport(
      'the mode',
      cfg([{ find: 'the mode', replace: 'the localname mode' }], [{ pattern: 'localname', flags: 'gi' }]),
    ),
    /localname/i,
  );
});
