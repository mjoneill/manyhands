#!/usr/bin/env node
/**
 * Headless test runner for the manyhands.
 *
 * Loads index.html?test in a sandboxed Chromium (via puppeteer), waits for the
 * in-browser test suite to finish, scrapes the pass/fail counts, prints
 * failures with their error messages, and exits with a status code:
 *
 *   0 — all tests passed
 *   1 — one or more tests failed
 *   2 — runner or page error before tests could complete
 *
 * The page is loaded via file:// (no server needed). Test code is fetch-mocked
 * by the test wrapper (see card #38), so this runner cannot corrupt
 * board-data.json on disk even if the dev server happens to be running.
 *
 * Usage:
 *   node run-tests.js
 */

import puppeteer from 'puppeteer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    if (pageErrors.length > 0) {
      console.log('\nPAGE ERRORS:');
      pageErrors.forEach(e => console.log('  ' + e));
    }

    await browser.close();

    const match = summary.match(/(\d+) passed, (\d+) failed/);
    if (!match) {
      console.error('\nCould not parse SUMMARY line; exit 2');
      process.exit(2);
    }
    const failed = parseInt(match[2], 10);
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
