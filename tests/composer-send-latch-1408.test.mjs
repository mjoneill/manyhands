/**
 * #1408 — ONE post per send. The customer's first Talk message (#1401, 2026-09-17
 * 20:07Z) landed twice, 1.2 s apart: the composer accepted a second submit
 * while the first was in flight (POST + reload). A latch holds across post()
 * and the reload; a second submit in that window is a no-op.
 *
 * Sabotage: remove the latch ⇒ "grew by exactly ONE" reads 2. The control
 * (two clicks with a settle between) proves the latch RELEASES — a latch that
 * never released would also pass the first line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBoardFixture, withBrowserServer } from './helpers/harness.mjs';

const count = async (base) => { const j = await (await fetch(`${base}/api/conversations?limit=500`)).json(); return (Array.isArray(j) ? j : j.conversations).length; };

test('#1408 two submits inside one in-flight window post ONCE; two settled submits post twice (the latch releases)', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    page.on('dialog', async (d) => { await d.accept(); });
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.cv-form .cv-input');
    const before = await count(server.baseUrl);

    // Two submits in the same tick — the shape of a double click / Enter twice.
    await page.evaluate(() => {
      const ta = document.querySelector('.cv-input'); ta.value = 'once, please'; ta.dispatchEvent(new Event('input', { bubbles: true }));
      const fm = document.querySelector('.cv-form');
      fm.requestSubmit(); fm.requestSubmit();
    });
    await page.waitForFunction(() => document.querySelector('.cv-input')?.value === '', { timeout: 5000 });
    await page.waitForFunction(() => [...document.querySelectorAll('.cv-msg')].some((m) => m.textContent.includes('once, please')), { timeout: 5000 });
    assert.equal(await count(server.baseUrl), before + 1, 'grew by exactly ONE — a second submit during the send is a no-op');
    assert.equal(await page.$eval('.cv-send', (b) => b.disabled), false, 'the button is live again after the send');

    // Control: the latch RELEASES — two submits with a settle between are two posts.
    for (const body of ['first', 'second']) {
      await page.evaluate((b) => { const ta = document.querySelector('.cv-input'); ta.value = b; ta.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.cv-form').requestSubmit(); }, body);
      await page.waitForFunction(() => document.querySelector('.cv-input')?.value === '', { timeout: 5000 });
    }
    await page.waitForFunction(() => [...document.querySelectorAll('.cv-msg')].some((m) => m.textContent.includes('second')), { timeout: 5000 });
    assert.equal(await count(server.baseUrl), before + 3, 'two settled sends are two posts');
  }, { server: { board: makeBoardFixture({ cards: [], conversations: [] }) }, launch: { headless: 'new' } });
});
