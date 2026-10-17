/**
 * #1648 — A FIRST UPLOAD STILL IN FLIGHT, on all three upload surfaces. TEST AUTHOR's, written AFTER the build (a regression pin, not a RED row).
 *
 * The guard rows (tests/upload-held-save-1648.test.mjs) pin Save and Post while a file is HELD or a RETRY is uploading, and name "the older in-flight
 * race with no held file ever involved" as out of scope. The build at 5571451 guards that case too (the code reviewer's 5a07917 review: "Source now
 * also guards initial active upload requests, although that older race was not the newly requested row coverage"), so it shipped with no row.
 * These rows pin it, and pin the way out: an upload that fails for good must not leave Save or Post refused forever.
 *
 *   FU-U  a FIRST upload in flight: Save/Post sends nothing and a reason names the file as uploading; once it lands the reason goes and
 *         Save/Post works and carries the file
 *   FU-F  a FIRST upload refused for good (400) or cut off (the request fails): nothing is held or uploading afterwards, so Save/Post works
 *         and carries no attachment (an uploading entry that is never cleared would refuse every later Save/Post)
 *
 * NOT covered, by name: two files in flight at once; an upload that never answers at all (no timeout exists to pin); what the reason says beyond
 * naming the file and that it is uploading; a Save/Post request that itself fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBoardFixture, withBrowserServer } from './helpers/harness.mjs';

const ts = '2026-10-17T00:00:00.000Z';
const NAME = 'first-flight.txt';
const board = () => makeBoardFixture({
  cards: [{ id: 'c1', shortId: 1, title: 'first card', description: '', type: 'task', column: 'backlog', order: 1, assignees: ['unassigned'], labels: [], priority: null, createdAt: ts, updatedAt: ts }],
  conversations: [], nextShortId: 2,
});
function oneFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufi1648-')); const p = path.join(dir, NAME); fs.writeFileSync(p, 'first flight bytes');
  return { dir, path: p };
}

/** POST /api/attachments answered by `step`: 'hold' waits for ctl.release() then goes to the server; 'reject' is a plain 400; 'abort' fails the request. */
async function intercept(page, step) {
  const ctl = { uploads: 0, patches: [], posts: [], release: null };
  let held = null; ctl.release = () => { const r = held; held = null; if (r) r.continue(); };
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = new URL(req.url());
    const body = () => { try { return JSON.parse(req.postData() || '{}'); } catch { return null; } };
    if (req.method() === 'PATCH' && /^\/api\/nodes\//.test(u.pathname)) { ctl.patches.push(body()); return req.continue(); }
    if (req.method() === 'POST' && /\/api\/conversations$/.test(u.pathname)) { ctl.posts.push(body()); return req.continue(); }
    if (req.method() !== 'POST' || !/\/api\/attachments$/.test(u.pathname)) return req.continue();
    ctl.uploads++;
    if (step === 'hold') { held = req; return undefined; }
    if (step === 'abort') return req.abort('failed');
    return req.respond({ status: 400, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'not a file this board accepts' }) });
  });
  return ctl;
}

const settle = (page, ms = 800) => page.evaluate((t) => new Promise((r) => setTimeout(r, t)), ms);
const bodyText = (page) => page.evaluate(() => document.body.innerText);
const newLines = async (page, before) => (await bodyText(page)).split('\n').filter((l) => !before.split('\n').includes(l));
const reasonLines = async (page) => (await bodyText(page)).split('\n').filter((l) => l.includes(NAME) && /not saved|not posted|uploading|waiting/i.test(l));
async function untilUploads(ctl, n) { for (let i = 0; i < 80 && ctl.uploads < n; i++) await new Promise((r) => setTimeout(r, 50)); }

const SURFACES = [
  {
    key: 'wiki.html (the page editor)', chips: '.attach-grid', file: '.attach-file-input', sent: (ctl) => ctl.patches,
    open: async (page, base) => {
      await page.goto(`${base}/wiki.html?node=c1`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /edit/i.test(b.textContent)), { timeout: 8000 });
      await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /edit/i.test(b.textContent)).click());
      await page.waitForSelector('.attach-file-input', { timeout: 8000 });
    },
    prepare: async () => {},
    act: (page) => page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save').click()),
    done: (page) => page.waitForFunction(() => !document.querySelector('.attach-file-input'), { timeout: 8000 }),
    still: (page) => page.evaluate(() => !!document.querySelector('.attach-file-input')),
  },
  {
    key: 'commons.html (the shared composer)', chips: '.cv-attach-chips', file: '.cv-form input[type=file], input[type=file]', sent: (ctl) => ctl.posts,
    open: async (page, base) => { await page.goto(`${base}/commons.html`, { waitUntil: 'networkidle0' }); await page.waitForSelector('.cv-input', { timeout: 8000 }); },
    prepare: (page) => page.evaluate(() => { document.querySelector('.cv-input').value = 'a message with a file'; }),
    act: (page) => page.evaluate(() => document.querySelector('.cv-form').requestSubmit()),
    done: (page) => settle(page, 1000),
    still: async () => true,
  },
  {
    key: 'index.html (the commons panel)', chips: '#convs-attachments', file: '#convs-file', sent: (ctl) => ctl.posts,
    open: async (page, base) => {
      await page.goto(`${base}/`, { waitUntil: 'networkidle0' }); await page.waitForSelector('.board-header', { timeout: 8000 });
      await page.click('[data-commons-toggle]'); await page.waitForSelector('#convs-panel.visible', { timeout: 8000 });
    },
    prepare: (page) => page.evaluate(() => { document.getElementById('convs-body').value = 'a message with a file'; }),
    act: (page) => page.evaluate(() => document.getElementById('convs-form').requestSubmit()),
    done: (page) => settle(page, 1000),
    still: async () => true,
  },
];

async function on(s, step, body) {
  const f = oneFile();
  try {
    await withBrowserServer(async ({ server, browser }) => {
      const page = await browser.newPage();
      page.on('dialog', async (d) => { try { await d.dismiss(); } catch { /* gone */ } });
      const ctl = await intercept(page, step);
      await s.open(page, server.baseUrl);
      await body({ page, ctl, file: f });
    }, { server: { board: board() }, launch: { headless: 'new' } });
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
}
const pickIn = async (page, s, f) => { const input = await page.$(s.file); await input.uploadFile(f.path); };
const landed = (page, s) => page.waitForFunction((sel, n) => document.querySelector(sel)?.textContent.includes(n) && ![...document.querySelectorAll(`${sel} button`)].some((b) => /retry/i.test(b.textContent)), { timeout: 8000 }, s.chips, NAME);

for (const s of SURFACES) {
  test(`#1648 (FU-U, ${s.key}) a FIRST upload in flight: nothing is sent and a reason names the file; once it lands the reason goes and the file goes with it`, { timeout: 120000 }, async () => {
    await on(s, 'hold', async ({ page, ctl, file }) => {
      await pickIn(page, s, file); await untilUploads(ctl, 1);
      assert.equal(ctl.uploads, 1, 'PRECONDITION: the first upload was sent and is not answered yet');
      await s.prepare(page);
      const before = await bodyText(page);
      await s.act(page); await settle(page, 800);
      assert.equal(s.sent(ctl).length, 0, `nothing was sent while the first upload is in flight (${s.sent(ctl).length})`);
      assert.equal(await s.still(page), true, 'and the editor is still open');
      const added = await newLines(page, before);
      assert.ok(added.some((l) => l.includes(NAME) && /uploading/i.test(l)), `a reason appeared that names ${NAME} as uploading: new lines were ${JSON.stringify(added)}`);
      ctl.release();
      await landed(page, s); await settle(page, 600);
      assert.deepEqual(await reasonLines(page), [], 'the file landed, so the reason that it is uploading is gone');
      await s.act(page); await s.done(page);
      assert.equal(s.sent(ctl).length, 1, 'after it landed, one request is sent');
      const atts = s.sent(ctl)[0].attachments || [];
      assert.equal(atts.length, 1, 'and it carries the file that landed');
      assert.equal(atts[0].name, NAME);
    });
  });

  for (const step of ['reject', 'abort']) {
    test(`#1648 (FU-F ${step}, ${s.key}) a FIRST upload that fails for good leaves nothing blocking: the next send goes, without the file`, { timeout: 120000 }, async () => {
      await on(s, step, async ({ page, ctl, file }) => {
        await pickIn(page, s, file); await untilUploads(ctl, 1); await settle(page, 1000);
        assert.equal(ctl.uploads, 1, 'PRECONDITION: the upload was attempted');
        assert.equal(await page.evaluate((sel) => [...document.querySelectorAll(`${sel} button`)].some((b) => /retry/i.test(b.textContent)), s.chips), false, 'PRECONDITION: a non-retryable failure is not held for Retry');
        await s.prepare(page);
        await s.act(page); await s.done(page);
        assert.equal(s.sent(ctl).length, 1, `the send went: the failed upload is not still counted as uploading (${s.sent(ctl).length} sent)`);
        assert.deepEqual(s.sent(ctl)[0].attachments || [], [], 'and it carries no attachment');
        assert.deepEqual(await reasonLines(page), [], 'and no reason about the file is left on screen');
      });
    });
  }
}
