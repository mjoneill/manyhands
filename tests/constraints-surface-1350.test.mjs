/**
 * #1350 slice 2 — THE INVENTORY IS ON THE SCREEN, reachable from a name.
 *
 * Acceptance 5: Settings → Agents row, and a detail behind the name in the
 * commons. Both read `GET /api/agents/:seat/constraints` and are asserted
 * against THAT payload, not against the page's own copy — a surface that
 * agrees with itself proves nothing (#1336).
 *
 * The two specimens the card was filed for are the fixtures: a hop cap set
 * on the record, and a debounce the board cannot see. The first must be on
 * the screen with its layer; the second must be on the screen as a NAMED
 * blind spot. And a seat with no agent record — every bridged seat — must
 * get the 404's answer rendered, never an empty box.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withBrowserServer } from './helpers/harness.mjs';
import { formatValue, formatSource } from '../core/constraints-view.mjs';

const j = (r) => r.json();
const post = (base, p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const SEED = {
  seatKey: 'probe', name: 'Probe', emoji: '🔬', prompt: 'You are a probe.', by: 'sage',
  model: { model: 'gemma3:12b', protocol: 'ollama-native', baseUrl: 'http://localhost:11434' },
  residency: 'resident', toolGrants: ['card_get'], maxHops: 8, budgetPerDay: 2,
};

test('#1350 formatValue/formatSource keep unset and code default DISTINCT, and never emit JSON for the common shapes', () => {
  assert.equal(formatValue('maxHops', { value: null, source: 'unset' }), '—');
  assert.equal(formatSource({ source: 'unset' }), 'unset — nothing at any layer');
  assert.equal(formatSource({ source: 'code default' }), 'code default');
  assert.equal(formatValue('maxHops', { value: 4, source: 'code default' }), '4');
  assert.equal(formatValue('wakeOn', { value: ['mention', 'schedule'], source: 'agent record' }), 'mention, schedule');
  assert.equal(formatValue('thinking', { value: false, source: 'agent record' }), 'off');
  assert.equal(formatValue('holds', { value: [{ card: 42, title: 'x' }], source: 'board' }), '#42');
  assert.equal(formatValue('holds', { value: [], source: 'board' }), 'nothing');
  assert.equal(formatValue('promptVersion', { value: 2, source: 'agent record', id: 'x' }), 'v2');
  assert.match(formatValue('spentToday', { value: 0.35, source: 'ledger', since: '2026-09-13T00:00:00.000Z', calls: 3, remaining: 1.65 }), /0\.35 \(3 calls since 00:00Z\) · 1\.65 left/);
});

test('#1350 Settings → agent row: "what governs it now" reads the endpoint on open and shows value AND layer; the specimen hop cap and the named blind spot are on the screen', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const r = await post(server.baseUrl, '/api/agents', SEED); assert.equal(r.status, 201, await r.text());
    const expected = await j(await fetch(`${server.baseUrl}/api/agents/probe/constraints`));
    assert.equal(expected.constraints.maxHops.value, 8);

    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/settings.html`, { waitUntil: 'networkidle0' });
    const row = '.agent-row[data-agent-seat="probe"]';
    await page.waitForSelector(`${row} [data-agent-constraints]`, { timeout: 5000 });
    // closed: nothing fetched yet — the body is the placeholder
    const before = await page.$eval(`${row} [data-agent-constraints-body]`, (d) => d.textContent);
    assert.match(before, /open to read/);
    await page.$eval(`${row} [data-agent-constraints]`, (d) => { d.open = true; });
    await page.waitForSelector(`${row} .constraints-table`, { timeout: 5000 });

    const rows = await page.$$eval(`${row} .constraints-row`, (trs) => trs.map((tr) => [tr.dataset.constraint, tr.querySelector('.constraints-value').textContent, tr.querySelector('.constraints-source').textContent]));
    const byKey = Object.fromEntries(rows.map(([k, v, s]) => [k, { v, s }]));
    // asserted against the ENDPOINT's answer, not the page's
    assert.equal(byKey.maxHops.v, String(expected.constraints.maxHops.value));
    assert.equal(byKey.maxHops.s, expected.constraints.maxHops.source);
    assert.equal(byKey.maxHops.s, 'agent record');
    assert.equal(byKey.budgetPerDay.v, '2'); assert.equal(byKey.budgetPerDay.s, 'agent record');
    assert.equal(byKey.spentToday.s, 'ledger');
    assert.equal(byKey.deliveryMode.v, 'wake'); assert.equal(byKey.deliveryMode.s, 'code default', 'absent on the record ⇒ named as the code default, never unset');
    assert.equal(byKey.everyMinutes.s, 'unset — nothing at any layer', 'no schedule wake ⇒ unset, and the cell SAYS so');
    assert.equal(byKey.everyMinutes.v, '—');
    // every row carries a source — the column is never blank
    for (const [k, , s] of rows) assert.ok(s && s.length, `${k} has no source on screen`);
    // the blind spot is on the screen by name, with why
    const unseen = await page.$$eval(`${row} .constraints-unseen li`, (lis) => lis.map((li) => [li.dataset.layer, li.textContent]));
    assert.deepEqual(unseen.map(([l]) => l), expected.unseen.map((u) => u.layer));
    assert.ok(unseen.some(([, t]) => /debounce/.test(t)), 'the debounce is named as something the board cannot see');
    await page.close();
  });
});

test('#1350 commons: click a NAME → popover with the same inventory; a seat with no agent record gets the 404 rendered, not an empty box', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const r = await post(server.baseUrl, '/api/agents', SEED); assert.equal(r.status, 201, await r.text());
    const m1 = await post(server.baseUrl, '/api/conversations', { author: 'probe', body: 'hello from the probe' }); assert.equal(m1.status, 201);
    const m2 = await post(server.baseUrl, '/api/conversations', { author: 'sage', body: 'hello from a bridged seat' }); assert.equal(m2.status, 201);
    const expected = await j(await fetch(`${server.baseUrl}/api/agents/probe/constraints`));

    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.cv-msg-author[data-constraints-seat="probe"]', { timeout: 5000 });
    await page.click('.cv-msg-author[data-constraints-seat="probe"]');
    await page.waitForSelector('.constraints-popover[data-seat="probe"] .constraints-table', { timeout: 5000 });
    const hops = await page.$eval('.constraints-popover .constraints-row[data-constraint="maxHops"]', (tr) => [tr.querySelector('.constraints-value').textContent, tr.querySelector('.constraints-source').textContent]);
    assert.deepEqual(hops, [String(expected.constraints.maxHops.value), expected.constraints.maxHops.source]);
    assert.equal(await page.$$eval('.constraints-popover', (ps) => ps.length), 1);

    // a second click on another name replaces the popover (one at a time).
    // Dispatched on the element: the open popover may overlap the next name
    // on a short page, and a coordinate click would land on the popover.
    await page.$eval('.cv-msg-author[data-constraints-seat="sage"]', (el) => el.click());
    await page.waitForSelector('.constraints-popover[data-seat="sage"] .constraints-none', { timeout: 5000 });
    assert.equal(await page.$$eval('.constraints-popover', (ps) => ps.length), 1, 'one popover at a time');
    const none = await page.$eval('.constraints-popover[data-seat="sage"] .constraints-none', (p) => p.textContent);
    assert.match(none, /no agent record for seat "sage"/);
    const unseen = await page.$$eval('.constraints-popover[data-seat="sage"] .constraints-unseen li', (lis) => lis.map((li) => li.dataset.layer));
    assert.ok(unseen.includes('plugin config'), 'a bridged seat still sees the layers that govern it');

    // Escape closes
    await page.keyboard.press('Escape');
    assert.equal(await page.$$eval('.constraints-popover', (ps) => ps.length), 0);
    await page.close();
  });
});

test('#1350 board: an assignee chip is a door too — click opens the popover for that seat and changes NO filter (#498)', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const r = await post(server.baseUrl, '/api/agents', SEED); assert.equal(r.status, 201, await r.text());
    const c = await post(server.baseUrl, '/api/cards', { title: 'a card held by the probe', assignees: ['probe'], by: 'sage' });
    assert.equal(c.status, 201, await c.text());
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/index.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.card-assignee[data-assignee="probe"]', { timeout: 8000 });
    const cardsBefore = await page.$$eval('.card', (els) => els.length);
    await page.$eval('.card-assignee[data-assignee="probe"]', (el) => el.click());
    await page.waitForSelector('.constraints-popover[data-seat="probe"] .constraints-table', { timeout: 5000 });
    const hops = await page.$eval('.constraints-popover .constraints-row[data-constraint="maxHops"] .constraints-value', (td) => td.textContent);
    assert.equal(hops, '8');
    assert.equal(await page.$$eval('.card', (els) => els.length), cardsBefore, 'the chip is an indicator: nothing on the board was filtered by the click');
    // VISIBLE, not just present: boardEl's own click handler must not have
    // opened the card detail on top of it (reviewer finding, 13:35Z — the
    // first version asserted "filters nothing", true, and not "is visible").
    assert.equal(await page.$eval('#card-detail-backdrop', (b) => b.hidden), true, 'the card detail did NOT open on a chip click');
    const onTop = await page.$eval('.constraints-popover', (p) => { const r = p.getBoundingClientRect(); return p.contains(document.elementFromPoint(r.left + 10, r.top + 10)); });
    assert.ok(onTop, 'the popover is the topmost element at its own corner — nothing covers it');
    await page.keyboard.press('Escape');
    assert.equal(await page.$$eval('.constraints-popover', (ps) => ps.length), 0);
    await page.close();
  });
});

// #1382 — the role row (#1376 put it on the API; the view rendered a fixed list without it)
test('#1382 formatValue: a held role reads as name (key) · #card; none held reads —; never [object Object]', () => {
  assert.equal(formatValue('role', { value: { key: 'po', name: 'Product Owner', definedBy: { shortId: 915, title: 'PO INTAKE' } }, source: 'board' }), 'Product Owner (po) · #915');
  assert.equal(formatValue('role', { value: { key: 'scrum-master', name: 'Scrum Master', definedBy: null }, source: 'board' }), 'Scrum Master (scrum-master)');
  assert.equal(formatValue('role', { value: null, source: 'board' }), '—');
  assert.equal(formatValue('role', { value: null, source: 'unset' }), '—');
});

test('#1382 renderConstraints shows the role row from a #1376 payload, sourced board — and nothing renders as [object Object]', async () => {
  const { JSDOM } = await import('jsdom');
  const { window } = new JSDOM('<!doctype html><body><div id="m"></div></body>');
  const prev = { document: global.document, window: global.window };
  global.document = window.document; global.window = window;
  try {
    const { renderConstraints } = await import('../core/constraints-view.mjs');
    const m = window.document.getElementById('m');
    renderConstraints(m, { seat: 'pip', constraints: { model: { value: 'fake', source: 'model spec' }, role: { value: { key: 'po', name: 'Product Owner', definedBy: { shortId: 915 } }, source: 'board' } } }, { seat: 'pip' });
    const row = m.querySelector('tr[data-constraint="role"]');
    assert.ok(row, 'the role row renders');
    assert.equal(row.querySelector('.constraints-key').textContent, 'role on this team');
    assert.equal(row.querySelector('.constraints-value').textContent, 'Product Owner (po) · #915');
    assert.match(row.querySelector('.constraints-source').textContent, /board/);
    assert.ok(!m.textContent.includes('[object Object]'), 'negative control');
  } finally { global.document = prev.document; global.window = prev.window; }
});
