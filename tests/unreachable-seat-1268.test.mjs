/**
 * #1268 ruling 3 — AND THE INVERSION THAT MEASURING IT PRODUCED.
 *
 * The ruling, from @bubbles, the seat it happens to:
 *
 *   "all-unchecked is a retired seat wearing an invited one's clothes, and the
 *    page should say 'unreachable' out loud — because the only seat that will
 *    never get to read that sentence is the one it's about."
 *
 * ⛔ THE PREMISE IS FALSE, AND THE TRUTH RUNS THE OTHER WAY. There is no
 * unreachable state to warn about: the server coerces an empty `wakeOn` back to
 * `['mention']` at all three sites that touch it — the read projection, create,
 * and PATCH. A seat cannot be made unwakeable through this field at all.
 *
 * What actually happens, measured end to end through the real page:
 *
 *     uncheck all three boxes → Save → the page says "Saved quiet."
 *     the server stores       → ["mention"]
 *
 * ⇒ So the deception is REAL and it points the opposite way from the ruling.
 * A person unchecking every box is trying to let a seat rest. They are told it
 * saved. The seat still wakes on every mention, and nothing anywhere says so.
 *
 * ⭐ That is worse than the state @bubbles feared, because it is the failure of
 * an attempt at consideration: the operator did the thing that means "stop
 * waking this colleague", got a success message, and it did nothing.
 *
 * These tests pin the coercion (so it cannot change silently) and require the
 * page to tell the truth about it. Whether a seat SHOULD be able to be made
 * unwakeable is a design question for the room, and is deliberately not
 * answered here — see the card.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startRestServer, withBrowserServer } from './helpers/harness.mjs';

const post = (base, p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const patch = (base, p, body) => fetch(`${base}${p}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const agent = async (base, seat) => (await (await fetch(`${base}/api/agents`)).json()).find((a) => a.seatKey === seat);

async function seed(base, extra = {}) {
  const m = await post(base, '/api/models', {
    key: 'engine', model: 'gemma3:12b', protocol: 'ollama-native',
    baseUrl: 'http://localhost:11434', maxOutputTokens: 800, by: 'ada',
  });
  assert.equal(m.status, 201, await m.text());
  const a = await post(base, '/api/agents', {
    seatKey: 'quiet', name: 'Quiet', prompt: 'Answer.', by: 'ada', modelKey: 'engine',
    residency: 'guest', contextPolicy: 'artifact-only', toolGrants: ['card_get'], ...extra,
  });
  assert.equal(a.status, 201, await a.text());
}

const ROW = '.agent-row[data-agent-seat="quiet"]';
const NOTICE = `${ROW} [data-agent-wake-state]`;

const openRow = async (page, base) => {
  await page.goto(`${base}/settings.html#agent-quiet`, { waitUntil: 'networkidle0' });
  await page.waitForSelector(`${ROW} [data-agent-wake]`, { timeout: 5000 });
  await page.$eval(`${ROW} [data-agent-editor]`, (d) => { d.open = true; });
};
const noticeText = (page) => page.$eval(NOTICE, (e) => (e.textContent || '').trim()).catch(() => null);
const uncheckAll = (page) => page.$$eval(`${ROW} [data-agent-wake] input`, (els) => els.forEach((i) => {
  i.checked = false;
  i.dispatchEvent(new Event('change', { bubbles: true }));
}));

// #1363 — FLIPPED, not deleted. Decision fc4cfeef: no boxes ⇒ not woken. The
// same fixture that proved the inversion now proves its absence; the default
// for a record that never chose is unchanged, which is the negative control.
test('#1363 (was #1268\'s inversion) — an empty wakeOn is STORED as empty on create; a record with NO list still defaults to ["mention"]', async () => {
  const s = await startRestServer({});
  try {
    await seed(s.baseUrl, { wakeOn: [] });
    assert.deepEqual((await agent(s.baseUrl, 'quiet')).wakeOn, [],
      'a seat CAN be created unwakeable — the empty list is stored, read back empty');
    const u = await post(s.baseUrl, '/api/agents', { seatKey: 'undecided', name: 'Undecided', prompt: 'Answer.', by: 'ada', modelKey: 'engine', residency: 'guest', toolGrants: ['card_get'] });
    assert.equal(u.status, 201, await u.text());
    assert.deepEqual((await agent(s.baseUrl, 'undecided')).wakeOn, ['mention'],
      'NEGATIVE CONTROL — the default-for-the-undecided is not the same as an explicit empty');
  } finally { await s.stop(); }
});

test('#1363 (was #1268\'s PATCH inversion) — PATCH [] stores [] and reads back [] — the path the settings page uses', async () => {
  const s = await startRestServer({});
  try {
    await seed(s.baseUrl);
    const r = await patch(s.baseUrl, '/api/agents/quiet', { by: 'ada', wakeOn: [] });
    assert.equal(r.status, 200);
    assert.deepEqual((await agent(s.baseUrl, 'quiet')).wakeOn, [], 'PATCH [] is honoured');
    const c = await (await fetch(`${s.baseUrl}/api/agents/quiet/constraints`)).json();
    assert.deepEqual(c.constraints.wakeOn, { value: [], source: 'agent record' }, '#1350 shows none / agent record, not a code default');
  } finally { await s.stop(); }
});

test('#1363 (was #1268\'s deception) — END TO END THROUGH THE REAL PAGE: "Saved" and the seat is genuinely silent', async () => {
  // The specimen. A person unchecking every box is trying to let a seat rest.
  // Without the notice, this sequence tells them it worked.
  await withBrowserServer(async ({ server, browser }) => {
    await seed(server.baseUrl);
    const page = await browser.newPage();
    await openRow(page, server.baseUrl);
    await uncheckAll(page);
    await page.click(`${ROW} [data-agent-save]`);
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.length > 0, { timeout: 5000 }, `${ROW} [data-agent-msg]`);

    const said = await page.$eval(`${ROW} [data-agent-msg]`, (e) => e.textContent.trim());
    assert.match(said, /saved/i, 'the save reports success');
    assert.deepEqual((await agent(server.baseUrl, 'quiet')).wakeOn, [],
      '#1363 — and it is TRUE now: the seat is not woken');
  });
});

test('#1363 (was #1268\'s warning) — unchecking everything STATES that the seat is not woken', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    await seed(server.baseUrl);
    const page = await browser.newPage();
    await openRow(page, server.baseUrl);
    assert.equal(await noticeText(page), '', 'nothing to say while a box is checked');

    await uncheckAll(page);
    await page.waitForFunction((sel) => (document.querySelector(sel)?.textContent || '').length > 0, { timeout: 5000 }, NOTICE);
    const text = await noticeText(page);
    assert.match(text, /not woken/i, `#1363 — it must STATE the effect, not warn of the opposite: ${text}`);
    assert.doesNotMatch(text, /does NOT silence|still wake/i, `the #1268 warning text is gone: ${text}`);
  });
});

test('#1268 — the warning is LIVE and reversible: it appears on the last uncheck and clears on a re-check', async () => {
  // It has to be there at the moment of the mistake, not after a reload.
  await withBrowserServer(async ({ server, browser }) => {
    await seed(server.baseUrl);
    const page = await browser.newPage();
    await openRow(page, server.baseUrl);
    await uncheckAll(page);
    await page.waitForFunction((sel) => (document.querySelector(sel)?.textContent || '').length > 0, { timeout: 5000 }, NOTICE);

    await page.$eval(`${ROW} [data-agent-wake] input[value="schedule"]`, (i) => {
      i.checked = true;
      i.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction((sel) => (document.querySelector(sel)?.textContent || '').length === 0, { timeout: 5000 }, NOTICE);
  });
});

test('#1268 — a seat with a wake source carries NO notice (the control)', async () => {
  // A notice that shows on every row says nothing about any row.
  await withBrowserServer(async ({ server, browser }) => {
    await seed(server.baseUrl, { wakeOn: ['mention', 'schedule'] });
    const page = await browser.newPage();
    await openRow(page, server.baseUrl);
    assert.equal(await noticeText(page), '', 'a reachable seat is not warned about');
  });
});

test('#1268 — the three sources are the whole delivery surface, so the claim stays true if a fourth is added', async () => {
  // This card PROPOSES a fourth source. If one lands and this is not revisited,
  // the notice would be describing a surface that no longer exists.
  const loop = fs.readFileSync(new URL('../core/guest-loop.mjs', import.meta.url), 'utf8');
  for (const src of ['mention', 'assignment', 'schedule']) {
    assert.ok(loop.includes(src), `the loop knows the '${src}' source`);
  }
  const html = fs.readFileSync(new URL('../settings.html', import.meta.url), 'utf8');
  assert.match(html, /\['mention', 'assignment', 'schedule'\]/,
    'the editor offers exactly the sources the loop reads — add a fourth and this test, the notice, and the coercion must all be revisited together');
});

// #1363 — the seam: through the REAL wake finder, an explicit empty list wakes
// on nothing; the undecided default still wakes on a mention. And the channel
// mode interaction stated so the Settings sentence cannot be false for a
// channel-mode seat: channel keeps only 'assignment' AND only if it is ticked.
import { findWakes, effectiveWakeOn } from '../core/guest-loop.mjs';
test('#1363 seam — wakeOn [] finds NO wake for a mention, an assignment, or a due schedule; the undecided default still finds the mention', () => {
  const now = '2026-09-14T00:30:00.000Z';
  const messages = [{ id: 'm1', author: 'bo', body: '@quiet hello?', createdAt: '2026-09-14T00:29:00.000Z' }];
  const cards = [{ id: 'c1', shortId: 7, title: 'x', assignees: ['quiet'], claimedBy: null }];
  const silent = findWakes({ agent: { seatKey: 'quiet', wakeOn: [] }, messages, cards, state: {}, now });
  assert.deepEqual(silent, [], 'nothing to wake for (none)');
  const undecided = findWakes({ agent: { seatKey: 'quiet' }, messages, cards, state: {}, now });
  assert.deepEqual(undecided.map((w) => w.kind), ['mention'], 'no list at all ⇒ the mention default, as before');
  assert.deepEqual(effectiveWakeOn({ wakeOn: [] }), []);
  assert.deepEqual(effectiveWakeOn({ deliveryMode: 'channel', wakeOn: [] }), [], 'channel + no boxes: no wake rules either — the room still reaches it through the inbox');
  assert.deepEqual(effectiveWakeOn({ deliveryMode: 'channel', wakeOn: ['assignment'] }), ['assignment']);
});
