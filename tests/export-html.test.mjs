/**
 * Behavior tests for the export HTML renderer (core/export-html.mjs) — #459.
 *
 * These target the constructs that would fail SILENTLY — a mangled table or a
 * reflowed ASCII diagram still produces a valid-looking file, so nothing warns
 * you; the reader just gets garbage. Each test would fail against a no-op or a
 * naive line-by-line renderer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderExportBody, renderExportHtml } from '../core/export-html.mjs';

test('fenced code survives verbatim — the ASCII diagram must not be reflowed', () => {
  const diagram = '  ┌────────┐\n  │ server │  ◄── two spaces, box chars\n  └────────┘';
  const html = renderExportBody('text\n\n```\n' + diagram + '\n```\n\nmore');
  assert.match(html, /<pre><code>/);
  // The exact bytes, including leading whitespace, must be preserved.
  assert.ok(html.includes(diagram), 'diagram content must appear unaltered');
});

test('markdown inside a fence is NOT interpreted', () => {
  const html = renderExportBody('```\n# not a heading\n- not a list\n**not bold**\n```');
  assert.ok(!/<h1>/.test(html), 'heading syntax inside a fence must stay literal');
  assert.ok(!/<li>/.test(html), 'list syntax inside a fence must stay literal');
  assert.ok(!/<strong>/.test(html), 'emphasis inside a fence must stay literal');
});

test('tables render as real tables, not raw pipes', () => {
  const md = '| Seat | Role |\n|---|---|\n| Sage | architect |\n| Nova | steward |';
  const html = renderExportBody(md);
  assert.match(html, /<table>/);
  assert.match(html, /<th>Seat<\/th>/);
  assert.match(html, /<td>architect<\/td>/);
  assert.equal((html.match(/<tr>/g) || []).length, 3, 'header + two body rows');
  assert.ok(!/\|/.test(html), 'no raw pipe characters should leak into the output');
});

test('a table immediately after a paragraph still renders (no blank-line dependency)', () => {
  const html = renderExportBody('Intro sentence.\n\n| A | B |\n|---|---|\n| 1 | 2 |');
  assert.match(html, /<p>Intro sentence\.<\/p>/);
  assert.match(html, /<table>/);
});

test('HTML in the source is escaped, not emitted live', () => {
  const html = renderExportBody('a <script>alert(1)</script> b');
  assert.ok(!/<script>/.test(html), 'script tags must never survive');
  assert.match(html, /&lt;script&gt;/);
});

test('code spans are not re-processed as emphasis', () => {
  const html = renderExportBody('use `a*b*c` and **real bold**');
  assert.match(html, /<code>a\*b\*c<\/code>/, 'asterisks inside code stay literal');
  assert.match(html, /<strong>real bold<\/strong>/);
});

test('blockquotes and horizontal rules render', () => {
  const html = renderExportBody('> quoted line\n\n---\n\nafter');
  assert.match(html, /<blockquote>quoted line<\/blockquote>/);
  assert.match(html, /<hr>/);
});

test('renderExportHtml produces a self-contained document with no external references', () => {
  const html = renderExportHtml('# Body\n\ntext', { title: 'Report' });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>Report<\/title>/);
  assert.match(html, /<style>/, 'CSS must be inlined');
  // The whole point: it has to open from file:// on a machine that has never
  // seen this project. Any external fetch breaks that.
  assert.ok(!/<script/i.test(html), 'no scripts');
  assert.ok(!/<link/i.test(html), 'no external stylesheets');
  assert.ok(!/https?:\/\/(?!schema\.org)/.test(html.replace(/<a href="[^"]*"/g, '')),
    'no external asset URLs');
});

test('the provenance footer stamps which version the reader is holding (#464 gap)', () => {
  const html = renderExportHtml('text', {
    title: 'T', sourceLabel: 'wiki #454', exportedAt: '2026-07-25T14:00:00Z', digest: 'abc123',
  });
  assert.match(html, /wiki #454/);
  assert.match(html, /2026-07-25T14:00:00Z/);
  assert.match(html, /abc123/);
});
