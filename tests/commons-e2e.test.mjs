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
import puppeteer from 'puppeteer';
import { startRestServer } from './helpers/harness.mjs';

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
  const server = await startRestServer({ board });
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
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
  } finally {
    await browser.close();
    await server.stop();
  }
});

test('commons.html?node= promotes a single thread to full page (scoped + titled + back-link)', async () => {
  const server = await startRestServer({ board });
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
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
  } finally {
    await browser.close();
    await server.stop();
  }
});

test('the board surfaces the Commons nav peer + a "⤢ Full page" promote link', async () => {
  const server = await startRestServer({ board });
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${server.baseUrl}/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.board-header', { timeout: 5000 });

    // Commons nav peer in the header (→ the full-page view).
    const headerLinks = await page.$$eval('.board-header a', (els) => els.map((e) => e.getAttribute('href')));
    assert.ok(headerLinks.includes('/commons.html'), 'board header links to commons.html: ' + headerLinks.join(', '));

    // The existing panel still toggles, and now carries the promote link.
    await page.click('#btn-toggle-convs');
    await page.waitForSelector('#convs-panel.visible', { timeout: 5000 });
    const promote = await page.$eval('.convs-promote', (e) => e.getAttribute('href'));
    assert.equal(promote, '/commons.html', 'panel promote link → commons.html');

    assert.deepEqual(errors, [], 'board booted without page errors: ' + errors.join(' | '));
  } finally {
    await browser.close();
    await server.stop();
  }
});

test('#238 commons.html: attach a file → it uploads, sends, and persists on the message', async () => {
  const server = await startRestServer({ board });
  const browser = await puppeteer.launch({ headless: 'new' });
  const tmpFile = path.join(os.tmpdir(), `cv-upload-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, 'hello attachment');
  try {
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
  } finally {
    fs.unlinkSync(tmpFile);
    await browser.close();
    await server.stop();
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
  const server = await startRestServer({ board: refBoard });
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
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
  } finally {
    await browser.close();
    await server.stop();
  }
});

test('#291/#303-1 board inline commons panel: #NNN refs (scroll in place) + chat markdown + XSS-inert', async () => {
  const xssBody = 'ping #1 **bold** <img src=x onerror="window.__xss=1"> and #999';
  const refBoard = {
    cards: [card('p', 1, 'Parent')],
    columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
    conversations: [msg('mx', xssBody, 'sage', null, 2)],
    nextShortId: 2,
  };
  const server = await startRestServer({ board: refBoard });
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.board-header', { timeout: 5000 });

    // Open the inline commons panel; wait for the seeded message to render.
    await page.click('#btn-toggle-convs');
    await page.waitForSelector('#convs-panel.visible .conv-msg-body', { timeout: 5000 });

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
    await page.click('.conv-card-ref');
    await page.waitForFunction(
      () => !!document.querySelector('.card[data-id="p"].highlighted'),
      { timeout: 3000 });
    assert.equal(page.url(), urlBefore, 'ref click scrolled in place — no page navigation');
  } finally {
    await browser.close();
    await server.stop();
  }
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
  const server = await startRestServer({ board: searchBoard });
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
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
  } finally {
    await browser.close();
    await server.stop();
  }
});

test('presence: the constellation lights each mind + marks the most-recent speaker; messages carry their author light', async () => {
  const now = new Date();
  const iso = (minsAgo) => new Date(now.getTime() - minsAgo * 60000).toISOString();
  const presBoard = {
    cards: [],
    columns: [{ id: 'backlog', name: 'Backlog', order: 0 }],
    conversations: [
      { id: 'p1', body: 'older thought', author: 'nova', attachedTo: null, createdAt: iso(40), mentions: [] },
      { id: 'p2', body: 'the freshest word', author: 'robin', attachedTo: null, createdAt: iso(1), mentions: [] },
    ],
    nextShortId: 1,
  };
  const server = await startRestServer({ board: presBoard });
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.constellation .mind', { timeout: 5000 });

    // The whole roster (human + 4 agents) is present; wiki is not a "mind".
    const names = await page.$$eval('.constellation .mind-name', (els) => els.map((e) => e.textContent));
    assert.equal(names.length, 5, 'five minds in the room: ' + names.join(', '));

    // Robin spoke most recently → she's the freshest (brighter than the absent).
    const freshest = await page.$eval('.mind.freshest .mind-name', (e) => e.textContent).catch(() => null);
    assert.ok(/Robin/.test(freshest || ''), 'the freshest speaker is Robin: ' + freshest);

    // A recent speaker's chip is brighter (higher opacity) than a long-absent one.
    const opacities = await page.evaluate(() => {
      const byName = {};
      document.querySelectorAll('.constellation .mind').forEach((m) => {
        byName[m.querySelector('.mind-name').textContent] = parseFloat(getComputedStyle(m).opacity);
      });
      return byName;
    });
    const robin = Object.entries(opacities).find(([n]) => /Robin/.test(n))[1];
    const kit = Object.entries(opacities).find(([n]) => /Kit/.test(n))[1]; // never spoke → dark
    assert.ok(robin > kit, `present mind brighter than absent: Robin ${robin} > Kit ${kit}`);

    // Each message carries its author's signature light (a --mind colour set).
    const hasMind = await page.$$eval('.cv-msg-lit', (els) => els.every((e) => e.style.getPropertyValue('--mind')));
    assert.ok(hasMind, 'every message has an identity light');
  } finally {
    await browser.close();
    await server.stop();
  }
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
  const server = await startRestServer({ board: soloBoard });
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.constellation .mind', { timeout: 5000 });
    assert.equal((await page.$$('.cv-msg')).length, 3, 'all three messages before solo');

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
  } finally {
    await browser.close();
    await server.stop();
  }
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
  const server = await startRestServer({ board: threadBoard });
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
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
  } finally {
    await browser.close();
    await server.stop();
  }
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
  const server = await startRestServer({ board: blockedBoard });
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
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
  } finally {
    await browser.close();
    await server.stop();
  }
});

test('#303-6 commons.html: "load older" hides when the whole history already fits', async () => {
  const convs = [];
  for (let i = 1; i <= 8; i++) convs.push(msg('m' + i, 'message number ' + i, 'sage', null, 1));
  convs.forEach((c, i) => { c.createdAt = `2026-05-01T00:00:0${i}.000Z`; });
  const server = await startRestServer({ board: { cards: [], columns: [{ id: 'backlog', name: 'Backlog', order: 0 }], conversations: convs, nextShortId: 1 } });
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
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
  } finally {
    await browser.close();
    await server.stop();
  }
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
  const server = await startRestServer({ board, staticDir: path.resolve('.') });
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  try {
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
  } finally {
    await browser.close();
    await server.stop();
  }
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
  const server = await startRestServer({ board, env: { SCRUM_ROSTER_FILE: rosterFile } });
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('select', { timeout: 5000 });
    const opts = await page.evaluate(() =>
      [...document.querySelector('select').options].map((o) => o.value));

    assert.deepEqual(opts.sort(), ['vlorbo', 'zzquux'],
      `picker must offer exactly the configured seats (wiki is not a person); got ${opts.join(', ')}`);
    for (const example of ['alex', 'robin', 'sage', 'nova', 'kit']) {
      assert.ok(!opts.includes(example),
        `example seat "${example}" leaked into a configured board's author picker`);
    }
  } finally {
    await browser.close();
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#504 mirror: with NO roster configured, the shipped example seats DO return', async () => {
  // Without this, a defaultActors() that returned [] would satisfy the test
  // above while offering nobody at all — a green that means nothing.
  const server = await startRestServer({ board });
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.goto(`${server.baseUrl}/commons.html`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('select', { timeout: 5000 });
    const opts = await page.evaluate(() =>
      [...document.querySelector('select').options].map((o) => o.value));
    assert.ok(opts.length > 0, 'a fresh install must still offer someone to post as');
    assert.ok(opts.includes('alex'), `expected the shipped examples; got ${opts.join(', ')}`);
  } finally {
    await browser.close();
    await server.stop();
  }
});
