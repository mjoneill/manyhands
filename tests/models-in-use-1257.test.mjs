/**
 * #1257 — THE PAGE CALLED MODELS COULD NOT ANSWER "WHAT MODELS DOES THIS BOARD
 * USE". The board ran three models and the section listed two: an inline model
 * (a seat pointed at an endpoint with no registry entry) was invisible, and a
 * registered model nobody used looked exactly like one everybody did. The
 * owner went to Models looking for a seat's model and was handed a confident
 * answer to a different question.
 *
 * The author's answer to the card's caveat: the REGISTRY stays the store of
 * shared definitions; the SECTION lists what the board runs. So a registered
 * row says who uses it (or that nobody does), inline models are listed as what
 * they are — per seat, linked to the seat — and promotion to the registry is an
 * explicit act that fills the form and creates nothing by itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withBrowserServer } from './helpers/harness.mjs';

const j = (r) => r.json();
const post = (base, p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function seed(base) {
  for (const m of [
    { key: 'shared-engine', model: 'gemma3:12b', protocol: 'ollama-native', baseUrl: 'http://localhost:11434', by: 'sage' },
    { key: 'idle-engine', model: 'phi4:14b', protocol: 'ollama-native', baseUrl: 'http://localhost:11434', by: 'sage' },
  ]) { const r = await post(base, '/api/models', m); assert.equal(r.status, 201, await r.text()); }
  const bound = await post(base, '/api/agents', { seatKey: 'bound', name: 'Bound', prompt: 'Answer.', by: 'sage', modelKey: 'shared-engine', residency: 'resident', contextPolicy: 'artifact-only', toolGrants: ['card_get'] });
  assert.equal(bound.status, 201, await bound.text());
  const loner = await post(base, '/api/agents', { seatKey: 'loner', name: 'Loner', prompt: 'Answer.', by: 'sage', residency: 'guest', contextPolicy: 'artifact-only', toolGrants: ['card_get'],
    model: { model: 'qwen3.5:9b', protocol: 'ollama-native', baseUrl: 'http://localhost:11434', sampling: { temperature: 0.2 } } });
  assert.equal(loner.status, 201, await loner.text());
}

test('#1257 the Models section lists what the board RUNS: the inline model appears, named as inline and linked to its seat', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    await seed(server.baseUrl);
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/settings.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-inline-models] [data-inline-model="loner"]', { timeout: 5000 });
    const inline = await page.$eval('[data-inline-model="loner"]', (el) => ({ text: el.textContent, link: el.querySelector('a')?.getAttribute('href') }));
    assert.match(inline.text, /qwen3\.5:9b/, 'the model the board is running is on the page');
    assert.match(inline.text, /inline/i, 'and it says it is inline, not shared');
    assert.equal(inline.link, '#agent-loner', 'linked to the seat that runs it');
    assert.match(inline.text, /temperature=0\.2/, 'its per-seat sampling is visible where the model is');
    // The registry itself is unchanged: two registered models, and only two.
    const models = await j(await fetch(`${server.baseUrl}/api/models`));
    assert.equal(models.length, 2, 'listing an inline model did not register it');
  });
});

test('#1257 a registered model says WHO uses it, and one nobody uses says so — the list stops being wrong in both directions', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    await seed(server.baseUrl);
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/settings.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.agent-row[data-model-key="idle-engine"] [data-model-used-by]', { timeout: 5000 });
    const shared = await page.$eval('.agent-row[data-model-key="shared-engine"] [data-model-used-by]', (el) => ({ text: el.textContent, link: el.querySelector('a')?.getAttribute('href') }));
    assert.match(shared.text, /used by/); assert.equal(shared.link, '#agent-bound');
    const idle = await page.$eval('.agent-row[data-model-key="idle-engine"] [data-model-used-by]', (el) => ({ text: el.textContent, unused: !!el.querySelector('[data-model-unused]') }));
    assert.ok(idle.unused, 'the idle registration is marked as used by nobody: ' + idle.text);
  });
});

test('#1257 promotion is an EXPLICIT act: the button fills the register form from the seat and creates NOTHING until Register is pressed', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    await seed(server.baseUrl);
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/settings.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-inline-model="loner"] [data-model-promote]', { timeout: 5000 });
    await page.click('[data-inline-model="loner"] [data-model-promote]');
    const form = await page.evaluate(() => ({
      key: document.getElementById('model-key').value,
      model: document.getElementById('model-model').value,
      protocol: document.getElementById('model-protocol').value,
      baseUrl: document.getElementById('model-baseurl').value,
      open: document.getElementById('model-key').closest('details').open,
      focused: document.activeElement && document.activeElement.id,
    }));
    assert.equal(form.model, 'qwen3.5:9b'); assert.equal(form.protocol, 'ollama-native'); assert.equal(form.baseUrl, 'http://localhost:11434');
    assert.equal(form.key, '', 'the key is the human\'s to choose'); assert.ok(form.open, 'the form is open'); assert.equal(form.focused, 'model-key', 'and the cursor is on the key');
    const models = await j(await fetch(`${server.baseUrl}/api/models`));
    assert.equal(models.length, 2, 'nothing was registered by the click');
    const loner = (await j(await fetch(`${server.baseUrl}/api/agents`))).find((a) => a.seatKey === 'loner');
    assert.equal(loner.usesModel, null, 'and the seat is still inline');
  });
});
