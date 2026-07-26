#!/usr/bin/env node
/**
 * Headless test runner — the DIRECT-FILE lane.
 *
 * Loads index.html?test in a sandboxed Chromium (via puppeteer), waits for the
 * in-browser test suite to finish, scrapes the pass/fail counts, prints
 * failures with their error messages, and exits with a status code:
 *
 *   0 — all tests passed and every page error was an expected one
 *   1 — a test failed, OR the page produced an UNEXPECTED error
 *   2 — runner or page error before tests could complete
 *
 * ── WHAT THIS LANE PROMISES, AND WHAT IT DOES NOT ──────────────────────────
 * The page is loaded over `file://`, with no server. That is deliberately a
 * NARROW lane, not a claim that the product works without a server:
 *
 *   - **The served page is the product.** `node server.js`, then a real URL.
 *     Module-backed behaviour — navigation, identity, the API — is covered by
 *     the served end-to-end tests, which refuse ANY page error.
 *   - **This lane covers the core workflow with no server at all**: the page
 *     renders from the fallback roster, a card can be created, and it survives
 *     a reload via localStorage. That is worth guarding on its own, because it
 *     is the difference between "renders" and "renders only when our server
 *     dressed it".
 *
 * Under `file://`, Chromium refuses cross-origin module imports and `fetch`.
 * Those errors are EXPECTED here and are enumerated in EXPECTED_PAGE_ERRORS.
 * Everything else fails the run.
 *
 * ── WHY THE ENUMERATION EXISTS ─────────────────────────────────────────────
 * This runner used to collect page errors, print them, and then decide its exit
 * status from the test-failure count alone. So a page could throw anything at
 * all and the run still exited 0 — proven by a pre-registered plant, not
 * theorised: `throw new Error('planted')` printed and passed.
 *
 * A blanket "ignore page errors under file://" would have been the tempting fix
 * and is the same bug with better manners. So the expected errors are named, and
 * an error that does not match a named pattern fails the run.
 *
 * ⚠️ Do not add a pattern here to make a run go green. Every entry is a promise
 * that this specific error is a property of the file:// sandbox rather than a
 * defect. A growing list is the check being switched off quietly.
 *
 * Usage:
 *   node run-tests.js
 */

import puppeteer from 'puppeteer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The page errors that are properties of the `file://` sandbox, not defects.
 *
 * Chromium blocks cross-origin module imports and fetches from an `origin: null`
 * document. Each blocked request produces TWO console errors: the CORS message
 * naming the URL, and a bare `Failed to load resource` with no URL attached.
 */
const EXPECTED_PAGE_ERRORS = [
  {
    name: 'CORS-blocked module import of a local core/ module',
    test: (e) => /Access to script at 'file:\/\/.*\/core\/[\w.-]+\.mjs'/.test(e)
      && /blocked by CORS policy/.test(e),
  },
  {
    name: 'CORS-blocked fetch of an API path with no server',
    test: (e) => /Access to fetch at 'file:\/\/\/api\//.test(e)
      && /blocked by CORS policy/.test(e),
  },
];

/**
 * `Failed to load resource: net::ERR_FAILED` carries no URL, so it cannot be
 * matched to the request that caused it. Allowing it unconditionally would be a
 * hole big enough to hide a real failed load in.
 *
 * So it is allowed only up to the number of requests we *know* were blocked:
 * one paired failure per matched CORS error. An extra one is a load that failed
 * for some other reason, and it fails the run.
 */
const isBareLoadFailure = (e) => /Failed to load resource: net::ERR_FAILED/.test(e);

/** Split page errors into expected and unexpected, with the counted bound applied. */
function classifyPageErrors(errors) {
  const expected = [];
  const unexpected = [];
  let corsBlocks = 0;
  const bare = [];

  for (const e of errors) {
    const match = EXPECTED_PAGE_ERRORS.find((p) => p.test(e));
    if (match) { corsBlocks++; expected.push({ error: e, why: match.name }); continue; }
    if (isBareLoadFailure(e)) { bare.push(e); continue; }
    unexpected.push(e);
  }

  bare.forEach((e, i) => {
    if (i < corsBlocks) expected.push({ error: e, why: 'paired load failure for a CORS-blocked request' });
    else unexpected.push(`${e}  (more bare load failures than CORS-blocked requests — this one is unaccounted for)`);
  });

  return { expected, unexpected };
}

(async () => {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push('pageerror: ' + e.message));
  page.on('console', msg => {
    if (msg.type() === 'error') pageErrors.push('console.error: ' + msg.text());
  });

  const url = 'file://' + path.resolve(__dirname, 'index.html') + '?test';

  try {
    await page.goto(url, { waitUntil: 'networkidle0' });

    await page.waitForFunction(
      () => {
        const el = document.getElementById('test-summary');
        return el && el.textContent && el.textContent.includes('total');
      },
      { timeout: 30000 }
    );

    const summary = await page.$eval('#test-summary', el => el.textContent);
    const failures = await page.$$eval('.test-result.fail', els =>
      els.map(el => ({
        name: el.querySelector('.name')?.textContent || '',
        error: el.querySelector('.error')?.textContent || '',
      }))
    );

    console.log('SUMMARY: ' + summary);
    if (failures.length > 0) {
      console.log('\nFAILURES:');
      failures.forEach(f => console.log(`  ❌ ${f.name}\n     ${f.error}`));
    }
    const { expected, unexpected } = classifyPageErrors(pageErrors);

    if (expected.length > 0) {
      console.log(`\nEXPECTED PAGE ERRORS (${expected.length}) — properties of the file:// sandbox:`);
      expected.forEach(({ error, why }) => console.log(`  · [${why}] ${error}`));
    }
    if (unexpected.length > 0) {
      console.log(`\n✖ UNEXPECTED PAGE ERRORS (${unexpected.length}):`);
      unexpected.forEach(e => console.log('  ✖ ' + e));
    }

    await browser.close();

    const match = summary.match(/(\d+) passed, (\d+) failed/);
    if (!match) {
      console.error('\nCould not parse SUMMARY line; exit 2');
      process.exit(2);
    }
    const failed = parseInt(match[2], 10);

    // An unexpected page error fails the run even when every test passed. The
    // whole point: this runner used to report green while the page threw.
    if (unexpected.length > 0) {
      console.error(`\n✖ ${unexpected.length} unexpected page error(s) — failing the run despite ${failed === 0 ? 'all tests passing' : 'the test failures above'}.`);
      console.error('  If one of these is genuinely a file:// sandbox property, name it in');
      console.error('  EXPECTED_PAGE_ERRORS with the reason. Do not widen a pattern to go green.');
      process.exit(1);
    }
    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error('\nRunner/page error before tests completed:');
    console.error('  ' + err.message);
    if (pageErrors.length > 0) {
      console.error('\nPAGE ERRORS:');
      pageErrors.forEach(e => console.error('  ' + e));
    }
    await browser.close();
    process.exit(2);
  }
})();
