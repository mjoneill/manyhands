/**
 * #226 — end-to-end smoke for the full-page Commons view (commons.html), the
 * shared conversation-view component mounted at full-page scale. Proves the
 * whole stack: ES-module load → /api/conversations → feed render → post → and
 * that ?node= scopes the view to a single node's homed thread.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The project root by THIS FILE's location, not the cwd: `path.resolve('.')`
// served 404s whenever the file was run from tests/ (2026-09-13).
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { startRestServer, withBrowserServer } from './helpers/harness.mjs';

const ts = (n) => `2026-05-0${n}T00:00:00.000Z`;
const card = (id, shortId, title, extra = {}) => ({
  id, shortId, title, description: '', type: 'task', assignees: ['sage'],
  labels: [], for: '', priority: null, column: 'backlog', order: 0,
  createdAt: ts(1), updatedAt: ts(1), relationships: { relatedTo: [], blockedBy: [] }, ...extra,
});
const msg = (id, body, author, attachedTo, n) => ({
  id, body, author, attachedTo, createdAt: ts(n), mentions: [],
});

const board = {
  cards: [card('p', 1, 'Parent', { description: 'a page' })],
  columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
  conversations: [
    msg('m1', 'floating in the commons', 'sage', null, 2),
    msg('m2', 'homed on the parent page', 'alex', 'p', 3),
  ],
  nextShortId: 2,
};

test('commons.html (unscoped) renders the whole feed and posts a message', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });

    // #294 — floating posts render in full; a HOMED post (attachedTo a card/page)
    // now collapses to a compact pointer in the unscoped room, not a full body.
    await page.waitForSelector('.cv-msg-body', { timeout: 5000 });
    const bodies = await page.$$eval('.cv-msg-body', (els) => els.map((e) => e.textContent));
    assert.ok(bodies.includes('floating in the commons'), 'floating message shown: ' + bodies.join(' | '));
    assert.ok(!bodies.includes('homed on the parent page'), 'homed message is a pointer, not a full body (#294)');
    await page.waitForSelector('.cv-pointer', { timeout: 5000 });
    const pointerText = await page.$eval('.cv-pointer', (e) => e.textContent);
    assert.ok(/conversation updated/.test(pointerText), 'homed post shows as a pointer: ' + pointerText);

    // Post through the form → it appears.
    await page.evaluate(() => { document.querySelector('.cv-input').value = 'posted from the full page'; });
    await page.click('.cv-send');
    await page.waitForFunction(
      () => [...document.querySelectorAll('.cv-msg-body')].some((e) => e.textContent.includes('posted from the full page')),
      { timeout: 5000 },
    );
    const after = await page.$$eval('.cv-msg-body', (els) => els.map((e) => e.textContent));
    assert.ok(after.some((b) => b.includes('posted from the full page')), 'posted message rendered: ' + after.join(' | '));
  }, { server: { board }, launch: { headless: 'new' } });
});

test('commons.html?node= promotes a single thread to full page (scoped + titled + back-link)', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/commons.html?node=p`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.cv-msg-body', { timeout: 5000 });

    const bodies = await page.$$eval('.cv-msg-body', (els) => els.map((e) => e.textContent));
    assert.ok(bodies.includes('homed on the parent page'), 'thread message shown');
    assert.ok(!bodies.includes('floating in the commons'), 'floating commons message NOT shown when scoped: ' + bodies.join(' | '));

    const title = await page.$eval('#title', (e) => e.textContent);
    assert.equal(title, '💬 Parent', 'title reflects the node name');

    const back = await page.$eval('#back', (e) => ({ shown: e.style.display !== 'none', href: e.getAttribute('href') }));
    assert.ok(back.shown && back.href === '/wiki.html?node=p', 'back-to-page link present: ' + JSON.stringify(back));

    // A post in this scope attaches to the node (lands in the thread, not the floating commons).
    await page.evaluate(() => { document.querySelector('.cv-input').value = 'reply in the thread'; });
    await page.click('.cv-send');
    await page.waitForFunction(
      () => [...document.querySelectorAll('.cv-msg-body')].some((e) => e.textContent.includes('reply in the thread')),
      { timeout: 5000 },
    );
    const stored = await (await fetch(`${server.baseUrl}/api/conversations?attachedTo=p`)).json();
    assert.ok(stored.some((c) => c.body === 'reply in the thread' && c.attachedTo === 'p'),
      'posted message attached to the node, not floated');
  }, { server: { board }, launch: { headless: 'new' } });
});

test('the board surfaces the Commons nav peer + a "⤢ Full page" promote link', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${server.baseUrl}/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.board-header', { timeout: 5000 });

    // Commons nav peer in the page chrome (→ the full-page view).
    // #496: the shared nav moved out of .board-header into the page shell's
    // header row — the board used to mount it in its own toolbar with its own
    // overrides, which was the drift this card removed. The property under test
    // is unchanged (from the board, the chrome offers a link to the Commons
    // page); only the element that holds the nav moved. `.shell-head a` is the
    // nav's new home and contains nothing else, so this is as tight as the old
    // `.board-header a` — it still fails if the nav goes missing.
    const headerLinks = await page.$$eval('.shell-head a', (els) => els.map((e) => e.getAttribute('href')));
    assert.ok(headerLinks.includes('/commons.html'), 'page shell header links to commons.html: ' + headerLinks.join(', '));

    // The existing panel still toggles, and now carries the promote link.
    await page.click('[data-commons-toggle]');   // #497: shared entrance
    await page.waitForSelector('#convs-panel.visible', { timeout: 5000 });
    const promote = await page.$eval('.commons-promote', (e) => e.getAttribute('href'));
    assert.equal(promote, '/commons.html', 'panel promote link → commons.html');

    assert.deepEqual(errors, [], 'board booted without page errors: ' + errors.join(' | '));
  }, { server: { board }, launch: { headless: 'new' } });
});

test('#238 commons.html: attach a file → it uploads, sends, and persists on the message', async () => {
  const tmpFile = path.join(os.tmpdir(), `cv-upload-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, 'hello attachment');
  try {
    await withBrowserServer(async ({ server, browser }) => {
      const page = await browser.newPage();
      page.on('dialog', (d) => d.dismiss()); // defuse any rejection alert
      await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('.cv-input', { timeout: 5000 });

      // the new surface now HAS a file input + 📎 button (the #238 fix)
      const input = await page.$('input[type=file]');
      assert.ok(input, 'the shared component exposes a file input');
      await input.uploadFile(tmpFile);

      // uploaded → a pending chip appears
      await page.waitForSelector('.cv-attach-chip', { timeout: 5000 });

      // type a body and send
      await page.evaluate(() => { document.querySelector('.cv-input').value = 'with an attachment'; });
      await page.evaluate(() => document.querySelector('.cv-form').requestSubmit());
      await page.waitForFunction(
        () => [...document.querySelectorAll('.cv-msg-body')].some((e) => e.textContent.includes('with an attachment')),
        { timeout: 5000 },
      );

      // the attachment persisted on the posted message
      const msgs = await (await fetch(`${server.baseUrl}/api/conversations?limit=10`)).json();
      const m = msgs.find((c) => c.body === 'with an attachment');
      assert.ok(m && Array.isArray(m.attachments) && m.attachments.length === 1,
        'posted message carries the attachment: ' + JSON.stringify(m && m.attachments));
    }, { server: { board }, launch: { headless: 'new' } });
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('#291/#303-1 commons.html: #NNN refs clickable + chat markdown renders; HTML in a body never injects', async () => {
  // One body carries: two card refs (#1 real, #999 unknown — the tokenizer is
  // card-list-agnostic), chat markdown (**bold**), AND an XSS probe that must
  // stay inert TEXT (escape-first renderer).
  const xssBody = 'see #1 **bold** <img src=x onerror="window.__xss=1"> and #999';
  const refBoard = {
    cards: [card('p', 1, 'Parent')],
    columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
    conversations: [msg('mx', xssBody, 'sage', null, 2)],
    nextShortId: 2,
  };
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.cv-msg-body', { timeout: 5000 });

    // Both #NNN become links carrying the board deep-link href (class .cardref).
    const refs = await page.$$eval('.cv-msg-body .cardref', (els) =>
      els.map((e) => ({ text: e.textContent, href: e.getAttribute('href') })));
    assert.deepEqual(refs, [
      { text: '#1', href: 'index.html?card=1' },
      { text: '#999', href: 'index.html?card=999' },
    ], 'both #NNN refs linkified with board deep-links: ' + JSON.stringify(refs));

    // #303-1 — **bold** rendered as a <strong>, not literal asterisks.
    const boldText = await page.$eval('.cv-msg-body strong', (e) => e.textContent).catch(() => null);
    assert.equal(boldText, 'bold', 'chat markdown rendered **bold** → <strong>');

    // XSS-safety (escape-first): the <img onerror> must be inert text, never an element.
    const probe = await page.evaluate(() => ({
      imgInBody: !!document.querySelector('.cv-msg-body img'),
      xssFlag: !!window.__xss,
      bodyText: document.querySelector('.cv-msg-body').textContent,
    }));
    assert.equal(probe.imgInBody, false, 'no <img> injected from the body');
    assert.equal(probe.xssFlag, false, 'onerror never executed');
    assert.ok(probe.bodyText.includes('<img src=x onerror='), 'markup survived as literal text');
  }, { server: { board: refBoard }, launch: { headless: 'new' } });
});

test('#291/#303-1 board inline commons panel: #NNN refs (scroll in place) + chat markdown + XSS-inert', async () => {
  const xssBody = 'ping #1 **bold** <img src=x onerror="window.__xss=1"> and #999';
  const refBoard = {
    cards: [card('p', 1, 'Parent')],
    columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
    conversations: [msg('mx', xssBody, 'sage', null, 2)],
    nextShortId: 2,
  };
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.board-header', { timeout: 5000 });

    // Open the inline commons panel; wait for the seeded message to render.
    await page.click('[data-commons-toggle]');   // #497: shared entrance
    await page.waitForSelector('#convs-panel.visible .conv-msg-body', { timeout: 5000 });
    // #497: the board panel slides in now (it used to appear instantly via
    // display:none→flex). `.visible` lands when the transition STARTS, so a
    // click here can be dispatched while the panel is still off-screen right —
    // puppeteer reports "Node is either not clickable". Wait for it to arrive.
    // #837 2a — this budget was raised 3000→5000 on the belief that THIS was
    // the CI intermittent. It was not: the next red still said "3000ms
    // exceeded", which this wait can no longer say. The failing wait is the
    // highlight wait further down; the fix is there. Left at 5000 (harmless),
    // kept as the record of a fix that never touched the failing line.
    // #1131 — THE SIXTH AND SEVENTH REDS, with the durable marker in place, so
    // the observation side was finally sound and the ACT side was left: this
    // guard let the click go as soon as the panel had moved 20 px of its
    // 420 px slide (.18 s). Puppeteer computes the click point, THEN moves and
    // presses over several CDP round-trips; on a starved runner the link has
    // slid out from under the point by the time the press lands, the press
    // hits something with no handler, and there is neither a navigation nor a
    // stamp — exactly what all seven reds showed. Wait for the slide to END:
    // translateX(0) with right:0 puts the panel's right edge on the viewport
    // edge, and it stays there.
    await page.waitForFunction(() => {
      const p = document.querySelector('#convs-panel');
      if (!p) return false;
      const r = p.getBoundingClientRect();
      return Math.abs(r.right - window.innerWidth) < 1 && r.width > 100;
    }, { timeout: 5000 });

    // Both #NNN become links (card-list-agnostic: #999 unknown still linkifies).
    const refs = await page.$$eval('.conv-card-ref', (els) =>
      els.map((e) => ({ text: e.textContent, href: e.getAttribute('href') })));
    assert.deepEqual(refs, [
      { text: '#1', href: 'index.html?card=1' },
      { text: '#999', href: 'index.html?card=999' },
    ], 'inline panel linkified both refs: ' + JSON.stringify(refs));

    // #303-1 — chat markdown renders in the panel too (shared renderer).
    const boldText = await page.$eval('.conv-msg-body strong', (e) => e.textContent).catch(() => null);
    assert.equal(boldText, 'bold', 'inline panel rendered **bold** → <strong>');

    // XSS-inert: the <img onerror> in the body is text, not an element.
    const probe = await page.evaluate(() => ({
      img: !!document.querySelector('.conv-msg-body img'),
      xss: !!window.__xss,
    }));
    assert.equal(probe.img, false, 'no <img> injected into the panel body');
    assert.equal(probe.xss, false, 'onerror never fired');

    // Clicking #1 scrolls to card `p` IN PLACE (highlighted, no navigation).
    const urlBefore = page.url();
    // ⛔ #837 2a — THE CI INTERMITTENT, resolved in two halves, both on the
    // INSTRUMENT and neither on the budget. `.highlighted` is TRANSIENT:
    // scrollToCardByShortId adds it on the click and removes it 1500ms later.
    //   1  the default poll is requestAnimationFrame, which headless Chrome
    //      throttles on a starved 2-core runner, so the whole window could fall
    //      between two polls  ⇒ polling: 'mutation' (fires on the change itself)
    //   2  the observer was installed AFTER the click — one CDP round-trip
    //      later — so a stall in that gap left nothing to observe  ⇒ register
    //      the wait BEFORE the act, the way waitForNavigation is used
    // Four CI reds (6009 / 5103 / 5164 / 4972ms) were this line; the third
    // came after fixing only half 1. A transient observed after the fact is
    // the same miss at a different layer.
    //
    // #1131 — THE FIFTH RED, after both halves above were in the file. Two
    // correct instrument fixes and it still failed means the instrument was
    // never the problem: the ASSERTION targets a transient. `.highlighted` has
    // a 1500 ms lifetime, so the window and the observation race by design on
    // a starved runner, and no observer can win a race the target created.
    // ⇒ Assert something that does not delete itself. scrollToCardByShortId
    // now stamps `data-highlighted-at` on the card it scrolled to and never
    // removes it; a late observer still sees it. The class stays for the eye.
    const stamped = page.waitForFunction(
      () => document.querySelector('.card[data-id="p"]')?.dataset.highlightedAt || null,
      { timeout: 3000, polling: 'mutation' });
    await page.click('.conv-card-ref');
    try {
      await stamped;
    } catch (e) {
      // Say what the page looked like when the wait gave up, so the next red
      // is a measurement rather than another "3000ms exceeded".
      const seen = await page.evaluate(() => ({
        cardPresent: !!document.querySelector('.card[data-id="p"]'),
        highlightedAt: document.querySelector('.card[data-id="p"]')?.dataset.highlightedAt ?? null,
        panelRight: document.querySelector('#convs-panel')?.getBoundingClientRect().right,
        innerWidth: window.innerWidth,
        url: location.href,
      }));
      throw new Error(`${e.message} — at timeout: ${JSON.stringify(seen)}`);
    }
    assert.equal(page.url(), urlBefore, 'ref click scrolled in place — no page navigation');
  }, { server: { board: refBoard }, launch: { headless: 'new' } });
});

// #303-6 — full-page commons search + load-older.
test('#303-6 commons.html: search filters the feed; clearing restores it', async () => {
  const searchBoard = {
    cards: [],
    columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
    conversations: [
      msg('m1', 'the quarterly budget review', 'alex', null, 2),
      msg('m2', 'router cadence is honest now', 'robin', null, 3),
      msg('m3', 'budget approved, thanks', 'nova', null, 4),
    ],
    nextShortId: 1,
  };
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.cv-msg-body', { timeout: 5000 });
    assert.equal((await page.$$('.cv-msg')).length, 3, 'all three shown initially');

    // Type "budget" → only the two budget messages remain.
    await page.type('.cv-search', 'budget');
    await page.waitForFunction(() => document.querySelectorAll('.cv-msg').length === 2, { timeout: 3000 });
    // authors now render with their identity light (glyph + display name).
    const authors = await page.$$eval('.cv-msg-author', (els) => els.map((e) => e.textContent));
    assert.equal(authors.length, 2, 'two budget messages remain');
    assert.ok(authors.some((a) => /Alex/.test(a)) && authors.some((a) => /Nova/.test(a)),
      'the budget messages are Alex\'s and Nova\'s: ' + authors.join(','));

    // Also matches by author name.
    await page.evaluate(() => { const s = document.querySelector('.cv-search'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.type('.cv-search', 'robin');
    await page.waitForFunction(() => document.querySelectorAll('.cv-msg').length === 1, { timeout: 3000 });

    // Clear → all restored.
    await page.evaluate(() => { const s = document.querySelector('.cv-search'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForFunction(() => document.querySelectorAll('.cv-msg').length === 3, { timeout: 3000 });
  }, { server: { board: searchBoard }, launch: { headless: 'new' } });
});

// #1010 — the box promised the corpus and filtered the loaded window. Now it
// asks the server (q filters BEFORE limit), states the true count from
// X-Total-Count, and each result jumps to its place in the feed.
test('#1010 commons search reaches OUTSIDE the loaded window, states the count, and results jump', async () => {
  // Seven messages; the view loads the newest 3. The needle sits in the oldest —
  // a buffer-local filter cannot see it, which is the defect.
  const bigBoard = {
    cards: [],
    columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
    conversations: [
      msg('o1', 'the canary sang at dawn', 'alex', null, 1),   // OLDEST — outside the window
      msg('o2', 'nothing to see', 'robin', null, 2),
      msg('o3', 'nothing to see either', 'nova', null, 3),
      msg('o4', 'still nothing', 'alex', null, 4),
      msg('n1', 'recent one', 'robin', null, 5),
      msg('n2', 'recent two', 'nova', null, 6),
      msg('n3', 'recent three', 'alex', null, 7),
    ],
    nextShortId: 1,
  };
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    // A 3-message window, like the board panel's bounded load (#210).
    await page.goto(`${server.baseUrl}/commons.html?limit=3`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.cv-msg-body', { timeout: 5000 });
    const loaded = await page.$$eval('.cv-msg', (els) => els.map((e) => e.dataset.id));
    assert.ok(!loaded.includes('o1'), 'precondition: the needle is NOT in the loaded window: ' + loaded.join(','));

    await page.type('.cv-search', 'canary');
    // The header is visible while the request is out, and then states the count.
    await page.waitForFunction(() => document.querySelector('.cv-search-head')?.textContent.includes('match'), { timeout: 5000 });
    const head = await page.$eval('.cv-search-head', (e) => e.textContent);
    assert.match(head, /^1 match\. /, 'the count comes from the server, not the window: ' + head);
    const results = await page.$$eval('.cv-result', (els) => els.map((a) => ({ href: a.getAttribute('href'), id: a.querySelector('.cv-msg')?.dataset.id })));
    assert.deepEqual(results, [{ href: 'commons.html?at=o1', id: 'o1' }], 'the out-of-window message is found and is a jump link');

    // NEGATIVE CONTROL — a term the corpus does not hold says so, as a corpus fact.
    const nonce = 'zq' + Math.random().toString(36).slice(2, 10);   // generated, never written down (#1010's fixture lesson)
    await page.evaluate(() => { const s = document.querySelector('.cv-search'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.type('.cv-search', nonce);
    await page.waitForFunction(() => document.querySelector('.cv-search-head')?.textContent.startsWith('No matches in the commons'), { timeout: 5000 });
    assert.equal((await page.$$('.cv-result')).length, 0);

    // Clear → the feed is back, newest 3.
    await page.evaluate(() => { const s = document.querySelector('.cv-search'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForFunction(() => !document.querySelector('.cv-search-head') && document.querySelectorAll('.cv-msg').length === 3, { timeout: 3000 });
  }, { server: { board: bigBoard }, launch: { headless: 'new' } });
});

test('#1010 a FAILED search is visibly failed — never "no matches"', async () => {
  const board2 = {
    cards: [], columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
    conversations: [msg('a1', 'alpha here', 'alex', null, 1), msg('a2', 'beta here', 'robin', null, 2)],
    nextShortId: 1,
  };
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.cv-msg-body', { timeout: 5000 });
    // Cut the search endpoint from under the page: a request with `q` fails.
    await page.setRequestInterception(true);
    page.on('request', (r) => (r.url().includes('q=') ? r.abort() : r.continue()));
    await page.type('.cv-search', 'alpha');
    await page.waitForFunction(() => document.querySelector('.cv-search-failed'), { timeout: 5000 });
    const head = await page.$eval('.cv-search-head', (e) => e.textContent);
    assert.match(head, /unavailable/, head);
    assert.doesNotMatch(head, /No matches in the commons/, 'a failed check must not read as a corpus-wide negative');
    const ids = await page.$$eval('.cv-result .cv-msg', (els) => els.map((e) => e.dataset.id));
    assert.deepEqual(ids, ['a1'], 'the loaded-window match still shows, labelled as such');
  }, { server: { board: board2 }, launch: { headless: 'new' } });
});

test('presence: the constellation lights who is actually here, counts the quiet by name, and marks the most-recent speaker', async () => {
  const now = new Date();
  const iso = (minsAgo) => new Date(now.getTime() - minsAgo * 60000).toISOString();
  const presBoard = {
    cards: [],
    columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
    conversations: [
      { id: 'p1', body: 'older thought', author: 'nova', attachedTo: null, createdAt: iso(20), mentions: [] },
      { id: 'p2', body: 'the freshest word', author: 'robin', attachedTo: null, createdAt: iso(1), mentions: [] },
    ],
    nextShortId: 1,
  };
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.constellation .mind', { timeout: 5000 });

    // ⛔ THE GUARANTEE THIS GATE EXISTS FOR: nobody leaves the room silently.
    // Before #1241 that was spelled "every roster seat has a chip". It is now
    // "every roster seat is either a chip or inside the quiet count" — the same
    // promise, one indirection later. Relaxing this to a smaller chip count
    // would make it a tautology that passes when seats vanish.
    const names = await page.$$eval('.constellation .mind-name', (els) => els.map((e) => e.textContent));
    const quietChip = await page.$eval('.constellation-quiet', (e) => e.textContent).catch(() => null);
    const quietN = Number((quietChip || '').match(/\+(\d+) quiet/)?.[1] ?? 0);
    assert.equal(names.length, 2, 'the two who spoke inside the window are shown: ' + names.join(', '));
    assert.equal(names.length + quietN, 5, `all five minds accounted for: ${names.length} lit + ${quietN} quiet`);

    // ⛔ COUNT ENTITIES, NEVER ROWS. The sum above is partly self-report: the
    // page emits quietCount, and inside constellationOrder live+quiet == roster
    // is a tautology, so the sum cannot see whether the quiet three are the
    // RIGHT three. A title naming one seat and dropping two passes it. So the
    // guarantee is the NAME SET; the sum survives only as the wiring check on
    // the count text. This is what "nobody leaves silently" always meant.
    const quietTitle = await page.$eval('.constellation-quiet', (e) => e.title);
    const bare = (t) => t.replace(/\(never posted here\)/, '').replace(/^\S+\s+/, '').trim();
    const accountedFor = names.map(bare)
      .concat(quietTitle.split('\n').slice(1).map(bare))
      .filter(Boolean)
      .sort();
    assert.deepEqual(accountedFor, ['Alex', 'Kit', 'Nova', 'Robin', 'Sage'],
      'every seat accounted for BY NAME, exactly once: ' + accountedFor.join(', '));

    // Robin spoke most recently → she's the freshest.
    const freshest = await page.$eval('.mind.freshest .mind-name', (e) => e.textContent).catch(() => null);
    assert.ok(/Robin/.test(freshest || ''), 'the freshest speaker is Robin: ' + freshest);

    // Brightness must still track recency AMONG THE LIVING. The old form of
    // this check compared a speaker to a never-spoken seat, which the collapse
    // now hides — so it would have passed on a constellation that gave every
    // live mind identical opacity. Nova (40m) and Robin (1m) are both lit.
    const opacities = await page.evaluate(() => {
      const byName = {};
      document.querySelectorAll('.constellation .mind').forEach((m) => {
        const n = m.querySelector('.mind-name');
        if (n) byName[n.textContent] = parseFloat(getComputedStyle(m).opacity);
      });
      return byName;
    });
    const robin = Object.entries(opacities).find(([n]) => /Robin/.test(n))[1];
    const nova = Object.entries(opacities).find(([n]) => /Nova/.test(n))[1];
    assert.ok(robin > nova, `recent speaker brighter than fading one: Robin ${robin} > Nova ${nova}`);

    // Each message carries its author's signature light (a --mind colour set).
    const hasMind = await page.$$eval('.cv-msg-lit', (els) => els.every((e) => e.style.getPropertyValue('--mind')));
    assert.ok(hasMind, 'every message has an identity light');
  }, { server: { board: presBoard }, launch: { headless: 'new' } });
});

test('presence: clicking a mind in the constellation solos its voice; clearing restores the room', async () => {
  const soloBoard = {
    cards: [],
    columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
    conversations: [
      { id: 's1', body: 'sage one', author: 'sage', attachedTo: null, createdAt: ts(2), mentions: [] },
      { id: 's2', body: 'nova one', author: 'nova', attachedTo: null, createdAt: ts(3), mentions: [] },
      { id: 's3', body: 'sage two', author: 'sage', attachedTo: null, createdAt: ts(4), mentions: [] },
    ],
    nextShortId: 1,
  };
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.constellation .mind', { timeout: 5000 });
    assert.equal((await page.$$('.cv-msg')).length, 3, 'all three messages before solo');

    // ⚠️ These posts are days old, so EVERY mind is quiet and no chip is shown
    // by name. That is the regression this gate now guards: a quiet seat you
    // cannot click is a seat you cannot listen to — and going quiet is exactly
    // when you want to. The expander must give the chip back.
    assert.equal(await page.$('.mind-name'), null, 'nobody spoke inside the window, so no lit chips');
    await page.evaluate(() => document.querySelector('.constellation-quiet').click());
    await page.waitForSelector('.constellation .mind-name', { timeout: 3000 });

    // Click a seat's chip → feed solos to that seat (2 msgs), banner + active chip appear.
    await page.evaluate(() => [...document.querySelectorAll('.mind')].find((m) => /Sage/.test(m.textContent)).click());
    await page.waitForSelector('.cv-solo-banner', { timeout: 3000 });
    const soloed = await page.$$eval('.cv-msg-author', (els) => els.map((e) => e.textContent));
    assert.ok(soloed.length === 2 && soloed.every((a) => /Sage/.test(a)), 'feed shows only Sage: ' + soloed.join(','));
    assert.ok(await page.$('.mind.soloed'), 'the clicked chip is active');
    assert.ok(await page.$('.constellation.has-solo'), 'the constellation marks a solo (dims the rest)');
    assert.match(await page.$eval('.cv-solo-banner', (e) => e.textContent), /listening to.*Sage/, 'banner names the mind');

    // "show the whole room" clears it.
    await page.evaluate(() => document.querySelector('.cv-solo-clear').click());
    await page.waitForFunction(() => !document.querySelector('.cv-solo-banner'), { timeout: 3000 });
    assert.equal((await page.$$('.cv-msg')).length, 3, 'the whole room is back');
    assert.equal(await page.$('.mind.soloed'), null, 'no chip active after clear');
  }, { server: { board: soloBoard }, launch: { headless: 'new' } });
});

test('#294 unscoped commons collapses card-attached posts to pointers; the scoped thread shows them full', async () => {
  const threadBoard = {
    cards: [card('k', 5, 'The Card')],
    columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
    conversations: [
      msg('f1', 'floating hello to the room', 'alex', null, 2),
      msg('a1', '**thread** talk on the card', 'nova', 'k', 3),
    ],
    nextShortId: 6,
  };
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();

    // Unscoped room: floating post is a full message; the card post is a pointer.
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.cv-feed', { timeout: 5000 });
    await page.waitForSelector('.cv-pointer', { timeout: 5000 });
    const fullBodies = await page.$$eval('.cv-msg .cv-msg-body', (els) => els.map((e) => e.textContent));
    assert.ok(fullBodies.some((b) => b.includes('floating hello')), 'floating post shown in full');
    assert.ok(!fullBodies.some((b) => b.includes('thread talk')), 'card post NOT dumped in full');
    const pointer = await page.$eval('.cv-pointer', (e) => ({ text: e.textContent, href: e.querySelector('a').getAttribute('href') }));
    assert.ok(pointer.text.includes('#5') && pointer.text.includes('The Card'), 'pointer names the card: ' + pointer.text);
    assert.equal(pointer.href, 'commons.html?node=k', 'pointer links to the card thread');

    // Scoped thread (?node=k): the card post renders full, with markdown.
    await page.goto(`${server.baseUrl}/commons.html?node=k`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.cv-msg-body', { timeout: 5000 });
    const scopedBold = await page.$eval('.cv-msg-body strong', (e) => e.textContent).catch(() => null);
    assert.equal(scopedBold, 'thread', 'scoped thread shows the full card post (markdown rendered)');
    assert.equal((await page.$$('.cv-pointer')).length, 0, 'no pointers inside the scoped thread');
  }, { server: { board: threadBoard }, launch: { headless: 'new' } });
});

test('commons.html: the raised-hands panel is a registry of open asks (who · ask · card), clearable', async () => {
  const blockedBoard = {
    cards: [
      card('bk', 7, 'Vendor disclosure call'),
      card('rz', 8, 'Already handled'),
      card('nz', 9, 'Just a thread'),
    ],
    columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
    conversations: [
      msg('r1', '🚧 need the go/no-go on the vendor contract', 'kit', 'bk', 2),  // open raise
      msg('r2', '🚧 need the budget number', 'nova', 'rz', 3),                  // raise…
      msg('r3', '✅ unblocked', 'alex', 'rz', 4),                            // …superseded → not shown
      msg('r4', 'just a normal thread comment', 'sage', 'nz', 5),            // no marker → not a raise
    ],
    nextShortId: 10,
  };
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
    // Only the ONE open raise counts (resolved + plain comment excluded).
    await page.waitForFunction(() => /· 1$/.test(document.getElementById('blocked-toggle').textContent), { timeout: 5000 });
    await page.evaluate(() => document.getElementById('blocked-toggle').click());
    await page.waitForSelector('#blocked-panel.visible .blocked-item', { timeout: 3000 });

    // who = the raiser, what = the ask, which = the card.
    assert.match(await page.$eval('.blocked-who', (e) => e.textContent), /Kit/, 'shows the raiser');
    assert.match(await page.$eval('.blocked-ask', (e) => e.textContent), /go\/no-go on the vendor contract/, 'shows the ask');
    assert.equal(await page.$eval('.blocked-item .blocked-ref', (e) => e.textContent), '#7', 'shows the card');
    assert.equal(await page.$eval('.blocked-open-card', (e) => e.getAttribute('href')), 'index.html?card=7', 'links to the board card');
    assert.equal((await page.$$('.blocked-item')).length, 1, 'exactly one open raise shows');

    // Clearing it (✓ unblocked posts a ✅ that supersedes) → panel empties.
    await page.evaluate(() => document.querySelector('.blocked-done').click());
    await page.waitForFunction(() => /· 0$/.test(document.getElementById('blocked-toggle').textContent), { timeout: 5000 });
    assert.match(await page.$eval('.blocked-empty', (e) => e.textContent), /No open asks/, 'panel empty after clearing');
  }, { server: { board: blockedBoard }, launch: { headless: 'new' } });
});

test('#303-6 commons.html: "load older" hides when the whole history already fits', async () => {
  const convs = [];
  for (let i = 1; i <= 8; i++) convs.push(msg('m' + i, 'message number ' + i, 'sage', null, 1));
  convs.forEach((c, i) => { c.createdAt = `2026-05-01T00:00:0${i}.000Z`; });
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.cv-msg', { timeout: 5000 });
    // All 8 fit under the default window → history exhausted after first load-older → button hides.
    // Click it once; with nothing older it should mark exhausted and hide.
    await page.click('.cv-load-older');
    await page.waitForFunction(() => {
      const b = document.querySelector('.cv-load-older');
      return b && getComputedStyle(b).display === 'none';
    }, { timeout: 3000 });
    assert.equal((await page.$$('.cv-msg')).length, 8, 'all messages present, none lost');
  }, { server: { board: { cards: [], columns: [{ id: 'backlog', name: 'Backlog', order: 0 }], conversations: convs, nextShortId: 1 } }, launch: { headless: 'new' } });
});

test('clearing a raised hand does NOT invent an author', async () => {
  // The worst of the five findings from the independent sweep: this page has no
  // identity picker, so the runtime cannot know who clicked. It answered anyway,
  // hardcoding a seat name — which meant the software wrote a FICTIONAL PERSON
  // into a real user's board history every time anyone cleared a raised hand.
  //
  // The rule: if the runtime cannot know who acted, it records that an action
  // happened, never who did it. A board whose history is partly fabricated is
  // worse than one that admits a gap.
  const board = {
    cards: [card('bk', 1, 'needs a decision')],
    columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
    conversations: [msg('r1', '🚧 which way do we go?', 'nova', 'bk', 1)],
    nextShortId: 2,
  };
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.getElementById('blocked-toggle').click());
    await page.waitForSelector('.blocked-done', { timeout: 5000 });
    await page.evaluate(() => document.querySelector('.blocked-done').click());
    await page.waitForFunction(
      () => /· 0$/.test(document.getElementById('blocked-toggle').textContent), { timeout: 5000 });

    const convos = await (await fetch(`${server.baseUrl}/api/conversations`)).json();
    const resolution = convos.find((c) => /✅/.test(c.body));
    assert.ok(resolution, 'precondition: a resolution was posted');
    assert.equal(resolution.author, 'system', 'authored as a system event, not as a person');

    // The real assertion: no seat name was invented. Any roster key appearing
    // here would be a person the software decided had acted.
    const roster = (await (await fetch(`${server.baseUrl}/api/roster`)).json()).seats;
    assert.ok(
      !Object.keys(roster).includes(resolution.author),
      `the resolution must not be attributed to a roster seat (got "${resolution.author}")`,
    );
  }, { server: { board, staticDir: PROJECT_ROOT }, launch: { headless: 'new', args: ['--no-sandbox'] } });
});

/**
 * #504 — the author picker must offer the CONFIGURED roster, never the shipped
 * examples.
 *
 * This defect wrote fictional authorship into a real board: `commons.html`
 * mounts the conversation view without naming `actors`, the default was a
 * hardcoded list of example seats, and a human's post was recorded under a seat
 * that does not exist. A rendering bug that forges the record.
 *
 * It survived because the fallback used to be correct — while a deployment
 * hardcoded its own seats as the default, a path that never consulted the
 * roster was indistinguishable from one that did. So the test asserts the
 * options EQUAL the configured roster, and a mirror test pins the fallback, or
 * a derivation returning nothing would "pass" both ways.
 */
test('#504 commons author picker offers the CONFIGURED roster, not the example seats', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrum-roster-504-'));
  const rosterFile = path.join(dir, 'roster.json');
  // Unmistakable names: if these appear, the roster was genuinely consulted.
  fs.writeFileSync(rosterFile, JSON.stringify({
    seats: {
      zzquux: { name: 'Zzquux', glyph: '◆', color: '#112233' },
      vlorbo: { name: 'Vlorbo', glyph: '●', color: '#445566' },
      wiki:   { name: 'wiki',   glyph: '📄', color: '#778899' },
    },
  }));
  try {
    await withBrowserServer(async ({ server, browser }) => {
      const page = await browser.newPage();
      await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('.cv-who', { timeout: 5000 });
      const opts = await page.evaluate(() =>
        [...document.querySelector('.cv-who').options].map((o) => o.value));

      assert.deepEqual(opts.sort(), ['vlorbo', 'zzquux'],
        `picker must offer exactly the configured seats (wiki is not a person); got ${opts.join(', ')}`);
      for (const example of ['alex', 'robin', 'sage', 'nova', 'kit']) {
        assert.ok(!opts.includes(example),
          `example seat "${example}" leaked into a configured board's author picker`);
      }
    }, { server: { board, env: { SCRUM_ROSTER_FILE: rosterFile } }, launch: { headless: 'new' } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#504 mirror: with NO roster configured, the shipped example seats DO return', async () => {
  // Without this, a defaultActors() that returned [] would satisfy the test
  // above while offering nobody at all — a green that means nothing.
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.cv-who', { timeout: 5000 });
    const opts = await page.evaluate(() =>
      [...document.querySelector('.cv-who').options].map((o) => o.value));
    assert.ok(opts.length > 0, 'a fresh install must still offer someone to post as');
    assert.ok(opts.includes('alex'), `expected the shipped examples; got ${opts.join(', ')}`);
  }, { server: { board }, launch: { headless: 'new' } });
});

// ── #1689 — ambient recall: the line under a room post, and the Reading page's "what have we read about…" ───────────
// The server side (the `recall` field, /api/recall, /api/recall/opened) is built separately against a fixed contract,
// so these rows STUB those answers with request interception and test only what the pages draw and send.
const RECALL_RUN = 'run-44d706e1-16af-4a45-8671-d4baef63563b';
const RECALL_RUN2 = 'run-61b68b31-9196-44af-a223-d16d4b6f61e0';
const recallItem = (extra = {}) => ({
  source: { title: 'How Complex Systems Fail', url: 'urn:sha256:' + 'a'.repeat(64) },
  readingPage: `/reading.html?run=${RECALL_RUN}`,
  readAt: '2026-11-14T15:45:51.430Z',
  why: {
    gist: 'Root-cause reasoning is socially motivated blame rather than technical analysis.',
    quote: 'Post-accident attribution to a root cause is fundamentally wrong because overt failure requires multiple faults.',
    quoteTruncated: false, claim: 'https://scrumboard.local/assertion/x',
  },
  score: 0.635,
  ...extra,
});
const XSS = '<img src=x onerror="window.__recallXss=1"><script>window.__recallXss=2</script>';
const recallPosts = () => [
  { id: 'p-none', body: 'a post that touches nothing we have read', author: 'sage', attachedTo: null, createdAt: ts(1), mentions: [] },
  { id: 'p-with', body: 'why do we keep blaming one root cause?', author: 'alex', attachedTo: null, createdAt: ts(2), mentions: [],
    recall: { items: [recallItem(), recallItem({ readingPage: `https://evil.example/reading.html?run=${RECALL_RUN2}`, source: { title: 'A second source', url: 'https://evil.example/x' } })] } },
  { id: 'p-down', body: 'the index is down right now', author: 'sage', attachedTo: null, createdAt: ts(3), mentions: [], recall: { unavailable: 'the embedding model is not loaded' } },
  { id: 'p-xss', body: 'hostile text in a recall', author: 'alex', attachedTo: null, createdAt: ts(4), mentions: [],
    recall: { items: [recallItem({ source: { title: 'T ' + XSS, url: 'javascript:alert(1)' }, why: { gist: 'G ' + XSS, quote: 'Q ' + XSS } })] } },
  { id: 'p-long', body: 'a long quote', author: 'sage', attachedTo: null, createdAt: ts(5), mentions: [],
    recall: { items: [recallItem({ source: { title: 'T'.repeat(300) }, why: { gist: 'g'.repeat(400), quote: 'q'.repeat(900) } })] } },
];
const emptyBoard = { cards: [], columns: [{ id: 'backlog', name: 'Backlog', order: 0 }], conversations: [], nextShortId: 1 };

/** Serve `posts` for the list fetch; everything else goes to the fixture server. */
async function stubConversations(page, posts) {
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname === '/api/conversations' && r.method() === 'GET' && !u.searchParams.has('afterCommit')) {
      return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(u.searchParams.has('since') || u.searchParams.has('before') ? [] : posts) });
    }
    return r.continue();
  });
}

test('#1689 commons.html: a post with recall carries one quiet aside; without it, or when recall is unavailable, nothing changes', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await stubConversations(page, recallPosts());
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.cv-msg[data-id="p-with"]', { timeout: 5000 });

    const shape = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.cv-msg')].map((m) => [m.dataset.id, [...m.children].map((c) => c.className)])));
    assert.deepEqual(shape['p-none'], ['cv-msg-meta', 'cv-msg-body prose'], 'a post with no recall is drawn exactly as before: meta, body');
    assert.deepEqual(shape['p-down'], ['cv-msg-meta', 'cv-msg-body prose'], 'an unavailable recall draws nothing in the room');
    assert.deepEqual(shape['p-with'], ['cv-msg-meta', 'cv-msg-body prose', 'cv-recall'], 'the aside sits directly under the body');

    const w = await page.$eval('.cv-msg[data-id="p-with"] .cv-recall', (box) => ({
      tag: box.tagName, label: box.getAttribute('aria-label'),
      rows: [...box.children].map((r) => ({ tag: r.tagName, href: r.getAttribute('href'), text: r.textContent, links: r.querySelectorAll('a').length })),
    }));
    assert.equal(w.tag, 'ASIDE');
    assert.match(w.label, /room has read/i, 'the aside says what it is');
    assert.equal(w.rows.length, 2);
    assert.equal(w.rows[0].tag, 'A');
    assert.equal(w.rows[0].href, `/reading.html?run=${RECALL_RUN}&from=recall&post=p-with`, 'the row links to the reading, saying it was opened from this post');
    assert.match(w.rows[0].text, /^📚 the room has read · How Complex Systems Fail \(Nov 14\)/);
    assert.match(w.rows[0].text, /socially motivated blame/);
    assert.match(w.rows[0].text, /multiple faults/);
    assert.equal(w.rows[1].tag, 'DIV', 'a readingPage off the one allowed shape draws no link');
    assert.equal(w.rows[1].href, null);
    assert.equal(w.rows[1].links, 0);
    assert.match(w.rows[1].text, /A second source/, 'the title is still shown, as plain text');

    // keyboard: the row is reachable and focusable
    await page.focus('.cv-msg[data-id="p-with"] a.cv-recall-item');
    assert.equal(await page.evaluate(() => document.activeElement.className), 'cv-recall-item');

    // an aside, not the author's words: smaller and muted next to the body, and no taller than about four lines a row
    const look = await page.evaluate(() => {
      const body = document.querySelector('.cv-msg[data-id="p-with"] .cv-msg-body');
      const row = document.querySelector('.cv-msg[data-id="p-with"] .cv-recall-item');
      const bs = getComputedStyle(body); const rs = getComputedStyle(row);
      const long = document.querySelector('.cv-msg[data-id="p-long"] .cv-recall-item');
      return { bodyPx: parseFloat(bs.fontSize), rowPx: parseFloat(rs.fontSize), bodyColor: bs.color, rowColor: rs.color,
        rowLine: parseFloat(rs.lineHeight), longH: long.getBoundingClientRect().height };
    });
    assert.ok(look.rowPx < look.bodyPx, `the aside is smaller than the post (${look.rowPx} vs ${look.bodyPx})`);
    assert.notEqual(look.rowColor, look.bodyColor, 'the aside is muted');
    assert.ok(look.longH <= look.rowLine * 4.6, `a row with a very long title, gist and quote stays about four lines (${look.longH}px, line ${look.rowLine}px)`);

    // untrusted text stays text
    const x = await page.$eval('.cv-msg[data-id="p-xss"] .cv-recall', (box) => ({ text: box.textContent, imgs: box.querySelectorAll('img').length, scripts: box.querySelectorAll('script').length, href: box.querySelector('a').getAttribute('href') }));
    assert.equal(x.imgs, 0);
    assert.equal(x.scripts, 0);
    assert.ok(x.text.includes('T <img src=x onerror=') && x.text.includes('G <img') && x.text.includes('Q <img') && x.text.includes('<script>'), 'the markup is shown as text in every field');
    assert.equal(x.href, `/reading.html?run=${RECALL_RUN}&from=recall&post=p-xss`, 'a javascript: source url is never the link');
    assert.equal(await page.evaluate(() => window.__recallXss), undefined, 'nothing in the recall ran');
    assert.deepEqual(errors, []);
  }, { server: { board: emptyBoard }, launch: { headless: 'new' } });
});

test('#1689 commons.html at 390px: a long unbroken quote does not scroll the page sideways', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 });
    await stubConversations(page, recallPosts());
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.cv-msg[data-id="p-long"] .cv-recall', { timeout: 5000 });
    const m = await page.evaluate(() => {
      const box = document.querySelector('.cv-msg[data-id="p-long"] .cv-recall').getBoundingClientRect();
      return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, right: box.right };
    });
    assert.ok(m.sw <= m.cw, `no horizontal scroll at 390px (scrollWidth ${m.sw} > ${m.cw})`);
    assert.ok(m.right <= m.cw, `the aside stays inside the viewport (right ${m.right})`);
  }, { server: { board: emptyBoard }, launch: { headless: 'new' } });
});

test('#1689 the board\'s slide-in commons panel draws the same aside, and nothing for a post without recall', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await stubConversations(page, recallPosts());
    await page.goto(`${server.baseUrl}/`, { waitUntil: 'networkidle0' });
    await page.click('[data-commons-toggle]');
    await page.waitForSelector('#convs-panel.visible .conv-msg[data-id="p-with"] .cv-recall', { timeout: 5000 });
    const shape = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#convs-feed .conv-msg')].map((m) => [m.dataset.id, [...m.children].map((c) => c.className)])));
    assert.deepEqual(shape['p-none'], ['conv-msg-meta', 'conv-msg-body']);
    assert.deepEqual(shape['p-down'], ['conv-msg-meta', 'conv-msg-body']);
    assert.deepEqual(shape['p-with'], ['conv-msg-meta', 'conv-msg-body', 'cv-recall']);
    const href = await page.$eval('#convs-feed .conv-msg[data-id="p-with"] a.cv-recall-item', (a) => a.getAttribute('href'));
    assert.equal(href, `/reading.html?run=${RECALL_RUN}&from=recall&post=p-with`);
    assert.equal(await page.evaluate(() => window.__recallXss), undefined);
    assert.deepEqual(errors, []);
  }, { server: { board: emptyBoard }, launch: { headless: 'new' } });
});

/** The Reading page against stubbed readings and a stubbed recall. Returns the recall and opened requests it saw. */
async function stubReading(page, { opened = 200 } = {}) {
  const seen = { recall: [], opened: [], held: null };
  await page.setRequestInterception(true);
  const json = (r, body, status = 200) => r.respond({ status, contentType: 'application/json', body: JSON.stringify(body) });
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname === '/api/readings') {
      return json(r, { readings: [{ id: RECALL_RUN, title: 'How Complex Systems Fail', url: 'urn:sha256:' + 'a'.repeat(64), outcome: 'complete', startedAt: '2026-11-14T15:42:50.448Z', finishedAt: '2026-11-14T15:45:51.430Z', claims: 3, links: 0 }], truncated: false });
    }
    if (u.pathname === `/api/readings/${RECALL_RUN}`) {
      return json(r, { run: { id: RECALL_RUN, outcome: 'complete', startedAt: '2026-11-14T15:42:50.448Z', finishedAt: '2026-11-14T15:45:51.430Z', links: 0 }, source: { title: 'How Complex Systems Fail', url: 'urn:sha256:' + 'a'.repeat(64) }, claims: [{ id: 'c1', type: 'empirical', gist: 'Failure needs many faults.', quote: 'overt failure requires multiple faults' }] });
    }
    if (u.pathname === '/api/recall/opened') {
      seen.opened.push({ method: r.method(), body: JSON.parse(r.postData() || 'null') });
      return json(r, opened === 200 ? { ok: true } : { error: 'no' }, opened);
    }
    if (u.pathname === '/api/recall') {
      const body = JSON.parse(r.postData() || 'null');
      seen.recall.push(body);
      const t = body && body.text;
      if (t === 'slow') { seen.held = r; return undefined; }
      if (t === 'neterr') return r.abort('failed');
      if (t === 'nothing') return json(r, { available: true, bar: 0.62, partial: false, items: [], searched: { claims: 251, embedded: 251, sources: 6 }, means: 'cosine similarity' });
      if (t === 'partial') return json(r, { available: true, bar: 0.62, partial: true, items: [recallItem()], searched: { claims: 251, embedded: 200, sources: 6 }, means: 'cosine similarity' });
      if (t === 'down') return json(r, { available: false, reason: 'the embedding model is not loaded', items: [] });
      if (t === 'hostile') return json(r, { available: true, bar: 0.62, partial: false, items: [recallItem({ source: { title: 'T ' + XSS }, readingPage: 'javascript:alert(1)', why: { gist: 'G ' + XSS, quote: 'Q ' + XSS } })], searched: { claims: 1, embedded: 1, sources: 1 } });
      return json(r, { available: true, bar: 0.62, partial: false, items: [recallItem(), recallItem({ readingPage: `/reading.html?run=${RECALL_RUN2}`, source: { title: 'Drift into Failure' }, score: 0.631 })], searched: { claims: 251, embedded: 251, sources: 6 }, means: 'cosine similarity' });
    }
    return r.continue();
  });
  return seen;
}

test('#1689 reading.html: "what have we read about…" says plainly what happened in each state', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const seen = await stubReading(page);
    await page.goto(`${server.baseUrl}/reading.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.recall-form input[type=search]', { timeout: 5000 });
    const order = await page.evaluate(() => { const f = document.querySelector('.recall-form'); const l = document.querySelector('.rows'); return !!(f.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING); });
    assert.ok(order, 'the box sits above the list');
    const ask = async (text) => {
      await page.$eval('.recall-form input[type=search]', (i, v) => { i.value = v; }, text);
      await page.click('.recall-form button[type=submit]');
    };
    const out = () => page.$eval('.recall-out', (e) => e.textContent);

    // empty input does nothing
    await ask('   ');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(seen.recall.length, 0, 'an empty box sends nothing');
    assert.equal(new URL(page.url()).search, '');

    // searching
    await ask('slow');
    await page.waitForFunction(() => /Looking through what we.ve read/.test(document.querySelector('.recall-out').textContent), { timeout: 5000 });
    assert.deepEqual(seen.recall.at(-1), { text: 'slow', k: 5 });
    await seen.held.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ available: true, bar: 0.62, partial: false, items: [recallItem()], searched: { claims: 251, embedded: 251, sources: 6 } }) });
    await page.waitForSelector('.recall-out .claim', { timeout: 5000 });

    // results, in the claims' visual language
    await ask('complex systems');
    await page.waitForFunction(() => document.querySelectorAll('.recall-out .claim').length === 2, { timeout: 5000 });
    const cards = await page.$$eval('.recall-out .claim', (els) => els.map((li) => ({
      title: li.querySelector('.rtitle').textContent, href: li.querySelector('.rtitle a') && li.querySelector('.rtitle a').getAttribute('href'),
      gist: li.querySelector('.gist').textContent, quote: li.querySelector('.quote').textContent, meta: li.querySelector('.cmeta').textContent,
    })));
    assert.equal(cards[0].title, 'How Complex Systems Fail');
    assert.equal(cards[0].href, `/reading.html?run=${RECALL_RUN}`);
    assert.match(cards[0].gist, /socially motivated blame/);
    assert.match(cards[0].quote, /multiple faults/);
    assert.match(cards[0].meta, /Nov 14/);
    assert.match(cards[0].meta, /0\.64/, 'the score as a small secondary number');
    assert.equal(cards[1].href, `/reading.html?run=${RECALL_RUN2}`);

    await ask('nothing');
    await page.waitForFunction(() => /clears the bar/.test(document.querySelector('.recall-out').textContent), { timeout: 5000 });
    assert.match(await out(), /Nothing we.ve read clears the bar for that\. The bar is 0\.62\./);

    await ask('partial');
    await page.waitForFunction(() => /not indexed yet/.test(document.querySelector('.recall-out').textContent), { timeout: 5000 });
    assert.match(await out(), /Some claims are not indexed yet; this answer may be incomplete\./);
    assert.equal(await page.$$eval('.recall-out .claim', (e) => e.length), 1, 'a partial answer still shows what it found');

    await ask('down');
    await page.waitForFunction(() => /Couldn.t look/.test(document.querySelector('.recall-out').textContent), { timeout: 5000 });
    assert.match(await out(), /Couldn.t look: the embedding model is not loaded/);

    await ask('neterr');
    await page.waitForFunction(() => /could not be reached/i.test(document.querySelector('.recall-out').textContent), { timeout: 5000 });

    // untrusted text in a result stays text, and a bad readingPage is no link
    await ask('hostile');
    await page.waitForSelector('.recall-out .claim', { timeout: 5000 });
    const h = await page.$eval('.recall-out', (e) => ({ imgs: e.querySelectorAll('img').length, scripts: e.querySelectorAll('script').length, links: e.querySelectorAll('a').length, text: e.textContent }));
    assert.deepEqual([h.imgs, h.scripts, h.links], [0, 0, 0]);
    assert.ok(h.text.includes('T <img') && h.text.includes('G <img') && h.text.includes('Q <img'));
    assert.equal(await page.evaluate(() => window.__recallXss), undefined);
    assert.deepEqual(errors, []);
  }, { server: { board: emptyBoard }, launch: { headless: 'new' } });
});

test('#1689 reading.html: the question is in the address, so it bookmarks, reloads and goes back', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    const seen = await stubReading(page);
    const ask = async (text) => {
      await page.$eval('.recall-form input[type=search]', (i, v) => { i.value = v; }, text);
      await page.click('.recall-form button[type=submit]');
    };
    const two = () => page.waitForFunction(() => document.querySelectorAll('.recall-out .claim').length === 2, { timeout: 5000 });
    await page.goto(`${server.baseUrl}/reading.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.recall-form', { timeout: 5000 });
    assert.equal(seen.recall.length, 0, 'a page opened without ?q= asks nothing');

    await ask('complex systems');
    await two();
    assert.equal(new URL(page.url()).searchParams.get('q'), 'complex systems');
    await ask('nothing');
    await page.waitForFunction(() => /clears the bar/.test(document.querySelector('.recall-out').textContent), { timeout: 5000 });
    assert.equal(new URL(page.url()).searchParams.get('q'), 'nothing');

    await page.goBack();
    await two();
    assert.equal(new URL(page.url()).searchParams.get('q'), 'complex systems');
    assert.equal(await page.$eval('.recall-form input[type=search]', (i) => i.value), 'complex systems');
    await page.goBack();
    await page.waitForFunction(() => document.querySelector('.recall-out').textContent.trim() === '', { timeout: 5000 });
    assert.equal(new URL(page.url()).search, '');
    assert.equal(await page.$eval('.recall-form input[type=search]', (i) => i.value), '');

    // a bookmark: a page opened with ?q= runs that search, once
    seen.recall.length = 0;
    await page.goto(`${server.baseUrl}/reading.html?q=${encodeURIComponent('complex systems')}`, { waitUntil: 'networkidle0' });
    await two();
    assert.deepEqual(seen.recall, [{ text: 'complex systems', k: 5 }]);
    assert.equal(await page.$eval('.recall-form input[type=search]', (i) => i.value), 'complex systems');
  }, { server: { board: emptyBoard }, launch: { headless: 'new' } });
});

test('#1689 reading.html reports an open from a recall once, only for a valid run, and never shows a failed report', async () => {
  await withBrowserServer(async ({ server, browser }) => {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const seen = await stubReading(page, { opened: 500 });
    const url = `${server.baseUrl}/reading.html?run=${RECALL_RUN}&from=recall&post=p-with`;
    await page.goto(url, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.claim', { timeout: 5000 });
    assert.deepEqual(seen.opened, [{ method: 'POST', body: { run: RECALL_RUN, post: 'p-with' } }], 'one report, with the run and the post');
    assert.equal(page.url(), url, 'the address bar is left as it is');
    assert.ok(!/recall|report/i.test(await page.$eval('#main', (e) => e.textContent)), 'a failed report is never shown');

    for (const q of [`run=run-bad&from=recall&post=p-with`, `run=${RECALL_RUN}&post=p-with`, `run=${RECALL_RUN}&from=recall`, `run=${RECALL_RUN}&from=elsewhere&post=p-with`]) {
      await page.goto(`${server.baseUrl}/reading.html?${q}`, { waitUntil: 'networkidle0' });
    }
    assert.equal(seen.opened.length, 1, 'no report without a valid run, from=recall and a post');
    assert.deepEqual(errors, []);
  }, { server: { board: emptyBoard }, launch: { headless: 'new' } });
});
