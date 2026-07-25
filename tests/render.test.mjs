/**
 * Tests for the pure wiki renderer (core/render.mjs). Behavior tests on the
 * produced HTML — especially the XSS-safety guarantee (escape-first).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, renderChatMarkdown } from '../core/render.mjs';

test('escapes HTML — no live markup survives from user content', () => {
  const html = renderMarkdown('<script>alert(1)</script>');
  assert.ok(!html.includes('<script>'), 'no raw <script>');
  assert.ok(html.includes('&lt;script&gt;'), 'escaped instead');
});

test('renders **bold** and # headings', () => {
  assert.ok(renderMarkdown('**bold**').includes('<strong>bold</strong>'));
  assert.ok(renderMarkdown('# Title').includes('<h1>Title</h1>'));
});

test('[[wikilinks]] become safe anchors carrying the target', () => {
  const html = renderMarkdown('see [[Parent Page]] now');
  assert.ok(html.includes('data-target="Parent Page"'), 'target captured');
  assert.ok(html.includes('>Parent Page</a>'), 'label shown');
});

test('[[Target|alias]] shows the alias, targets the page', () => {
  const html = renderMarkdown('[[Real Page|click me]]');
  assert.ok(html.includes('data-target="Real Page"'));
  assert.ok(html.includes('>click me</a>'));
});

test('a wikilink target containing HTML is neutralised (escape-first)', () => {
  const html = renderMarkdown('[[<img src=x onerror=alert(1)>]]');
  assert.ok(!html.includes('<img'), 'no live <img> injected via a wikilink');
});

test('non-string input renders empty', () => {
  assert.equal(renderMarkdown(null), '');
  assert.equal(renderMarkdown(undefined), '');
});

// #247 — real notes use single newlines + bullets without blank lines.
test('heading immediately followed by bullets: heading stands, bullets list, not enjambed', () => {
  const html = renderMarkdown('# Notes\n- first\n- second\n- third');
  assert.ok(html.includes('<h1>Notes</h1>'), 'heading rendered: ' + html);
  assert.ok(html.includes('<ul>'), 'bullets wrapped in a list');
  assert.ok(html.includes('<li>first</li>') && html.includes('<li>third</li>'), 'each bullet a list item');
  assert.ok(!/Notes<\/h1>\s*-\s*first/.test(html), 'bullets are NOT raw "- " text glued to the heading (the enjamb bug)');
});

test('single newlines within a text block become <br> (no enjambing)', () => {
  assert.ok(renderMarkdown('line one\nline two').includes('line one<br>line two'),
    'single newline → <br>');
});

test('blank-line-separated text stays in separate paragraphs', () => {
  const html = renderMarkdown('para one\n\npara two');
  assert.ok((html.match(/<p>/g) || []).length === 2, 'two paragraphs: ' + html);
});

test('* bullets work too, and *italic* mid-line is not mistaken for a bullet', () => {
  assert.ok(renderMarkdown('* alpha\n* beta').includes('<li>alpha</li>'), '* makes list items');
  assert.ok(renderMarkdown('an *emphatic* word').includes('<em>emphatic</em>'), 'inline italic preserved');
});

// #248 — indentation nests bullets (a child <ul> inside the parent <li>).
test('nested bullets: an indented "- " makes a sub-list under its parent', () => {
  const html = renderMarkdown('- top\n  - sub\n  - sub2\n- top2');
  assert.ok(html.includes('<li>top<ul>'), 'parent item opens a nested list: ' + html);
  assert.ok(html.includes('<li>sub</li><li>sub2</li>'), 'both sub-items inside the nested list');
  assert.ok(html.includes('</ul></li><li>top2</li>'), 'list closes back to top level for the next top item');
});

// ── #303-1: renderChatMarkdown (chat-minimal) ──────────────────────────────

test('chat: escape-first — HTML in a body never becomes live markup', () => {
  const html = renderChatMarkdown('hi <img src=x onerror="window.x=1"> there');
  assert.ok(!html.includes('<img'), 'no live <img>: ' + html);
  assert.ok(html.includes('&lt;img'), 'escaped instead');
});

test('chat: renders bold, italic, and unordered lists', () => {
  assert.ok(renderChatMarkdown('**b**').includes('<strong>b</strong>'));
  assert.ok(renderChatMarkdown('*i*').includes('<em>i</em>'));
  const list = renderChatMarkdown('- one\n- two');
  assert.ok(list.includes('<ul><li>one</li><li>two</li></ul>'), 'bullets → ul/li: ' + list);
});

test('chat: #NNN becomes a card link, plain # / #word do not', () => {
  const html = renderChatMarkdown('see #296 and email me#2 but not # heading or #foo');
  assert.ok(html.includes('<a class="cardref" data-shortid="296" href="index.html?card=296">#296</a>'), html);
  assert.ok(!html.includes('data-shortid="2"'), 'email-me#2 is not a ref (preceded by a word char)');
  assert.ok(html.includes('# heading'), 'a lone # renders as literal text, not a heading');
  assert.ok(!html.includes('<h1>'), 'NO headings in chat-minimal');
});

test('chat: single newlines are preserved as <br> (chat feel, no <p> blocks)', () => {
  const html = renderChatMarkdown('line one\nline two');
  assert.ok(html.includes('line one<br>line two'), 'newline → br: ' + html);
  assert.ok(!html.includes('<p>'), 'no paragraph wrapping');
});

test('chat: a card ref inside bold still linkifies and stays inside the strong', () => {
  const html = renderChatMarkdown('**see #296**');
  assert.ok(html.includes('<strong>see <a class="cardref"'), 'ref nested in bold: ' + html);
});

test('chat: an apostrophe is NOT mangled into a #39 card ref (escaped-entity collision)', () => {
  const html = renderChatMarkdown("the team's call on #303");
  assert.ok(!html.includes('data-shortid="39"'), 'the &#39; entity must not become a #39 link: ' + html);
  assert.ok(html.includes('&#39;') || html.includes("'"), 'apostrophe preserved as an entity');
  assert.ok(html.includes('data-shortid="303"'), 'a real ref alongside it still links');
});
