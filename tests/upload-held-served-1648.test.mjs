/**
 * #1648 pre-build gate (3) — the browser rows for a HELD upload. TEST AUTHOR's, written before any build.
 *
 * The attachment fence (rows F1 to F7, tests/attachments-fence-1648.test.mjs on card/1648-fence-rows) promises that while a paired capture holds
 * the fence, an upload through the app is HELD, or REFUSED with a retryable error: HTTP 503, a JSON body whose `error` says why, and a
 * `retry-after` header. The accepted tightening (accepted 10-15) is that the browser then shows a visible, recoverable failure that KEEPS the
 * selected file. Today none of the three browser upload surfaces does:
 *
 *   commons.html and card threads (core/conversation-view.mjs, uploadFile)  a NATIVE alert(), and the file is dropped
 *   index.html's commons panel (uploadCommonsFile)                          a toast, and the file is dropped (the picker is cleared right after)
 *   wiki.html's page editor (fileInput.onchange)                            notify(), and the file is dropped
 *
 * Every row answers the 503 itself by request interception, so these rows do not depend on the fence being built. The success path goes to the
 * REAL server (the interception lets the request through), so a retry that works is a real upload.
 *
 * PROPOSED INTERFACE (the builder may rename; the rows then follow). On a retryable refusal each surface:
 *   (a) shows the server's `error` text on the page, NON-MODALLY (no alert / confirm / prompt: a native dialog freezes a page for an agent
 *       driving the board through a browser, which index.html's own comment already says);
 *   (b) keeps the file as a chip in that surface's pending area, in a held state, containing the file's name and a button whose text matches /retry/i;
 *   (c) Retry sends the SAME name and the SAME bytes again; on success the chip becomes an ordinary pending attachment (name, no Retry button);
 *   (d) a second refusal leaves the held chip where it is, still retryable.
 * A refusal that is NOT retryable (400, no retry-after) keeps today's behaviour: the message, nothing kept, no Retry.
 *
 * ROWS, per surface:   C  CONTROLS (pass today)  ·  H  the held upload shows its reason and keeps the file (RED today)  ·  R  Retry (RED today)
 *
 * NOT covered, by name: the fence itself (F1 to F7); the exact wording of the message (only that the server's own `error` text is on the page);
 * a paste or drop path (the pickers are driven); a file larger than the server's limit; the upload-in-flight spinner; the wording of the button
 * beyond /retry/i; any other upload surface than these three (grep of api/attachments in index.html, wiki.html and core/ found these).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBoardFixture, withBrowserServer } from './helpers/harness.mjs';

const ts = '2026-10-17T00:00:00.000Z';
const REASON = 'attachments are being backed up right now; retry in a moment';
const card = (shortId, title) => ({
  id: `c${shortId}`, shortId, title, description: '', type: 'task', column: 'backlog', order: shortId,
  assignees: ['unassigned'], labels: [], priority: null, createdAt: ts, updatedAt: ts,
});
const board = () => makeBoardFixture({ cards: [card(1, 'first card')], conversations: [], nextShortId: 2 });

function tmpFiles(...specs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uh1648-'));
  const files = specs.map(([name, text]) => { const p = path.join(dir, name); fs.writeFileSync(p, text); return { name, text, path: p }; });
  return { dir, files };
}

/**
 * Intercept POST /api/attachments. `plan` is the list of answers for the successive uploads, each 'real' (let it through to the server) or an
 * object { status, error, retryAfter }. The log records every upload's name and bytes (decoded), in order.
 */
async function interceptUploads(page, plan) {
  const log = []; let n = 0;
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.method() !== 'POST' || !/\/api\/attachments$/.test(new URL(req.url()).pathname)) return req.continue();
    let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch { /* record as empty */ }
    log.push({ name: body.name, bytes: Buffer.from(body.data || '', 'base64').toString('utf8') });
    const step = plan[Math.min(n++, plan.length - 1)];
    if (step === 'real') return req.continue();
    const headers = { 'content-type': 'application/json' };
    if (step.retryAfter) headers['retry-after'] = String(step.retryAfter);
    return req.respond({ status: step.status, headers, body: JSON.stringify({ error: step.error }) });
  });
  return log;
}

const HELD = { status: 503, error: REASON, retryAfter: 2 };
const REJECTED = { status: 400, error: 'that file type is not accepted' };

/** The three surfaces. `open` leaves the page ready to take a file; `chips` is the pending area; `pick` hands files to the picker. */
const SURFACES = [
  {
    key: 'commons.html (the shared composer)', multi: true, chips: '.cv-attach-chips',
    open: async (page, base) => { await page.goto(`${base}/commons.html`, { waitUntil: 'networkidle0' }); await page.waitForSelector('.cv-input', { timeout: 8000 }); },
    pick: async (page, paths) => { const input = await page.$('input[type=file]'); await input.uploadFile(...paths); },
  },
  {
    key: 'index.html (the commons panel)', multi: true, chips: '#convs-attachments',
    open: async (page, base) => {
      await page.goto(`${base}/`, { waitUntil: 'networkidle0' }); await page.waitForSelector('.board-header', { timeout: 8000 });
      await page.click('[data-commons-toggle]'); await page.waitForSelector('#convs-panel.visible', { timeout: 8000 });
    },
    pick: async (page, paths) => { const input = await page.$('#convs-file'); await input.uploadFile(...paths); },
  },
  {
    key: 'wiki.html (the page editor)', multi: false, chips: '.attach-grid',
    open: async (page, base) => {
      await page.goto(`${base}/wiki.html?node=c1`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /edit/i.test(b.textContent)), { timeout: 8000 });
      await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /edit/i.test(b.textContent)).click());
      await page.waitForSelector('.attach-file-input', { timeout: 8000 });
    },
    pick: async (page, paths) => { const input = await page.$('.attach-file-input'); await input.uploadFile(...paths.slice(0, 1)); },
  },
];

/** Run `body` on a served page for a surface, with every native dialog recorded and dismissed (so a blocking alert fails a row instead of hanging it). */
async function onSurface(s, plan, body) {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    const dialogs = []; page.on('dialog', async (d) => { dialogs.push(`${d.type()}: ${d.message()}`); try { await d.dismiss(); } catch { /* gone */ } });
    const log = await interceptUploads(page, plan);
    await s.open(page, server.baseUrl);
    await body({ page, log, dialogs, base: server.baseUrl });
  }, { server: { board: board() }, launch: { headless: 'new' } });
}

/** What the pending area holds now: one entry per chip-like child, with its text and whether it has a Retry button. */
const chipState = (page, chips) => page.$$eval(`${chips} > *`, (els) => els.map((e) => ({ text: e.textContent || '', retry: [...e.querySelectorAll('button')].some((b) => /retry/i.test(b.textContent || b.title || b.getAttribute('aria-label') || '')) })));
const pageText = (page) => page.evaluate(() => document.body.innerText);
const settle = (page, ms = 700) => page.evaluate((t) => new Promise((r) => setTimeout(r, t)), ms);

for (const s of SURFACES) {
  test(`#1648 (UH-C, ${s.key}) CONTROLS: a file that uploads becomes one pending chip with its name and no Retry; a non-retryable 400 shows no Retry and keeps nothing`, { timeout: 120000 }, async () => {
    const { dir, files } = tmpFiles(['note-a.txt', 'alpha bytes']);
    try {
      await onSurface(s, ['real'], async ({ page, log }) => {
        await s.pick(page, files.map((f) => f.path));
        await page.waitForFunction((sel) => (document.querySelector(sel)?.children.length || 0) >= 1, { timeout: 8000 }, s.chips);
        const st = await chipState(page, s.chips);
        assert.equal(st.length, 1, `one pending chip (${JSON.stringify(st)})`);
        assert.ok(st[0].text.includes('note-a.txt'), `the chip names the file: ${st[0].text}`);
        assert.equal(st[0].retry, false, 'an uploaded file has no Retry button');
        assert.equal(log.length, 1, 'exactly one upload was sent');
        assert.equal(log[0].bytes, 'alpha bytes', 'and it carried the file bytes');
      });
      await onSurface(s, [REJECTED], async ({ page, log }) => {
        await s.pick(page, files.map((f) => f.path));
        await page.waitForFunction(() => true); await settle(page);
        const st = await chipState(page, s.chips);
        assert.equal(log.length, 1, 'the upload was attempted once');
        assert.ok(!st.some((c) => c.retry), `a non-retryable refusal offers no Retry (${JSON.stringify(st)})`);
        assert.ok(!st.some((c) => c.text.includes('note-a.txt')), `and keeps no chip for the rejected file (${JSON.stringify(st)})`);
      });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test(`#1648 (UH-H, ${s.key}) a HELD upload (503 + retry-after) shows the server's reason on the page without a native dialog, and KEEPS the file as a retryable chip`, { timeout: 120000 }, async () => {
    const { dir, files } = tmpFiles(['note-a.txt', 'alpha bytes']);
    try {
      await onSurface(s, [HELD], async ({ page, log, dialogs }) => {
        await s.pick(page, files.map((f) => f.path));
        await settle(page, 1200);
        assert.equal(log.length, 1, 'the upload was attempted');
        assert.deepEqual(dialogs, [], `no native dialog (it freezes a page for an agent driving the board): ${dialogs.join(' | ')}`);
        assert.ok((await pageText(page)).includes(REASON), 'the server\'s own error text is on the page, not only in a dialog or the console');
        const st = await chipState(page, s.chips);
        const held = st.find((c) => c.text.includes('note-a.txt'));
        assert.ok(held, `the selected file is kept as a chip in the pending area (${JSON.stringify(st)})`);
        assert.equal(held.retry, true, 'and the chip has a Retry button');
      });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test(`#1648 (UH-R, ${s.key}) Retry sends the SAME name and bytes again and the chip becomes an ordinary pending attachment; a second hold leaves it retryable`, { timeout: 120000 }, async () => {
    const { dir, files } = tmpFiles(['note-a.txt', 'alpha bytes']);
    try {
      await onSurface(s, [HELD, HELD, 'real'], async ({ page, log }) => {
        await s.pick(page, files.map((f) => f.path));
        await settle(page, 1200);
        const clickRetry = () => page.evaluate((sel) => {
          const b = [...document.querySelectorAll(`${sel} button`)].find((x) => /retry/i.test(x.textContent || x.title || x.getAttribute('aria-label') || ''));
          if (!b) return false; b.click(); return true;
        }, s.chips);
        assert.equal(await clickRetry(), true, 'there is a Retry button to press after the first hold');
        await settle(page, 1200);
        assert.equal(log.length, 2, 'Retry sent a second upload');
        assert.equal(await clickRetry(), true, 'a second hold leaves the chip retryable');
        // wait for the ORDINARY chip: the file's name present and no Retry button. "No Retry button" alone is true the instant Retry is pressed (the held chip
        // is taken down while the upload is in flight), which raced the third upload's answer.
        await page.waitForFunction((sel) => {
          const c = document.querySelector(sel); if (!c || !c.textContent.includes('note-a.txt')) return false;
          return ![...c.querySelectorAll('button')].some((x) => /retry/i.test(x.textContent || x.title || x.getAttribute('aria-label') || ''));
        }, { timeout: 8000 }, s.chips);
        assert.equal(log.length, 3, 'and the third attempt went through');
        for (const [i, l] of log.entries()) { assert.equal(l.name, 'note-a.txt', `attempt ${i + 1} sent the same name`); assert.equal(l.bytes, 'alpha bytes', `attempt ${i + 1} sent the same bytes`); }
        const st = await chipState(page, s.chips);
        assert.equal(st.filter((c) => c.text.includes('note-a.txt')).length, 1, `exactly one chip for the file now (${JSON.stringify(st)})`);
        assert.ok(!st.some((c) => c.retry), 'and it has no Retry button: it is an ordinary pending attachment');
      });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  if (s.multi) {
    test(`#1648 (UH-M, ${s.key}) two files, the second held: the first stays an ordinary pending attachment and the second is kept for Retry`, { timeout: 120000 }, async () => {
      const { dir, files } = tmpFiles(['note-a.txt', 'alpha bytes'], ['note-b.txt', 'bravo bytes']);
      try {
        await onSurface(s, ['real', HELD], async ({ page, log }) => {
          await s.pick(page, files.map((f) => f.path));
          await settle(page, 1800);
          assert.equal(log.length, 2, 'both uploads were attempted, in order');
          const st = await chipState(page, s.chips);
          const a = st.find((c) => c.text.includes('note-a.txt')); const b = st.find((c) => c.text.includes('note-b.txt'));
          assert.ok(a && a.retry === false, `the first file is an ordinary pending chip (${JSON.stringify(st)})`);
          assert.ok(b && b.retry === true, `the second file is kept with a Retry button (${JSON.stringify(st)})`);
        });
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
  }
}
