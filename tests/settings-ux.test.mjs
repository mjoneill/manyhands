/**
 * #263 — the settings console (settings.html) end-to-end: load current config,
 * flip the mode, change a timing, save, and confirm it persisted live via the
 * API. Puppeteer against an isolated server (own port + temp config file).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { startRestServer } from './helpers/harness.mjs';

test('#263 settings page: flip to Hard + set a timeout, save, config persists live', async () => {
  const server = await startRestServer();
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/settings.html`, { waitUntil: 'networkidle0' });
    // Defaults loaded as soft; flip to hard and set the timeout to 120s.
    await page.click('input[name=mode][value="hard"]');
    await page.$eval('#hardTimeout', (el) => { el.value = '120'; });
    await page.click('#save');
    await page.waitForFunction(() => document.getElementById('msg')?.classList.contains('ok'), { timeout: 5000 });

    const cfg = await (await fetch(`${server.baseUrl}/api/config`)).json();
    assert.equal(cfg.mode, 'hard', 'mode persisted as hard');
    assert.equal(cfg.hard.timeoutMs, 120000, 'timeout persisted as 120s');
  } finally {
    await browser.close();
    await server.stop();
  }
});

test('#410 settings page: flip to TokenRing + set the lease timeout, save, config persists live', async () => {
  const server = await startRestServer();
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/settings.html`, { waitUntil: 'networkidle0' });
    await page.click('input[name=mode][value="token-ring"]');
    // The token-ring timings fieldset reveals when the mode is selected.
    const shown = await page.$eval('#token-ring-fields', (el) => getComputedStyle(el).display !== 'none');
    assert.ok(shown, 'token-ring timings fieldset is visible when TokenRing is selected');
    await page.$eval('#tokenRingTimeout', (el) => { el.value = '180'; });
    await page.click('#save');
    await page.waitForFunction(() => document.getElementById('msg')?.classList.contains('ok'), { timeout: 5000 });

    const cfg = await (await fetch(`${server.baseUrl}/api/config`)).json();
    assert.equal(cfg.mode, 'token-ring', 'mode persisted as token-ring');
    assert.equal(cfg.tokenRing.timeoutMs, 180000, 'lease timeout persisted as 180s');
  } finally {
    await browser.close();
    await server.stop();
  }
});

test('#263 settings page: an invalid window (min > max) is rejected with the validation message', async () => {
  const server = await startRestServer();
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/settings.html`, { waitUntil: 'networkidle0' });
    await page.click('input[name=mode][value="soft"]');
    await page.$eval('#softMin', (el) => { el.value = '90'; });
    await page.$eval('#softMax', (el) => { el.value = '10'; });
    await page.click('#save');
    await page.waitForFunction(() => document.getElementById('msg')?.classList.contains('err'), { timeout: 5000 });
    const text = await page.$eval('#msg', (el) => el.textContent);
    assert.match(text, /Rejected/, `shows the server rejection: ${text}`);
  } finally {
    await browser.close();
    await server.stop();
  }
});
