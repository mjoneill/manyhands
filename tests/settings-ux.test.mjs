/**
 * #263 — the settings console (settings.html) end-to-end: load current config,
 * flip the mode, change a timing, save, and confirm it persisted live via the
 * API. Puppeteer against an isolated server (own port + temp config file).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, withBrowserServer } from './helpers/harness.mjs';

test('#263 settings page: flip to Hard + set a timeout, save, config persists live', async () => {
  await withBrowserServer(async ({ server, browser }) => {
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
  }, { server: {}, launch: { headless: 'new' } });
});

test('#410 settings page: flip to TokenRing + set the lease timeout, save, config persists live', async () => {
  await withBrowserServer(async ({ server, browser }) => {
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
  }, { server: {}, launch: { headless: 'new' } });
});

// #737 rewrote this assertion. It previously matched /Rejected/ — the prefix of
// the passthrough of the server's message. That is wording, not behaviour: the
// property the title claims is "an invalid window is REJECTED with a validation
// message", and it survives the client now catching this case in seconds.
//
// Strengthened while here, because the old version never checked the half that
// matters: it asserted a message appeared and never that the config was left
// alone. A save that both complained AND persisted would have passed.
test('#263/#737 settings page: an invalid window (min > max) is refused, explained, and not saved', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/settings.html`, { waitUntil: 'networkidle0' });
    const before = await (await fetch(`${server.baseUrl}/api/config`)).json();

    await page.click('input[name=mode][value="soft"]');
    await page.$eval('#softMin', (el) => { el.value = '90'; });
    await page.$eval('#softMax', (el) => { el.value = '10'; });
    await page.click('#save');
    await page.waitForFunction(() => document.getElementById('msg')?.classList.contains('err'), { timeout: 5000 });

    const text = await page.$eval('#msg', (el) => el.textContent);
    assert.match(text, /90.*10|backwards/i, `explains which way round it went wrong: ${text}`);
    assert.doesNotMatch(text, /\d{4,}/, `states the problem in the seconds the field asked for, not raw ms: ${text}`);

    const after = await (await fetch(`${server.baseUrl}/api/config`)).json();
    assert.deepEqual(after.soft, before.soft, 'a refused window must not be persisted');
  }, { server: {}, launch: { headless: 'new' } });
});

// #737 — the owner's exact input. 120→360 is a genuine violation (360s > the 300s
// ceiling), so the refusal is correct; the bug was that it was reported as
// "0 <= minMs <= maxMs <= 300000" to someone typing into a field labelled
// seconds, from which the real limit cannot be derived.
test('#737 an over-ceiling window is refused in SECONDS, naming the field and the limit', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/settings.html`, { waitUntil: 'networkidle0' });
    await page.click('input[name=mode][value="soft"]');

    // The browser itself should now refuse the value before anyone clicks Save.
    assert.equal(await page.$eval('#softMax', (el) => el.max), '300',
      'the input must carry the server ceiling, converted to seconds');

    await page.$eval('#softMin', (el) => { el.value = '120'; });
    await page.$eval('#softMax', (el) => { el.value = '360'; });
    await page.click('#save');
    await page.waitForFunction(() => document.getElementById('msg')?.classList.contains('err'), { timeout: 5000 });

    const text = await page.$eval('#msg', (el) => el.textContent);
    assert.match(text, /300 seconds/, `names the actual ceiling in seconds: ${text}`);
    assert.match(text, /360/, `quotes back what was entered: ${text}`);
    assert.doesNotMatch(text, /300000|minMs|maxMs/, `no raw-millisecond predicate leaks to the user: ${text}`);

    // And the largest window that DOES fit must save, so the ceiling is usable
    // rather than merely explained.
    await page.$eval('#softMax', (el) => { el.value = '300'; });
    await page.click('#save');
    await page.waitForFunction(() => document.getElementById('msg')?.classList.contains('ok'), { timeout: 5000 });
    const cfg = await (await fetch(`${server.baseUrl}/api/config`)).json();
    assert.equal(cfg.soft.maxMs, 300000, '120s→300s sits exactly at the ceiling and must persist');
  }, { server: {}, launch: { headless: 'new' } });
});

// #737 — the guard the client-side check makes necessary. Pre-validating in the
// page is a convenience layered ON the server's authority, and the danger of any
// such layer is that it becomes the only check and then disagrees. If the bounds
// never arrive, the editor must defer rather than invent a limit, and the
// server's refusal must still reach the user instead of being swallowed.
test('#737 with the bounds unavailable, the editor defers and the SERVER refusal still surfaces', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/settings.html`, { waitUntil: 'networkidle0' });
    await page.click('input[name=mode][value="soft"]');

    // Simulate a server that never told us its bounds.
    await page.evaluate(() => { LIMITS_S = null; });

    await page.$eval('#softMin', (el) => { el.value = '120'; });
    await page.$eval('#softMax', (el) => { el.value = '360'; });
    await page.click('#save');
    await page.waitForFunction(() => document.getElementById('msg')?.classList.contains('err'), { timeout: 5000 });

    const text = await page.$eval('#msg', (el) => el.textContent);
    assert.match(text, /Rejected/, `the server's own rejection must still be shown: ${text}`);

    const cfg = await (await fetch(`${server.baseUrl}/api/config`)).json();
    assert.notEqual(cfg.soft.maxMs, 360000, 'and the out-of-range value must not persist');
  }, { server: {}, launch: { headless: 'new' } });
});
