/**
 * #1734 (with #1857) — the wiki editor never deletes a person's unsaved words without them seeing it.
 *
 * Measured 2026-10-22 (the probe kept in the private workspace, diagnostics/wiki-draft-loss-20261022/):
 *   path 1  Save gets an HTTP error → the editor closed, the draft key was deleted, no error was shown: words LOST.
 *           (core/composer-watch.mjs says clearDraft is "Called ONLY after a post is confirmed stored"; wiki.html's
 *           Save called it without checking res.ok.)
 *   path 4  the page changed while the editor was closed → on reopen the draft was dropped silently: words LOST.
 *   case 5  the page changed while the editor was OPEN → Save overwrote the other person's text (#1857's lost update).
 *   cases 2 and 3 (network loss, applied or not) kept the words: those are CONTROLS and stay green here.
 *
 * Every browser row ends on what the PERSON sees: the editor on screen, or the editor reopened. Not the storage key.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountComposerWatch, draftKeyFor } from '../core/composer-watch.mjs';
import { makeBoardFixture, withBrowserServer } from './helpers/harness.mjs';

// ── U: the draft module hands a stale draft to its caller instead of deleting it ───────────────────────────────────

function world({ storage = new Map(), value = '' } = {}) {
  const { window } = new JSDOM(`<!doctype html><body><textarea id="ta">${value}</textarea></body>`, { url: 'http://board.test/wiki.html' });
  window.localStorage.clear();
  for (const [k, v] of storage) window.localStorage.setItem(k, v);
  const prev = global.window; global.window = window;
  return { window, ta: window.document.getElementById('ta'), restore: () => { global.window = prev; } };
}
const snapshot = (win) => { const m = new Map(); for (let i = 0; i < win.localStorage.length; i++) { const k = win.localStorage.key(i); m.set(k, win.localStorage.getItem(k)); } return m; };

test('U1 #1734 path 4: with onStale, a draft written on an OLDER base is handed to the caller word for word, the newer text stays in the box, and the key is KEPT until the person chooses', () => {
  const w = world({ value: 'v1' });
  const h = mountComposerWatch(w.window.document, { textarea: w.ta, key: 'wiki:p1', base: 'v1', sample: false });
  w.ta.value = 'my unsaved words\nsecond line\n'; w.ta.dispatchEvent(new w.window.Event('input', { bubbles: true }));
  h.stop(); w.restore();
  const handed = [];
  const w2 = world({ storage: snapshot(w.window), value: 'v2 by someone else' });
  const h2 = mountComposerWatch(w2.window.document, { textarea: w2.ta, key: 'wiki:p1', base: 'v2 by someone else', sample: false, onStale: (t) => handed.push(t) });
  assert.deepEqual(handed, ['my unsaved words\nsecond line\n'], 'the caller received the exact words');
  assert.equal(w2.ta.value, 'v2 by someone else', 'the stale draft never overwrites the newer text on its own (#466)');
  assert.notEqual(w2.window.localStorage.getItem(draftKeyFor('wiki:p1')), null, 'and it is not deleted behind the person\'s back');
  h2.stop(); w2.restore();
});

// ── B: the real editor, served ─────────────────────────────────────────────────────────────────────────────────────

const MINE = 'my unsaved words\nsecond line\n';
const J = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function mkPage(base, text) {
  const r = await fetch(`${base}/api/nodes`, J('POST', { title: 'a page', body: '' }));
  assert.ok(r.ok, `create ${r.status}`);
  const id = (await r.json())['@id'];
  assert.ok((await fetch(`${base}/api/nodes/${encodeURIComponent(id)}`, J('PATCH', { body: text }))).ok, 'seed');
  return id;
}
const serverText = async (base, id) => (await (await fetch(`${base}/api/nodes/${encodeURIComponent(id)}`)).json()).node.text;
const editElsewhere = (base, id, text) => fetch(`${base}/api/nodes/${encodeURIComponent(id)}`, J('PATCH', { body: text }));

async function openEditor(page, base, id) {
  await page.goto(`${base}/wiki.html?node=${encodeURIComponent(id)}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim().endsWith('Edit')), { timeout: 8000 });
  await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => b.textContent.trim().endsWith('Edit')).click(); });
  await page.waitForSelector('.edit-body', { timeout: 8000 });
}
const type = (page, text) => page.evaluate((t) => { const ta = document.querySelector('.edit-body'); ta.value = t; ta.dispatchEvent(new Event('input', { bubbles: true })); }, text);
const clickButton = (page, label) => page.evaluate((l) => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === l);
  if (!b) return false; b.click(); return true;
}, label);
const settle = () => new Promise((r) => setTimeout(r, 1200));
const screen = (page) => page.evaluate(() => ({
  editorOpen: !!document.querySelector('.edit-body'),
  editorText: document.querySelector('.edit-body')?.value ?? null,
  status: document.querySelector('.save-status')?.textContent ?? '',
}));

/** Intercept this page's PATCH: 'http500' | 'abort-unapplied' | 'abort-applied' | 'record' (capture the body, pass it on). */
async function intercept(page, base, id, mode, seen = []) {
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    if (page.__off || req.method() !== 'PATCH' || !req.url().includes(`/api/nodes/${encodeURIComponent(id)}`)) return req.continue();
    seen.push(JSON.parse(req.postData() || '{}'));
    if (mode === 'http500') return req.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'injected failure' }) });
    if (mode === 'abort-unapplied') return req.abort('connectionreset');
    if (mode === 'abort-applied') { await fetch(req.url(), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: req.postData() }); return req.abort('connectionreset'); }
    return req.continue();
  });
  return seen;
}

const served = (fn) => withBrowserServer(async ({ server, browser }) => {
  const page = await browser.newPage();
  page.on('dialog', (d) => d.accept());
  await fn({ base: server.baseUrl, page });
}, { server: { board: makeBoardFixture({ cards: [], nextShortId: 1 }) } });

test('B1 #1857 Save SENDS the version the editor loaded (node.board.version), and a plain save still lands and closes the editor', async () => {
  await served(async ({ base, page }) => {
    const id = await mkPage(base, 'v1 server text');
    const loaded = (await (await fetch(`${base}/api/nodes/${encodeURIComponent(id)}`)).json()).node.board.version;
    const seen = await intercept(page, base, id, 'record');
    await openEditor(page, base, id); await type(page, MINE);
    assert.ok(await clickButton(page, 'Save')); await settle();
    assert.equal(seen.at(-1)?.ifVersion, loaded, `the save carried ifVersion ${loaded}: ${JSON.stringify(seen.at(-1))}`);
    assert.equal(await serverText(base, id), MINE, 'CONTROL: the words were stored');
    assert.equal((await screen(page)).editorOpen, false, 'and the editor closed on a confirmed save');
  });
});

test('B2 #1734 path 1: Save gets an HTTP 500 → the editor STAYS OPEN with the exact words, the person is told, and reopening still shows them', async () => {
  await served(async ({ base, page }) => {
    const id = await mkPage(base, 'v1 server text');
    await intercept(page, base, id, 'http500');
    await openEditor(page, base, id); await type(page, MINE);
    await clickButton(page, 'Save'); await settle();
    const s = await screen(page);
    assert.equal(s.editorOpen, true, 'the editor did not close on a failure');
    assert.equal(s.editorText, MINE, 'the words are still in it');
    assert.match(s.status, /not saved|failed/i, `the person sees that the save failed: ${JSON.stringify(s.status)}`);
    page.__off = true;
    await openEditor(page, base, id);
    assert.equal((await screen(page)).editorText, MINE, 'and the draft survived a reopen (clearDraft was NOT called)');
  });
});

test('B3 #1857 case 5: the page changed while the editor was OPEN → Save is refused, their text survives, mine stays on screen, and "Save mine anyway" is a deliberate overwrite', async () => {
  await served(async ({ base, page }) => {
    const id = await mkPage(base, 'v1 server text');
    await openEditor(page, base, id); await type(page, MINE);
    assert.ok((await editElsewhere(base, id, 'v2 by someone else')).ok);
    await clickButton(page, 'Save'); await settle();
    const s = await screen(page);
    assert.equal(await serverText(base, id), 'v2 by someone else', 'their text was NOT overwritten');
    assert.equal(s.editorOpen, true); assert.equal(s.editorText, MINE, 'my words are still on screen');
    assert.match(s.status, /changed/i, `the person is told why: ${JSON.stringify(s.status)}`);
    assert.ok(await clickButton(page, 'Save mine anyway'), 'the overwrite is offered as an explicit choice');
    await settle();
    assert.equal(await serverText(base, id), MINE, 'and only that choice overwrites');
  });
});

test('B4 #1734 path 4: the page changed while the editor was CLOSED → on reopen the person is shown the earlier draft and can restore it word for word', async () => {
  await served(async ({ base, page }) => {
    const id = await mkPage(base, 'v1 server text');
    await openEditor(page, base, id); await type(page, MINE);
    assert.ok((await editElsewhere(base, id, 'v2 by someone else')).ok);
    await openEditor(page, base, id);   // navigated away and back: a reopen on the newer text
    const s = await screen(page);
    assert.equal(s.editorText, 'v2 by someone else', 'the newer text is what the editor opens on');
    assert.match(s.status, /earlier|unsaved/i, `the person SEES that a draft exists: ${JSON.stringify(s.status)}`);
    assert.ok(await clickButton(page, 'Restore my earlier draft'), 'and is offered it');
    assert.equal((await screen(page)).editorText, MINE, 'restored word for word');
  });
});

for (const mode of ['abort-unapplied', 'abort-applied']) {
  test(`B5 CONTROL (${mode}): a network loss keeps the words in the editor and reopening restores them`, async () => {
    await served(async ({ base, page }) => {
      const id = await mkPage(base, 'v1 server text');
      await intercept(page, base, id, mode);
      await openEditor(page, base, id); await type(page, MINE);
      await clickButton(page, 'Save'); await settle();
      const s = await screen(page);
      assert.equal(s.editorOpen, true); assert.equal(s.editorText, MINE);
      page.__off = true;
      await openEditor(page, base, id);
      assert.equal((await screen(page)).editorText, MINE, 'the words survive a reopen');
    });
  });
}
