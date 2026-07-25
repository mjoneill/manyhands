/**
 * Server-side tests for wikilink parsing + backlink derivation (core/links.mjs).
 * Pure (no server, no I/O) — behavior tests on the derived link structure.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWikiLinks, buildLinkIndex } from '../core/links.mjs';

// ── parseWikiLinks ────────────────────────────────────────────────────────

test('extracts [[targets]] in first-seen order, deduplicated', () => {
  assert.deepEqual(
    parseWikiLinks('see [[Alpha]] and [[Beta]], then [[Alpha]] again'),
    ['Alpha', 'Beta'],
  );
});

test('keeps the target of a [[Target|alias]] piped link', () => {
  assert.deepEqual(parseWikiLinks('[[Real Page|shown text]]'), ['Real Page']);
});

test('trims whitespace inside the brackets', () => {
  assert.deepEqual(parseWikiLinks('[[  Spacey Title  ]]'), ['Spacey Title']);
});

test('returns [] for no links or non-string input', () => {
  assert.deepEqual(parseWikiLinks('plain text, no links'), []);
  assert.deepEqual(parseWikiLinks(null), []);
  assert.deepEqual(parseWikiLinks(undefined), []);
});

// ── buildLinkIndex ────────────────────────────────────────────────────────

test('derives outbound links + backlinks, resolved by node name (case-insensitive)', () => {
  const nodes = [
    { '@id': 'a', name: 'Alpha', text: 'links to [[Beta]]' },
    { '@id': 'b', name: 'Beta', text: 'no links here' },
    { '@id': 'c', name: 'Gamma', text: 'also points to [[beta]] (lowercased)' },
  ];
  const { outbound, backlinks } = buildLinkIndex(nodes);
  assert.deepEqual(outbound.get('a'), ['b']);
  assert.deepEqual(outbound.get('b'), []);
  assert.deepEqual(backlinks.get('b').sort(), ['a', 'c']);
  assert.deepEqual(backlinks.get('a'), []);
});

test('ignores self-links and unresolved targets', () => {
  const nodes = [
    { '@id': 'a', name: 'Alpha', text: 'see [[Alpha]] (self) and [[Nonexistent]]' },
  ];
  const { outbound, backlinks } = buildLinkIndex(nodes);
  assert.deepEqual(outbound.get('a'), []);
  assert.deepEqual(backlinks.get('a'), []);
});
