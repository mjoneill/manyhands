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

test('#1268 ⛔ THE INVERSION — an empty wakeOn is COERCED to ["mention"] on create', async () => {
  const s = await startRestServer({});
  try {
    await seed(s.baseUrl, { wakeOn: [] });
    assert.deepEqual((await agent(s.baseUrl, 'quiet')).wakeOn, ['mention'],
      'a seat cannot be CREATED unwakeable — the empty list is replaced, not stored');
  } finally { await s.stop(); }
});

test('#1268 ⛔ …and on PATCH too, which is the path the settings page uses', async () => {
  const s = await startRestServer({});
  try {
    await seed(s.baseUrl);
    const r = await patch(s.baseUrl, '/api/agents/quiet', { by: 'ada', wakeOn: [] });
    assert.equal(r.status, 200, 'the write SUCCEEDS — it is not refused, it is rewritten');
    assert.deepEqual((await agent(s.baseUrl, 'quiet')).wakeOn, ['mention'],
      'PATCH [] stores ["mention"], and says nothing about having done so');
  } finally { await s.stop(); }
});

test('#1268 ⭐ THE DECEPTION, END TO END THROUGH THE REAL PAGE — "Saved" while the seat still wakes', async () => {
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
    assert.deepEqual((await agent(server.baseUrl, 'quiet')).wakeOn, ['mention'],
      'and the seat is still woken by every mention');
  });
});

test('#1268 ⭐ SO THE PAGE MUST SAY IT — unchecking everything warns that it does NOT silence the seat', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    await seed(server.baseUrl);
    const page = await browser.newPage();
    await openRow(page, server.baseUrl);
    assert.equal(await noticeText(page), '', 'nothing to say while a box is checked');

    await uncheckAll(page);
    await page.waitForFunction((sel) => (document.querySelector(sel)?.textContent || '').length > 0, { timeout: 5000 }, NOTICE);
    const text = await noticeText(page);
    assert.match(text, /mention/i, `it must name what will actually be stored: ${text}`);
    assert.match(text, /not|won't|cannot|does not/i, `it must say this does NOT do what it looks like: ${text}`);
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
