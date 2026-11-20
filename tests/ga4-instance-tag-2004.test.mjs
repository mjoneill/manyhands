/**
 * #2004 — an instance owner can set their OWN GA4 measurement ID, and the board's pages report to THEIR property.
 *
 *   G1  OFF BY DEFAULT: with no ID, every HTML page is served exactly as before (no gtag, no Google host named).
 *   G2  A valid ID puts the tag on every HTML page the server serves, and nowhere else (not on JSON, not on JS).
 *   G3  A malformed ID is refused: nothing is injected (an ID is code once it is in a <script>), and the server says so.
 *   G4  NO WORKSPACE CONTENT: in a real browser, with Google's script stubbed so nothing leaves the test, the values
 *       the page hands gtag carry the page's FIXED name and its path with the query and hash removed. A card title in
 *       document.title and a card id in the query never reach dataLayer, including after the page pushes ?card=.
 *   G5  With no ID, a page in a real browser makes no request to any Google host at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, withBrowserServer } from './helpers/harness.mjs';
import { parseGa4Id, ga4PageName, ga4Snippet } from '../core/ga4-tag.mjs';

const ID = 'G-TEST2004AB';
const PAGES = ['/', '/index.html', '/commons.html', '/wiki.html', '/insights.html', '/settings.html', '/retreat.html'];
const GOOGLE = /googletagmanager\.com|google-analytics\.com|gtag\(/;

async function serve(env, body) {
  const server = await startRestServer({ env });
  try { return await body(server); } finally { await server.stop(); }
}
const get = async (base, p) => { const r = await fetch(base + p); return { status: r.status, type: r.headers.get('content-type') || '', text: await r.text() }; };

test('#2004 the ID parser accepts only a GA4 measurement ID', () => {
  assert.equal(parseGa4Id('G-ABC123XYZ9').id, 'G-ABC123XYZ9');
  assert.equal(parseGa4Id('  g-abc123xyz9 ').id, 'G-ABC123XYZ9', 'trimmed and upper-cased');
  for (const bad of ['UA-12345-1', 'G-', 'G-<script>', "G-AB');alert(1);//", 'G-ABC DEF', 'G-' + 'A'.repeat(40), 'GTM-ABC123']) {
    const r = parseGa4Id(bad);
    assert.equal(r.id, null, `refused: ${bad}`);
    assert.ok(r.error, `a refusal says why: ${bad}`);
  }
  assert.deepEqual(parseGa4Id(''), { id: null, error: null }, 'empty is off, not an error');
  assert.deepEqual(parseGa4Id(undefined), { id: null, error: null });
});

test('#2004 every page has a fixed name, never derived from its content', () => {
  assert.equal(ga4PageName('/index.html'), 'board');
  assert.equal(ga4PageName('/commons.html'), 'commons');
  assert.equal(ga4PageName('/wiki.html'), 'wiki');
  assert.equal(ga4PageName('/some-new-page.html'), 'some-new-page');
  assert.equal(ga4PageName('/odd name<x>.html'), 'page', 'anything not a plain slug is just "page"');
});

test('#2004 the snippet is built only from the validated ID and the fixed name', () => {
  const s = ga4Snippet(ID, 'board');
  assert.match(s, /https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=G-TEST2004AB/);
  assert.match(s, /page_title:\s*"board"/);
  assert.doesNotMatch(s, /document\.title/, 'the page title is never read');
  assert.throws(() => ga4Snippet('G-<x>', 'board'), /measurement ID/);
});

test('#2004 G1 with no ID, every page is served exactly as before', async () => {
  await serve({}, async (s) => {
    for (const p of PAGES) {
      const r = await get(s.baseUrl, p);
      assert.equal(r.status, 200, p);
      assert.doesNotMatch(r.text, GOOGLE, `no Google tag on ${p}`);
    }
  });
});

test('#2004 G2 a valid ID tags every HTML page, and nothing else', async () => {
  await serve({ SCRUM_GA4_MEASUREMENT_ID: ID }, async (s) => {
    for (const p of PAGES) {
      const r = await get(s.baseUrl, p);
      assert.equal(r.status, 200, p);
      assert.ok(r.text.includes(`gtag/js?id=${ID}`), `the tag is on ${p}`);
      assert.equal(r.text.split(`gtag/js?id=${ID}`).length - 1, 1, `exactly one tag on ${p}`);
    }
    const name = (await get(s.baseUrl, '/commons.html')).text.match(/page_title:\s*"([^"]*)"/)[1];
    assert.equal(name, 'commons');
    const api = await get(s.baseUrl, '/api/board');
    assert.doesNotMatch(api.text, GOOGLE, 'JSON is never tagged');
  });
});

test('#2004 G3 a malformed ID is refused: nothing injected, and the server says so', async () => {
  await serve({ SCRUM_GA4_MEASUREMENT_ID: "G-AB');alert(1);//" }, async (s) => {
    const r = await get(s.baseUrl, '/index.html');
    assert.doesNotMatch(r.text, GOOGLE);
    assert.ok(await s.waitForStderr(/GA4/), 'one line in the log names the refused setting');
    assert.doesNotMatch(s.stderr(), /alert\(1\)/, 'the bad value itself is not echoed');
  });
});

const board = {
  cards: [{ id: 'c-secret', shortId: 77, title: 'SECRET-CARD-TITLE', description: 'SECRET-BODY', column: 'backlog', order: 0, type: 'task' }],
  columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
  conversations: [],
  nextShortId: 78,
};

test('#2004 G4 in a browser, gtag is handed the fixed name and a bare path, never a card title or id', { timeout: 90000 }, async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    const google = [];
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (/googletagmanager\.com|google-analytics\.com/.test(req.url())) {
        google.push(req.url());
        return req.respond({ status: 200, contentType: 'application/javascript', body: '/* stub: nothing leaves the test */' });
      }
      req.continue();
    });
    await page.goto(`${server.baseUrl}/index.html?card=77#frag`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { document.title = 'SECRET-CARD-TITLE · board'; history.pushState({}, '', '?card=77&q=SECRET-SEARCH'); });
    await new Promise((r) => setTimeout(r, 300));
    const layer = await page.evaluate(() => JSON.stringify(window.dataLayer || []));
    assert.equal(google.length, 1, 'the page asked for Google\'s script once (stubbed here)');
    assert.ok(google[0].includes(`id=${ID}`));
    assert.match(layer, /"page_title":"board"/);
    assert.ok(layer.includes(`"page_location":"${server.baseUrl}/index.html"`), `bare path: ${layer}`);
    for (const secret of ['SECRET-CARD-TITLE', 'SECRET-BODY', 'SECRET-SEARCH', 'card=77', 'frag']) {
      assert.ok(!layer.includes(secret), `${secret} never reaches gtag: ${layer}`);
    }
    assert.ok((layer.match(/"set"/g) || []).length >= 2, 'the fixed values are set again after the page changes its URL');
  }, { server: { board, env: { SCRUM_GA4_MEASUREMENT_ID: ID } }, launch: { headless: 'new' } });
});

test('#2004 G5 with no ID, a page in a browser makes no request to Google', { timeout: 90000 }, async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    const google = [];
    page.on('request', (req) => { if (/google/.test(new URL(req.url()).hostname)) google.push(req.url()); });
    await page.goto(`${server.baseUrl}/index.html`, { waitUntil: 'networkidle2' });
    assert.deepEqual(google, []);
  }, { server: { board }, launch: { headless: 'new' } });
});
