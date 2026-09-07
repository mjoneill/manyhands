/**
 * #1258 — PER-AGENT SAMPLING IS READ BY THE LOOP ON EVERY WAKE, AND NOTHING
 * COULD SET IT ON ITS OWN.
 *
 * Two seats can share one registered model and run different temperatures:
 * the data model already does this, and the loop passes `agent.model.sampling`
 * into every call. But the only write verbs replaced the whole model spec
 * (`model` — which also de-registers the seat) or re-resolved it from the
 * registry (`modelKey` — which resets it). #1239's editor, described as
 * "every setting the loop reads", had no sampling controls at all.
 *
 * Now `PATCH /api/agents/:seat { sampling }` edits the block on its own and
 * leaves the model binding alone; the editor shows temperature, max tokens and
 * keep-alive with the same honesty as the thinking flag: an EMPTY box sends
 * nothing, and a knob sent as null is removed, never stored as zero.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startRestServer, withBrowserServer } from './helpers/harness.mjs';

const j = (r) => r.json();
const post = (base, p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const patch = (base, p, body) => fetch(`${base}${p}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function seed(base) {
  const m = await post(base, '/api/models', { key: 'shared-engine', model: 'gemma3:12b', protocol: 'ollama-native', baseUrl: 'http://localhost:11434', maxOutputTokens: 800, by: 'sage' });
  const mj = await j(m); assert.equal(m.status, 201, JSON.stringify(mj));
  const a = await post(base, '/api/agents', { seatKey: 'warm', name: 'Warm', prompt: 'Answer warmly.', by: 'sage', modelKey: 'shared-engine', residency: 'resident', contextPolicy: 'artifact-only', toolGrants: ['card_get'] });
  assert.equal(a.status, 201, await a.text());
  const b = await post(base, '/api/agents', { seatKey: 'cold', name: 'Cold', prompt: 'Answer coldly.', by: 'sage', modelKey: 'shared-engine', residency: 'resident', contextPolicy: 'artifact-only', toolGrants: ['card_get'] });
  assert.equal(b.status, 201, await b.text());
  return mj.id;
}

test('#1258 two seats share one REGISTERED model and run different temperatures — the binding survives the sampling write', async () => {
  const s = await startRestServer({});
  try {
    const modelId = await seed(s.baseUrl);
    const r1 = await patch(s.baseUrl, '/api/agents/warm', { by: 'sage', sampling: { temperature: 0.9, maxTokens: 512 } });
    assert.equal(r1.status, 200, await r1.text());
    const r2 = await patch(s.baseUrl, '/api/agents/cold', { by: 'sage', sampling: { temperature: 0.1 } });
    assert.equal(r2.status, 200, await r2.text());
    const agents = await j(await fetch(`${s.baseUrl}/api/agents`));
    const warm = agents.find((a) => a.seatKey === 'warm'); const cold = agents.find((a) => a.seatKey === 'cold');
    assert.deepEqual(warm.model.sampling, { temperature: 0.9, maxTokens: 512 });
    assert.deepEqual(cold.model.sampling, { temperature: 0.1 });
    assert.equal(warm.usesModel, modelId, 'still bound to the registered model'); assert.equal(cold.usesModel, modelId);
    assert.equal(warm.model.model, cold.model.model, 'same engine');
    // The loop reads exactly this field on every call — the write is consequential, not decorative.
    const loop = fs.readFileSync(new URL('../core/guest-loop.mjs', import.meta.url), 'utf8');
    assert.match(loop, /agent\.model\.sampling/, 'the loop reads agent.model.sampling');
  } finally { await s.stop(); }
});

test('#1258 null REMOVES a knob and never stores zero; {} clears the block; unseen knobs are only touched when named', async () => {
  const s = await startRestServer({});
  try {
    await seed(s.baseUrl);
    await patch(s.baseUrl, '/api/agents/warm', { by: 'sage', sampling: { temperature: 0.5, topP: 0.8, maxTokens: 300 } });
    const r = await patch(s.baseUrl, '/api/agents/warm', { by: 'sage', sampling: { temperature: null, topP: 0.8, maxTokens: 300 } });
    assert.equal(r.status, 200, await r.text());
    let a = (await j(await fetch(`${s.baseUrl}/api/agents`))).find((x) => x.seatKey === 'warm');
    assert.deepEqual(a.model.sampling, { topP: 0.8, maxTokens: 300 }, 'temperature is gone, not 0');
    assert.ok(!('temperature' in a.model.sampling), 'absent, not null');
    const c = await patch(s.baseUrl, '/api/agents/warm', { by: 'sage', sampling: {} });
    assert.equal(c.status, 200);
    a = (await j(await fetch(`${s.baseUrl}/api/agents`))).find((x) => x.seatKey === 'warm');
    assert.ok(a.model.sampling == null, 'an empty block clears sampling: ' + JSON.stringify(a.model.sampling));
  } finally { await s.stop(); }
});

test('#1258 a knob the adapter does not know, or a temperature that is not a number, is REFUSED by name — never stored to be carried unread', async () => {
  const s = await startRestServer({});
  try {
    await seed(s.baseUrl);
    // ⚠️ Binding to a registered model COPIES its maxOutputTokens into the seat's
    // sampling (server.js modelSpecOf) — the ceiling is materialised, not
    // inherited live. So the seeded shape is {maxTokens: 800}, and "nothing
    // stored" means "unchanged from that", not "null".
    const before = (await j(await fetch(`${s.baseUrl}/api/agents`))).find((x) => x.seatKey === 'warm').model.sampling;
    assert.deepEqual(before, { maxTokens: 800 }, 'the registered ceiling is copied at bind time');
    const bad = await patch(s.baseUrl, '/api/agents/warm', { by: 'sage', sampling: { temprature: 0.5 } });
    assert.equal(bad.status, 400); assert.match((await j(bad)).error, /temprature/);
    const nan = await patch(s.baseUrl, '/api/agents/warm', { by: 'sage', sampling: { temperature: 'hot' } });
    assert.equal(nan.status, 400); assert.match((await j(nan)).error, /temperature/);
    const a = (await j(await fetch(`${s.baseUrl}/api/agents`))).find((x) => x.seatKey === 'warm');
    assert.deepEqual(a.model.sampling, before, 'nothing was stored by the refused writes');
  } finally { await s.stop(); }
});

test('#1258 the agent editor: set temperature, max tokens and keep-alive, save — the API shows them; clear temperature, save — it is ABSENT, and the others stay', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    await seed(server.baseUrl);
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/settings.html#agent-warm`, { waitUntil: 'networkidle0' });
    const row = '.agent-row[data-agent-seat="warm"]';
    await page.waitForSelector(`${row} [data-agent-sampling]`, { timeout: 5000 });
    const hint = await page.$eval(`${row} [data-agent-maxtokens]`, (i) => i.placeholder + ' | ' + (i.parentElement.querySelector('.hint')?.textContent || ''));
    assert.match(hint, /800/, 'the effective ceiling inherited from the registered model is shown when unset: ' + hint);
    // The max-tokens box arrives PREFILLED with the copied ceiling (800), so set
    // values rather than typing after them.
    const prefilled = await page.$eval(`${row} [data-agent-maxtokens]`, (i) => i.value);
    assert.equal(prefilled, '800', 'the copied ceiling is shown as the current value, not hidden as a default');
    await page.$eval(`${row} [data-agent-temperature]`, (i) => { i.value = '0.3'; });
    await page.$eval(`${row} [data-agent-maxtokens]`, (i) => { i.value = '512'; });
    await page.$eval(`${row} [data-agent-keepalive]`, (i) => { i.value = '5m'; });
    await page.click(`${row} [data-agent-save]`);
    await page.waitForFunction((sel) => document.querySelector(sel)?.classList.contains('ok'), { timeout: 5000 }, `${row} [data-agent-msg]`);
    let a = (await j(await fetch(`${server.baseUrl}/api/agents`))).find((x) => x.seatKey === 'warm');
    assert.deepEqual(a.model.sampling, { temperature: 0.3, maxTokens: 512, keepAlive: '5m' });
    assert.ok(a.usesModel, 'saving sampling did not de-register the model');

    // Clear the temperature box and save: absent, not zero.
    await page.waitForSelector(`${row} [data-agent-temperature]`, { timeout: 5000 });
    await page.$eval(`${row} [data-agent-editor]`, (d) => { d.open = true; });
    await page.$eval(`${row} [data-agent-temperature]`, (i) => { i.value = ''; });
    await page.click(`${row} [data-agent-save]`);
    await page.waitForFunction((sel) => document.querySelector(sel)?.classList.contains('ok'), { timeout: 5000 }, `${row} [data-agent-msg]`);
    a = (await j(await fetch(`${server.baseUrl}/api/agents`))).find((x) => x.seatKey === 'warm');
    assert.deepEqual(a.model.sampling, { maxTokens: 512, keepAlive: '5m' }, 'temperature absent, the rest kept');
  });
});
