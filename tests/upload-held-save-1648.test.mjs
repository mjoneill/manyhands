/**
 * #1648 — THE WIKI EDITOR'S SAVE WHILE A FILE IS HELD OR STILL UPLOADING. TEST AUTHOR's, written before the fix.
 *
 * The finding (the code reviewer, 43097, confirmed in source at cc1bab6, not browser-reproduced by her): the wiki page editor's Save sends only the
 * attachments it has successfully uploaded (`workingAttachments`), then re-renders the page, so a file held after a retryable refusal is silently
 * lost; and Retry takes the held entry down BEFORE its request finishes, so a Save during that request loses the file the same way.
 *
 * THE CONTRACT these rows pin (from the reviewer's wording): in the wiki editor, while a file is HELD or a Retry is still UPLOADING,
 *   - Save sends NO save request (PATCH /api/nodes/...) and the editor stays open;
 *   - an inline explanation appears that is about saving and names the file;
 *   - Retry and remove stay available (the file can still be rescued, or let go);
 * and once the held file is removed, or the Retry lands, Save works, and what it saves includes the file that landed. With nothing held, Save is
 * unchanged (a control).
 *
 *   SV-C  CONTROL (passes today): nothing held, Save sends one save request and the page leaves edit mode
 *   SV-H  a HELD file: Save is refused (no request, still editing, an explanation naming the file, Retry and remove still there)        RED today
 *   SV-H2 the held file REMOVED: Save works and saves without it                                                                       passes today
 *   SV-U  a Retry still IN FLIGHT: Save is refused with an explanation; when the upload lands Save works and saves the landed file       RED today
 *
 * THE SAME GUARD ON THE TWO COMPOSERS (agreed on the card, 43099 to 43102): a held chip is this card's own invention, and one left on screen after a Post
 * reads as "the file went with it". So on the shared composer (commons.html and card threads) and the board's commons panel, while a file is HELD or a Retry is
 * UPLOADING, Post sends no post, a reason about posting that names the file appears and STAYS until the file is retried or removed (not a toast that fades),
 * and Retry and remove stay; a Post after remove, or after the Retry lands, works and carries the landed file; with nothing held, Post is unchanged; and a Post
 * with an empty text box and only a held file says why instead of doing nothing.
 *
 *   SC-C  CONTROL (passes today): nothing held, text typed: one post request, no attachments
 *   SC-H  a HELD file with text typed: Post refused, still unposted, a persistent reason naming the file, Retry and remove still there   RED today
 *   SC-E  a HELD file and an EMPTY box: Post says why                                                                                 RED today
 *   SC-H2 the held file REMOVED: Post works without it                                                                                passes today
 *   SC-U  a Retry IN FLIGHT: Post refused with a reason; when it lands, Post works and carries the landed file                        RED today
 *
 * NOT covered, by name: the older in-flight Post race with no held file ever involved (out of scope, agreed); what the reason says beyond mentioning posting
 * (or saving), the file, and for the in-flight case that an upload is under way; Cancel (which discards by intent); more than one file in the wiki editor
 * (it takes one); a save or post request that fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBoardFixture, withBrowserServer } from './helpers/harness.mjs';

const ts = '2026-10-17T00:00:00.000Z';
const REASON = 'attachments are being backed up right now; retry in a moment';
const NAME = 'held-note.txt';
const board = () => makeBoardFixture({
  cards: [{ id: 'c1', shortId: 1, title: 'first card', description: '', type: 'task', column: 'backlog', order: 1, assignees: ['unassigned'], labels: [], priority: null, createdAt: ts, updatedAt: ts }],
  conversations: [], nextShortId: 2,
});
function oneFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uhs1648-')); const p = path.join(dir, NAME); fs.writeFileSync(p, 'held bytes');
  return { dir, path: p };
}

/**
 * Answer POST /api/attachments from `plan`: 'real' goes to the server; 'held' is the retryable 503; 'hold-then-real' waits until `ctl.release()` and
 * then goes to the server (an upload in flight). Every PATCH /api/nodes/... (a save) is recorded and let through.
 */
async function intercept(page, plan) {
  const ctl = { uploads: 0, patches: [], posts: [], release: null };
  let held = null; ctl.release = () => { const r = held; held = null; if (r) r.continue(); };
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = new URL(req.url());
    if (req.method() === 'PATCH' && /^\/api\/nodes\//.test(u.pathname)) { let b = null; try { b = JSON.parse(req.postData() || '{}'); } catch { /* recorded as null */ } ctl.patches.push(b); return req.continue(); }
    if (req.method() === 'POST' && /\/api\/conversations$/.test(u.pathname)) { let b = null; try { b = JSON.parse(req.postData() || '{}'); } catch { /* recorded as null */ } ctl.posts.push(b); return req.continue(); }
    if (req.method() !== 'POST' || !/\/api\/attachments$/.test(u.pathname)) return req.continue();
    const step = plan[Math.min(ctl.uploads++, plan.length - 1)];
    if (step === 'real') return req.continue();
    if (step === 'hold-then-real') { held = req; return undefined; }
    return req.respond({ status: 503, headers: { 'content-type': 'application/json', 'retry-after': '2' }, body: JSON.stringify({ error: REASON }) });
  });
  return ctl;
}

async function openEditor(page, base) {
  await page.goto(`${base}/wiki.html?node=c1`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /edit/i.test(b.textContent)), { timeout: 8000 });
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /edit/i.test(b.textContent)).click());
  await page.waitForSelector('.attach-file-input', { timeout: 8000 });
}
const settle = (page, ms = 800) => page.evaluate((t) => new Promise((r) => setTimeout(r, t)), ms);
const editing = (page) => page.evaluate(() => !!document.querySelector('.attach-file-input'));
const clickSave = (page) => page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save').click());
const clickByText = (page, re) => page.evaluate((src) => { const r = new RegExp(src, 'i'); const b = [...document.querySelectorAll('.attach-grid button')].find((x) => r.test(x.textContent || x.title || x.getAttribute('aria-label') || '')); if (!b) return false; b.click(); return true; }, re.source);
const has = (page, re) => page.evaluate((src) => [...document.querySelectorAll('.attach-grid button')].some((x) => new RegExp(src, 'i').test(x.textContent || x.title || x.getAttribute('aria-label') || '')), re.source);
const bodyText = (page) => page.evaluate(() => document.body.innerText);

async function onEditor(plan, body) {
  const f = oneFile();
  try {
    await withBrowserServer(async ({ server, browser }) => {
      const page = await browser.newPage();
      const dialogs = []; page.on('dialog', async (d) => { dialogs.push(d.message()); try { await d.dismiss(); } catch { /* gone */ } });
      const ctl = await intercept(page, plan);
      await openEditor(page, server.baseUrl);
      await body({ page, ctl, file: f, dialogs });
    }, { server: { board: board() }, launch: { headless: 'new' } });
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
}
async function pick(page, f) { const input = await page.$('.attach-file-input'); await input.uploadFile(f.path); }

test('#1648 (SV-C CONTROL) nothing held: Save sends one save request and leaves edit mode', { timeout: 120000 }, async () => {
  await onEditor(['real'], async ({ page, ctl }) => {
    await clickSave(page);
    await page.waitForFunction(() => !document.querySelector('.attach-file-input'), { timeout: 8000 });
    assert.equal(ctl.patches.length, 1, 'exactly one save request');
    assert.deepEqual(ctl.patches[0].attachments, [], 'and it carries the page\'s attachments (none)');
  });
});

test('#1648 (SV-H) a HELD file: Save is refused: no save request, still editing, an explanation about saving that names the file, Retry and remove still there', { timeout: 120000 }, async () => {
  await onEditor(['held'], async ({ page, ctl, file }) => {
    await pick(page, file); await settle(page, 1000);
    assert.equal(await has(page, /retry/), true, 'PRECONDITION: the file is held and Retry is offered');
    const before = await bodyText(page);
    await clickSave(page); await settle(page, 1000);
    assert.equal(ctl.patches.length, 0, `no save request was sent while a file is held (${ctl.patches.length})`);
    assert.equal(await editing(page), true, 'and the editor is still open');
    const after = await bodyText(page);
    const added = after.split('\n').filter((l) => !before.split('\n').includes(l));
    assert.ok(added.some((l) => /save/i.test(l) && l.includes(NAME)), `an explanation appeared that is about saving and names ${NAME}: new lines were ${JSON.stringify(added)}`);
    assert.equal(await has(page, /retry/), true, 'Retry is still available');
    assert.equal(await has(page, /^×$|remove/), true, 'and so is remove');
    await settle(page, 4800);   // a toast that hides itself after a few seconds would be gone by now
    assert.ok((await bodyText(page)).split('\n').some((l) => /save/i.test(l) && l.includes(NAME)), 'and the explanation STAYS until the file is retried or removed: it is still there 5 s later');
  });
});

test('#1648 (SV-H2) the held file REMOVED: Save works and saves without it', { timeout: 120000 }, async () => {
  await onEditor(['held'], async ({ page, ctl, file }) => {
    await pick(page, file); await settle(page, 1000);
    assert.equal(await clickByText(page, /^×$|remove/), true, 'PRECONDITION: the held chip has a remove control');
    await clickSave(page);
    await page.waitForFunction(() => !document.querySelector('.attach-file-input'), { timeout: 8000 });
    assert.equal(ctl.patches.length, 1);
    assert.deepEqual(ctl.patches[0].attachments, [], 'saved without the file that was let go');
  });
});

test('#1648 (SV-U) a Retry still IN FLIGHT: Save is refused with an explanation; when the upload lands Save works and saves the landed file', { timeout: 120000 }, async () => {
  await onEditor(['held', 'hold-then-real'], async ({ page, ctl, file }) => {
    await pick(page, file); await settle(page, 1000);
    assert.equal(await clickByText(page, /retry/), true, 'PRECONDITION: Retry is offered and pressed');
    await settle(page, 600);
    assert.equal(ctl.uploads, 2, 'PRECONDITION: the retry upload is in flight (sent, not yet answered)');
    const before = await bodyText(page);
    await clickSave(page); await settle(page, 800);
    assert.equal(ctl.patches.length, 0, `no save request while the retry is still uploading (${ctl.patches.length})`);
    assert.equal(await editing(page), true, 'and the editor is still open');
    const added = (await bodyText(page)).split('\n').filter((l) => !before.split('\n').includes(l));
    assert.ok(added.some((l) => /save/i.test(l) || /upload/i.test(l)), `an explanation appeared: new lines were ${JSON.stringify(added)}`);
    ctl.release();
    await page.waitForFunction((n) => document.querySelector('.attach-grid')?.textContent.includes(n) && ![...document.querySelectorAll('.attach-grid button')].some((b) => /retry/i.test(b.textContent)), { timeout: 8000 }, NAME);
    await clickSave(page);
    await page.waitForFunction(() => !document.querySelector('.attach-file-input'), { timeout: 8000 });
    assert.equal(ctl.patches.length, 1, 'after it landed, Save works: one save request');
    assert.equal(ctl.patches[0].attachments.length, 1, 'and it carries the file that landed');
    assert.equal(ctl.patches[0].attachments[0].name, NAME);
  });
});


// ---------------------------------------------------------------------------------------------------- the two composers
const COMPOSERS = [
  {
    key: 'commons.html (the shared composer)', chips: '.cv-attach-chips', input: '.cv-input',
    open: async (page, base) => { await page.goto(`${base}/commons.html`, { waitUntil: 'networkidle0' }); await page.waitForSelector('.cv-input', { timeout: 8000 }); },
    file: '.cv-form input[type=file], input[type=file]',
    post: (page) => page.evaluate(() => document.querySelector('.cv-form').requestSubmit()),
  },
  {
    key: 'index.html (the commons panel)', chips: '#convs-attachments', input: '#convs-body',
    open: async (page, base) => {
      await page.goto(`${base}/`, { waitUntil: 'networkidle0' }); await page.waitForSelector('.board-header', { timeout: 8000 });
      await page.click('[data-commons-toggle]'); await page.waitForSelector('#convs-panel.visible', { timeout: 8000 });
    },
    file: '#convs-file',
    post: (page) => page.evaluate(() => document.getElementById('convs-form').requestSubmit()),
  },
];
const hasIn = (page, chips, re) => page.evaluate((c, src) => [...document.querySelectorAll(`${c} button`)].some((x) => new RegExp(src, 'i').test(x.textContent || x.title || x.getAttribute('aria-label') || '')), chips, re.source);
const pressIn = (page, chips, re) => page.evaluate((c, src) => { const b = [...document.querySelectorAll(`${c} button`)].find((x) => new RegExp(src, 'i').test(x.textContent || x.title || x.getAttribute('aria-label') || '')); if (!b) return false; b.click(); return true; }, chips, re.source);
const typeText = (page, sel, text) => page.evaluate((s2, t) => { document.querySelector(s2).value = t; }, sel, text);
const newLines = async (page, before) => (await bodyText(page)).split('\n').filter((l) => !before.split('\n').includes(l));

async function onComposer(c, plan, body) {
  const f = oneFile();
  try {
    await withBrowserServer(async ({ server, browser }) => {
      const page = await browser.newPage();
      const dialogs = []; page.on('dialog', async (d) => { dialogs.push(d.message()); try { await d.dismiss(); } catch { /* gone */ } });
      const ctl = await intercept(page, plan);
      await c.open(page, server.baseUrl);
      await body({ page, ctl, file: f, dialogs });
    }, { server: { board: board() }, launch: { headless: 'new' } });
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
}
const pickIn = async (page, c, f) => { const input = await page.$(c.file); await input.uploadFile(f.path); };

for (const c of COMPOSERS) {
  test(`#1648 (SC-C CONTROL, ${c.key}) nothing held, text typed: Post sends one post request and no attachments`, { timeout: 120000 }, async () => {
    await onComposer(c, ['real'], async ({ page, ctl }) => {
      await typeText(page, c.input, 'a plain message'); await c.post(page);
      await page.waitForFunction(() => true); await settle(page, 1000);
      assert.equal(ctl.posts.length, 1, 'exactly one post request');
      assert.equal(ctl.posts[0].body, 'a plain message');
      assert.deepEqual(ctl.posts[0].attachments || [], [], 'and no attachments');
    });
  });

  test(`#1648 (SC-H, ${c.key}) a HELD file with text typed: Post is refused, a persistent reason names the file, Retry and remove are still there`, { timeout: 120000 }, async () => {
    await onComposer(c, ['held'], async ({ page, ctl, file }) => {
      await pickIn(page, c, file); await settle(page, 1000);
      assert.equal(await hasIn(page, c.chips, /retry/), true, 'PRECONDITION: the file is held and Retry is offered');
      await typeText(page, c.input, 'a message that must not leave without its file');
      const before = await bodyText(page);
      await c.post(page); await settle(page, 1000);
      assert.equal(ctl.posts.length, 0, `no post request was sent while a file is held (${ctl.posts.length})`);
      const added = await newLines(page, before);
      assert.ok(added.some((l) => /post|send/i.test(l) && l.includes(NAME)), `a reason appeared that is about posting and names ${NAME}: new lines were ${JSON.stringify(added)}`);
      assert.equal(await hasIn(page, c.chips, /retry/), true, 'Retry is still available');
      assert.equal(await hasIn(page, c.chips, /^×$|remove/), true, 'and so is remove');
      await settle(page, 4800);
      assert.ok((await bodyText(page)).split('\n').some((l) => /post|send/i.test(l) && l.includes(NAME)), 'and the reason STAYS (it is still there 5 s later), not a toast that fades');
    });
  });

  test(`#1648 (SC-E, ${c.key}) a HELD file and an EMPTY box: Post says why instead of doing nothing`, { timeout: 120000 }, async () => {
    await onComposer(c, ['held'], async ({ page, ctl, file }) => {
      await pickIn(page, c, file); await settle(page, 1000);
      assert.equal(await hasIn(page, c.chips, /retry/), true, 'PRECONDITION: the file is held');
      const before = await bodyText(page);
      await c.post(page); await settle(page, 1000);
      assert.equal(ctl.posts.length, 0, 'nothing was posted');
      const added = await newLines(page, before);
      assert.ok(added.some((l) => /post|send/i.test(l) && l.includes(NAME)), `the empty Post is explained, naming the file: new lines were ${JSON.stringify(added)}`);
    });
  });

  test(`#1648 (SC-H2, ${c.key}) the held file REMOVED: Post works and carries no attachment`, { timeout: 120000 }, async () => {
    await onComposer(c, ['held'], async ({ page, ctl, file }) => {
      await pickIn(page, c, file); await settle(page, 1000);
      assert.equal(await pressIn(page, c.chips, /^×$|remove/), true, 'PRECONDITION: the held chip has a remove control');
      await typeText(page, c.input, 'sent after letting the file go'); await c.post(page); await settle(page, 1000);
      assert.equal(ctl.posts.length, 1, 'the post went');
      assert.deepEqual(ctl.posts[0].attachments || [], [], 'without the file that was let go');
    });
  });

  test(`#1648 (SC-U, ${c.key}) a Retry still IN FLIGHT: Post is refused with a reason; when the upload lands, Post works and carries the landed file`, { timeout: 120000 }, async () => {
    await onComposer(c, ['held', 'hold-then-real'], async ({ page, ctl, file }) => {
      await pickIn(page, c, file); await settle(page, 1000);
      assert.equal(await pressIn(page, c.chips, /retry/), true, 'PRECONDITION: Retry is offered and pressed');
      await settle(page, 600);
      assert.equal(ctl.uploads, 2, 'PRECONDITION: the retry upload is in flight (sent, not yet answered)');
      await typeText(page, c.input, 'posted once the file has landed');
      const before = await bodyText(page);
      await c.post(page); await settle(page, 800);
      assert.equal(ctl.posts.length, 0, `no post request while the retry is still uploading (${ctl.posts.length})`);
      const added = await newLines(page, before);
      assert.ok(added.some((l) => /post|send|upload/i.test(l)), `a reason appeared: new lines were ${JSON.stringify(added)}`);
      ctl.release();
      await page.waitForFunction((sel, n) => document.querySelector(sel)?.textContent.includes(n) && ![...document.querySelectorAll(`${sel} button`)].some((b) => /retry/i.test(b.textContent)), { timeout: 8000 }, c.chips, NAME);
      await c.post(page); await settle(page, 1000);
      assert.equal(ctl.posts.length, 1, 'after it landed, Post works: one post request');
      assert.equal((ctl.posts[0].attachments || []).length, 1, 'and it carries the file that landed');
      assert.equal(ctl.posts[0].attachments[0].name, NAME);
    });
  });
}
