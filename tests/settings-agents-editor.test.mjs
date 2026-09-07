/**
 * #1239 — A HUMAN CAN EDIT AN AGENT FROM THE SETTINGS PAGE.
 *
 * Every configuration change made on 2026-09-06 — grants, the thinking flag,
 * the model swap, the hop ceiling, on two seats — was a colleague issuing REST
 * by hand, because the page could only mint a prompt version. These tests are
 * the page doing those same writes through the UI, and reading them back from
 * the API rather than from the page's own message.
 *
 * ⛔ THE PAIRING THAT COST THREE HOURS (#1242): the prompt and the grants were
 * edited in different places and shown in different places. The editor here
 * shows CAPABILITIES and INSTRUCTIONS side by side, each dated, so a prompt
 * that tells a seat to stop before using the tools it was granted is visible
 * as a contradiction on one screen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startRestServer, withBrowserServer } from './helpers/harness.mjs';

const j = (r) => r.json();
const post = (base, p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const SEED_AGENT = {
  seatKey: 'probe', name: 'Probe', prompt: 'You are a probe. Answer from what you are handed.', by: 'sage',
  model: { model: 'gemma3:12b', protocol: 'ollama-native', baseUrl: 'http://localhost:11434' },
  residency: 'resident', contextPolicy: 'artifact-only',
  toolGrants: ['card_get', 'board_search', 'graph_query'],
};

test('#1239 GET /api/tools lists exactly what an agent may be granted — the page builds its checkboxes from this, never from a list of its own', async () => {
  const s = await startRestServer({});
  try {
    const tools = await j(await fetch(`${s.baseUrl}/api/tools`));
    assert.ok(Array.isArray(tools) && tools.length >= 5, 'a list of tools');
    for (const t of tools) { assert.equal(typeof t.name, 'string'); assert.equal(typeof t.description, 'string'); assert.ok(t.description.length > 20, `${t.name} says what it does`); }
    const names = tools.map((t) => t.name);
    for (const n of ['card_get', 'board_search', 'graph_query', 'kind_list', 'predicate_list', 'card_claim']) assert.ok(names.includes(n), `${n} is grantable`);
    // ⛔ The list and the validator must be ONE set: a name the page offers that
    // the server refuses is a checkbox that cannot be saved.
    const r = await post(s.baseUrl, '/api/agents', SEED_AGENT); assert.equal(r.status, 201, await r.text());
    const patch = await fetch(`${s.baseUrl}/api/agents/probe`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ by: 'sage', toolGrants: names }) });
    const patched = await j(patch);
    assert.equal(patch.status, 200, JSON.stringify(patched));
    assert.deepEqual(patched.toolGrants.slice().sort(), names.slice().sort(), 'every listed tool round-trips as a grant');
  } finally { await s.stop(); }
});

test('#1239 the agent editor: uncheck a grant, set the hop ceiling, turn thinking OFF, save — the API shows the change, not just the page', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const r = await post(server.baseUrl, '/api/agents', SEED_AGENT); assert.equal(r.status, 201, await r.text());
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/settings.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.agent-row[data-agent-seat="probe"] [data-agent-editor]', { timeout: 5000 });
    const row = '.agent-row[data-agent-seat="probe"]';
    await page.$eval(`${row} [data-agent-editor]`, (d) => { d.open = true; });

    // The checkboxes come from /api/tools and reflect the CURRENT grants.
    const grants = await page.$$eval(`${row} [data-agent-grants] input[type=checkbox]`, (els) => els.map((e) => [e.value, e.checked]));
    assert.ok(grants.length >= 6, 'one checkbox per grantable tool: ' + grants.length);
    assert.deepEqual(Object.fromEntries(grants.filter(([, c]) => c)), { card_get: true, board_search: true, graph_query: true }, 'checked = granted');

    await page.click(`${row} [data-agent-grants] input[value="graph_query"]`);
    await page.$eval(`${row} [data-agent-maxhops]`, (el) => { el.value = '3'; });
    await page.select(`${row} [data-agent-thinking]`, 'false');
    await page.click(`${row} [data-agent-save]`);
    await page.waitForFunction((sel) => document.querySelector(sel)?.classList.contains('ok'), { timeout: 5000 }, `${row} [data-agent-msg]`);

    const agents = await j(await fetch(`${server.baseUrl}/api/agents`));
    const a = agents.find((x) => x.seatKey === 'probe');
    assert.deepEqual(a.toolGrants.slice().sort(), ['board_search', 'card_get'], 'graph_query was revoked');
    assert.equal(a.maxHops, 3, 'hop ceiling saved');
    assert.equal(a.thinking, false, 'thinking is OFF (false), not unset');
    assert.equal(a.promptVersions, 1, 'saving settings did NOT mint a prompt version');
  }, { server: {}, launch: { headless: 'new' } });
});

test('#1239 a refusal is rendered as the server\'s words beside the editor, never as a bare status', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const r = await post(server.baseUrl, '/api/agents', SEED_AGENT); assert.equal(r.status, 201, await r.text());
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/settings.html`, { waitUntil: 'networkidle0' });
    const row = '.agent-row[data-agent-seat="probe"]';
    await page.waitForSelector(`${row} [data-agent-editor]`, { timeout: 5000 });
    await page.$eval(`${row} [data-agent-editor]`, (d) => { d.open = true; });
    await page.$eval(`${row} [data-agent-maxhops]`, (el) => { el.value = '99'; });
    await page.click(`${row} [data-agent-save]`);
    await page.waitForFunction((sel) => document.querySelector(sel)?.classList.contains('err'), { timeout: 5000 }, `${row} [data-agent-msg]`);
    const msg = await page.$eval(`${row} [data-agent-msg]`, (e) => e.textContent);
    assert.match(msg, /maxHops must be a whole number from 1 to 20/, 'the server\'s reason, verbatim: ' + msg);
    const a = (await j(await fetch(`${server.baseUrl}/api/agents`))).find((x) => x.seatKey === 'probe');
    assert.equal(a.maxHops, null, 'nothing was written');
  }, { server: {}, launch: { headless: 'new' } });
});

test('#1239 capabilities and instructions sit side by side, each dated, so a prompt that contradicts its grants is visible on one screen (#1242)', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const r = await post(server.baseUrl, '/api/agents', SEED_AGENT); assert.equal(r.status, 201, await r.text());
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/settings.html`, { waitUntil: 'networkidle0' });
    const row = '.agent-row[data-agent-seat="probe"]';
    await page.waitForSelector(`${row} [data-agent-editor]`, { timeout: 5000 });
    const pane = await page.$eval(`${row} [data-agent-editor]`, (d) => {
      d.open = true;
      const grants = d.querySelector('[data-agent-grants]'); const prompt = d.querySelector('[data-agent-prompt]');
      const gr = grants.getBoundingClientRect(); const pr = prompt.getBoundingClientRect();
      return {
        sideBySide: Math.abs(gr.top - pr.top) < 120 && gr.left < pr.left,
        grantsMeta: d.querySelector('[data-agent-grants-meta]')?.textContent || '',
        promptMeta: d.querySelector('[data-agent-prompt-meta]')?.textContent || '',
        promptBody: prompt.value,
      };
    });
    assert.ok(pane.sideBySide, 'grants on the left, prompt on the right, same band');
    assert.match(pane.promptMeta, /v1/, 'prompt version shown');
    assert.match(pane.promptMeta, /sage/, 'prompt author shown');
    assert.match(pane.promptMeta, /20\d\d-\d\d-\d\d/, 'prompt dated');
    assert.match(pane.grantsMeta, /20\d\d-\d\d-\d\d/, 'grants dated');
    assert.match(pane.promptBody, /You are a probe/, 'the CURRENT prompt is what is shown');
  }, { server: {}, launch: { headless: 'new' } });
});

test('#1239 the model editor: change a registered model\'s context window and thinking flag from the page', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const r = await post(server.baseUrl, '/api/models', { key: 'probe-model', model: 'gemma3:12b', protocol: 'ollama-native', baseUrl: 'http://localhost:11434', by: 'sage' });
    assert.equal(r.status, 201, await r.text());
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/settings.html`, { waitUntil: 'networkidle0' });
    const row = '.agent-row[data-model-key="probe-model"]';
    await page.waitForSelector(`${row} [data-model-editor]`, { timeout: 5000 });
    await page.$eval(`${row} [data-model-editor]`, (d) => { d.open = true; });
    await page.$eval(`${row} [data-model-ctx]`, (el) => { el.value = '4096'; });
    await page.select(`${row} [data-model-thinking]`, 'true');
    await page.click(`${row} [data-model-save]`);
    await page.waitForFunction((sel) => document.querySelector(sel)?.classList.contains('ok'), { timeout: 5000 }, `${row} [data-model-msg]`);
    const m = (await j(await fetch(`${server.baseUrl}/api/models`))).find((x) => x.key === 'probe-model');
    assert.equal(m.contextWindow, 4096);
    assert.equal(m.thinking, true);
  }, { server: {}, launch: { headless: 'new' } });
});

test('#1239 the page has a section nav and every link lands on a section that exists — the cure for the scrolling', () => {
  const html = fs.readFileSync(new URL('../settings.html', import.meta.url), 'utf8');
  const hrefs = [...html.matchAll(/data-settings-nav[\s\S]*?<\/nav>/g)].flatMap((m) => [...m[0].matchAll(/href="#([^"]+)"/g)].map((x) => x[1]));
  assert.ok(hrefs.length >= 5, 'a nav with one link per section: ' + hrefs.join(', '));
  for (const id of hrefs) assert.match(html, new RegExp(`id="${id}"`), `#${id} exists on the page`);
  for (const must of ['models-panel', 'agents-panel']) assert.ok(hrefs.includes(must), `${must} is reachable from the nav`);
});

/**
 * #1256 — THE OWNER OPENED THE PAGE AND CONCLUDED THE PROMPT EDITOR HAD BEEN
 * REMOVED. Nothing was removed: #1239 put the prompt behind a fold whose whole
 * label was "Edit". A control that exists and cannot be found produces a FALSE
 * belief about the system, which is worse than an absent one. So: the prompt's
 * first line is on the page before any click, the fold names what it holds, a
 * link to #agent-<seat> opens that seat's editor, and the nav marks the section
 * that is actually on screen (a clicked link used to keep its focus ring while
 * the reader scrolled away, so the nav pointed at the last click).
 */

test('#1256 the prompt is visible before any click, and the fold says what it hides', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const r = await post(server.baseUrl, '/api/agents', SEED_AGENT); assert.equal(r.status, 201, await r.text());
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/settings.html`, { waitUntil: 'networkidle0' });
    const row = '.agent-row[data-agent-seat="probe"]';
    await page.waitForSelector(`${row} [data-agent-editor]`, { timeout: 5000 });
    const seen = await page.$eval(row, (el) => ({
      peek: el.querySelector('[data-agent-prompt-peek]')?.textContent || '',
      peekVisible: !!(el.querySelector('[data-agent-prompt-peek]') && el.querySelector('[data-agent-prompt-peek]').getBoundingClientRect().height > 0),
      summary: el.querySelector('[data-agent-editor] > summary')?.textContent || '',
      open: el.querySelector('[data-agent-editor]').open,
      id: el.id,
    }));
    assert.ok(seen.peek.includes('You are a probe.'), 'the prompt\'s first line is on the page: ' + seen.peek);
    assert.ok(seen.peekVisible, 'and it is rendered, not merely present in the DOM');
    assert.equal(seen.open, false, 'the full editor still starts folded — the peek is what makes that acceptable');
    assert.match(seen.summary, /prompt/i, 'the fold names the prompt: ' + seen.summary);
    assert.match(seen.summary, /grants/i, 'and the grants: ' + seen.summary);
    assert.equal(seen.id, 'agent-probe', 'the row is addressable');
  });
});

test('#1256 a link to #agent-<seat> lands on that seat with its editor OPEN', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const r = await post(server.baseUrl, '/api/agents', SEED_AGENT); assert.equal(r.status, 201, await r.text());
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/settings.html#agent-probe`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.agent-row[data-agent-seat="probe"] [data-agent-editor]', { timeout: 5000 });
    const open = await page.$eval('.agent-row[data-agent-seat="probe"] [data-agent-editor]', (d) => d.open);
    assert.equal(open, true, 'arriving by link opens the editor');
    const textarea = await page.$eval('.agent-row[data-agent-seat="probe"] [data-agent-prompt]', (t) => ({ value: t.value, visible: t.getBoundingClientRect().height > 0 }));
    assert.ok(textarea.visible && textarea.value.startsWith('You are a probe.'), 'and the prompt textarea is on screen with the prompt in it');
  });
});

test('#1256 the nav marks the section ON SCREEN — scrolled to Models, it says Models, not the last thing clicked', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 600 });
    await page.goto(`${server.baseUrl}/settings.html`, { waitUntil: 'networkidle0' });
    // Click Whispers (the specimen: the nav kept saying Whispers), then scroll to Models by hand.
    await page.click('[data-settings-nav] a[href="#whispers-panel"]');
    await page.waitForFunction(() => document.querySelector('[data-settings-nav] a[href="#whispers-panel"]')?.getAttribute('aria-current') === 'location', { timeout: 3000 });
    await page.evaluate(() => document.getElementById('models-panel').scrollIntoView());
    await page.waitForFunction(() => document.querySelector('[data-settings-nav] a[href="#models-panel"]')?.getAttribute('aria-current') === 'location', { timeout: 3000 });
    const marked = await page.$$eval('[data-settings-nav] a[aria-current]', (els) => els.map((a) => a.getAttribute('href')));
    assert.deepEqual(marked, ['#models-panel'], 'exactly one link is current, and it is the section on screen');
    const focused = await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('href'));
    assert.notEqual(focused, '#whispers-panel', 'the clicked link does not keep focus to masquerade as current');
  });
});
