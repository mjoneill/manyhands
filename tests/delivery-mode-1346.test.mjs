/**
 * #1346 slice 1 — `deliveryMode` on the agent record. A FIELD, no behaviour
 * yet: "wake" (today's mention/assignment/schedule; the default) or "channel"
 * (every post offered through Off/Soft/Hard; mention and schedule superseded;
 * assignment kept, because an assignment is an obligation and never enters
 * the fanout). Slices 2–4 make the field DO something; this one makes it
 * exist, read back, validate, and show on the #1350 surface with its layer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRestServer, makeBoardFixture } from './helpers/harness.mjs';

async function api(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  let parsed = null; try { parsed = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: parsed };
}
const MODEL = { model: 'fake', protocol: 'ollama-native', baseUrl: 'http://127.0.0.1:1' };
const create = (base, extra = {}) => api(base, 'POST', '/api/agents', { seatKey: 'gizmo', prompt: 'Be brief.', residency: 'resident', by: 'ada', model: MODEL, ...extra });
const read = async (base) => (await api(base, 'GET', '/api/agents')).body.find((a) => a.seatKey === 'gizmo');

test('#1346 the field DEFAULTS to "wake" and is READABLE as such — absent is not a third state', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    assert.equal((await create(srv.baseUrl)).status, 201);
    const a = await read(srv.baseUrl);
    assert.equal(a.deliveryMode, 'wake', 'the default is today\'s behaviour, and it is written down, not inferred from absence');
  } finally { await srv.stop(); }
});

test('#1346 the field survives the seam: set on CREATE, set on PATCH, read back each time, reversible', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    assert.equal((await create(srv.baseUrl, { deliveryMode: 'channel' })).status, 201);
    assert.equal((await read(srv.baseUrl)).deliveryMode, 'channel', 'accepted on create and READ BACK');
    const back = await api(srv.baseUrl, 'PATCH', '/api/agents/gizmo', { deliveryMode: 'wake', by: 'ada' });
    assert.equal(back.status, 200);
    assert.equal((await read(srv.baseUrl)).deliveryMode, 'wake', 'reversible — a mode that cannot be switched back is a delete');
    const fwd = await api(srv.baseUrl, 'PATCH', '/api/agents/gizmo', { deliveryMode: 'channel', by: 'ada' });
    assert.equal(fwd.status, 200);
    assert.equal((await read(srv.baseUrl)).deliveryMode, 'channel');
  } finally { await srv.stop(); }
});

test('#1346 an UNKNOWN mode is REFUSED with the two names, on create and on patch — never coerced, never silently dropped', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    const bad = await create(srv.baseUrl, { deliveryMode: 'tokenring' });
    assert.equal(bad.status, 400, `a typo must not land on either mode — got ${bad.status}`);
    assert.match(String(bad.body?.error), /wake|channel/, 'the refusal names what IS accepted');
    assert.equal((await create(srv.baseUrl)).status, 201);
    const patch = await api(srv.baseUrl, 'PATCH', '/api/agents/gizmo', { deliveryMode: 'Channel ', by: 'ada' });
    assert.equal(patch.status, 400, 'case and whitespace are not the contract either');
    assert.equal((await read(srv.baseUrl)).deliveryMode, 'wake', 'and the refused write changed nothing');
  } finally { await srv.stop(); }
});

test('#1346 the #1350 surface shows the mode WITH ITS LAYER, and no longer declares it unseen', async () => {
  const srv = await startRestServer({ board: makeBoardFixture({ cards: [], nextShortId: 1 }) });
  try {
    assert.equal((await create(srv.baseUrl)).status, 201);
    let c = (await api(srv.baseUrl, 'GET', '/api/agents/gizmo/constraints')).body;
    assert.equal(c.constraints.deliveryMode.value, 'wake');
    assert.equal(c.constraints.deliveryMode.source, 'code default', 'not set on the record ⇒ the code default, named as such — never blank');
    await api(srv.baseUrl, 'PATCH', '/api/agents/gizmo', { deliveryMode: 'channel', by: 'ada' });
    c = (await api(srv.baseUrl, 'GET', '/api/agents/gizmo/constraints')).body;
    assert.equal(c.constraints.deliveryMode.value, 'channel');
    assert.equal(c.constraints.deliveryMode.source, 'agent record');
    assert.ok(!c.unseen.some((u) => u.layer === 'channel delivery'),
      'the field exists now, so "channel delivery" leaves the unseen list — an inspector must not declare blind a thing it can read');
  } finally { await srv.stop(); }
});

// ── the editor, through a real browser ──────────────────────────────────────
import { withBrowserServer } from './helpers/harness.mjs';

const ROW = '.agent-row[data-agent-seat="gizmo"]';
async function openGizmo(page, base) {
  await page.goto(`${base}/settings.html#agent-gizmo`, { waitUntil: 'networkidle0' });
  await page.waitForSelector(`${ROW} [data-agent-delivery]`, { timeout: 5000 });
  await page.$eval(`${ROW} [data-agent-editor]`, (d) => { d.open = true; });
}
const wakeBoxes = (page) => page.$$eval(`${ROW} [data-agent-wake] input`, (els) => els.map((i) => ({ v: i.value, disabled: i.disabled })));

test('#1346 EDITOR — choosing "channel" greys out mention and schedule, leaves assignment live, and the save round-trips the mode', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    assert.equal((await create(server.baseUrl)).status, 201);
    const page = await browser.newPage();
    await openGizmo(page, server.baseUrl);

    assert.deepEqual(await wakeBoxes(page), [
      { v: 'mention', disabled: false }, { v: 'assignment', disabled: false }, { v: 'schedule', disabled: false },
    ], 'in wake mode every rule is live');

    await page.select(`${ROW} [data-agent-delivery]`, 'channel');
    assert.deepEqual(await wakeBoxes(page), [
      { v: 'mention', disabled: true }, { v: 'assignment', disabled: false }, { v: 'schedule', disabled: true },
    ], 'channel supersedes mention and schedule; assignment is an obligation and stays');
    const hint = await page.$eval(`${ROW} [data-agent-delivery-hint]`, (e) => e.textContent);
    assert.match(hint, /slices 2/, 'the hint says the transport is not built yet — the selector must not promise a delivery that does not exist');

    await page.click(`${ROW} [data-agent-save]`);
    await page.waitForFunction((sel) => /saved/i.test(document.querySelector(sel)?.textContent || ''), { timeout: 5000 }, `${ROW} [data-agent-msg]`);
    assert.equal((await read(server.baseUrl)).deliveryMode, 'channel', 'what the editor showed is what the record holds');

    // And back, because a mode that cannot be switched back is a delete.
    await page.select(`${ROW} [data-agent-delivery]`, 'wake');
    assert.deepEqual((await wakeBoxes(page)).map((b) => b.disabled), [false, false, false]);
  });
});
