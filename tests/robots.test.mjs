/**
 * #588 — three crawler-exclusion layers, asserted at the three places they
 * actually fail. They are NOT additive in the nominal case: if robots.txt is
 * served and honoured, a crawler never fetches the page and never reads the
 * header or the meta tag. The point is that each covers a failure the others
 * don't — served from the wrong root, deleted later, page copied elsewhere,
 * headers stripped by a proxy.
 *
 * ⚠️ RUN THIS FILE ALONE:
 *     node --test tests/robots.test.mjs
 * NOT `npm run test:server` — that globs all 57 test files and 17 of them
 * import puppeteer, which the dev clone deliberately does not install. The
 * suite fails on a missing module, which looks exactly like your change
 * breaking something. This file needs only node: builtins.
 *
 * Isolated server per test (own port + temp board) — never live :3141.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRestServer } from './helpers/harness.mjs';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function serverTest(name, fn) {
  test(name, async () => {
    const server = await startRestServer();
    try {
      await fn(server);
    } finally {
      await server.stop();
    }
  });
}

// ── Layer 1: robots.txt, and the MIME entry that makes it real ───────────

serverTest('GET /robots.txt disallows every path for every agent', async ({ baseUrl }) => {
  const res = await fetch(`${baseUrl}/robots.txt`);
  assert.equal(res.status, 200, 'robots.txt must be served, not 404');

  const body = await res.text();
  assert.match(body, /^User-agent:\s*\*$/m, 'must apply to all agents');
  assert.match(body, /^Disallow:\s*\/$/m, 'must disallow the root, which covers every path');
});

serverTest('robots.txt is served as text/plain — the silent-failure case', async ({ baseUrl }) => {
  const res = await fetch(`${baseUrl}/robots.txt`);
  const ct = (res.headers.get('content-type') || '').split(';')[0].trim();

  // Google honours robots.txt ONLY as text/plain. Without '.txt' in
  // MIME_TYPES the file falls through to application/octet-stream: it
  // exists, it looks installed, and it does nothing. This assertion is the
  // difference between shipping the control and shipping the appearance
  // of it — `ls` cannot see this and neither can a file-content test.
  assert.equal(ct, 'text/plain', `robots.txt served as "${ct}", not text/plain`);
});

serverTest('robots.txt declares charset=utf-8 — the mojibake case', async ({ baseUrl }) => {
  const res = await fetch(`${baseUrl}/robots.txt`);
  const ct = res.headers.get('content-type') || '';

  // #605: a text file has NO in-band way to declare its encoding. HTML has
  // <meta charset> in its own <head>; .txt has nothing. Without this parameter
  // the client guesses, and the usual guess renders an em dash as "â€”".
  // This was live in production and reported by a human reading the file.
  assert.match(ct, /charset=utf-8/i, `robots.txt served as "${ct}" — no charset`);
});

serverTest('robots.txt is pure ASCII, independent of any header', async ({ baseUrl }) => {
  const res = await fetch(`${baseUrl}/robots.txt`);
  const bytes = Buffer.from(await res.arrayBuffer());

  // #605, belt and braces: the header above is the fix, but robots.txt is
  // parsed by strangers' tooling we cannot inspect, and a control whose
  // legibility depends on a header being honoured is what #588 said not to
  // ship. If the file is pure ASCII the two decodings are identical — an
  // assertion that cannot pass vacuously and does not consult the header.
  assert.equal(
    bytes.toString('utf8'),
    bytes.toString('latin1'),
    'robots.txt must be pure ASCII — the decodings differ, so it is not',
  );
});

serverTest('HTML is served with charset=utf-8 too, not just <meta>', async ({ baseUrl }) => {
  // #605: pages carry <meta charset> and so recover on their own. That
  // fallback lives inside the document and does not travel with the response,
  // so the header is asserted here rather than trusted.
  const res = await fetch(`${baseUrl}/index.html`);
  assert.match(res.headers.get('content-type') || '', /charset=utf-8/i);
});

// ── Layer 2: X-Robots-Tag on EVERY response, not an enumerated route list ──

serverTest('X-Robots-Tag is set on an HTML route', async ({ baseUrl }) => {
  const res = await fetch(`${baseUrl}/index.html`);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
});

serverTest('X-Robots-Tag is set on an /api/* route', async ({ baseUrl }) => {
  // The header lives at the single choke point in handleRequest, before any
  // routing, precisely so /api/* is covered without anyone listing routes.
  // #588: a grep for '/api/...' returns three and misses routes known to
  // exist, so any enumeration ships a gap.
  const res = await fetch(`${baseUrl}/api/cards`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
});

serverTest('X-Robots-Tag survives a route that does not exist', async ({ baseUrl }) => {
  // A 404 is still a response a crawler can index. Setting the header before
  // routing means error paths are covered too — the case an
  // after-the-handler implementation would miss.
  const res = await fetch(`${baseUrl}/no-such-page-${Date.now()}`);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
});

// ── Layer 3: <meta robots> on every page, ENUMERATED FROM A GLOB ─────────

test('every HTML page carries <meta name="robots">', () => {
  // Enumerated from disk, NEVER a hand-written list. The four pages each own
  // their <head> — there is no shared partial — so page five would otherwise
  // ship uncovered and no test would notice. This assertion is the thing
  // that makes the fifth page fail instead of shipping bare.
  const pages = fs.readdirSync(PROJECT_DIR).filter((f) => f.endsWith('.html'));

  // A glob that matches nothing passes every assertion below it. Refuse that.
  assert.ok(pages.length >= 4, `expected at least 4 HTML pages, found ${pages.length}`);

  const missing = pages.filter((page) => {
    const html = fs.readFileSync(path.join(PROJECT_DIR, page), 'utf8');
    return !/<meta\s+name=["']robots["']\s+content=["']noindex,\s*nofollow["']\s*\/?>/i.test(html);
  });

  assert.deepEqual(missing, [], `HTML pages without <meta name="robots">: ${missing.join(', ')}`);
});
