/**
 * #379 — a cheap tripwire for the failure that took the commons page dark on
 * 2026-07-10: an HTML comment opened with `<!--` and was never closed, so the
 * parser swallowed the `<aside>` panel AND the whole `<script type="module">`
 * after it. No JS ran; the page hung on "Loading…" with an empty console —
 * silent, because an unterminated comment is valid text, not a syntax error.
 *
 * commons-e2e.test.mjs already catches this behaviorally (its mount never
 * happens on a broken page), but it's a heavy Puppeteer suite. This is the
 * millisecond guard: no browser, no server, just the served bytes. Runs under
 * the standard `node --test tests/*.test.mjs`.
 *
 * The detector strips <script>/<style> element CONTENTS first — those may
 * legally contain `-->` (e.g. `while (i-->0)`) or `<!--`, and counting raw
 * would false-positive. What remains is the page's own markup, where an
 * unterminated comment is always a bug.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_HTML = ['commons.html', 'index.html', 'settings.html', 'wiki.html'];

/**
 * Scan a page's markup for comment balance. Returns { open, close, unterminated }.
 * `unterminated` is the one that breaks a page: a `<!--` with no following `-->`
 * eats everything after it, including scripts.
 */
export function scanComments(html) {
  const markup = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '<script></script>')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '<style></style>');
  let i = 0, open = 0, close = 0, unterminated = false;
  for (;;) {
    const o = markup.indexOf('<!--', i);
    if (o === -1) break;
    open++;
    const c = markup.indexOf('-->', o + 4);
    if (c === -1) { unterminated = true; break; }
    close++;
    i = c + 3;
  }
  return { open, close, unterminated };
}

// Guard the guard: prove the detector actually detects, and doesn't false-positive
// on JS that merely looks like a comment close. A vanity check that always passes
// would be worse than nothing here.
test('#379 scanComments detects an unterminated comment and ignores script/style contents', () => {
  const broken = '<body>\n  <!-- oops, never closed\n  <aside>x</aside>\n  <script type="module">go()</script>\n</body>';
  const b = scanComments(broken);
  assert.ok(b.unterminated, 'flags the unterminated markup comment');

  // `i-->0` and a `<!--` inside a string live in the script — stripped, so clean.
  const good = '<body>\n  <!-- fine --><aside>x</aside>\n  <script type="module">let i=5; while (i-->0) {} const s="<!--";</script>\n</body>';
  const g = scanComments(good);
  assert.ok(!g.unterminated, 'no false unterminated from JS that looks like comment markers');
  assert.equal(g.open, g.close, 'balanced markup comments count equal');
});

for (const file of ROOT_HTML) {
  test(`#379 ${file} has no unterminated HTML comment (would swallow its <script>)`, () => {
    const html = fs.readFileSync(path.join(PROJECT_DIR, file), 'utf8');
    const { open, close, unterminated } = scanComments(html);
    assert.equal(unterminated, false,
      `${file}: an HTML comment opened with <!-- and never closed — it will eat the markup (and scripts) after it`);
    assert.equal(open, close,
      `${file}: unbalanced HTML comment markers (${open} <!-- vs ${close} -->)`);
  });
}
